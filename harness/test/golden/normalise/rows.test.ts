import { randomUUID } from 'node:crypto';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { decodeRow, encodeRow, type CanonicalColumn, type CanonicalValue } from '@opt2/platform/migration-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createIdOrdinals, ordinalFor } from '../../../src/golden/normalise/ids.js';
import { loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import {
  compareRows,
  normaliseRows,
  type NormalisedRows,
  type NormalisedTable,
  type RowComparison,
} from '../../../src/golden/normalise/rows.js';
import type { RowSnapshot } from '../../../src/golden/side-effects.js';

const PERSON = 'people.person';
const GROUP = 'identity.group_account';
// Sorts after `people.person`, so an archive unit on one side only cannot shift the person ordinals.
const ARCHIVE = 'people.person_archive';
const SITE = 'tenant-a';
const SAVED_AT = '2026-06-30 09:15:00';
const TIMESTAMP = '<ts:iso-local>';
const EQUAL: RowComparison = { missing: [], extra: [], checksumEqual: true };

const COLUMNS: CanonicalColumn[] = [
  { name: 'UserID', type: 's' },
  { name: 'SiteID', type: 's' },
  { name: 'Fname', type: 's' },
  { name: 'LastUpdate', type: 't' },
  { name: 'LastUpdateByID', type: 's' },
  { name: 'InActive', type: 'i' },
];
// effectiveFrom is a date-only field, compared literally.
const ARCHIVE_COLUMNS: CanonicalColumn[] = [
  { name: 'UserID', type: 's' },
  { name: 'effectiveFrom', type: 't' },
];
// A masked timestamp column holds its placeholder, which is text.
const OUTPUT_COLUMNS: CanonicalColumn[] = COLUMNS.map((column) =>
  column.name === 'LastUpdate' ? { name: 'LastUpdate', type: 's' } : column,
);

type PersonRow = {
  UserID: string;
  SiteID: string;
  Fname: string | null;
  LastUpdate: string | Date | null;
  LastUpdateByID: string;
  InActive: number;
};

type SnapshotUnit = Partial<Pick<RowSnapshot, 'unit' | 'legacyTable' | 'columns'>>;

let rules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
});

/** A tenant-a person row with fresh CF UUIDs, saved at `SAVED_AT` unless overridden. */
function person(Fname: string | null, overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    UserID: cfUuid(),
    SiteID: SITE,
    Fname,
    LastUpdate: SAVED_AT,
    LastUpdateByID: cfUuid(),
    InActive: 0,
    ...overrides,
  };
}

/** Snapshot of `rows` as canonical encodings, in input order; the sample unit `people.person` unless overridden. */
function snapshot(rows: readonly Readonly<Record<string, unknown>>[], of: SnapshotUnit = {}): RowSnapshot {
  const columns = of.columns ?? COLUMNS;
  return {
    unit: of.unit ?? PERSON,
    owner: (of.unit ?? PERSON).split('.')[0] ?? '',
    legacyTable: of.legacyTable ?? 'tusers',
    columns,
    keyColumns: [columns[0]?.name ?? ''],
    keyless: false,
    rows: rows.map((row) => encodeRow(columns, row)),
  };
}

/** One scenario side's normalised rows of `snapshots`, with fresh id ordinals. */
function normalise(...snapshots: RowSnapshot[]): NormalisedRows {
  return normaliseRows(Object.fromEntries(snapshots.map((s) => [s.unit, s])), createIdOrdinals(), rules);
}

/** The normalised table of `unit`; fails the test when it is absent. */
function tableOf(rows: NormalisedRows, unit = PERSON): NormalisedTable {
  const table = rows[unit];
  if (table === undefined) throw new Error(`no normalised table for ${unit}`);
  return table;
}

/** Decoded values of each distinct normalised encoding of `table`. */
function decoded(table: NormalisedTable): Record<string, CanonicalValue>[] {
  return table.entries.map(({ encoding }) => decodeRow(table.columns, encoding));
}

/** Encoding a person row normalises to, given the ordinals of its `UserID` and `LastUpdateByID`. */
function normalisedPerson(Fname: string | null, user: number, editor: number, overrides: Partial<PersonRow> = {}): string {
  return encodeRow(OUTPUT_COLUMNS, {
    UserID: `<id:${String(user)}>`,
    SiteID: SITE,
    Fname,
    LastUpdate: TIMESTAMP,
    LastUpdateByID: `<id:${String(editor)}>`,
    InActive: 0,
    ...overrides,
  });
}

describe('normaliseRows multisets', () => {
  it.each<[golden: number, replay: number]>([
    [2, 1],
    [3, 1],
    [1, 2],
    [2, 2],
  ])('counts %i identical golden rows against %i replay rows, one list element per occurrence', (g, r) => {
    const row = person('Ada');
    const replayRow = person('Ada');
    const golden = normalise(snapshot(Array.from({ length: g }, () => row)));
    const replay = normalise(snapshot(Array.from({ length: r }, () => replayRow)));
    const encoding = normalisedPerson('Ada', 1, 2);
    expect(tableOf(golden).entries).toEqual([{ encoding, count: g }]);
    const occurrences = (n: number): string[] => Array.from({ length: Math.max(n, 0) }, () => encoding);
    expect(compareRows(golden, replay)).toEqual({
      [PERSON]: { missing: occurrences(g - r), extra: occurrences(r - g), checksumEqual: g === r },
    });
    expect(compareRows(replay, golden)).toEqual({
      [PERSON]: { missing: occurrences(r - g), extra: occurrences(g - r), checksumEqual: g === r },
    });
  });
});

describe('normaliseRows masking', () => {
  it('replaces CF UUIDs with ordinals, so rows with other ids in the same roles compare equal', () => {
    const golden = normalise(snapshot([person('Ada'), person('Bea')]));
    const replay = normalise(snapshot([person('Ada'), person('Bea')]));
    expect(tableOf(golden).entries).toEqual([
      { encoding: normalisedPerson('Ada', 1, 2), count: 1 },
      { encoding: normalisedPerson('Bea', 3, 4), count: 1 },
    ]);
    expect(compareRows(golden, replay)).toEqual({ [PERSON]: EQUAL });
  });

  it('masks LastUpdate instants as their format class, so rows saved at other times compare equal', () => {
    const golden = normalise(snapshot([person('Ada', { LastUpdate: SAVED_AT })]));
    const replay = normalise(snapshot([person('Ada', { LastUpdate: new Date(2026, 6, 1, 17, 42, 13, 250) })]));
    expect(tableOf(golden).columns).toEqual(OUTPUT_COLUMNS);
    expect(decoded(tableOf(replay)).map((row) => row.LastUpdate)).toEqual([TIMESTAMP]);
    expect(compareRows(golden, replay)).toEqual({ [PERSON]: EQUAL });
  });

  it('gives an id repeated across rows one ordinal on both sides', () => {
    const goldenEditor = cfUuid();
    const replayEditor = cfUuid();
    const golden = normalise(
      snapshot([person('Ada', { LastUpdateByID: goldenEditor }), person('Bea', { LastUpdateByID: goldenEditor })]),
    );
    const replay = normalise(
      snapshot([person('Bea', { LastUpdateByID: replayEditor }), person('Ada', { LastUpdateByID: replayEditor })]),
    );
    expect(decoded(tableOf(golden)).map((row) => [row.UserID, row.LastUpdateByID])).toEqual([
      ['<id:1>', '<id:2>'],
      ['<id:3>', '<id:2>'],
    ]);
    expect(compareRows(golden, replay)).toEqual({ [PERSON]: EQUAL });
  });

  it('tells a shared id apart from distinct ids in the same column', () => {
    const editor = cfUuid();
    const golden = normalise(
      snapshot([person('Ada', { LastUpdateByID: editor }), person('Bea', { LastUpdateByID: editor })]),
    );
    const replay = normalise(snapshot([person('Ada'), person('Bea')]));
    expect(compareRows(golden, replay)).toEqual({
      [PERSON]: { missing: [normalisedPerson('Bea', 3, 2)], extra: [normalisedPerson('Bea', 3, 4)], checksumEqual: false },
    });
  });

  it('keeps ordinals the scenario assigned in earlier steps and numbers new ids after them', () => {
    const side = (admin: string): { rows: NormalisedRows; next: number } => {
      const state = createIdOrdinals();
      ordinalFor(admin, state, rules.ids);
      const rows = normaliseRows(
        { [PERSON]: snapshot([person('Bea', { LastUpdateByID: admin }), person('Ada', { LastUpdateByID: admin })]) },
        state,
        rules,
      );
      return { rows, next: state.next };
    };
    const golden = side(cfUuid());
    const replay = side(cfUuid());
    expect(decoded(tableOf(golden.rows)).map((row) => [row.UserID, row.LastUpdateByID])).toEqual([
      ['<id:2>', '<id:1>'],
      ['<id:3>', '<id:1>'],
    ]);
    expect(golden.next).toBe(4);
    expect(compareRows(golden.rows, replay.rows)).toEqual({ [PERSON]: EQUAL });
  });

  it.each<[title: string, legacyTable: string, column: CanonicalColumn, value: unknown, expected: CanonicalValue]>([
    ['a whole timestamp in a text column is masked', 'tusers', { name: 'notes', type: 's' }, SAVED_AT, '<ts:jdbc-timestamp>'],
    ['a serialized document keeps a timestamp byte-exact', 'ttrash', { name: 'objectString', type: 's' }, SAVED_AT, SAVED_AT],
    [
      'ids inside a serialized document become ordinals',
      'dbo.[ttrash]',
      { name: 'objectString', type: 's' },
      `<wddxPacket><string>${cfUuid()}</string></wddxPacket>`,
      '<wddxPacket><string><id:1></string></wddxPacket>',
    ],
    ['an RFC 4122 uuid takes its own ordinal', 'tusers', { name: 'remoteID', type: 's' }, randomUUID(), '<uuid:1>'],
    [
      'a date-only timestamp column stays literal',
      'Program_1.blackout',
      { name: 'effective_from', type: 't' },
      '2026-06-30 00:00:00',
      '2026-06-30T00:00:00.000',
    ],
    ['a four-decimal money string stays literal', 'Program_1.finance_record', { name: 'amount', type: 's' }, '1250.5000', '1250.5000'],
    ['an integer stays literal', 'tusers', { name: 'InActive', type: 'i' }, 1, '1'],
    ['a null stays null', 'tusers', { name: 'Fname', type: 's' }, null, null],
  ])('%s', (_title, legacyTable, column, value, expected) => {
    const table = tableOf(normalise(snapshot([{ [column.name]: value }], { legacyTable, columns: [column] })));
    expect(decoded(table)).toEqual([{ [column.name]: expected }]);
    expect(table.columns).toEqual([column]);
  });
});

describe('normaliseRows ordering', () => {
  it('normalises the same rows identically whatever their input order', () => {
    const ada = person('Ada');
    const bea = person('Bea');
    const cyd = person('Cyd');
    const forward = normalise(snapshot([ada, bea, cyd]));
    expect(normalise(snapshot([cyd, bea, ada]))).toEqual(forward);
    expect(normalise(snapshot([bea, cyd, ada]))).toEqual(forward);
  });

  it('compares replay rows in another order as equal', () => {
    const golden = normalise(snapshot([person('Ada'), person('Bea'), person('Cyd')]));
    const replay = normalise(snapshot([person('Cyd'), person('Ada'), person('Bea')]));
    expect(tableOf(golden).checksum).toBe(tableOf(replay).checksum);
    expect(compareRows(golden, replay)).toEqual({ [PERSON]: EQUAL });
  });

  it('returns units in sorted order', () => {
    const rows = normalise(snapshot([person('Ada')]), snapshot([person('Admins')], { unit: GROUP }));
    expect(Object.keys(rows)).toEqual([GROUP, PERSON]);
    expect(tableOf(rows, GROUP)).toMatchObject({ unit: GROUP, legacyTable: 'tusers' });
  });
});

describe('compareRows differences', () => {
  it.each<[change: string, replayBea: Partial<PersonRow>, expected: string]>([
    ['Fname', { Fname: 'Bia' }, normalisedPerson('Bia', 3, 4)],
    ['InActive', { InActive: 1 }, normalisedPerson('Bea', 3, 4, { InActive: 1 })],
    ['LastUpdate cleared', { LastUpdate: null }, normalisedPerson('Bea', 3, 4, { LastUpdate: null })],
  ])('reports a changed %s as one missing and one extra occurrence', (_change, replayBea, expected) => {
    const golden = normalise(snapshot([person('Ada'), person('Bea')]));
    const replay = normalise(snapshot([person('Ada'), person('Bea', replayBea)]));
    expect(compareRows(golden, replay)).toEqual({
      [PERSON]: { missing: [normalisedPerson('Bea', 3, 4)], extra: [expected], checksumEqual: false },
    });
  });

  it('compares each unit independently', () => {
    const golden = normalise(snapshot([person('Ada')]), snapshot([person(null)], { unit: GROUP }));
    const replay = normalise(snapshot([person('Ada')]), snapshot([person(null, { InActive: 1 })], { unit: GROUP }));
    expect(compareRows(golden, replay)).toEqual({
      [GROUP]: {
        missing: [normalisedPerson(null, 1, 2)],
        extra: [normalisedPerson(null, 1, 2, { InActive: 1 })],
        checksumEqual: false,
      },
      [PERSON]: EQUAL,
    });
  });

  it('reports every row of a unit present on one side only, its ids sharing the earlier units ordinals', () => {
    const ada = person('Ada');
    const archive = (UserID: string, effectiveFrom: string): Record<string, string> => ({ UserID, effectiveFrom });
    const both = normalise(
      snapshot([ada]),
      snapshot([archive(ada.UserID, '2026-06-30 00:00:00'), archive(cfUuid(), '2026-07-01 00:00:00')], {
        unit: ARCHIVE,
        legacyTable: 'synthetic.person_archive',
        columns: ARCHIVE_COLUMNS,
      }),
    );
    const personOnly = normalise(snapshot([person('Ada')]));
    const archiveRows = [
      encodeRow(ARCHIVE_COLUMNS, archive('<id:1>', '2026-06-30T00:00:00.000')),
      encodeRow(ARCHIVE_COLUMNS, archive('<id:3>', '2026-07-01T00:00:00.000')),
    ];
    expect(compareRows(both, personOnly)).toEqual({
      [PERSON]: EQUAL,
      [ARCHIVE]: { missing: archiveRows, extra: [], checksumEqual: false },
    });
    expect(compareRows(personOnly, both)).toEqual({
      [PERSON]: EQUAL,
      [ARCHIVE]: { missing: [], extra: archiveRows, checksumEqual: false },
    });
  });

  it('finds no difference between empty snapshots', () => {
    const golden = normalise(snapshot([]));
    expect(tableOf(golden).entries).toEqual([]);
    expect(compareRows(golden, normalise(snapshot([])))).toEqual({ [PERSON]: EQUAL });
    expect(compareRows({}, {})).toEqual({});
  });
});
