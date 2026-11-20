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
  type CommitCallback,
  type MetadataTx,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
} from '@opt2/platform/tenancy';
import type { ServiceClient } from '@opt2/platform/service-kit';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createSessionBarrier } from '../../src/dispatcher/barrier.js';
import {
  JAR_PURGE_BATCH,
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
  type LegacyJarOptions,
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
  /** setSessionCookies' attributes at NOW under Masa's default `sessionCookiesExpires=never`. */
  const WRITTEN_TAIL = tailOf(sessionCookieStrings({ CFID: '', CFTOKEN: '' }, {}, NOW)[0] ?? '');

  it('takes session cookies of any case from the Cookie header with the attributes setSessionCookies writes', () => {
    expect(WRITTEN_TAIL).toBe('expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;');
    expect(requestSessionCookies('userid=9C1D7E2F; cfid=1001; CFTOKEN=12345678; jsessionid=J1', {}, NOW)).toEqual({
      CFID: { name: 'CFID', value: '1001', attributes: WRITTEN_TAIL },
      CFTOKEN: { name: 'CFTOKEN', value: '12345678', attributes: WRITTEN_TAIL },
      JSESSIONID: { name: 'JSESSIONID', value: 'J1', attributes: WRITTEN_TAIL },
    });
  });

  it('reuses the name and attributes of a live observed cookie with the request value', () => {
    const attributes = 'domain=example.com;path=/;secure;HttpOnly;';
    const observed = absorbLegacySetCookies([`jsessionid=old;${attributes}`]).sessionCookies;
    expect(requestSessionCookies('JSESSIONID=node01opt2test', observed, NOW)).toEqual({
      JSESSIONID: { name: 'jsessionid', value: 'node01opt2test', attributes },
    });
  });

  it('falls back to the written attributes when the observed cookie is a deletion', () => {
    const deletion = deleteCookieLegacy('cfid', { cookieDomain: 'example.com' }, NOW);
    const observed = absorbLegacySetCookies([deletion]).sessionCookies;
    expect(requestSessionCookies('CFID=1001', observed, NOW)).toEqual({
      CFID: { name: 'CFID', value: '1001', attributes: WRITTEN_TAIL },
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
  identity_end_pending_at: Date | null;
  /** Returned by the upsert alone: whether it created the row. */
  inserted?: boolean | undefined;
}

interface RecordedQuery {
  text: string;
  values: unknown[] | undefined;
}

/** One metadata transaction of the double: its statements in order and how it ended. */
interface RecordedTransaction {
  queries: RecordedQuery[];
  outcome: 'open' | 'commit' | 'rollback';
}

/** TenantDb double: metadata transactions record each statement and answer with the queued result. */
interface FakeDb {
  /** Its commit callbacks run once a transaction commits, outside it, as the platform runner runs them. */
  db: TenantDb;
  queries: RecordedQuery[];
  transactions: RecordedTransaction[];
  answer(rows: JarRecord[], rowCount?: number | null): void;
  /** Answers statements starting with `prefix` with `rows` instead of the queued result. */
  answerFor(prefix: string, rows: QueryResultRow[]): void;
}

const DOUBLE_SCHEMA = 't_gateway_jar';

function fakeDb(): FakeDb {
  const queries: RecordedQuery[] = [];
  const transactions: RecordedTransaction[] = [];
  const answers = new Map<string, QueryResultRow[]>();
  let next: { rows: QueryResultRow[]; rowCount: number | null } = { rows: [], rowCount: 0 };
  const db: TenantDb = {
    schema: DOUBLE_SCHEMA,
    withTenant: () => Promise.reject(new Error('the jar never acts for a tenant')),
    async withMetadata<T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> {
      const transaction: RecordedTransaction = { queries: [], outcome: 'open' };
      transactions.push(transaction);
      const commits: CommitCallback[] = [];
      const tx: MetadataTx = {
        kind: 'metadata',
        schema: DOUBLE_SCHEMA,
        query: <R extends QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>> => {
          const recorded = { text: (typeof text === 'string' ? text : text.text).replace(/\s+/g, ' ').trim(), values };
          queries.push(recorded);
          transaction.queries.push(recorded);
          const special = [...answers].find(([prefix]) => recorded.text.startsWith(prefix))?.[1];
          const result = special === undefined ? next : { rows: special, rowCount: special.length };
          return Promise.resolve({ command: 'SELECT', oid: 0, fields: [], ...result } as unknown as QueryResult<R>);
        },
        onCommit: (cb) => {
          commits.push(cb);
        },
      };
      let result: T;
      try {
        result = await fn(tx);
        transaction.outcome = 'commit';
      } catch (err) {
        transaction.outcome = 'rollback';
        throw err;
      }
      for (const cb of commits) await cb();
      return result;
    },
    end: () => Promise.resolve(),
  };
  return {
    db,
    queries,
    transactions,
    answer(rows, rowCount = rows.length) {
      next = { rows, rowCount };
    },
    answerFor(prefix, rows) {
      answers.set(prefix, rows);
    },
  };
}

describe('createLegacyJar over a TenantDb double', () => {
  const UPSERT_COLUMNS = 'session_id, legacy_session_id, cookies, mode, hydrated_epoch, updated_at';
  const COLUMNS = `${UPSERT_COLUMNS}, identity_end_pending_at`;
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
    identity_end_pending_at: null,
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

  const LOCK_TEXT = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
  const lockOf = (sessionId: string): RecordedQuery => ({ text: LOCK_TEXT, values: [`${TABLE}:${sessionId}`] });
  const nativeLockOf = (legacySessionId: string): RecordedQuery => ({
    text: LOCK_TEXT,
    values: [`${TABLE}.native:${legacySessionId}`],
  });
  const INPUT: JarUpsert = {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    cookies: COOKIES,
    mode: 'target-primary',
    hydratedEpoch: 7,
  };

  /** The rebind statement removing the other holders, a holder owed its identity end kept as an empty marked jar. */
  const REMOVAL_TEXT =
    `WITH kept AS ( UPDATE ${TABLE} SET legacy_session_id = NULL, cookies = '{}'::jsonb, hydrated_epoch = NULL, ` +
    'updated_at = now() WHERE session_id <> $1 AND (session_id = $2 OR legacy_session_id = $3) ' +
    'AND identity_end_pending_at IS NOT NULL RETURNING session_id ), removed AS ( ' +
    `DELETE FROM ${TABLE} WHERE session_id <> $1 AND (session_id = $2 OR legacy_session_id = $3) ` +
    'AND identity_end_pending_at IS NULL RETURNING session_id ) ' +
    'SELECT session_id FROM kept UNION ALL SELECT session_id FROM removed';

  /** Asserts the merge-upsert statement of `input`. */
  function expectUpsert(statement: RecordedQuery | undefined, input: JarUpsert): void {
    expect(statement?.text).toContain(
      `INSERT INTO ${TABLE} AS jar (${UPSERT_COLUMNS}, last_active_at) VALUES ($1, $2, $3::jsonb, $4, $5, now(), now())`,
    );
    expect(statement?.text).toContain('ON CONFLICT (session_id) DO UPDATE SET');
    expect(statement?.text).toContain('cookies = jar.cookies || EXCLUDED.cookies');
    expect(statement?.text).toContain('last_active_at = EXCLUDED.last_active_at');
    expect(statement?.text).toContain(`RETURNING ${COLUMNS}, (xmax = 0) AS inserted`);
    expect(statement?.values).toEqual([
      input.sessionId,
      input.legacySessionId,
      JSON.stringify(input.cookies),
      input.mode,
      input.hydratedEpoch,
    ]);
  }

  it('upserts after the session lock in one transaction, merging the cookie map and returning the row', async () => {
    fake.answer([RECORD]);
    await expect(jar.upsert(INPUT)).resolves.toEqual(ROW);
    expect(fake.transactions).toHaveLength(1);
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[0]).toEqual(lockOf(SESSION_ID));
    expectUpsert(fake.queries[1], INPUT);
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
      expect(fake.transactions).toEqual([
        { queries: [lockOf(SESSION_ID), { text, values }], outcome: 'commit' },
      ]);
    },
  );

  it('marks the identity end pending under the session lock in one transaction, creating an empty jar when none exists', async () => {
    await jar.markIdentityEndPending(SESSION_ID, 'target-primary');
    expect(fake.transactions).toEqual([
      {
        queries: [
          lockOf(SESSION_ID),
          {
            text:
              `INSERT INTO ${TABLE} AS jar (${COLUMNS}) VALUES ($1, NULL, '{}'::jsonb, $2, NULL, now(), now()) ` +
              'ON CONFLICT (session_id) DO UPDATE SET ' +
              'identity_end_pending_at = COALESCE(jar.identity_end_pending_at, EXCLUDED.identity_end_pending_at), ' +
              'updated_at = EXCLUDED.updated_at',
            values: [SESSION_ID, 'target-primary'],
          },
        ],
        outcome: 'commit',
      },
    ]);
  });

  it.each<[string, Date | undefined, Date | null]>([
    ['whatever the row version', undefined, null],
    ['only at the row version read', UPDATED_AT, UPDATED_AT],
  ])(
    'clears the pending identity end %s under the session lock in one transaction, first removing a jar held only for it',
    async (_label, updatedAt, version) => {
      await jar.clearIdentityEndPending(SESSION_ID, updatedAt);
      expect(fake.transactions).toEqual([
        {
          queries: [
            lockOf(SESSION_ID),
            {
              text:
                `DELETE FROM ${TABLE} WHERE session_id = $1 AND identity_end_pending_at IS NOT NULL ` +
                "AND legacy_session_id IS NULL AND cookies = '{}'::jsonb AND hydrated_epoch IS NULL " +
                'AND ($2::timestamp IS NULL OR updated_at = $2)',
              values: [SESSION_ID, version],
            },
            {
              text:
                `UPDATE ${TABLE} SET identity_end_pending_at = NULL, updated_at = now() ` +
                'WHERE session_id = $1 AND identity_end_pending_at IS NOT NULL AND ($2::timestamp IS NULL OR updated_at = $2)',
              values: [SESSION_ID, version],
            },
          ],
          outcome: 'commit',
        },
      ]);
    },
  );


  it.each<[string, Date | null, JarRow]>([
    ['without', null, ROW],
    ['with', new Date(Date.UTC(2026, 5, 30, 11, 58)), { ...ROW, identityEndPendingAt: new Date(Date.UTC(2026, 5, 30, 11, 58)) }],
  ])('reads a jar %s a pending identity end, carrying the mark only when set', async (_label, pendingAt, expected) => {
    fake.answer([{ ...RECORD, identity_end_pending_at: pendingAt }]);
    await expect(jar.get(SESSION_ID)).resolves.toStrictEqual(expected);
  });

  it('rebinds under the previous session lock, then the legacy session lock, moving barrier rows at once', async () => {
    const previous = 'identity-session-0000';
    fake.answer([RECORD]);
    fake.answerFor('WITH kept AS', [{ session_id: previous }, { session_id: 'stale-holder' }]);
    await expect(jar.rebind(INPUT, previous)).resolves.toEqual(ROW);

    expect(fake.transactions).toHaveLength(1);
    expect(fake.transactions[0]?.outcome).toBe('commit');
    const [lockPrevious, lockNative, removal, move, upsert] = fake.queries;
    expect([lockPrevious, lockNative]).toEqual([lockOf(previous), nativeLockOf(LEGACY_SESSION_ID)]);
    expect(removal).toEqual({ text: REMOVAL_TEXT, values: [SESSION_ID, previous, LEGACY_SESSION_ID] });
    expect(move?.text).toBe(
      `WITH moved AS (DELETE FROM ${DOUBLE_SCHEMA}.session_barrier WHERE session_id = ANY($2::text[]) ` +
        'RETURNING owner, xid, pending, recorded_at) ' +
        `INSERT INTO ${DOUBLE_SCHEMA}.session_barrier AS b (session_id, owner, xid, pending, recorded_at) ` +
        'SELECT $1, owner, max(xid), sum(pending)::integer, max(recorded_at) FROM moved GROUP BY owner ' +
        'ON CONFLICT (session_id, owner) DO UPDATE SET ' +
        'xid = GREATEST(b.xid, EXCLUDED.xid), pending = b.pending + EXCLUDED.pending, ' +
        'recorded_at = GREATEST(b.recorded_at, EXCLUDED.recorded_at)',
    );
    expect(move?.values).toEqual([SESSION_ID, [previous, 'stale-holder']]);
    expectUpsert(upsert, INPUT);
    expect(fake.queries).toHaveLength(5);
  });

  it.each<[string, string | undefined, string | null, RecordedQuery[]]>([
    ['a legacy session and no previous session', undefined, LEGACY_SESSION_ID, [nativeLockOf(LEGACY_SESSION_ID)]],
    ['a previous session and no legacy session', 'identity-session-0000', null, [lockOf('identity-session-0000')]],
    ['neither', undefined, null, []],
  ])('rebinds with %s under exactly those locks, moving no barrier row', async (_, previous, sid, locks) => {
    fake.answer([RECORD]);
    fake.answerFor('WITH kept AS', []);
    const input = { ...INPUT, legacySessionId: sid };
    await jar.rebind(input, previous);
    expect(fake.queries.slice(0, locks.length)).toEqual(locks);
    expect(fake.queries[locks.length]?.values).toEqual([SESSION_ID, previous ?? null, sid]);
    expectUpsert(fake.queries[locks.length + 1], input);
    expect(fake.queries).toHaveLength(locks.length + 2);
  });

  it('runs a locked section on one transaction that takes each held lock once and commits', async () => {
    fake.answer([RECORD]);
    const result = await jar.withSessionLock(SESSION_ID, async (locked) => {
      await locked.get(SESSION_ID);
      await locked.findByLegacySessionId(LEGACY_SESSION_ID);
      await locked.lockNative(LEGACY_SESSION_ID);
      await locked.setHydratedEpoch(SESSION_ID, 9);
      await locked.upsert(INPUT);
      await locked.rebind(INPUT);
      await locked.rebind(INPUT, SESSION_ID);
      await locked.lockNative(LEGACY_SESSION_ID);
      await locked.drop(SESSION_ID);
      return 'done';
    });
    expect(result).toBe('done');
    expect(fake.transactions).toHaveLength(1);
    expect(fake.transactions[0]?.outcome).toBe('commit');
    expect(fake.queries[0]).toEqual(lockOf(SESSION_ID));
    expect(fake.queries.filter((query) => query.text === LOCK_TEXT)).toEqual([
      lockOf(SESSION_ID),
      nativeLockOf(LEGACY_SESSION_ID),
    ]);
  });

  it('runs a native-locked section on one transaction holding only the legacy session lock', async () => {
    fake.answer([RECORD]);
    fake.answerFor('WITH kept AS', []);
    const row = await jar.withNativeLock(LEGACY_SESSION_ID, async (locked) => {
      await locked.findByLegacySessionId(LEGACY_SESSION_ID);
      return locked.rebind(INPUT);
    });
    expect(row).toEqual(ROW);
    expect(fake.transactions).toHaveLength(1);
    expect(fake.transactions[0]?.outcome).toBe('commit');
    expect(fake.queries.filter((query) => query.text === LOCK_TEXT)).toEqual([nativeLockOf(LEGACY_SESSION_ID)]);
    expect(fake.queries[0]).toEqual(nativeLockOf(LEGACY_SESSION_ID));
  });

  it.each<[string, (j: LegacyJar) => Promise<unknown>, RecordedQuery[], RegExp]>([
    [
      'a second session lock',
      (j) => j.withSessionLock(SESSION_ID, (locked) => locked.upsert({ ...INPUT, sessionId: 'identity-session-0002' })),
      [lockOf(SESSION_ID)],
      /session identity-session-0002 requested while holding session identity-session-0001/,
    ],
    [
      'a session lock after a legacy session lock',
      (j) => j.withNativeLock(LEGACY_SESSION_ID, (locked) => locked.rebind(INPUT, SESSION_ID)),
      [nativeLockOf(LEGACY_SESSION_ID)],
      /session identity-session-0001 requested after native session OPT2TEST_1001_12345678/,
    ],
    [
      'a write of its own row inside a native-locked section',
      (j) => j.withNativeLock(LEGACY_SESSION_ID, (locked) => locked.upsert(INPUT)),
      [nativeLockOf(LEGACY_SESSION_ID)],
      /requested after native session/,
    ],
    [
      'a second legacy session lock',
      (j) =>
        j.withSessionLock(SESSION_ID, async (locked) => {
          await locked.lockNative(LEGACY_SESSION_ID);
          await locked.lockNative('OPT2TEST_2002_87654321');
        }),
      [lockOf(SESSION_ID), nativeLockOf(LEGACY_SESSION_ID)],
      /native session OPT2TEST_2002_87654321 requested while holding native session OPT2TEST_1001_12345678/,
    ],
    [
      'a rebind to a second legacy session',
      (j) =>
        j.withNativeLock(LEGACY_SESSION_ID, (locked) =>
          locked.rebind({ ...INPUT, legacySessionId: 'OPT2TEST_2002_87654321' }),
        ),
      [nativeLockOf(LEGACY_SESSION_ID)],
      /requested while holding native session/,
    ],
  ])('refuses %s without waiting for it and rolls back', async (_label, section, locks, message) => {
    fake.answer([RECORD]);
    await expect(section(jar)).rejects.toThrow(message);
    expect(fake.transactions).toEqual([{ queries: locks, outcome: 'rollback' }]);
  });

  it('rolls the locked section back and rethrows when it throws', async () => {
    const failure = new Error('bridge refused');
    await expect(
      jar.withSessionLock(SESSION_ID, async (locked) => {
        await locked.upsert(INPUT);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fake.transactions).toHaveLength(1);
    expect(fake.transactions[0]?.outcome).toBe('rollback');
    expect(fake.transactions[0]?.queries[0]).toEqual(lockOf(SESSION_ID));
  });

  it.each(outcomes)(
    'marks activity in one transaction without a lock, leaving updated_at, and answers $expected for a row count of $rowCount',
    async ({ rowCount, expected }) => {
      fake.answer([], rowCount);
      await expect(jar.markActive(SESSION_ID)).resolves.toBe(expected);
      expect(fake.transactions).toEqual([
        {
          queries: [{ text: `UPDATE ${TABLE} SET last_active_at = now() WHERE session_id = $1`, values: [SESSION_ID] }],
          outcome: 'commit',
        },
      ]);
    },
  );

  const IDLE_AFTER_MS = 10_920_000;
  const BARRIER_TABLE = `${DOUBLE_SCHEMA}.session_barrier`;
  const PURGE: RecordedQuery = {
    text:
      `WITH idle AS ( SELECT session_id FROM ${TABLE} ` +
      'WHERE last_active_at < now() - make_interval(secs => $1) ORDER BY last_active_at, session_id LIMIT $2 ' +
      'FOR UPDATE SKIP LOCKED ), purged AS ( ' +
      `DELETE FROM ${TABLE} AS jar USING idle WHERE jar.session_id = idle.session_id ), positions AS ( ` +
      `SELECT session_id, owner FROM ${BARRIER_TABLE} WHERE session_id IN (SELECT session_id FROM idle) AND pending = 0 ` +
      'AND recorded_at < now() - make_interval(secs => $1) FOR UPDATE SKIP LOCKED ) ' +
      `DELETE FROM ${BARRIER_TABLE} AS b USING positions AS p WHERE b.session_id = p.session_id AND b.owner = p.owner`,
    values: [IDLE_AFTER_MS / 1000, JAR_PURGE_BATCH],
  };

  it('purges up to 100 idle jars in a transaction of its own once a write that created a jar commits', async () => {
    const purging = createLegacyJar(fake.db, { purgeIdleAfterMs: IDLE_AFTER_MS });
    fake.answer([{ ...RECORD, inserted: true }]);
    await expect(purging.upsert(INPUT)).resolves.toEqual(ROW);
    expect(JAR_PURGE_BATCH).toBe(100);
    expect(fake.transactions).toHaveLength(2);
    expect(fake.transactions[0]?.outcome).toBe('commit');
    expectUpsert(fake.transactions[0]?.queries[1], INPUT);
    expect(fake.transactions[1]).toEqual({ queries: [PURGE], outcome: 'commit' });
  });

  it('queues one purge for a locked section however many jars it creates', async () => {
    const purging = createLegacyJar(fake.db, { purgeIdleAfterMs: IDLE_AFTER_MS });
    fake.answer([{ ...RECORD, inserted: true }]);
    fake.answerFor('WITH kept AS', []);
    await purging.withSessionLock(SESSION_ID, async (locked) => {
      await locked.upsert(INPUT);
      await locked.rebind({ ...INPUT, sessionId: SESSION_ID });
    });
    expect(fake.transactions.map((transaction) => transaction.queries.filter((query) => query.text === PURGE.text).length)).toEqual([0, 1]);
  });

  it.each<[string, LegacyJarOptions, boolean | undefined, boolean]>([
    ['a write that updated a stored jar', { purgeIdleAfterMs: IDLE_AFTER_MS }, false, false],
    ['a store without an idle limit', {}, true, false],
    ['a section that rolled its created jar back', { purgeIdleAfterMs: IDLE_AFTER_MS }, true, true],
  ])('purges nothing after %s', async (_label, options, inserted, rollsBack) => {
    fake.answer([{ ...RECORD, inserted }]);
    const store = createLegacyJar(fake.db, options);
    const section = store.withSessionLock(SESSION_ID, async (locked) => {
      await locked.upsert(INPUT);
      if (rollsBack) throw new Error('bridge refused');
    });
    if (rollsBack) await expect(section).rejects.toThrow('bridge refused');
    else await section;
    expect(fake.transactions).toHaveLength(1);
    expect(fake.queries.map((query) => query.text)).not.toContain(PURGE.text);
  });
});

const live = Boolean(process.env.PG_HOST) && (await pgAvailable());

/** Owners whose barrier rows the rebind suites store, as a version projecting both would. */
const BARRIER_OWNERS: ReadonlySet<string> = new Set(['people', 'identity']);

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
    await withMetadata(handle.app, async (tx) => {
      await tx.query(`DELETE FROM ${handle.schema}.legacy_jar`);
      await tx.query(`DELETE FROM ${handle.schema}.session_barrier`);
    });
  });

  /** Records barrier positions as the dispatcher's barrier does. */
  async function recordBarrier(sessionId: string, positions: Record<string, string>): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.session_barrier (session_id, owner, xid, recorded_at)
         SELECT $1, p.owner, p.xid, now() FROM unnest($2::text[], $3::numeric[]) AS p(owner, xid)`,
        [sessionId, Object.keys(positions), Object.values(positions)],
      ),
    );
  }

  /** Barrier positions by session and owner. */
  async function barrierRows(): Promise<Array<{ session_id: string; owner: string; xid: string }>> {
    const { rows } = await withMetadata(handle.app, (tx) =>
      tx.query<{ session_id: string; owner: string; xid: string }>(
        `SELECT session_id, owner, xid::text AS xid FROM ${handle.schema}.session_barrier ORDER BY session_id, owner`,
      ),
    );
    return rows;
  }

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

  const REPLACEMENT_ID = 'identity-session-0002';

  it('rebinds a legacy session held by a different previous session and moves its barrier rows', async () => {
    await jar.upsert(INPUT);
    await recordBarrier(SESSION_ID, { identity: '100', people: '50' });
    await recordBarrier(REPLACEMENT_ID, { identity: '90', programs_sites: '7' });
    const replacement: JarUpsert = { ...INPUT, sessionId: REPLACEMENT_ID, mode: 'legacy-primary', hydratedEpoch: null };
    await expect(jar.upsert(replacement)).rejects.toMatchObject({ code: '23505' });

    const stored = await jar.rebind(replacement, SESSION_ID);
    expect(stored).toMatchObject(replacement);
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
    await expect(jar.findByLegacySessionId(LEGACY_SESSION_ID)).resolves.toEqual(stored);
    expect(await barrierRows()).toEqual([
      { session_id: REPLACEMENT_ID, owner: 'identity', xid: '100' },
      { session_id: REPLACEMENT_ID, owner: 'people', xid: '50' },
      { session_id: REPLACEMENT_ID, owner: 'programs_sites', xid: '7' },
    ]);
  });

  it('moves declared writes with their positions on rebind, summing the declarations per owner', async () => {
    await jar.upsert(INPUT);
    const barrier = createSessionBarrier({
      db: handle.app,
      client: { request: () => Promise.reject(new Error('no projection await here')) } as unknown as ServiceClient,
      projectedOwners: () => BARRIER_OWNERS,
    });
    await barrier.declare(SESSION_ID, 'people');
    await barrier.declare(SESSION_ID, 'people');
    await barrier.declare(SESSION_ID, 'identity');
    await recordBarrier(SESSION_ID, { programs_sites: '7' });
    await barrier.record(SESSION_ID, new Map([['identity', '100']]));
    await barrier.declare(REPLACEMENT_ID, 'people');
    await recordBarrier(REPLACEMENT_ID, { identity: '90' });
    await expect(
      withMetadata(handle.app, (tx) =>
        tx.query(`UPDATE ${handle.schema}.session_barrier SET pending = -1 WHERE session_id = $1`, [SESSION_ID]),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const replacement: JarUpsert = { ...INPUT, sessionId: REPLACEMENT_ID, mode: 'legacy-primary', hydratedEpoch: null };
    await jar.rebind(replacement, SESSION_ID);
    const { rows } = await withMetadata(handle.app, (tx) =>
      tx.query<{ session_id: string; owner: string; xid: string | null; pending: number }>(
        `SELECT session_id, owner, xid::text AS xid, pending FROM ${handle.schema}.session_barrier ORDER BY session_id, owner`,
      ),
    );
    expect(rows).toEqual([
      { session_id: REPLACEMENT_ID, owner: 'identity', xid: '100', pending: 1 },
      { session_id: REPLACEMENT_ID, owner: 'people', xid: null, pending: 3 },
      { session_id: REPLACEMENT_ID, owner: 'programs_sites', xid: '7', pending: 0 },
    ]);
  });

  it('rebind displaces an unrelated stale holder of the legacy session and leaves other jars alone', async () => {
    await jar.upsert({ ...INPUT, sessionId: 'stale-holder' });
    await jar.upsert({ ...INPUT, sessionId: 'unrelated', legacySessionId: 'OPT2TEST_3003_33333333' });
    await jar.upsert({ ...INPUT, sessionId: REPLACEMENT_ID, legacySessionId: null, cookies: { CFID } });

    const stored = await jar.rebind({ ...INPUT, sessionId: REPLACEMENT_ID, cookies: { CFTOKEN } });
    expect(stored).toMatchObject({
      sessionId: REPLACEMENT_ID,
      legacySessionId: LEGACY_SESSION_ID,
      cookies: { CFID, CFTOKEN },
    });
    await expect(jar.get('stale-holder')).resolves.toBeUndefined();
    await expect(jar.get('unrelated')).resolves.toMatchObject({ legacySessionId: 'OPT2TEST_3003_33333333' });
  });

  it('marks a session without a jar in an empty jar, keeps the first mark and drops it with the jar', async () => {
    await jar.markIdentityEndPending(SESSION_ID, 'legacy-primary');
    const marked = await jar.get(SESSION_ID);
    expect(marked).toMatchObject({ sessionId: SESSION_ID, legacySessionId: null, cookies: {}, mode: 'legacy-primary', hydratedEpoch: null });
    expect(marked?.identityEndPendingAt).toBeInstanceOf(Date);
    await jar.markIdentityEndPending(SESSION_ID, 'target-primary');
    await expect(jar.get(SESSION_ID)).resolves.toMatchObject({
      mode: 'legacy-primary',
      identityEndPendingAt: marked?.identityEndPendingAt,
    });
    await expect(jar.drop(SESSION_ID)).resolves.toBe(true);
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
  });

  it('clears the mark of a jar holding a legacy session, keeping its cookies and epoch, and leaves an unmarked jar as it was', async () => {
    await jar.upsert(INPUT);
    const unmarked = await jar.upsert({ ...INPUT, sessionId: 'unmarked', legacySessionId: 'OPT2TEST_3003_33333333' });
    await jar.markIdentityEndPending(SESSION_ID, 'target-primary');

    await jar.clearIdentityEndPending(SESSION_ID);
    await jar.clearIdentityEndPending('unmarked');
    const cleared = await jar.get(SESSION_ID);
    expect(cleared).toMatchObject(INPUT);
    expect(cleared).not.toHaveProperty('identityEndPendingAt');
    await expect(jar.get('unmarked')).resolves.toEqual(unmarked);
  });

  it('removes the empty jar a mark left for a session without one, and does nothing for a session with no jar', async () => {
    await jar.markIdentityEndPending(SESSION_ID, 'legacy-primary');
    await jar.clearIdentityEndPending(SESSION_ID);
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
    await expect(jar.clearIdentityEndPending(SESSION_ID)).resolves.toBeUndefined();
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
  });

  it.each<[string, JarUpsert | undefined, Partial<JarRow> | undefined]>([
    ['a jar holding a legacy session', INPUT, INPUT],
    ['the empty jar a mark left', undefined, undefined],
  ])('clears the mark of %s only at the version read, leaving a later mark standing', async (_label, seed, cleared) => {
    if (seed !== undefined) await jar.upsert(seed);
    await jar.markIdentityEndPending(SESSION_ID, 'target-primary');
    const read = await jar.get(SESSION_ID);
    // A later logout's mark, in a later millisecond, keeps the first mark's time and stamps updated_at.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await jar.markIdentityEndPending(SESSION_ID, 'target-primary');
    const remarked = await jar.get(SESSION_ID);
    expect(remarked?.updatedAt.getTime()).toBeGreaterThan(read?.updatedAt.getTime() ?? Infinity);

    await jar.clearIdentityEndPending(SESSION_ID, read?.updatedAt);
    await expect(jar.get(SESSION_ID)).resolves.toEqual(remarked);

    // Activity leaves the version, so the clear at the version read still applies.
    await jar.markActive(SESSION_ID);
    await jar.clearIdentityEndPending(SESSION_ID, remarked?.updatedAt);
    const after = await jar.get(SESSION_ID);
    expect(after).toEqual(cleared === undefined ? undefined : expect.objectContaining(cleared));
    expect(after?.identityEndPendingAt).toBeUndefined();
  });

  it('clears the mark inside a locked section at the version read before it, keeping the jar the section upserts', async () => {
    await jar.upsert(INPUT);
    await jar.markIdentityEndPending(SESSION_ID, 'target-primary');
    const read = await jar.get(SESSION_ID);

    const stored = await jar.withSessionLock(SESSION_ID, async (locked) => {
      await locked.clearIdentityEndPending(SESSION_ID, read?.updatedAt);
      return locked.upsert({ ...INPUT, hydratedEpoch: 12 });
    });

    expect(stored).toMatchObject({ ...INPUT, hydratedEpoch: 12 });
    expect(stored).not.toHaveProperty('identityEndPendingAt');
    await expect(jar.get(SESSION_ID)).resolves.toEqual(stored);
  });


  it('keeps the mark of a jar through upserts, epoch updates and a rebind to the same session', async () => {
    await jar.upsert(INPUT);
    await expect(jar.get(SESSION_ID)).resolves.not.toHaveProperty('identityEndPendingAt');
    await jar.markIdentityEndPending(SESSION_ID, 'legacy-primary');
    const pendingAt = (await jar.get(SESSION_ID))?.identityEndPendingAt;
    expect(pendingAt).toBeInstanceOf(Date);
    await jar.upsert({ ...INPUT, cookies: { CFID } });
    await jar.setHydratedEpoch(SESSION_ID, 9);
    const rebound = await jar.rebind({ ...INPUT, hydratedEpoch: 10 }, SESSION_ID);
    expect(rebound).toMatchObject({ ...INPUT, hydratedEpoch: 10, identityEndPendingAt: pendingAt });
    await expect(jar.get(SESSION_ID)).resolves.toEqual(rebound);
  });

  it.each<[string, string | undefined]>([
    ['the previous session', SESSION_ID],
    ['another holder of the legacy session', undefined],
  ])('rebinding away from %s owed its identity end keeps it as an empty marked jar', async (_label, previous) => {
    await jar.upsert(INPUT);
    await jar.markIdentityEndPending(SESSION_ID, 'target-primary');
    await recordBarrier(SESSION_ID, { identity: '100' });
    const replacement: JarUpsert = { ...INPUT, sessionId: REPLACEMENT_ID, mode: 'legacy-primary', hydratedEpoch: null };

    const stored = await jar.rebind(replacement, previous);
    expect(stored).toMatchObject(replacement);
    expect(stored).not.toHaveProperty('identityEndPendingAt');
    const kept = await jar.get(SESSION_ID);
    expect(kept).toMatchObject({ legacySessionId: null, cookies: {}, mode: 'target-primary', hydratedEpoch: null });
    expect(kept?.identityEndPendingAt).toBeInstanceOf(Date);
    await expect(jar.findByLegacySessionId(LEGACY_SESSION_ID)).resolves.toEqual(stored);
    expect(await barrierRows()).toEqual([{ session_id: REPLACEMENT_ID, owner: 'identity', xid: '100' }]);
  });

  it('lets two concurrent rebinds of one mapping both succeed', async () => {
    await jar.upsert(INPUT);
    const replacement: JarUpsert = { ...INPUT, sessionId: REPLACEMENT_ID, mode: 'legacy-primary', hydratedEpoch: null };
    const results = await Promise.all([jar.rebind(replacement, SESSION_ID), jar.rebind(replacement, SESSION_ID)]);
    for (const row of results) expect(row).toMatchObject(replacement);
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
    await expect(jar.findByLegacySessionId(LEGACY_SESSION_ID)).resolves.toMatchObject({ sessionId: REPLACEMENT_ID });
  });

  it('moves exactly the barrier positions its one statement deletes, keeping one recorded after it', async () => {
    await jar.upsert(INPUT);
    const barrier = createSessionBarrier({
      db: handle.app,
      client: { request: () => Promise.reject(new Error('no projection await here')) } as unknown as ServiceClient,
      projectedOwners: () => BARRIER_OWNERS,
    });
    await barrier.record(SESSION_ID, new Map([['identity', '100']]));
    const BARRIER = `${handle.schema}.session_barrier`;
    let moved!: () => void;
    const afterMove = new Promise<void>((resolve) => {
      moved = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const statements: string[] = [];
    // Holds the rebind transaction open right after its first barrier statement.
    const held: TenantDb = {
      ...handle.app,
      withMetadata: (fn) =>
        handle.app.withMetadata((tx) =>
          fn({
            ...tx,
            async query<R extends QueryResultRow>(sql: string | QueryConfig, values?: unknown[]) {
              const text = typeof sql === 'string' ? sql : sql.text;
              const result = await tx.query<R>(sql, values);
              const first = text.includes(BARRIER) && !statements.some((earlier) => earlier.includes(BARRIER));
              statements.push(text);
              if (first) {
                moved();
                await finished;
              }
              return result;
            },
          }),
        ),
    };
    const replacement: JarUpsert = { ...INPUT, sessionId: REPLACEMENT_ID, mode: 'legacy-primary', hydratedEpoch: null };
    const rebind = createLegacyJar(held).rebind(replacement, SESSION_ID);
    await afterMove;
    await barrier.record(SESSION_ID, new Map([['people', '200']]));
    finish();
    await expect(rebind).resolves.toMatchObject(replacement);

    expect(statements.filter((text) => text.includes(BARRIER))).toHaveLength(1);
    expect(await barrierRows()).toEqual([
      { session_id: SESSION_ID, owner: 'people', xid: '200' },
      { session_id: REPLACEMENT_ID, owner: 'identity', xid: '100' },
    ]);
  });

  it('holds a top-level write of the session until the locked section commits', async () => {
    await jar.upsert(INPUT);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const section = jar.withSessionLock(SESSION_ID, async (locked) => {
      await locked.setHydratedEpoch(SESSION_ID, 5);
      entered();
      await held;
      return locked.get(SESSION_ID);
    });
    await inside;
    let written = false;
    const write = jar.setHydratedEpoch(SESSION_ID, 9).then((changed) => {
      written = true;
      return changed;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(written).toBe(false);
    await expect(jar.get(SESSION_ID)).resolves.toMatchObject({ hydratedEpoch: 3 });

    release();
    await expect(section).resolves.toMatchObject({ hydratedEpoch: 5 });
    await expect(write).resolves.toBe(true);
    await expect(jar.get(SESSION_ID)).resolves.toMatchObject({ hydratedEpoch: 9 });
  });

  it('rolls back every locked write when the section throws', async () => {
    const before = await jar.upsert(INPUT);
    const failure = new Error('bridge refused');
    await expect(
      jar.withSessionLock(SESSION_ID, async (locked) => {
        await locked.upsert({ ...INPUT, legacySessionId: 'OPT2TEST_2002_87654321', hydratedEpoch: 8 });
        await locked.drop(SESSION_ID);
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(jar.get(SESSION_ID)).resolves.toEqual(before);
  });

  describe('activity and the idle purge', () => {
    const HOUR_MS = 3_600_000;
    const created: JarUpsert = { ...INPUT, sessionId: 'created', legacySessionId: null };

    /** Moves the session's idle clock `seconds` into the past. */
    async function idleFor(sessionId: string, seconds: number): Promise<void> {
      await withMetadata(handle.app, (tx) =>
        tx.query(
          `UPDATE ${handle.schema}.legacy_jar SET last_active_at = now() - make_interval(secs => $2) WHERE session_id = $1`,
          [sessionId, seconds],
        ),
      );
    }

    /** Seeds a jar without a legacy session, idle for `seconds`. */
    async function idleJar(sessionId: string, seconds: number): Promise<void> {
      await jar.upsert({ ...created, sessionId });
      await idleFor(sessionId, seconds);
    }

    /** Whether the session's jar was active within the last `seconds`. */
    async function activeWithin(sessionId: string, seconds: number): Promise<boolean | undefined> {
      const { rows } = await withMetadata(handle.app, (tx) =>
        tx.query<{ recent: boolean }>(
          `SELECT last_active_at > now() - make_interval(secs => $2) AS recent FROM ${handle.schema}.legacy_jar WHERE session_id = $1`,
          [sessionId, seconds],
        ),
      );
      return rows[0]?.recent;
    }

    async function jarIds(): Promise<string[]> {
      const { rows } = await withMetadata(handle.app, (tx) =>
        tx.query<{ session_id: string }>(`SELECT session_id FROM ${handle.schema}.legacy_jar ORDER BY session_id`),
      );
      return rows.map((row) => row.session_id);
    }

    /** Stores a barrier row of `owner` recorded `seconds` ago. */
    async function barrierRow(sessionId: string, owner: string, pending: number, seconds: number): Promise<void> {
      await withMetadata(handle.app, (tx) =>
        tx.query(
          `INSERT INTO ${handle.schema}.session_barrier (session_id, owner, xid, pending, recorded_at)
           VALUES ($1, $2, CASE WHEN $3::integer = 0 THEN 42 END, $3, now() - make_interval(secs => $4))`,
          [sessionId, owner, pending, seconds],
        ),
      );
    }

    async function barrierKeys(): Promise<string[]> {
      const { rows } = await withMetadata(handle.app, (tx) =>
        tx.query<{ key: string }>(
          `SELECT session_id || '/' || owner AS key FROM ${handle.schema}.session_barrier ORDER BY session_id, owner`,
        ),
      );
      return rows.map((row) => row.key);
    }

    it('marks a jar active now without touching updated_at, and every write refreshes it', async () => {
      const stored = await jar.upsert(INPUT);
      await idleFor(SESSION_ID, 7200);
      await expect(activeWithin(SESSION_ID, 60)).resolves.toBe(false);

      await expect(jar.markActive(SESSION_ID)).resolves.toBe(true);
      await expect(activeWithin(SESSION_ID, 60)).resolves.toBe(true);
      await expect(jar.get(SESSION_ID)).resolves.toEqual(stored);
      await expect(jar.markActive('identity-session-none')).resolves.toBe(false);

      await idleFor(SESSION_ID, 7200);
      await jar.upsert(INPUT);
      await expect(activeWithin(SESSION_ID, 60)).resolves.toBe(true);
    });

    it('purges, once a write creates a jar, the idle jars, marked or not, with their long-recorded positions', async () => {
      await idleJar('idle', 7200);
      await idleJar('idle-recent-position', 7200);
      await idleJar('fresh', 0);
      await idleJar('just-under', 3570);
      await jar.markIdentityEndPending('pending-idle', 'target-primary');
      await idleFor('pending-idle', 7200);
      await idleJar('pending-active', 7200);
      await jar.markIdentityEndPending('pending-active', 'legacy-primary');
      await jar.markActive('pending-active');
      await barrierRow('idle', 'people', 0, 7200);
      await barrierRow('idle', 'identity', 2, 7200);
      await barrierRow('idle-recent-position', 'people', 0, 0);
      await barrierRow('fresh', 'people', 0, 7200);
      await barrierRow('pending-idle', 'people', 0, 7200);
      const purging = createLegacyJar(handle.app, { purgeIdleAfterMs: HOUR_MS });

      await purging.upsert({ ...created, sessionId: 'fresh' });
      expect(await jarIds()).toEqual(['fresh', 'idle', 'idle-recent-position', 'just-under', 'pending-active', 'pending-idle']);

      await purging.upsert(created);
      expect(await jarIds()).toEqual(['created', 'fresh', 'just-under', 'pending-active']);
      await expect(jar.get('pending-active')).resolves.toHaveProperty('identityEndPendingAt');
      // A pending declaration stays for its exchange; a position recorded within the limit stays for its await.
      expect(await barrierKeys()).toEqual(['fresh/people', 'idle/identity', 'idle-recent-position/people']);
    });

    it('purges at most 100 jars per created jar, oldest first', async () => {
      await withMetadata(handle.app, (tx) =>
        tx.query(
          `INSERT INTO ${handle.schema}.legacy_jar (session_id, legacy_session_id, cookies, mode, hydrated_epoch, updated_at, last_active_at)
           SELECT 'idle-' || lpad(i::text, 3, '0'), NULL, '{}'::jsonb, 'legacy-primary', NULL, now(), now() - make_interval(secs => 7200 - i)
           FROM generate_series(1, 102) AS i`,
        ),
      );
      await createLegacyJar(handle.app, { purgeIdleAfterMs: HOUR_MS }).upsert(created);
      expect(await jarIds()).toEqual(['created', 'idle-101', 'idle-102']);
    });

    it('skips an idle jar another transaction holds instead of waiting for it', async () => {
      await idleJar('idle-held', 7200);
      await idleJar('idle-free', 7200);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding!: () => void;
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const holder = withMetadata(handle.app, async (tx) => {
        await tx.query(`SELECT 1 FROM ${handle.schema}.legacy_jar WHERE session_id = $1 FOR UPDATE`, ['idle-held']);
        holding();
        await released;
      });
      await held;
      try {
        await createLegacyJar(handle.app, { purgeIdleAfterMs: HOUR_MS }).upsert(created);
        expect(await jarIds()).toEqual(['created', 'idle-held']);
      } finally {
        release();
        await holder;
      }
    });
  });
});
