# @cheatron/nthread

**NThread** is a thread hijacking library for x64 Windows that seizes control of existing threads — without injecting shellcode, allocating remote memory, or using `CreateRemoteThread`.

> Built on [@cheatron/native](https://github.com/Cheatron/cheatron-native). TypeScript port of the original [C/C++ NThread](https://github.com/woldann/NThread).

> [!IMPORTANT]
> **64-bit Windows only.** Requires Wine to develop/test on Linux.

---

## How It Works

NThread reuses two tiny instruction sequences (gadgets) already present in loaded modules:

| Gadget | Pattern | Purpose |
|--------|---------|---------|
| **Sleep** | `jmp .` (`EB FE`) | Parks the thread in an infinite loop |
| **Pivot** | `push reg; ret` | Redirects `RIP` to the sleep gadget |

Hijack sequence: suspend → capture context → redirect RIP through pivot → spin until RIP lands on sleep gadget. No shellcode, no remote allocation — just register writes.

```
suspend thread
    → save full register context
    → set RIP = pushret gadget
    → set RSP = safe scratch area (current RSP − 8192, 16-aligned)
    → set target register = sleep address
    → apply context → resume
    → poll until RIP == sleep address
    → thread is now parked and ready for commands
```

---

## Features

- **No code injection** — reuses gadgets in `ntdll`, `kernel32`, `kernelbase`, `msvcrt`
- **No `WriteProcessMemory`** — memory ops use the target thread's own `msvcrt` functions
- **Auto-discovery** — scans loaded modules lazily via `Module.scan()`
- **Reversible** — saves full register context before hijacking; restores on `proxy.close()`
- **CRT bridge** — resolves `msvcrt` exports (`malloc`, `calloc`, `memset`, `strlen`, `wcslen`, `fopen`, `fread`, etc.) and calls them *from inside the target thread*
- **kernel32 bridge** — resolves `kernel32` exports (`LoadLibraryA/W`, `GetModuleHandleExA/W`, etc.) — all auto-bound on the proxy
- **String args** — pass strings directly to `proxy.call()`, automatically allocated and freed
- **Write optimization** — `romem` tracks known region contents and skips unchanged bytes automatically
- **Heap allocator** — `NThreadHeap` pre-allocates a heap block in the target and sub-allocates from it, minimising CRT round-trips
- **File channel** — `NThreadFile` replaces RPM/WPM with bidirectional filesystem I/O through a single temp file

---

## Installation

```bash
bun add @cheatron/nthread
```

---

## Quick Start

### Basic — `NThread`

```typescript
import { NThread, crt } from '@cheatron/nthread';

const nthread = new NThread();
const [proxy, captured] = await nthread.inject(tid);

// Call a function inside the target thread (x64 calling convention)
const ptr = await proxy.call(crt.malloc, 1024n);

// Write memory via hijacked memset calls
await proxy.write(ptr, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));

// Read memory back
const buf = await proxy.read(ptr, 4);

// Restore original context and release
await proxy.close();
```

### Heap — `NThreadHeap`

```typescript
import { NThreadHeap } from '@cheatron/nthread';

const nt = new NThreadHeap();
const [proxy] = await nt.inject(tid);

// alloc/free go through the local heap — fewer CRT calls
const ptr = await proxy.alloc(256, { fill: 0 });
await proxy.write(ptr, myData);
await proxy.dealloc(ptr);

// Allocate and write a null-terminated string in one step
const strPtr = await nt.allocString(proxy, 'Hello, target!');

await proxy.close(); // frees all heap blocks atomically
```

### File Channel — `NThreadFile`

```typescript
import { NThreadFile } from '@cheatron/nthread';

const nt = new NThreadFile();
const [proxy] = await nt.inject(tid);

// read/write now go through a temp file — no RPM/WPM
const ptr = await proxy.alloc(4096, { fill: 0 });
await proxy.write(ptr, largeBuffer);          // fs.writeFileSync → fread
const data = await proxy.read(ptr, 4096);     // fwrite + fflush → fs.readFileSync

await proxy.close(); // closes FILE*, deletes temp file, destroys heaps, restores thread
```

### File I/O Helpers

```typescript
// Open a file in the target process
const stream = await nthread.fileOpen(proxy, 'C:\\data\\log.txt', 'rb');

// Read 512 bytes from the stream → local Buffer
const buf = await nthread.fileRead(proxy, stream, 512);

// Write data to a stream (string, Buffer, or NativeMemory)
await nthread.fileWrite(proxy, stream, 'hello');

// Flush and close
await nthread.fileFlush(proxy, stream);
await nthread.fileClose(proxy, stream);
```

### Read-Only Memory (`romem`)

Tracks a known-content region as a `(remote, local)` pair. `proxy.write()` auto-detects overlaps and skips unchanged bytes.

```typescript
import { createReadOnlyMemory, unregisterReadOnlyMemory } from '@cheatron/nthread';

const romem = await createReadOnlyMemory(proxy, 256); // calloc in target
const data = Buffer.alloc(256);
data.writeUInt32LE(0xDEADBEEF, 0);
await proxy.write(romem.remote, data); // only the 4 changed bytes are written

unregisterReadOnlyMemory(romem);
```

---

## Class Hierarchy

```
NThread              — Orchestrator: inject, threadCall, writeMemory, CRT helpers
  └─ NThreadHeap     — Heap sub-allocator per proxy (doubles up to maxSize)
       └─ NThreadFile — Filesystem-based I/O channel (single temp file)
```

### `NThread`

Lightweight orchestrator — holds resolved gadget addresses and runs the hijack sequence.

```typescript
new NThread(processId?, sleepAddress?, pushretAddress?, regKey?)
```

| Method | Description |
|--------|-------------|
| `inject(thread)` | Hijack a thread (TID or `Thread`), returns `[ProxyThread, CapturedThread]` |
| `allocString(proxy, str, opts?)` | Allocate + write a null-terminated string |
| `writeString(proxy, dest, str)` | Write a null-terminated string to an existing address |
| `fileOpen(proxy, path, mode)` | `fopen` in the target; auto-allocates/frees string args |
| `fileWrite(proxy, stream, data)` | `fwrite` — accepts `Buffer`, `string`, or `NativeMemory` |
| `fileRead(proxy, stream, dest)` | `fread` — `NativeMemory` or byte-count → `Buffer` |
| `fileFlush(proxy, stream)` | `fflush` |
| `fileClose(proxy, stream)` | `fclose` |

Overridable hooks (for subclasses):
- `threadClose(proxy, captured, suicide?)` — called by `proxy.close()`
- `threadAlloc(proxy, size, opts?)` — called by `proxy.alloc()`
- `threadDealloc(proxy, ptr)` — called by `proxy.dealloc()`

### `NThreadHeap`

Subclass of `NThread`. Pre-allocates a heap block in the target and sub-allocates from it. The block doubles on full (up to `maxSize`); oversized requests fall back to `msvcrt!malloc`.

```typescript
new NThreadHeap(heapSize?, maxSize?, processId?, sleepAddress?, pushretAddress?, regKey?)
// Defaults: heapSize = 65536, maxSize = 524288
```

All heap blocks are **freed atomically on `proxy.close()`**.

### `NThreadFile`

Subclass of `NThreadHeap`. Replaces `ReadProcessMemory`/`WriteProcessMemory` (and the base class's decomposed `memset` writes) with a bidirectional filesystem channel.

```typescript
new NThreadFile(heapSize?, maxSize?, processId?, sleepAddress?, pushretAddress?, regKey?)
```

- Opens a single temp file in the target with `fopen(path, "w+b")` during `inject()`
- **Write** (attacker → target): write locally → `fseek(0)` + `fread` in target
- **Read** (target → attacker): `fseek(0)` + `fwrite` + `fflush` in target → read locally
- `proxy.close()` calls `fclose`, deletes the temp file, then destroys heaps and restores the thread

### `ProxyThread`

High-level interface returned by `inject()`. Each operation is a replaceable delegate.

| Method | Description |
|--------|-------------|
| `read(address, size)` | Read memory from the target |
| `write(address, data, size?)` | Write memory to the target |
| `call(address, ...args)` | Call a function (up to 4 args: RCX, RDX, R8, R9) |
| `alloc(size, opts?)` | Allocate memory (`AllocOptions`: `fill`, `readonly`, `address`) |
| `dealloc(ptr)` | Deallocate memory (routes through delegate; subclasses may use managed heap) |
| `close(suicide?)` | Release thread, or terminate with exit code |
| `bind(name, address)` | Bind a remote function as a named method on the proxy |

**Delegate setters**: `setReader`, `setWriter`, `setCaller`, `setCloser`, `setAllocer`, `setDeallocer` — replace any operation with a custom function.

**CRT auto-binding**: All resolved `msvcrt` functions are bound as methods on the proxy (e.g. `proxy.malloc(size)`, `proxy.free(ptr)`, `proxy.strlen(str)`).

**kernel32 auto-binding**: All resolved `kernel32` functions are also bound (e.g. `proxy.LoadLibraryA(name)`, `proxy.GetModuleHandleExA(flags, name, phModule)`).

**`bind(name, address)`**: Creates a named property on the proxy that delegates to `this.call(address, ...args)`. Used internally for CRT/kernel32 auto-binding — also available for custom bindings.

### `CapturedThread`

Extends `Native.Thread`. Owns the hardware context cache, suspend tracking, and register manipulation.

| Method | Description |
|--------|-------------|
| `fetchContext()` / `applyContext()` | Sync hardware ↔ cache |
| `getRIP()` / `setRIP(addr)` | RIP convenience accessors |
| `wait(timeoutMs?)` | Poll until RIP == sleep address |
| `release()` | Restore saved context without closing handle |
| `close()` | `release()` → drain suspends → close handle |

### `AllocOptions`

```typescript
interface AllocOptions {
  fill?: number;                // byte value to fill allocated memory
  readonly?: boolean;           // allocate in the readonly zone of the heap
  address?: NativePointer;      // realloc mode: resize an existing allocation
}
```

---

## Gadget Auto-Discovery

Gadgets are discovered lazily on first `inject()`. The scanner searches `ntdll`, `kernel32`, `kernelbase`, and `msvcrt` for:

- **Sleep**: `EB FE` (`jmp .`)
- **Pushret**: `push reg; ret` — register priority: `Rbx → Rbp → Rdi → Rsi` (least-clobbered by `msvcrt` calls)

You can also provide explicit gadget addresses in the constructor if you prefer manual control:

```typescript
const nt = new NThread(pid, mySleepAddr, myPushretAddr, 'Rbx');
```

---

## CRT Bridge

`crt.ts` resolves `msvcrt.dll` exports at load time. All values are `NativePointer` — used as `RIP` targets for `threadCall`.

```typescript
import { crt } from '@cheatron/nthread';

crt.malloc   // msvcrt!malloc
crt.calloc   // msvcrt!calloc
crt.realloc  // msvcrt!realloc
crt.free     // msvcrt!free
crt.memset   // msvcrt!memset
crt.strlen   // msvcrt!strlen
crt.wcslen   // msvcrt!wcslen
crt.fopen    // msvcrt!fopen
crt.fread    // msvcrt!fread
crt.fwrite   // msvcrt!fwrite
crt.fseek    // msvcrt!fseek
crt.fflush   // msvcrt!fflush
crt.fclose   // msvcrt!fclose
```

---

## kernel32 Bridge

`kernel32.ts` resolves `kernel32.dll` exports at load time. All values are `NativePointer` — used as `RIP` targets for `threadCall`.

```typescript
import { kernel32 } from '@cheatron/nthread';

kernel32.LoadLibraryA       // kernel32!LoadLibraryA
kernel32.LoadLibraryW       // kernel32!LoadLibraryW
kernel32.ReadProcessMemory  // kernel32!ReadProcessMemory
kernel32.WriteProcessMemory // kernel32!WriteProcessMemory
kernel32.GetCurrentProcess  // kernel32!GetCurrentProcess
kernel32.GetModuleHandleA   // kernel32!GetModuleHandleA
kernel32.GetModuleHandleW   // kernel32!GetModuleHandleW
kernel32.GetModuleHandleExA // kernel32!GetModuleHandleExA
kernel32.GetModuleHandleExW // kernel32!GetModuleHandleExW
```

---

## Error Hierarchy

```
NThreadError
  ├─ NoSleepAddressError              — no sleep gadget found
  ├─ NoPushretAddressError             — no pushret gadget found
  ├─ ThreadReadNotImplementedError     — threadRead not overridden
  ├─ InjectError
  │    ├─ InjectTimeoutError           — thread didn't reach sleep in time
  │    └─ MsvcrtNotLoadedError         — msvcrt.dll not in target process
  ├─ CallError
  │    ├─ CallNotInjectedError         — call before inject
  │    ├─ CallTooManyArgsError         — more than 4 args
  │    ├─ CallRipMismatchError         — RIP not at sleep before call
  │    ├─ CallTimeoutError             — function didn't return in time
  │    └─ CallThreadDiedError          — thread exited during call
  ├─ ReadError
  │    └─ ReadSizeRequiredError        — read(NativePointer) without size
  ├─ WriteError
  │    ├─ WriteSizeRequiredError       — NativePointer write without size
  │    └─ WriteFailedError             — write returned wrong byte count
  ├─ AllocError
  │    ├─ CallocNullError              — calloc returned NULL
  │    └─ ReallocNullError             — realloc returned NULL
  ├─ ProxyError
  │    ├─ ProxyReadNotConfiguredError  — read delegate not set, no Process
  │    ├─ ProxyWriteNotConfiguredError — write delegate not set, no Process
  │    └─ ProxyCallNotConfiguredError  — call delegate not set
  ├─ HeapError
  │    ├─ HeapInvalidSizeError         — invalid heap zone sizes
  │    ├─ HeapAllocSizeError           — invalid alloc size
  │    ├─ HeapZoneExhaustedError       — readonly/readwrite zone full
  │    └─ HeapFreeInvalidError         — address not in heap
  ├─ FileError                         — fopen returned NULL
  └─ GadgetError
       └─ GadgetScanError              — pattern scan failed
```

---

## Development

```bash
bun install
bun run build
bun run lint
bun run format

# Tests require Wine (Windows x64 on Linux)
wine /path/to/bun-windows-x64/bun.exe test
```

---

## License

MIT
