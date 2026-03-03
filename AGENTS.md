# AGENTS.md - Technical Overview for AI Agents

This document provides a high-level overview of the `@cheatron/nthread` library for AI agents extending or maintaining the codebase.

## 1. Core Concept: Gadget-Based Thread Hijacking

NThread seizes control of a running thread **without allocating remote memory or injecting shellcode**. It works by chaining two small pre-existing instruction sequences found in loaded modules:

- **Sleep gadget** (`jmp .` / `EB FE`): An infinite self-loop. Used as the "parking spot" — the thread sits here while hijacked.
- **Pushret gadget** (`push reg; ret` / e.g. `53 C3`): Pivots `RIP` by pushing a register onto the stack and returning to it.

### Hijack flow (in `NThread.inject(thread)`):
```
captured = new CapturedThread(thread, regKey, sleepAddress)
captured.suspend()
captured.fetchContext()         → read hardware registers into cache
captured.setRIP(pushret)        → next instruction to execute after resume
captured.setRSP(calcStackBegin) → safe scratch stack (currentRSP - 8192, 16-aligned)
captured.setTargetReg(sleep)    → the register that pushret will 'push; ret' to
captured.applyContext()         → write cache → hardware
captured.resume()

captured.wait() loop:
  fetchContext() → check Rip == sleepAddress
  → repeat until match

return [new ProxyThread(closeFn), captured]
```

## 2. Architecture: Four-Class Composition

### Folder structure
```
src/
  nthread.ts          — Orchestrator (NThread class + Arg type)
  nthread-heap.ts     — NThreadHeap subclass
  nthread-file.ts     — NThreadFile subclass (filesystem I/O)
  crt.ts              — msvcrt resolver
  kernel32.ts         — kernel32 resolver
  globals.ts          — gadget registry
  errors.ts
  logger.ts
  index.ts
  thread/
    captured-thread.ts
    proxy-thread.ts
  memory/
    heap.ts           — Heap (slab allocator)
    romem.ts          — read-only memory registry
    alloc-options.ts  — AllocOptions interface
tests/
  helpers.ts          — spawnLoopThread / cleanupThread
  crt.test.ts
  heap.test.ts
  nthread.test.ts
  nthread-file.test.ts
  romem.test.ts
```

### `NThread` (`nthread.ts`) — Orchestrator

Lightweight orchestrator. Does **not** extend `Native.Thread`. Holds resolved gadget addresses (`sleepAddress`, `pushretAddress`, `regKey`) and an optional `processId` for diagnostics.

**`export type Arg = bigint | number | Native.NativePointer | string`** — defined here, re-exported from `index.ts`. String arguments are auto-resolved to remote pointers via `resolveArgs` (ASCII → utf8, non-ASCII → utf16le).

**Constructor**: `(processId?, sleepAddress?, pushretAddress?, regKey?)` — resolves gadgets from the global registry if not explicitly provided.

**`inject(thread: Native.Thread | number)`**: Creates a `CapturedThread`, performs the hijack sequence, and returns a `[ProxyThread, CapturedThread]` tuple.

**`threadCall(thread, target, args, timeoutMs)`**: x64 calling convention: maps up to 4 args to `RCX, RDX, R8, R9`, sets `RIP` to target, `RSP` to `thread.callRsp`, resumes, and waits for RIP to return to sleep. Returns `RAX` as `NativePointer`.

**`writeMemory(thread, dest, source)`**: Checks the global romem registry for overlapping regions. If overlap found, splits the write into up to 3 parts (before/overlap/after): the overlap goes through `writeMemorySafeBuffer` (skips unchanged bytes) and `updateSnapshot` updates the local copy.

**`writeMemoryWithPointer(thread, dest, source, size)`**: Reads from a `NativePointer` source, then writes via decomposed memset. Does **not** check romem.

**`writeMemorySafe(thread, dest, source, lastDest)`**: Routes to optimized variants:
- `lastDest: number` → uniform fill — skips bytes matching `fillByte`
- `lastDest: Buffer` → snapshot diff — skips bytes matching the previous state

**Overridable hooks** (protected, called by the proxy delegates):
- `threadClose(proxy, captured, suicide?)` — default: terminate (if suicide) then `captured.close()`
- `threadAlloc(proxy, size, opts?)` — default: `malloc`/`calloc`/`malloc+memset`; `opts.address` → CRT `realloc`
- `threadDealloc(proxy, ptr)` — default: call `crt.free`

### `CapturedThread` (`thread/captured-thread.ts`) — Thread State

Extends `Native.Thread` from `@cheatron/native`. Owns all low-level thread state.

**Context cache pattern**: Two-layer context system:
- `latestContext`: in-memory cache. `getContext()` / `setContext()` operate on this.
- Hardware: `fetchContext()` reads from hardware → cache. `applyContext()` writes cache → hardware.

**Fields**: `suspendCount`, `savedContext`, `latestContext`, `callRsp: bigint = 0n`, `sleepAddress`, `regKey`.

**`release()`**: Restores the thread to its pre-hijack state without closing the handle: `suspend → setContext(savedContext) → applyContext → resume`.

**`close()`**: Calls `release()` (try-catch for dead threads), drains remaining `suspendCount`, then `super.close()`.

**`wait()` implementation**: Polls `fetchContext()` in a loop, checking `BigInt(rip) === sleepAddress.address`. On `fetchContext()` throw → `super.wait(0)` to detect termination.

**`calcStackBegin(baseRsp)`**: Computes `alignStack(baseRsp + STACK_ADD)` where `STACK_ADD = -8192n`. Parameter is the **current RSP value**.

### `ProxyThread` (`thread/proxy-thread.ts`) — Extensible Interface

High-level interface for interacting with a captured thread. Does **not** hold a `CapturedThread` reference.

**Delegate pattern**: Private function fields with setter methods. Public methods auto-pass `this` as the first argument.

**Private fields**: `_read`, `_write`, `_call`, `_close`, `_alloc`, `_dealloc`

**Setters**: `setReader`, `setWriter`, `setCaller`, `setCloser`, `setAllocer`, `setDeallocer`

**Function signatures** (all receive `proxy: ProxyThread` as first arg):
```typescript
type ReadMemoryFn  = (proxy, address, size) => Promise<Buffer>
type WriteMemoryFn = (proxy, address, data, size?) => Promise<number>
type CallFn        = (proxy, address, ...args) => Promise<NativePointer>
type CloseFn       = (proxy, suicide?) => Promise<void>
type AllocFn       = (proxy, size, opts?) => Promise<NativePointer>
type DeallocFn     = (proxy, ptr) => Promise<void>
```

**Public methods**: `read`, `write`, `call`, `close(suicide?)`, `alloc(size, opts?)`, `dealloc(ptr)`, `allocString(str, encoding?, opts?)`

**`allocString(str, encoding?, opts?)`**: Encodes the string (default `utf16le`), appends a null terminator (2 bytes for `utf16le`/`ucs2`, 1 byte otherwise), calls `alloc()` then `write()`. Returns the remote pointer.

**Constructor**: `(close: CloseFn, process?: Native.Process)` — `close` is required. `process` is captured in default `_read`/`_write` closures.

**During `inject()`**, NThread configures the proxy:
- `_close` → `nthread.threadClose(captured, ...)`
- `setCaller` → delegates to `nthread.threadCall(captured, ...)`
- `setWriter` → routes to `writeMemoryWithPointer` (NativePointer) or `writeMemory` (Buffer)
- `setAllocer` → `nthread.threadAlloc(...)`
- `setDeallocer` → `nthread.threadDealloc(...)`

**CRT auto-binding**: All `crt` entries (including `free`) are bound as methods on the proxy instance (e.g. `proxy.malloc(size)`, `proxy.free(ptr)`). The delegate method for managed deallocation is `proxy.dealloc(ptr)`.

### `NThreadHeap` (`nthread-heap.ts`) — Heap Subclass

Subclass of `NThread`. Maintains a `ProxyState` per proxy: `{ heap: Heap | null, prevHeaps: Heap[], allocations: Map<bigint, AllocRecord> }`.

**Model**: Single `Heap` block per proxy. When full, doubles size up to `maxSize`, old block pushed to `prevHeaps`. If `maxSize` is reached or request is oversized → `super.threadAlloc()` (CRT malloc). `AllocRecord = { alloc: HeapAlloc; heap: Heap } | 'super'`.

**Constants**: `DEFAULT_NTHREAD_HEAP_SIZE = 65536`, `DEFAULT_NTHREAD_HEAP_MAX_SIZE = 65536 * 8`

**`threadClose`** override: destroys all heap blocks (prevHeaps + active) before calling `super.threadClose()`.

**`threadAlloc`** override:
- `opts.address` → `reallocInternal` (heap-aware realloc)
- Otherwise → `allocFromHeap` (try current heap → grow → fallback to super)

**`reallocInternal`**: detects old zone from address range; preserves zone unless `opts.readonly` is explicitly set; fills `[copyLen..newSize]` with `opts.fill`; fallback uses `{ ...opts, address: undefined }` to avoid CRT realloc on a heap pointer.

### `AllocOptions` (`memory/alloc-options.ts`)

```typescript
interface AllocOptions {
  fill?: number;                // byte value to fill new/all bytes
  readonly?: boolean;           // zone hint: true = READONLY zone in Heap
  address?: NativePointer;      // realloc mode: resize this existing allocation
}
```

## 3. Gadget Registry (`globals.ts`)

Two internal pools:
- `sleepAddresses: NativePointer[]`
- `pushretAddresses: Map<bigint, { pointer: NativePointer, regKey }>` — keyed by address (bigint)

**Auto-discovery** (`autoDiscoverAddresses()`): Runs once (guarded by `isAutoDiscovered`). Uses `@cheatron/keystone` to assemble target byte patterns, then calls `Native.Module.scan()` across `ntdll`, `kernel32`, `kernelbase`, `msvcrt`.

**Register priority** (`leastClobberedRegs`): `["Rbx", "Rbp", "Rdi", "Rsi"]`.

## 4. CRT Resolver (`crt.ts`)

Resolves `msvcrt.dll` exports at module load time via `Native.Module.crt.getProcAddress(name)`. All values are `NativePointer`.

Exported functions: `fopen`, `memset`, `malloc`, `calloc`, `fwrite`, `fflush`, `fclose`, `fread`, `fseek`, `realloc`, `free`.

**Important**: Top-level initialization — depends on `@cheatron/native`'s module graph being fully resolved.

## 5. Memory Write Strategies

### `memset`-write
Calls target thread's `msvcrt!memset`. Buffer is decomposed into **runs of equal bytes** — one `memset` call per run. Safe-write variant skips bytes matching a `local_cpy` snapshot.

### `memset`-write vs file-channel-write decision
When using `NThreadFile`, all writes go through the filesystem channel (single `fread` call). The base `NThread` / `NThreadHeap` classes use the decomposed `memset` strategy instead.

### `NThreadFile` (`nthread-file.ts`) — Filesystem I/O Subclass

Subclass of `NThreadHeap`. Replaces `ReadProcessMemory`/`WriteProcessMemory` (and the base class's decomposed `memset` write strategy) with bidirectional filesystem channels.

**Inheritance**: `NThread` → `NThreadHeap` → `NThreadFile`

**Constants**: `DEFAULT_FILE_MAX_TRANSFER = 1048576` (1 MiB) — reserved for future path-rotation support.

**Per-proxy state** (`FileChannelState`): `filePath` (local temp file path), `stream` (`FILE*` handle kept open in the target).

**`inject()` override**:
1. Calls `super.inject()` to perform the base hijack + heap setup.
2. Generates a unique temp file path via `crypto.randomBytes`.
3. Opens the file in the target with `fopen(path, "w+b")` — the `FILE*` is kept open.
4. Overrides `proxy.setWriter()` → `fileChannelWrite` and `proxy.setReader()` → `fileChannelRead`.
5. On failure, calls `proxy.close()` to clean up the base injection.

**`fileChannelWrite` (attacker → target)**:
1. Writes data to local temp file (`fs.writeFileSync` — truncates).
2. `fseek(stream, 0, SEEK_SET)` to reset the target's stream position.
3. `fread(dest, 1, size, stream)` reads from the file into the target address.

**`fileChannelRead` (target → attacker)**:
1. `fseek(stream, 0, SEEK_SET)` to reset the target's stream position.
2. `fwrite(src, 1, size, stream)` dumps target memory to the file.
3. `fflush(stream)` ensures data reaches disk.
4. Reads the file locally (`fs.readFileSync`).

**`threadClose` override**: Closes the `FILE*` stream via `fclose`, deletes the temp file (best-effort), then delegates to `super.threadClose()` (heap destruction + thread restore).

**Note**: The file channel bypasses the romem snapshot system entirely. Read-only memory regions are not snapshot-tracked when using file-channel writes — the full buffer is transferred every time. Path rotation (reusing new file paths after `max_transfer` bytes) is not yet implemented.

## 6. Filesystem Channel — Design Notes

Bidirectional memory I/O entirely through the filesystem — no `ReadProcessMemory`, no `WriteProcessMemory`.

Architecture:
- Single temp file opened once with `"w+b"` (read+write) during `inject()`, kept open as `FILE*`.
- **Write channel** (attacker → target): attacker writes temp file locally → `fseek(0)` + `fread` in target
- **Read channel** (target → attacker): `fseek(0)` + `fwrite` + `fflush` in target → attacker reads temp file
- No per-operation `fopen`/`fclose` overhead — only `fseek` resets the position
- Path rotation after `max_transfer` bytes (not yet implemented)

## 7. Memory Region Abstraction (`ntmem`) — Partially Ported

`ntmem_t` manages a target region as a triple-buffer: `remote` (target heap), `local` (attacker working copy), `local_cpy` (snapshot for dirty-range detection). Partially ported as `romem`.

## 7b. Read-Only Memory Registry (`memory/romem.ts`)

Typescript-native write optimization. Tracks `(remote: NativePointer, local: Buffer)` pairs.

### API

| Function | Description |
|----------|-------------|
| `createReadOnlyMemory(proxy, size)` | Allocates via `calloc(1, size)`, registers, returns `ReadOnlyMemory` |
| `registerReadOnlyMemory(remote, local)` | Manual registration |
| `unregisterReadOnlyMemory(romem)` | Removes from registry (does NOT free remote memory). Returns `boolean`. |
| `findOverlappingRegion(destAddr, writeLen)` | Returns overlapping region or `undefined` |
| `getOverlapInfo(destAddr, writeLen, romem)` | Returns `{ writeOffset, overlapLen, snapshot }` |
| `updateSnapshot(romem, source, destAddr)` | Copies written bytes into `romem.local` |

### Integration with `NThread.writeMemory`

`writeMemory` calls `findOverlappingRegion` on every invocation. If overlap found: split into up to 3 parts → overlap goes through `writeMemorySafeBuffer` → `updateSnapshot` called after.

## 8. Dependencies

- **`@cheatron/native`**: `NativePointer`, `IPointer`, `Thread`, `Module`, `Pattern`, `Scanner`, `currentProcess`, `ContextFlags`, `MemoryState`, `MemoryProtection`
- **`@cheatron/keystone`**: `KeystoneX86` for assembling gadget patterns during auto-discovery
- **`@cheatron/log`**: Shared logger, re-exported from `@cheatron/native`

## 9. Development & Testing

- **Environment**: Wine on Linux (`wine /path/to/bun-windows-x64/bun.exe test`)
- **Known Wine behavior**: After tests complete, Wine may log `NtRaiseException` or sync errors — expected, not a code bug.
- **Shared helper** (`tests/helpers.ts`): `spawnLoopThread()` → `{ loopAddr, thread, tid }`, `cleanupThread(spawned)` → terminate + free. Used by all tests that need a live thread.

### Test structure
- `tests/crt.test.ts` — verifies CRT function pointer resolution
- `tests/heap.test.ts` — `Heap` slab allocator: alloc, free, reuse, write, destroy
- `tests/nthread.test.ts` — inject into `jmp .` thread, verify context, `proxy.write()`, `allocString`, `ExitThread(42)` via `proxy.call()`
- `tests/nthread-file.test.ts` — file channel inject, write/read through file channel, large buffer, `allocString`, `proxy.close()` cleanup
- `tests/romem.test.ts` — `createReadOnlyMemory`, skip-write for identical data, snapshot updates, `unregisterReadOnlyMemory`


### Hijack flow (in `NThread.inject(thread)`):
```
captured = new CapturedThread(thread, regKey, sleepAddress)
captured.suspend()
captured.fetchContext()         → read hardware registers into cache
captured.setRIP(pushret)        → next instruction to execute after resume
captured.setRSP(calcStackBegin) → safe scratch stack (currentRSP - 8192, 16-aligned)
captured.setTargetReg(sleep)    → the register that pushret will 'push; ret' to
captured.applyContext()         → write cache → hardware
captured.resume()

captured.wait() loop:
  fetchContext() → check Rip == sleepAddress
  → repeat until match

return [new ProxyThread(closeFn), captured]
```

