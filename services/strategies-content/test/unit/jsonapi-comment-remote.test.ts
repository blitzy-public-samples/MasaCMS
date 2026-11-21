/**
 * JSON API comment remote functions (contentCommentBean.cfc:317-430): how processRequest reaches each one, and through the
 * front controller over a throwaway content schema, as the Masa 7.6.1 oracle on ACF 2023 answers them (site default).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WWW_AUTHENTICATE } from '@opt2/platform/legacy-compat';
import { closeGates, openGates, qualified } from '@opt2/platform/migration-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { resolveJsonApiCall, type JsonApiResolveOptions } from '../../src/routes/jsonapi.js';
import { buildTestApp, openContentGates, withPgSchema, type TestApp } from '../helpers/app.js';
import { contentHeaders, type ContentSubject } from '../helpers/tokens.js';

type Fn = 'delete' | 'undelete' | 'flag' | 'markasspam' | 'unmarkasspam';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** The columns the remote functions write. */
interface Flags {
  isdeleted: number;
  isspam: number;
  flagcount: number;
}

const SITE = TENANT_A.siteId;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const ENTERED = new Date(2026, 5, 1, 9, 0, 0);
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const MISSING = cfId('Z', 1);
const JSON_TYPE = 'application/json;charset=utf-8';

const FNS: readonly Fn[] = ['delete', 'undelete', 'flag', 'markasspam', 'unmarkasspam'];
/** The comment's flags before the call; undelete and unmarkasspam start from the state they clear. */
const START: Readonly<Record<Fn, Flags>> = {
  delete: { isdeleted: 0, isspam: 0, flagcount: 0 },
  undelete: { isdeleted: 1, isspam: 0, flagcount: 0 },
  flag: { isdeleted: 0, isspam: 0, flagcount: 0 },
  markasspam: { isdeleted: 0, isspam: 0, flagcount: 0 },
  unmarkasspam: { isdeleted: 0, isspam: 1, flagcount: 0 },
};
/** Own oracle: the flags each function writes, and the content's approved, live comment count it then stores. */
const WRITTEN: Readonly<Record<Fn, Flags & { comments: number }>> = {
  delete: { isdeleted: 1, isspam: 0, flagcount: 0, comments: 1 },
  undelete: { isdeleted: 0, isspam: 0, flagcount: 0, comments: 2 },
  flag: { isdeleted: 0, isspam: 0, flagcount: 1, comments: 2 },
  markasspam: { isdeleted: 0, isspam: 1, flagcount: 0, comments: 1 },
  unmarkasspam: { isdeleted: 0, isspam: 0, flagcount: 0, comments: 2 },
};
/** Subjects and whether they hold comment and Site Manager module access (contentCommentBean.allowModuleAccess). */
const SUBJECTS: ReadonlyArray<[ContentSubject, boolean]> = [
  ['anonymous', false],
  ['editor', false],
  ['site-admin', true],
  ['s2', true],
];

/** The `catch (Any)` envelope reporting `method`: `delete` is a jsonApiUtility function, so isDefined keeps it; others read `invalid`. */
const serverError = (method: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"message":"Unhandled Exception","code":"server_error"}}`;

type Family = 'api' | 'rest';
type RemoteFunction = 'delete' | 'undelete' | 'flag' | 'markAsSpam' | 'unMarkAsSpam';

const REGISTERED: ReadonlySet<string> = new Set([TENANT_A, TENANT_B, TENANT_UMBRELLA].map((tenant) => tenant.siteId));
const RESOLVE: JsonApiResolveOptions = {
  siteExists: (siteId) => REGISTERED.has(siteId.toLowerCase()),
  appReloadKey: 'appreload',
  context: '',
  variations: false,
};
const ENDPOINTS: Readonly<Record<Family, string>> = { api: `/_api/json/v1/${SITE}`, rest: `/_api/rest/v1/${SITE}` };
const FAMILIES = Object.keys(ENDPOINTS) as Family[];
const FUNCTIONS: readonly RemoteFunction[] = ['delete', 'undelete', 'flag', 'markAsSpam', 'unMarkAsSpam'];
const UNKNOWN_COMMENT = cfId('F', 9999);

/** One way processRequest reaches a remote function: the request path and query, the name as sent, and whether `loadBy` loads a bean. */
interface Reach {
  label: string;
  url: (endpoint: string, fn: string) => string;
  sent: (fn: string) => string;
  loads: boolean;
}

const REACHES: readonly Reach[] = [
  { label: '<id>/<function>, upper-cased', url: (e, fn) => `${e}/comment/${UNKNOWN_COMMENT}/${fn.toUpperCase()}`, sent: (fn) => fn.toUpperCase(), loads: true },
  { label: '<function> after the entity', url: (e, fn) => `${e}/comment/${fn}`, sent: (fn) => fn, loads: false },
  { label: 'the id param', url: (e, fn) => `${e}/comment?id=${fn}`, sent: (fn) => fn, loads: false },
  { label: 'the primary key param', url: (e, fn) => `${e}/comment?commentid=${fn}`, sent: (fn) => fn, loads: false },
  { label: 'a dotted method', url: (e, fn) => `${e}/?method=comment.${fn}`, sent: (fn) => fn, loads: false },
];

function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));
}

describe('remote function resolution', () => {
  const cases = FAMILIES.flatMap((family) => FUNCTIONS.flatMap((fn) => REACHES.map((reach) => ({ family, fn, reach, title: `${family} ${fn} through ${reach.label}` }))));

  it.each(cases)('resolves $title to the bean function, reporting the name as sent', ({ family, fn, reach }) => {
    const url = reach.url(ENDPOINTS[family], fn);
    const resolved = resolveJsonApiCall({ method: 'GET', url, query: queryOf(url), body: undefined, headers: {} }, RESOLVE);
    expect(resolved.key.key).toBe(`${family}:comment.~${fn.toLowerCase()}`);
    expect(resolved.target).toMatchObject({ kind: 'remote', name: fn });
    expect(resolved.method).toBe(reach.sent(fn));
    expect(resolved.params.string('method')).toBe(reach.sent(fn));
    expect(resolved.beanId).toBe(reach.loads ? UNKNOWN_COMMENT : undefined);
  });

  it('keeps the dotted method path as `<site>/<entity>/<function>`', () => {
    const url = `${ENDPOINTS.api}/?method=comment.unMarkAsSpam`;
    expect(resolveJsonApiCall({ method: 'GET', url, query: queryOf(url), body: undefined, headers: {} }, RESOLVE).pathInfo).toEqual([SITE, 'comment', 'unMarkAsSpam']);
  });

  it.each<[string, (endpoint: string) => string, boolean]>([
    ['<id>/<function>', (e) => `${e}/comment/${UNKNOWN_COMMENT}/flag?id=${UNKNOWN_COMMENT}`, false],
    ['<function> after the entity', (e) => `${e}/comment/flag?id=${UNKNOWN_COMMENT}`, true],
    ['the id param', (e) => `${e}/comment?id=flag`, false],
  ])('leaves params.id after %s as legacy deletes it before the call (1082, 1453)', (_label, url, keepsId) => {
    const target = url(ENDPOINTS.api);
    const resolved = resolveJsonApiCall({ method: 'GET', url: target, query: queryOf(target), body: undefined, headers: {} }, RESOLVE);
    expect(Object.hasOwn(resolved.echoParams, 'id')).toBe(keepsId);
  });
});

let handle: ThrowawaySchema;
let repository: ContentRepository;
let api: TestApp<TenantDb>;
let seq = 0;

/** A comment of a fresh content item with `flags`, beside an approved sibling comment; returns both ids. */
async function thread(flags: Flags): Promise<{ contentId: string; commentId: string }> {
  seq += 1;
  const contentId = cfId('C', seq);
  const commentId = cfId('M', seq);
  await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
    const base = { contentid: contentId, siteid: SITE, email: 'ann@x.test', entered: ENTERED, isapproved: 1, subscribe: 0 };
    await repository.comments.insertComment(tx, { ...base, commentid: commentId, name: 'Ann', comments: 'First', ...flags });
    await repository.comments.insertComment(tx, { ...base, commentid: cfId('S', seq), name: 'Sib', comments: 'Second', isdeleted: 0, isspam: 0, flagcount: 0 });
  });
  return { contentId, commentId };
}

async function flagsOf(commentId: string): Promise<Flags | undefined> {
  const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
    tx.query<Flags>(`SELECT isdeleted, isspam, flagcount FROM ${qualified(handle.schema, 'comment')} WHERE commentid = $1`, [commentId]),
  );
  return rows[0];
}

/** The stored comment count of `contentId` in the site, or undefined without a stats row. */
async function statOf(contentId: string): Promise<number | undefined> {
  const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
    tx.query<{ comments: number }>(`SELECT comments FROM ${qualified(handle.schema, 'content_stats')} WHERE contentid = $1 AND siteid = $2`, [contentId, SITE]),
  );
  return rows[0]?.comments;
}

/** Drops the stats row a new bean's recount stores under contentid ''. */
async function clearBlankStat(): Promise<void> {
  await withTenant(handle.app, TENANT_A.tenantId, (tx) => tx.query(`DELETE FROM ${qualified(handle.schema, 'content_stats')} WHERE contentid = ''`));
}

async function send(method: HttpMethod, url: string, subject: ContentSubject) {
  return api.app.inject({ method, url, headers: await contentHeaders(subject) });
}

describe.skipIf(!(await pgAvailable()))('JSON API comment remote functions', () => {
  beforeAll(async () => {
    handle = await withPgSchema();
    await seedRegistry(handle.app);
    const clock = fixedClock(NOW);
    repository = createContentRepository({ clock, schema: handle.schema });
    // The service's shutdown ends its pool; the throwaway schema's drop() ends this one.
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
      withMetadata: (fn, options) => handle.app.withMetadata(fn, options),
      end: () => Promise.resolve(),
    };
    api = await buildTestApp({ db, clock });
    await openContentGates(handle);
  });

  afterAll(async () => {
    try {
      await api?.close();
    } finally {
      await handle?.drop();
    }
  });

  const pathCases = (['json', 'ajax'] as const).flatMap((family) =>
    SUBJECTS.flatMap(([subject, access]) => FNS.map((fn): [string, Fn, ContentSubject, boolean] => [family, fn, subject, access])),
  );
  it.each(pathCases)('%s <id>/%s as %s writes only with module access, or for flag, then answers the server_error 500', async (family, fn, subject, access) => {
    const { contentId, commentId } = await thread(START[fn]);
    const res = await send('GET', `/_api/${family}/v1/${SITE}/comment/${commentId}/${fn}`, subject);
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([500, JSON_TYPE, serverError(fn === 'delete' ? 'delete' : 'invalid')]);
    const { comments, ...flags } = WRITTEN[fn];
    if (access || fn === 'flag') {
      expect(await flagsOf(commentId)).toEqual(flags);
      expect(await statOf(contentId)).toBe(comments);
    } else {
      expect(await flagsOf(commentId)).toEqual(START[fn]);
      expect(await statOf(contentId)).toBeUndefined();
    }
  });

  it.each<[HttpMethod, string, Fn, string]>([
    ['POST', 'DELETE', 'delete', 'DELETE'],
    ['PUT', 'MarkAsSpam', 'markasspam', 'invalid'],
    ['DELETE', 'Flag', 'flag', 'invalid'],
  ])('%s <id>/%s runs the function on any verb and reports the name as sent when it is defined', async (method, spelled, fn, reported) => {
    const { contentId, commentId } = await thread(START[fn]);
    const res = await send(method, `/_api/json/v1/${SITE}/comment/${commentId}/${spelled}`, 's2');
    expect([res.statusCode, res.body]).toEqual([500, serverError(reported)]);
    const { comments, ...flags } = WRITTEN[fn];
    expect(await flagsOf(commentId)).toEqual(flags);
    expect(await statOf(contentId)).toBe(comments);
  });

  it.each<[string, (commentId: string) => string, ContentSubject, string, boolean]>([
    ['<fn>', () => '/comment/flag', 'anonymous', 'invalid', true],
    ['an id naming fn', () => '/comment?id=flag', 'anonymous', 'invalid', true],
    ['a dotted method', () => '/?method=comment.flag', 'anonymous', 'invalid', true],
    ['<fn> with an id, which it does not load', (commentId) => `/comment/flag?id=${commentId}`, 'anonymous', 'invalid', true],
    ['<fn> of the plural entity with further segments', () => '/comments/flag/x/y', 'anonymous', 'invalid', true],
    ['<fn> without module access', () => '/comment/delete', 'anonymous', 'delete', false],
    ['<fn> with module access', () => '/comment/delete', 's2', 'delete', true],
    ['<id>/<fn> of a missing comment', () => `/comment/${MISSING}/delete`, 's2', 'delete', true],
  ])('%s invokes a new bean of the API site: no comment changes, a recount stores contentid ""', async (_label, path, subject, reported, recounts) => {
    const { contentId, commentId } = await thread(START.flag);
    await clearBlankStat();
    const res = await send('GET', `/_api/json/v1/${SITE}${path(commentId)}`, subject);
    expect([res.statusCode, res.body]).toEqual([500, serverError(reported)]);
    expect(await flagsOf(commentId)).toEqual(START.flag);
    expect(await statOf(contentId)).toBeUndefined();
    expect(await statOf('')).toBe(recounts ? 0 : undefined);
  });

  it.each(FNS)('REST <id>/%s without credentials answers the Basic 401 and writes nothing', async (fn) => {
    const { contentId, commentId } = await thread(START[fn]);
    const res = await send('GET', `/_api/rest/v1/${SITE}/comment/${commentId}/${fn}`, 'anonymous');
    expect([res.statusCode, res.headers['www-authenticate'], res.body]).toEqual([
      401,
      WWW_AUTHENTICATE.basic,
      '{"apiversion":"v1","method":"invalid","error":{"message":"Insufficient Account Permissions","code":"invalid_request"}}',
    ]);
    expect(await flagsOf(commentId)).toEqual(START[fn]);
    expect(await statOf(contentId)).toBeUndefined();
  });

  it.each(FNS)('REST <id>/%s with a user token writes nothing: sessionless, the bean event throws first', async (fn) => {
    const { contentId, commentId } = await thread(START[fn]);
    const res = await send('GET', `/_api/rest/v1/${SITE}/comment/${commentId}/${fn}`, 's2');
    expect([res.statusCode, res.body]).toEqual([500, serverError(fn === 'delete' ? 'delete' : 'invalid')]);
    expect(await flagsOf(commentId)).toEqual(START[fn]);
    expect(await statOf(contentId)).toBeUndefined();
  });

  it('fails closed with the legacy 503 while the comment units are legacy-authoritative', async () => {
    const { contentId, commentId } = await thread(START.flag);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-comment-remote-legacy' });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-comment-remote-legacy', state: 'legacy' });
    try {
      const res = await send('GET', `/_api/json/v1/${SITE}/comment/${commentId}/flag`, 'anonymous');
      expect(res.statusCode).toBe(503);
    } finally {
      await openContentGates(handle);
    }
    expect(await flagsOf(commentId)).toEqual(START.flag);
    expect(await statOf(contentId)).toBeUndefined();
  });
});
