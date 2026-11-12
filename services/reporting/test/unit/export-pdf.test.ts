// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The PDF writer's streamed layout: spill passes, page order, page texts, bounded lookahead and spill removal. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportTableStream } from '../../src/domain/sources.js';
import { renderPdf } from '../../src/domain/writers/pdf.js';
import type { ExportDefinitionRow, ExportJobRow } from '../../src/repo/tables.js';

/** Lines each spill's line readings yielded, per reading, and a failure to raise in one reading. */
const spills = vi.hoisted(() => ({
  readings: [] as number[][],
  fail: undefined as { reading: number; after: number; error: Error } | undefined,
}));

vi.mock('../../src/domain/writers/spill.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/domain/writers/spill.js')>();
  return {
    ...actual,
    createSpill: async () => {
      const spill = await actual.createSpill();
      const readings: number[] = [];
      spills.readings.push(readings);
      return {
        ...spill,
        async *lines() {
          const reading = readings.length;
          readings.push(0);
          for await (const line of spill.lines()) {
            const { fail } = spills;
            if (fail !== undefined && fail.reading === reading && readings[reading] === fail.after) throw fail.error;
            readings[reading] = (readings[reading] ?? 0) + 1;
            yield line;
          }
        },
      };
    },
  };
});

const job = {
  job_id: '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9',
  created: new Date('2026-06-30T09:00:00.000Z'),
  started_at: new Date('2026-06-30T09:00:01.000Z'),
} as ExportJobRow;
const definition = {} as ExportDefinitionRow;

/** A table whose rows each iteration yields afresh, throwing `fail.error` in place of row `fail.after`. */
function tableOf(title: string, labels: readonly string[], rows: readonly (readonly string[])[], fail?: { after: number; error: Error }): ExportTableStream {
  return {
    title,
    columns: labels.map((label) => ({ field: label, label })),
    rows: {
      async *[Symbol.asyncIterator]() {
        for (const [i, row] of rows.entries()) {
          if (i === fail?.after) throw fail.error;
          yield await Promise.resolve(row);
        }
      },
    },
  };
}

const render = (table: ExportTableStream): ReturnType<typeof renderPdf> => renderPdf({ table, job, definition });

/** `count` two-column rows `ROW-<n>`, `value <n>`. */
function numberedRows(count: number): string[][] {
  return Array.from({ length: count }, (_, i) => [`ROW-${String(i + 1).padStart(4, '0')}`, `value ${String(i + 1)}`]);
}

const COLUMNS = Array.from({ length: 12 }, (_, c) => `c${String(c + 1)}`);
/** `count` rows of 12 unbreakable cells `r<row>c<column>:xxx…`, wide enough to split every page into column parts. */
const wideRows = (count: number): string[][] =>
  Array.from({ length: count }, (_, r) => COLUMNS.map((column) => `r${String(r + 1)}${column}:${'x'.repeat(28)}`));

const STANDARD_FONT_DATA_URL = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts/');

/** Each page's text items as pdfjs-dist extracts them, with each item's font size. */
async function pdfItems(bytes: Buffer): Promise<{ str: string; size: number }[][]> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl: STANDARD_FONT_DATA_URL });
  try {
    const doc = await task.promise;
    const pages: { str: string; size: number }[][] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(content.items.flatMap((item) => ('str' in item ? [{ str: item.str, size: Number(item.transform[0]) }] : [])));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** PDF text per page as the golden normaliser extracts it: text items joined with spaces, whitespace collapsed and trimmed. */
async function pdfPages(bytes: Buffer): Promise<string[]> {
  return (await pdfItems(bytes)).map((items) => items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim());
}

/** Each page of a wide table as `title`, or L/R for its left or right column part and the ordinal of its row range. */
function partOrder(pages: string[]): string[] {
  const parts = pages.map((text) => {
    const cells = [...text.matchAll(/r(\d+)c(\d+):/g)].map(([, row, column]) => [Number(row), Number(column)] as const);
    if (cells.length === 0) return undefined;
    const rows = cells.map(([row]) => row);
    return { side: Math.min(...cells.map(([, column]) => column)) === 1 ? 'L' : 'R', rows: `${String(Math.min(...rows))}-${String(Math.max(...rows))}` };
  });
  const ranges = [...new Set(parts.flatMap((part) => (part === undefined ? [] : [part.rows])))].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return parts.map((part) => (part === undefined ? 'title' : `${part.side}${String(ranges.indexOf(part.rows) + 1)}`));
}

/** The first chunk of a paused `body`, once its buffer has stopped filling. */
async function firstChunk(body: Readable): Promise<unknown> {
  const chunk: unknown = await new Promise((resolve) => body.once('readable', () => resolve(body.read())));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return chunk;
}

/** Resolves once `body` closes, errored or not. */
function closeOf(body: Readable): Promise<void> {
  return new Promise((resolve) => body.once('close', () => resolve()));
}

let parent: string;
let previous: string | undefined;

// A private temporary directory, so only this test's spill can show there.
beforeEach(async () => {
  spills.readings.length = 0;
  spills.fail = undefined;
  parent = await mkdtemp(join(tmpdir(), 'export-pdf-test-'));
  previous = process.env.TMPDIR;
  process.env.TMPDIR = parent;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previous;
  await rm(parent, { recursive: true, force: true });
});

describe('renderPdf layout passes', () => {
  it.each([
    { name: 'once, at the default zoom', table: tableOf('Default', ['code', 'label'], numberedRows(50)), readings: [51], sizes: [13, 26] },
    {
      name: 'once, at a print zoom whose font size is the default',
      table: tableOf('T', ['w'], [['m'.repeat(38) + '.'.repeat(6)], ...numberedRows(60)]),
      readings: [62],
      sizes: [13, 26],
    },
    { name: 'twice, at a print zoom with a smaller font', table: tableOf('Split', COLUMNS, wideRows(40)), readings: [41, 41], sizes: [4, 8] },
  ])('reads the spilled rows $name', async ({ table, readings, sizes }) => {
    const bytes = await buffer((await render(table)).body);
    expect(spills.readings).toEqual([readings]);
    const drawn = new Set((await pdfItems(bytes)).flat().map((item) => item.size));
    expect([...drawn].sort((a, b) => a - b)).toEqual(sizes);
  });
});

describe('renderPdf pages', () => {
  it('draws a 76-page table 36 rows on the first page, then 40 a page, with the header row on the first only', async () => {
    const rows = numberedRows(3_000);
    const text = (from: number, to: number): string => rows.slice(from, to).map((row) => row.join(' ')).join(' ');
    const expected = [`Long c o d e l a b e l ${text(0, 36)}`];
    for (let from = 36; from < rows.length; from += 40) expected.push(text(from, from + 40));
    expect(expected).toHaveLength(76);
    expect(await pdfPages(await buffer((await render(tableOf('Long', ['code', 'label'], rows))).body))).toEqual(expected);
  });

  it.each([
    { name: 'left then right part of each page', title: 'Wide', order: ['L1', 'R1', 'L2', 'R2'] },
    {
      name: 'each right part before its left one, after one title page',
      title: 'Heading '.repeat(1_500),
      order: ['title', 'R1', 'L1', 'R2', 'L2', 'R3', 'L3'],
    },
    {
      name: 'each left part after the next page’s right part, after two title pages',
      title: 'Heading '.repeat(3_000),
      order: ['title', 'R1', 'title', 'R2', 'L1', 'R3', 'L2', 'L3'],
    },
  ])('orders a wide table as $name', async ({ title, order }) => {
    const pages = await pdfPages(await buffer((await render(tableOf(title, COLUMNS, wideRows(200)))).body));
    const parts = partOrder(pages);
    expect(parts).toEqual(order);
    for (const side of ['L', 'R']) {
      const rows = pages.filter((_, i) => parts[i]?.startsWith(side)).flatMap((text) => [...text.matchAll(/r(\d+)c\d+:/g)].map(([, row]) => Number(row)));
      expect(new Set(rows).size).toBe(200);
    }
  });
});

describe('renderPdf spill', () => {
  it('lays out only the rows of the pages painted so far, then every row by the end of the body', async () => {
    const { body } = await render(tableOf('Long', ['code', 'label'], numberedRows(12_000)));
    const first = (await firstChunk(body)) as Buffer;
    const laidOut = spills.readings[0]?.[0] ?? 0;
    const emitted = Buffer.concat([first, (body.read() as Buffer | null) ?? Buffer.alloc(0)]).toString('latin1');
    // pdfkit writes a page's dictionary once the next page is added, so one page more than it wrote is painted.
    const painted = (emitted.match(/\/Type \/Page\n/g) ?? []).length + 1;
    const spilledThrough = (pages: number): number => 1 + 36 + 40 * (pages - 1);
    expect(painted).toBeLessThan(76);
    expect(laidOut).toBeGreaterThan(spilledThrough(painted - 1));
    expect(laidOut).toBeLessThanOrEqual(spilledThrough(painted) + 40);
    await buffer(body);
    expect(spills.readings).toEqual([[12_001]]);
  });

  it('keeps its spill while the body is open and removes it once the body ends', async () => {
    const { body } = await render(tableOf('Long', ['code', 'label'], numberedRows(500)));
    const closed = closeOf(body);
    expect(await readdir(parent)).toEqual([expect.stringMatching(/^reporting-export-/) as string]);
    await buffer(body);
    await closed;
    expect(await readdir(parent)).toEqual([]);
  });

  it('removes its spill and fails with the very error a row read raises', async () => {
    const error = new Error('page 2 unreadable');
    await expect(render(tableOf('t', ['code', 'label'], numberedRows(100), { after: 40, error }))).rejects.toBe(error);
    expect(spills.readings).toEqual([[]]);
    expect(await readdir(parent)).toEqual([]);
  });

  it('removes its spill and destroys the body with the very error a spill read raises', async () => {
    const error = new Error('spill unreadable');
    spills.fail = { reading: 0, after: 200, error };
    const { body } = await render(tableOf('Long', ['code', 'label'], numberedRows(5_000)));
    const closed = closeOf(body);
    await expect(buffer(body)).rejects.toBe(error);
    await closed;
    expect(await readdir(parent)).toEqual([]);
  });

  it('stops laying out and removes its spill when the consumer destroys the body', async () => {
    const { body } = await render(tableOf('Long', ['code', 'label'], numberedRows(12_000)));
    const closed = closeOf(body);
    await firstChunk(body);
    const [laidOut] = spills.readings[0] ?? [];
    expect(await readdir(parent)).toHaveLength(1);
    body.destroy();
    await closed;
    expect(await readdir(parent)).toEqual([]);
    expect(spills.readings[0]?.[0]).toBe(laidOut);
  });
});
