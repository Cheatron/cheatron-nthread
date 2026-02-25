import * as Native from '@cheatron/native';
import { log } from './logger.js';

/**
 * CRTFunctions: A collection of standard C Runtime functions resolved in the target process.
 * These are essential for performing standard operations like memory allocation (malloc/free)
 * and file I/O (fopen/fwrite) from native code within the hijacked thread.
 */
export interface CRTFunctions {
  fopen: Native.NativePointer;
  memset: Native.NativePointer;
  malloc: Native.NativePointer;
  calloc: Native.NativePointer;
  realloc: Native.NativePointer;
  fwrite: Native.NativePointer;
  fflush: Native.NativePointer;
  fclose: Native.NativePointer;
  fread: Native.NativePointer;
  free: Native.NativePointer;
}

/**
 * Internal helper to resolve a function by name from the static `msvcrt.dll` module.
 * This assumes `msvcrt.dll` is already loaded in the target process (common for Win32 apps).
 */
const get = (name: string): Native.NativePointer => {
  const addr = Native.Module.crt.getProcAddress(name);
  log.debug('CRT', `Resolved ${name}: ${addr}`);
  return addr;
};

/**
 * Global CRT function pointers.
 * These are initialized lazily or on import to be used globally by other components.
 */
export const crt: CRTFunctions = {
  fopen: get('fopen'),
  memset: get('memset'),
  malloc: get('malloc'),
  calloc: get('calloc'),
  realloc: get('realloc'),
  fwrite: get('fwrite'),
  fflush: get('fflush'),
  fclose: get('fclose'),
  fread: get('fread'),
  free: get('free'),
};
