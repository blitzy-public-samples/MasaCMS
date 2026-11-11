// Legacy session cookie jar: Set-Cookie absorb and re-emit helpers, and the gateway.legacy_jar store.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCookieLegacy,
  sessionCookieStrings,
  setCookieLegacy,
  type LegacyCookieConfig,
  type LegacyCookieOptions,
} from '@opt2/platform/legacy-compat';
import {
  withMetadata,
  type MetadataTx,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
} from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  absorbLegacySetCookies,
  createLegacyJar,
  isDeletedJarCookie,
  legacyCookieHeader,
  legacySetCookiesFrom,
  requestSessionCookies,
  targetSetCookiesFrom,
  type JarCookie,
  type JarCookies,
  type JarRow,
  type JarUpsert,
  type LegacyJar,
} from '../../src/session/jar.js';

const NOW = new Date(Date.UTC(2026, 5, 30, 12));
const SESSION_ID = 'identity-session-0001';
const LEGACY_SESSION_ID = 'OPT2TEST_1001_12345678';
const LEGACY_TOKENS = { CFID: '1001', CFTOKEN: '12345678', jsessionid: 'node01opt2test' };
const ISSUED: Readonly<Record<string, string>> = { CFID: 'T-CFID', CFTOKEN: 'T-CFTOKEN', JSESSIONID: 'T-JSESSIONID' };
const DEFAULT_TAIL = 'path=/;HttpOnly;';

/** The raw text after the first `;` of a Set-Cookie value. */
const tailOf = (setCookie: string): string => setCookie.slice(setCookie.indexOf(';') + 1);

/** The cookie name of a Set-Cookie value, in the case it was written. */
const nameOf = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf('='));

describe('absorbLegacySetCookies and targetSetCookiesFrom', () => {
  const legacyWrites: Array<[string, LegacyCookieOptions, LegacyCookieConfig]> = [
    ['no expires, domain or secure', { name: 'CFID', value: '1001' }, {}],
    ['an expiry in days', { name: 'CFTOKEN', value: '12345678', expires: 1 }, {}],
    ['the never expiry', { name: 'JSESSIONID', value: 'node01opt2test', expires: 'never' }, {}],
    ['a domain argument', { name: 'CFID', value: '1001', domain: 'example.com' }, {}],
    ['a secure argument', { name: 'CFTOKEN', value: '12345678', secure: true }, {}],
    [
      'configured domain, path and secure',
      { name: 'JSESSIONID', value: 'node01opt2test', expires: 'never' },
      { cookieDomain: '.example.com', cookiePath: '/admin/', secureCookies: true },
    ],
    [
      'a lower-case name kept by maintainCase',
      { name: 'jsessionid', value: 'node01opt2test', maintainCase: true, expires: 30, secure: true },
      {},
    ],
  ];

  it.each(legacyWrites)(
    're-emits a setCookieLegacy cookie with %s under its observed name and byte-identical attributes',
    (_label, options, cfg) => {
      const setCookie = setCookieLegacy(options, cfg, NOW);
      const name = nameOf(setCookie);
      const { sessionCookies, otherSetCookies } = absorbLegacySetCookies([setCookie]);
      expect(otherSetCookies).toEqual([]);
      expect(sessionCookies).toEqual({
        [name.toUpperCase()]: { name, value: options.value, attributes: tailOf(setCookie) },
      });
      expect(targetSetCookiesFrom(sessionCookies, ISSUED, NOW)).toEqual([
        `${name}=${ISSUED[name.toUpperCase()]};${tailOf(setCookie)}`,
      ]);
      expect(legacySetCookiesFrom(sessionCookies)).toEqual([setCookie]);
    },
  );

  it.each([
    [
      'a legacy-form Set-Cookie',
      'CFID=1001;expires=Fri, 30-Jun-2056 12:00:00 GMT;domain=.example.com;path=/;secure;HttpOnly;',
      'expires=Fri, 30-Jun-2056 12:00:00 GMT;domain=.example.com;path=/;secure;HttpOnly;',
    ],
    ['a standard-form Set-Cookie', 'JSESSIONID=node01opt2test; Path=/; Secure; HttpOnly', ' Path=/; Secure; HttpOnly'],
    ['a Set-Cookie with no attributes', 'CFTOKEN=12345678', ''],
  ])('stores the attribute tail verbatim for %s', (_label, setCookie, tail) => {
    const name = nameOf(setCookie);
    expect(absorbLegacySetCookies([setCookie]).sessionCookies[name]?.attributes).toBe(tail);
  });

  it('passes every other Set-Cookie through unchanged and in order', () => {
    const userid = 'userid=9C1D7E2F;expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;';
    const userHash = 'userHash=AB12CD34;path=/;HttpOnly;';
    const lookalike = 'CFIDX=1;path=/;';
    const standard = 'MXP_TRACKINGID=abc; Path=/; SameSite=Lax';
    const { sessionCookies, otherSetCookies } = absorbLegacySetCookies([
      userid,
      'CFID=1001;path=/;HttpOnly;',
      userHash,
      lookalike,
      'CFTOKEN=12345678;path=/;HttpOnly;',
      standard,
    ]);
    expect(otherSetCookies).toEqual([userid, userHash, lookalike, standard]);
    expect(Object.keys(sessionCookies)).toEqual(['CFID', 'CFTOKEN']);
  });

  it.each(['cfid', 'CfId', 'cftoken', 'CFToken', 'jsessionid', 'JSessionID'])(
    'absorbs %s as a session cookie keyed by its upper-case name',
    (name) => {
      const { sessionCookies, otherSetCookies } = absorbLegacySetCookies([`${name}=v1;path=/;HttpOnly;`]);
      expect(otherSetCookies).toEqual([]);
      expect(sessionCookies).toEqual({ [name.toUpperCase()]: { name, value: 'v1', attributes: DEFAULT_TAIL } });
    },
  );

  it('keeps the last Set-Cookie of a session cookie whatever its case', () => {
    const { sessionCookies } = absorbLegacySetCookies(['CFID=1;path=/;HttpOnly;', 'cfid=2;domain=example.com;path=/;']);
    expect(sessionCookies).toEqual({ CFID: { name: 'cfid', value: '2', attributes: 'domain=example.com;path=/;' } });
  });

  it('matches issued values case-insensitively and leaves out cookies identity did not issue', () => {
    const { sessionCookies } = absorbLegacySetCookies([
      'CFID=1001;path=/;HttpOnly;',
      'jsessionid=node01opt2test;path=/;HttpOnly;',
      'CFTOKEN=12345678;path=/;HttpOnly;',
    ]);
    expect(targetSetCookiesFrom(sessionCookies, { cfid: 'T-1', JSESSIONID: 'T-3' }, NOW)).toEqual([
      'CFID=T-1;path=/;HttpOnly;',
      'jsessionid=T-3;path=/;HttpOnly;',
    ]);
  });

  it.each([
    ['deleteCookie', deleteCookieLegacy('CFID', {}, NOW)],
    [
      'deleteCookie with domain and secure config',
      deleteCookieLegacy('CFID', { cookieDomain: '.example.com', secureCookies: true }, NOW),
    ],
    ['an expiry of now', setCookieLegacy({ name: 'CFTOKEN', value: '12345678', expires: 'now' }, {}, NOW)],
    ['an empty value', 'JSESSIONID=; Path=/; HttpOnly'],
    ['a past standard Expires', 'jsessionid=node01opt2test; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'],
  ])('re-emits a legacy deletion by %s as a deletion of the target cookie', (_label, setCookie) => {
    const { sessionCookies } = absorbLegacySetCookies([setCookie]);
    expect(targetSetCookiesFrom(sessionCookies, ISSUED, NOW)).toEqual([`${nameOf(setCookie)}=;${tailOf(setCookie)}`]);
    expect(legacyCookieHeader(sessionCookies, NOW)).toBe('');
  });
});

describe('isDeletedJarCookie', () => {
  it.each<[string, boolean, string, string]>([
    ['a value and no expires', false, '1001', DEFAULT_TAIL],
    ['an empty value', true, '', DEFAULT_TAIL],
    ['an expires after now', false, '1001', 'expires=Tue, 30-Jun-2026 12:00:01 GMT;path=/;'],
    ['an expires exactly at now', true, '1001', 'expires=Tue, 30-Jun-2026 12:00:00 GMT;path=/;'],
    ['an upper-case Expires before now', true, '1001', ' EXPIRES=Mon, 29 Jun 2026 12:00:00 GMT; Path=/'],
    ['an unparseable expires', false, '1001', 'expires=not-a-date;path=/;'],
    ['a valueless expires attribute', false, '1001', 'expires;path=/;'],
  ])('reports a cookie with %s as deleted: %s', (_label, deleted, value, attributes) => {
    expect(isDeletedJarCookie({ name: 'CFID', value, attributes }, NOW)).toBe(deleted);
  });

  it('judges expiry against the current time by default', () => {
    const expiring = (attributes: string): boolean => isDeletedJarCookie({ name: 'CFID', value: '1001', attributes });
    expect(expiring('expires=Thu, 01-Jan-1970 00:00:00 GMT;')).toBe(true);
    expect(expiring('expires=Fri, 31-Dec-9999 23:59:59 GMT;')).toBe(false);
  });
});

describe('legacyCookieHeader and legacySetCookiesFrom', () => {
  it('joins the live jar cookies as name=value pairs in jar order, skipping deletions', () => {
    const { sessionCookies } = absorbLegacySetCookies([
      'CFID=1001;path=/;HttpOnly;',
      'CFTOKEN=;expires=Tue, 30-Jun-2026 12:00:00 GMT;path=/;HttpOnly;',
      'jsessionid=node01opt2test; Path=/; HttpOnly',
    ]);
    expect(legacyCookieHeader(sessionCookies, NOW)).toBe('CFID=1001; jsessionid=node01opt2test');
  });

  it('gives an empty Cookie header and no Set-Cookie values for an empty jar', () => {
    expect(legacyCookieHeader({})).toBe('');
    expect(legacySetCookiesFrom({})).toEqual([]);
  });

  it.each<[string, LegacyCookieConfig]>([
    ['the default config', {}],
    ['session-only expiry', { sessionCookiesExpires: 'session' }],
    [
      'domain, path, secure and day-count config',
      { cookieDomain: '.example.com', cookiePath: '/admin/', secureCookies: true, sessionCookiesExpires: '7' },
    ],
  ])('hands back exactly the Set-Cookie values setSessionCookies wrote under %s', (_label, cfg) => {
    const written = sessionCookieStrings(LEGACY_TOKENS, cfg, NOW);
    const { sessionCookies } = absorbLegacySetCookies(written);
    expect(legacySetCookiesFrom(sessionCookies)).toEqual(written);
    expect(legacyCookieHeader(sessionCookies, NOW)).toBe('CFID=1001; CFTOKEN=12345678; JSESSIONID=node01opt2test');
  });

  it('hands back a stored deletion unchanged', () => {
    const deletion = deleteCookieLegacy('CFID', {}, NOW);
    expect(legacySetCookiesFrom(absorbLegacySetCookies([deletion]).sessionCookies)).toEqual([deletion]);
  });
});

describe('requestSessionCookies', () => {
  it('takes session cookies of any case from the Cookie header with setCookieLegacy default attributes', () => {
    expect(requestSessionCookies('userid=9C1D7E2F; cfid=1001; CFTOKEN=12345678', {}, NOW)).toEqual({
      CFID: { name: 'CFID', value: '1001', attributes: DEFAULT_TAIL },
      CFTOKEN: { name: 'CFTOKEN', value: '12345678', attributes: DEFAULT_TAIL },
    });
  });

  it('reuses the name and attributes of a live observed cookie with the request value', () => {
    const attributes = 'domain=example.com;path=/;secure;HttpOnly;';
    const observed = absorbLegacySetCookies([`jsessionid=old;${attributes}`]).sessionCookies;
    expect(requestSessionCookies('JSESSIONID=node01opt2test', observed, NOW)).toEqual({
      JSESSIONID: { name: 'jsessionid', value: 'node01opt2test', attributes },
    });
  });

  it('falls back to default attributes when the observed cookie is a deletion', () => {
    const deletion = deleteCookieLegacy('cfid', { cookieDomain: 'example.com' }, NOW);
    const observed = absorbLegacySetCookies([deletion]).sessionCookies;
    expect(requestSessionCookies('CFID=1001', observed, NOW)).toEqual({
      CFID: { name: 'CFID', value: '1001', attributes: DEFAULT_TAIL },
    });
  });

  it.each([undefined, '', 'userid=9C1D7E2F; userHash=AB12CD34'])(
    'finds no session cookies in the Cookie header %j',
    (header) => {
      expect(requestSessionCookies(header)).toEqual({});
    },
  );
});

/** A `legacy_jar` row as pg returns it. */
interface JarRecord {
  session_id: string;
  legacy_session_id: string | null;
  cookies: JarCookies;
  mode: JarRow['mode'];
  hydrated_epoch: string | null;
  updated_at: Date;
}

interface RecordedQuery {
  text: string;
  values: unknown[] | undefined;
}

/** TenantDb double: metadata transactions record each statement and answer with the queued result. */
interface FakeDb {
  db: TenantDb;
  queries: RecordedQuery[];
  answer(rows: JarRecord[], rowCount?: number | null): void;
}

const DOUBLE_SCHEMA = 't_gateway_jar';

function fakeDb(): FakeDb {
  const queries: RecordedQuery[] = [];
  let next: { rows: JarRecord[]; rowCount: number | null } = { rows: [], rowCount: 0 };
  const tx: MetadataTx = {
    kind: 'metadata',
    schema: DOUBLE_SCHEMA,
    query: <R extends QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>> => {
      queries.push({ text: (typeof text === 'string' ? text : text.text).replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve({ command: 'SELECT', oid: 0, fields: [], ...next } as unknown as QueryResult<R>);
    },
    onCommit: () => {
      throw new Error('the jar registers no commit callbacks');
    },
  };
  const db: TenantDb = {
    schema: DOUBLE_SCHEMA,
    withTenant: () => Promise.reject(new Error('the jar never acts for a tenant')),
    withMetadata: (fn) => fn(tx),
    end: () => Promise.resolve(),
  };
  return {
    db,
    queries,
    answer(rows, rowCount = rows.length) {
      next = { rows, rowCount };
    },
  };
}

describe('createLegacyJar over a TenantDb double', () => {
  const COLUMNS = 'session_id, legacy_session_id, cookies, mode, hydrated_epoch, updated_at';
  const TABLE = `${DOUBLE_SCHEMA}.legacy_jar`;
  const UPDATED_AT = new Date(Date.UTC(2026, 5, 30, 11, 59));
  const COOKIES = absorbLegacySetCookies(sessionCookieStrings(LEGACY_TOKENS, {}, NOW)).sessionCookies;
  const RECORD: JarRecord = {
    session_id: SESSION_ID,
    legacy_session_id: LEGACY_SESSION_ID,
    cookies: COOKIES,
    mode: 'target-primary',
    hydrated_epoch: '7',
    updated_at: UPDATED_AT,
  };
  const ROW: JarRow = {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    cookies: COOKIES,
    mode: 'target-primary',
    hydratedEpoch: 7,
    updatedAt: UPDATED_AT,
  };

  let fake: FakeDb;
  let jar: LegacyJar;

  beforeEach(() => {
    fake = fakeDb();
    jar = createLegacyJar(fake.db);
  });

  it('reads a jar by identity session id from the handle schema, with the bigint epoch as a number', async () => {
    fake.answer([RECORD]);
    await expect(jar.get(SESSION_ID)).resolves.toEqual(ROW);
    expect(fake.queries).toEqual([
      { text: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = $1`, values: [SESSION_ID] },
    ]);
  });

  it('reads a jar by ColdFusion session id, keeping a null epoch and legacy session id null', async () => {
    fake.answer([{ ...RECORD, legacy_session_id: null, hydrated_epoch: null }]);
    await expect(jar.findByLegacySessionId(LEGACY_SESSION_ID)).resolves.toEqual({
      ...ROW,
      legacySessionId: null,
      hydratedEpoch: null,
    });
    expect(fake.queries).toEqual([
      { text: `SELECT ${COLUMNS} FROM ${TABLE} WHERE legacy_session_id = $1`, values: [LEGACY_SESSION_ID] },
    ]);
  });

  it.each(['get', 'findByLegacySessionId'] as const)('%s resolves undefined when no jar matches', async (method) => {
    fake.answer([]);
    await expect(jar[method]('missing')).resolves.toBeUndefined();
  });

  it('upserts in one statement that merges the cookie map into the stored one, returning the row', async () => {
    const input: JarUpsert = {
      sessionId: SESSION_ID,
      legacySessionId: LEGACY_SESSION_ID,
      cookies: COOKIES,
      mode: 'target-primary',
      hydratedEpoch: 7,
    };
    fake.answer([RECORD]);
    await expect(jar.upsert(input)).resolves.toEqual(ROW);
    expect(fake.queries).toHaveLength(1);
    const [statement] = fake.queries;
    expect(statement?.text).toContain(
      `INSERT INTO ${TABLE} AS jar (${COLUMNS}) VALUES ($1, $2, $3::jsonb, $4, $5, now())`,
    );
    expect(statement?.text).toContain('ON CONFLICT (session_id) DO UPDATE SET');
    expect(statement?.text).toContain('cookies = jar.cookies || EXCLUDED.cookies');
    expect(statement?.text).toContain(`RETURNING ${COLUMNS}`);
    expect(statement?.values).toEqual([SESSION_ID, LEGACY_SESSION_ID, JSON.stringify(COOKIES), 'target-primary', 7]);
  });

  const writes = [
    {
      method: 'setHydratedEpoch',
      call: (j: LegacyJar) => j.setHydratedEpoch(SESSION_ID, 9),
      text: `UPDATE ${TABLE} SET hydrated_epoch = $2, updated_at = now() WHERE session_id = $1`,
      values: [SESSION_ID, 9],
    },
    {
      method: 'drop',
      call: (j: LegacyJar) => j.drop(SESSION_ID),
      text: `DELETE FROM ${TABLE} WHERE session_id = $1`,
      values: [SESSION_ID],
    },
  ];
  const outcomes: Array<{ rowCount: number | null; expected: boolean }> = [
    { rowCount: 1, expected: true },
    { rowCount: 0, expected: false },
    { rowCount: null, expected: false },
  ];

  it.each(writes.flatMap((write) => outcomes.map((outcome) => ({ ...write, ...outcome }))))(
    '$method answers $expected for a row count of $rowCount',
    async ({ call, text, values, rowCount, expected }) => {
      fake.answer([], rowCount);
      await expect(call(jar)).resolves.toBe(expected);
      expect(fake.queries).toEqual([{ text, values }]);
    },
  );
});

const live = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!live)('createLegacyJar against PostgreSQL', () => {
  const CFID: JarCookie = {
    name: 'CFID',
    value: '1001',
    attributes: 'expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;',
  };
  const CFTOKEN: JarCookie = { name: 'CFTOKEN', value: '12345678', attributes: DEFAULT_TAIL };
  const JSESSIONID: JarCookie = { name: 'jsessionid', value: 'node01opt2', attributes: ' Path=/; Secure; HttpOnly' };
  const COOKIES: JarCookies = { CFID, CFTOKEN, JSESSIONID };
  const INPUT: JarUpsert = {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    cookies: COOKIES,
    mode: 'target-primary',
    hydratedEpoch: 3,
  };
  let handle: ThrowawaySchema;
  let jar: LegacyJar;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'gateway',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    jar = createLegacyJar(handle.app);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, (tx) => tx.query(`DELETE FROM ${handle.schema}.legacy_jar`));
  });

  it('stores a jar and reads it back by identity and ColdFusion session id', async () => {
    const written = await jar.upsert(INPUT);
    expect(written).toMatchObject(INPUT);
    expect(written.updatedAt).toBeInstanceOf(Date);
    await expect(jar.get(SESSION_ID)).resolves.toEqual(written);
    await expect(jar.findByLegacySessionId(LEGACY_SESSION_ID)).resolves.toEqual(written);
    await expect(jar.get('missing')).resolves.toBeUndefined();
    await expect(jar.findByLegacySessionId('missing')).resolves.toBeUndefined();
  });

  it('merges upserted cookies into the stored ones and replaces every other column', async () => {
    await jar.upsert({ ...INPUT, cookies: { CFID, CFTOKEN } });
    const renewed: JarCookie = { name: 'cfid', value: '2002', attributes: DEFAULT_TAIL };
    const merged = await jar.upsert({
      sessionId: SESSION_ID,
      legacySessionId: 'OPT2TEST_2002_87654321',
      cookies: { CFID: renewed, JSESSIONID },
      mode: 'legacy-primary',
      hydratedEpoch: null,
    });
    expect(merged).toMatchObject({
      sessionId: SESSION_ID,
      legacySessionId: 'OPT2TEST_2002_87654321',
      cookies: { CFID: renewed, CFTOKEN, JSESSIONID },
      mode: 'legacy-primary',
      hydratedEpoch: null,
    });
    await expect(jar.findByLegacySessionId(LEGACY_SESSION_ID)).resolves.toBeUndefined();
  });

  it('records the hydrated epoch and drops a jar, answering false for an absent one', async () => {
    await jar.upsert(INPUT);
    await expect(jar.setHydratedEpoch(SESSION_ID, 12)).resolves.toBe(true);
    await expect(jar.get(SESSION_ID)).resolves.toMatchObject({ hydratedEpoch: 12 });
    await expect(jar.setHydratedEpoch('missing', 12)).resolves.toBe(false);
    await expect(jar.drop(SESSION_ID)).resolves.toBe(true);
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
    await expect(jar.drop(SESSION_ID)).resolves.toBe(false);
  });
});
