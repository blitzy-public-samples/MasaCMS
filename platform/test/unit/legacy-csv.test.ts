import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_CSV_BATCH_ROWS,
  cfIsNumeric,
  cfListAppend,
  cfListQualifyChar,
  cfListToArray,
  cfQueryCellText,
  cfQueryColumnOrder,
  cfTimestampText,
  legacyQuery,
  legacyUsersCsv,
  legacyUsersCsvStream,
  type LegacyCsvRows,
  type LegacyQuery,
} from '../../src/legacy-compat/index.js';

const USER_COLUMNS = ['userid', 'fname', 'password', 'inactive'];
const USERS = legacyQuery(USER_COLUMNS, [{ userid: 'ABC', fname: 'Smith, J', password: 'secret', inactive: '0' }]);
const USERS_HEADER_LINE = '"userid","fname","inactive"\n';

// Header and qa_editor row of GET /admin/?muraAction=cusers.download&siteid=default&ispublic=0 on Masa 7.6.1, ACF 2023.
const ORACLE_COLUMNS = [
  'ADMIN', 'EMAIL', 'FNAME', 'GROUPNAME', 'ISPUBLIC', 'LASTUPDATE', 'LASTUPDATEBY',
  'LNAME', 'S2', 'SITEID', 'SUBTYPE', 'TYPE', 'USERID', 'USERNAME',
];
const ORACLE_BODY =
  '"ADMIN","EMAIL","FNAME","GROUPNAME","ISPUBLIC","LASTUPDATE","LASTUPDATEBY","LNAME","S2","SITEID","SUBTYPE","TYPE","USERID","USERNAME"\n' +
  '" ","qa_editor@example.com ","QA "," ",0 ,"2026-11-10 09:07:57.137 ","Admin User ","Editor ",0 ,' +
  '"default ","Default ",2 ,"AF240756-C1CD-6298-60C0CAF70AACAE2B ","qa_editor "\n';

/** A cell as ListQualify CHAR emits it: bare when CFML reads it as numeric, quoted otherwise. */
function qualified(cell: string): string {
  return cfIsNumeric(cell) ? cell : `"${cell}"`;
}

describe('legacyUsersCsv body', () => {
  it('starts with the qualified column list minus password, ended by LF', () => {
    expect(legacyUsersCsv(USERS).body).toMatch(/^"userid","fname","inactive"\n/);
  });

  it('writes every column of a row, password included, each with a trailing space and its commas restored', () => {
    expect(legacyUsersCsv(USERS).body).toBe(`${USERS_HEADER_LINE}"ABC ","Smith, J ","secret ",${qualified('0 ')}\n`);
  });

  it('keeps every comma of a value inside one quoted cell', () => {
    const q = legacyQuery(['fname'], [{ fname: 'a,b,,c' }]);
    expect(legacyUsersCsv(q).body).toBe('"fname"\n"a,b,,c "\n');
  });

  it('ends every line with LF alone', () => {
    const { body } = legacyUsersCsv(USERS);
    expect(body).not.toContain('\r');
    expect(body.split('\n')).toHaveLength(3);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('returns only the header line for a query without rows', () => {
    expect(legacyUsersCsv(legacyQuery(USER_COLUMNS, [])).body).toBe(USERS_HEADER_LINE);
  });

  it.each(['PASSWORD', 'Password'])('drops the %s column from the header case-insensitively but keeps it in rows', (column) => {
    const q = legacyQuery(['userid', column], [{ userid: 'ABC', [column]: 'secret' }]);
    expect(legacyUsersCsv(q).body).toBe('"userid"\n"ABC ","secret "\n');
  });

  it('reproduces the ACF 2023 cusers.download body, resolving columns case-insensitively and NULL as empty', () => {
    const q = legacyQuery(ORACLE_COLUMNS, [
      {
        admin: null,
        email: 'qa_editor@example.com',
        fname: 'QA',
        groupname: '',
        ispublic: 0,
        lastupdate: '2026-11-10 09:07:57.137',
        lastupdateby: 'Admin User',
        lname: 'Editor',
        s2: 0,
        siteid: 'default',
        subtype: 'Default',
        type: 2,
        userid: 'AF240756-C1CD-6298-60C0CAF70AACAE2B',
        username: 'qa_editor',
      },
    ]);
    expect(legacyUsersCsv(q).body).toBe(ORACLE_BODY);
  });
});

describe('legacyUsersCsv headers', () => {
  it('sends users.csv as an attachment with the content type ACF gives cfcontent type="text/csv"', () => {
    // ACF 2023 appends the charset (observed on cusers.download), so the bare text/csv of dsp_download.cfm never reaches the wire.
    expect(legacyUsersCsv(USERS).headers).toEqual({
      'Content-Disposition': 'attachment;filename=users.csv',
      'Content-Type': 'text/csv; charset=UTF-8',
    });
  });
});

describe('CFML list primitives', () => {
  it.each([
    { list: 'a,1,b', expected: '"a",1,"b"' },
    { list: 'a,,b', expected: '"a","b"' },
    { list: 'say "hi",2 ', expected: '"say "hi"",2 ' },
  ])('cfListQualifyChar turns $list into $expected', ({ list, expected }) => {
    expect(cfListQualifyChar(list)).toBe(expected);
  });

  it.each([
    { list: '', value: 'x', expected: 'x' },
    { list: 'x', value: 'y', expected: 'x,y' },
  ])('cfListAppend($list, $value) returns $expected', ({ list, value, expected }) => {
    expect(cfListAppend(list, value)).toBe(expected);
  });

  it('cfListToArray drops empty items', () => {
    expect(cfListToArray('a,,b,')).toEqual(['a', 'b']);
  });
});

type Row = Record<string, unknown>;

/** The query as ACF reads it: columns in `cfQueryColumnOrder`, every cell rendered by `cfQueryCellText`. */
function acfRendered(columnList: string[], rows: Row[]): LegacyQuery {
  const columns = cfQueryColumnOrder(columnList);
  return legacyQuery(
    columns.map(({ column }) => column),
    rows.map((row) => Object.fromEntries(columns.map(({ name, column }) => [column, cfQueryCellText(row[name])]))),
  );
}

/** The body chunks in the order a pipe receives them. */
async function chunksOf(body: Readable): Promise<string[]> {
  const chunks: string[] = [];
  body.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  await once(body, 'end');
  return chunks;
}

/** `rows` from an async generator, as a cursor-backed source yields them. */
async function* asyncRows(rows: readonly Row[]): AsyncGenerator<Row> {
  for (const row of rows) yield row;
}

/** `count` single-column rows `{ fname: 'n<i>' }`. */
function nameRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ fname: `n${i}` }));
}

/** `nameRows(count)` from a sync or async generator, counting the rows it yields and the times its `finally` runs. */
function trackedRows(kind: 'sync' | 'async', count: number): { rows: LegacyCsvRows; seen: { pulled: number; released: number } } {
  const seen = { pulled: 0, released: 0 };
  function* syncSource(): Generator<Row> {
    try {
      for (const row of nameRows(count)) {
        seen.pulled += 1;
        yield row;
      }
    } finally {
      seen.released += 1;
    }
  }
  async function* asyncSource(): AsyncGenerator<Row> {
    for (const row of syncSource()) yield await Promise.resolve(row);
  }
  return { rows: kind === 'sync' ? syncSource() : asyncSource(), seen };
}

/** `nameRows(count)` from a cursor whose release rejects with `failure`. */
function unreleasable(count: number, failure: Error): AsyncIterable<Row> {
  const rows = nameRows(count)[Symbol.iterator]();
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve(rows.next()),
      return: () => Promise.reject(failure),
    }),
  };
}

describe('ACF query cell rendering', () => {
  it.each([
    { value: null, expected: '' },
    { value: undefined, expected: '' },
    { value: ' Smith, J ', expected: ' Smith, J ' },
    { value: 12, expected: '12' },
    { value: 1 / 3, expected: '0.333333333333' },
    { value: 1e20, expected: '1E+020' },
    { value: new Date(2026, 10, 10, 9, 7, 57, 137), expected: '2026-11-10 09:07:57.137' },
    { value: new Date(2026, 10, 10, 9, 7, 57, 370), expected: '2026-11-10 09:07:57.37' },
    { value: new Date(2026, 10, 10, 9, 7, 57, 0), expected: '2026-11-10 09:07:57.0' },
  ])('cfQueryCellText($value) is $expected', ({ value, expected }) => {
    expect(cfQueryCellText(value)).toBe(expected);
  });

  it.each([{}, [], { toString: () => 'x' }])('cfQueryCellText(%j) throws as ACF does for a complex value', (value) => {
    expect(() => cfQueryCellText(value)).toThrow(new TypeError('Complex object types cannot be converted to simple values.'));
  });

  it('cfTimestampText keeps the first fraction digit', () => {
    expect(cfTimestampText(new Date(2026, 0, 2, 3, 4, 5, 100))).toBe('2026-01-02 03:04:05.1');
  });

  it('cfQueryColumnOrder upper-cases and sorts by code unit, keeping each source name', () => {
    expect(cfQueryColumnOrder(['userid', 'Fname', 'S2', 'siteID', 'remote_id', 'REMOTEID'])).toEqual([
      { name: 'Fname', column: 'FNAME' },
      { name: 'REMOTEID', column: 'REMOTEID' },
      { name: 'remote_id', column: 'REMOTE_ID' },
      { name: 'S2', column: 'S2' },
      { name: 'siteID', column: 'SITEID' },
      { name: 'userid', column: 'USERID' },
    ]);
  });
});

describe('legacyUsersCsvStream', () => {
  const QUIRK_COLUMNS = ['userid', 'Fname', 'password', 'company', 'ext', 'lastupdate', 'notes', 'S2', 'remoteID'];
  const QUIRK_ROWS: Row[] = [
    {
      userid: 'ABC', Fname: 'Smith, J', password: 'secret', company: 'The "Quoted" Co', ext: 12,
      lastupdate: new Date(2026, 10, 10, 9, 7, 57, 137), notes: null, S2: 0, remoteID: '0',
    },
    {
      userid: 'DEF', Fname: '  12 ', password: null, company: 'a,b,,c', ext: 1 / 3,
      lastupdate: new Date(2026, 0, 1, 0, 0, 0, 0), notes: undefined, S2: 1, remoteID: '1e3',
    },
    {
      userid: 'GHI', Fname: '**comma**', password: 'x', company: '', ext: -0.5,
      lastupdate: new Date(2026, 5, 30, 9, 15, 0, 370), notes: 'line\nbreak', S2: 1e20, remoteID: '',
    },
  ];
  const DATASETS = [
    { name: 'password, commas, quotes, numeric-looking values, NULLs and Dates', columns: QUIRK_COLUMNS, rows: QUIRK_ROWS },
    { name: 'a column list without password', columns: ['lname', 'email'], rows: [{ lname: 'Doe', email: null }] },
    { name: 'no rows', columns: QUIRK_COLUMNS, rows: [] },
    { name: 'several batches', columns: ['fname'], rows: nameRows(LEGACY_CSV_BATCH_ROWS * 2 + 1) },
  ];
  const SOURCES: { kind: string; of: (rows: Row[]) => LegacyCsvRows }[] = [
    { kind: 'an array', of: (rows) => rows },
    { kind: 'an async generator', of: (rows) => asyncRows(rows) },
  ];

  describe.each(SOURCES)('from $kind', ({ of }) => {
    it.each(DATASETS)('writes the bytes legacyUsersCsv writes for $name rendered as ACF reads it', async ({ columns, rows }) => {
      const { body, headers } = await legacyUsersCsvStream(columns, of(rows));
      const expected = legacyUsersCsv(acfRendered(columns, rows));
      expect((await chunksOf(body)).join('')).toBe(expected.body);
      expect(headers).toEqual(expected.headers);
    });
  });

  it('reproduces the ACF 2023 cusers.download body from raw rows, timestamps as Date', async () => {
    const row = {
      admin: null, email: 'qa_editor@example.com', fname: 'QA', groupname: '', ispublic: 0,
      lastupdate: new Date(2026, 10, 10, 9, 7, 57, 137), lastupdateby: 'Admin User', lname: 'Editor', s2: 0,
      siteid: 'default', subtype: 'Default', type: 2, userid: 'AF240756-C1CD-6298-60C0CAF70AACAE2B', username: 'qa_editor',
    };
    const { body } = await legacyUsersCsvStream(Object.keys(row), [row]);
    expect((await chunksOf(body)).join('')).toBe(ORACLE_BODY);
  });

  it('resolves row keys case-insensitively as ACF reads query columns', async () => {
    const { body } = await legacyUsersCsvStream(['UserID', 'Fname'], [{ userid: 'ABC', FNAME: 'Jo' }]);
    expect((await chunksOf(body)).join('')).toBe('"FNAME","USERID"\n"Jo ","ABC "\n');
  });

  it('answers one chunk holding only the header line for no rows', async () => {
    const { body } = await legacyUsersCsvStream(USER_COLUMNS, []);
    expect(await chunksOf(body)).toEqual(['"FNAME","INACTIVE","USERID"\n']);
  });

  it('emits the header with the first batch, then one chunk per batch', async () => {
    const { body } = await legacyUsersCsvStream(['fname'], nameRows(LEGACY_CSV_BATCH_ROWS * 2 + 1));
    const lineCounts = (await chunksOf(body)).map((chunk) => chunk.split('\n').length - 1);
    expect(lineCounts).toEqual([LEGACY_CSV_BATCH_ROWS + 1, LEGACY_CSV_BATCH_ROWS, 1]);
  });

  it('pulls rows only as the body is read', async () => {
    let pulled = 0;
    async function* counted(): AsyncGenerator<Row> {
      for (const row of nameRows(LEGACY_CSV_BATCH_ROWS * 3)) {
        pulled += 1;
        yield row;
      }
    }
    const { body } = await legacyUsersCsvStream(['fname'], counted());
    await nextTurn();
    expect(pulled).toBe(LEGACY_CSV_BATCH_ROWS);
    await chunksOf(body);
    expect(pulled).toBe(LEGACY_CSV_BATCH_ROWS * 3);
  });

  it('rejects when a row of the first batch cannot be rendered', async () => {
    await expect(legacyUsersCsvStream(['fname'], [{ fname: 'ok' }, { fname: {} }])).rejects.toThrow(
      new TypeError('Complex object types cannot be converted to simple values.'),
    );
  });

  it.each([
    {
      failure: 'a complex cell',
      rows: (): LegacyCsvRows => [...nameRows(LEGACY_CSV_BATCH_ROWS + 1), { fname: {} }],
      error: new TypeError('Complex object types cannot be converted to simple values.'),
    },
    {
      failure: 'the row source',
      rows: async function* (): AsyncGenerator<Row> {
        yield* nameRows(LEGACY_CSV_BATCH_ROWS + 1);
        throw new Error('cursor lost');
      },
      error: new Error('cursor lost'),
    },
  ])('errors the body after the first batch when $failure fails', async ({ rows, error }) => {
    const { body } = await legacyUsersCsvStream(['fname'], rows());
    const chunks: string[] = [];
    body.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const [streamError] = await once(body, 'error');
    expect(streamError).toEqual(error);
    expect(chunks).toHaveLength(1);
  });

  describe.each(['sync', 'async'] as const)('with a %s generator row source', (kind) => {
    it.each([
      { when: 'destroyed before any read', act: (body: Readable) => body.destroy(), pulled: LEGACY_CSV_BATCH_ROWS },
      { when: 'destroyed after its first chunk', act: (body: Readable) => body.once('data', () => body.destroy()), pulled: LEGACY_CSV_BATCH_ROWS },
      { when: 'read to its end', act: (body: Readable) => body.resume(), pulled: LEGACY_CSV_BATCH_ROWS * 3 },
    ])('ends the source exactly once, $pulled rows pulled, when the body is $when', async ({ act, pulled }) => {
      const { rows, seen } = trackedRows(kind, LEGACY_CSV_BATCH_ROWS * 3);
      const { body } = await legacyUsersCsvStream(['fname'], rows);
      act(body);
      await once(body, 'close');
      expect(seen).toEqual({ pulled, released: 1 });
    });
  });

  it('ends the row source once its pull in flight settles when the body is destroyed mid-stream', async () => {
    let released = 0;
    let pulling = (): void => undefined;
    const pulled = new Promise<void>((resolve) => {
      pulling = resolve;
    });
    let resume = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    async function* source(): AsyncGenerator<Row> {
      try {
        yield* nameRows(LEGACY_CSV_BATCH_ROWS);
        pulling();
        await held;
        yield* nameRows(LEGACY_CSV_BATCH_ROWS * 2);
      } finally {
        released += 1;
      }
    }
    const { body } = await legacyUsersCsvStream(['fname'], source());
    const chunks: string[] = [];
    body.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    await pulled;
    body.destroy();
    resume();
    await once(body, 'close');
    expect(released).toBe(1);
    expect(chunks).toHaveLength(1);
  });

  it.each([
    { how: 'without an error', cause: undefined, expected: new Error('cursor close failed') },
    { how: 'with an error of its own', cause: new Error('client gone'), expected: new Error('client gone') },
  ])('errors the body without an unhandled rejection when the row source fails to end on a destroy $how', async ({ cause, expected }) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const { body } = await legacyUsersCsvStream(['fname'], unreleasable(LEGACY_CSV_BATCH_ROWS * 2, new Error('cursor close failed')));
      const errored = once(body, 'error') as Promise<[unknown]>;
      body.destroy(cause);
      const [streamError] = await errored;
      await delay(20);
      expect(streamError).toEqual(expected);
      expect(body.destroyed).toBe(true);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
