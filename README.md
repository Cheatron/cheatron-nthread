# @cheatron/nthread

**NThread** is a thread hijacking library for x64 Windows that seizes control of existing threads — without injecting shellcode, allocating remote memory, or using `CreateRemoteThread`.

> Built on [@cheatron/native](https://github.com/Cheatron/cheatron-native). TypeScript port of the original [C/C++ NThread](https://github.com/woldann/NThread).

> [!IMPORTANT]
> **64-bit Windows only.** Requires Wine to develop/test on Linux.

---

## How It Works

NThread reuses two tiny instruction sequences (gadgets) already present in loaded modules:

| Gadget | Pattern | Purpose |
|--------|---------|--------|
| **Sleep** | `jmp .` (`EB FE`) | Parks the thread in an infinite loop |
| **Pivot** | `push reg; ret` | Redirects `RIP` to the sleep gadget |

Hijack sequence: suspend → capture context → redirect RIP through pivot → spin until RIP lands on sleep gadget. No shellcode, no remote allocation — just register writes.

---

## Features

- **No code injection** — reuses gadgets in `ntdll`, `kernel32`, `kernelbase`, `msvcrt`
- **No `WriteProcessMemory`** — memory ops are performed by hijacking the target thread to call its own `msvcrt` functions
- **Auto-discovery** — scans modules lazily via `Module.scan()`
- **Reversible** — saves full register context before hijacking; restores on `proxy.close()`
- **CRT bridge** — resolves `msvcrt!malloc`, `calloc`, `memset`, `fwrite`, etc. and calls them *from inside the target thread*
- **Write optimization** — `romem` tracks known region contents and lets `write()` skip unchanged bytes automatically
- **Heap allocator** — `NThreadHeap` pre-allocates a single heap block in the target and sub-allocates from it, minimising round-trips

---

## Installation

```bash
bun add @cheatron/nthread
```

---

## Quick Start

```typescript
import { NThread, createReadOnlyMemory } from '@cheatron/nthread';

const nthread = new NThread();

// Hijack an existing thread by TID
const [proxy, captured] = await nthread.inject(tid);

// Call a function inside the target thread (x64 calling convention)
const ptr = await proxy.call(crt.malloc, 1024n);

// Write memory via hijacked memset calls
await proxy.write(ptr, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));

// Allocate and write a wide string in one step
const strPtr = await proxy.allocString('Hello, target!');

// Read memory back
const buf = await proxy.read(ptr, 4);

// Restore original context and release
await proxy.close();
```

---

## Core Components

### `NThread`

Lightweight orchestrator — holds resolved gadget addresses and runs the hijack sequence.

```typescript
new NThread(processId?, sleepAddress?, pushretAddress?, regKey?)
```

| Method | Description |
|--------|-------------|
| `inject(thread)` | Hijack a thread (TID or `Thread`), returns `[ProxyThread, CapturedThread]` |
| `threadCall(thread, target, args, timeout)` | Execute a function call on a captured thread |
| `writeMemory(thread, dest, source)` | Write via decomposed `memset` calls; romem-aware |

Overridable hooks (for subclasses):
- `threadClose(proxy, captured, suicide?)` — called by `proxy.close()`
- `threadAlloc(proxy, size, opts?)` — called by `proxy.alloc()`
- `threadFree(proxy, ptr)` — called by `proxy.free()`

### `NThreadHeap`

Subclass of `NThread`. Pre-allocates a single heap block (`calloc`) in the target and sub-allocates from it. The heap doubles on full (up to `maxSize`); oversized requests fall back to `msvcrt!malloc`.

```typescript
new NThreadHeap(heapSize?, maxSize?, processId?, sleepAddress?, pushretAddress?, regKey?)
// Defaults: heapSize = 65536, maxSize = 65536 * 8
```

All proxy allocations are **freed atomically on `proxy.close()`**.

### `CapturedThread`

Extends `Native.Thread`. Owns the hardware context cache, suspend tracking, and register manipulation for a single captured thread.

| Method | Description |
|--------|-------------|
| `fetchContext()` / `applyContext()` | Sync hardware ↔ cache |
| `getRIP()` / `setRIP(addr)` | RIP convenience accessors |
| `wait(timeoutMs?)` | Poll until RIP == sleep address |
| `release()` | Restore saved context without closing handle |
| `close()` | `release()` → drain suspends → close handle |

### `ProxyThread`

High-level interface for a captured thread. Each operation is a replaceable delegate.

```typescript
new ProxyThread(close: CloseFn, process?: Native.Process)
```

| Method | Description |
|--------|-------------|
| `read(address, size)` | Read memory |
| `write(address, data, size?)` | Write memory |
| `call(address, ...args)` | Call a function |
| `alloc(size, opts?)` | Allocate memory (`malloc`/`calloc`/realloc) |
| `free(ptr)` | Free memory |
| `allocString(str, encoding?, opts?)` | Alloc + write a string; null-terminated; default encoding `utf16le` |
| `close(suicide?)` | Release the thread (or terminate with exit code) |
| `setReader/setWriter/setCaller/setCloser/setAllocer/setFreer` | Replace delegates |

### `globals.ts` — Gadget Registry

Manages sleep and pushret gadget pools. Auto-discovery runs once lazily on first use, scanning `ntdll`, `kernel32`, `kernelbase`, `msvcrt`. Register priority: `Rbx → Rbp → Rdi → Rsi`.

### `crt.ts` — CRT Bridge

Resolves `msvcrt.dll` exports at load time (`malloc`, `calloc`, `free`, `memset`, `realloc`, `fopen`, `fread`, `fwrite`, `fflush`, `fclose`). All values are `NativePointer` — set as `RIP` on the hijacked thread.

---

## Read-Only Memory (`romem`)

`romem` tracks a known-content region as a `(remote: NativePointer, local: Buffer)` pair. `proxy.write()` auto-detects overlaps and skips unchanged bytes.

```typescript
import { createReadOnlyMemory, unregisterReadOnlyMemory } from '@cheatron/nthread';

const romem = await createReadOnlyMemory(proxy, 256); // calloc in target
const data = Buffer.alloc(256);
data.writeUInt32LE(0xDEADBEEF, 0);
await proxy.write(romem.remote, data); // only changed bytes are written

unregisterReadOnlyMemory(romem);
```

---

## Development

```bash
bun install
bun run build
wine /path/to/bun.exe test
```

---

## License

MIT
