import { expect, test, describe } from 'bun:test';
import * as Native from '@cheatron/native';
import { NThreadFile, CallThreadDiedError } from '../src/index.js';
import { spawnLoopThread, cleanupThread } from './helpers.js';

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

        const asciiBuf = process.memory.read(asciiPtr, asciiStr.length + 1);
        expect(asciiBuf.toString('utf8', 0, asciiStr.length)).toBe(asciiStr);
        expect(asciiBuf[asciiStr.length]).toBe(0);
        await proxy.dealloc(asciiPtr);

        // Unicode string — resolveEncoding picks utf16le
        const unicodeStr = 'Dosya kanalı test 🗂️';
        const unicodePtr = await nt.allocString(proxy, unicodeStr);
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
});
