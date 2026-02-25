import * as Native from '@cheatron/native';
import { KeystoneX86 } from '@cheatron/keystone';

export interface SpawnedThread {
  loopAddr: Native.NativePointer;
  thread: Native.Thread;
  tid: number;
}

/**
 * Allocates an executable `jmp .` page, spawns a thread on it, and waits
 * 50 ms for the OS to finish thread initialization (TEB / signal stack setup).
 *
 * The caller is responsible for cleanup — use {@link cleanupThread}.
 */
export async function spawnLoopThread(): Promise<SpawnedThread> {
  const assembler = new KeystoneX86();
  const loopBuffer = Buffer.from(assembler.asm('jmp .'));
  const proc = Native.currentProcess;
  const loopAddr = proc.memory.alloc(
    loopBuffer.length,
    null,
    Native.MemoryState.COMMIT,
    Native.MemoryProtection.EXECUTE_READWRITE,
  );
  proc.memory.write(loopAddr, loopBuffer);
  const thread = Native.Thread.create(loopAddr, null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { loopAddr, thread, tid: thread.tid };
}

/**
 * Terminates + closes the spawned thread and frees the loop page.
 * Safe to call even if the thread has already exited.
 */
export function cleanupThread(spawned: SpawnedThread): void {
  if (spawned.thread.isValid()) {
    spawned.thread.terminate(0);
    spawned.thread.close();
  }
  Native.currentProcess.memory.free(spawned.loopAddr);
}
