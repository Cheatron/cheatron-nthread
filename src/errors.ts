// ── Base ──────────────────────────────────────────────────────────────────────

abstract class BaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

// ── NThread errors ────────────────────────────────────────────────────────────

export class NThreadError extends BaseError {}

export class NoSleepAddressError extends NThreadError {
  constructor() {
    super('No valid sleep address could be found or auto-discovered');
  }
}

export class NoPushretAddressError extends NThreadError {
  constructor() {
    super('No valid pushret gadget could be found or auto-discovered');
  }
}

export class InjectError extends NThreadError {}

export class InjectTimeoutError extends InjectError {
  constructor(public readonly waitResult: number) {
    super(`Thread did not reach sleep address (wait result: ${waitResult})`);
  }
}

export class MsvcrtNotLoadedError extends InjectError {
  constructor() {
    super("msvcrt.dll is not loaded in the target thread's process");
  }
}

// ── Call errors ───────────────────────────────────────────────────────────────

export class CallError extends NThreadError {
  public readonly target: bigint;

  constructor(message: string, target: bigint) {
    super(message);
    this.target = target;
  }
}

export class CallNotInjectedError extends CallError {
  constructor() {
    super('Thread not injected. Call inject() first.', 0n);
  }
}

export class CallTooManyArgsError extends CallError {
  public readonly argCount: number;

  constructor(argCount: number) {
    super(
      `x64 calling convention supports max 4 register arguments (RCX, RDX, R8, R9), got ${argCount}`,
      0n,
    );
    this.argCount = argCount;
  }
}

export class CallRipMismatchError extends CallError {
  public readonly currentRip: bigint;
  public readonly expectedRip: bigint;

  constructor(target: bigint, currentRip: bigint, expectedRip: bigint) {
    super(
      `Thread RIP (0x${currentRip.toString(16)}) is not at sleep address (0x${expectedRip.toString(16)})`,
      target,
    );
    this.currentRip = currentRip;
    this.expectedRip = expectedRip;
  }
}

export class CallTimeoutError extends CallError {
  public readonly waitResult: number;

  constructor(target: bigint, waitResult: number) {
    super(
      `Thread did not return to sleep address (wait result: ${waitResult})`,
      target,
    );
    this.waitResult = waitResult;
  }
}

export class CallThreadDiedError extends CallError {
  constructor(target: bigint) {
    super(
      'Thread died during call (e.g. ExitThread / noreturn function)',
      target,
    );
  }
}

// ── Write errors ─────────────────────────────────────────────────────────────────

export class WriteError extends NThreadError {}

export class WriteSizeRequiredError extends WriteError {
  constructor() {
    super('Size must be specified when writing from a NativePointer source');
  }
}

// ── Alloc errors ─────────────────────────────────────────────────────────────

export class AllocError extends NThreadError {}

export class ReallocNullError extends AllocError {
  public readonly address: bigint;
  public readonly size: number;

  constructor(address: bigint, size: number) {
    super(`realloc(0x${address.toString(16)}, ${size}) returned NULL`);
    this.address = address;
    this.size = size;
  }
}

// ── File I/O errors ───────────────────────────────────────────────────────────

export class FileError extends NThreadError {}

// ── Gadget errors ─────────────────────────────────────────────────────────────

export class GadgetError extends NThreadError {}

export class GadgetScanError extends GadgetError {
  public readonly pattern: string;

  constructor(pattern: string) {
    super(`Failed to scan for gadget pattern: ${pattern}`);
    this.pattern = pattern;
  }
}
