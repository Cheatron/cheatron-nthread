import { expect, test, describe } from 'bun:test';
import * as Native from '@cheatron/native';
import { NThread, Heap, findOverlappingRegion } from '../src/index.js';
import { KeystoneX86 } from '@cheatron/keystone';

describe('Heap', () => {
  test('create, alloc, free, reuse, write, and destroy', async () => {
    const assembler = new KeystoneX86();
    const loopCode = assembler.asm('jmp .');
    const loopBuffer = Buffer.from(loopCode);

    const process = Native.currentProcess;
    const loopAddr = process.memory.alloc(
      loopBuffer.length,
      null,
      0x3000,
      Native.MemoryProtection.EXECUTE_READWRITE,
    );
    process.memory.write(loopAddr, loopBuffer);

    const thread = Native.Thread.create(loopAddr, null);
    const tid = thread.tid;
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const nthread = new NThread();
      const [proxy, captured] = await nthread.inject(tid);

      // 1. Create a small heap: 256 total, 128 ro + 128 rw
      const heap = await Heap.create(proxy, 256, 128);
      expect(heap.base.address).not.toBe(0n);
      expect(heap.totalSize).toBe(256);
      expect(heap.roSize).toBe(128);
      expect(heap.rwSize).toBe(128);
      expect(heap.roRemaining).toBe(128);
      expect(heap.rwRemaining).toBe(128);

      // 2. Readonly zone is registered as romem
      expect(findOverlappingRegion(heap.base.address, 1)).toBe(heap.romem);

      // 3. Bump allocations
      const roA = heap.allocReadonly(32);
      expect(roA.size).toBe(32);
      expect(roA.remote.address).toBe(heap.base.address);
      expect(heap.roRemaining).toBe(96);

      const roB = heap.allocReadonly(32);
      expect(roB.remote.address).toBe(heap.base.address + 32n);
      expect(heap.roRemaining).toBe(64);

      const rwA = heap.alloc(48);
      expect(rwA.size).toBe(48);
      expect(rwA.remote.address).toBe(heap.rwBase.address);
      expect(heap.rwRemaining).toBe(80);

      const rwB = heap.alloc(32);
      expect(rwB.remote.address).toBe(heap.rwBase.address + 48n);
      expect(heap.rwRemaining).toBe(48);

      // 4. Free and reuse — readonly zone
      heap.free(roA); // free the first 32-byte block
      expect(heap.roAvailable).toBe(64 + 32); // bump remaining + freed

      const roC = heap.allocReadonly(16); // should come from free list (first-fit)
      expect(roC.remote.address).toBe(heap.base.address); // reuses roA's slot
      expect(roC.size).toBe(16);

      const roD = heap.allocReadonly(16); // remainder of roA's slot
      expect(roD.remote.address).toBe(heap.base.address + 16n);

      // 5. Free and reuse — readwrite zone
      heap.free(rwA); // free the first 48-byte block
      expect(heap.rwAvailable).toBe(48 + 48); // bump remaining + freed

      const rwC = heap.alloc(48); // exact reuse
      expect(rwC.remote.address).toBe(heap.rwBase.address);

      // 6. Coalescing — free two adjacent blocks, then alloc their combined size
      heap.free(roC); // offset 0, size 16
      heap.free(roD); // offset 16, size 16 — should coalesce into [0, 32)

      const roE = heap.allocReadonly(32); // should get the coalesced block
      expect(roE.remote.address).toBe(heap.base.address);
      expect(roE.size).toBe(32);

      // 7. Write to a readonly alloc — romem safe path
      const data = Buffer.alloc(32);
      data.writeUInt32LE(0xdeadbeef, 0);
      data.writeUInt32LE(0xcafebabe, 4);
      await proxy.write(roE.remote, data);

      const readBack = process.memory.read(roE.remote, 32);
      expect(readBack.readUInt32LE(0)).toBe(0xdeadbeef);
      expect(readBack.readUInt32LE(4)).toBe(0xcafebabe);
      expect(readBack.readUInt32LE(8)).toBe(0); // rest is zero

      // 8. Write to a rw alloc — standard memset path
      const rwData = Buffer.alloc(32);
      rwData.writeUInt32LE(0x12345678, 0);
      await proxy.write(rwB.remote, rwData);

      const rwReadBack = process.memory.read(rwB.remote, 32);
      expect(rwReadBack.readUInt32LE(0)).toBe(0x12345678);

      // 9. Exhaust zone then free to make space
      // Fill remaining ro bump area
      const _roFill = heap.allocReadonly(heap.roRemaining);
      expect(heap.roRemaining).toBe(0);

      // Can't alloc more from bump
      expect(() => heap.allocReadonly(1)).toThrow();

      // Free something and alloc from free list
      heap.free(roE);
      const roF = heap.allocReadonly(32);
      expect(roF.remote.address).toBe(heap.base.address);

      // 10. Invalid free — address outside heap
      const fakeAlloc = {
        remote: new Native.NativePointer(0xdeadn),
        size: 4,
      };
      expect(() => heap.free(fakeAlloc)).toThrow('does not belong');

      // 11. Reset clears everything
      heap.reset();
      expect(heap.roRemaining).toBe(128);
      expect(heap.rwRemaining).toBe(128);
      expect(heap.roAvailable).toBe(128);
      expect(heap.rwAvailable).toBe(128);

      // 12. Destroy frees the remote memory and unregisters romem
      await heap.destroy(proxy);
      expect(findOverlappingRegion(heap.base.address, 1)).toBeUndefined();

      // Cleanup
      captured.release();
    } finally {
      if (thread.isValid()) {
        thread.terminate(0);
        thread.close();
      }
      process.memory.free(loopAddr);
    }
  });
});
