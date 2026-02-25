import * as Native from '@cheatron/native';
import type { ProxyThread } from '../thread/proxy-thread.js';
import { crt } from '../crt.js';

/**
 * A read-only memory region allocated in the target process.
 * Stores both the remote pointer and a local Buffer copy.
 * Since we are the ones who wrote it, we always know the exact contents —
 * this lets writeMemory skip unchanged bytes automatically.
 */
export interface ReadOnlyMemory {
  /** Remote address in the target process (allocated via calloc) */
  readonly remote: Native.NativePointer;
  /** Local copy of the data — always mirrors what is on the remote side */
  readonly local: Buffer;
}

/** Internal storage for all registered read-only regions */
const regions: ReadOnlyMemory[] = [];

/**
 * Allocates a zero-initialized read-only memory region in the target process
 * via hijacked `calloc(1, size)` and registers it for write-optimization.
 *
 * @param proxy The proxy thread to execute calloc on.
 * @param size  Total byte size to allocate.
 * @returns A ReadOnlyMemory handle.
 */
export async function createReadOnlyMemory(
  proxy: ProxyThread,
  size: number,
): Promise<ReadOnlyMemory> {
  const ptr = await proxy.call(crt.calloc, 1, size);
  if (ptr.address === 0n) {
    throw new Error(`calloc(1, ${size}) returned NULL`);
  }

  const local = Buffer.alloc(size); // zero-filled — matches calloc
  const romem: ReadOnlyMemory = { remote: ptr, local };
  regions.push(romem);
  return romem;
}

/**
 * Registers an existing pointer + buffer pair as a read-only memory region.
 * Use this when the memory was allocated through other means but you still
 * want writeMemory to benefit from the snapshot optimization.
 *
 * @param remote Address in the target process.
 * @param local  Buffer that mirrors the remote contents exactly.
 */
export function registerReadOnlyMemory(
  remote: Native.NativePointer,
  local: Buffer,
): ReadOnlyMemory {
  const romem: ReadOnlyMemory = { remote, local };
  regions.push(romem);
  return romem;
}

/**
 * Removes a read-only memory region from the registry.
 * Does NOT free the remote allocation — call `free` separately if needed.
 */
export function unregisterReadOnlyMemory(romem: ReadOnlyMemory): boolean {
  const idx = regions.indexOf(romem);
  if (idx === -1) return false;
  regions.splice(idx, 1);
  return true;
}

/**
 * Checks whether a write range [destAddr, destAddr + writeLen) overlaps
 * with any registered read-only region.
 *
 * Returns the overlapping region, or undefined if no overlap.
 */
export function findOverlappingRegion(
  destAddr: bigint,
  writeLen: number,
): ReadOnlyMemory | undefined {
  const writeEnd = destAddr + BigInt(writeLen);
  for (const r of regions) {
    const rStart = r.remote.address;
    const rEnd = rStart + BigInt(r.local.length);
    // overlap: !(writeEnd <= rStart || destAddr >= rEnd)
    if (writeEnd > rStart && destAddr < rEnd) {
      return r;
    }
  }
  return undefined;
}

/**
 * Extracts the local snapshot bytes for the overlapping portion of a write.
 *
 * Given a write to [destAddr, destAddr + writeLen) that overlaps with `romem`,
 * returns the Buffer slice from romem.local that corresponds to the overlap region,
 * along with the overlap boundaries relative to the write.
 */
export function getOverlapInfo(
  destAddr: bigint,
  writeLen: number,
  romem: ReadOnlyMemory,
): {
  /** Offset within the write buffer where the overlap begins */
  writeOffset: number;
  /** Length of the overlapping region */
  overlapLen: number;
  /** The snapshot bytes from romem.local for the overlapping range */
  snapshot: Buffer;
} {
  const writeEnd = destAddr + BigInt(writeLen);
  const rStart = romem.remote.address;
  const rEnd = rStart + BigInt(romem.local.length);

  const overlapStart = destAddr > rStart ? destAddr : rStart;
  const overlapEnd = writeEnd < rEnd ? writeEnd : rEnd;
  const overlapLen = Number(overlapEnd - overlapStart);

  // Offset within the write buffer
  const writeOffset = Number(overlapStart - destAddr);

  // Offset within romem.local
  const romemOffset = Number(overlapStart - rStart);
  const snapshot = romem.local.subarray(romemOffset, romemOffset + overlapLen);

  return { writeOffset, overlapLen, snapshot };
}

/**
 * Updates the local snapshot of a read-only region after a successful write.
 * Call this after writeMemorySafeBuffer completes to keep the snapshot current.
 *
 * @param romem    The read-only memory region.
 * @param source   The data that was written.
 * @param destAddr The remote address that was written to.
 */
export function updateSnapshot(
  romem: ReadOnlyMemory,
  source: Buffer,
  destAddr: bigint,
): void {
  const rStart = romem.remote.address;
  const writeStart = destAddr;
  const writeEnd = writeStart + BigInt(source.length);
  const rEnd = rStart + BigInt(romem.local.length);

  const overlapStart = writeStart > rStart ? writeStart : rStart;
  const overlapEnd = writeEnd < rEnd ? writeEnd : rEnd;
  if (overlapEnd <= overlapStart) return;

  const srcOffset = Number(overlapStart - writeStart);
  const dstOffset = Number(overlapStart - rStart);
  const len = Number(overlapEnd - overlapStart);

  source.copy(romem.local, dstOffset, srcOffset, srcOffset + len);
}
