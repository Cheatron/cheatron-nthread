import * as Native from '@cheatron/native';
import type { ProxyThread } from '../thread/proxy-thread.js';
import {
  registerReadOnlyMemory,
  unregisterReadOnlyMemory,
  type ReadOnlyMemory,
} from './romem.js';
import { crt } from '../crt.js';

/** Default total heap size (bytes) */
export const DEFAULT_HEAP_SIZE = 16384;

/** Result of a heap allocation — pointer into the pre-allocated region */
export interface HeapAlloc {
  /** Remote address in the target process */
  readonly remote: Native.NativePointer;
  /** Size of this allocation */
  readonly size: number;
}

/** A free block in the free list */
interface FreeBlock {
  /** Offset from the zone start */
  offset: number;
  /** Size of the free block */
  size: number;
}

/**
 * A lightweight allocator that pre-allocates a single contiguous block
 * in the target process and carves out sub-allocations from it.
 *
 * The block is split into two zones:
 * - **Readonly zone** (first half): registered as romem — writes automatically
 *   skip unchanged bytes via snapshot diffing.
 * - **ReadWrite zone** (second half): standard memory — no snapshot tracking.
 *
 * Supports `free()` — freed blocks are returned to a per-zone free list
 * with automatic coalescing of adjacent blocks. New allocations check the
 * free list first (first-fit), then fall back to bumping.
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │  base                                    │
 * │  ├── readonly zone (roSize bytes)        │
 * │  │   ├── alloc 1                         │
 * │  │   ├── [freed → free list]             │
 * │  │   ├── alloc 3                         │
 * │  │   └── ... (bump / reuse →)            │
 * │  ├── readwrite zone (rwSize bytes)       │
 * │  │   ├── alloc 1                         │
 * │  │   ├── [freed → free list]             │
 * │  │   └── ... (bump / reuse →)            │
 * └──────────────────────────────────────────┘
 * ```
 */
export class Heap {
  /** Base remote address of the entire heap block */
  readonly base: Native.NativePointer;
  /** Total size of the heap */
  readonly totalSize: number;
  /** Size of the readonly zone */
  readonly roSize: number;
  /** Size of the readwrite zone */
  readonly rwSize: number;

  /** The romem handle for the readonly zone */
  readonly romem: ReadOnlyMemory;

  /** Current bump offset within the readonly zone */
  private roOffset = 0;
  /** Current bump offset within the readwrite zone */
  private rwOffset = 0;

  /** Free list for the readonly zone (sorted by offset) */
  private roFreeList: FreeBlock[] = [];
  /** Free list for the readwrite zone (sorted by offset) */
  private rwFreeList: FreeBlock[] = [];

  private constructor(
    base: Native.NativePointer,
    totalSize: number,
    roSize: number,
    rwSize: number,
    romem: ReadOnlyMemory,
  ) {
    this.base = base;
    this.totalSize = totalSize;
    this.roSize = roSize;
    this.rwSize = rwSize;
    this.romem = romem;
  }

  /**
   * Creates a new Heap by allocating a single contiguous block in the target
   * process via `calloc`. The block is zero-initialized.
   *
   * @param proxy The proxy thread to execute calloc on.
   * @param totalSize Total heap size in bytes (default: 16384).
   * @param roSize Size of the readonly zone (default: half of totalSize).
   * @returns A ready-to-use Heap instance.
   */
  static async create(
    proxy: ProxyThread,
    totalSize: number = DEFAULT_HEAP_SIZE,
    roSize?: number,
  ): Promise<Heap> {
    const actualRoSize = roSize ?? Math.floor(totalSize / 2);
    const rwSize = totalSize - actualRoSize;

    if (actualRoSize < 0 || rwSize < 0) {
      throw new Error(
        `Invalid heap sizes: roSize=${actualRoSize}, rwSize=${rwSize}`,
      );
    }

    const base = await proxy.call(crt.calloc, 1, totalSize);
    if (base.address === 0n) {
      throw new Error(`calloc(1, ${totalSize}) returned NULL`);
    }

    // Register the readonly zone as romem for snapshot-based write optimization
    const roRemote = base;
    const roLocal = Buffer.alloc(actualRoSize); // zero-filled — matches calloc
    const romem = registerReadOnlyMemory(roRemote, roLocal);

    return new Heap(base, totalSize, actualRoSize, rwSize, romem);
  }

  /** Remote address where the readwrite zone starts */
  get rwBase(): Native.NativePointer {
    return new Native.NativePointer(this.base.address + BigInt(this.roSize));
  }

  /** Remaining bytes in the readonly zone (bump area only, excludes free list) */
  get roRemaining(): number {
    return this.roSize - this.roOffset;
  }

  /** Remaining bytes in the readwrite zone (bump area only, excludes free list) */
  get rwRemaining(): number {
    return this.rwSize - this.rwOffset;
  }

  /**
   * Total available bytes in the readonly zone (bump + free list).
   */
  get roAvailable(): number {
    return (
      this.roRemaining + this.roFreeList.reduce((sum, b) => sum + b.size, 0)
    );
  }

  /**
   * Total available bytes in the readwrite zone (bump + free list).
   */
  get rwAvailable(): number {
    return (
      this.rwRemaining + this.rwFreeList.reduce((sum, b) => sum + b.size, 0)
    );
  }

  /**
   * First-fit search on a free list. Returns the index of the matching block,
   * or -1 if none found.
   */
  private static findFreeBlock(freeList: FreeBlock[], size: number): number {
    for (let i = 0; i < freeList.length; i++) {
      if (freeList[i]!.size >= size) return i;
    }
    return -1;
  }

  /**
   * Allocates from a free list block. If the block is larger than needed,
   * the remainder is kept in the free list.
   */
  private static splitFreeBlock(
    freeList: FreeBlock[],
    index: number,
    size: number,
  ): number {
    const block = freeList[index]!;
    const offset = block.offset;
    const remainder = block.size - size;

    if (remainder > 0) {
      block.offset += size;
      block.size = remainder;
    } else {
      freeList.splice(index, 1);
    }

    return offset;
  }

  /**
   * Inserts a freed block into the free list (sorted by offset)
   * and merges with adjacent blocks.
   */
  private static insertAndCoalesce(
    freeList: FreeBlock[],
    offset: number,
    size: number,
  ): void {
    // Find insertion point (keep sorted by offset)
    let insertIdx = 0;
    while (
      insertIdx < freeList.length &&
      freeList[insertIdx]!.offset < offset
    ) {
      insertIdx++;
    }

    freeList.splice(insertIdx, 0, { offset, size });

    // Merge with next block
    if (insertIdx + 1 < freeList.length) {
      const curr = freeList[insertIdx]!;
      const next = freeList[insertIdx + 1]!;
      if (curr.offset + curr.size === next.offset) {
        curr.size += next.size;
        freeList.splice(insertIdx + 1, 1);
      }
    }

    // Merge with previous block
    if (insertIdx > 0) {
      const prev = freeList[insertIdx - 1]!;
      const curr = freeList[insertIdx]!;
      if (prev.offset + prev.size === curr.offset) {
        prev.size += curr.size;
        freeList.splice(insertIdx, 1);
      }
    }
  }

  /**
   * Allocates from the readonly zone.
   * Checks the free list first (first-fit), then falls back to bumping.
   *
   * The returned pointer is inside the romem-registered region —
   * writes to it will benefit from snapshot-based skip optimization.
   *
   * @param size Number of bytes to allocate.
   * @returns HeapAlloc with the remote pointer and size.
   * @throws If the readonly zone doesn't have enough space.
   */
  allocReadonly(size: number): HeapAlloc {
    if (size <= 0) throw new Error(`Invalid alloc size: ${size}`);

    // Try free list first
    const freeIdx = Heap.findFreeBlock(this.roFreeList, size);
    if (freeIdx !== -1) {
      const offset = Heap.splitFreeBlock(this.roFreeList, freeIdx, size);
      const remote = new Native.NativePointer(
        this.base.address + BigInt(offset),
      );
      return { remote, size };
    }

    // Bump allocate
    if (this.roOffset + size > this.roSize) {
      throw new Error(
        `Readonly zone exhausted: requested ${size}, available ${this.roAvailable}`,
      );
    }

    const remote = new Native.NativePointer(
      this.base.address + BigInt(this.roOffset),
    );
    this.roOffset += size;
    return { remote, size };
  }

  /**
   * Allocates from the readwrite zone.
   * Checks the free list first (first-fit), then falls back to bumping.
   *
   * Standard memory — no romem tracking.
   *
   * @param size Number of bytes to allocate.
   * @returns HeapAlloc with the remote pointer and size.
   * @throws If the readwrite zone doesn't have enough space.
   */
  alloc(size: number): HeapAlloc {
    if (size <= 0) throw new Error(`Invalid alloc size: ${size}`);

    // Try free list first
    const freeIdx = Heap.findFreeBlock(this.rwFreeList, size);
    if (freeIdx !== -1) {
      const offset = Heap.splitFreeBlock(this.rwFreeList, freeIdx, size);
      const remote = new Native.NativePointer(
        this.base.address + BigInt(this.roSize) + BigInt(offset),
      );
      return { remote, size };
    }

    // Bump allocate
    if (this.rwOffset + size > this.rwSize) {
      throw new Error(
        `ReadWrite zone exhausted: requested ${size}, available ${this.rwAvailable}`,
      );
    }

    const remote = this.base.add(BigInt(this.roSize) + BigInt(this.rwOffset));
    this.rwOffset += size;
    return { remote, size };
  }

  /**
   * Frees a previously allocated block, returning it to the appropriate
   * zone's free list. Adjacent free blocks are automatically coalesced.
   *
   * Does NOT zero the remote memory. The romem snapshot for readonly
   * allocations remains unchanged (will be updated on next write).
   *
   * @param alloc The HeapAlloc returned by alloc() or allocReadonly().
   * @throws If the allocation doesn't belong to this heap.
   */
  free(alloc: HeapAlloc): void {
    const addr = alloc.remote.address;
    const baseAddr = this.base.address;
    const roEnd = baseAddr + BigInt(this.roSize);
    const rwEnd = roEnd + BigInt(this.rwSize);

    if (addr >= baseAddr && addr < roEnd) {
      // Readonly zone
      const offset = Number(addr - baseAddr);
      Heap.insertAndCoalesce(this.roFreeList, offset, alloc.size);
    } else if (addr >= roEnd && addr < rwEnd) {
      // ReadWrite zone — offset relative to rw zone start
      const offset = Number(addr - roEnd);
      Heap.insertAndCoalesce(this.rwFreeList, offset, alloc.size);
    } else {
      throw new Error(
        `Address 0x${addr.toString(16)} does not belong to this heap`,
      );
    }
  }

  /**
   * Resets both zones — clears free lists and bump pointers.
   * Does NOT zero out the remote memory — call memset separately if needed.
   * The romem snapshot (local buffer) is also reset to all zeroes.
   */
  reset(): void {
    this.roOffset = 0;
    this.rwOffset = 0;
    this.roFreeList.length = 0;
    this.rwFreeList.length = 0;
    this.romem.local.fill(0);
  }

  /**
   * Frees the entire heap block in the target process and unregisters the romem.
   *
   * @param proxy The proxy thread to execute free on.
   */
  async destroy(proxy: ProxyThread): Promise<void> {
    unregisterReadOnlyMemory(this.romem);
    await proxy.call(crt.free, this.base);
  }
}
