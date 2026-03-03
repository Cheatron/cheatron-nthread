import * as Native from '@cheatron/native';
import { crt } from '../crt.js';
import { kernel32 } from '../kernel32.js';
import type { Arg } from '../nthread.js';
import type { AllocOptions } from '../memory/alloc-options.js';

/**
 * Type signatures for proxy operations.
 * Each receives the ProxyThread instance as the first argument for context.
 */
export type ReadMemoryFn = (
  proxy: ProxyThread,
  address: Native.NativePointer,
  size: number,
) => Promise<Buffer>;
export type WriteMemoryFn = (
  proxy: ProxyThread,
  address: Native.NativePointer,
  data: Buffer | Native.NativePointer,
  size?: number,
) => Promise<number>;
export type CallFn = (
  proxy: ProxyThread,
  address: Native.NativePointer,
  ...args: Arg[]
) => Promise<Native.NativePointer>;
export type CloseFn = (proxy: ProxyThread, suicide?: number) => Promise<void>;
export type AllocFn = (
  proxy: ProxyThread,
  size: number,
  opts?: AllocOptions,
) => Promise<Native.NativeMemory>;
export type DeallocFn = (
  proxy: ProxyThread,
  ptr: Native.NativePointer,
) => Promise<void>;

/** Signature for a bound function on ProxyThread (e.g. proxy.malloc, proxy.memset) */
export type BoundCallFn = (...args: Arg[]) => Promise<Native.NativePointer>;

/**
 * ProxyThread provides a high-level, extensible interface for interacting with a captured thread.
 * Each operation (read, write, call) can be independently replaced via setter methods.
 */
export class ProxyThread {
  /** `msvcrt!fopen(path, mode)` */
  declare fopen: (path: Arg, mode: Arg) => Promise<Native.NativePointer>;
  /** `msvcrt!memset(dest, value, count)` */
  declare memset: (
    dest: Arg,
    value: Arg,
    count: Arg,
  ) => Promise<Native.NativePointer>;
  /** `msvcrt!malloc(size)` */
  declare malloc: (size: Arg) => Promise<Native.NativePointer>;
  /** `msvcrt!calloc(count, size)` */
  declare calloc: (count: Arg, size: Arg) => Promise<Native.NativePointer>;
  /** `msvcrt!fwrite(buffer, size, count, stream)` */
  declare fwrite: (
    buffer: Arg,
    size: Arg,
    count: Arg,
    stream: Arg,
  ) => Promise<Native.NativePointer>;
  /** `msvcrt!fflush(stream)` */
  declare fflush: (stream: Arg) => Promise<Native.NativePointer>;
  /** `msvcrt!fclose(stream)` */
  declare fclose: (stream: Arg) => Promise<Native.NativePointer>;
  /** `msvcrt!fread(buffer, size, count, stream)` */
  declare fread: (
    buffer: Arg,
    size: Arg,
    count: Arg,
    stream: Arg,
  ) => Promise<Native.NativePointer>;
  /** `msvcrt!realloc(ptr, size)` */
  declare realloc: (ptr: Arg, size: Arg) => Promise<Native.NativePointer>;
  /** `msvcrt!fseek(stream, offset, origin)` — returns 0 on success */
  declare fseek: (
    stream: Arg,
    offset: Arg,
    origin: Arg,
  ) => Promise<Native.NativePointer>;
  /** `msvcrt!free(ptr)` */
  declare free: (ptr: Arg) => Promise<Native.NativePointer>;

  // --- kernel32.dll bindings ---
  /** `kernel32!LoadLibraryA(lpLibFileName)` */
  declare LoadLibraryA: (lpLibFileName: Arg) => Promise<Native.NativePointer>;
  /** `kernel32!LoadLibraryW(lpLibFileName)` */
  declare LoadLibraryW: (lpLibFileName: Arg) => Promise<Native.NativePointer>;
  /** `kernel32!ReadProcessMemory(hProcess, lpBaseAddress, lpBuffer, nSize, lpNumberOfBytesRead)` */
  declare ReadProcessMemory: (
    hProcess: Arg,
    lpBaseAddress: Arg,
    lpBuffer: Arg,
    nSize: Arg,
    lpNumberOfBytesRead: Arg,
  ) => Promise<Native.NativePointer>;
  /** `kernel32!WriteProcessMemory(hProcess, lpBaseAddress, lpBuffer, nSize, lpNumberOfBytesWritten)` */
  declare WriteProcessMemory: (
    hProcess: Arg,
    lpBaseAddress: Arg,
    lpBuffer: Arg,
    nSize: Arg,
    lpNumberOfBytesWritten: Arg,
  ) => Promise<Native.NativePointer>;
  /** `kernel32!GetCurrentProcess()` */
  declare GetCurrentProcess: () => Promise<Native.NativePointer>;
  /** `kernel32!GetModuleHandleA(lpModuleName)` */
  declare GetModuleHandleA: (
    lpModuleName: Arg,
  ) => Promise<Native.NativePointer>;
  /** `kernel32!GetModuleHandleW(lpModuleName)` */
  declare GetModuleHandleW: (
    lpModuleName: Arg,
  ) => Promise<Native.NativePointer>;
  /** `kernel32!GetModuleHandleExA(dwFlags, lpModuleName, phModule)` */
  declare GetModuleHandleExA: (
    dwFlags: Arg,
    lpModuleName: Arg,
    phModule: Arg,
  ) => Promise<Native.NativePointer>;
  /** `kernel32!GetModuleHandleExW(dwFlags, lpModuleName, phModule)` */
  declare GetModuleHandleExW: (
    dwFlags: Arg,
    lpModuleName: Arg,
    phModule: Arg,
  ) => Promise<Native.NativePointer>;

  private _read: ReadMemoryFn;
  private _write: WriteMemoryFn;
  private _call: CallFn;
  private _close: CloseFn;
  private _alloc: AllocFn;
  private _dealloc: DeallocFn;

  constructor(close: CloseFn, process?: Native.Process) {
    this._close = close;
    this._read = async (_proxy, address, size) => {
      if (!process)
        throw new Error('read not configured and no Process provided.');
      return process.memory.read(address, size);
    };

    this._write = async (_proxy, address, data, size) => {
      if (!process)
        throw new Error('write not configured and no Process provided.');

      if (data instanceof Native.NativePointer) {
        if (size) {
          const written = process.memory.writeWithPointer(address, data, size);
          if (written != size) {
            throw new Error('Failed to write memory.');
          }
          return written;
        } else {
          throw new Error('Size must be specified when writing a pointer.');
        }
      } else {
        const writeSize = size ?? data.length;
        const written = process.memory.write(address, data, writeSize);
        if (written != writeSize) {
          throw new Error('Failed to write memory.');
        }
        return written;
      }
    };

    this._call = async (_proxy, _address, ..._args) => {
      throw new Error('call not configured.');
    };

    // Default alloc: malloc / calloc / malloc+memset depending on opts.fill
    this._alloc = async (_proxy, size, opts) => {
      if (opts?.address) {
        // Basic realloc via CRT
        const ptr = await this.realloc(opts.address.address, BigInt(size));
        if (ptr.address === 0n)
          throw new Error(
            `realloc(0x${opts.address.address.toString(16)}, ${size}) returned NULL`,
          );
        return Native.NativeMemory.createFromPointer(ptr, undefined, size);
      }
      const fill = opts?.fill;
      if (fill === undefined) {
        const ptr = await this.malloc(BigInt(size));
        return Native.NativeMemory.createFromPointer(ptr, undefined, size);
      } else if (fill === 0) {
        const ptr = await this.calloc(1n, BigInt(size));
        return Native.NativeMemory.createFromPointer(ptr, undefined, size);
      } else {
        const ptr = await this.malloc(BigInt(size));
        await this.memset(ptr.address, BigInt(fill & 0xff), BigInt(size));
        return Native.NativeMemory.createFromPointer(ptr, undefined, size);
      }
    };

    // Default dealloc: delegates to msvcrt!free via the call chain
    this._dealloc = async (_proxy, ptr) => {
      await this.call(crt.free, ptr.address);
    };

    // Auto-bind all CRT functions
    for (const [name, address] of Object.entries(crt)) {
      this.bind(name, address);
    }

    // Auto-bind all kernel32 functions
    for (const [name, address] of Object.entries(kernel32)) {
      this.bind(name, address);
    }
  }

  /**
   * Binds a named function onto this proxy instance.
   * The bound function delegates to `this.call(address, ...args)`.
   *
   * @param name Function name — becomes a property on the proxy (e.g. 'malloc').
   * @param address Target function address in the remote process.
   */
  bind(name: string, address: Native.NativePointer): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)[name] = (...args: Arg[]) => this.call(address, ...args);
  }

  /** Sets the read memory strategy */
  setReader(fn: ReadMemoryFn): void {
    this._read = fn;
  }

  /** Sets the write memory strategy */
  setWriter(fn: WriteMemoryFn): void {
    this._write = fn;
  }

  /** Sets the call strategy */
  setCaller(fn: CallFn): void {
    this._call = fn;
  }

  /** Sets the close strategy */
  setCloser(fn: CloseFn): void {
    this._close = fn;
  }

  /** Sets the alloc strategy */
  setAllocer(fn: AllocFn): void {
    this._alloc = fn;
  }

  /** Sets the dealloc strategy */
  setDeallocer(fn: DeallocFn): void {
    this._dealloc = fn;
  }

  /** Reads memory from the remote process. When `address` is a `NativeMemory`, `size` defaults to `address.size`. */
  read(address: Native.NativeMemory): Promise<Buffer>;
  read(address: Native.NativePointer, size: number): Promise<Buffer>;
  read(address: Native.NativePointer, size?: number): Promise<Buffer> {
    const sz =
      size ??
      (address instanceof Native.NativeMemory ? address.size : undefined);
    if (sz === undefined)
      throw new Error(
        'read: size is required when address is not a NativeMemory',
      );
    return this._read(this, address, sz);
  }

  /** Writes memory into the remote process */
  write(
    address: Native.NativePointer,
    data: Buffer | Native.NativePointer,
    size?: number,
  ): Promise<number> {
    return this._write(this, address, data, size);
  }

  /** Calls a function, passing this proxy as context */
  async call(
    address: Native.NativePointer,
    ...args: Arg[]
  ): Promise<Native.NativePointer> {
    return this._call(this, address, ...args);
  }

  /**
   * Restores the thread to its original state and releases it.
   * @param suicide If provided, terminates the thread with this exit code instead of resuming it.
   */
  close(suicide?: number): Promise<void> {
    return this._close(this, suicide);
  }

  /**
   * Allocates memory in the remote process.
   *
   * - `opts.fill` undefined         → `malloc(size)`
   * - `opts.fill === 0`              → `calloc(1, size)` (zero-initialized)
   * - `opts.fill > 0`                → `malloc(size)` + `memset(ptr, fill, size)`
   * - `opts.type`                    → zone hint for HeapPool (READONLY / READWRITE)
   * - `opts.address`                 → realloc mode: resize existing allocation
   *
   * Returns a `NativeMemory` so callers always know the allocation size.
   */
  alloc(size: number, opts?: AllocOptions): Promise<Native.NativeMemory> {
    return this._alloc(this, size, opts);
  }

  /**
   * Frees a previously allocated remote pointer.
   * Routes through the dealloc delegate — subclasses (e.g. NThreadHeap)
   * can override to return the block to a managed heap instead of calling CRT free.
   */
  dealloc(ptr: Native.NativePointer): Promise<void> {
    return this._dealloc(this, ptr);
  }
}
