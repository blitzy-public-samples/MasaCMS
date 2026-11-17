/**
 * JSON API `comment` remote functions (contentCommentBean.cfc:317-428): how processRequest reaches each one, and through
 * the service app over a throwaway content schema, its write, the comment stat recount and legacy's 500 answer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qualified } from '@opt2/platform/migration-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createContentRepository } from '../../src/repo/repository.js';
import { resolveJsonApiCall, type JsonApiResolveOptions } from '../../src/routes/jsonapi.js';
import { TEST_CLOCK, buildTestApp, openContentGates, withPgSchema, type TestApp } from '../helpers/app.js';
import { seedTenantRegistry } from '../helpers/seed.js';
import { contentHeaders, type TokenSubject } from '../helpers/tokens.js';

type Family = 'api' | 'rest';
type RemoteFunction = 'delete' | 'undelete' | 'flag' | 'markAsSpam' | 'unMarkAsSpam';

const SITE = TENANT_A.siteId;
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
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
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
});

/** A comment's stored flags. */
interface CommentState {
  isdeleted: number | null;
  isspam: number | null;
  flagcount: number | null;
}

/** The flags a function starts from, so its write changes them, and the change it makes. */
const START: Readonly<Record<RemoteFunction, CommentState>> = {
  delete: { isdeleted: 0, isspam: 0, flagcount: 0 },
  undelete: { isdeleted: 1, isspam: 0, flagcount: 0 },
  flag: { isdeleted: 0, isspam: 0, flagcount: 2 },
  markAsSpam: { isdeleted: 0, isspam: 0, flagcount: 0 },
  unMarkAsSpam: { isdeleted: 0, isspam: 1, flagcount: 0 },
};
const CHANGED: Readonly<Record<RemoteFunction, Partial<CommentState>>> = {
  delete: { isdeleted: 1 },
  undelete: { isdeleted: 0 },
  flag: { flagcount: 3 },
  markAsSpam: { isspam: 1 },
  unMarkAsSpam: { isspam: 0 },
};

/** The method legacy's server_error reports: the name when jsonApiUtility defines it (`delete`), else `invalid` (oracle). */
const REPORTED: Readonly<Record<RemoteFunction, string>> = {
  delete: 'delete',
  undelete: 'invalid',
  flag: 'invalid',
  markAsSpam: 'invalid',
  unMarkAsSpam: 'invalid',
};

describe.skipIf(!(await pgAvailable()))('remote functions through the service app', () => {
  let handle: ThrowawaySchema;
  let t: TestApp<TenantDb>;
  let serial = 0;
  const repository = (): ReturnType<typeof createContentRepository> => createContentRepository({ clock: TEST_CLOCK, schema: handle.schema });

  beforeAll(async () => {
    handle = await withPgSchema();
    await seedTenantRegistry(handle);
    await openContentGates(handle);
    t = await buildTestApp({ db: handle.app });
  });

  afterAll(async () => {
    await t?.close();
    await handle?.drop();
  });

  /** A content item of its own with the target comment in `start` and one approved sibling; returns both ids. */
  async function seedThread(start: CommentState): Promise<{ contentId: string; commentId: string }> {
    serial += 1;
    const contentId = cfId('C', serial);
    const commentId = cfId('M', serial);
    const repo = repository();
    await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      const version = { siteid: SITE, type: 'Page', subtype: 'Default', moduleid: '00000000000000000000000000000000000', approved: 1, display: 1, active: 1 };
      await repo.content.insertVersion(tx, { ...version, contentid: contentId, contenthistid: cfId('H', serial), title: `Thread ${serial}` });
      const comment = { contentid: contentId, siteid: SITE, email: 'reader@x.test', comments: 'Hello', entered: new Date(2026, 5, 1, 9, 0, 0), isapproved: 1, subscribe: 0 };
      await repo.comments.insertComment(tx, { ...comment, ...start, commentid: commentId, name: 'Target' });
      await repo.comments.insertComment(tx, { ...comment, isdeleted: 0, isspam: 0, flagcount: 0, commentid: cfId('S', serial), name: 'Sibling' });
    });
    return { contentId, commentId };
  }

  async function commentState(commentId: string): Promise<CommentState | undefined> {
    const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      tx.query<CommentState>(`SELECT isdeleted, isspam, flagcount FROM ${qualified(handle.schema, 'comment')} WHERE commentid = $1`, [commentId]),
    );
    return rows[0];
  }

  /** The stored `comments` stat of the item, or undefined when it has no stats row. */
  async function commentStat(contentId: string, siteId = SITE): Promise<number | undefined> {
    const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      tx.query<{ comments: number }>(`SELECT comments FROM ${qualified(handle.schema, 'content_stats')} WHERE rtrim(contentid) = $1 AND siteid = $2`, [contentId, siteId]),
    );
    return rows[0]?.comments;
  }

  /** The item's approved comments that are neither spam nor deleted, as contentDAO.getCommentCount counts them. */
  async function liveComments(contentId: string): Promise<number> {
    const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `SELECT count(*)::integer AS n FROM ${qualified(handle.schema, 'comment')} WHERE contentid = $1 AND isapproved = 1 AND isspam = 0 AND isdeleted = 0`,
        [contentId],
      ),
    );
    return rows[0]?.n ?? 0;
  }

  async function call(family: Family, path: string, subject: TokenSubject, method: 'GET' | 'POST' = 'POST') {
    t.client.clear();
    return t.app.inject({ method, url: `${ENDPOINTS[family]}${path}`, headers: await contentHeaders(subject) });
  }

  /** Legacy's answer to every remote function call: the server_error envelope, once the function has run. */
  function expectServerError(res: Awaited<ReturnType<typeof call>>, fn: RemoteFunction): void {
    expect(res.statusCode, res.body).toBe(500);
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
    expect(res.json()).toEqual({ apiversion: 'v1', method: REPORTED[fn], error: { message: 'Unhandled Exception', code: 'server_error' } });
    expect(t.client.csrfConsumes).toEqual([]);
  }

  const each = FAMILIES.flatMap((family) => FUNCTIONS.map((fn) => ({ family, fn })));

  it.each(each)('$family $fn with comment and Site Manager module access changes the comment and recounts its content', async ({ family, fn }) => {
    const { contentId, commentId } = await seedThread(START[fn]);
    const res = await call(family, `/comment/${commentId}/${fn}`, 'site-admin');
    expectServerError(res, fn);
    expect(await commentState(commentId)).toEqual({ ...START[fn], ...CHANGED[fn] });
    expect(await commentStat(contentId)).toBe(await liveComments(contentId));
  });

  it.each(each)('$family $fn without comment module access writes only what flag writes for anyone', async ({ family, fn }) => {
    const { contentId, commentId } = await seedThread(START[fn]);
    const res = await call(family, `/comment/${commentId}/${fn}`, 'system-user');
    expectServerError(res, fn);
    if (fn === 'flag') {
      expect(await commentState(commentId)).toEqual({ ...START.flag, ...CHANGED.flag });
      expect(await commentStat(contentId)).toBe(await liveComments(contentId));
    } else {
      expect(await commentState(commentId)).toEqual(START[fn]);
      expect(await commentStat(contentId)).toBeUndefined();
    }
  });

  it.each(FAMILIES.flatMap((family) => FUNCTIONS.flatMap((fn) => [`/comment/${UNKNOWN_COMMENT}/${fn}`, `/comment/${fn}`, `/comment?id=${fn}`].map((path) => ({ family, fn, path })))))(
    '$family $path runs on a new bean: no comment changes and the empty item is recounted',
    async ({ family, fn, path }) => {
      const { contentId, commentId } = await seedThread(START[fn]);
      const res = await call(family, path, 'site-admin', 'GET');
      expectServerError(res, fn);
      expect(await commentState(commentId)).toEqual(START[fn]);
      expect(await commentStat(contentId)).toBeUndefined();
      // contentManager.setCommentStat('', '') of the new bean stores an empty item's stats row, as legacy does.
      expect(await commentStat('', '')).toBe(0);
    },
  );
});
