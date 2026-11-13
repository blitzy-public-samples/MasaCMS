// Masa admin user CSV downloads (cusers.cfc:473-496, cusers/inc/dsp_download.cfm:77-79) and the CFML list functions they use.
import { Readable } from 'node:stream';
import { cfDateTimeFormat } from './dates.js';
import { cfIsNumeric, cfNumberString, type LegacyQuery } from './serializer.js';

const COMMA_TOKEN = '**comma**';

/** The download headers `legacyUsersCsv` answers with. */
const USERS_CSV_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Disposition': 'attachment;filename=users.csv',
  'Content-Type': 'text/csv; charset=UTF-8',
});

/** Rows per chunk of a streamed users CSV. */
export const LEGACY_CSV_BATCH_ROWS = 500;

/** A query column in ACF `columnList` order: the row key it reads and its upper-cased name. */
export interface CfQueryColumn {
  name: string;
  column: string;
}

/** Rows of a streamed users CSV, values as the database returns them. */
export type LegacyCsvRows = Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>;

/** A streamed users CSV: the download headers and the body bytes. */
export interface LegacyUsersCsvStream {
  headers: Record<string, string>;
  body: Readable;
}

/** CFML ListAppend: the value alone for an empty list, otherwise appended after the delimiter. */
export function cfListAppend(list: string, value: string, delim = ','): string {
  return list === '' ? value : list + delim + value;
}

/** CFML ListToArray for a single delimiter: empty items are dropped. */
export function cfListToArray(list: string, delim = ','): string[] {
  return list.split(delim).filter((item) => item !== '');
}

/** CFML ListQualify(list, qualifier, delim, 'CHAR'): wraps non-numeric elements, never escapes embedded qualifiers. */
export function cfListQualifyChar(list: string, qualifier = '"', delim = ','): string {
  // ACF 2023 (observed on cusers.download) quotes every non-numeric element, UUIDs and dates included, and reads '0 ' as numeric.
  return cfListToArray(list, delim)
    .map((item) => (cfIsNumeric(item) ? item : qualifier + item + qualifier))
    .join(delim);
}

/** Values of a row in column order, resolved case-insensitively as ACF reads rs[col][i]. */
function rowValues(row: Record<string, unknown>, cols: readonly string[]): unknown[] {
  const lowerKeys = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  return cols.map((col) => {
    const key = Object.hasOwn(row, col) ? col : lowerKeys.get(col.toLowerCase());
    return key === undefined ? undefined : row[key];
  });
}

/** Cell texts of a row in column order, resolved case-insensitively as ACF reads rs[col][i]; NULL reads as ''. */
function rowCells(row: Record<string, unknown>, cols: readonly string[]): string[] {
  return rowValues(row, cols).map((value) => String(value ?? ''));
}

/** A datetime cell as ACF renders a `java.sql.Timestamp`: `yyyy-mm-dd HH:nn:ss.f`, trailing fraction zeros dropped. */
export function cfTimestampText(value: Date): string {
  // The first fraction digit always stays, so `.000` reads `.0` and `.370` reads `.37`.
  return cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss.lll').replace(/0{1,2}$/, '');
}

/**
 * A query cell as ACF renders it in string context; NULL reads as ''.
 * @throws TypeError For a complex value, which ACF cannot convert to a simple value either.
 */
export function cfQueryCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (value instanceof Date) return cfTimestampText(value);
  throw new TypeError('Complex object types cannot be converted to simple values.');
}

/** A query's columns as ACF lists them: upper-cased and sorted by code unit, the order its row cells follow. */
export function cfQueryColumnOrder(columnList: readonly string[]): CfQueryColumn[] {
  return columnList
    .map((name) => ({ name, column: name.toUpperCase() }))
    .sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
}

/** Masa users CSV body and headers; cells must arrive as ACF renders query values, dates pre-formatted (e.g. 2026-11-10 09:07:57.137). */
export function legacyUsersCsv(q: LegacyQuery): { body: string; headers: Record<string, string> } {
  const cols = q.columnList;
  const passwordAt = cols.findIndex((col) => col.toLowerCase() === 'password');
  const headerCols = passwordAt === -1 ? cols : cols.filter((_, i) => i !== passwordAt);
  let str = cfListQualifyChar(headerCols.join(',')) + '\n';
  for (const row of q.rows) {
    let r = '';
    // Rows keep the password column the header drops (cusers.cfc:488-493): a pre-existing leak reproduced for parity, reported not fixed.
    for (const value of rowCells(row, cols)) r = cfListAppend(r, value.replaceAll(',', COMMA_TOKEN) + ' ');
    str += cfListQualifyChar(r) + '\n';
  }
  return {
    body: str.replaceAll(COMMA_TOKEN, ','),
    headers: {
      'Content-Disposition': 'attachment;filename=users.csv',
      // ACF 2023 adds this charset to cfcontent type="text/csv" (observed on cusers.download).
      'Content-Type': 'text/csv; charset=UTF-8',
    },
  };
}

/** One users CSV row line as `legacyUsersCsv` writes it; the comma token never spans a line, so restoring it per line is exact. */
function usersCsvLine(cells: readonly string[]): string {
  let r = '';
  for (const value of cells) r = cfListAppend(r, value.replaceAll(',', COMMA_TOKEN) + ' ');
  return cfListQualifyChar(r).replaceAll(COMMA_TOKEN, ',') + '\n';
}

/** The users CSV of raw `rows` in chunks: the header line with the first batch, then `LEGACY_CSV_BATCH_ROWS` rows each. */
async function* usersCsvChunks(columnList: readonly string[], rows: LegacyCsvRows): AsyncGenerator<string, void, undefined> {
  const columns = cfQueryColumnOrder(columnList);
  const names = columns.map(({ name }) => name);
  const cols = columns.map(({ column }) => column);
  const passwordAt = cols.findIndex((col) => col.toLowerCase() === 'password');
  const headerCols = passwordAt === -1 ? cols : cols.filter((_, i) => i !== passwordAt);
  let chunk = cfListQualifyChar(headerCols.join(',')).replaceAll(COMMA_TOKEN, ',') + '\n';
  let count = 0;
  for await (const row of rows) {
    // Rows keep the password column the header drops, as legacyUsersCsv does.
    chunk += usersCsvLine(rowValues(row, names).map(cfQueryCellText));
    count += 1;
    if (count === LEGACY_CSV_BATCH_ROWS) {
      yield chunk;
      chunk = '';
      count = 0;
    }
  }
  if (chunk !== '') yield chunk;
}

/** Bytes of `first`, then the rest of `chunks`, one chunk per read; destroying them, read or not, ends `chunks` and its row source. */
function chunkStream(first: IteratorResult<string, void>, chunks: AsyncGenerator<string, void, undefined>): Readable {
  let prefetched: IteratorResult<string, void> | null = first;
  return new Readable({
    // Readable.from's buffer size, so at most one chunk waits unread.
    highWaterMark: 1,
    read() {
      const next = prefetched ?? chunks.next();
      prefetched = null;
      Promise.resolve(next).then(
        (result) => {
          this.push(result.done === true ? null : result.value);
        },
        (error: unknown) => {
          this.destroy(error as Error);
        },
      );
    },
    destroy(error, callback) {
      // A failed release errors the body only when no earlier error already does.
      chunks.return(undefined).then(
        () => {
          process.nextTick(callback, error);
        },
        (cleanup: unknown) => {
          process.nextTick(callback, error ?? (cleanup as Error));
        },
      );
    },
  });
}

/**
 * Masa users CSV of raw query rows as a byte stream: `legacyUsersCsv`'s headers and body bytes for the query as ACF reads it
 * (`cfQueryColumnOrder`, `cfQueryCellText`), pulled from `rows` one batch at a time as the body is read.
 * Resolves once the header and first batch are rendered, so their failure rejects; a later failure errors `body`.
 */
export async function legacyUsersCsvStream(columnList: readonly string[], rows: LegacyCsvRows): Promise<LegacyUsersCsvStream> {
  const chunks = usersCsvChunks(columnList, rows);
  const first = await chunks.next();
  return { headers: { ...USERS_CSV_HEADERS }, body: chunkStream(first, chunks) };
}
