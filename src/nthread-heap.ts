import * as Native from '@cheatron/native';
import { NThread } from './nthread.js';
import { Heap, type HeapAlloc } from './memory/heap.js';
import type { CapturedThread } from './thread/captured-thread.js';
import type { ProxyThread } from './thread/proxy-thread.js';
import type { GeneralPurposeRegs } from './globals.js';
import type { AllocOptions } from './memory/alloc-options.js';

/** Default initial heap block size (bytes). */
export const DEFAULT_NTHREAD_HEAP_SIZE = 65536;

/** Default maximum heap size — heap doubles up to this limit before falling back to super. */
export const DEFAULT_NTHREAD_HEAP_MAX_SIZE = DEFAULT_NTHREAD_HEAP_SIZE * 8; // 512 KiB

/** An allocation record: heap-backed or delegated to the super (NThread) allocator. */
type AllocRecord = { alloc: HeapAlloc; heap: Heap } | 'super';

/** Per-proxy runtime state. */
interface ProxyState {
  /** The current (active) heap new allocations are served from. */
  heap: Heap | null;
  /** Older heap blocks kept alive solely so their existing allocs can be freed. */
  prevHeaps: Heap[];
  allocations: Map<bigint, AllocRecord>;
}

/**
 * NThreadHeap extends {@link NThread} with a single growing heap per injection.
 *
 * On first allocation a {@link Heap} of `heapSize` bytes is created in the
 * target process via `calloc`. When it fills up the heap is **doubled** (up to
 * `maxSize`) — the old block is kept resident so its existing allocations can
 * still be freed, but new allocations come from the freshly grown block.
 *
 * When even a `maxSize`-sized block cannot satisfy a request (or `maxSize` is
 * already reached), `super.threadAlloc()` is called — the base {@link NThread}
 * allocator, which uses `msvcrt!malloc` / `calloc` / `realloc`.
 *
 * ### Lifecycle
 * - `proxy.close()` destroys the active heap **and** all previous blocks, then
 *   restores the thread context via `super.threadClose()`.
 *
 * ### When to prefer NThreadHeap over NThread
 * - Many small allocations: one `calloc` round-trip per block instead of per alloc
 * - Readonly data: zone-typed allocs benefit from romem snapshot-skip writes
 * - Predictable lifetime: all heap memory freed atomically on `proxy.close()`
 *
 * @example
 * ```typescript
 * const nt = new NThreadHeap(65536, 524288); // initial 64 KiB, max 512 KiB
 * const [proxy] = await nt.inject(tid);
 *
 * const ptr = await proxy.alloc(64, { readonly: true, fill: 0 });
 * await proxy.write(ptr, myBuffer);
 *
 * await proxy.close(); // destroys all heap blocks, restores thread
 * ```
 */
export class NThreadHeap extends NThread {
  /** Initial heap block size (bytes). */
  readonly heapSize: number;
  /** Maximum heap block size (bytes). Exceeded → super.threadAlloc(). */
  readonly maxSize: number;

  private state = new Map<ProxyThread, ProxyState>();

  constructor(
    heapSize?: number,
    maxSize?: number,
    processId?: number,
    sleepAddress?: Native.NativePointer,
    pushretAddress?: Native.NativePointer,
    regKey?: GeneralPurposeRegs,
  ) {
    super(processId, sleepAddress, pushretAddress, regKey);
    this.heapSize = heapSize ?? DEFAULT_NTHREAD_HEAP_SIZE;
    this.maxSize = maxSize ?? DEFAULT_NTHREAD_HEAP_MAX_SIZE;
  }

  // ---------------------------------------------------------------------------
  // Overrides
  // ---------------------------------------------------------------------------

  protected override async threadClose(
    proxy: ProxyThread,
    captured: CapturedThread,
    suicide?: number,
  ): Promise<void> {
    const s = this.state.get(proxy);
    if (s) {
      const allHeaps = s.heap ? [...s.prevHeaps, s.heap] : s.prevHeaps;
      for (const heap of allHeaps) {
        await heap.destroy(proxy);
      }
      this.state.delete(proxy);
    }
    await super.threadClose(proxy, captured, suicide);
  }

  protected override async threadAlloc(
    proxy: ProxyThread,
    size: number,
    opts?: AllocOptions,
  ): Promise<Native.NativePointer> {
    if (opts?.address) {
      return this.reallocInternal(proxy, opts.address, size, opts);
    }

    const ro = opts?.readonly ?? false;
    const ptr = await this.allocFromHeap(proxy, size, ro);

    // ptr === null → heap can't serve it; fall back to super (NThread/malloc)
    if (ptr === null) {
      return super.threadAlloc(proxy, size, opts);
    }

    if (opts?.fill !== undefined) {
      await proxy.write(ptr, Buffer.alloc(size, opts.fill & 0xff));
    }

    return ptr;
  }

  protected override async threadFree(
    proxy: ProxyThread,
    ptr: Native.NativePointer,
  ): Promise<void> {
    const s = this.state.get(proxy);
    const entry = s?.allocations.get(ptr.address);
    s?.allocations.delete(ptr.address);

    // Unknown or super-backed → delegate to NThread base (crt.free)
    if (!entry || entry === 'super') {
      return super.threadFree(proxy, ptr);
    }

    entry.heap.free(entry.alloc);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private getState(proxy: ProxyThread): ProxyState {
    let s = this.state.get(proxy);
    if (!s) {
      s = { heap: null, prevHeaps: [], allocations: new Map() };
      this.state.set(proxy, s);
    }
    return s;
  }

  /**
   * Tries to allocate from the active heap. Grows the heap if full (up to
   * `maxSize`). Returns `null` when the request must be served by super.
   */
  private async allocFromHeap(
    proxy: ProxyThread,
    size: number,
    ro: boolean,
  ): Promise<Native.NativePointer | null> {
    const s = this.getState(proxy);

    if (s.heap) {
      // Try current active heap
      const result = this.tryAlloc(s.heap, size, ro);
      if (result) {
        s.allocations.set(result.remote.address, {
          alloc: result,
          heap: s.heap,
        });
        return result.remote;
      }

      // Full — can we grow?
      if (s.heap.totalSize >= this.maxSize) return null; // at ceiling

      const newSize = Math.min(s.heap.totalSize * 2, this.maxSize);
      if (size > newSize) return null; // request too big for any heap block

      s.prevHeaps.push(s.heap);
      s.heap = await Heap.create(proxy, newSize, this.calcRoSize(newSize, ro));
    } else {
      // First alloc — create the initial heap
      if (size > this.maxSize) return null;
      const initSize = Math.max(Math.min(this.heapSize, this.maxSize), size);
      s.heap = await Heap.create(
        proxy,
        initSize,
        this.calcRoSize(initSize, ro),
      );
    }

    const result = this.tryAlloc(s.heap, size, ro);
    if (!result) return null; // shouldn't happen

    s.allocations.set(result.remote.address, { alloc: result, heap: s.heap });
    return result.remote;
  }

  /** Silent wrapper around `Heap.alloc` / `Heap.allocReadonly`. Returns `null` on failure. */
  private tryAlloc(heap: Heap, size: number, ro: boolean): HeapAlloc | null {
    try {
      return ro ? heap.allocReadonly(size) : heap.alloc(size);
    } catch {
      return null;
    }
  }

  /** Computes readonly zone size for a new heap block. */
  private calcRoSize(totalSize: number, ro: boolean): number {
    return ro ? Math.floor((totalSize * 3) / 4) : Math.floor(totalSize / 4);
  }

  private async reallocInternal(
    proxy: ProxyThread,
    address: Native.NativePointer,
    newSize: number,
    opts?: AllocOptions,
  ): Promise<Native.NativePointer> {
    const s = this.getState(proxy);
    const entry = s.allocations.get(address.address);

    if (!entry || entry === 'super') {
      // Delegate entirely to NThread base (CRT realloc path)
      if (entry === 'super') s.allocations.delete(address.address);
      const newPtr = await super.threadAlloc(proxy, newSize, opts);
      s.allocations.set(newPtr.address, 'super');
      return newPtr;
    }

    // Detect old zone: address < base + roSize → was readonly
    const oldRo =
      entry.alloc.remote.address <
      entry.heap.base.address + BigInt(entry.heap.roSize);

    // Preserve old zone unless caller explicitly requests a change
    const ro = opts?.readonly ?? oldRo;

    // Allocate new block (heap if possible, otherwise super/CRT — but NOT realloc on old address)
    const newRaw = await this.allocFromHeap(proxy, newSize, ro);
    const newPtr =
      newRaw ??
      (await super.threadAlloc(proxy, newSize, {
        ...opts,
        address: undefined,
      }));
    if (!newRaw) s.allocations.set(newPtr.address, 'super');

    // Copy old content
    const copyLen = Math.min(entry.alloc.size, newSize);
    if (copyLen > 0) {
      const oldData = await proxy.read(address, copyLen);
      await proxy.write(newPtr, oldData);
    }

    // Fill newly added bytes when growing
    if (newSize > copyLen && opts?.fill !== undefined) {
      const fillPtr = new Native.NativePointer(
        newPtr.address + BigInt(copyLen),
      );
      await proxy.write(
        fillPtr,
        Buffer.alloc(newSize - copyLen, opts.fill & 0xff),
      );
    }

    entry.heap.free(entry.alloc);
    s.allocations.delete(address.address);

    return newPtr;
  }
}
