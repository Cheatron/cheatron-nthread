import { expect, test, describe } from 'bun:test';
import * as Native from '@cheatron/native';
import {
  NThread,
  CallThreadDiedError,
  InjectAbortedError,
} from '@cheatron/nthread';
import {
  spawnLoopThread,
  cleanupThread,
  spawnSleepThread,
  cleanupSleepThread,
} from './helpers';

describe('NThread', () => {
  test('should be exported', () => {
    expect(NThread).toBeDefined();
  });

  test('should attach to an infinite loop thread and capture context', async () => {
    const spawned = await spawnLoopThread();
    const process = Native.currentProcess;
    expect(spawned.tid).toBeGreaterThan(0);

    try {
      const nthread = new NThread();
      const [proxy, captured] = await nthread.inject(spawned.tid);

      expect(captured.tid).toBe(spawned.tid);
      expect(captured.getContext()).toBeDefined();
      expect(captured.getContext().Rip).toBeDefined();
      expect(captured.getContext().Rip).not.toBe(0n);

      const MAGIC = 0xdeadbeef;
      const testSize = 4;
      const testMem = process.memory.alloc(
        testSize,
        Native.MemoryProtection.READWRITE,
        Native.MemoryState.COMMIT | Native.MemoryState.RESERVE,
      );
      expect(testMem.address).not.toBe(0n);

      const magicBuf = Buffer.alloc(4);
      magicBuf.writeUInt32LE(MAGIC);
      await proxy.write(testMem, magicBuf);
      const readBuf = process.memory.read(testMem);
      expect(readBuf.readUInt32LE(0)).toBe(MAGIC);
      process.memory.free(testMem);

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

  test('allocString — writes null-terminated wide string into target', async () => {
    const spawned = await spawnLoopThread();
    const process = Native.currentProcess;

    try {
      const nthread = new NThread();
      const [proxy, captured] = await nthread.inject(spawned.tid);

      try {
        // ASCII → resolveEncoding picks utf8 (1 byte/char + 1-byte null)
        const asciiStr = 'Hello, NThread!';
        const asciiPtr = await nthread.allocString(proxy, asciiStr);
        expect(asciiPtr.address).not.toBe(0n);
        const asciiBuf = process.memory.read(asciiPtr);
        expect(asciiBuf.toString('utf8', 0, asciiStr.length)).toBe(asciiStr);
        expect(asciiBuf[asciiStr.length]).toBe(0);
        await proxy.dealloc(asciiPtr);

        // Unicode → resolveEncoding picks utf16le (2-byte null terminator)
        const unicodeStr = 'Merhaba, Dünya! 🌍';
        const unicodePtr = await nthread.allocString(proxy, unicodeStr);
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

  test('inject — supports AbortSignal cancellation', async () => {
    const spawned = await spawnLoopThread();

    try {
      const nthread = new NThread();
      const controller = new AbortController();
      controller.abort();

      await expect(
        nthread.inject(spawned.tid, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(InjectAbortedError);
    } finally {
      cleanupThread(spawned);
    }
  });

  test('inject — aborts while target thread is in Sleep syscall', async () => {
    const spawned = await spawnSleepThread(5000);

    try {
      const nthread = new NThread();
      const controller = new AbortController();
      const injectPromise = nthread.inject(spawned.tid, {
        signal: controller.signal,
        timeoutMs: 10000,
        pollIntervalMs: 10,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();

      await expect(injectPromise).rejects.toBeInstanceOf(InjectAbortedError);
    } finally {
      cleanupSleepThread(spawned);
    }
  });

  test('scan — finds all occurrences of a pattern in remote memory', async () => {
    const spawned = await spawnLoopThread();

    try {
      const nthread = new NThread();
      const [proxy, captured] = await nthread.inject(spawned.tid);

      try {
        const SIZE = 1024;
        // Allocate zeroed buffer in target process
        const mem = await proxy.alloc(SIZE, { fill: 0 });

        // Write a distinct 4-byte marker at three known offsets
        const MARKER = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const OFFSETS = [0, 256, 700];
        for (const off of OFFSETS) {
          await proxy.write(
            new Native.NativePointer(mem.address + BigInt(off)),
            MARKER,
          );
        }

        // Scan for the marker pattern
        const pattern = new Native.Pattern('DE AD BE EF');
        const found: bigint[] = [];
        for await (const addr of nthread.scan(proxy, mem, pattern)) {
          found.push(addr);
        }

        expect(found.length).toBe(OFFSETS.length);
        for (const off of OFFSETS) {
          expect(found).toContain(mem.address + BigInt(off));
        }

        await proxy.dealloc(mem);
      } finally {
        await proxy.close();
        captured.close();
      }
    } finally {
      cleanupThread(spawned);
    }
  }, 60000);
});
