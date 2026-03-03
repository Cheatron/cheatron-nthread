import { expect, test, describe } from 'bun:test';
import * as Native from '@cheatron/native';
import { NThread, CallThreadDiedError } from '../src/index.js';
import { spawnLoopThread, cleanupThread } from './helpers.js';

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
        null,
        Native.MemoryState.COMMIT,
        Native.MemoryProtection.READWRITE,
      );
      expect(testMem.address).not.toBe(0n);

      const magicBuf = Buffer.alloc(4);
      magicBuf.writeUInt32LE(MAGIC);
      await proxy.write(testMem, magicBuf);
      const readBuf = process.memory.read(testMem, testSize);
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
        const asciiBuf = process.memory.read(asciiPtr, asciiStr.length + 1);
        expect(asciiBuf.toString('utf8', 0, asciiStr.length)).toBe(asciiStr);
        expect(asciiBuf[asciiStr.length]).toBe(0);
        await proxy.dealloc(asciiPtr);

        // Unicode → resolveEncoding picks utf16le (2-byte null terminator)
        const unicodeStr = 'Merhaba, Dünya! 🌍';
        const unicodePtr = await nthread.allocString(proxy, unicodeStr);
        expect(unicodePtr.address).not.toBe(0n);
        const unicodeEncoded = Buffer.from(unicodeStr, 'utf16le');
        const unicodeBuf = process.memory.read(
          unicodePtr,
          unicodeEncoded.length + 2,
        );
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
});
