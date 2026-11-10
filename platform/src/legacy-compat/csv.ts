// Masa admin user CSV downloads (cusers.cfc:473-496, cusers/inc/dsp_download.cfm:77-79) and the CFML list functions they use.
import { cfIsNumeric, type LegacyQuery } from './serializer.js';

const COMMA_TOKEN = '**comma**';

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

/** Cell texts of a row in column order, resolved case-insensitively as ACF reads rs[col][i]; NULL reads as ''. */
function rowCells(row: Record<string, unknown>, cols: readonly string[]): string[] {
  const lowerKeys = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  return cols.map((col) => {
    const key = Object.hasOwn(row, col) ? col : lowerKeys.get(col.toLowerCase());
    return String((key === undefined ? undefined : row[key]) ?? '');
  });
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
