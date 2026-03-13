import * as Native from '@cheatron/native';
import {
  resolveEncoding,
  AsyncNativeFunctionGenerator,
  createMemmem,
} from '@cheatron/native';
import { MEMMEM_BYTES } from '@cheatron/native/dist/msvcrt-ext';
import {
  getRandomSleepAddress,
  getRandomPushretAddress,
  type GeneralPurposeRegs,
} from './globals';
import { log } from './logger';
import { ProxyThread } from './thread/proxy-thread';
import { CapturedThread } from './thread/captured-thread';
import { NThreadMemory } from './nthread-memory';
import { crtFunctions } from './crt';
import { kernel32Functions } from './kernel32';
import { GetModuleHandleExFlag } from '@cheatron/win32-ext';
import {
  NoSleepAddressError,
  NoPushretAddressError,
  InjectTimeoutError,
  InjectAbortedError,
  MsvcrtNotLoadedError,
  CallTooManyArgsError,
  CallRipMismatchError,
  CallTimeoutError,
  CallThreadDiedError,
  ReallocNullError,
  ThreadReadNotImplementedError,
  WaitAbortedError,
} from './errors';
import {
  findOverlappingRegion,
  getOverlapInfo,
  updateSnapshot,
} from './memory/romem';

import type { AllocOptions } from './memory/alloc-options';

export { STACK_ADD } from './thread/captured-thread';

/**
 * Register-compatible argument type.
 * All values are ultimately converted to bigint for register assignment (RCX, RDX, R8, R9).
 * Accepts NativePointer (→ .address) and number (→ BigInt()) for convenience.
 */
export type Arg = bigint | number | Native.NativePointer | string;

export interface InjectOptions {
  /** `AbortSignal` to cancel the inject operation. Rejection: `InjectAbortedError`. */
  signal?: AbortSignal;
  /** Maximum ms to wait for the thread to reach the sleep gadget. Default: 5000. */
  timeoutMs?: number;
  /**
   * Poll interval (ms) used **only** during the initial hijack wait — i.e. while
   * waiting for the target thread to reach the sleep gadget.  After injection
   * completes this is reset to 1 ms so that every `proxy.call()` responds quickly.
   *
   * Raise this to reduce CPU burn when injecting into a thread parked in a long
   * syscall (e.g. `Sleep(5000)`).  Default: 50.
   */
  pollIntervalMs?: number;
}

const nthreadLog = log.child('');

/**
 * NThread: Orchestrates non-invasive thread hijacking.
 *
 * It works by suspending a target thread, redirecting its Rip to a 'pushreg/ret' gadget,
 * setting a 'sleep' address as the target, and waiting for the thread to 'land'
 * at said sleep address. Once landed, the thread is effectively seized without
 * stopping the underlying process or requiring complex debugging APIs.
 *
 * The actual thread state (context cache, suspend tracking, proxy) is managed by
 * the contained CapturedThread instance, created during inject().
 */
export class NThread {
  /** Optional process ID for diagnostics and logging */
  public processId?: number;

  /** Address of an infinite loop gadget ('jmp .') used to hold the thread */
  public sleepAddress?: Native.NativePointer;

  /** Address of a pivot gadget ('push reg; ret') used to redirect execution */
  public pushretAddress?: Native.NativePointer;

  /** The register key (e.g., 'Rbx') used for the pushret pivot */
  public regKey?: GeneralPurposeRegs;

  /**
   * Creates an NThread instance and prepares redirect gadgets.
   * @param processId Optional process ID for diagnostics and logging.
   * @param sleepAddress Optional explicit sleep gadget.
   * @param pushretAddress Optional explicit pushret gadget.
   * @param regKey Optional register preference for the pushret gadget.
   */
  constructor(
    processId?: number,
    sleepAddress?: Native.NativePointer,
    pushretAddress?: Native.NativePointer,
    regKey?: GeneralPurposeRegs,
  ) {
    this.processId = processId;
    this.sleepAddress = sleepAddress;
    this.pushretAddress = pushretAddress;
    this.regKey = regKey;
  }

  async setRandomSleepAddress() {
    this.sleepAddress = await getRandomSleepAddress();
    if (!this.sleepAddress) {
      throw new NoSleepAddressError();
    }
  }

  async setRandomPushretAddress() {
    const randomPushret = await getRandomPushretAddress(this.regKey);
    if (!randomPushret) {
      throw new NoPushretAddressError();
    }
    this.pushretAddress = randomPushret.address;
    this.regKey = randomPushret.regKey;
  }

  /**
   * Executes the hijacking flow:
   * 1. Create a CapturedThread from the given thread parameter.
   * 2. Suspend the thread.
   * 3. Capture and save current register state.
   * 4. Redirect Rip to PushRet gadget.
   * 5. Point the chosen register (RegKey) to the Sleep gadget.
   * 6. Adjust stack (Rsp) to a safe scratch area.
   * 7. Resume and wait for the thread to 'trap' itself in the loop.
   *
   * @param thread Thread object or Thread ID to hijack.
   */
  async inject(
    thread: Native.Thread | number | CapturedThread,
    options?: InjectOptions,
  ): Promise<[ProxyThread, CapturedThread]> {
    const timeoutMs = options?.timeoutMs ?? 5000;
    const pollIntervalMs = Math.max(0, options?.pollIntervalMs ?? 50);
    this.throwIfAborted(options?.signal);

    if (!this.sleepAddress) {
      await this.setRandomSleepAddress();
      this.throwIfAborted(options?.signal);
    }
    if (!this.pushretAddress || !this.regKey) {
      await this.setRandomPushretAddress();
      this.throwIfAborted(options?.signal);
    }

    // After the set calls above, all three are guaranteed non-null (they throw on failure)
    const sleepAddress = this.sleepAddress!;
    const pushretAddress = this.pushretAddress!;
    const regKey = this.regKey!;

    // If an already-captured thread is provided, skip the hijack sequence
    // and go straight to proxy setup. No try-catch here — the caller owns the
    // CapturedThread and is responsible for cleanup on failure.
    if (thread instanceof CapturedThread) {
      this.throwIfAborted(options?.signal);
      const result = await this.setupProxy(thread);
      this.throwIfAborted(options?.signal);
      await this.ensureCrtLoaded(result[0], thread);
      nthreadLog.info(`Proxy configured for captured thread ${thread.tid}`);
      return result;
    }

    // Resolve handle + tid. Keep the source object alive in scope so the GC
    // happens only on success.
    let handle: Native.HANDLE;
    let tid: number;

    if (thread instanceof Native.Thread) {
      handle = thread.rawHandle;
      tid = thread.tid;
    } else {
      const sourceThread = Native.Thread.open(thread);
      handle = sourceThread.rawHandle;
      tid = sourceThread.tid;
    }

    const captured = new CapturedThread(handle, tid, regKey, sleepAddress);
    captured.pollIntervalMs = pollIntervalMs;

    try {
      captured.suspend();

      captured.fetchContext();
      captured.savedContext = captured.getContext();

      // Preserve original values to restore them later
      const targetReg = captured.savedContext[regKey];
      const rip = captured.savedContext.Rip;
      const rsp = captured.savedContext.Rsp;

      // Hijack:
      // RIP -> [push reg; ret]  (The pivot)
      // REG -> [jmp .]          (The final destination)
      // pushret will 'push sleep; ret' → sleep addr lands at [stackBegin - 8]
      // call() later sets RSP to that same address so 'ret' pops sleep again.
      const stackBegin = captured.calcStackBegin(BigInt(rsp));
      captured.callRsp = stackBegin - 8n;

      captured.setRIP(pushretAddress.toBigInt());
      captured.setRSP(stackBegin);
      captured.setTargetReg(sleepAddress.toBigInt());

      captured.applyContext();
      captured.resume();

      this.throwIfAborted(options?.signal);

      nthreadLog.info(
        `Waiting for thread ${captured.tid} to reach ${sleepAddress}...`,
      );

      const res = await captured.wait(timeoutMs, options?.signal);

      if (res != Native.WaitReturn.OBJECT_0) {
        throw new InjectTimeoutError(res);
      }

      // Restore tight poll cadence for subsequent threadCall() waits.
      // The user-supplied pollIntervalMs was only needed during the hijack
      // wait (e.g. a thread stuck in a long syscall); every proxy.call()
      // after this point completes fast and should poll at 1 ms.
      captured.pollIntervalMs = 1;

      // Refresh context now that we are stably 'parked' at sleepAddress
      captured.savedContext = captured.getContext();

      // Restore original state into our local copy so we can resume naturally later
      captured.savedContext[regKey] = targetReg;
      captured.savedContext.Rip = rip;
      captured.savedContext.Rsp = rsp;

      // Ensure we capture integer and control registers for maximum control
      captured.latestContext.ContextFlags =
        Native.ContextFlags.INTEGER | Native.ContextFlags.CONTROL;

      const result = await this.setupProxy(captured);
      await this.ensureCrtLoaded(result[0], captured);

      nthreadLog.info(`Successfully injected into thread ${captured.tid}`);
      return result;
    } catch (err) {
      captured.release();
      if (err instanceof WaitAbortedError) {
        throw new InjectAbortedError();
      }
      throw err;
    }
  }

  protected throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new InjectAbortedError();
    }
  }

  /**
   * Verifies that msvcrt.dll is loaded in the target process.
   * @throws {MsvcrtNotLoadedError} if the module is not found.
   */
  protected async ensureCrtLoaded(
    proxy: ProxyThread,
    captured: CapturedThread,
  ): Promise<void> {
    if (
      !(await this.checkModuleLoaded(
        proxy,
        captured,
        Native.Module.crt.base.address,
      ))
    ) {
      throw new MsvcrtNotLoadedError();
    }
  }

  /**
   * Creates and configures a ProxyThread for the given captured thread.
   * Wires up all delegates (caller, writer, reader, allocer, deallocer).
   */
  protected async setupProxy(
    captured: CapturedThread,
  ): Promise<[ProxyThread, CapturedThread]> {
    const proxy = new ProxyThread((_proxy, suicide) =>
      this.threadClose(_proxy, captured, suicide),
    );
    proxy.setCaller((_proxy, address, ...proxyArgs) =>
      this.threadCall(_proxy, captured, address, [...proxyArgs]),
    );
    proxy.setWriter((_proxy, address, data) =>
      this.threadWrite(_proxy, address, data),
    );
    proxy.setReader((_proxy, address) => this.threadRead(_proxy, address));
    proxy.setAllocer((_proxy, size, opts) =>
      this.threadAlloc(_proxy, size, opts),
    );
    proxy.setDeallocer((_proxy, ptr) => this.threadDealloc(_proxy, ptr));

    return [proxy, captured];
  }

  /**
   * Checks whether the module owning `moduleBase` is still loaded in the target
   * process. Uses `GetModuleHandleExA` with `FROM_ADDRESS | UNCHANGED_REFCOUNT`
   * so the reference count is not bumped. The output HMODULE is written to a
   * scratch slot on the hijack stack (`callRsp - 512`) — only the return value
   * matters.
   *
   * @returns `true` if the module is loaded, `false` otherwise.
   */
  protected async checkModuleLoaded(
    proxy: ProxyThread,
    captured: CapturedThread,
    moduleBase: Arg,
    phModule?: Arg,
  ): Promise<boolean> {
    const flags =
      GetModuleHandleExFlag.UNCHANGED_REFCOUNT |
      GetModuleHandleExFlag.FROM_ADDRESS;
    const outPtr = phModule ?? captured.callRsp - 512n;
    const result = await this.threadCall(
      proxy,
      captured,
      kernel32Functions.GetModuleHandleExA,
      [flags, moduleBase, outPtr],
    );
    return result.address !== 0n;
  }

  /** Reads data from the target process via ReadProcessMemory. */
  private async threadRead(
    _proxy: ProxyThread,
    _address: Native.NativeMemory,
  ): Promise<Buffer> {
    throw new ThreadReadNotImplementedError();
  }

  /** Writes data to the target process; dispatches NativeMemory vs Buffer. */
  private async threadWrite(
    proxy: ProxyThread,
    address: Native.NativePointer,
    data: Buffer | Native.NativeMemory,
  ): Promise<number> {
    if (data instanceof Native.NativeMemory) {
      await this.writeMemoryWithPointer(proxy, address, data, data.size);
      return data.size;
    }
    const buf = data instanceof Buffer ? data : Buffer.from(data);
    await this.writeMemory(proxy, address, buf);
    return buf.length;
  }

  /**
   * Hook: called to release the proxy and captured thread.
   * Subclasses can override to perform cleanup (e.g. destroy a heap pool)
   * before closing. Default: terminate (if suicide) then close the handle.
   */
  protected async threadClose(
    _proxy: ProxyThread,
    captured: CapturedThread,
    suicide?: number,
  ): Promise<void> {
    if (suicide !== undefined) captured.terminate(suicide);
    captured.close();
  }

  /**
   * Hook: allocates memory in the target process.
   * Default: `malloc` / `calloc` / `malloc+memset` depending on `opts.fill`;
   * delegates to `msvcrt!realloc` when `opts.address` is provided.
   * Subclasses can override to use a pre-allocated heap instead.
   */
  protected async threadAlloc(
    proxy: ProxyThread,
    size: number,
    opts?: AllocOptions,
  ): Promise<Native.NativeMemory> {
    if (opts?.address) {
      const ptr = await proxy.realloc(opts.address.address, BigInt(size));
      if (ptr.address === 0n)
        throw new ReallocNullError(opts.address.address, size);
      return new Native.NativeMemory(ptr.address, size);
    }
    const fill = opts?.fill;
    if (fill === undefined) {
      const ptr = await proxy.malloc(BigInt(size));
      return new Native.NativeMemory(ptr.address, size);
    } else if (fill === 0) {
      const ptr = await proxy.calloc(1n, BigInt(size));
      return new Native.NativeMemory(ptr.address, size);
    } else {
      const ptr = await proxy.malloc(BigInt(size));
      await proxy.memset(ptr.address, BigInt(fill & 0xff), BigInt(size));
      return new Native.NativeMemory(ptr.address, size);
    }
  }

  /**
   * Hook: frees a pointer in the target process.
   * Default: `msvcrt!free`.
   * Subclasses can override to return the block to a managed heap instead.
   */
  protected async threadDealloc(
    proxy: ProxyThread,
    ptr: Native.NativePointer,
  ): Promise<void> {
    await proxy.call(crtFunctions.free, ptr.address);
  }

  /**
   * Allocates memory for a string and writes it into the remote process via the captured thread.
   * Null-terminates automatically.
   *
   * @param proxy The proxy for the captured thread.
   * @param str String to encode and write.
   * @param encoding Buffer encoding — defaults to `'utf16le'` (Windows wide string).
   * @param opts Optional alloc options forwarded to `proxy.alloc()`.
   */
  /**
  /**
   * Resolves an argument list, converting `string` values to remote pointers.
   * Uses `resolveEncoding` to auto-detect encoding (ASCII → utf8, non-ASCII → utf16le)
   * so callers can pass plain strings to both A and W variant Windows functions.
   */
  protected async resolveArgs(
    proxy: ProxyThread,
    args: Arg[],
  ): Promise<bigint[]> {
    return Promise.all(
      args.map(async (arg): Promise<bigint> => {
        if (typeof arg === 'string') {
          const [buf] = resolveEncoding(null, null, arg);
          const ptr = await proxy.alloc(buf.length);
          await proxy.write(ptr, buf);
          return ptr.address;
        }
        if (arg instanceof Native.NativePointer) return arg.address;
        return BigInt(arg);
      }),
    );
  }

  /**
   * Allocates a null-terminated wide string (UTF-16LE) in the target process.
   * Use `encoding` to override — e.g. `'utf8'` for ANSI (A-variant) APIs.
   */
  async allocString(
    proxy: ProxyThread,
    str: string,
    opts?: AllocOptions,
  ): Promise<Native.NativeMemory> {
    const [buf] = resolveEncoding(null, null, str);
    const ptr = await proxy.alloc(buf.length, opts);
    await proxy.write(ptr, buf);
    return ptr;
  }

  /**
   * Encodes `str` with a null terminator and writes it into an already-allocated
   * remote address. Auto-detects encoding via `resolveEncoding`
   * (ASCII → UTF-8 + 1-byte null, non-ASCII → UTF-16LE + 2-byte null).
   *
   * @returns Number of bytes written.
   */
  async writeString(
    proxy: ProxyThread,
    dest: Native.NativePointer,
    str: string,
  ): Promise<number> {
    const [buf] = resolveEncoding(null, null, str);
    return proxy.write(dest, buf);
  }

  /**
   * Queries memory information in the target process using VirtualQuery.
   */
  async queryMemory(
    proxy: ProxyThread,
    address: Native.IPointer,
  ): Promise<Native.MemoryBasicInformation> {
    const buf = await proxy.alloc(Native.MBI_SIZE);
    try {
      const res = await proxy.call(
        kernel32Functions.VirtualQuery,
        address.address,
        buf.address,
        Native.MBI_SIZE,
      );
      if (res.address === 0n) {
        throw new Error(`VirtualQuery failed at ${address.toString()}`);
      }
      const data = await proxy.read(buf);
      return Native.ffi.decode(
        data,
        Native.MEMORY_BASIC_INFORMATION,
      ) as Native.MemoryBasicInformation;
    } finally {
      await proxy.dealloc(buf.address as unknown as Native.NativePointer);
    }
  }

  /**
   * Creates an asynchronous wrapper (AsyncProcessMemory) around the provided
   * ProxyThread, mimicking the ProcessMemory interface. This allows safe,
   * snapshot-backed or proxied memory operations seamlessly.
   */
  createMemory(proxy: ProxyThread): NThreadMemory {
    return new NThreadMemory(this, proxy);
  }

  /**
   * Creates an {@link AsyncNativeFunctionGenerator} backed by the hijacked thread.
   * Allocates a single RWX executable page in the target process and lets you
   * assemble / write native functions into it via `add()` / `addBytes()`.
   *
   * @param proxy The proxy returned by {@link inject}.
   * @param capacity Page size in bytes (default 8192).
   */
  async createNativeFunctionGenerator(
    proxy: ProxyThread,
    capacity?: number,
  ): Promise<AsyncNativeFunctionGenerator> {
    return AsyncNativeFunctionGenerator.create(
      this.createMemory(proxy),
      capacity,
    );
  }

  /**
   * Calls the remote `memmem` function via the hijacked thread.
   * On first call for a given proxy, injects memmem into `gen` (if supplied, else
   * allocates a throw-away single-function page) and binds it to the proxy.
   * Subsequent calls reuse the already-bound proxy method without touching `gen`.
   *
   * @param gen Optional generator page to inject memmem into. Created automatically
   *            (sized exactly for memmem) if omitted; the page is kept alive.
   * @returns Pointer to the first match, or a null pointer if not found.
   */
  async memmem(
    proxy: ProxyThread,
    haystack: Native.NativeMemory,
    needle: Native.NativeMemory,
    gen?: AsyncNativeFunctionGenerator,
  ): Promise<Native.NativePointer> {
    if (!('memmem' in proxy)) {
      if (!gen) {
        gen = await this.createNativeFunctionGenerator(
          proxy,
          MEMMEM_BYTES.length + 16,
        );
      }
      if (!gen.get('memmem')) {
        await createMemmem(gen);
      }
      proxy.bind('memmem', gen.get('memmem')!.pointer);
    }

    const proxyWithMemmem = proxy as ProxyThread & {
      memmem: (...args: Arg[]) => Promise<Native.NativePointer>;
    };

    return proxyWithMemmem.memmem(
      haystack.address,
      haystack.size,
      needle.address,
      needle.size,
    );
  }

  /**
   * Scans a remote memory region for the given {@link Pattern}.
   * Delegates to {@link memmem} for each chunk — memmem is injected and bound
   * to the proxy on the first chunk, then reused automatically.
   *
   * @param proxy     The proxy returned by {@link inject}.
   * @param memory    Remote memory region to scan.
   * @param pattern   Pattern to search for.
   * @param chunkSize Optional scan chunk size in bytes (default 1 MiB).
   * @param gen       Optional generator page shared with other native functions.
   *                  If omitted, a dedicated page is allocated automatically.
   */
  async *scan(
    proxy: ProxyThread,
    memory: Native.NativeMemory,
    pattern: Native.Pattern,
    chunkSize?: number,
    gen?: AsyncNativeFunctionGenerator,
  ): AsyncGenerator<bigint> {
    // `pattern.bytes` is a local Buffer — Scanner passes it as the `needle` LPVOID
    // argument, but the remote memmem cannot access local JS heap addresses.
    // Pre-allocate the needle in the target process once and reuse it per chunk.
    const remoteNeedle = await proxy.alloc(pattern.bytes.length);
    await proxy.write(remoteNeedle, pattern.bytes);
    try {
      const memmemFn: Native.MemmemFn = async (haystack, haystackLen) => {
        const result = await this.memmem(
          proxy,
          new Native.NativeMemory(haystack, Number(haystackLen)),
          remoteNeedle,
          gen,
        );
        return result.raw;
      };
      yield* Native.Scanner.scan(memory, pattern, memmemFn, chunkSize);
    } finally {
      await proxy.dealloc(remoteNeedle);
    }
  }

  // ─── File I/O helpers ──────────────────────────────────────────────────────

  /**
   * Opens a file in the target process via `msvcrt!fopen`.
   * Both `path` and `mode` are automatically allocated as null-terminated ANSI
   * strings and freed after the call.
   *
   * @returns `FILE*` pointer (`address === 0n` on failure).
   */
  async fileOpen(
    proxy: ProxyThread,
    path: string | Native.NativePointer,
    mode: string | Native.NativePointer,
  ): Promise<Native.NativePointer> {
    const pathPtr =
      typeof path === 'string' ? await this.allocString(proxy, path) : null;
    const modePtr =
      typeof mode === 'string' ? await this.allocString(proxy, mode) : null;
    try {
      const pathArg = pathPtr
        ? pathPtr.address
        : (path as Native.NativePointer).address;
      const modeArg = modePtr
        ? modePtr.address
        : (mode as Native.NativePointer).address;
      return await proxy.fopen(pathArg, modeArg);
    } finally {
      if (pathPtr) await proxy.dealloc(pathPtr);
      if (modePtr) await proxy.dealloc(modePtr);
    }
  }

  /**
   * Writes data to an open `FILE*` stream via `msvcrt!fwrite`.
   *
   * **Two modes:**
   * - `data: Buffer | string` — encodes locally, allocates a remote scratch buffer,
   *   calls `fwrite`, then frees it automatically.
   *   Strings are encoded as UTF-8 (raw bytes, no null terminator).
   * - `data: NativeMemory` — already in the target process; byte count is taken
   *   from `data.size` automatically.
   *
   * @returns Number of bytes written.
   */
  async fileWrite(
    proxy: ProxyThread,
    stream: Native.NativePointer,
    data: Buffer | string | Native.NativeMemory,
  ): Promise<number> {
    if (data instanceof Native.NativeMemory) {
      const result = await proxy.fwrite(
        data.address,
        1n,
        BigInt(data.size),
        stream.address,
      );
      return Number(result.address);
    }
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const ptr = await proxy.alloc(buf.length);
    try {
      await proxy.write(ptr, buf);
      const result = await proxy.fwrite(
        ptr.address,
        1n,
        BigInt(buf.length),
        stream.address,
      );
      return Number(result.address);
    } finally {
      await proxy.dealloc(ptr);
    }
  }

  /**
   * Reads bytes from a `FILE*` stream via `msvcrt!fread`.
   *
   * **Two modes:**
   * - `dest: NativeMemory` — reads directly into an existing remote buffer;
   *   byte count is taken from `dest.size` automatically. Returns number of bytes read.
   * - `dest: number` (= byteCount) — allocates a remote scratch buffer,
   *   calls `fread`, copies the result back as a local `Buffer`, then frees the scratch.
   *
   * `size` is always `1` — byte-granular I/O.
   */
  async fileRead(
    proxy: ProxyThread,
    stream: Native.NativePointer,
    dest: Native.NativeMemory | number,
  ): Promise<number | Buffer> {
    if (dest instanceof Native.NativeMemory) {
      const result = await proxy.fread(
        dest.address,
        1n,
        BigInt(dest.size),
        stream.address,
      );
      return Number(result.address);
    }
    // dest is a byte count — alloc internally and return a local Buffer
    const byteCount = dest;
    const ptr = await proxy.alloc(byteCount);
    try {
      const result = await proxy.fread(
        ptr.address,
        1n,
        BigInt(byteCount),
        stream.address,
      );
      const bytesRead = Number(result.address);
      return await proxy.read(ptr.withSize(bytesRead));
    } finally {
      await proxy.dealloc(ptr);
    }
  }

  /**
   * Flushes a `FILE*` stream via `msvcrt!fflush`.
   * Returns `0` on success, non-zero on failure (mirrors fflush).
   */
  async fileFlush(
    proxy: ProxyThread,
    stream: Native.NativePointer,
  ): Promise<number> {
    const result = await proxy.fflush(stream.address);
    return Number(result.address);
  }

  /**
   * Closes a `FILE*` stream via `msvcrt!fclose`.
   * Returns `0` on success, `EOF` on failure (mirrors fclose).
   */
  async fileClose(
    proxy: ProxyThread,
    stream: Native.NativePointer,
  ): Promise<number> {
    const result = await proxy.fclose(stream.address);
    return Number(result.address);
  }

  /**
   * Executes a function call on a captured thread using the Windows x64 calling convention.
   * The thread must be parked at the sleep address (after inject()).
   *
   * Supports up to 4 parameters mapped to RCX, RDX, R8, R9.
   * Returns the value from RAX after the function completes.
   *
   * @param thread The captured thread to execute on.
   * @param target Address of the function to call.
   * @param args Up to 4 arguments (RCX, RDX, R8, R9).
   * @param timeoutMs Timeout in ms for waiting on the function return (default: 5000).
   * @returns RAX value as NativePointer.
   */
  async threadCall(
    proxy: ProxyThread,
    thread: CapturedThread,
    target: Native.NativePointer | bigint,
    args: Arg[] = [],
    timeoutMs: number = 5000,
  ): Promise<Native.NativePointer> {
    if (args.length > 4) {
      throw new CallTooManyArgsError(args.length);
    }
    const resolved = await this.resolveArgs(proxy, args);

    const targetAddr =
      target instanceof Native.NativePointer
        ? target.toBigInt()
        : BigInt(target);

    // 1. Suspend the thread (should be parked at sleep 'jmp .')
    thread.suspend();
    thread.fetchContext();

    // Safety check: verify thread is actually at the sleep address
    const currentRip = BigInt(thread.getContext().Rip);
    if (currentRip !== thread.sleepAddress.address) {
      thread.resume();
      throw new CallRipMismatchError(
        targetAddr,
        currentRip,
        thread.sleepAddress.address,
      );
    }

    // 2. Map arguments to x64 calling convention registers
    const ctx = thread.getContext();
    if (resolved.length > 0) ctx.Rcx = resolved[0]!;
    if (resolved.length > 1) ctx.Rdx = resolved[1]!;
    if (resolved.length > 2) ctx.R8 = resolved[2]!;
    if (resolved.length > 3) ctx.R9 = resolved[3]!;

    // 3. Redirect execution to target function
    //    callRsp points to the pre-written return address (sleep gadget), set once in inject()
    ctx.Rip = targetAddr;
    ctx.Rsp = thread.callRsp;

    thread.setContext(ctx);
    thread.applyContext();
    thread.resume();

    nthreadLog.debug(
      `Calling 0x${targetAddr.toString(16)} with ${resolved.length} arg(s)...`,
    );

    // 6. Wait for the function to return (RIP lands back at sleep address)
    const res = await thread.wait(timeoutMs);
    if (res === Native.WaitReturn.FAILED) {
      throw new CallThreadDiedError(targetAddr);
    }
    if (res !== Native.WaitReturn.OBJECT_0) {
      throw new CallTimeoutError(targetAddr, res);
    }

    // 7. Return value is in RAX
    const rax = new Native.NativePointer(thread.getContext().Rax);
    nthreadLog.debug(`Call returned: 0x${rax.toString()}`);
    return rax;
  }

  /**
   * Writes arbitrary data to the target process memory using hijacked memset calls.
   * Decomposes the source buffer into runs of equal bytes and issues one
   * `msvcrt!memset(dest + offset, value, runLength)` call per run.
   *
   * If the write range overlaps a registered read-only memory region, the
   * overlapping portion is routed through writeMemorySafeBuffer (skips unchanged
   * bytes) and the non-overlapping parts are written normally via recursive calls.
   *
   * @param dest Target address to write to.
   * @param source The data to write.
   */
  async writeMemory(
    proxy: ProxyThread,
    dest: Native.NativePointer | bigint,
    source: Buffer | Uint8Array,
  ): Promise<number> {
    const destAddr = dest instanceof Native.NativePointer ? dest.address : dest;
    const data = source instanceof Buffer ? source : Buffer.from(source);
    const length = data.length;
    if (length === 0) return 0;

    // Check if the write overlaps a read-only memory region
    const romem = findOverlappingRegion(destAddr, length);
    if (romem) {
      const { writeOffset, overlapLen, snapshot } = getOverlapInfo(
        destAddr,
        length,
        romem,
      );

      let written = 0;

      // Part before the overlap — plain writeMemory
      if (writeOffset > 0) {
        written += await this.writeMemory(
          proxy,
          destAddr,
          data.subarray(0, writeOffset),
        );
      }

      // Overlapping part — safe write using the snapshot
      const overlapDest = new Native.NativePointer(
        destAddr + BigInt(writeOffset),
      );
      const overlapData = data.subarray(
        writeOffset,
        writeOffset + overlapLen,
      ) as Buffer;
      written += await this.writeMemorySafeBuffer(
        proxy,
        overlapDest,
        overlapData,
        snapshot,
      );
      updateSnapshot(romem, overlapData, overlapDest.address);

      // Part after the overlap — plain writeMemory
      const afterOffset = writeOffset + overlapLen;
      if (afterOffset < length) {
        written += await this.writeMemory(
          proxy,
          destAddr + BigInt(afterOffset),
          data.subarray(afterOffset),
        );
      }

      return written;
    }

    // No overlap — standard decomposed memset
    let i = 0;
    while (i < length) {
      const value = data[i]!;
      let j = i + 1;
      while (j < length && data[j] === value) {
        j++;
      }

      const runLen = j - i;
      const addr = await proxy.call(
        crtFunctions.memset,
        destAddr + BigInt(i),
        value,
        runLen,
      );
      if (addr.address === 0n) return i;

      i = j;
    }

    return length;
  }

  /**
   * Writes data from a NativePointer source to the target process memory
   * using hijacked memset calls. Reads the source pointer byte-by-byte into
   * a local buffer first, then delegates to the standard decomposed memset.
   *
   * Does NOT check read-only memory regions — this is intended for writing
   * data we don't already know the contents of.
   *
   * @param thread The captured thread to execute on.
   * @param dest Target address to write to.
   * @param source Source pointer to read from (in our process).
   * @param size Number of bytes to write.
   */
  async writeMemoryWithPointer(
    proxy: ProxyThread,
    dest: Native.NativePointer | bigint,
    source: Native.NativePointer,
    size: number,
  ): Promise<number> {
    const destAddr = dest instanceof Native.NativePointer ? dest.address : dest;
    const buf = Native.currentProcess.memory.read(
      source instanceof Native.NativeMemory
        ? source
        : new Native.NativeMemory(source.address, size),
    );
    if (buf.length === 0) return 0;

    // Standard decomposed memset — no romem check
    let i = 0;
    while (i < buf.length) {
      const value = buf[i]!;
      let j = i + 1;
      while (j < buf.length && buf[j] === value) {
        j++;
      }

      const runLen = j - i;
      const addr = await proxy.call(
        crtFunctions.memset,
        destAddr + BigInt(i),
        value,
        runLen,
      );
      if (addr.address === 0n) return i;

      i = j;
    }

    return buf.length;
  }

  /**
   * Safe write dispatcher: routes to the optimized variant based on `lastDest` type.
   *
   * @param dest Target address to write to.
   * @param source The data to write.
   * @param lastDest Either a snapshot Buffer of the previous state, or a single byte value
   *                 representing a uniform fill (e.g. 0 means the region is all zeroes).
   */
  async writeMemorySafe(
    proxy: ProxyThread,
    dest: Native.NativePointer,
    source: Buffer,
    lastDest: Buffer | number,
  ): Promise<number> {
    if (typeof lastDest === 'number') {
      return this.writeMemorySafeUniform(proxy, dest, source, lastDest);
    }
    return this.writeMemorySafeBuffer(proxy, dest, source, lastDest);
  }

  /**
   * Safe write against a uniform fill value.
   * Skips bytes that already equal `fillByte`.
   */
  private async writeMemorySafeUniform(
    proxy: ProxyThread,
    dest: Native.NativePointer,
    source: Buffer,
    fillByte: number,
  ): Promise<number> {
    const destAddr = dest.address;
    const length = source.length;
    if (length === 0) return 0;

    let i = 0;
    while (i < length) {
      while (i < length && source[i] === fillByte) i++;
      if (i >= length) break;

      const value = source[i]!;
      let j = i + 1;
      while (j < length && source[j] === value) j++;

      const runLen = j - i;
      const addr = await proxy.call(
        crtFunctions.memset,
        destAddr + BigInt(i),
        value,
        runLen,
      );
      if (addr.address === 0n) return i;

      i = j;
    }

    return length;
  }

  /**
   * Safe write against a snapshot Buffer.
   * Skips bytes that match the corresponding byte in `last`.
   */
  private async writeMemorySafeBuffer(
    proxy: ProxyThread,
    dest: Native.NativePointer,
    source: Buffer,
    last: Buffer,
  ): Promise<number> {
    const destAddr = dest.address;
    const length = source.length;
    if (length === 0) return 0;

    let i = 0;
    while (i < length) {
      while (i < length && source[i] === last[i]) i++;
      if (i >= length) break;

      const value = source[i]!;
      let j = i + 1;
      while (j < length && source[j] === value) j++;

      const runLen = j - i;
      const addr = await proxy.call(
        crtFunctions.memset,
        destAddr + BigInt(i),
        value,
        runLen,
      );
      if (addr.address === 0n) return i;

      i = j;
    }

    return length;
  }
}
