import * as Native from '@cheatron/native';
import type { AsyncMemory } from '@cheatron/native';
import type { ProxyThread } from './thread/proxy-thread';
import type { NThread } from './nthread';

/**
 * NThreadMemory: Asynchronous memory interface backed by a hijacked thread.
 *
 * Implements the `AsyncMemory` interface from `@cheatron/native`, routing all
 * operations through a `ProxyThread` (read/write/alloc/free) and the owning
 * `NThread` (query/protect).
 *
 * This allows any code expecting an `AsyncMemory` to transparently work with
 * a hijacked thread — including snapshot-backed or proxied memory operations.
 */
export class NThreadMemory implements AsyncMemory {
  public readonly isLocal: boolean = false;

  constructor(
    private readonly nthread: NThread,
    private readonly proxy: ProxyThread,
  ) {}

  // ─── Core read / write ───────────────────────────────────────────────────

  async read(address: Native.NativeMemory): Promise<Buffer> {
    return this.proxy.read(address);
  }

  async write(
    address: Native.NativePointer,
    data: Buffer | Native.NativeMemory,
  ): Promise<number> {
    return this.proxy.write(address, data);
  }

  // ─── Allocation ──────────────────────────────────────────────────────────

  /**
   * Allocates memory in the target process via the proxy's alloc delegate.
   *
   * If `protection` includes any EXECUTE flag (EXECUTE, EXECUTE_READ,
   * EXECUTE_READWRITE, EXECUTE_WRITECOPY), the allocated heap block is made
   * executable via `VirtualProtect` so injected native code can run in it.
   * All other protection and allocationType values are otherwise ignored —
   * allocation still goes through CRT malloc/calloc.
   */
  async alloc(
    size: number,
    protection?: number | Native.MemoryProtection,
    _allocationType?: number | Native.MemoryState,
    _address?: Native.NativePointer | null,
  ): Promise<Native.NativeMemory> {
    const mem = await this.proxy.alloc(size);

    const EXECUTE_MASK =
      Native.MemoryProtection.EXECUTE |
      Native.MemoryProtection.EXECUTE_READ |
      Native.MemoryProtection.EXECUTE_READWRITE |
      Native.MemoryProtection.EXECUTE_WRITECOPY;

    if (protection && (Number(protection) & EXECUTE_MASK) !== 0) {
      await this.protect(mem, size, Number(protection));
    }

    return mem;
  }

  /**
   * Frees a previously allocated pointer in the target process.
   *
   * Note: `size` and `freeType` are ignored — deallocation goes through
   * CRT free (or the NThreadHeap slab allocator).
   *
   * @returns Always `true` on success (CRT free has no return value).
   */
  async free(
    address: Native.NativePointer,
    _size?: number,
    _freeType?: number,
  ): Promise<boolean> {
    await this.proxy.dealloc(address);
    return true;
  }

  // ─── Memory protection ──────────────────────────────────────────────────

  /**
   * Changes the protection on a region of memory via `kernel32!VirtualProtect`.
   *
   * @returns The previous protection value (DWORD).
   */
  async protect(
    address: Native.NativePointer,
    size: number,
    newProtect: number,
  ): Promise<number> {
    // VirtualProtect needs a pointer to receive the old protection value
    const oldProtectBuf = await this.proxy.alloc(4);
    try {
      const result = await this.proxy.VirtualProtect(
        address.address,
        BigInt(size),
        BigInt(newProtect),
        oldProtectBuf.address,
      );
      if (result.address === 0n) {
        throw new Error(
          `VirtualProtect failed at ${address.toString()} (size=${size}, newProtect=0x${newProtect.toString(16)})`,
        );
      }
      // oldProtectBuf is in the same process memory space (Wine / same-PID),
      // so a direct local read is safe and avoids requiring proxy.read().
      const data = Native.currentProcess.memory.read(oldProtectBuf);
      return data.readUInt32LE(0);
    } finally {
      await this.proxy.dealloc(oldProtectBuf);
    }
  }

  // ─── Memory query ────────────────────────────────────────────────────────

  /**
   * Queries information about a memory region via `NThread.queryMemory`.
   */
  async query(
    address: Native.NativePointer,
  ): Promise<Native.MemoryBasicInformation> {
    return this.nthread.queryMemory(this.proxy, address);
  }
}
