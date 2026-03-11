import { expect, test, describe } from 'bun:test';
import * as Native from '@cheatron/native';
import {
  NThread,
  NThreadFile,
  CallThreadDiedError,
  createReadOnlyMemory,
  unregisterReadOnlyMemory,
  findOverlappingRegion,
} from '@cheatron/nthread';
import { spawnLoopThread, cleanupThread } from './helpers';

describe('NThreadFile', () => {
  test('should inject and establish file channel', async () => {
    const spawned = await spawnLoopThread();

    try {
      const nt = new NThreadFile();
      const [proxy, captured] = await nt.inject(spawned.tid);

      expect(captured.tid).toBe(spawned.tid);
      expect(captured.getContext()).toBeDefined();
      expect(captured.getContext().Rip).not.toBe(0n);

      await proxy.close();
      captured.close();
    } finally {
      cleanupThread(spawned);
    }
  });

  test('write and read through file channel', async () => {
    const spawned = await spawnLoopThread();

    try {
      const nt = new NThreadFile();
      const [proxy, captured] = await nt.inject(spawned.tid);

      try {
        // Allocate a remote buffer and write known data through the file channel
        const size = 64;
        const ptr = await proxy.alloc(size, { fill: 0 });
        expect(ptr.address).not.toBe(0n);
        expect(ptr.size).toBe(size);

        // Write a pattern via the file channel
        const pattern = Buffer.alloc(size);
        for (let i = 0; i < size; i++) pattern[i] = i & 0xff;
        const written = await proxy.write(ptr, pattern);
        expect(written).toBe(size);

        // Read it back through the file channel
        const readBack = await proxy.read(ptr);
        expect(readBack.length).toBe(size);
        expect(Buffer.compare(readBack, pattern)).toBe(0);
      } finally {
        await proxy.close();
        captured.close();
      }
    } finally {
      cleanupThread(spawned);
    }
  });

  test('write and read a large buffer (4 KiB)', async () => {
    const spawned = await spawnLoopThread();

    try {
      const nt = new NThreadFile();
      const [proxy, captured] = await nt.inject(spawned.tid);

      try {
        const size = 4096;
        const ptr = await proxy.alloc(size, { fill: 0 });

        // Fill with pseudo-random data
        const data = Buffer.alloc(size);
        for (let i = 0; i < size; i++) data[i] = (i * 37 + 13) & 0xff;
        await proxy.write(ptr, data);

        const readBack = await proxy.read(ptr);
        expect(readBack.length).toBe(size);
        expect(Buffer.compare(readBack, data)).toBe(0);
      } finally {
        await proxy.close();
        captured.close();
      }
    } finally {
      cleanupThread(spawned);
    }
  });

  test('allocString through file channel', async () => {
    const spawned = await spawnLoopThread();
    const process = Native.currentProcess;

    try {
      const nt = new NThreadFile();
      const [proxy, captured] = await nt.inject(spawned.tid);

      try {
        // ASCII string — resolveEncoding picks utf8
        const asciiStr = 'Hello, NThreadFile!';
        const asciiPtr = await nt.allocString(proxy, asciiStr);
        expect(asciiPtr.address).not.toBe(0n);

        const asciiBuf = process.memory.read(asciiPtr);
        expect(asciiBuf.toString('utf8', 0, asciiStr.length)).toBe(asciiStr);
        expect(asciiBuf[asciiStr.length]).toBe(0);
        await proxy.dealloc(asciiPtr);

        // Unicode string — resolveEncoding picks utf16le
        const unicodeStr = 'Dosya kanalı test 🗂️';
        const unicodePtr = await nt.allocString(proxy, unicodeStr);
        expect(unicodePtr.address).not.toBe(0n);

        const unicodeEncoded = Buffer.from(unicodeStr, 'utf16le');
        const unicodeBuf = process.memory.read(unicodePtr);
        expect(unicodeBuf.toString('utf16le', 0, unicodeEncoded.length)).toBe(
          unicodeStr,
        );
        expect(unicodeBuf.readUInt16LE(unicodeEncoded.length)).toBe(0);
        await proxy.dealloc(unicodePtr);
      } finally {
        await proxy.close();
        captured.close();
      }
    } finally {
      cleanupThread(spawned);
    }
  });

  test('proxy.close cleans up and thread exits', async () => {
    const spawned = await spawnLoopThread();

    try {
      const nt = new NThreadFile();
      const [proxy, captured] = await nt.inject(spawned.tid);

      // Verify the channel works before termination
      const ptr = await proxy.alloc(8, { fill: 0xaa });
      const readBack = await proxy.read(ptr);
      expect(readBack[0]).toBe(0xaa);

      const exitThread = Native.Module.kernel32.getProcAddress('ExitThread');
      expect(exitThread.address).not.toBe(0n);

      try {
        await proxy.call(exitThread, 42);
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(CallThreadDiedError);
      }

      expect(captured.getExitCode()).toBe(42);
      captured.close();
    } finally {
      cleanupThread(spawned);
    }
  });

  test('inject NThread first, then pass CapturedThread to NThreadFile', async () => {
    const spawned = await spawnLoopThread();
    const process = Native.currentProcess;

    try {
      // 1. Inject with base NThread — performs the hijack
      const nthread = new NThread();
      const [baseProxy, captured] = await nthread.inject(spawned.tid);

      expect(captured.tid).toBe(spawned.tid);

      // Verify the base proxy works (memset-based write)
      const MAGIC = 0xcafebabe;
      const testMem = process.memory.alloc(
        4,
        Native.MemoryProtection.READWRITE,
        Native.MemoryState.COMMIT | Native.MemoryState.RESERVE,
      );
      const magicBuf = Buffer.alloc(4);
      magicBuf.writeUInt32LE(MAGIC);
      await baseProxy.write(testMem, magicBuf);
      const readBuf = process.memory.read(testMem);
      expect(readBuf.readUInt32LE(0)).toBe(MAGIC);
      process.memory.free(testMem);

      // 2. Pass the CapturedThread to NThreadFile — skips hijack, sets up file channel
      const ntFile = new NThreadFile();
      const [fileProxy, sameCaptured] = await ntFile.inject(captured);

      expect(sameCaptured).toBe(captured);

      // 3. Write and read through the file channel
      const size = 128;
      const ptr = await fileProxy.alloc(size, { fill: 0 });
      expect(ptr.address).not.toBe(0n);

      const pattern = Buffer.alloc(size);
      for (let i = 0; i < size; i++) pattern[i] = (i * 17 + 5) & 0xff;
      const written = await fileProxy.write(ptr, pattern);
      expect(written).toBe(size);

      const readBack = await fileProxy.read(ptr);
      expect(readBack.length).toBe(size);
      expect(Buffer.compare(readBack, pattern)).toBe(0);

      // 4. allocString through the file channel proxy
      const testStr = 'Cross-inject works!';
      const strPtr = await ntFile.allocString(fileProxy, testStr);
      expect(strPtr.address).not.toBe(0n);
      const strBuf = process.memory.read(strPtr);
      expect(strBuf.toString('utf8', 0, testStr.length)).toBe(testStr);
      expect(strBuf[testStr.length]).toBe(0);
      await fileProxy.dealloc(strPtr);

      // 5. Clean up — file proxy closes the file channel + heap, then exit thread
      const exitThread = Native.Module.kernel32.getProcAddress('ExitThread');
      try {
        await fileProxy.call(exitThread, 99);
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(CallThreadDiedError);
      }

      expect(captured.getExitCode()).toBe(99);
      captured.close();
    } finally {
      cleanupThread(spawned);
    }
  });

  test('readonly alloc + write/read through file channel', async () => {
    const spawned = await spawnLoopThread();
    const process = Native.currentProcess;

    try {
      const nt = new NThreadFile();
      const [proxy, captured] = await nt.inject(spawned.tid);

      try {
        // 1. Allocate a readonly region via the heap (zero-filled)
        const size = 32;
        const ptr = await proxy.alloc(size, { readonly: true, fill: 0 });
        expect(ptr.address).not.toBe(0n);
        expect(ptr.size).toBe(size);

        // Verify zero-initialized via file channel read
        const zeroBuf = await proxy.read(ptr);
        expect(zeroBuf.length).toBe(size);
        expect(zeroBuf.every((b) => b === 0)).toBe(true);

        // 2. Write a pattern through the file channel
        const pattern = Buffer.alloc(size);
        pattern.writeUInt32LE(0xdeadbeef, 0);
        pattern.writeUInt32LE(0xcafebabe, 16);
        const written = await proxy.write(ptr, pattern);
        expect(written).toBe(size);

        // 3. Read back through the file channel
        const readBack = await proxy.read(ptr);
        expect(readBack.length).toBe(size);
        expect(readBack.readUInt32LE(0)).toBe(0xdeadbeef);
        expect(readBack.readUInt32LE(4)).toBe(0);
        expect(readBack.readUInt32LE(16)).toBe(0xcafebabe);
        expect(readBack.readUInt32LE(20)).toBe(0);

        // 4. Cross-verify via direct process memory read
        const directRead = process.memory.read(ptr);
        expect(Buffer.compare(directRead, pattern)).toBe(0);

        // 5. Dealloc the readonly region (should go through heap free, not CRT)
        await proxy.dealloc(ptr);
      } finally {
        await proxy.close();
        captured.close();
      }
    } finally {
      cleanupThread(spawned);
    }
  });

  test('romem with file channel — snapshot not tracked but writes work', async () => {
    const spawned = await spawnLoopThread();
    const process = Native.currentProcess;

    try {
      const nt = new NThreadFile();
      const [proxy, captured] = await nt.inject(spawned.tid);

      try {
        // 1. Create a romem region — calloc-backed, registered in the global registry
        const romem = await createReadOnlyMemory(proxy, 16);
        expect(romem.remote.address).not.toBe(0n);
        expect(romem.local.length).toBe(16);
        expect(findOverlappingRegion(romem.remote.address, 1)).toBe(romem);

        // 2. Write through file channel — romem snapshot system is bypassed,
        //    but the data should still arrive in the target
        const dataBuf = Buffer.alloc(16);
        dataBuf.writeUInt32LE(0x12345678, 0);
        dataBuf.writeUInt32LE(0xaabbccdd, 8);
        const written = await proxy.write(romem.remote, dataBuf);
        expect(written).toBe(16);

        // 3. Verify data reached the target via direct memory read
        const directRead = process.memory.read(romem.remote.withSize(16));
        expect(directRead.readUInt32LE(0)).toBe(0x12345678);
        expect(directRead.readUInt32LE(8)).toBe(0xaabbccdd);

        // 4. Read back via file channel
        const fileRead = await proxy.read(romem.remote.withSize(16));
        expect(fileRead.readUInt32LE(0)).toBe(0x12345678);
        expect(fileRead.readUInt32LE(8)).toBe(0xaabbccdd);

        // 5. Note: romem.local snapshot is NOT updated by file channel writes
        //    (the file channel bypasses the romem system entirely)
        expect(romem.local.readUInt32LE(0)).toBe(0);
        expect(romem.local.readUInt32LE(8)).toBe(0);

        // 6. Cleanup
        expect(unregisterReadOnlyMemory(romem)).toBe(true);
        expect(findOverlappingRegion(romem.remote.address, 1)).toBeUndefined();
      } finally {
        await proxy.close();
        captured.close();
      }
    } finally {
      cleanupThread(spawned);
    }
  });
});
