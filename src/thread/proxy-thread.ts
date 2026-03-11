import * as Native from '@cheatron/native';
import { crtFunctions } from '../crt';
import { kernel32Functions } from '../kernel32';
import type { Arg } from '../nthread';
import type { AllocOptions } from '../memory/alloc-options';
import {
  ProxyReadNotConfiguredError,
  ProxyWriteNotConfiguredError,
  ProxyCallNotConfiguredError,
  WriteFailedError,
  ReallocNullError,
} from '../errors';

/**
 * Type signatures for proxy operations.
 * Each receives the ProxyThread instance as the first argument for context.
 */
export type ReadMemoryFn = (
  proxy: ProxyThread,
  address: Native.NativeMemory,
) => Promise<Buffer>;
export type WriteMemoryFn = (
  proxy: ProxyThread,
  address: Native.NativePointer,
  data: Buffer | Native.NativeMemory,
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
  /** `msvcrt!strlen(str)` — returns string length in bytes (narrow) */
  declare strlen: (str: Arg) => Promise<Native.NativePointer>;
  /** `msvcrt!wcslen(str)` — returns string length in wide characters */
  declare wcslen: (str: Arg) => Promise<Native.NativePointer>;

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
  /** `kernel32!VirtualQuery(lpAddress, lpBuffer, dwLength)` */
  declare VirtualQuery: (
    lpAddress: Arg,
    lpBuffer: Arg,
    dwLength: Arg,
  ) => Promise<Native.NativePointer>;
  /** `kernel32!VirtualProtect(lpAddress, dwSize, flNewProtect, lpflOldProtect)` */
  declare VirtualProtect: (
    lpAddress: Arg,
    dwSize: Arg,
    flNewProtect: Arg,
    lpflOldProtect: Arg,
  ) => Promise<Native.NativePointer>;

  private _read: ReadMemoryFn;
  private _write: WriteMemoryFn;
  private _call: CallFn;
  private _close: CloseFn;
  private _alloc: AllocFn;
  private _dealloc: DeallocFn;

  constructor(close: CloseFn, process?: Native.Process) {
    this._close = close;
    this._read = async (_proxy, address) => {
      if (!process) throw new ProxyReadNotConfiguredError();
      return process.memory.read(address);
    };

    this._write = async (_proxy, address, data) => {
      if (!process) throw new ProxyWriteNotConfiguredError();

      const len = data instanceof Native.NativeMemory ? data.size : data.length;
      const written = process.memory.write(address, data);
      if (written != len) throw new WriteFailedError();
      return written;
    };

    this._call = async (_proxy, _address, ..._args) => {
      throw new ProxyCallNotConfiguredError();
    };

    // Default alloc: malloc / calloc / malloc+memset depending on opts.fill
    this._alloc = async (_proxy, size, opts) => {
      if (opts?.address) {
        // Basic realloc via CRT
        const ptr = await this.realloc(opts.address.address, BigInt(size));
        if (ptr.address === 0n)
          throw new ReallocNullError(opts.address.address, size);
        return new Native.NativeMemory(ptr.address, size);
      }
      const fill = opts?.fill;
      if (fill === undefined) {
        const ptr = await this.malloc(BigInt(size));
        return new Native.NativeMemory(ptr.address, size);
      } else if (fill === 0) {
        const ptr = await this.calloc(1n, BigInt(size));
        return new Native.NativeMemory(ptr.address, size);
      } else {
        const ptr = await this.malloc(BigInt(size));
        await this.memset(ptr.address, BigInt(fill & 0xff), BigInt(size));
        return new Native.NativeMemory(ptr.address, size);
      }
    };

    // Default dealloc: delegates to msvcrt!free via the call chain
    this._dealloc = async (_proxy, ptr) => {
      await this.call(crtFunctions.free, ptr.address);
    };

    // Auto-bind all CRT functions
    for (const [name, address] of Object.entries(crtFunctions)) {
      this.bind(name, address);
    }

    // Auto-bind all kernel32 functions
    for (const [name, address] of Object.entries(kernel32Functions)) {
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
  read(address: Native.NativeMemory): Promise<Buffer> {
    return this._read(this, address);
  }

  /** Writes memory into the remote process */
  write(
    address: Native.NativePointer,
    data: Buffer | Native.NativeMemory,
  ): Promise<number> {
    return this._write(this, address, data);
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
