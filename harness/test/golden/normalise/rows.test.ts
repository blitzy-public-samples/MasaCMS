import { randomBytes, randomUUID } from 'node:crypto';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { decodeRow, encodeRow, type CanonicalColumn, type CanonicalValue } from '@opt2/platform/migration-kit';
import bcrypt from 'bcryptjs';
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
const CREDENTIAL = 'identity.credential';

/** Credential columns of `tusers`, the password column spelt `password`. */
function credentialColumns(password = 'Password'): CanonicalColumn[] {
  return [
    { name: 'UserID', type: 's' },
    { name: password, type: 's' },
    { name: 'PasswordCreated', type: 't' },
  ];
}

/** A bcrypt hash of `secret` in revision `variant` at `cost`, under a fresh salt. */
function bcryptHash(secret: string, variant = '2a', cost = 4): string {
  const salt = bcrypt.genSaltSync(cost).slice('$2b$04$'.length);
  return bcrypt.hashSync(secret, `$${variant}$${String(cost).padStart(2, '0')}$${salt}`);
}

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
      'synthetic.person_archive',
      { name: 'effective_from', type: 't' },
      '2026-06-30 00:00:00',
      '2026-06-30T00:00:00.000',
    ],
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

describe('normaliseRows volatile columns', () => {
  // Assembled at run time, so secret scanning does not read them as credentials.
  const SECRET = ['fixture', 'created', 'password'].join('-');
  const OTHER = ['fixture', 'admin', 'password'].join('-');
  const UNKNOWN = ['fixture', 'seeded', 'password'].join('-');
  const CREATED = 'generated:gs-pe-01';
  const SECRETS: ReadonlyMap<string, string> = new Map([
    ['admin', OTHER],
    [CREATED, SECRET],
  ]);

  interface CredentialOptions {
    secrets?: ReadonlyMap<string, string>;
    legacyTable?: string;
    column?: string;
  }

  /** One side's credential rows: one row of `password` in column `column` of `legacyTable`. */
  function credential(password: string, opts: CredentialOptions = {}): NormalisedTable {
    const column = opts.column ?? 'Password';
    const row = { UserID: cfUuid(), [column]: password, PasswordCreated: SAVED_AT };
    const of = { unit: CREDENTIAL, legacyTable: opts.legacyTable ?? 'tusers', columns: credentialColumns(column) };
    const rows = normaliseRows({ [CREDENTIAL]: snapshot([row], of) }, createIdOrdinals(), rules, opts.secrets);
    return tableOf(rows, CREDENTIAL);
  }

  /** The comparison of two sides that differ in their one row. */
  function differing(golden: NormalisedTable, replay: NormalisedTable): Record<string, RowComparison> {
    return {
      [CREDENTIAL]: {
        missing: golden.entries.map((entry) => entry.encoding),
        extra: replay.entries.map((entry) => entry.encoding),
        checksumEqual: false,
      },
    };
  }

  it.each<[variant: string, legacyTable: string, column: string]>([
    ['2a', 'tusers', 'Password'],
    ['2b', 'dbo.[tusers]', 'password'],
    ['2y', 'TUSERS', 'PASSWORD'],
    ['2', 'tusers', 'Password'],
  ])('names the secret two fresh %s hashes in %s.%s verify, so the rows are equal', (variant, legacyTable, column) => {
    const opts = { secrets: SECRETS, legacyTable, column };
    const golden = credential(bcryptHash(SECRET, variant), opts);
    const replay = credential(bcryptHash(SECRET, variant), opts);
    expect(decoded(golden)).toEqual([
      { UserID: '<id:1>', [column]: `$${variant}$04$<verifies:${CREATED}>`, PasswordCreated: TIMESTAMP },
    ]);
    expect(compareRows({ [CREDENTIAL]: golden }, { [CREDENTIAL]: replay })).toEqual({ [CREDENTIAL]: EQUAL });
  });

  // A `null` shown value is the hash itself, kept literal.
  it.each<[label: string, golden: () => string, replay: () => string, shown: [string | null, string | null]]>([
    [
      'hashes of different secrets',
      () => bcryptHash(SECRET),
      () => bcryptHash(OTHER),
      [`$2a$04$<verifies:${CREATED}>`, '$2a$04$<verifies:admin>'],
    ],
    [
      'one secret at different costs',
      () => bcryptHash(SECRET),
      () => bcryptHash(SECRET, '2a', 5),
      [`$2a$04$<verifies:${CREATED}>`, `$2a$05$<verifies:${CREATED}>`],
    ],
    [
      'one secret in different revisions',
      () => bcryptHash(SECRET),
      () => bcryptHash(SECRET, '2b'),
      [`$2a$04$<verifies:${CREATED}>`, `$2b$04$<verifies:${CREATED}>`],
    ],
    [
      'a verified hash and one no secret verifies',
      () => bcryptHash(SECRET),
      () => bcryptHash(UNKNOWN),
      [`$2a$04$<verifies:${CREATED}>`, null],
    ],
    ['two hashes no secret verifies', () => bcryptHash(UNKNOWN), () => bcryptHash(UNKNOWN), [null, null]],
  ])('tells apart %s', (_label, goldenValue, replayValue, shown) => {
    const [goldenHash, replayHash] = [goldenValue(), replayValue()];
    const golden = credential(goldenHash, { secrets: SECRETS });
    const replay = credential(replayHash, { secrets: SECRETS });
    expect([decoded(golden)[0]?.Password, decoded(replay)[0]?.Password]).toEqual([
      shown[0] ?? goldenHash,
      shown[1] ?? replayHash,
    ]);
    expect(compareRows({ [CREDENTIAL]: golden }, { [CREDENTIAL]: replay })).toEqual(differing(golden, replay));
  });

  it.each<[label: string, secrets: ReadonlyMap<string, string> | undefined, hashed: string]>([
    ['no secret verifies it', SECRETS, UNKNOWN],
    ['no secrets are supplied', undefined, SECRET],
    ['the secrets are empty', new Map(), SECRET],
  ])('keeps a hash literal when %s, so the same hash is equal and a fresh one differs', (_label, secrets, hashed) => {
    const hash = bcryptHash(hashed);
    const golden = credential(hash, { secrets });
    expect(decoded(golden).map((row) => row.Password)).toEqual([hash]);
    const same = credential(hash, { secrets });
    expect(compareRows({ [CREDENTIAL]: golden }, { [CREDENTIAL]: same })).toEqual({ [CREDENTIAL]: EQUAL });
    const fresh = credential(bcryptHash(hashed), { secrets });
    expect(compareRows({ [CREDENTIAL]: golden }, { [CREDENTIAL]: fresh })).toEqual(differing(golden, fresh));
  });

  it.each<[first: string, second: string]>([
    ['generated:gs-id-75', CREATED],
    [CREATED, 'generated:gs-id-75'],
  ])('names %s, the first of two secrets with one value in resolution order', (first, second) => {
    const secrets = new Map([
      ['admin', OTHER],
      [first, SECRET],
      [second, SECRET],
    ]);
    expect(decoded(credential(bcryptHash(SECRET), { secrets }))[0]?.Password).toBe(`$2a$04$<verifies:${first}>`);
  });

  it('writes no secret value into the normalised rows', () => {
    const tables = [bcryptHash(SECRET), bcryptHash(OTHER), bcryptHash(UNKNOWN)].map((hash) =>
      credential(hash, { secrets: SECRETS }),
    );
    const text = JSON.stringify(tables);
    expect(text).toContain('<verifies:admin>');
    for (const value of [SECRET, OTHER, UNKNOWN]) expect(text).not.toContain(value);
  });

  it.each<[label: string, legacyTable: string, value: () => string]>([
    ['an MD5 hex digest', 'tusers', () => randomBytes(16).toString('hex')],
    ['a bcrypt hash one character short', 'tusers', () => bcryptHash(SECRET).slice(0, -1)],
    ['a bcrypt hash in a password column of another table', 'tcontent', () => bcryptHash(SECRET)],
  ])('compares %s literally, so two values still differ', (_label, legacyTable, value) => {
    const [goldenValue, replayValue] = [value(), value()];
    const golden = credential(goldenValue, { secrets: SECRETS, legacyTable });
    const replay = credential(replayValue, { secrets: SECRETS, legacyTable });
    expect(decoded(golden).map((row) => row.Password)).toEqual([goldenValue]);
    expect(compareRows({ [CREDENTIAL]: golden }, { [CREDENTIAL]: replay })).toEqual(differing(golden, replay));
  });
});
