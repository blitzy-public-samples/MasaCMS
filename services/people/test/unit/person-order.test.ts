/** People repository `pagePersonsInOrder` against PostgreSQL: the people domain's comparator order, keyset pages, scope filters and plan. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { cfNumberString, cfUuid } from '@opt2/platform/legacy-compat';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  LEGACY_CHAR_CI_COLLATION,
  LEGACY_TEXT_ORDER_COLLATION,
  PERSON_LAST_NAME_ORDER,
  PERSON_NAME_ORDER,
  createPeopleRepository,
  type PeopleRepository,
  type PersonCursor,
  type PersonOrderScope,
  type PersonSortKey,
} from '../../src/repo/repository.js';
import { PEOPLE_UNITS, type PersonRow } from '../../src/repo/tables.js';

/** One stored person of the order corpus. */
interface CorpusRow {
  userid: string;
  lname: string | null;
  fname: string | null;
  created: Date | null;
  ext: number | null;
}

// Replicates text, compareText, compareSql and compareCandidates of src/domain/search.ts exactly.
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? '' : String(value);
}

const COLLATOR = new Intl.Collator('en-US', { sensitivity: 'accent' });

function compareText(a: string, b: string): number {
  return COLLATOR.compare(a.replace(/ +$/, ''), b.replace(/ +$/, ''));
}

function compareSql(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return compareText(text(a), text(b));
}

function compareCandidates(a: CorpusRow, b: CorpusRow, keys: readonly PersonSortKey[]): number {
  for (const key of keys) {
    const order = compareSql((a as unknown as Record<string, unknown>)[key.column], (b as unknown as Record<string, unknown>)[key.column]);
    if (order !== 0) return key.descending ? -order : order;
  }
  return compareSql(a.userid, b.userid);
}

/** Case, accent, ligature, compatibility, script, punctuation, whitespace, combining-mark, emoji and NULL edge cases. */
const CURATED: readonly (string | null)[] = [
  'Smith', 'smith', 'SMITH', 'Smíth', 'Smith ', 'Smith  ', "O'Brien", 'OBrien', 'O Brien', "o'brien", 'de la Cruz', 'Dela Cruz', 'DelaCruz',
  'Lee-Smith', 'Lee Smith', 'LeeSmith', "Lee'Smith", 'Müller', 'Muller', 'Mueller', 'Ångström', 'Angstrom', 'Zoë', 'Zoe', 'Æsir', 'Aesir',
  'Øre', 'Ore', 'ß', 'ss', 'SS', 'Straße', 'Strasse', 'İstanbul', 'Istanbul', 'ıstanbul', 'Łukasz', 'Lukasz', 'Đorđe', 'Dorde', 'Þór', 'Thor',
  'ñandu', 'nandu', 'Ñandu', 'Ŝ', '中文', '日本', '한국', 'Ελλάδα', 'ελλάδα', 'Россия', 'россия', '123', '12', '1a', 'a1', '-dash', '_under',
  '(paren)', '!bang', '[bracket]', '\\back', ' lead', '', ' ', '   ', 'a', 'A', 'á', 'Á', 'à', 'â', 'ä', 'ã', 'å', 'ą', 'æ', 'ç', 'č', 'ć',
  'ď', 'é', 'è', 'ê', 'ë', 'ě', 'ę', 'ğ', 'í', 'ì', 'î', 'ï', 'ł', 'ń', 'ň', 'ó', 'ò', 'ô', 'ö', 'õ', 'ø', 'œ', 'ř', 'ś', 'š', 'ş', 'ť', 'ú',
  'ù', 'û', 'ü', 'ů', 'ý', 'ÿ', 'ž', 'ź', 'ż', '\u01C4', '\u01C5', '\u01C6', '\uFB01', 'fi', '\u2168', 'IX', '\u2460', '1', 'K', '\u212A',
  '\u00C5', '\u212B', '\u03A9', '\u2126', '\u00B5', '\u03BC', '\u017F', 's', '\uFB00', 'ff', 'x\u0301', '\u00E1', 'a\u0301', 'tab\tx',
  'trail\t', 'new\nline', '\u{1F600}', '\u{1F600}a', 'a\u{1F600}', '\u200Bzw', 'zw', null, null,
];

/** Seeded random names over ASCII, Latin-1 letters, space, apostrophe, hyphen, punctuation and digits. */
function randomNames(count: number): string[] {
  const pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZáéíóúüñçßøåæœÀÉÖÜ '-.,0123456789";
  let seed = 7;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: count }, () => Array.from({ length: 1 + Math.floor(next() * 8) }, () => pool[Math.floor(next() * pool.length)]).join(''));
}

/** Every code point U+0020..U+2FFF followed by 'x'. */
function codePointNames(): string[] {
  return Array.from({ length: 0x3000 - 0x20 }, (_, index) => `${String.fromCodePoint(0x20 + index)}x`);
}

/** Userid leads whose collated order differs from their byte order. */
const USERID_LEADS = ['b', 'A', 'c', 'Á', 'D', 'é', '_', 'z', 'Z9', '0'];
const CORPUS_START = Date.UTC(2026, 0, 5, 8, 0, 0);
/** Time for one pass over the corpus, a page of 37 per query. */
const CORPUS_TIMEOUT = 300_000;

/** The corpus: one person per name, with first names, created times and ext values that repeat, so ties reach the userid. */
function corpus(): CorpusRow[] {
  const names = [...CURATED, ...randomNames(6000), ...codePointNames()];
  return names.map((lname, index) => ({
    userid: `${USERID_LEADS[index % USERID_LEADS.length]}-${String(index).padStart(5, '0')}`,
    lname,
    fname: index % 17 === 0 ? null : (names[(index * 7919 + 13) % names.length] ?? null),
    created: index % 9 === 0 ? null : new Date(CORPUS_START + (index % 401) * 60_000),
    ext: index % 13 === 0 ? null : ((index * 31) % 47) - 20,
  }));
}

/** A stored userid without its char(35) padding. */
function unpadded(userid: string): string {
  return userid.replace(/ +$/, '');
}

const available = await pgAvailable();

describe.skipIf(!available)('pagePersonsInOrder against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: PeopleRepository;
  const rows = corpus();

  /** Inserts persons straight into the throwaway table of `tenant`, NULLs kept. */
  async function insert(tenant: string, people: readonly (Partial<PersonRow> & { userid: string })[]): Promise<void> {
    const columns = ['userid', 'siteid', 'lname', 'fname', 'company', 'email', 'jobtitle', 'created', 'ext'] as const;
    const types = ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamp', 'integer'];
    const unnest = columns.map((_, index) => `$${index + 2}::${types[index]}[]`).join(', ');
    for (let start = 0; start < people.length; start += 2000) {
      const chunk = people.slice(start, start + 2000);
      const params = columns.map((column) => chunk.map((person) => person[column] ?? null));
      await handle.app.withTenant(tenant, (tx) =>
        tx.query(`INSERT INTO "${handle.schema}".person (tenant_id, ${columns.join(', ')}) SELECT $1::uuid, u.* FROM unnest(${unnest}) AS u`, [
          tenant,
          ...params,
        ]),
      );
    }
  }

  /** Every person of `scope` in `tenant`, read a page of `limit` at a time, each page in its own transaction. */
  async function readAll(scope: PersonOrderScope, orderBy: readonly PersonSortKey[], limit: number, tenant = TENANT_B.tenantId): Promise<PersonRow[]> {
    const read: PersonRow[] = [];
    let after: PersonCursor | null = null;
    do {
      const page = await handle.app.withTenant(tenant, (tx) => repo.pagePersonsInOrder(tx, scope, { orderBy, after, limit }));
      expect(page.rows.length).toBeLessThanOrEqual(limit);
      read.push(...page.rows);
      after = page.next;
    } while (after !== null);
    return read;
  }

  /** Userids of the persons of `scope` in tenant A, in order. */
  async function idsOf(scope: PersonOrderScope, orderBy: readonly PersonSortKey[] = PERSON_NAME_ORDER, limit = 1000): Promise<string[]> {
    return (await readAll(scope, orderBy, limit, TENANT_A.tenantId)).map((row) => unpadded(row.userid));
  }

  /** The statements on the person table that `call` issues on `tx`, with their parameters. */
  async function personStatements(tx: TenantTx, call: (tx: TenantTx) => Promise<unknown>): Promise<[string, unknown[]][]> {
    const issued: [string, unknown[]][] = [];
    const recording: TenantTx = {
      ...tx,
      query(text, values) {
        issued.push([text as string, values ?? []]);
        return tx.query(text, values);
      },
    };
    await call(recording);
    return issued.filter(([sql]) => sql.includes(`"${handle.schema}"."person"`));
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'person-order-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'person-order-test', state: 'open' });
    repo = createPeopleRepository({ clock: fixedClock(new Date(CORPUS_START)), schema: handle.schema });
    await insert(TENANT_B.tenantId, rows.map((row) => ({ ...row, siteid: 'corpus' })));
    // Only the table owner may ANALYZE.
    const client = await handle.migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE "${handle.roles.owner}"`);
      await client.query(`ANALYZE "${handle.schema}".person`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('creates the collation as the ICU case-insensitive, accent-sensitive root order', async () => {
    const found = await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query(
        'SELECT collprovider, collisdeterministic, colliculocale FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace' +
          ' WHERE n.nspname = $1 AND c.collname = $2',
        [handle.schema, LEGACY_TEXT_ORDER_COLLATION],
      ),
    );
    expect(found.rows).toEqual([{ collprovider: 'i', collisdeterministic: false, colliculocale: 'und-u-ks-level2' }]);
  });

  it.each<[string, readonly PersonSortKey[], number]>([
    ['last then first name', PERSON_NAME_ORDER, 37],
    ['last name', PERSON_LAST_NAME_ORDER, 37],
    ['first name descending, then last name', [{ column: 'fname', descending: true }, { column: 'lname', descending: false }], 37],
    ['created, then last name descending', [{ column: 'created', descending: false }, { column: 'lname', descending: true }], 37],
    ['ext descending', [{ column: 'ext', descending: true }], 37],
  ])('pages the corpus by %s exactly as the domain comparator sorts it', async (_label, orderBy, limit) => {
    const expected = [...rows].sort((a, b) => compareCandidates(a, b, orderBy)).map((row) => row.userid);
    const paged = (await readAll({}, orderBy, limit)).map((row) => unpadded(row.userid));
    expect(paged).toHaveLength(expected.length);
    const at = paged.findIndex((userid, index) => userid !== expected[index]);
    const byId = new Map(rows.map((row) => [row.userid, row]));
    expect(at === -1 ? null : { at, paged: byId.get(paged[at] ?? ''), expected: byId.get(expected[at] ?? '') }).toBeNull();
  }, CORPUS_TIMEOUT);

  describe('ties', () => {
    const suffix = cfUuid().slice(0, 8);
    const site = `tie-${suffix}`;
    const id = (lead: string): string => `${lead}-tie-${suffix}`;
    // Equal last names under the collation, a later first name, then an accented name that does not tie.
    const people = [
      { userid: id('b'), lname: 'Smith', fname: null },
      { userid: id('A'), lname: 'smith ', fname: null },
      { userid: id('e'), lname: 'SMITH', fname: null },
      { userid: id('D'), lname: 'Smith  ', fname: null },
      { userid: id('c'), lname: 'sMiTh', fname: null },
      { userid: id('f'), lname: 'smith', fname: 'x' },
      { userid: id('0'), lname: 'Smíth', fname: null },
    ];

    beforeAll(async () => {
      await insert(TENANT_A.tenantId, people.map((person) => ({ ...person, siteid: site })));
    });

    it.each([1, 2, 3])('keeps the collated userid order of equal names across pages of %i', async (limit) => {
      const expected = ['A', 'b', 'c', 'D', 'e', 'f', '0'].map(id);
      expect(await idsOf({ siteIds: [site] }, PERSON_NAME_ORDER, limit)).toEqual(expected);
      expect(await idsOf({ siteIds: [site] }, PERSON_LAST_NAME_ORDER, limit)).toEqual(expected);
    });

    it('keeps every id equal under the collation across pages, in one stable order', async () => {
      const tied = { siteIds: [`fold-${suffix}`] };
      const ids = [`\uFB01-${suffix}`, `fi-${suffix}`];
      await insert(TENANT_A.tenantId, ids.map((userid) => ({ userid, siteid: `fold-${suffix}`, lname: 'Same' })));
      const onePerPage = await idsOf(tied, PERSON_NAME_ORDER, 1);
      expect([...onePerPage].sort()).toEqual([...ids].sort());
      expect(await idsOf(tied, PERSON_NAME_ORDER, 10)).toEqual(onePerPage);
    });

    it('rejects a cursor of another ordering', async () => {
      const page = await handle.app.withTenant(TENANT_A.tenantId, (tx) => repo.pagePersonsInOrder(tx, { siteIds: [site] }, { orderBy: PERSON_LAST_NAME_ORDER, limit: 1 }));
      await expect(
        handle.app.withTenant(TENANT_A.tenantId, (tx) => repo.pagePersonsInOrder(tx, { siteIds: [site] }, { orderBy: PERSON_NAME_ORDER, after: page.next })),
      ).rejects.toThrow(RangeError);
    });
  });

  describe('scope', () => {
    const suffix = cfUuid().slice(0, 8);
    const id = (name: string): string => `${name}-${suffix}`;
    const likeSite = `like-${suffix}`;

    beforeAll(async () => {
      await insert(TENANT_A.tenantId, [
        { userid: id('s1'), siteid: `S1-${suffix}`, lname: 'One' },
        { userid: id('s1b'), siteid: `s1-${suffix}  `, lname: 'Two' },
        { userid: id('s2'), siteid: `S2-${suffix}`, lname: 'Three' },
        { userid: id('blank-site'), siteid: '', lname: 'Four' },
        { userid: id('null-site'), siteid: null, lname: 'Five' },
        { userid: id('smith'), siteid: likeSite, lname: 'Smith', company: 'Back\\Slash' },
        { userid: id('jones'), siteid: likeSite, lname: 'Jones', jobtitle: 'Smithy' },
        { userid: id('bracket'), siteid: likeSite, lname: '[abc]x' },
        { userid: id('emile'), siteid: likeSite, lname: 'Émile', fname: 'Ann' },
        { userid: id('email'), siteid: likeSite, lname: null, fname: null, email: 'other@example.com' },
        { userid: id('blank'), siteid: likeSite, lname: null, fname: null, company: null, email: null, jobtitle: null },
      ]);
    });

    it.each<[string, readonly string[], readonly string[]]>([
      ['one site under any case and trailing spaces', ['s1-SUFFIX '], ['s1', 's1b']],
      ['any of several sites', ['S2-SUFFIX', 's1-suffix'], ['s1', 's1b', 's2']],
      ['the empty site id', [''], ['blank-site']],
      ['no site for an empty list', [], []],
    ])('reads %s', async (_label, siteIds, expected) => {
      const found = await idsOf({ siteIds: siteIds.map((siteId) => siteId.replace(/suffix/i, suffix)) });
      expect(found.sort()).toEqual(expected.map(id).sort());
    });

    it.each<[string, string, readonly string[] | undefined, readonly string[]]>([
      ['ASCII case folded', '%SMITH%', undefined, ['smith', 'jones']],
      ['non-ASCII case kept', '%émile%', undefined, []],
      ['ASCII letters folded beside kept accents', '%Émi%E%', undefined, ['emile']],
      ['% matching any run', 'S%th', undefined, ['smith']],
      ['_ matching one character', 'j_nes', undefined, ['jones']],
      ['[ literal', '%[a%', undefined, ['bracket']],
      ['no bracket class', '[s]mith', undefined, []],
      ['backslash literal', '%k\\s%', undefined, ['smith']],
      ['NULL columns skipped', '%', undefined, ['smith', 'jones', 'bracket', 'emile', 'email']],
      ['email alone', '%OTHER@%', undefined, ['email']],
      ['orUserIds under any case and trailing spaces', 'nomatch', ['BLANK-SUFFIX  '], ['blank']],
      ['orUserIds beside pattern matches', 'j%', ['blank-suffix'], ['jones', 'blank']],
      ['an empty orUserIds', 'nomatch', [], []],
    ])('prefilters %s', async (_label, pattern, orUserIds, expected) => {
      const nameLike = { pattern, ...(orUserIds === undefined ? {} : { orUserIds: orUserIds.map((userId) => userId.replace(/suffix/i, suffix)) }) };
      const found = await idsOf({ siteIds: [likeSite], nameLike });
      expect(found.sort()).toEqual(expected.map(id).sort());
    });

    it('adds no userid term for an empty orUserIds', async () => {
      const issued = await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
        personStatements(tx, (recording) => repo.pagePersonsInOrder(recording, { nameLike: { pattern: '%', orUserIds: [] } }, { orderBy: PERSON_NAME_ORDER })),
      );
      expect(issued).toHaveLength(1);
      expect(issued[0]?.[0]).not.toContain(LEGACY_CHAR_CI_COLLATION);
      expect(issued[0]?.[1]).toHaveLength(3);
    });

    it('matches a backtracking-heavy pattern against 255-character runs well under a second', async () => {
      const run = 'a'.repeat(255);
      const site = `redos-${suffix}`;
      await insert(TENANT_A.tenantId, [
        { userid: id('run'), siteid: site, lname: run, fname: run, company: run, email: run, jobtitle: run },
        { userid: id('run-b'), siteid: site, lname: `${'a'.repeat(254)}b` },
      ]);
      const started = performance.now();
      const found = await idsOf({ siteIds: [site], nameLike: { pattern: `${'a%'.repeat(12)}b` } });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(found).toEqual([id('run-b')]);
    });

    it('reads only the transaction tenant', async () => {
      const page = await handle.app.withTenant(TENANT_A.tenantId, (tx) => repo.pagePersonsInOrder(tx, {}, { orderBy: PERSON_NAME_ORDER, limit: 1000 }));
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.every((row) => row.tenant_id === TENANT_A.tenantId)).toBe(true);
    });
  });

  it.each<[string, number | undefined, number]>([
    ['500 rows without a limit', undefined, 500],
    ['at most 1000 rows', 5000, 1000],
  ])('pages %s', async (_label, limit, expected) => {
    const page = await handle.app.withTenant(TENANT_B.tenantId, (tx) => repo.pagePersonsInOrder(tx, {}, { orderBy: PERSON_NAME_ORDER, ...(limit === undefined ? {} : { limit }) }));
    expect(page.rows).toHaveLength(expected);
    expect(page.next).not.toBeNull();
    expect(Object.keys(page.rows[0] ?? {}).filter((column) => column.startsWith('__order_'))).toEqual([]);
  });

  it('rejects a limit that is not a positive integer', async () => {
    await expect(handle.app.withTenant(TENANT_B.tenantId, (tx) => repo.pagePersonsInOrder(tx, {}, { orderBy: PERSON_NAME_ORDER, limit: 0 }))).rejects.toThrow(RangeError);
  });

  it.each<[string, boolean]>([
    ['first', false],
    ['next', true],
  ])('reads the %s name-order page in the order of person_tenant_text_name_order_idx without sorting', async (_label, next) => {
    const plan = await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      const after = next ? (await repo.pagePersonsInOrder(tx, {}, { orderBy: PERSON_NAME_ORDER, limit: 37 })).next : null;
      const [statement] = await personStatements(tx, (recording) => repo.pagePersonsInOrder(recording, {}, { orderBy: PERSON_NAME_ORDER, after, limit: 37 }));
      if (statement === undefined) throw new Error('no statement reads person');
      return (await tx.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(`EXPLAIN (FORMAT JSON) ${statement[0]}`, statement[1])).rows;
    });
    const walk = (node: Record<string, unknown>): Record<string, unknown>[] => [node, ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(walk)];
    const nodes = plan.flatMap((row) => row['QUERY PLAN'].flatMap((entry) => walk(entry.Plan)));
    const scan = nodes.find((node) => node['Index Name'] === 'person_tenant_text_name_order_idx');
    expect(String(scan?.['Index Cond'])).toContain('tenant_id = ');
    expect(nodes.filter((node) => String(node['Node Type']).includes('Sort'))).toEqual([]);
  });
});
