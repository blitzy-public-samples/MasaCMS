// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Request lifecycle create → sign → audit → verify through the fixture and `/v1` routes and the domain functions, over the recording db, held to esignature.cfc. */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError, isCfUuid } from '@opt2/platform/legacy-compat';
import { roundToSqlServerDatetime, withGatedTenant } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type Clock } from '@opt2/platform/service-kit';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { GENESIS_PREV_HASH, hashToHex, type ChainEntry } from '../../src/domain/hash-chain.js';
import {
  AUDIT_ACTIONS,
  EsignatureDomainError,
  appendAuditEntry,
  createSignatureRequest,
  getAuditChain,
  getRequest,
  signRequest,
  verifyStored,
  verifySupplied,
  type EsignatureActor,
  type EsignatureDomainDeps,
  type SuppliedAuditEntry,
} from '../../src/domain/signing.js';
import { BASE64_DECODE_SLICE } from '../../src/legacy/checks.js';
import { PeopleReadDeniedError, type PersonSummary } from '../../src/legacy/people-client.js';
import { createEsignatureRepository } from '../../src/repo/repository.js';
import type { AuditEntryRow, SignatureRequestRow } from '../../src/repo/tables.js';
import {
  CSRF_HEADERS,
  TEST_CLOCK,
  buildTestApp,
  createFakePeopleClient,
  createRecordingDb,
  type RecordedWrite,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';
import { AUDITOR_USER_ID, OTHER_USER_ID, SIGNER_USER_ID, headersFor, userHeaders } from '../helpers/tokens.js';
import { TAMPER_CASES, VECTOR_REQUEST_ID, chainEntries } from '../helpers/vectors.js';

type Injected = Awaited<ReturnType<TestApp['app']['inject']>>;
type Headers = Record<string, string>;
type Payload = Readonly<Record<string, unknown>>;

const FIXTURE = '/legacy-fixtures/cfml/api.cfm/esignature';
const V1 = '/v1/esignature';
const SURFACES = [
  ['fixture', FIXTURE],
  ['v1', V1],
] as const;
type Surface = (typeof SURFACES)[number][0];

// auth.cfc role group names.
const SIGNER_ROLES = ['system-user', 'esignature.signer'] as const;
const AUDITOR_ROLES = ['system-user', 'esignature.auditor'] as const;

// envelope.cfc errorMap messages and esignature.cfc's conflict message.
const INVALID_PARAMETERS = 'Invalid parameters';
const FORBIDDEN = 'Insufficient Account Permissions';
const NOT_FOUND = 'Not Found';
const INVALID_TOKENS = 'Invalid CSRF tokens';
const ALREADY_SIGNED = 'already-signed';
const UNHANDLED = 'Unhandled Exception';

const MISSING_ID = '00000000-0000-0000-0000000000000000';
const POOL_USER_ID = 'A1B2C3D4-0000-0000-00000000000000A9';
const GROUP_ID = 'A1B2C3D4-0000-0000-00000000000000AA';
const B_USER_ID = 'A1B2C3D4-0000-0000-00000000000000B1';
const DOCUMENT = Buffer.from('%PDF-1.7 synthetic lifecycle contract');
const DOCUMENT_SHA256 = createHash('sha256').update(DOCUMENT).digest('hex');
const CREATE: Payload = Object.freeze({ documentName: 'lifecycle.pdf', documentBase64: DOCUMENT.toString('base64'), signerUserId: SIGNER_USER_ID });
const TYPED_NAME = ' Zo\u00eb \u00dcnal \u2013 \u7f72\u540d ';

/** A people pool-user read result. */
const person = (userId: string, siteId: string = TENANT_A.siteId, type = 2): PersonSummary => ({ userId, siteId, type });

const PERSONS: readonly PersonSummary[] = [
  person(SIGNER_USER_ID),
  person(AUDITOR_USER_ID),
  person(OTHER_USER_ID),
  person(POOL_USER_ID, TENANT_UMBRELLA.siteId),
  person(GROUP_ID, TENANT_A.siteId, 1),
  person(B_USER_ID, TENANT_B.siteId),
];

/** The request `tenant-a` vector chain belongs to, already SIGNED. */
const VECTOR_REQUEST: Readonly<Partial<SignatureRequestRow>> = Object.freeze({
  tenant_id: TENANT_A.tenantId,
  request_id: VECTOR_REQUEST_ID,
  siteid: TENANT_A.siteId,
  document_name: 'vector.pdf',
  document_sha256: 'cbe8263992edc7f17cfdcb0d0b113055db84a88864419e372f390f0630f7057d',
  document: Buffer.from('vector'),
  signer_user_id: SIGNER_USER_ID,
  state: 'SIGNED',
  created: new Date(2026, 5, 30, 0, 0, 0, 0),
  createdbyid: SIGNER_USER_ID,
});

let t: TestApp;
const extraApps: TestApp[] = [];

beforeEach(async () => {
  t = await buildTestApp({ peopleClient: createFakePeopleClient(PERSONS) });
});

afterEach(async () => {
  await Promise.all([t.app.close(), ...extraApps.splice(0).map((extra) => extra.app.close())]);
});

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `at` at SQL Server datetime precision: as envelope.cfc rows() renders it, and as the audit route formats it. */
function datetimeTexts(at: Date): { seconds: string; millis: string } {
  const r = roundToSqlServerDatetime({
    year: at.getFullYear(),
    month: at.getMonth() + 1,
    day: at.getDate(),
    hour: at.getHours(),
    minute: at.getMinutes(),
    second: at.getSeconds(),
    fractionSeconds: at.getMilliseconds() / 1000,
  });
  const seconds = `${pad(r.year, 4)}-${pad(r.month)}-${pad(r.day)}T${pad(r.hour)}:${pad(r.minute)}:${pad(r.second)}`;
  return { seconds, millis: `${seconds}.${pad(r.ms, 3)}` };
}

/** A chain as esignature.cfc suppliedEntries reads it, in `seq` order as an audit read returns it: every key as text, NULL as ''. */
function suppliedCopy(entries: readonly ChainEntry[]): SuppliedAuditEntry[] {
  return [...entries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => ({
      seq: String(entry.seq),
      action: entry.action,
      actor_user_id: entry.actor_user_id ?? '',
      detail: entry.detail ?? '',
      at: typeof entry.at === 'string' ? entry.at : datetimeTexts(entry.at).millis,
      prev_hash: hashToHex(entry.prev_hash),
      entry_hash: hashToHex(entry.entry_hash),
    }));
}

/** Seeds VECTOR_REQUEST with `entries` as its stored chain into `t`'s recording db. */
function seedVectorChain(entries: readonly ChainEntry[] = chainEntries()): void {
  t.db.seed('signature_request', [VECTOR_REQUEST]);
  t.db.seed(
    'audit_entry',
    entries.map((entry) => ({ ...entry, tenant_id: TENANT_A.tenantId, at: entry.at as Date })),
  );
}

const signer = (site: string = TENANT_A.siteId): Promise<Headers> => userHeaders({ sub: SIGNER_USER_ID, site, roles: SIGNER_ROLES });
/** A signer of the site who is not the signer of the requests under test; they create them. */
const requester = (): Promise<Headers> => userHeaders({ sub: OTHER_USER_ID, roles: SIGNER_ROLES });
const auditor = (): Promise<Headers> => headersFor('esignature.auditor', { site: TENANT_A.siteId });

/** A POST to `url`, with the CSRF token pair auth.cfc requireCsrf checks on a fixture write and the `/v1` writes consume alike. */
async function post(url: string, headers: Headers | Promise<Headers>, payload: Payload = {}, app: TestApp = t): Promise<Injected> {
  return app.app.inject({ method: 'POST', url, headers: { ...(await headers), ...CSRF_HEADERS }, payload: { ...payload } });
}

async function get(url: string, headers: Headers | Promise<Headers>, app: TestApp = t): Promise<Injected> {
  return app.app.inject({ method: 'GET', url, headers: await headers });
}

/** The answer's data: the fixture envelope's `data`, or the plain `/v1` body. */
function dataOf(surface: Surface, res: Injected): Record<string, unknown> {
  const body = res.json() as Record<string, unknown>;
  return (surface === 'fixture' ? body.data : body) as Record<string, unknown>;
}

/** Creates a request for SIGNER_USER_ID as the requester and returns its id. */
async function createRequest(app: TestApp = t, prefix: string = FIXTURE): Promise<string> {
  const res = await post(`${prefix}/requests`, requester(), CREATE, app);
  expect(res.statusCode).toBe(200);
  return dataOf(prefix === FIXTURE ? 'fixture' : 'v1', res).request_id as string;
}

/** Creates a request and signs it with TYPED_NAME; returns its id. */
async function createSigned(): Promise<string> {
  const id = await createRequest();
  expect((await post(`${FIXTURE}/requests/${id}/sign`, signer(), { typedName: TYPED_NAME })).statusCode).toBe(200);
  return id;
}

/** The fixture error envelope of `method`. */
function errorBody(method: string, message: string, code = 'invalid_request'): Record<string, unknown> {
  return { apiversion: 'v1', method, error: { code, message } };
}

/** `<op> <bare table>` of each write that is not a changelog row. */
function dataWrites(writes: readonly RecordedWrite[]): string[] {
  return writes.filter((w) => w.table !== 'esignature.changelog').map((w) => `${w.op} ${w.table.replace(/^esignature\./, '')}`);
}

/** The audit entries of request `id` in `seq` order. */
function storedChain(db: RecordingDb, id: string): AuditEntryRow[] {
  return db
    .rows('audit_entry')
    .filter((row) => row.request_id === id)
    .sort((a, b) => a.seq - b.seq);
}

describe('esignature.cfc audit actions', () => {
  it('appends created, then signed', () => {
    expect(AUDIT_ACTIONS).toEqual({ created: 'created', signed: 'signed' });
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
  });
});

describe('create', () => {
  it.each(SURFACES)('creates a PENDING request for a pool signer with its created entry on the genesis hash through %s', async (surface, prefix) => {
    const res = await post(`${prefix}/requests`, requester(), CREATE);
    expect(res.statusCode).toBe(200);
    const data = dataOf(surface, res);
    const id = data.request_id as string;
    expect([isCfUuid(id), id.length]).toEqual([true, 35]);
    const now = datetimeTexts(TEST_CLOCK.now());
    const row = {
      request_id: id,
      siteid: TENANT_A.siteId,
      document_name: 'lifecycle.pdf',
      document_sha256: DOCUMENT_SHA256,
      signer_user_id: SIGNER_USER_ID,
      state: 'PENDING',
      created: now.seconds,
      createdbyid: OTHER_USER_ID,
    };
    expect(res.json()).toEqual(surface === 'fixture' ? { apiversion: 'v1', method: 'esignature.requests', data: row } : row);

    expect(dataWrites(t.db.writes())).toEqual(['insert signature_request', 'insert audit_entry']);
    const [entry] = storedChain(t.db, id);
    expect(entry).toMatchObject({ seq: 1, action: 'created', actor_user_id: OTHER_USER_ID, detail: DOCUMENT_SHA256, tenant_id: TENANT_A.tenantId });
    expect(entry?.prev_hash.equals(GENESIS_PREV_HASH)).toBe(true);
    expect(datetimeTexts(entry?.at ?? new Date(0)).millis).toBe(now.millis);
    expect(t.db.rows('signature_request')[0]?.document).toEqual(DOCUMENT);
    expect(t.peopleClient.calls).toEqual([{ siteId: TENANT_A.siteId, userId: SIGNER_USER_ID }]);
  });

  it.each<[string, Date, string, string]>([
    ['on a datetime tick', new Date(2026, 5, 30, 12, 0, 0, 0), '2026-06-30T12:00:00', '2026-06-30T12:00:00.000'],
    ['between ticks', new Date(2026, 5, 30, 14, 5, 9, 124), '2026-06-30T14:05:09', '2026-06-30T14:05:09.123'],
    ['carrying into the next day', new Date(2026, 5, 30, 23, 59, 59, 999), '2026-07-01T00:00:00', '2026-07-01T00:00:00.000'],
  ])('stores created and the created entry at at SQL Server datetime precision %s', async (_label, at, created, auditAt) => {
    const clock: Clock = { now: () => new Date(at.getTime()) };
    const app = await buildTestApp({ clock, peopleClient: createFakePeopleClient(PERSONS) });
    extraApps.push(app);
    const id = await createRequest(app);
    const audit = await get(`${FIXTURE}/requests/${id}/audit`, auditor(), app);
    expect((await get(`${V1}/requests/${id}`, auditor(), app)).json()).toMatchObject({ created, signature: null });
    expect(audit.json().data.items.map((item: Record<string, unknown>) => item.at)).toEqual([auditAt]);
  });

  it.each([
    ['a lower-case UserID', SIGNER_USER_ID.toLowerCase(), SIGNER_USER_ID],
    ['a public-pool (umbrella) user', POOL_USER_ID, POOL_USER_ID],
  ])('stores the signer UserID people returns for %s', async (_label, sent, stored) => {
    const res = await post(`${FIXTURE}/requests`, requester(), { ...CREATE, signerUserId: sent });
    expect(res.json().data.signer_user_id).toBe(stored);
  });

  it.each<[string, Payload]>([
    ['an empty documentName', { ...CREATE, documentName: '' }],
    ['a documentName over 255 characters', { ...CREATE, documentName: 'd'.repeat(256) }],
    ['a complex documentName', { ...CREATE, documentName: ['lifecycle.pdf'] }],
    ['documentBase64 that is not base64', { ...CREATE, documentBase64: 'not*base64' }],
    ['an empty document', { ...CREATE, documentBase64: '' }],
    ['no signerUserId', { documentName: CREATE.documentName, documentBase64: CREATE.documentBase64 }],
    ['a signer people does not know', { ...CREATE, signerUserId: MISSING_ID }],
    ['a group (Type 1) as signer', { ...CREATE, signerUserId: GROUP_ID }],
    ['a user outside the site user pools', { ...CREATE, signerUserId: B_USER_ID }],
  ])('answers invalidParameters for %s and writes nothing', async (_label, payload) => {
    for (const [surface, prefix] of SURFACES) {
      const res = await post(`${prefix}/requests`, requester(), payload);
      expect([surface, res.statusCode, res.json()]).toEqual([surface, 400, errorBody('esignature.requests', INVALID_PARAMETERS)]);
    }
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it.each(SURFACES)('stores and hashes a document spanning several decode slices byte for byte through %s', async (surface, prefix) => {
    const document = Buffer.alloc((BASE64_DECODE_SLICE / 4) * 3 * 2 + 1000);
    for (let i = 0; i < document.length; i += 1) document[i] = (i * 131 + 17) & 0xff;
    const sha256 = createHash('sha256').update(document).digest('hex');
    const res = await post(`${prefix}/requests`, requester(), { ...CREATE, documentBase64: document.toString('base64') });
    expect(res.statusCode).toBe(200);
    const data = dataOf(surface, res);
    expect(data.document_sha256).toBe(sha256);
    expect(t.db.rows('signature_request')[0]?.document?.equals(document)).toBe(true);
    expect(storedChain(t.db, data.request_id as string)[0]?.detail).toBe(sha256);
  });

  it('accepts a documentName of exactly 255 characters', async () => {
    const res = await post(`${FIXTURE}/requests`, requester(), { ...CREATE, documentName: 'd'.repeat(255) });
    expect([res.statusCode, res.json().data.document_name]).toEqual([200, 'd'.repeat(255)]);
  });

  it.each<[string, Error]>([
    ['403', new PeopleReadDeniedError(403, 'forbidden')],
    ['401', new PeopleReadDeniedError(401, 'authorization')],
  ])('answers forbidden when people denies the signer read with %s', async (_status, error) => {
    t.peopleClient.failWith(error);
    for (const [, prefix] of SURFACES) {
      const res = await post(`${prefix}/requests`, requester(), CREATE);
      expect([res.statusCode, res.json()]).toEqual([403, errorBody('esignature.requests', FORBIDDEN)]);
    }
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it.each<[string, Error]>([
    ['ServiceUnavailableError', new ServiceUnavailableError('people', new Error('connect ECONNREFUSED'))],
    ['LegacyServiceUnavailableError', new LegacyServiceUnavailableError()],
  ])('answers the legacy 503 when people is unavailable (%s)', async (_name, error) => {
    t.peopleClient.failWith(error);
    for (const [, prefix] of SURFACES) {
      const res = await post(`${prefix}/requests`, requester(), CREATE);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toEqual({ code: 'server_error', message: UNHANDLED });
    }
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it('answers server_error for any other people failure', async () => {
    t.peopleClient.failWith(new Error('people answered the user read with HTTP 418'));
    const res = await post(`${FIXTURE}/requests`, requester(), CREATE);
    expect([res.statusCode, res.json()]).toEqual([500, errorBody('esignature.requests', UNHANDLED, 'server_error')]);
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it('lists the created requests by created, then request_id, through both surfaces', async () => {
    const ids = [await createRequest(), await createRequest(t, V1)];
    const ordered = [...ids].sort();
    for (const [surface, prefix] of SURFACES) {
      const data = dataOf(surface, await get(`${prefix}/requests`, requester())) as { items: Array<{ request_id: string }>; totalitems: number };
      expect([surface, data.totalitems, data.items.map((item) => item.request_id)]).toEqual([surface, 2, ordered]);
    }
  });

  it('refuses a fixture create whose CSRF token identity rejects, consuming it for the empty collection context', async () => {
    t.csrf.answer(false);
    const res = await post(`${FIXTURE}/requests`, requester(), CREATE);
    expect([res.statusCode, res.json()]).toEqual([400, errorBody('esignature.requests', INVALID_TOKENS)]);
    expect(t.csrf.calls.map((call) => call.context)).toEqual(['']);
    expect(dataWrites(t.db.writes())).toEqual([]);
  });
});

describe('sign', () => {
  it.each(SURFACES)(
    'signs as the token user, stores the typed name as sent and chains the signed entry to the created one through %s',
    async (surface, prefix) => {
      const id = await createRequest();
      t.db.clear();
      const res = await post(`${prefix}/requests/${id}/sign`, signer(), {
        typedName: TYPED_NAME,
        signerUserId: OTHER_USER_ID,
        signer_user_id: OTHER_USER_ID,
      });
      expect(res.statusCode).toBe(200);
      expect(dataOf(surface, res)).toMatchObject({ request_id: id, state: 'SIGNED', signer_user_id: SIGNER_USER_ID });
      if (surface === 'fixture') expect(res.json().method).toBe('esignature.requests.sign');

      expect(dataWrites(t.db.writes())).toEqual(['update signature_request', 'insert signature', 'insert audit_entry']);
      const [signature, ...others] = t.db.rows('signature');
      expect(others).toEqual([]);
      expect(signature).toMatchObject({ request_id: id, typed_name: TYPED_NAME, signer_user_id: SIGNER_USER_ID });
      expect(isCfUuid(signature?.signature_id ?? '')).toBe(true);
      const [created, signed] = storedChain(t.db, id);
      expect(signed).toMatchObject({ seq: 2, action: 'signed', actor_user_id: SIGNER_USER_ID, detail: TYPED_NAME });
      expect(signed?.prev_hash.equals(created?.entry_hash ?? Buffer.alloc(0))).toBe(true);
      // esignature.cfc reads no user while signing.
      expect(t.peopleClient.calls).toHaveLength(1);
    },
  );

  it.each(SURFACES)('answers conflict already-signed to a second signature through %s and writes nothing', async (_surface, prefix) => {
    const id = await createSigned();
    t.db.clear();
    const res = await post(`${prefix}/requests/${id}/sign`, signer(), { typedName: 'Second Name' });
    expect([res.statusCode, res.json()]).toEqual([409, errorBody('esignature.requests.sign', ALREADY_SIGNED)]);
    expect(dataWrites(t.db.writes())).toEqual([]);
    expect(t.db.rows('signature').map((row) => row.typed_name)).toEqual([TYPED_NAME]);
  });

  it('answers conflict already-signed for a stored request that is no longer PENDING', async () => {
    t.db.seed('signature_request', [VECTOR_REQUEST]);
    const res = await post(`${FIXTURE}/requests/${VECTOR_REQUEST_ID}/sign`, signer(), { typedName: 'Ann Signer' });
    expect([res.statusCode, res.json()]).toEqual([409, errorBody('esignature.requests.sign', ALREADY_SIGNED)]);
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it.each([
    ['255 UTF-16 code units', 'n'.repeat(255)],
    ['surrogate pairs within 255 code units', `${'\u{1F58B}'.repeat(127)}n`],
    ['surrounding whitespace', '  Ann Signer\t'],
    ['a visible character among invisible ones', '\u200B\u00A0A\u2060'],
  ])('stores a typed name with %s byte for byte', async (_label, typedName) => {
    const id = await createRequest();
    const res = await post(`${FIXTURE}/requests/${id}/sign`, signer(), { typedName });
    expect(res.statusCode).toBe(200);
    expect(t.db.rows('signature')[0]?.typed_name).toBe(typedName);
    expect(storedChain(t.db, id)[1]?.detail).toBe(typedName);
  });

  it.each<[string, Payload]>([
    ['no typedName', {}],
    ['an empty typedName', { typedName: '' }],
    ['spaces only', { typedName: '   ' }],
    ['control characters only', { typedName: '\t\r\n\u0000' }],
    ['no-break and line separators only', { typedName: '\u00A0\u2007\u202F\u2028\u2029' }],
    ['format characters only', { typedName: '\u200B\u2060\uFEFF\u00AD' }],
    ['256 code units', { typedName: 'n'.repeat(256) }],
    ['128 surrogate pairs', { typedName: '\u{1F58B}'.repeat(128) }],
    ['a complex typedName', { typedName: { first: 'Ann' } }],
  ])('answers invalidParameters for %s and leaves the request PENDING', async (_label, payload) => {
    const id = await createRequest();
    t.db.clear();
    for (const [, prefix] of SURFACES) {
      const res = await post(`${prefix}/requests/${id}/sign`, signer(), payload);
      expect([res.statusCode, res.json()]).toEqual([400, errorBody('esignature.requests.sign', INVALID_PARAMETERS)]);
    }
    expect(dataWrites(t.db.writes())).toEqual([]);
    expect(t.db.rows('signature_request')[0]?.state).toBe('PENDING');
  });

  it.each(SURFACES)('answers invalidParameters to a typed name holding U+0000 through %s and rolls the signature back', async (_surface, prefix) => {
    const id = await createRequest();
    t.db.clear();
    // The name passes the typed-name rule; PostgreSQL refuses it.
    const res = await post(`${prefix}/requests/${id}/sign`, signer(), { typedName: 'A\u0000B' });
    expect([res.statusCode, res.json()]).toEqual([400, errorBody('esignature.requests.sign', INVALID_PARAMETERS)]);
    expect(dataWrites(t.db.writes())).toEqual([]);
    expect(t.db.rows('signature_request')[0]?.state).toBe('PENDING');
    expect(t.db.rows('signature')).toEqual([]);
    expect(storedChain(t.db, id).map((row) => row.action)).toEqual([AUDIT_ACTIONS.created]);
  });

  it.each<[string, () => Promise<string>, () => Promise<Headers>, Payload, number, string]>([
    ['an unknown request before the signer check', () => Promise.resolve(MISSING_ID), requester, { typedName: 'Ann' }, 404, NOT_FOUND],
    ['another signer before the typed-name rule', createRequest, requester, { typedName: '' }, 403, FORBIDDEN],
    [
      'an auditor, who holds no signer role',
      createRequest,
      () => userHeaders({ sub: SIGNER_USER_ID, roles: AUDITOR_ROLES }),
      { typedName: 'Ann' },
      403,
      FORBIDDEN,
    ],
    ['a blank typed name before the state check', createSigned, signer, { typedName: ' ' }, 400, INVALID_PARAMETERS],
  ])('refuses %s', async (_label, requestId, headers, payload, status, message) => {
    const id = await requestId();
    t.db.clear();
    const res = await post(`${FIXTURE}/requests/${id}/sign`, headers(), payload);
    expect([res.statusCode, res.json()]).toEqual([status, errorBody('esignature.requests.sign', message)]);
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it.each<[string, (id: string) => Promise<Injected>]>([
    ['a GET', async (id) => get(`${FIXTURE}/requests/${id}/sign`, signer())],
    [
      'a POST overridden to PUT',
      async (id) =>
        t.app.inject({
          method: 'POST',
          url: `${FIXTURE}/requests/${id}/sign`,
          headers: { ...(await signer()), ...CSRF_HEADERS, 'x-http-method-override': 'PUT' },
          payload: { typedName: 'Ann' },
        }),
    ],
  ])('answers notFound to %s of the sign route, as esignature.cfc handle() dispatches', async (_label, send) => {
    const id = await createRequest();
    t.db.clear();
    const res = await send(id);
    expect([res.statusCode, res.json()]).toEqual([404, errorBody('esignature.requests.sign', NOT_FOUND)]);
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it('answers a user token the platform rejects with the JSON API invalidAccessToken row in the fixture envelope, writing nothing', async () => {
    const id = await createRequest();
    t.db.clear();
    const res = await post(`${FIXTURE}/requests/${id}/sign`, { ...(await signer()), authorization: 'Bearer not-a-user-token' }, { typedName: 'Ann' });
    expect([res.statusCode, res.json()]).toEqual([401, errorBody('esignature.requests.sign', 'Invalid Access Token', 'invalid_token')]);
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it('consumes the CSRF token of a fixture sign for the request id context', async () => {
    const id = await createRequest();
    await post(`${FIXTURE}/requests/${id}/sign`, signer(), { typedName: 'Ann' });
    expect(t.csrf.calls.map((call) => call.context)).toEqual(['', id]);
  });
});

describe('audit chain', () => {
  it('lists the created and signed entries in seq order, each linked to the previous entry hash, for an auditor', async () => {
    const id = await createSigned();
    const res = await get(`${FIXTURE}/requests/${id}/audit`, auditor());
    expect([res.statusCode, res.json().method]).toEqual([200, 'esignature.requests.audit']);
    const { items, ...paging } = res.json().data as { items: Array<Record<string, unknown>> };
    expect(paging).toEqual({ startindex: 1, endindex: 2, itemsperpage: 50, totalitems: 2, totalpages: 1, pageindex: 1 });
    expect(items.map((item) => item.action)).toEqual([AUDIT_ACTIONS.created, AUDIT_ACTIONS.signed]);
    expect(items[0]?.prev_hash).toBe(hashToHex(GENESIS_PREV_HASH));
    expect(items.map((item) => item.entry_hash)).toEqual(storedChain(t.db, id).map((row) => hashToHex(row.entry_hash)));
    const at = datetimeTexts(TEST_CLOCK.now()).millis;
    expect(items).toEqual([
      {
        entry_id: expect.any(String),
        request_id: id,
        seq: 1,
        action: 'created',
        actor_user_id: OTHER_USER_ID,
        detail: DOCUMENT_SHA256,
        at,
        prev_hash: '0'.repeat(64),
        entry_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        entry_id: expect.any(String),
        request_id: id,
        seq: 2,
        action: 'signed',
        actor_user_id: SIGNER_USER_ID,
        detail: TYPED_NAME,
        at,
        prev_hash: items[0]?.entry_hash,
        entry_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(items.every((item) => isCfUuid(item.entry_id as string))).toBe(true);
  });

  it('answers the same page through /v1 as plain JSON', async () => {
    const id = await createSigned();
    const fixture = (await get(`${FIXTURE}/requests/${id}/audit`, auditor())).json().data;
    const v1 = await get(`${V1}/requests/${id}/audit`, auditor());
    expect([v1.statusCode, v1.json()]).toEqual([200, fixture]);
  });

  it.each<[string, string, Record<string, number>, number[], readonly (typeof SURFACES)[number][]]>([
    [
      'the second page of one entry',
      'pageIndex=2&itemsPerPage=1',
      { startindex: 2, endindex: 2, itemsperpage: 1, totalitems: 2, totalpages: 2, pageindex: 2 },
      [2],
      SURFACES,
    ],
    [
      'a page past the end',
      'pageIndex=3&itemsPerPage=1',
      { startindex: 3, endindex: 2, itemsperpage: 1, totalitems: 2, totalpages: 2, pageindex: 3 },
      [],
      SURFACES,
    ],
    [
      'empty fixture paging values as the defaults',
      'pageIndex=&itemsPerPage=',
      { startindex: 1, endindex: 2, itemsperpage: 50, totalitems: 2, totalpages: 1, pageindex: 1 },
      [1, 2],
      [SURFACES[0]],
    ],
  ])('pages the chain as envelope.cfc queryPage does for %s', async (_label, query, paging, seqs, surfaces) => {
    const id = await createSigned();
    for (const [surface, prefix] of surfaces) {
      const { items, ...rest } = dataOf(surface, await get(`${prefix}/requests/${id}/audit?${query}`, auditor())) as {
        items: Array<{ seq: number }>;
      };
      expect([surface, rest, items.map((item) => item.seq)]).toEqual([surface, paging, seqs]);
    }
  });

  it.each(['pageIndex=0', 'itemsPerPage=1001', 'itemsPerPage=0', 'pageIndex=first', 'itemsPerPage=1.5', 'pageIndex=\u0662'])(
    'answers invalidParameters for the paging %s',
    async (query) => {
      const id = await createSigned();
      for (const [, prefix] of SURFACES) {
        const res = await get(`${prefix}/requests/${id}/audit?${query}`, auditor());
        expect([prefix, res.statusCode, res.json()]).toEqual([prefix, 400, errorBody('esignature.requests.audit', INVALID_PARAMETERS)]);
      }
    },
  );

  it('fails a fixture page index of non-ASCII digits inside the paging bounds with server_error, as ACF int() does', async () => {
    const id = await createSigned();
    const res = await get(`${FIXTURE}/requests/${id}/audit?pageIndex=1\u0662`, auditor());
    expect([res.statusCode, res.json()]).toEqual([500, errorBody('esignature.requests.audit', UNHANDLED, 'server_error')]);
  });

  it.each([
    ['its signer', signer, 200],
    ['another signer', requester, 403],
  ])('admits %s as a chain reader as authorizeChainReader does', async (_label, headers, status) => {
    const id = await createSigned();
    for (const [, prefix] of SURFACES) {
      expect((await get(`${prefix}/requests/${id}/audit`, headers())).statusCode).toBe(status);
      expect((await get(`${prefix}/requests/${id}/verify`, headers())).statusCode).toBe(status);
    }
  });
});

describe('fixture ids no stored request has', () => {
  // Every stored request id is a CF UUID, so esignature.cfc's char(35) lookup of any other id matches no row.
  it.each(['x%00.cfm', `${MISSING_ID}%00`, `%20${MISSING_ID}`, 'not-a-uuid', '0f8fad5b-d9cb-469f-a165-70867728950e'])(
    'answers id %s with notFound on sign, audit and verify, never querying it',
    async (id) => {
      const sent = decodeURIComponent(id);
      for (const [send, method] of [
        [() => post(`${FIXTURE}/requests/${id}/sign`, signer(), { typedName: 'Jane Doe' }), 'esignature.requests.sign'],
        [() => get(`${FIXTURE}/requests/${id}/audit`, auditor()), 'esignature.requests.audit'],
        [() => get(`${FIXTURE}/requests/${id}/verify`, auditor()), 'esignature.requests.verify'],
        [() => post(`${FIXTURE}/requests/${id}/verify`, auditor(), { entries: '[]' }), 'esignature.requests.verify'],
      ] as const) {
        t.db.clear();
        const res = await send();
        expect([res.statusCode, res.json()]).toEqual([404, errorBody(method, NOT_FOUND)]);
        const lookups = t.db.queries().filter((q) => q.sql.includes('"request_id" = upper($1)') || q.params.some((p) => p === sent || p === sent.toUpperCase()));
        expect(lookups).toEqual([]);
      }
    },
  );
});

describe('verify', () => {
  it.each(SURFACES)('answers valid over the stored chain through %s, appending no entry', async (surface, prefix) => {
    const id = await createSigned();
    t.db.clear();
    const res = await get(`${prefix}/requests/${id}/verify`, auditor());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      surface === 'fixture'
        ? { apiversion: 'v1', method: 'esignature.requests.verify', data: { valid: true, entries: 2, brokenat: 0 } }
        : { valid: true, entries: 2, brokenat: 0 },
    );
    expect(dataWrites(t.db.writes())).toEqual([]);
    expect(storedChain(t.db, id)).toHaveLength(2);
  });

  it('breaks at the signed entry once its stored detail is altered', async () => {
    const id = await createSigned();
    const repository = createEsignatureRepository({ db: t.db, clock: TEST_CLOCK });
    const signed = storedChain(t.db, id)[1];
    await withTenant(t.db, TENANT_A.tenantId, (tx) =>
      repository.update(tx, 'audit_entry', { entry_id: signed?.entry_id }, { detail: 'Someone Else' }),
    );
    for (const [surface, prefix] of SURFACES) {
      expect(dataOf(surface, await get(`${prefix}/requests/${id}/verify`, auditor()))).toEqual({ valid: false, entries: 2, brokenat: 2 });
    }
  });

  it.each([
    ['an array', (items: unknown[]) => items],
    ['JSON text', (items: unknown[]) => JSON.stringify(items)],
  ])('verifies the audit listing posted back unchanged as %s', async (_label, encode) => {
    const id = await createSigned();
    const items = (await get(`${FIXTURE}/requests/${id}/audit`, auditor())).json().data.items as unknown[];
    t.db.clear();
    const res = await post(`${FIXTURE}/requests/${id}/verify`, auditor(), { entries: encode(items) });
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'esignature.requests.verify', data: { valid: true, entries: 2, brokenat: 0 } });
    const v1 = await post(`${V1}/requests/${id}/verify`, auditor(), { entries: items });
    expect(v1.json()).toEqual({ valid: true, entries: 2, brokenat: 0 });
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it('hashes a supplied copy against the stored request id, so another request breaks it at its first entry', async () => {
    const first = await createSigned();
    const second = await createRequest();
    const items = (await get(`${FIXTURE}/requests/${first}/audit`, auditor())).json().data.items as unknown[];
    const res = await post(`${FIXTURE}/requests/${second}/verify`, auditor(), { entries: items });
    expect(res.json().data).toEqual({ valid: false, entries: 2, brokenat: 1 });
  });

  it('verifies the five-entry vector chain stored and as a supplied copy', async () => {
    seedVectorChain();
    for (const [surface, prefix] of SURFACES) {
      const stored = await get(`${prefix}/requests/${VECTOR_REQUEST_ID}/verify`, auditor());
      const supplied = await post(`${prefix}/requests/${VECTOR_REQUEST_ID}/verify`, auditor(), { entries: suppliedCopy(chainEntries()) });
      expect([dataOf(surface, stored), dataOf(surface, supplied)]).toEqual([
        { valid: true, entries: 5, brokenat: 0 },
        { valid: true, entries: 5, brokenat: 0 },
      ]);
    }
  });

  it.each(TAMPER_CASES)('breaks the stored vector chain at seq $brokenat for $name', async ({ mutate, brokenat }) => {
    const tampered = mutate(chainEntries());
    seedVectorChain(tampered);
    for (const [surface, prefix] of SURFACES) {
      const res = await get(`${prefix}/requests/${VECTOR_REQUEST_ID}/verify`, auditor());
      expect(dataOf(surface, res)).toEqual({ valid: false, entries: tampered.length, brokenat });
    }
  });

  it.each(TAMPER_CASES)('breaks a supplied copy of the vector chain at seq $brokenat for $name', async ({ mutate, brokenat }) => {
    seedVectorChain();
    const copy = suppliedCopy(mutate(chainEntries()));
    for (const [surface, prefix] of SURFACES) {
      const res = await post(`${prefix}/requests/${VECTOR_REQUEST_ID}/verify`, auditor(), { entries: JSON.stringify(copy) });
      expect(dataOf(surface, res)).toEqual({ valid: false, entries: copy.length, brokenat });
    }
  });

  it.each<[string, (copy: SuppliedAuditEntry[]) => unknown]>([
    ['entries that are not an array', () => 'not json'],
    ['an entry that is not a struct', (copy) => [copy[0]?.seq]],
    ['an entry missing entry_hash', (copy) => [{ ...copy[0], entry_hash: undefined }]],
    ['a seq with a leading zero', (copy) => [{ ...copy[0], seq: '01' }]],
    ['an at without milliseconds', (copy) => [{ ...copy[0], at: '2026-06-30T00:00:00' }]],
    ['a 63-digit prev_hash', (copy) => [{ ...copy[0], prev_hash: '0'.repeat(63) }]],
  ])('answers invalidParameters for %s', async (_label, entries) => {
    seedVectorChain();
    const res = await post(`${FIXTURE}/requests/${VECTOR_REQUEST_ID}/verify`, auditor(), { entries: entries(suppliedCopy(chainEntries())) });
    expect([res.statusCode, res.json()]).toEqual([400, errorBody('esignature.requests.verify', INVALID_PARAMETERS)]);
  });
});

describe('/v1 CSRF', () => {
  /** One `/v1` write on a PENDING request `id`: its URL, caller, body, envelope method and the context the fixture consumes its pair under. */
  interface V1Write {
    label: string;
    url: (id: string) => string;
    headers: () => Promise<Headers>;
    payload: Payload;
    method: string;
    context: (id: string) => string;
  }

  const V1_WRITES: readonly V1Write[] = [
    { label: 'create', url: () => `${V1}/requests`, headers: requester, payload: CREATE, method: 'esignature.requests', context: () => '' },
    { label: 'sign', url: (id) => `${V1}/requests/${id}/sign`, headers: () => signer(), payload: { typedName: 'Ann' }, method: 'esignature.requests.sign', context: (id) => id },
    {
      label: 'supplied verify',
      url: (id) => `${V1}/requests/${id}/verify`,
      headers: auditor,
      payload: { entries: [] },
      method: 'esignature.requests.verify',
      context: (id) => id,
    },
  ];
  const [CSRF_TOKEN, CSRF_EXPIRES] = Object.values(CSRF_HEADERS);

  it.each(V1_WRITES)('answers a /v1 $label without a CSRF pair invalidTokens, calling identity for nothing and writing nothing', async ({ url, headers, payload, method }) => {
    const id = await createRequest();
    t.db.clear();
    const consumed = t.csrf.calls.length;
    const res = await t.app.inject({ method: 'POST', url: url(id), headers: await headers(), payload: { ...payload } });
    expect([res.statusCode, res.json()]).toEqual([400, errorBody(method, INVALID_TOKENS)]);
    expect(t.csrf.calls).toHaveLength(consumed);
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it.each(V1_WRITES)('answers a /v1 $label whose CSRF token identity rejects invalidTokens, writing nothing', async ({ url, headers, payload, method }) => {
    const id = await createRequest();
    t.db.clear();
    t.csrf.answer(false);
    const res = await post(url(id), headers(), payload);
    expect([res.statusCode, res.json()]).toEqual([400, errorBody(method, INVALID_TOKENS)]);
    expect(dataWrites(t.db.writes())).toEqual([]);
  });

  it.each(V1_WRITES)('consumes the CSRF pair of a /v1 $label once, under the fixture context', async ({ url, headers, payload, context }) => {
    const id = await createRequest();
    const consumed = t.csrf.calls.length;
    const res = await post(url(id), headers(), payload);
    expect(res.statusCode).toBe(200);
    expect(t.csrf.calls.slice(consumed)).toEqual([{ sessionId: expect.any(String), token: CSRF_TOKEN, expires: CSRF_EXPIRES, context: context(id) }]);
  });

  it('consumes a /v1 sign pair under the path id as sent, before the id is validated', async () => {
    const res = await post(`${V1}/requests/not-a-uuid/sign`, signer(), { typedName: 'Ann' });
    expect([res.statusCode, res.json()]).toEqual([400, errorBody('esignature.requests.sign', INVALID_PARAMETERS)]);
    expect(t.csrf.calls.map((call) => call.context)).toEqual(['not-a-uuid']);
  });
});

describe('domain functions over the recording db', () => {
  const REQUESTER: EsignatureActor = { userId: OTHER_USER_ID, siteId: TENANT_A.siteId, roles: SIGNER_ROLES };
  const SIGNER: EsignatureActor = { userId: SIGNER_USER_ID, siteId: TENANT_A.siteId, roles: SIGNER_ROLES };
  const AUDITOR: EsignatureActor = { userId: AUDITOR_USER_ID, siteId: TENANT_A.siteId, roles: AUDITOR_ROLES };
  const INPUT = Object.freeze({ documentName: 'lifecycle.pdf', document: DOCUMENT, signerUserId: SIGNER_USER_ID });

  /** A recording db with the domain collaborators over it and one PENDING request created by REQUESTER. */
  interface Prepared {
    db: RecordingDb;
    deps: EsignatureDomainDeps;
    id: string;
  }

  async function prepare(): Promise<Prepared> {
    const db = createRecordingDb();
    const deps: EsignatureDomainDeps = {
      repository: createEsignatureRepository({ db, clock: TEST_CLOCK }),
      clock: TEST_CLOCK,
      peopleClient: createFakePeopleClient(PERSONS),
    };
    const { request } = await withGatedTenant(db, TENANT_A.tenantId, (tx) => createSignatureRequest(tx, deps, INPUT, REQUESTER));
    return { db, deps, id: request.request_id };
  }

  const sign = ({ db, deps, id }: Prepared, typedName = TYPED_NAME, actor = SIGNER) =>
    withGatedTenant(db, TENANT_A.tenantId, (tx) => signRequest(tx, deps, { requestId: id, typedName }, actor));

  /** The lifecycle rows of the only request in `db`, with generated ids and the hashes over them reduced to their checks. */
  function lifecycleRows(db: RecordingDb): unknown {
    const [request] = db.rows('signature_request');
    const [signature] = db.rows('signature');
    if (request === undefined || signature === undefined) throw new Error('no signed request stored');
    return {
      request: { ...request, request_id: isCfUuid(request.request_id) },
      signature: { ...signature, signature_id: isCfUuid(signature.signature_id), request_id: signature.request_id === request.request_id },
      chain: storedChain(db, request.request_id).map(({ entry_id, request_id, prev_hash, entry_hash, ...rest }) => ({
        ...rest,
        entry_id: isCfUuid(entry_id),
        request_id: request_id === request.request_id,
      })),
    };
  }

  it('creates and signs through withGatedTenant with the rows and write order of the route path', async () => {
    const prepared = await prepare();
    const signed = await sign(prepared);
    await createSigned();
    expect(dataWrites(prepared.db.writes())).toEqual(dataWrites(t.db.writes()));
    expect(dataWrites(prepared.db.writes())).toEqual([
      'insert signature_request',
      'insert audit_entry',
      'update signature_request',
      'insert signature',
      'insert audit_entry',
    ]);
    expect(lifecycleRows(prepared.db)).toEqual(lifecycleRows(t.db));
    const [created] = storedChain(prepared.db, prepared.id);
    expect(created?.prev_hash.equals(GENESIS_PREV_HASH)).toBe(true);
    expect(signed.audit.prev_hash.equals(created?.entry_hash ?? Buffer.alloc(0))).toBe(true);
    expect([signed.request.state, signed.signature.typed_name, signed.signature.signer_user_id]).toEqual(['SIGNED', TYPED_NAME, SIGNER_USER_ID]);
  });

  it('reads, appends to and verifies the chain it wrote', async () => {
    const prepared = await prepare();
    const { db, deps, id } = prepared;
    const pending = await withTenant(db, TENANT_A.tenantId, (tx) => getRequest(tx, id, AUDITOR));
    expect([pending.request.state, pending.signature]).toEqual(['PENDING', null]);
    await sign(prepared);
    const detail = await withTenant(db, TENANT_A.tenantId, (tx) => getRequest(tx, id, SIGNER));
    expect(detail.signature).toMatchObject({ request_id: id, typed_name: TYPED_NAME, signer_user_id: SIGNER_USER_ID });

    // usp_audit_append takes any action, and a NULL actor and detail; the request id matches as char(35) does.
    const appended = await withGatedTenant(db, TENANT_A.tenantId, (tx) =>
      appendAuditEntry(tx, deps, { requestId: id.toLowerCase(), action: 'reviewed', actorUserId: null, detail: null, at: TEST_CLOCK.now() }),
    );
    const chain = storedChain(db, id);
    expect(appended).toMatchObject({ request_id: id, seq: 3, action: 'reviewed', actor_user_id: null, detail: null });
    expect(appended.prev_hash.equals(chain[1]?.entry_hash ?? Buffer.alloc(0))).toBe(true);

    const page = await withTenant(db, TENANT_A.tenantId, (tx) => getAuditChain(tx, id, { pageIndex: 2, itemsPerPage: 2 }, AUDITOR));
    expect([page.total, page.rows.map((row) => row.seq)]).toEqual([3, [3]]);
    expect(await withTenant(db, TENANT_A.tenantId, (tx) => verifyStored(tx, id, AUDITOR))).toEqual({ valid: true, entries: 3, brokenat: 0 });
    expect(verifySupplied({ request_id: id }, suppliedCopy(chain))).toEqual({ valid: true, entries: 3, brokenat: 0 });
  });

  it.each<[string, (p: Prepared) => Promise<unknown>, (p: Prepared) => Promise<unknown>, string, string]>([
    ['a second signature', (p) => sign(p), (p) => sign(p, 'Second Name'), 'conflict', ALREADY_SIGNED],
    ['a signature of an unknown request', async () => undefined, (p) => sign({ ...p, id: MISSING_ID }), 'notFound', NOT_FOUND],
    ['a signature by another user', async () => undefined, (p) => sign(p, TYPED_NAME, REQUESTER), 'forbidden', FORBIDDEN],
    ['a typed name of an ideographic space', async () => undefined, (p) => sign(p, '\u3000'), 'invalidParameters', INVALID_PARAMETERS],
    [
      'a signer people does not know',
      async () => undefined,
      ({ db, deps }) =>
        withGatedTenant(db, TENANT_A.tenantId, (tx) => createSignatureRequest(tx, deps, { ...INPUT, signerUserId: MISSING_ID }, REQUESTER)),
      'invalidParameters',
      INVALID_PARAMETERS,
    ],
    [
      'a read of an unknown request',
      async () => undefined,
      ({ db }) => withTenant(db, TENANT_A.tenantId, (tx) => getRequest(tx, MISSING_ID, AUDITOR)),
      'notFound',
      NOT_FOUND,
    ],
    [
      'a chain read by another signer',
      async () => undefined,
      ({ db, id }) => withTenant(db, TENANT_A.tenantId, (tx) => getAuditChain(tx, id, { pageIndex: 1, itemsPerPage: 50 }, REQUESTER)),
      'forbidden',
      FORBIDDEN,
    ],
    [
      'an append to an unknown request',
      async () => undefined,
      ({ db, deps }) =>
        withGatedTenant(db, TENANT_A.tenantId, (tx) =>
          appendAuditEntry(tx, deps, { requestId: MISSING_ID, action: 'signed', actorUserId: SIGNER_USER_ID, detail: 'Ann', at: TEST_CLOCK.now() }),
        ),
      'notFound',
      NOT_FOUND,
    ],
    [
      'a supplied copy with seq 0',
      async () => undefined,
      async ({ id }) => verifySupplied({ request_id: id }, [{ ...suppliedCopy(chainEntries())[0], seq: '0' } as SuppliedAuditEntry]),
      'invalidParameters',
      INVALID_PARAMETERS,
    ],
  ])(
    'raises EsignatureDomainError for %s with the envelope.cfc type and message, writing nothing',
    async (_label, before, failing, type, message) => {
      const prepared = await prepare();
      await before(prepared);
      const writes = prepared.db.writes().length;
      const error = await failing(prepared).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(EsignatureDomainError);
      expect(error).toMatchObject({ name: 'EsignatureDomainError', type, message });
      expect(prepared.db.writes()).toHaveLength(writes);
    },
  );
});

describe('tenancy', () => {
  const routes: ReadonlyArray<[string, 'GET' | 'POST', (id: string) => string, string]> = [
    ['fixture sign', 'POST', (id) => `${FIXTURE}/requests/${id}/sign`, 'esignature.requests.sign'],
    ['fixture audit', 'GET', (id) => `${FIXTURE}/requests/${id}/audit`, 'esignature.requests.audit'],
    ['fixture stored verify', 'GET', (id) => `${FIXTURE}/requests/${id}/verify`, 'esignature.requests.verify'],
    ['fixture supplied verify', 'POST', (id) => `${FIXTURE}/requests/${id}/verify`, 'esignature.requests.verify'],
    ['v1 read', 'GET', (id) => `${V1}/requests/${id}`, 'esignature.requests'],
    ['v1 sign', 'POST', (id) => `${V1}/requests/${id}/sign`, 'esignature.requests.sign'],
    ['v1 audit', 'GET', (id) => `${V1}/requests/${id}/audit`, 'esignature.requests.audit'],
    ['v1 stored verify', 'GET', (id) => `${V1}/requests/${id}/verify`, 'esignature.requests.verify'],
    ['v1 supplied verify', 'POST', (id) => `${V1}/requests/${id}/verify`, 'esignature.requests.verify'],
  ];

  it.each(routes)('hides a tenant-a request from its signer acting in tenant-b on the %s route', async (_label, method, url, envelopeMethod) => {
    const id = await createRequest();
    t.db.clear();
    const headers = signer(TENANT_B.siteId);
    const res = method === 'POST' ? await post(url(id), headers, { typedName: 'Ann Signer', entries: [] }) : await get(url(id), headers);
    expect([res.statusCode, res.json()]).toEqual([404, errorBody(envelopeMethod, NOT_FOUND)]);
    expect(dataWrites(t.db.writes())).toEqual([]);
    expect(t.db.rows('signature_request')[0]?.state).toBe('PENDING');
  });

  it.each<[string, () => Promise<Injected>]>([
    ['a fixture create body', () => post(`${FIXTURE}/requests`, requester(), { ...CREATE, siteid: TENANT_B.siteId })],
    ['a fixture create query', () => post(`${FIXTURE}/requests?siteid=${TENANT_B.siteId}`, requester(), CREATE)],
    ['a /v1 create body', () => post(`${V1}/requests`, requester(), { ...CREATE, siteid: TENANT_B.siteId })],
    ['a /v1 create query', () => post(`${V1}/requests?siteid=${TENANT_B.siteId}`, requester(), CREATE)],
  ])('refuses a siteid other than the token site in %s with 403, writing nothing', async (_label, send) => {
    const res = await send();
    expect([res.statusCode, res.json().error]).toEqual([403, { code: 'invalid_request', message: FORBIDDEN }]);
    expect(t.db.writes()).toEqual([]);
    expect(t.peopleClient.calls).toEqual([]);
  });

  it('writes under the token tenant whatever tenant the body names', async () => {
    const res = await post(`${FIXTURE}/requests`, requester(), {
      ...CREATE,
      siteid: TENANT_A.siteId,
      tenant_id: TENANT_B.tenantId,
      tenantId: TENANT_B.tenantId,
      tid: TENANT_B.tenantId,
    });
    expect(res.statusCode).toBe(200);
    expect(new Set(t.db.writes().map((write) => write.tenantId))).toEqual(new Set([TENANT_A.tenantId]));
    expect(t.db.rows('signature_request', TENANT_B.tenantId)).toEqual([]);
  });

  it('keeps a tenant-b request to tenant-b, with its own pool signer', async () => {
    const tenantB = (): Promise<Headers> => userHeaders({ sub: B_USER_ID, site: TENANT_B.siteId, roles: SIGNER_ROLES });
    const created = await post(`${FIXTURE}/requests`, tenantB(), { ...CREATE, signerUserId: B_USER_ID });
    expect(created.json().data).toMatchObject({ siteid: TENANT_B.siteId, signer_user_id: B_USER_ID, state: 'PENDING' });
    const signed = await post(`${FIXTURE}/requests/${created.json().data.request_id}/sign`, tenantB(), { typedName: 'Bea Signer' });
    expect(signed.json().data.state).toBe('SIGNED');
    expect(t.db.rows('signature', TENANT_B.tenantId)).toHaveLength(1);
    expect(t.db.rows('signature_request', TENANT_A.tenantId)).toEqual([]);
    const listed = async (headers: Promise<Headers>): Promise<number> => (await get(`${FIXTURE}/requests`, headers)).json().data.totalitems;
    expect([await listed(requester()), await listed(tenantB())]).toEqual([0, 1]);
  });
});
