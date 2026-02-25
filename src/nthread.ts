import * as Native from '@cheatron/native';
import {
  getRandomSleepAddress,
  getRandomPushretAddress,
  type GeneralPurposeRegs,
} from './globals.js';
import { log } from './logger';
import { ProxyThread } from './thread/proxy-thread.js';
import { CapturedThread } from './thread/captured-thread.js';
import { crt } from './crt.js';
import {
  NoSleepAddressError,
  NoPushretAddressError,
  InjectTimeoutError,
  CallTooManyArgsError,
  CallRipMismatchError,
  CallTimeoutError,
  CallThreadDiedError,
} from './errors.js';
import {
  findOverlappingRegion,
  getOverlapInfo,
  updateSnapshot,
} from './memory/romem.js';

import type { AllocOptions } from './memory/alloc-options.js';

export { STACK_ADD } from './thread/captured-thread.js';

/**
 * Register-compatible argument type.
 * All values are ultimately converted to bigint for register assignment (RCX, RDX, R8, R9).
 * Accepts NativePointer (→ .address) and number (→ BigInt()) for convenience.
 */
export type Arg = bigint | number | Native.NativePointer;

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
  public sleepAddress: Native.NativePointer;

  /** Address of a pivot gadget ('push reg; ret') used to redirect execution */
  public pushretAddress: Native.NativePointer;

  /** The register key (e.g., 'Rbx') used for the pushret pivot */
  public regKey: GeneralPurposeRegs;

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

    // 1. Resolve Sleep Address
    if (sleepAddress) {
      this.sleepAddress = sleepAddress;
    } else {
      const randomSleepAddress = getRandomSleepAddress();
      if (!randomSleepAddress) {
        throw new NoSleepAddressError();
      }
      this.sleepAddress = randomSleepAddress;
    }

    // 2. Resolve PushRet Address and Key
    if (pushretAddress !== undefined) {
      this.pushretAddress = pushretAddress;
      this.regKey = regKey ?? 'Rbp';
    } else {
      const randomPushret = getRandomPushretAddress(regKey);
      if (!randomPushret) {
        throw new NoPushretAddressError();
      }
      this.pushretAddress = randomPushret.address;
      this.regKey = randomPushret.regKey;
    }
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
    thread: Native.Thread | number,
  ): Promise<[ProxyThread, CapturedThread]> {
    const captured = new CapturedThread(
      thread,
      this.regKey,
      this.sleepAddress,
      this.processId,
    );

    captured.suspend();

    captured.fetchContext();
    captured.savedContext = captured.getContext();

    // Preserve original values to restore them later
    const targetReg = captured.savedContext[this.regKey];
    const rip = captured.savedContext.Rip;
    const rsp = captured.savedContext.Rsp;

    // Hijack:
    // RIP -> [push reg; ret]  (The pivot)
    // REG -> [jmp .]          (The final destination)
    // pushret will 'push sleep; ret' → sleep addr lands at [stackBegin - 8]
    // call() later sets RSP to that same address so 'ret' pops sleep again.
    const stackBegin = captured.calcStackBegin(BigInt(rsp));
    captured.callRsp = stackBegin - 8n;

    captured.setRIP(this.pushretAddress.address);
    captured.setRSP(stackBegin);
    captured.setTargetReg(this.sleepAddress.address);

    captured.applyContext();
    captured.resume();

    nthreadLog.info(
      `Waiting for thread ${captured.tid} to reach ${this.sleepAddress}...`,
    );

    // Poll until Rip matches our infinite loop address
    const res = await captured.wait(5000);
    if (res != Native.WaitReturn.OBJECT_0) {
      throw new InjectTimeoutError(res);
    }

    // Refresh context now that we are stably 'parked' at sleepAddress
    captured.savedContext = captured.getContext();

    // Restore original state into our local copy so we can resume naturally later
    captured.savedContext[this.regKey] = targetReg;
    captured.savedContext.Rip = rip;
    captured.savedContext.Rsp = rsp;

    // Ensure we capture integer and control registers for maximum control
    captured.latestContext.ContextFlags =
      Native.ContextFlags.INTEGER | Native.ContextFlags.CONTROL;

    const proxy = new ProxyThread((_proxy, suicide) =>
      this.threadClose(_proxy, captured, suicide),
    );
    /*proxy.setReader((_proxy, address, size) =>
      Promise.resolve(Native.currentProcess.memory.read(address, size)),
    );*/
    proxy.setCaller((_proxy, address, ...proxyArgs) =>
      this.threadCall(captured, address, [...proxyArgs]),
    );
    proxy.setWriter((_proxy, address, data, size) =>
      this.threadWrite(_proxy, address, data, size),
    );
    proxy.setAllocer((_proxy, size, opts) =>
      this.threadAlloc(_proxy, size, opts),
    );
    proxy.setFreer((_proxy, ptr) => this.threadFree(_proxy, ptr));

    nthreadLog.info(`Successfully injected into thread ${captured.tid}`);

    return [proxy, captured];
  }

  /** Writes data to the target process; dispatches NativePointer vs Buffer. */
  private async threadWrite(
    proxy: ProxyThread,
    address: Native.NativePointer,
    data: Buffer | Native.NativePointer,
    size?: number,
  ): Promise<number> {
    if (data instanceof Native.NativePointer) {
      if (!size) {
        throw new Error('Size must be specified when writing a pointer.');
      }
      await this.writeMemoryWithPointer(proxy, address, data, size);
      return size;
    }
    const buf = data instanceof Buffer ? data : Buffer.from(data);
    const writeSize = size ?? buf.length;
    await this.writeMemory(proxy, address, buf.subarray(0, writeSize));
    return writeSize;
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
  ): Promise<Native.NativePointer> {
    if (opts?.address) {
      const ptr = await proxy.realloc(opts.address.address, BigInt(size));
      if (ptr.address === 0n)
        throw new Error(
          `realloc(0x${opts.address.address.toString(16)}, ${size}) returned NULL`,
        );
      return ptr;
    }
    const fill = opts?.fill;
    if (fill === undefined) {
      return proxy.malloc(BigInt(size));
    } else if (fill === 0) {
      return proxy.calloc(1n, BigInt(size));
    } else {
      const ptr = await proxy.malloc(BigInt(size));
      await proxy.memset(ptr.address, BigInt(fill & 0xff), BigInt(size));
      return ptr;
    }
  }

  /**
   * Hook: frees a pointer in the target process.
   * Default: `msvcrt!free`.
   * Subclasses can override to return the block to a managed heap instead.
   */
  protected async threadFree(
    proxy: ProxyThread,
    ptr: Native.NativePointer,
  ): Promise<void> {
    await proxy.call(crt.free, ptr.address);
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
  async allocString(
    proxy: ProxyThread,
    str: string,
    encoding: BufferEncoding = 'utf16le',
    opts?: AllocOptions,
  ): Promise<Native.NativePointer> {
    const encoded = Buffer.from(str, encoding);
    const nullBytes = encoding === 'utf16le' || encoding === 'ucs2' ? 2 : 1;
    const buf = Buffer.alloc(encoded.length + nullBytes);
    encoded.copy(buf);
    const ptr = await proxy.alloc(buf.length, opts);
    await proxy.write(ptr, buf);
    return ptr;
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
    thread: CapturedThread,
    target: Native.NativePointer | bigint,
    args: Arg[] = [],
    timeoutMs: number = 5000,
  ): Promise<Native.NativePointer> {
    if (args.length > 4) {
      throw new CallTooManyArgsError(args.length);
    }

    const toBigInt = (v: Arg): bigint => {
      if (v instanceof Native.NativePointer) return v.address;
      return BigInt(v);
    };

    const targetAddr =
      target instanceof Native.NativePointer ? target.address : BigInt(target);

    // 1. Suspend the thread (should be parked at sleep 'jmp .')
    thread.suspend();
    thread.fetchContext();

    // Safety check: verify thread is actually at the sleep address
    const currentRip = BigInt(thread.getContext().Rip);
    if (currentRip !== this.sleepAddress.address) {
      thread.resume();
      throw new CallRipMismatchError(
        targetAddr,
        currentRip,
        this.sleepAddress.address,
      );
    }

    // 2. Map arguments to x64 calling convention registers
    const ctx = thread.getContext();
    if (args.length > 0) ctx.Rcx = toBigInt(args[0]!);
    if (args.length > 1) ctx.Rdx = toBigInt(args[1]!);
    if (args.length > 2) ctx.R8 = toBigInt(args[2]!);
    if (args.length > 3) ctx.R9 = toBigInt(args[3]!);

    // 3. Redirect execution to target function
    //    callRsp points to the pre-written return address (sleep gadget), set once in inject()
    ctx.Rip = targetAddr;
    ctx.Rsp = thread.callRsp;

    thread.setContext(ctx);
    thread.applyContext();
    thread.resume();

    nthreadLog.debug(
      `Calling 0x${targetAddr.toString(16)} with ${args.length} arg(s)...`,
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
        crt.memset,
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
    const buf = Native.currentProcess.memory.read(source, size);
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
        crt.memset,
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
        crt.memset,
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
        crt.memset,
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
