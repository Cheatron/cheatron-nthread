import { expect, test, describe } from 'bun:test';
import { crt } from '../src';

describe('CRT Initialization', () => {
  test('should automatically resolve CRT functions on import', async () => {
    expect(crt).not.toBeNull();

    // Check required functions
    expect(crt.fopen).toBeDefined();
    expect(crt.memset).toBeDefined();
    expect(crt.malloc).toBeDefined();
    expect(crt.fwrite).toBeDefined();
    expect(crt.fflush).toBeDefined();
    expect(crt.fclose).toBeDefined();
    expect(crt.fread).toBeDefined();
    expect(crt.free).toBeDefined();

    // Basic check that they are addresses
    // In some environments/koffi versions these might be bigints, numbers, or objects (Buffers/Pointers)
    const type = typeof crt.fopen;
    expect(['bigint', 'object', 'number']).toContain(type);

    if (type === 'bigint') {
      expect(crt.fopen).not.toBe(0n);
    }
  });
});
