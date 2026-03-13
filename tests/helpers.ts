import * as Native from '@cheatron/native';
import { KeystoneX86 } from '@cheatron/keystone';

export interface SpawnedThread {
  loopAddr: Native.NativePointer;
  thread: Native.Thread;
  tid: number;
}

export interface SpawnedSleepThread {
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
    Native.MemoryProtection.EXECUTE_READWRITE,
    Native.MemoryState.COMMIT,
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

/**
 * Spawns a thread that immediately executes kernel32!Sleep(ms).
 * Useful for testing inject/cancel behavior while the target is in a syscall wait.
 */
export async function spawnSleepThread(
  ms: number = 5000,
): Promise<SpawnedSleepThread> {
  const sleepAddr = Native.Module.kernel32.getProcAddress('Sleep');
  const thread = Native.Thread.create(sleepAddr, new Native.NativePointer(ms));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { thread, tid: thread.tid };
}

/**
 * Terminates + closes a spawned Sleep thread.
 * Safe to call even if the thread has already exited.
 */
export function cleanupSleepThread(spawned: SpawnedSleepThread): void {
  if (spawned.thread.isValid()) {
    spawned.thread.terminate(0);
    spawned.thread.close();
  }
}
