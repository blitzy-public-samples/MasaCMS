// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The XLSX writer's spilled shared strings: their read-back, the sharedStrings part and the removal of the spill file. */
import { watch } from 'node:fs';
import { mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportTableStream } from '../../src/domain/sources.js';
import { renderXlsx } from '../../src/domain/writers/xlsx.js';
import type { ExportDefinitionRow, ExportJobRow } from '../../src/repo/tables.js';

const job: ExportJobRow = {
  tenant_id: '7d4a9f3e-1c2b-5e6f-8a9b-0c1d2e3f4a5b',
  job_id: '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9',
  siteid: 'tenant-a',
  definition_id: '2C3D4E5F-6071-8293-A4B5C6D7E8F90A1B',
  format: 'xlsx',
  state: 'running',
  requested_by_id: '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90A',
  created: new Date('2026-06-30T09:00:00.000Z'),
  started_at: new Date('2026-06-30T09:00:01.000Z'),
  finished_at: null,
  error: null,
  file_name: null,
  content_type: null,
  object_key: null,
  output_sha256: null,
  row_version: '2',
};

const definition: ExportDefinitionRow = {
  tenant_id: job.tenant_id,
  definition_id: job.definition_id,
  siteid: job.siteid,
  name: 'Finance records',
  source: 'finance.records',
  columns: '["v"]',
};

// The strict grammar of the part the writer streams: no character outside an escape is '<', '>', '&', '"' or "'".
const SST_DOCUMENT =
  /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\n<sst xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main" count="(\d+)" uniqueCount="(\d+)">((?:<si><t(?: xml:space="preserve")?>(?:[^<>&"']|&(?:amp|lt|gt|quot|apos);)*<\/t><\/si>)*)<\/sst>$/;

/** A table whose rows `pulled` counts; `fail` throws in place of row `after`. */
function tableOf(
  labels: readonly string[],
  rows: readonly (readonly string[])[],
  fail?: { after: number; error: Error },
): ExportTableStream & { pulled: () => number } {
  let pulled = 0;
  return {
    title: 't',
    columns: labels.map((label) => ({ field: label, label })),
    rows: {
      async *[Symbol.asyncIterator]() {
        for (const [i, row] of rows.entries()) {
          if (i === fail?.after) throw fail.error;
          pulled += 1;
          yield await Promise.resolve(row);
        }
      },
    },
    pulled: () => pulled,
  };
}

/** The body of the workbook rendered from `table`. */
function bodyOf(table: ExportTableStream): PassThrough {
  return renderXlsx({ definition, table, job }).body as PassThrough;
}

/** Each sheet's rows as [value, type] pairs, as exceljs reads them back. */
async function readBack(bytes: Buffer): Promise<{ name: string; rows: [ExcelJS.CellValue, ExcelJS.ValueType][][] }[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  return workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    rows: Array.from({ length: sheet.rowCount }, (_, r) => {
      const row = sheet.getRow(r + 1);
      return Array.from({ length: row.cellCount }, (_, c): [ExcelJS.CellValue, ExcelJS.ValueType] => [row.getCell(c + 1).value, row.getCell(c + 1).type]);
    }),
  }));
}

/** The text of zip entry `name`, found through the archive's central directory, or undefined when it has none. */
function zipText(bytes: Buffer, name: string): string | undefined {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = bytes.readUInt32LE(end + 16);
  for (let left = bytes.readUInt16LE(end + 10); left > 0; left -= 1) {
    const nameLength = bytes.readUInt16LE(at + 28);
    if (bytes.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const local = bytes.readUInt32LE(at + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(start, start + bytes.readUInt32LE(at + 20));
      return (bytes.readUInt16LE(at + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return undefined;
}

/** The sharedStrings part's count and uniqueCount attributes and its `<si>` elements; fails unless it matches SST_DOCUMENT. */
function sharedStrings(bytes: Buffer): { count: number; uniqueCount: number; elements: string[] } {
  const match = SST_DOCUMENT.exec(zipText(bytes, 'xl/sharedStrings.xml') ?? '');
  expect(match).not.toBeNull();
  return {
    count: Number(match?.[1]),
    uniqueCount: Number(match?.[2]),
    elements: [...(match?.[3] ?? '').matchAll(/<si>.*?<\/si>/gs)].map(([element]) => element),
  };
}

/** `length` seeded characters from '!' to 'z', which deflate cannot shrink much. */
function noise(length: number): string {
  const bytes = Buffer.alloc(length);
  let state = 20260630;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = 33 + ((state >>> 24) % 90);
  }
  return bytes.toString('latin1');
}

describe('renderXlsx shared strings', () => {
  it('reads back repeated and distinct strings unchanged, each cell a string', async () => {
    const labels = ['code', 'state', 'code'];
    const rows = Array.from({ length: 200 }, (_, i) => [`ROW-${String(i)}`, i % 2 === 0 ? 'APPROVED' : 'SUBMITTED', `ROW-${String(i % 7)}`]);
    const sheets = await readBack(await buffer(bodyOf(tableOf(labels, rows))));
    expect(sheets).toEqual([{ name: 'export', rows: [labels, ...rows].map((row) => row.map((value) => [value, ExcelJS.ValueType.String])) }]);
  });

  it.each([
    { name: 'an empty string', value: '', read: '', element: '<si><t></t></si>' },
    { name: 'leading and trailing spaces', value: ' padded ', read: ' padded ', element: '<si><t xml:space="preserve"> padded </t></si>' },
    { name: 'a line feed', value: 'line\nfeed', read: 'line\nfeed', element: '<si><t xml:space="preserve">line\nfeed</t></si>' },
    { name: 'a tab', value: 'tab\there', read: 'tab\there', element: '<si><t>tab\there</t></si>' },
    { name: 'CR and CRLF', value: 'cr\rcrlf\r\n.', read: 'cr\rcrlf\r\n.', element: '<si><t xml:space="preserve">cr_x000D_crlf_x000D_\n.</t></si>' },
    { name: 'C0 controls and DEL', value: 'nul\u0000us\u001fdel\u007f', read: 'nul\u0000us\u001fdel\u007f', element: '<si><t>nul_x0000_us_x001F_del_x007F_</t></si>' },
    { name: 'a literal _x000D_ escape', value: 'literal _x000D_', read: 'literal _x000D_', element: '<si><t>literal _x005F_x000D_</t></si>' },
    {
      name: 'a literal _xHHHH before a control character',
      value: '_x0041\u0001_x0012\u001d&',
      read: '_x0041\u0001_x0012\u001d&',
      element: '<si><t>_x005F_x0041_x0001__x005F_x0012_x001D_&amp;</t></si>',
    },
    { name: 'the XML special characters', value: `&<>"'`, read: `&<>"'`, element: '<si><t>&amp;&lt;&gt;&quot;&apos;</t></si>' },
    { name: 'a lone surrogate, as UTF-8 encodes it', value: 'lone \ud800', read: 'lone \ufffd', element: '<si><t>lone \ufffd</t></si>' },
    { name: 'a 100,000-character string', value: 'x'.repeat(100_000), read: 'x'.repeat(100_000), element: `<si><t>${'x'.repeat(100_000)}</t></si>` },
  ])('writes $name as exceljs does and reads it back', async ({ value, read, element }) => {
    const bytes = await buffer(bodyOf(tableOf(['v'], [[value]])));
    expect((await readBack(bytes))[0]?.rows[1]).toEqual([[read, ExcelJS.ValueType.String]]);
    expect(sharedStrings(bytes).elements).toEqual(['<si><t>v</t></si>', element]);
  });

  it('writes one string per string cell, a repeated string included, counted in count and uniqueCount', async () => {
    const bytes = await buffer(bodyOf(tableOf(['v', 'v'], [['same', 'same'], ['same', 'other']])));
    expect(sharedStrings(bytes)).toEqual({
      count: 6,
      uniqueCount: 6,
      elements: ['v', 'v', 'same', 'same', 'same', 'other'].map((text) => `<si><t>${text}</t></si>`),
    });
    expect([...(zipText(bytes, 'xl/worksheets/sheet1.xml') ?? '').matchAll(/t="s"><v>(\d+)<\/v>/g)].map(([, index]) => Number(index))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(zipText(bytes, '[Content_Types].xml')).toContain('PartName="/xl/sharedStrings.xml"');
    expect(zipText(bytes, 'xl/_rels/workbook.xml.rels')).toContain('Target="sharedStrings.xml"');
  });

  it('writes no sharedStrings part for a table without columns', async () => {
    const bytes = await buffer(bodyOf(tableOf([], [[], []])));
    expect([zipText(bytes, 'xl/sharedStrings.xml'), zipText(bytes, '[Content_Types].xml')?.includes('sharedStrings')]).toEqual([undefined, false]);
    expect(await readBack(bytes)).toEqual([{ name: 'export', rows: [] }]);
  });
});

describe('renderXlsx spill file', () => {
  let parent: string;
  let previous: string | undefined;

  // A private temporary directory, so only this writer's spill shows here.
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'export-xlsx-test-'));
    previous = process.env.TMPDIR;
    process.env.TMPDIR = parent;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(parent, { recursive: true, force: true });
  });

  /** Waits until the private directory holds `count` spill directories. */
  async function spills(count: number): Promise<void> {
    await vi.waitFor(async () => expect(await readdir(parent)).toHaveLength(count), { timeout: 10_000, interval: 5 });
  }

  /** This process's open files under the private directory. */
  async function openFiles(): Promise<string[]> {
    const links = await Promise.all((await readdir('/proc/self/fd')).map((fd) => readlink(join('/proc/self/fd', fd)).catch(() => '')));
    return links.filter((link) => link.startsWith(parent));
  }

  /** Resolves once one entry has appeared in, then left, the private directory. */
  function createdAndRemoved(): Promise<void> {
    const watcher = watch(parent);
    const seen = new Map<string, number>();
    return new Promise((resolve) => {
      watcher.on('change', (_event, name) => {
        const events = (seen.get(String(name)) ?? 0) + 1;
        seen.set(String(name), events);
        if (events < 2) return;
        watcher.close();
        resolve();
      });
    });
  }

  it('removes its spill once its full body is read to the end', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => [`ROW-${String(i)}`, `value ${String(i)}`]);
    const body = bodyOf(tableOf(['code', 'label'], rows));
    while (!body.writableNeedDrain) await nextTurn();
    expect(await readdir(parent)).toHaveLength(1);
    expect((await readBack(await buffer(body)))[0]?.rows).toHaveLength(20_001);
    await spills(0);
  });

  it('removes its spill before its body fails with a row read error', async () => {
    const error = new Error('page 2 unreadable');
    const body = bodyOf(tableOf(['v'], [['a'], ['b'], ['c']], { after: 2, error }));
    await expect(buffer(body)).rejects.toBe(error);
    expect(await readdir(parent)).toEqual([]);
  });

  it.runIf(process.platform === 'linux')('removes its spill when the consumer destroys the body before the workbook starts', async () => {
    const removed = createdAndRemoved();
    const table = tableOf(['v'], []);
    const body = bodyOf(table);
    body.destroy();
    await removed;
    expect([await readdir(parent), table.pulled()]).toEqual([[], 0]);
  });

  it('removes its spill when the consumer destroys its full body while rows are read', async () => {
    const table = tableOf(['code', 'label'], Array.from({ length: 60_000 }, (_, i) => [`ROW-${String(i)}`, `value ${String(i)}`]));
    const body = bodyOf(table);
    while (!body.writableNeedDrain) await nextTurn();
    expect(await readdir(parent)).toHaveLength(1);
    body.destroy();
    await spills(0);
    expect(table.pulled()).toBeLessThan(60_000);
  });

  it.runIf(process.platform === 'linux')('removes its spill and closes its file when the consumer destroys the full body while the strings part streams', async () => {
    const body = bodyOf(tableOf(['v'], [[noise(8_000_000)]]));
    while (!body.writableNeedDrain) await nextTurn();
    expect([await readdir(parent), await openFiles()].map((entries) => entries.length)).toEqual([1, 1]);
    body.destroy();
    await spills(0);
    await vi.waitFor(async () => expect(await openFiles()).toEqual([]), { timeout: 10_000, interval: 5 });
  });
});
