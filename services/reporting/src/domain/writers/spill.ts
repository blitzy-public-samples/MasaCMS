// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Temporary file a writer spills text to while it reads its rows, then reads back as often as its layout needs. */
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const DIRECTORY_PREFIX = 'reporting-export-';
const FILE_NAME = 'spill';

/** A spill file: appended to until `end`, then read from the start any number of times until `dispose`. */
export interface Spill {
  /** Appends `text` without waiting; throws once ended or disposed, or with an earlier write error. */
  append(text: string): void;
  /** Resolves once the file accepts more; rejects with its write error, or once ended or disposed. */
  drain(): Promise<void>;
  /** Appends `text`, then waits as `drain` does. */
  write(text: string): Promise<void>;
  /** Flushes and closes the file for reading. */
  end(): Promise<void>;
  /** The file's bytes from the start. */
  open(): Readable;
  /** The file's lines from the start, each without its line break; the file closes when iteration stops. */
  lines(): AsyncGenerator<string>;
  /** Closes and removes the file; later calls do nothing. */
  dispose(): Promise<void>;
}

/** Resolves once `out` drains or closes. */
function drainedOrClosed(out: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (out.destroyed) {
      resolve();
      return;
    }
    const done = (): void => {
      out.off('drain', done);
      out.off('close', done);
      resolve();
    };
    out.on('drain', done);
    out.on('close', done);
  });
}

/** Creates an empty spill file in its own directory under the OS temporary directory. */
export async function createSpill(): Promise<Spill> {
  const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
  const path = join(directory, FILE_NAME);
  const out = createWriteStream(path);
  let failure: Error | undefined;
  // Kept rather than thrown by the stream: the next append, drain or end throws it.
  out.on('error', (err: Error) => {
    failure ??= err;
  });
  let disposed: Promise<void> | undefined;

  /** Throws that the spill is disposed, the file's write error, or that the spill is already ended. */
  function check(): void {
    if (disposed !== undefined) throw new Error('spill file is disposed');
    if (failure !== undefined) throw failure;
    if (out.writableEnded) throw new Error('spill file is ended');
  }

  function append(text: string): void {
    check();
    out.write(text);
  }

  async function drain(): Promise<void> {
    check();
    if (!out.writableNeedDrain) return;
    await drainedOrClosed(out);
    check();
  }

  return {
    append,
    drain,
    async write(text) {
      append(text);
      await drain();
    },
    async end() {
      check();
      out.end();
      await finished(out);
    },
    open() {
      return createReadStream(path);
    },
    async *lines() {
      const input = createReadStream(path);
      const reader = createInterface({ input, crlfDelay: Infinity });
      try {
        yield* reader;
      } finally {
        reader.close();
        input.destroy();
      }
    },
    dispose() {
      disposed ??= (async () => {
        out.destroy();
        await rm(directory, { recursive: true, force: true });
      })();
      return disposed;
    },
  };
}
