import type * as Native from '@cheatron/native';

/** Options for ProxyThread.alloc(). */
export interface AllocOptions {
  /**
   * Fill byte applied after allocation.
   * - `undefined` → no explicit fill
   * - `0`         → zero fill (uses `calloc` for raw malloc fallback; explicit memset for heap)
   * - `N`         → fill entire block with `N & 0xff`
   */
  fill?: number;

  /**
   * Allocate from the romem-tracked readonly zone of the heap.
   * Default: `false` (readwrite zone). Ignored when falling back to raw malloc.
   */
  readonly?: boolean;

  /**
   * If provided, realloc mode: resize this existing allocation to `size` bytes.
   * - Heap-backed: allocate new block → copy old data → free old block.
   * - malloc-backed (or unknown): delegates to `msvcrt!realloc`.
   */
  address?: Native.NativePointer;
}
