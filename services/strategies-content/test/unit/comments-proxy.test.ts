/** commentsProxy.cfc `get`, `flag` and `getContentStats` through the service app over the recording pool; `renderCommentsPage` stays legacy-served. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LEGACY_ERROR_PAGE_HTML, LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import { getCommentValues, getContentStatsValues, type CommentValues } from '../../src/domain/comments.js';
import { CONTENT_CONFIG_DEFAULTS, type DomainDeps } from '../../src/domain/context.js';
import { STATS_DEFAULTS, statsValues } from '../../src/domain/stats.js';
import { muraJsonEncode } from '../../src/legacy/cfjson.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { COMMENTS_PROXY_PATH } from '../../src/routes/comments-proxy.js';
import {
  TEST_CLOCK,
  buildTestApp,
  createRecordingDb,
  userHeaders,
  type RecordedStatement,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';
import { IDS, contentSeed } from '../helpers/seed.js';
import { contentHeaders } from '../helpers/tokens.js';

type Row = Record<string, unknown>;
type HttpMethod = 'GET' | 'POST';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SITE = TENANT_A.siteId;
const COMMENT = IDS.comments.approved;
const WITH_STATS = IDS.content.pageTwo;
const WITHOUT_STATS = IDS.content.pageOne;
const UNKNOWN_COMMENT = 'F0000000-0000-0000-0000000000000099';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;

/** The stored `tcontentstats` row of {@link WITH_STATS}; {@link WITHOUT_STATS} has none. */
const STATS_ROW: Row = {
  tenant_id: TENANT_A.tenantId,
  contentid: WITH_STATS,
  siteid: SITE,
  views: 42,
  rating: 3.5,
  totalvotes: 4,
  upvotes: 3,
  downvotes: 1,
  comments: 0,
  majorversion: 2,
  minorversion: 1,
  lockid: '',
  locktype: '',
  disablecomments: 1,
};

// seedRecordingDb answers a table's reads with all its rows whatever the WHERE clause, so the proxy's statements are answered from the seed by their parameters.
const FIND_COMMENT = /^SELECT c\.contentid, c\.commentid, .* FROM "content"\."comment" c LEFT JOIN /;
const LOCK_COMMENT = /^SELECT \* FROM "content"\."comment" WHERE .* FOR UPDATE$/;
const UPDATE_COMMENT = /^UPDATE "content"\."comment" SET "flagcount" = \$1 WHERE "tenant_id" = \$2 AND "commentid" = \$3 RETURNING \*$/;
const COUNT_COMMENTS = /^SELECT count\(contentid\)::integer AS commentcount FROM "content"\."comment" WHERE /;
const ACTIVE_CONTENT = /FROM "content"\."content" tcontent LEFT JOIN .* WHERE tcontent\.contentid = ANY\(\$1::bpchar\[\]\) AND \(tcontent\.active = 1\) AND tcontent\.siteid = \$2 /;
const READ_STATS = /^SELECT s\.contentid, .* FROM "content"\."content_stats" s WHERE s\.contentid = ANY\(\$1::bpchar\[\]\) AND s\.siteid = \$2$/;

/** Seeded rows of `table` across every fixture tenant. */
function seededRows(table: string): Row[] {
  return contentSeed().flatMap((seed) => seed.rows.filter((entry) => entry.table.table === table).map((entry) => ({ ...entry.row })));
}

/** Whether `id` is one of the id forms a statement binds, compared as the bpchar casts compare them. */
function bindsId(bound: unknown, id: unknown): boolean {
  const forms = Array.isArray(bound) ? bound : [bound];
  return forms.some((form) => String(form).toLowerCase() === String(id).toLowerCase());
}

/** Answers the proxy's statements from the seed under the transaction's tenant, as forced RLS scopes them. */
function answerFromSeed(db: RecordingDb): void {
  const comments = seededRows('comment');
  const content = seededRows('content');
  const inTenant = (rows: readonly Row[], tenantId: string | null): Row[] => rows.filter((row) => row.tenant_id === tenantId);
  db.respond(FIND_COMMENT, (params, _sql, { tenantId }) => inTenant(comments, tenantId).filter((row) => bindsId(params[2], row.commentid)));
  db.respond(LOCK_COMMENT, (params, _sql, { tenantId }) => inTenant(comments, tenantId).filter((row) => bindsId(params[1], row.commentid)));
  db.respond(UPDATE_COMMENT, (params, _sql, { tenantId }) =>
    inTenant(comments, tenantId)
      .filter((row) => bindsId(params[2], row.commentid))
      .map((row) => ({ ...row, flagcount: params[0] })),
  );
  db.respond(COUNT_COMMENTS, (params, _sql, { tenantId }) => [
    {
      commentcount: inTenant(comments, tenantId).filter(
        (row) => bindsId(params[0], row.contentid) && row.siteid === params[1] && row.isapproved === 1 && row.isspam === params[2] && row.isdeleted === params[3],
      ).length,
    },
  ]);
  db.respond(ACTIVE_CONTENT, (params, _sql, { tenantId }) =>
    inTenant(content, tenantId).filter((row) => row.active === 1 && bindsId(params[0], row.contentid) && row.siteid === params[1]),
  );
  db.respond(READ_STATS, (params, _sql, { tenantId }) =>
    inTenant([STATS_ROW], tenantId).filter((row) => bindsId(params[0], row.contentid) && row.siteid === params[1]),
  );
}

/** Recorded writes naming `"content".<table>`. */
function writesTo(db: RecordingDb, table: string): RecordedStatement[] {
  return db.writes().filter((statement) => statement.sql.includes(`"content"."${table}"`));
}

describe('commentsProxy.cfc data methods', () => {
  let t: TestApp;
  /** The domain's dependencies over the app's pool, for the expected values. */
  let deps: DomainDeps;
  /** A site visitor relayed by the gateway: a tenant-a user token without roles; `contentHeaders('anonymous')` carries no user token and is answered 401. */
  let visitor: Record<string, string>;

  beforeAll(async () => {
    const db = createRecordingDb();
    answerFromSeed(db);
    t = await buildTestApp({ db });
    deps = { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS };
    visitor = await userHeaders({ sub: '', site: SITE, roles: [] });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    t.db.clear();
  });

  /** Calls the proxy with `fields` in the query string (GET) or the form body (POST), checking the answer against the contract. */
  async function call(method: HttpMethod, fields: string, headers: Record<string, string> = visitor): Promise<InjectResponse> {
    const res = await t.app.inject(
      method === 'GET'
        ? { method, url: `${COMMENTS_PROXY_PATH}?${fields}`, headers }
        : { method, url: COMMENTS_PROXY_PATH, headers: { ...FORM, ...headers }, payload: fields },
    );
    assertResponseMatchesOpenApi(OPENAPI, { method, path: COMMENTS_PROXY_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  /** `get`'s expected body: the domain's comment values under the bean instance id the response carries, which every load draws afresh. */
  async function expectedGetBody(body: string, commentId: string): Promise<{ text: string; values: CommentValues }> {
    const values = await getCommentValues(deps, TENANT_A.tenantId, commentId, { scheme: 'http' });
    const instanceID = /"instanceid":"([^"]+)"/.exec(body)?.[1];
    return { text: muraJsonEncode({ ...values, instanceID }), values };
  }

  it.each<[HttpMethod, string]>([
    ['GET', `method=get&commentID=${COMMENT}`],
    ['POST', `method=get&commentID=${COMMENT}&siteid=${SITE}`],
  ])('%s get answers the loaded comment bean as Mura.json encodes it, lower-cased keys, in the plain-text content type', async (method, fields) => {
    const res = await call(method, fields);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.body).toContain(`"commentid":"${COMMENT}"`);
    expect(t.db.writes()).toEqual([]);
    const expected = await expectedGetBody(res.body, COMMENT);
    expect(expected.values).toMatchObject({ isNew: 0, commentID: COMMENT, contentID: WITHOUT_STATS, name: 'Approved Reader', isApproved: 1 });
    expect(res.body).toBe(expected.text);
  });

  it('get of an unknown commentID answers a new bean holding that id, as load() leaves a miss', async () => {
    const res = await call('GET', `method=get&commentID=${UNKNOWN_COMMENT}`);

    expect(res.statusCode).toBe(200);
    const expected = await expectedGetBody(res.body, UNKNOWN_COMMENT);
    expect(expected.values).toMatchObject({ isNew: 1, commentID: UNKNOWN_COMMENT, contentID: '', siteID: '', name: '', flagCount: 0 });
    expect(res.body).toBe(expected.text);
  });

  it.each<[string, string, () => object]>([
    ['a node with stats answers its stored values', WITH_STATS, () => ({ ...STATS_ROW, contentID: WITH_STATS, siteID: SITE, isNew: 0 })],
    ['a node without stats answers the stats bean defaults under its id', WITHOUT_STATS, () => ({ ...STATS_DEFAULTS, contentID: WITHOUT_STATS, siteID: SITE })],
  ])('getContentStats of %s, writing nothing', async (_label, contentId, stored) => {
    const res = await call('GET', `method=getContentStats&contentID=${contentId}`);

    expect(res.statusCode).toBe(200);
    expect(t.db.writes()).toEqual([]);
    const values = await getContentStatsValues(deps, TENANT_A.tenantId, contentId, SITE);
    expect(values).toEqual(statsValues(stored()));
    expect(res.body).toBe(muraJsonEncode(values));
  });

  it('flag answers an empty body after one write adding 1 to the comment flag count, then refreshes the content comment stat', async () => {
    const before = seededRows('comment').find((row) => row.commentid === COMMENT)?.flagcount;
    const res = await call('POST', `method=flag&commentID=${COMMENT}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.body).toBe('');
    expect(writesTo(t.db, 'comment').map(({ params }) => params)).toEqual([[Number(before) + 1, TENANT_A.tenantId, COMMENT]]);
    // contentManager.setCommentStat: page one counts only its approved comment, not the pending, spam or deleted ones.
    const [stat] = writesTo(t.db, 'content_stats');
    const columns = (/^INSERT INTO \S+ \(([^)]*)\) VALUES/.exec(stat?.sql ?? '')?.[1] ?? '').split(', ').map((column) => column.replace(/"/g, ''));
    expect(Object.fromEntries(columns.map((column, i) => [column, stat?.params[i]]))).toMatchObject({ contentid: WITHOUT_STATS, siteid: SITE, comments: 1 });
  });

  it('defaults an omitted siteid to the token site', async () => {
    const omitted = await call('GET', `method=getContentStats&contentID=${WITH_STATS}`);
    const read = t.db.statements.find((statement) => ACTIVE_CONTENT.test(statement.sql));
    const explicit = await call('GET', `method=getContentStats&contentID=${WITH_STATS}&siteid=${SITE}`);

    expect(omitted.statusCode).toBe(200);
    expect(read?.params[1]).toBe(SITE);
    expect(omitted.body).toBe(explicit.body);
  });

  it.each<[string, string]>([
    ['get', `commentID=${COMMENT}`],
    ['flag', `commentID=${COMMENT}`],
    ['getContentStats', `contentID=${WITH_STATS}`],
  ])('refuses %s with siteid=tenant-b on a tenant-a token with 403, reading and writing nothing', async (method, argument) => {
    const res = await call('POST', `method=${method}&${argument}&siteid=${TENANT_B.siteId}`);

    expect(res.statusCode).toBe(403);
    expect(t.db.statements).toEqual([]);
  });

  it('answers 401 when the gateway relays no user token, since the call then has no tenant', async () => {
    const res = await call('GET', `method=get&commentID=${COMMENT}`, await contentHeaders('anonymous'));

    expect(res.statusCode).toBe(401);
    expect(t.db.statements).toEqual([]);
  });

  it('does not serve renderCommentsPage: the ColdFusion error page for a method the component does not run, with nothing read or rendered', async () => {
    const res = await call('GET', `method=renderCommentsPage&contentID=${WITHOUT_STATS}&pageNo=1&nextN=3`);

    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(t.db.statements).toEqual([]);
  });
});
