import * as Native from '@cheatron/native';
import type { GeneralPurposeRegs } from '../globals.js';

export const STACK_ADD = -8192n;

/**
 * CapturedThread: A specialized Thread wrapper that manages the low-level state
 * of a captured thread, including context caching, suspend/resume tracking,
 * and register manipulation.
 *
 * It extends Native.Thread. A ProxyThread holds the reference back to this instance.
 */
export class CapturedThread extends Native.Thread {
  /** Count of active suspensions to ensure balanced resume calls on close */
  protected suspendCount = 0;

  /** The register context captured immediately before hijacking */
  public savedContext!: Native.ThreadContext;

  /** The current live or modified context of the thread */
  public latestContext!: Native.ThreadContext;

  /** Pre-computed RSP value used for call() — set once during inject() */
  public callRsp: bigint = 0n;

  /** Address of an infinite loop gadget ('jmp .') used to hold the thread */
  public sleepAddress: Native.NativePointer;

  /** The register key (e.g., 'Rbx') used for the pushret pivot */
  public regKey: GeneralPurposeRegs;

  /**
   * Creates a CapturedThread instance.
   * @param thread Thread object or Thread ID to attach to.
   * @param regKey The register key used for the pushret pivot.
   * @param sleepAddress The sleep gadget address for parking the thread.
   * @param processId Optional process ID for diagnostics and logging.
   */
  constructor(
    thread: Native.Thread | number,
    regKey: GeneralPurposeRegs,
    sleepAddress: Native.NativePointer,
    processId?: number,
  ) {
    let threadObject: Native.Thread;
    if (thread instanceof Native.Thread) {
      threadObject = thread;
    } else {
      threadObject = Native.Thread.open(thread, processId);
    }

    const rawHandle = threadObject.rawHandle;
    // Unregister original so CapturedThread owns the lifecycle via super()
    Native.handleRegistry.unregister(threadObject);
    super(rawHandle, threadObject.tid, true);

    this.regKey = regKey;
    this.sleepAddress = sleepAddress;
  }

  /** Calculates a new stack pointer offset from the current RSP */
  calcStackBegin(baseRsp: bigint = BigInt(this.getContext().Rsp)): bigint {
    return Native.stackAlign16(baseRsp + STACK_ADD);
  }

  /** Gets the value of the pivot register */
  getTargetReg(): Native.UINT64 {
    return this.getContext()[this.regKey];
  }

  /** Sets the value of the pivot register */
  setTargetReg(reg: Native.UINT64): void {
    const ctx = this.getContext();
    ctx[this.regKey] = reg;
    this.setContext(ctx);
  }

  /** Helper to get RSP */
  getRSP(): Native.UINT64 {
    return this.getContext().Rsp;
  }

  /** Helper to set RSP */
  setRSP(rsp: Native.UINT64): void {
    const ctx = this.getContext();
    ctx.Rsp = rsp;
    this.setContext(ctx);
  }

  /** Helper to get RIP */
  getRIP(): Native.UINT64 {
    return this.getContext().Rip;
  }

  /** Helper to set RIP */
  setRIP(rip: Native.UINT64): void {
    const ctx = this.getContext();
    ctx.Rip = rip;
    this.setContext(ctx);
  }

  /** Returns the last fetched/modified context cache */
  override getContext(): Native.ThreadContext {
    if (!this.latestContext) {
      this.fetchContext();
    }
    return this.latestContext;
  }

  /** Updates the context cache (does not apply to hardware yet) */
  override setContext(ctx: Native.ThreadContext): void {
    this.latestContext = ctx;
  }

  /** Explicitly fetches context from the hardware into the cache */
  fetchContext(): void {
    this.latestContext = super.getContext();
  }

  /** Explicitly applies the cached context to the hardware */
  applyContext(): void {
    super.setContext(this.latestContext);
  }

  /** Suspends the thread and increments internal counter */
  override suspend(): number {
    const result = super.suspend();
    if (result) {
      this.suspendCount++;
    }
    return result;
  }

  /** Resumes the thread and decrements internal counter */
  override resume(): number {
    const result = super.resume();
    if (result) {
      this.suspendCount--;
    }
    return result;
  }

  /** Restores the saved context and resumes the thread (without closing the handle) */
  release(): void {
    this.suspend();
    this.setContext(this.savedContext);
    this.applyContext();
    this.resume();
  }

  /** Closes the handle and ensures the thread is resumed if it was suspended by us */
  override close() {
    try {
      this.release();
    } catch {
      // Thread may already be dead (e.g. ExitThread was called) — ignore
    }
    for (let i = 0; i < this.suspendCount; i++) {
      try {
        super.resume();
      } catch {
        break;
      }
    }
    this.suspendCount = 0;
    super.close();
  }

  /**
   * Custom wait that polls the thread's RIP to see if it landed at the sleepAddress.
   * If the thread dies or crashes during wait, it returns FAILED.
   */
  override async wait(
    timeoutMs: number = Native.INFINITE,
  ): Promise<Native.WaitReturn> {
    let count = 0;

    while (count < timeoutMs) {
      try {
        this.fetchContext();
        const rip = this.getContext().Rip;
        if (BigInt(rip) === this.sleepAddress.valueOf()) {
          return Native.WaitReturn.OBJECT_0;
        }
      } catch (_) {
        const res = await super.wait(0);
        if (res === Native.WaitReturn.OBJECT_0) {
          return Native.WaitReturn.FAILED;
        }
        return res;
      }

      await new Promise((resolve) => setTimeout(resolve, 1));
      count++;
    }

    return Native.WaitReturn.TIMEOUT;
  }
}
