import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import JSZip from 'jszip';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { sha256Hex } from '@opt2/platform/migration-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { GoldenConfigError } from '../../../src/golden/errors.js';
import {
  ZIP_NESTING_LIMIT,
  csvModel,
  exportKindFor,
  exportModel,
  fileModel,
  zipModel,
  type CsvModel,
  type ExportKind,
  type ZipModel,
} from '../../../src/golden/normalise/exports.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import { loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import { normaliseTimestamp } from '../../../src/golden/normalise/values.js';
import type { BodyRepresentation, RecordedResponse } from '../../../src/golden/steps.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/exports/${name}`, import.meta.url));

const USERS_CSV_SHA256 = 'cca9eec959ce8ce6e8542495acd16cb4115994885bcc251537b6c1b913b3b23f';
const TINY_PDF_SHA256 = 'bb7ad3f693a1c54b3f72e48e9c3b1165b314778e28504ed2e94c15852c5a5964';
const ZIP_TYPE = 'application/zip; charset=UTF-8';
const TIMESTAMP_COLUMNS = ['CREATED', 'LASTUPDATE', 'LASTLOGIN', 'PASSWORDCREATED'] as const;
const JDBC_TIMESTAMP = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)/g;
const SHIFT_MS = 3 * 86_400_000 + 7 * 60_000;
const CF_UUID_ANYWHERE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}/i;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);
const DETAIL_ID = 'C0FFEE00-1111-4C22-9D3333333333E444';

let rules: NormaliseRules;
let usersCsv: string;
let usersCsvBytes: Buffer;
let tinyPdf: Buffer;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
  usersCsvBytes = readFileSync(fixture('users.csv'));
  usersCsv = usersCsvBytes.toString('utf8');
  tinyPdf = readFileSync(fixture('tiny.pdf'));
});

function columnIndex(model: CsvModel, name: string): number {
  const index = model.rows[0]?.indexOf(name) ?? -1;
  expect(index, `column ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

function column(model: CsvModel, name: string): string[] {
  const index = columnIndex(model, name);
  return model.rows.slice(1).map((row) => row[index] ?? '');
}

// Every CF UUID swapped for a fresh one (consistently) and every timestamp moved, its format kept.
function replayCopy(text: string): string {
  const remapped = new Map<string, string>();
  const withIds = text.replace(new RegExp(CF_UUID_ANYWHERE.source, 'gi'), (id) => {
    const key = id.toUpperCase();
    const next = remapped.get(key) ?? cfUuid();
    remapped.set(key, next);
    return next;
  });
  return withIds.replace(JDBC_TIMESTAMP, (_match, ...parts: string[]) => {
    const [y, mo, d, h, mi, s, fraction] = parts.map(String);
    const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const shifted = new Date(at + SHIFT_MS);
    return `${shifted.toISOString().slice(0, 19).replace('T', ' ')}.${fraction}`;
  });
}

/** One archive member: a file's content, or null for a directory. */
type ZipMember = readonly [name: string, content: string | Buffer | null];

const ZIP_DATE_A = new Date(Date.UTC(2026, 10, 16, 23, 43, 2));
const ZIP_DATE_B = new Date(Date.UTC(2026, 10, 16, 23, 50, 4));
// An archive holding no entries: its end-of-central-directory record alone.
const EMPTY_ZIP = Buffer.from(`504b0506${'00'.repeat(18)}`, 'hex');

/** ZIP bytes holding `members` alone, no folder their paths imply, in the given order, every entry stamped `date`. */
async function zipBytes(members: readonly ZipMember[], date: Date, compression: 'STORE' | 'DEFLATE' = 'DEFLATE') {
  const zip = new JSZip();
  for (const [name, content] of members) {
    if (content === null) zip.file(name, null, { dir: true, date, createFolders: false });
    else zip.file(name, content, { date, createFolders: false });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression });
}

/** A settings bundle in Masa's layout: data files beside nested asset and cache archives, entries stamped `date`. */
async function bundleBytes(date: Date, options: { reverse?: boolean; assetText?: string } = {}): Promise<Buffer> {
  const members: ZipMember[] = [
    ['wddx_rstcontent.xml', '<wddxPacket version="1.0"><data/></wddxPacket>'],
    ['assetfiles.zip', await zipBytes([['empty.txt', options.assetText ?? 'empty']], date)],
    ['extensions.txt', 'extensions'],
    ['cachefiles.zip', await zipBytes([['file/', null], [`file/${DETAIL_ID}.txt`, 'empty']], date)],
  ];
  return zipBytes(options.reverse === true ? members.reverse() : members, date);
}

const WDDX_AT_A = '2026-11-17T00:13:09+00:00';
const WDDX_AT_B = '2026-11-17T01:09:17+00:00';

/** A one-row WDDX recordset as Masa's settings bundle writes it. */
function wddx(contentHistId: string, lastUpdate: string, title = 'Home'): string {
  return (
    "<wddxPacket version='1.0'><header/><data><recordset rowCount='1' fieldNames='CONTENTHISTID,LASTUPDATE,TITLE'>" +
    `<field name='CONTENTHISTID'><string>${contentHistId}</string></field>` +
    `<field name='LASTUPDATE'><dateTime>${lastUpdate}</dateTime></field>` +
    `<field name='TITLE'><string>${title}</string></field></recordset></data></wddxPacket>`
  );
}

describe('csvModel', () => {
  it('reads the users download as a 36-column grid with its header row', () => {
    const model = csvModel(usersCsv, createIdOrdinals(), rules);

    expect(model.kind).toBe('csv');
    expect(model.rows).toHaveLength(5);
    for (const row of model.rows) expect(row).toHaveLength(36);
    expect(model.rows[0]?.[0]).toBe('COMPANY');
    expect(model.rows[0]?.at(-1)).toBe('WEBSITE');
  });

  it('keeps embedded commas and the appended trailing spaces of each cell', () => {
    const model = csvModel(usersCsv, createIdOrdinals(), rules);
    const cells = model.rows.flat();

    expect(column(model, 'NOTES')[0]).toBe('Prefers mail, then phone ');
    expect(column(model, 'COMPANY')[2]).toBe('Okafor Analytics, Ltd ');
    expect(column(model, 'TAGS')[3]).toBe('alpha,ops ');
    expect(column(model, 'JOBTITLE')[0]).toBe('Editor  ');
    expect(column(model, 'LASTLOGIN')[1]).toBe(' ');
    expect(cells.some((cell) => cell.includes('**comma**'))).toBe(false);
  });

  it('replaces ids by first-sight ordinals and timestamps by their class placeholder', () => {
    const model = csvModel(usersCsv, createIdOrdinals(), rules);
    const jdbc = `${normaliseTimestamp('2026-05-04 10:00:00.0', rules)} `;

    expect(jdbc).toMatch(/^<ts:[a-z0-9-]+> $/);
    expect(column(model, 'USERID')).toStrictEqual(['<id:2> ', '<id:3> ', '<id:4> ', '<id:5> ']);
    expect(column(model, 'LASTUPDATEBYID')).toStrictEqual(Array<string>(4).fill('<id:1> '));
    for (const name of TIMESTAMP_COLUMNS) {
      for (const cell of column(model, name)) expect([jdbc, ' ']).toContain(cell);
    }
    for (const cell of model.rows.flat()) {
      expect(cell).not.toMatch(CF_UUID_ANYWHERE);
      expect(cell).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    }
  });

  it('matches a replay that differs only in ids and timestamps, and not one with a changed cell', () => {
    const replay = replayCopy(usersCsv);
    const capture = csvModel(usersCsv, createIdOrdinals(), rules);

    expect(replay).not.toBe(usersCsv);
    expect(csvModel(replay, createIdOrdinals(), rules)).toStrictEqual(capture);
    const edited = replay.replace('"Northwind Studio "', '"Northwind Studios "');
    expect(csvModel(edited, createIdOrdinals(), rules)).not.toStrictEqual(capture);
  });

  it('ignores a byte-order mark and keeps date-only columns literal', () => {
    const text = '\uFEFF"effectiveFrom","DUE_DATE","shippedOn"\n"2026-06-30","2026-07-01","2026-07-02"\n';

    expect(csvModel(text, createIdOrdinals(), rules).rows).toStrictEqual([
      ['effectiveFrom', 'DUE_DATE', 'shippedOn'],
      ['2026-06-30', '2026-07-01', normaliseTimestamp('2026-07-02', rules)],
    ]);
  });
});

describe('csvModel key ties', () => {
  const ADMIN = 'B0B0B0B0-0000-4B00-8B0000000000B000';
  const uid = (n: number): string => `A1B2C3D4-00${String(n).padStart(2, '0')}-4A01-9F0000000000A0${String(n).padStart(2, '0')}`;
  const HEADER = ['LNAME', 'FNAME', 'CREATED', 'LASTUPDATEBYID', 'USERID'];
  // Legacy key order on LNAME: runs Abbott (one cased ABBOTT, one padded), Adams (twins apart from USERID), then Zed.
  const ROWS = [
    ['Abbott ', 'Montana ', '2026-05-04 10:00:00.0 ', `${ADMIN} `, `${uid(1)} `],
    ['ABBOTT ', 'Keshawn ', '2026-05-05 10:00:00.0 ', `${ADMIN} `, `${uid(2)} `],
    ['Abbott  ', 'Annabelle ', '2026-05-06 10:00:00.0 ', `${ADMIN} `, `${uid(3)} `],
    ['Adams ', 'Rossie ', '2026-05-07 10:00:00.0 ', `${ADMIN} `, `${uid(5)} `],
    ['Adams ', 'Rossie ', '2026-05-07 10:00:00.0 ', `${ADMIN} `, `${uid(4)} `],
    ['Zed ', 'Lev ', '2026-05-08 10:00:00.0 ', `${ADMIN} `, `${uid(6)} `],
  ];
  const text = (rows: readonly (readonly string[])[]): string =>
    `${[HEADER, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n')}\n`;
  const model = (rows: readonly (readonly string[])[], keys: readonly string[] = ['LNAME']): CsvModel =>
    csvModel(text(rows), createIdOrdinals(), rules, keys);
  const at = (...order: number[]): string[][] => order.map((i) => ROWS[i] as string[]);

  it.each([
    { label: 'reversed', order: [2, 1, 0, 4, 3, 5] },
    { label: 'rotated', order: [1, 2, 0, 3, 4, 5] },
    { label: 'as listed', order: [0, 1, 2, 3, 4, 5] },
  ])('gives tie runs $label the same model, numbering ids in the canonical order', ({ order }) => {
    const ordered = model(at(...order));

    expect(ordered).toStrictEqual(model(ROWS));
    expect(column(ordered, 'FNAME')).toStrictEqual(['Keshawn ', 'Annabelle ', 'Montana ', 'Rossie ', 'Rossie ', 'Lev ']);
    expect(column(ordered, 'LASTUPDATEBYID')).toStrictEqual(Array<string>(6).fill('<id:1> '));
    expect(column(ordered, 'USERID')).toStrictEqual(['<id:2> ', '<id:3> ', '<id:4> ', '<id:5> ', '<id:6> ', '<id:7> ']);
    expect(column(model(at(...order), []), 'FNAME')).toStrictEqual(at(...order).map((row) => row[1]));
  });

  it('orders rows tied apart from their ids by their raw cells, so each id keeps its ordinal', () => {
    const ordinals = (order: number[]): (number | undefined)[] => {
      const state = createIdOrdinals();
      csvModel(text(at(...order)), state, rules, ['LNAME']);
      return [uid(4), uid(5)].map((id) => state.byId.get(id));
    };

    expect(ordinals([0, 1, 2, 3, 4, 5])).toStrictEqual([5, 6]);
    expect(ordinals([0, 1, 2, 4, 3, 5])).toStrictEqual([5, 6]);
  });

  it('keeps a row out of key order a difference, and ties on every declared column only', () => {
    expect(model(at(3, 0, 1, 2, 4, 5))).not.toStrictEqual(model(ROWS));
    expect(model(at(0, 1, 2, 5, 3, 4))).not.toStrictEqual(model(ROWS));
    expect(model(at(2, 1, 0, 3, 4, 5), ['LNAME', 'FNAME'])).not.toStrictEqual(model(ROWS, ['LNAME', 'FNAME']));
    expect(model(at(0, 1, 2, 4, 3, 5), ['LNAME', 'FNAME'])).toStrictEqual(model(ROWS, ['LNAME', 'FNAME']));
  });

  it('throws GoldenConfigError for a key column the header lacks, and models an empty body', () => {
    expect(() => model(ROWS, ['LASTNAME'])).toThrow(GoldenConfigError);
    expect(() => model(ROWS, ['LASTNAME'])).toThrow('csvKeyOrder column LASTNAME is not a header of the CSV');
    expect(csvModel('', createIdOrdinals(), rules, ['LNAME'])).toStrictEqual({ kind: 'csv', rows: [] });
  });
});

describe('zipModel', () => {
  const entry = (name: string, content: string) => ({ name, sha256: sha256Hex(content), size: content.length });

  it('lists each nested archive, then its files and directories under its prefix, and normalises names', async () => {
    expect(await zipModel(await bundleBytes(ZIP_DATE_A), ZIP_TYPE, createIdOrdinals(), rules)).toStrictEqual({
      kind: 'zip',
      contentType: ZIP_TYPE,
      entries: [
        entry('assetfiles.zip!/', ''),
        entry('assetfiles.zip!/empty.txt', 'empty'),
        entry('cachefiles.zip!/', ''),
        entry('cachefiles.zip!/file/', ''),
        entry('cachefiles.zip!/file/<id:1>.txt', 'empty'),
        entry('extensions.txt', 'extensions'),
        entry('wddx_rstcontent.xml', '<wddxPacket version="1.0"><data/></wddxPacket>'),
      ],
    });
  });

  it('compares the content of each file, never entry times, entry order or bytes', async () => {
    const a = await bundleBytes(ZIP_DATE_A);
    const b = await bundleBytes(ZIP_DATE_B, { reverse: true });

    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(await zipModel(b, ZIP_TYPE, createIdOrdinals(), rules)).toStrictEqual(
      await zipModel(a, ZIP_TYPE, createIdOrdinals(), rules),
    );
  });

  it('tells archives apart when one byte of a nested file differs', async () => {
    const capture = (await zipModel(await bundleBytes(ZIP_DATE_A), ZIP_TYPE, createIdOrdinals(), rules)) as ZipModel;
    const changed = await bundleBytes(ZIP_DATE_A, { assetText: 'emptY' });
    const replay = (await zipModel(changed, ZIP_TYPE, createIdOrdinals(), rules)) as ZipModel;

    const same = replay.entries.map((e, i) => e.sha256 === capture.entries[i]?.sha256);
    expect(same).toStrictEqual([true, false, true, true, true, true, true]);
    expect(replay).not.toStrictEqual(capture);
  });

  it.each<{ label: string; top?: ZipMember[]; nested?: ZipMember[]; added: string }>([
    { label: 'an empty directory', top: [['empty/', null]], added: 'empty/' },
    { label: 'a directory of a nested archive', nested: [['empty/', null]], added: 'inner.zip!/empty/' },
    { label: 'an empty nested archive', top: [['extra.zip', EMPTY_ZIP]], added: 'extra.zip!/' },
  ])('tells archives apart when one holds $label more', async ({ top = [], nested = [], added }) => {
    const archive = async (extraTop: readonly ZipMember[], extraNested: readonly ZipMember[]) => {
      const inner = await zipBytes([['data.txt', 'data'], ...extraNested], ZIP_DATE_A);
      const bytes = await zipBytes([['manifest.txt', 'same payload'], ['inner.zip', inner], ...extraTop], ZIP_DATE_A);
      return zipModel(bytes, ZIP_TYPE, createIdOrdinals(), rules);
    };
    const capture = await archive([], []);
    const replay = await archive(top, nested);

    expect(replay).not.toStrictEqual(capture);
    expect(replay?.entries.filter((e) => e.name === added)).toStrictEqual([entry(added, '')]);
    expect(replay?.entries.filter((e) => e.name !== added)).toStrictEqual(capture?.entries);
  });

  it('lists only the files of an archive whose paths imply folders it holds no entries for', async () => {
    const bytes = await zipBytes([['a/b/c.txt', 'c'], ['a/d.txt', 'd']], ZIP_DATE_A);
    const synthesised = await JSZip.loadAsync(bytes, { createFolders: true });

    expect(Object.keys(synthesised.files).sort()).toStrictEqual(['a/', 'a/b/', 'a/b/c.txt', 'a/d.txt']);
    expect((await zipModel(bytes, ZIP_TYPE, createIdOrdinals(), rules))?.entries).toStrictEqual([
      entry('a/b/c.txt', 'c'),
      entry('a/d.txt', 'd'),
    ]);
  });

  it.each([
    { label: 'a CF UUID and an ISO timestamp', replay: wddx(cfUuid(), WDDX_AT_B), equal: true },
    { label: 'a non-volatile value', replay: wddx(DETAIL_ID, WDDX_AT_A, 'Home page'), equal: false },
    { label: 'a byte order mark', replay: `\uFEFF${wddx(DETAIL_ID, WDDX_AT_A)}`, equal: false },
  ])('compares text files by normalised content; differing in $label, equal is $equal', async ({ replay, equal }) => {
    const model = async (xml: string) => {
      const bytes = await zipBytes([['wddx_rstcontent.xml', xml], ['extensions.txt', 'extensions']], ZIP_DATE_A);
      return zipModel(bytes, ZIP_TYPE, createIdOrdinals(), rules);
    };
    const capture = await model(wddx(DETAIL_ID, WDDX_AT_A));

    expect(isDeepStrictEqual(await model(replay), capture)).toBe(equal);
  });

  it.each([
    { label: 'rows in another order', name: 'wddx_rstcontentcategoryassign.xml', change: false, equal: true },
    { label: 'rows in another order and one value', name: 'wddx_rstcontentcategoryassign.xml', change: true, equal: false },
    { label: 'ordered rsthierarchy rows in another order', name: 'wddx_rsthierarchy.xml', change: false, equal: false },
  ])('compares $name holding $label, equal is $equal', async ({ name, change, equal }) => {
    const [category, other] = [cfUuid(), cfUuid()];
    const rows: string[][] = [
      [cfUuid(), category, '0.0'],
      [cfUuid(), other, '0.0'],
      [cfUuid(), category, '1.0'],
    ];
    // As cfwddx writes a query (one field per column) and cffile ends the file.
    const packet = (ordered: readonly string[][]) => {
      const field = (column: string, c: number, type: string) =>
        `<field name='${column}'>${ordered.map((row) => `<${type}>${row[c]}</${type}>`).join('')}</field>`;
      return (
        "<wddxPacket version='1.0'><header/><data><recordset rowCount='3' fieldNames='CONTENTHISTID,CATEGORYID," +
        `ISFEATURE' type='coldfusion.sql.QueryTable'>${field('CONTENTHISTID', 0, 'string')}` +
        `${field('CATEGORYID', 1, 'string')}${field('ISFEATURE', 2, 'number')}</recordset></data></wddxPacket>\n`
      );
    };
    const model = async (xml: string) =>
      zipModel(await zipBytes([[name, xml]], ZIP_DATE_A), ZIP_TYPE, createIdOrdinals(), rules);
    const replayRows = [...rows.slice(2), ...rows.slice(0, 2)].map((row, i) =>
      change && i === 0 ? [...row.slice(0, 2), '0.0'] : row,
    );

    expect(isDeepStrictEqual(await model(packet(replayRows)), await model(packet(rows)))).toBe(equal);
  });

  it('numbers ids in raw-name order, name before content, so entries sharing an id share its ordinal', async () => {
    const [shared, other, named] = [cfUuid(), cfUuid(), cfUuid()];
    const bytes = await zipBytes(
      [
        ['wddx_rsthierarchy.xml', `<string>${other}</string><string>${shared}</string>`],
        ['wddx_rstcontent.xml', `<string>${shared}</string><dateTime>${WDDX_AT_A}</dateTime>`],
        [`file/${named}.txt`, other],
        [`pack/${other}.zip`, await zipBytes([[`${shared}.txt`, named]], ZIP_DATE_A)],
        [`dir/${shared}/`, null],
      ],
      ZIP_DATE_A,
    );

    expect((await zipModel(bytes, ZIP_TYPE, createIdOrdinals(), rules))?.entries).toStrictEqual([
      entry('dir/<id:1>/', ''),
      entry('file/<id:2>.txt', '<id:3>'),
      entry('pack/<id:3>.zip!/', ''),
      entry('pack/<id:3>.zip!/<id:1>.txt', '<id:2>'),
      entry('wddx_rstcontent.xml', '<string><id:1></string><dateTime><ts:serializer></dateTime>'),
      entry('wddx_rsthierarchy.xml', '<string><id:3></string><string><id:1></string>'),
    ]);
  });

  it.each([
    { label: 'a NUL byte', content: Buffer.concat([PNG_BYTES, Buffer.from(DETAIL_ID)]) },
    { label: 'invalid UTF-8', content: Buffer.concat([Buffer.from(DETAIL_ID), Buffer.from([0xc3, 0x28])]) },
  ])('compares a file holding $label by its raw digest and size', async ({ content }) => {
    const bytes = await zipBytes([['image.bin', content]], ZIP_DATE_A);

    expect((await zipModel(bytes, ZIP_TYPE, createIdOrdinals(), rules))?.entries).toStrictEqual([
      { name: 'image.bin', sha256: sha256Hex(content), size: content.length },
    ]);
  });

  it(`keeps archives nested past ZIP_NESTING_LIMIT (${ZIP_NESTING_LIMIT}) and a non-archive .zip as files`, async () => {
    // levelN.zip holds levelN+1.zip; the last level holds leaf.txt.
    const names = Array.from({ length: ZIP_NESTING_LIMIT + 1 }, (_name, i) => `level${i + 1}.zip`);
    const leaf = await zipBytes([['leaf.txt', 'leaf']], ZIP_DATE_A);
    let archive = leaf;
    for (const name of names.slice(1).reverse()) archive = await zipBytes([[name, archive]], ZIP_DATE_A);
    const bytes = await zipBytes([[names[0] as string, archive], ['broken.zip', 'not an archive']], ZIP_DATE_A);

    const model = await zipModel(bytes, ZIP_TYPE, createIdOrdinals(), rules);

    const expanded = names.slice(0, ZIP_NESTING_LIMIT).map((_name, i) => `${names.slice(0, i + 1).join('!/')}!/`);
    const deepest = `${expanded.at(-1)}${names[ZIP_NESTING_LIMIT]}`;
    expect(model?.entries).toStrictEqual([
      entry('broken.zip', 'not an archive'),
      ...expanded.map((name) => entry(name, '')),
      { name: deepest, sha256: sha256Hex(leaf), size: leaf.length },
    ]);
  });

  it.each<{ label: string; bytes: () => Promise<Buffer> }>([
    { label: 'bytes that are no archive', bytes: async () => Buffer.from('PK\u0003\u0004 not an archive') },
    { label: 'an empty body', bytes: async () => Buffer.alloc(0) },
    {
      label: 'a truncated archive',
      bytes: async () => {
        const whole = await bundleBytes(ZIP_DATE_A);
        return whole.subarray(0, Math.floor(whole.length / 2));
      },
    },
    {
      label: 'an archive whose file fails its CRC-32',
      bytes: async () => {
        const stored = await zipBytes([['data.txt', 'FIXTURE-CONTENT']], ZIP_DATE_A, 'STORE');
        const at = stored.indexOf('FIXTURE-CONTENT');
        stored[at] = 'X'.charCodeAt(0);
        return stored;
      },
    },
  ])('falls back to the file model, filename included, for $label', async ({ bytes }) => {
    const body = await bytes();
    const response = recorded(ZIP_TYPE, { bytesBase64: body.toString('base64') }, sha256Hex(body));
    response.headers['content-disposition'] = 'attachment;filename="bundle.zip"';

    expect(await zipModel(body, ZIP_TYPE, createIdOrdinals(), rules)).toBeUndefined();
    expect(await exportModel(response, createIdOrdinals(), rules)).toStrictEqual({
      ...fileModel({ bytes: body, contentType: ZIP_TYPE }),
      filename: 'bundle.zip',
    });
  });
});

describe('fileModel', () => {
  it('hashes the body bytes and keeps the content type', () => {
    expect(fileModel({ bytes: tinyPdf, contentType: 'application/pdf' })).toStrictEqual({
      kind: 'file',
      sha256: TINY_PDF_SHA256,
      contentType: 'application/pdf',
    });
    expect(fileModel({ bytes: usersCsvBytes, contentType: 'text/csv' })).toStrictEqual({
      kind: 'file',
      sha256: USERS_CSV_SHA256,
      contentType: 'text/csv',
    });
  });

  it('passes a recorded digest through in preference to the bytes', () => {
    const recorded = sha256Hex('recorded body');

    expect(fileModel({ sha256: recorded, contentType: 'image/png; name=x' })).toStrictEqual({
      kind: 'file',
      sha256: recorded,
      contentType: 'image/png; name=x',
    });
    expect(fileModel({ sha256: recorded, bytes: PNG_BYTES, contentType: 'image/png' }).sha256).toBe(recorded);
  });
});

describe('exportKindFor', () => {
  it.each<[string, ExportKind]>([
    ['text/csv', 'csv'],
    ['text/csv; charset=utf-8', 'csv'],
    ['Text/CSV;charset=UTF-8', 'csv'],
    ['application/octet-stream', 'file'],
    ['image/png', 'file'],
    ['application/zip', 'zip'],
    [ZIP_TYPE, 'zip'],
    ['application/x-zip-compressed', 'zip'],
    ['', 'file'],
  ])('compares %j as %s', (contentType, kind) => {
    expect(exportKindFor(contentType)).toBe(kind);
  });
});

function recorded(contentType: string, body: BodyRepresentation, sha256: string): RecordedResponse {
  return { status: 200, headers: { 'content-type': contentType }, contentType, sha256, hops: [], ...body };
}

describe('exportModel', () => {
  it('builds the model its content type selects, equal to the direct call', async () => {
    const csv = recorded('text/csv; charset=utf-8', { text: usersCsv }, USERS_CSV_SHA256);
    const png = recorded('image/png', { bytesBase64: PNG_BYTES.toString('base64') }, sha256Hex(PNG_BYTES));
    const bundle = await bundleBytes(ZIP_DATE_A);
    const zip = recorded(ZIP_TYPE, { bytesBase64: bundle.toString('base64') }, sha256Hex(bundle));

    expect(await exportModel(csv, createIdOrdinals(), rules)).toStrictEqual(
      csvModel(usersCsv, createIdOrdinals(), rules),
    );
    expect(await exportModel(png, createIdOrdinals(), rules)).toStrictEqual(
      fileModel({ bytes: PNG_BYTES, contentType: 'image/png' }),
    );
    expect(await exportModel(zip, createIdOrdinals(), rules)).toStrictEqual(
      await zipModel(bundle, ZIP_TYPE, createIdOrdinals(), rules),
    );
    const headerless = { contentType: 'application/zip', sha256: sha256Hex(PNG_BYTES) };
    expect(await exportModel(headerless, createIdOrdinals(), rules)).toStrictEqual(fileModel(headerless));
  });

  it('decodes a CSV body recorded as bytes', async () => {
    const csv = recorded('text/csv', { bytesBase64: usersCsvBytes.toString('base64') }, USERS_CSV_SHA256);

    expect(await exportModel(csv, createIdOrdinals(), rules)).toStrictEqual(
      csvModel(usersCsv, createIdOrdinals(), rules),
    );
  });

  it.each<[string | string[], string]>([
    [`attachment; filename="${DETAIL_ID}.png"`, '<id:1>.png'],
    ['attachment; filename=report-2026.png', 'report-2026.png'],
    ['inline; filename="say \\"hi\\".png"', 'say "hi".png'],
    [['attachment; filename="first.png"', 'attachment; filename="second.png"'], 'first.png'],
  ])('compares downloads by digest, content type and Content-Disposition %j', async (disposition, filename) => {
    const png = recorded('image/png', { bytesBase64: PNG_BYTES.toString('base64') }, sha256Hex(PNG_BYTES));
    png.headers['content-disposition'] = disposition;

    expect(await exportModel(png, createIdOrdinals(), rules)).toStrictEqual({
      kind: 'file',
      sha256: sha256Hex(PNG_BYTES),
      contentType: 'image/png',
      filename,
    });
  });

  it('compares a ZIP download by its files, content type and Content-Disposition filename', async () => {
    const bundle = await bundleBytes(ZIP_DATE_A);
    const zip = recorded(ZIP_TYPE, { bytesBase64: bundle.toString('base64') }, sha256Hex(bundle));
    zip.headers['content-disposition'] = `attachment;filename="export_${DETAIL_ID}.zip"`;

    const model = await exportModel(zip, createIdOrdinals(), rules);

    // The cache archive names the same id first, so the filename continues its ordinal.
    const files = await zipModel(bundle, ZIP_TYPE, createIdOrdinals(), rules);
    expect(model).toStrictEqual({ ...files, filename: 'export_<id:1>.zip' });
  });

  it.each([
    {
      label: 'settings bundle',
      capture: 'attachment;filename="export_page_tenant-a_2026_11_16_23_43.zip"',
      replay: 'attachment;filename="export_page_tenant-a_2026_11_16_23_50.zip"',
      otherClass: 'attachment;filename="export_page_tenant-a_2026_11_16.zip"',
      filename: 'export_page_tenant-a_<ts:file-stamp-minute>.zip',
    },
    {
      label: 'form export',
      capture: 'attachment;filename=opt_2_seed_contact_form_2026_16_11_tenant-a.zip',
      replay: 'attachment;filename=opt_2_seed_contact_form_2026_17_11_tenant-a.zip',
      otherClass: 'attachment;filename=opt_2_seed_contact_form_2026_16_11_23_43_tenant-a.zip',
      filename: 'opt_2_seed_contact_form_<ts:file-stamp-date>_tenant-a.zip',
    },
  ])('compares the $label filename by its stamp class, whatever the export time', async (c) => {
    const bundle = await bundleBytes(ZIP_DATE_A);
    const model = async (disposition: string) => {
      const zip = recorded(ZIP_TYPE, { bytesBase64: bundle.toString('base64') }, sha256Hex(bundle));
      zip.headers['content-disposition'] = disposition;
      return exportModel(zip, createIdOrdinals(), rules);
    };
    const capture = await model(c.capture);

    expect(capture).toMatchObject({ kind: 'zip', filename: c.filename });
    expect(await model(c.replay)).toStrictEqual(capture);
    expect(await model(c.otherClass)).not.toStrictEqual(capture);
  });

  it('follows the export switches of the rules', async () => {
    const switched: NormaliseRules = {
      ...rules,
      exports: {
        ...rules.exports,
        csv: { ...rules.exports.csv, whitespace: 'collapse-and-trim' },
        zip: { ...rules.exports.zip, compare: ['entries', 'contentType'] },
        file: { compare: ['sha256', 'contentType'] },
      },
    };
    const png = recorded('image/png', { bytesBase64: PNG_BYTES.toString('base64') }, sha256Hex(PNG_BYTES));
    png.headers['content-disposition'] = 'attachment; filename="photo.png"';
    const bundle = await bundleBytes(ZIP_DATE_A);
    const zip = recorded(ZIP_TYPE, { bytesBase64: bundle.toString('base64') }, sha256Hex(bundle));
    zip.headers['content-disposition'] = 'attachment; filename="bundle.zip"';

    expect(column(csvModel(usersCsv, createIdOrdinals(), switched), 'JOBTITLE')[0]).toBe('Editor');
    expect(await exportModel(png, createIdOrdinals(), switched)).toStrictEqual(
      fileModel({ bytes: PNG_BYTES, contentType: 'image/png' }),
    );
    expect(await exportModel(zip, createIdOrdinals(), switched)).toStrictEqual(
      await zipModel(bundle, ZIP_TYPE, createIdOrdinals(), switched),
    );
  });
});
