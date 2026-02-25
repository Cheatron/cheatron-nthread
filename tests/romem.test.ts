import { expect, test, describe } from 'bun:test';
import * as Native from '@cheatron/native';
import {
  NThread,
  createReadOnlyMemory,
  unregisterReadOnlyMemory,
  findOverlappingRegion,
} from '../src/index.js';
import { spawnLoopThread, cleanupThread } from './helpers.js';

describe('ReadOnlyMemory', () => {
  test('createReadOnlyMemory allocates via calloc and writeMemory uses safe path', async () => {
    const spawned = await spawnLoopThread();
    const process = Native.currentProcess;

    try {
      const [proxy, captured] = await new NThread().inject(spawned.tid);

      // 1. Allocate a 16-byte read-only region (zero-initialized via calloc)
      const romem = await createReadOnlyMemory(proxy, 16);
      expect(romem.remote.address).not.toBe(0n);
      expect(romem.local.length).toBe(16);
      expect(romem.local.every((b) => b === 0)).toBe(true);

      // 2. Verify the region is findable
      expect(findOverlappingRegion(romem.remote.address, 1)).toBe(romem);

      // 3. Write identical data (all zeroes) — safeBuffer should skip everything
      expect(await proxy.write(romem.remote, Buffer.alloc(16))).toBe(16);
      expect(process.memory.read(romem.remote, 16).every((b) => b === 0)).toBe(
        true,
      );

      // 4. Write actual data — only changed bytes are written
      const dataBuf = Buffer.alloc(16);
      dataBuf.writeUInt32LE(0xdeadbeef, 0);
      dataBuf.writeUInt32LE(0xcafebabe, 8);
      expect(await proxy.write(romem.remote, dataBuf)).toBe(16);

      const rb = process.memory.read(romem.remote, 16);
      expect(rb.readUInt32LE(0)).toBe(0xdeadbeef);
      expect(rb.readUInt32LE(4)).toBe(0);
      expect(rb.readUInt32LE(8)).toBe(0xcafebabe);
      expect(rb.readUInt32LE(12)).toBe(0);

      // 5. Snapshot updated
      expect(romem.local.readUInt32LE(0)).toBe(0xdeadbeef);
      expect(romem.local.readUInt32LE(8)).toBe(0xcafebabe);

      // 6. Same data again — safeBuffer skips all (idempotent)
      expect(await proxy.write(romem.remote, dataBuf)).toBe(16);
      const rb2 = process.memory.read(romem.remote, 16);
      expect(rb2.readUInt32LE(0)).toBe(0xdeadbeef);
      expect(rb2.readUInt32LE(8)).toBe(0xcafebabe);

      // 7. Unregister
      const scratchAddr = process.memory.alloc(
        4,
        null,
        Native.MemoryState.COMMIT,
        Native.MemoryProtection.READWRITE,
      );
      expect(unregisterReadOnlyMemory(romem)).toBe(true);
      expect(findOverlappingRegion(romem.remote.address, 1)).toBeUndefined();
      expect(unregisterReadOnlyMemory(romem)).toBe(false);
      process.memory.free(scratchAddr);

      captured.release();
    } finally {
      cleanupThread(spawned);
    }
  });
});
