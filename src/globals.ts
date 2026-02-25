import * as Native from '@cheatron/native';
import { log } from './logger.js';
import { KeystoneX86 } from '@cheatron/keystone';

const globalsLog = log.child('Globals');

/**
 * GeneralPurposeRegs: Supported 64-bit general purpose registers for x64 hijacking.
 */
export type GeneralPurposeRegs = Extract<
  keyof Native.ThreadContext,
  | 'Rax'
  | 'Rcx'
  | 'Rdx'
  | 'Rbx'
  | 'Rsp'
  | 'Rbp'
  | 'Rsi'
  | 'Rdi'
  | 'R8'
  | 'R9'
  | 'R10'
  | 'R11'
  | 'R12'
  | 'R13'
  | 'R14'
  | 'R15'
>;

/**
 * Register priority sequence for hijacking.
 * We prefer registers that are traditionally "callee-saved" or less likely to be
 * actively holding critical data during a random suspension point.
 */
export const leastClobberedRegs: GeneralPurposeRegs[] = [
  'Rbx',
  'Rbp',
  'Rdi',
  'Rsi', // Non-Volatile (stable frame pointers/iterators)
  // "R12" - "R15" are also non-volatile but less common in simple gadgets
];

/** Internal pool of discovered 'jmp .' addresses */
const sleepAddresses: Native.NativePointer[] = [];

/** Internal mapping of discovered 'push reg; ret' addresses to their respective registers */
const pushretAddresses = new Map<
  bigint,
  { pointer: Native.NativePointer; regKey: GeneralPurposeRegs }
>();

/**
 * Manually registers a sleep address (gadget) into the global pool.
 * @param address The NativePointer to the 'jmp .' instruction.
 */
export function registerSleepAddress(address: Native.NativePointer): void {
  sleepAddresses.push(address);
  globalsLog.debug(`Registered sleepAddress: ${address}`);
}

/**
 * Retrieves a random sleep address from the pool.
 * If the pool is empty, it triggers auto-discovery.
 */
export function getRandomSleepAddress(): Native.NativePointer | undefined {
  if (sleepAddresses.length === 0) {
    autoDiscoverAddresses();
  }

  if (sleepAddresses.length === 0) return undefined;

  const randomIndex = Math.floor(Math.random() * sleepAddresses.length);
  return sleepAddresses[randomIndex];
}

/**
 * Manually registers a pushret address (gadget) into the global pool.
 * @param address The NativePointer to the 'push reg; ret' sequence.
 * @param regKey The register used in the 'push' instruction.
 */
export function registerPushretAddress(
  address: Native.NativePointer,
  regKey: GeneralPurposeRegs,
): void {
  pushretAddresses.set(address.address, { pointer: address, regKey });
  globalsLog.debug(`Registered pushretAddress: ${address} (RegKey: ${regKey})`);
}

/**
 * Retrieves a random pushret address from the pool, prioritized by stability.
 * @param regKey Optional filter to find a gadget for a specific register.
 * @returns An object containing the pointer and the register it targets.
 *
 * Logic:
 * 1. If regKey is specified, search only for that register.
 * 2. If no regKey is specified, search through `leastClobberedRegs` in order
 *    and return the first available gadget type found.
 */
export function getRandomPushretAddress(
  regKey?: GeneralPurposeRegs,
): { address: Native.NativePointer; regKey: GeneralPurposeRegs } | undefined {
  if (pushretAddresses.size === 0) {
    autoDiscoverAddresses();
  }

  if (pushretAddresses.size === 0) return undefined;

  let validEntries = Array.from(pushretAddresses.values());

  if (regKey) {
    validEntries = validEntries.filter((e) => e.regKey === regKey);
  } else {
    // Step through priority list to find the "best" available gadget class
    for (const bestReg of leastClobberedRegs) {
      const bestEntries = validEntries.filter((e) => e.regKey === bestReg);
      if (bestEntries.length > 0) {
        validEntries = bestEntries;
        break;
      }
    }
  }

  if (validEntries.length === 0) return undefined;

  const randomIndex = Math.floor(Math.random() * validEntries.length);
  const selected = validEntries[randomIndex];

  if (!selected) return undefined;

  return { address: selected.pointer, regKey: selected.regKey };
}

/** Flag to prevent redundant heavy scans */
let isAutoDiscovered = false;

/**
 * Scans all loaded modules in the current process for useful hijacking gadgets.
 * Uses Keystone to assemble the target instructions on-the-fly to ensure
 * architecture-perfect pattern matching.
 */
export function autoDiscoverAddresses() {
  if (isAutoDiscovered) return;

  globalsLog.info(
    'Starting auto-discovery of global execution addresses via pattern scanning...',
  );

  // Search only in executable memory (RX or RWX)
  const protect =
    Native.MemoryProtection.EXECUTE_READ |
    Native.MemoryProtection.EXECUTE_READWRITE;

  const assembler = new KeystoneX86();

  // 1. Scan for Sleep Gadgets ('jmp .')
  const sleepCode = assembler.asm('jmp .');
  const sleepPattern = new Native.Pattern(sleepCode)
    .noLimit()
    .addProtect(protect);

  const sleepRes = Native.Module.scan(sleepPattern);
  for (const match of sleepRes.all()) {
    registerSleepAddress(match.pointer);
  }

  // 2. Scan for PushRet Gadgets ('push reg; ret')
  const retCode = assembler.asm('ret');

  for (const regKey of leastClobberedRegs) {
    // Compile 'push rax' etc.
    const pushCode = assembler.asm('push ' + regKey.toString().toLowerCase());

    // Pattern = [Push opcode(s)] + [Ret opcode]
    const pushretCode = [...pushCode, ...retCode];
    const pushretPattern = new Native.Pattern(pushretCode)
      .noLimit()
      .addProtect(protect);

    // Perform process-wide cross-module scan
    const pushretRes = Native.Module.scan(pushretPattern);
    for (const match of pushretRes.all()) {
      registerPushretAddress(match.pointer, regKey);
    }
  }

  isAutoDiscovered = true;
  globalsLog.info(
    `Auto-discovery complete. Found ${sleepAddresses.length} sleep gadgets and ${pushretAddresses.size} pushret gadgets.`,
  );
}
