import * as Native from '@cheatron/native';
import { log } from './logger.js';

/**
 * Kernel32Functions: function pointers resolved from kernel32.dll in the
 * target process. Used for remote calls through a hijacked thread.
 */
export interface Kernel32Functions {
  LoadLibraryA: Native.NativePointer;
  LoadLibraryW: Native.NativePointer;
  ReadProcessMemory: Native.NativePointer;
  WriteProcessMemory: Native.NativePointer;
  GetCurrentProcess: Native.NativePointer;
  GetModuleHandleA: Native.NativePointer;
  GetModuleHandleW: Native.NativePointer;
  GetModuleHandleExA: Native.NativePointer;
  GetModuleHandleExW: Native.NativePointer;
}

const get = (name: string): Native.NativePointer => {
  const addr = Native.Module.kernel32.getProcAddress(name);
  log.debug('Kernel32', `Resolved ${name}: ${addr}`);
  return addr;
};

export const kernel32: Kernel32Functions = {
  LoadLibraryA: get('LoadLibraryA'),
  LoadLibraryW: get('LoadLibraryW'),
  ReadProcessMemory: get('ReadProcessMemory'),
  WriteProcessMemory: get('WriteProcessMemory'),
  GetCurrentProcess: get('GetCurrentProcess'),
  GetModuleHandleA: get('GetModuleHandleA'),
  GetModuleHandleW: get('GetModuleHandleW'),
  GetModuleHandleExA: get('GetModuleHandleExA'),
  GetModuleHandleExW: get('GetModuleHandleExW'),
};
