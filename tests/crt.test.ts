import { expect, test, describe } from 'bun:test';
import { crtFunctions } from '../src';

describe('CRT Initialization', () => {
  test('should automatically resolve CRT functions on import', async () => {
    expect(crtFunctions).not.toBeNull();

    // Check required functions
    expect(crtFunctions.fopen).toBeDefined();
    expect(crtFunctions.memset).toBeDefined();
    expect(crtFunctions.malloc).toBeDefined();
    expect(crtFunctions.fwrite).toBeDefined();
    expect(crtFunctions.fflush).toBeDefined();
    expect(crtFunctions.fclose).toBeDefined();
    expect(crtFunctions.fread).toBeDefined();
    expect(crtFunctions.free).toBeDefined();
    expect(crtFunctions.strlen).toBeDefined();
    expect(crtFunctions.wcslen).toBeDefined();

    // Basic check that they are addresses
    // In some environments/koffi versions these might be bigints, numbers, or objects (Buffers/Pointers)
    const type = typeof crtFunctions.fopen;
    expect(['bigint', 'object', 'number']).toContain(type);

    if (type === 'bigint') {
      expect(crtFunctions.fopen).not.toBe(0n);
    }
  });
});
