// Temporary disk spool of one file-store object, so its bytes pass from the bridge to an owner without being held in memory.
import { once } from 'node:events';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

const SPOOL_PREFIX = 'opt2-file-spool-';
const SPOOL_FILE = 'object';

/** One spool file: `writer` creates it for a single download, `reader` reads back what was written. */
export interface Spool {
  writer(): Promise<Writable>;
  reader(): Promise<Readable>;
}

/** Destroys `stream` unless it has already closed, and waits until its file is closed. */
async function closeStream(stream: Readable | Writable): Promise<void> {
  if (stream.closed) return;
  const closed = once(stream, 'close');
  stream.destroy();
  // The stream's own failure has already reached its consumer; only the release of the descriptor is awaited here.
  await closed.catch(() => undefined);
}

/**
 * Runs `use` over a fresh spool file in its own directory under the OS temporary directory, then closes every stream it
 * opened and removes the directory, whatever the outcome.
 */
export async function withSpool<T>(use: (spool: Spool) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), SPOOL_PREFIX));
  const path = join(dir, SPOOL_FILE);
  const streams: (Readable | Writable)[] = [];
  const opened = <S extends Readable | Writable>(stream: S): S => {
    streams.push(stream);
    return stream;
  };
  try {
    return await use({
      writer: async () => opened((await open(path, 'wx')).createWriteStream()),
      reader: async () => opened((await open(path, 'r')).createReadStream()),
    });
  } finally {
    await Promise.all(streams.map(closeStream));
    await rm(dir, { recursive: true, force: true });
  }
}
