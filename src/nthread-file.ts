import * as Native from '@cheatron/native';
import { NThreadHeap } from './nthread-heap';
import type { CapturedThread } from './thread/captured-thread';
import type { ProxyThread } from './thread/proxy-thread';
import type { GeneralPurposeRegs } from './globals';
import { log } from './logger';
import { FileError } from './errors';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const fileLog = log.child('File');

/** SEEK_SET constant for fseek — seek from beginning of file. */
const SEEK_SET = 0;

/** Per-proxy file channel state. */
interface FileChannelState {
  /** Local temp file path used as the bidirectional I/O channel. */
  filePath: string;
  /** `FILE*` handle kept open in the target process (`"w+b"` mode). */
  stream: Native.NativePointer;
}

/**
 * Default maximum bytes transferred before rotating temp file paths.
 * Reserved for future path-rotation support.
 */
export const DEFAULT_FILE_MAX_TRANSFER = 1024 * 1024; // 1 MiB

/**
 * NThreadFile extends {@link NThreadHeap} with filesystem-based I/O channels.
 *
 * Instead of `ReadProcessMemory` / `WriteProcessMemory` (or the base class's
 * decomposed `memset` write strategy), all data flows through a single temp file:
 *
 * - **Write channel** (attacker → target): attacker writes to temp file locally,
 *   then `fseek(0)` + `fread` in the target reads it into the destination address.
 * - **Read channel** (target → attacker): `fseek(0)` + `fwrite` + `fflush` in
 *   the target dumps memory to the file, then attacker reads it locally.
 *
 * The file is opened once during `inject()` with `"w+b"` mode (read+write) and
 * kept open for the lifetime of the proxy. `fseek(0, SEEK_SET)` resets the
 * stream position before each operation.
 *
 * ### When to prefer NThreadFile
 * - Large bulk transfers: one `fread`/`fwrite` call vs many `memset` calls
 * - Stealth: avoids RPM/WPM API calls entirely
 *
 * ### Lifecycle
 * - `inject()` opens a single temp file and configures the proxy delegates.
 * - `proxy.write()` / `proxy.read()` transparently route through the file channel.
 * - `proxy.close()` closes the stream, deletes the temp file, restores the thread.
 *
 * @example
 * ```typescript
 * const nt = new NThreadFile();
 * const [proxy] = await nt.inject(tid);
 *
 * const ptr = await proxy.alloc(256, { fill: 0 });
 * await proxy.write(ptr, myBuffer);       // goes through file channel
 * const data = await proxy.read(ptr);     // goes through file channel
 *
 * await proxy.close(); // closes stream, deletes temp file, destroys heaps, restores thread
 * ```
 */
export class NThreadFile extends NThreadHeap {
  constructor(
    heapSize?: number,
    maxSize?: number,
    processId?: number,
    sleepAddress?: Native.NativePointer,
    pushretAddress?: Native.NativePointer,
    regKey?: GeneralPurposeRegs,
  ) {
    super(heapSize, maxSize, processId, sleepAddress, pushretAddress, regKey);
  }

  // ---------------------------------------------------------------------------
  // setupProxy override
  // ---------------------------------------------------------------------------

  protected override async setupProxy(
    captured: CapturedThread,
  ): Promise<[ProxyThread, CapturedThread]> {
    const [proxy, cap] = await super.setupProxy(captured);

    // Generate a unique temp path
    const id = randomBytes(8).toString('hex');
    const filePath = join(tmpdir(), `nt_${id}`);

    // Open the file in the target with read+write mode (kept open for the
    // proxy's lifetime); fileOpen handles remote string alloc/free internally.
    const stream = await this.fileOpen(proxy, filePath, 'w+b');
    if (stream.address === 0n) {
      throw new FileError(`fopen("${filePath}", "w+b") returned NULL`);
    }

    const state: FileChannelState = { filePath, stream };

    // Replace writer: file-based attacker→target channel
    proxy.setWriter((_proxy, address, data) =>
      this.fileChannelWrite(_proxy, state, address, data),
    );

    // Replace reader: file-based target→attacker channel
    proxy.setReader((_proxy, address) =>
      this.fileChannelRead(_proxy, state, address),
    );

    // Replace closer: clean up file channel, then delegate to base
    proxy.setCloser((_proxy, suicide?) =>
      this.fileChannelClose(_proxy, state, cap, suicide),
    );

    fileLog.info(`File channel established: ${filePath}`);

    return [proxy, cap];
  }

  // ---------------------------------------------------------------------------
  // File Channel I/O
  // ---------------------------------------------------------------------------

  /**
   * Closes the file channel: closes the `FILE*` stream in the target, deletes
   * the temp file, then delegates to the base `threadClose` for heap destruction
   * and thread restore.
   */
  protected async fileChannelClose(
    proxy: ProxyThread,
    state: FileChannelState,
    captured: CapturedThread,
    suicide?: number,
  ): Promise<void> {
    // Close the FILE* stream (thread is still alive at this point;
    // termination happens in the base threadClose call below).
    await proxy.fclose(state.stream.address);

    // Delete temp file (best-effort)
    try {
      unlinkSync(state.filePath);
    } catch {
      /* file may not exist */
    }

    // Heap destruction + thread restore
    await this.threadClose(proxy, captured, suicide);
  }

  /**
   * Writes data to the target process through the filesystem channel.
   *
   * 1. Writes `data` to the local temp file (truncates).
   * 2. `fseek(stream, 0, SEEK_SET)` to reset the target's stream position.
   * 3. `fread` in the target reads from the file into the destination address.
   */
  protected async fileChannelWrite(
    proxy: ProxyThread,
    state: FileChannelState,
    address: Native.NativePointer,
    data: Buffer | Native.NativeMemory,
  ): Promise<number> {
    let buf: Buffer;
    let writeSize: number;

    if (data instanceof Native.NativeMemory) {
      buf = Native.currentProcess.memory.read(data);
      writeSize = data.size;
    } else {
      buf = data instanceof Buffer ? data : Buffer.from(data);
      writeSize = buf.length;
    }

    if (writeSize === 0) return 0;

    // 1. Write to local temp file
    writeFileSync(state.filePath, buf);

    // 2. Reset stream position in target
    await proxy.fseek(state.stream, 0n, BigInt(SEEK_SET));

    // 3. Read file contents into target address
    const result = await proxy.fread(
      address.address,
      1n,
      BigInt(writeSize),
      state.stream,
    );
    return Number(result.address);
  }

  /**
   * Reads data from the target process through the filesystem channel.
   *
   * 1. `fseek(stream, 0, SEEK_SET)` to reset the target's stream position.
   * 2. `fwrite` in the target dumps memory to the file.
   * 3. `fflush` ensures data reaches disk.
   * 4. Reads the temp file locally.
   */
  protected async fileChannelRead(
    proxy: ProxyThread,
    state: FileChannelState,
    address: Native.NativeMemory,
  ): Promise<Buffer> {
    const size = address.size;
    if (size === 0) return Buffer.alloc(0);

    // 1. Reset stream position in target
    await proxy.fseek(state.stream, 0n, BigInt(SEEK_SET));

    // 2. Write target memory to file
    await proxy.fwrite(address.address, 1n, BigInt(size), state.stream);

    // 3. Flush to disk
    await proxy.fflush(state.stream.address);

    // 4. Read the file locally
    const result = readFileSync(state.filePath);
    return result.subarray(0, size) as Buffer;
  }
}
