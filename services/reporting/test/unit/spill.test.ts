// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The writers' spill file: appended text read back whole and by line, repeatedly, then removed. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSpill } from '../../src/domain/writers/spill.js';

let parent: string;
let previous: string | undefined;

// A private temporary directory, so spills that other suites and processes create never show here.
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'spill-test-'));
  previous = process.env.TMPDIR;
  process.env.TMPDIR = parent;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previous;
  await rm(parent, { recursive: true, force: true });
});

/** The lines `lines` yields. */
async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const read: string[] = [];
  for await (const line of lines) read.push(line);
  return read;
}

describe('createSpill', () => {
  it('reads back what it was written, whole and by line, as often as asked', async () => {
    const spill = await createSpill();
    try {
      const rows = [JSON.stringify(['a\r\nb', null, 'é\u2028']), JSON.stringify([]), JSON.stringify(['\ud800'])];
      for (const row of rows) await spill.write(`${row}\n`);
      await spill.end();
      expect(await text(spill.open())).toBe(rows.map((row) => `${row}\n`).join(''));
      expect(await collect(spill.lines())).toStrictEqual(rows);
      expect(await collect(spill.lines())).toStrictEqual(rows);
    } finally {
      await spill.dispose();
    }
  });

  it('waits for the file while it is full and keeps every byte', async () => {
    const spill = await createSpill();
    try {
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 64; i++) await spill.write(`${chunk}\n`);
      await spill.end();
      const lines = await collect(spill.lines());
      expect(lines).toHaveLength(64);
      expect(lines.every((line) => line === chunk)).toBe(true);
    } finally {
      await spill.dispose();
    }
  });

  it('appends without waiting and drains on request', async () => {
    const spill = await createSpill();
    try {
      const chunk = 'y'.repeat(32 * 1024);
      for (let i = 0; i < 8; i++) spill.append(`${chunk}\n`);
      await spill.drain();
      await spill.drain();
      await spill.end();
      expect(await collect(spill.lines())).toStrictEqual(new Array<string>(8).fill(chunk));
    } finally {
      await spill.dispose();
    }
  });

  it('closes the file when line iteration stops early', async () => {
    const spill = await createSpill();
    try {
      for (let i = 0; i < 1000; i++) await spill.write(`${i}\n`);
      await spill.end();
      for await (const line of spill.lines()) {
        expect(line).toBe('0');
        break;
      }
      expect((await collect(spill.lines())).at(-1)).toBe('999');
    } finally {
      await spill.dispose();
    }
  });

  it('removes its directory once, and refuses writes after disposal', async () => {
    const spill = await createSpill();
    const created = await readdir(parent);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^reporting-export-/);
    await spill.write('row\n');
    await Promise.all([spill.dispose(), spill.dispose()]);
    expect(await readdir(parent)).toStrictEqual([]);
    await expect(spill.write('late\n')).rejects.toThrow('spill file is disposed');
    expect(() => spill.append('late\n')).toThrow('spill file is disposed');
    await expect(spill.drain()).rejects.toThrow('spill file is disposed');
    await expect(spill.end()).rejects.toThrow('spill file is disposed');
  });

  it('rejects a write waiting on a full file once disposed', async () => {
    const spill = await createSpill();
    const waiting = expect(spill.write('x'.repeat(1024 * 1024))).rejects.toThrow('spill file is disposed');
    await spill.dispose();
    await waiting;
  });

  it('refuses writes once ended', async () => {
    const spill = await createSpill();
    try {
      await spill.end();
      await expect(spill.write('after end\n')).rejects.toThrow('spill file is ended');
      await expect(spill.end()).rejects.toThrow('spill file is ended');
    } finally {
      await spill.dispose();
    }
  });
});
