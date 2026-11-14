/** carch raw Site Manager actions of `routes/v1/carch.ts` over the recording pool and an identity double: locks, quick edits, clipboard, approvals, trees, flat view, prompts and their fragments. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { LEGACY_ADMIN_SENTINEL_ID, LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import {
  CSRF_CONSUME_PATH,
  legacyParamsOf,
  sendLegacyResponse,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { UndefinedLegacyElementError } from '../../src/domain/content.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { SESSION_EFFECTS_HEADER, adminCsrf, circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { carchRawActions, type CarchRawResult } from '../../src/routes/v1/carch.js';
import { TEST_CLOCK, buildContentApp, userHeaders, type ContentTestApp } from '../helpers/app.js';

type Json = Record<string, unknown>;
type RawAction = keyof typeof carchRawActions;

const SITE = TENANT_A.siteId;
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const OTHER_USER = 'C1D2E3F4-0009-4A5B-8C7D9E0F1A2B3C4D';
const SITE_MANAGER = '00000000000000000000000000000000000';
const COMPONENTS = '00000000000000000000000000000000003';
const END = '00000000000000000000000000000000END';
const HOME = LEGACY_ADMIN_SENTINEL_ID;
const PAGE = 'A1000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const KID = 'A1000000-0002-4A5B-8C7D9E0F1A2B3C4D';
const PROMO = 'A1000000-0003-4A5B-8C7D9E0F1A2B3C4D';
const BANNER = 'A1000000-0004-4A5B-8C7D9E0F1A2B3C4D';
const HOME_HIST = 'B1000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const PAGE_HIST = 'B1000000-0002-4A5B-8C7D9E0F1A2B3C4D';
const DRAFT_HIST = 'B1000000-0003-4A5B-8C7D9E0F1A2B3C4D';
const KID_HIST = 'B1000000-0004-4A5B-8C7D9E0F1A2B3C4D';
const PROMO_HIST = 'B1000000-0005-4A5B-8C7D9E0F1A2B3C4D';
const FILE = 'F1000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const REQUEST = 'D1000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const CHAIN = 'D1000000-0002-4A5B-8C7D9E0F1A2B3C4D';
const GROUP = 'D1000000-0003-4A5B-8C7D9E0F1A2B3C4D';
const CHANGESET = 'E1000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const CAT_A = 'E2000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const CAT_B = 'E2000000-0002-4A5B-8C7D9E0F1A2B3C4D';
const SUBTYPE = 'E3000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const EXTEND_SET = 'E3000000-0002-4A5B-8C7D9E0F1A2B3C4D';
const PUBLISHED_AT = new Date(2026, 5, 1, 9, 0, 0, 0);
const DRAFTED_AT = new Date(2026, 5, 2, 10, 30, 0, 0);
const LATER = new Date(2026, 5, 3, 8, 0, 0, 0);
const TOKEN = { 'x-csrf_token': 'T0KEN', 'x-csrf_token_expires': '260630235959000' } as const;
const EDITOR_ROLES = [moduleRole(SITE_MANAGER)];
const HTML = 'text/html;charset=UTF-8';
const JSON_UTF8 = 'application/json;charset=utf-8';

/** A stored content version of tenant-a, active and approved unless overridden. */
function version(contentid: string, contenthistid: string, extra: Json = {}): Json {
  return {
    contentid,
    contenthistid,
    siteid: SITE,
    moduleid: SITE_MANAGER,
    parentid: HOME,
    type: 'Page',
    subtype: 'Default',
    title: 'About Us',
    menutitle: 'About Us',
    filename: 'about-us',
    urltitle: 'about-us',
    active: 1,
    approved: 1,
    display: 1,
    isnav: 1,
    restricted: 0,
    restrictgroups: null,
    orderno: 1,
    sortby: 'orderno',
    sortdirection: 'asc',
    lastupdate: PUBLISHED_AT,
    lastupdateby: 'Admin User',
    lastupdatebyid: USER_ID,
    changesetid: null,
    fileid: null,
    path: null,
    inheritobjects: 'Inherit',
    template: '',
    childtemplate: '',
    approvalstatus: null,
    approvalgroupid: null,
    requestid: null,
    ...extra,
  };
}

let t: ContentTestApp;
let ctx: ContentRouteContext;
let last: { out?: CarchRawResult; error?: unknown } = {};
let versions: Json[] = [];
let stats: Json[] = [];
const calls: ServiceRequest[] = [];
const consumed: CsrfConsumeRequest[] = [];
const identity = { adminState: {} as Json, user: { userID: USER_ID } as Json, userStatus: 200, csrfValid: true };

/** Whether any flattened statement parameter equals `id` ignoring case. */
function bound(params: readonly unknown[], id: unknown): boolean {
  const wanted = typeof id === 'string' ? id.toLowerCase() : '';
  return params.flat().some((value) => typeof value === 'string' && value.toLowerCase() === wanted);
}

/** The active versions whose `column` is one of the statement's parameters. */
const activeBy = (column: string) => (params: readonly unknown[]): Json[] => versions.filter((row) => row.active === 1 && bound(params, row[column]));

/** Answers the content, crumb, tree, stats and subtype reads from `versions` and `stats`. */
function seedWorld(): void {
  versions = [
    version(HOME, HOME_HIST, { parentid: END, title: 'Home', menutitle: 'Home', filename: '', urltitle: '' }),
    version(PAGE, PAGE_HIST, { fileid: FILE }),
    version(PAGE, DRAFT_HIST, { active: 0, approved: 0, title: 'About Us Draft', menutitle: 'About Us Draft', lastupdate: DRAFTED_AT }),
    version(KID, KID_HIST, { parentid: PAGE, title: 'Team', menutitle: 'Team', filename: 'about-us/team', orderno: 2 }),
    version(PROMO, PROMO_HIST, { parentid: COMPONENTS, moduleid: COMPONENTS, type: 'Component', title: 'Promo', menutitle: 'Promo', filename: null }),
  ];
  stats = [];
  t.db.respond(/^SELECT tcontent\.active, tcontent\.approved, tcontent\.audience/, (params, sql) =>
    / WHERE tcontent\.contenthistid = /.test(sql) ? versions.filter((row) => bound(params, row.contenthistid)) : activeBy('contentid')(params),
  );
  t.db.respond(/tapprovalassignments\.exemptid FROM /, activeBy('contentid'));
  t.db.respond(/ WHERE tcontent\.siteid = \$1 AND tcontent\.active = 1 AND tcontent\.contentid = ANY/, activeBy('contentid'));
  t.db.respond(/ WHERE tcontent\.siteid = \$1 AND tcontent\.parentid = ANY/, (params) =>
    activeBy('parentid')(params).map((row) => ({ ...row, haskids: versions.filter((kid) => kid.active === 1 && kid.parentid === row.contentid).length })),
  );
  t.db.respond(/^SELECT count\(tcontent\.parentid\)::integer AS kids /, (params) => [{ kids: activeBy('parentid')(params).length }]);
  t.db.respond(/FROM "content"\."content_stats" s WHERE /, (params) => stats.filter((row) => bound(params, row.contentid)));
  t.db.respond(/tcontent\.approved = 0 AND tcontent\.changesetid IS NULL ORDER BY /, (params) =>
    versions.filter((row) => row.approved === 0 && row.active === 0 && bound(params, row.contentid)),
  );
}

beforeAll(async () => {
  t = await buildContentApp({
    declare: (app: FastifyInstance) => {
      const db = app.opt2.db;
      if (db === undefined) throw new TypeError('the test app has no pool');
      ctx = {
        domain: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS },
        clock: TEST_CLOCK,
        actorFor: (request: FastifyRequest) => Promise.resolve(actorFromClaims(request.opt2Auth.user, 'Admin User')),
      } as Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'> as ContentRouteContext;
      // The raw flow the raw router gives each entry: the circuit gate, the CSRF consume where it names a context, then the entry.
      for (const [action, spec] of Object.entries(carchRawActions)) {
        app.route({
          method: ['GET', 'POST'],
          url: `/v1/raw/carch/${action}`,
          config: circuitRouteConfig('carch'),
          handler: async (request, reply) => {
            const siteId = legacyParamsOf(request).siteid;
            const actor = await requireCircuitAccess(request, ctx, 'carch', typeof siteId === 'string' ? siteId : '');
            if ('csrfContext' in spec) await adminCsrf(spec.csrfContext).call(app, request, reply);
            try {
              last.out = await spec.run(request, ctx, actor);
            } catch (error) {
              last.error = error;
              throw error;
            }
            const out = last.out;
            return sendLegacyResponse(reply, { status: out.status, headers: { 'content-type': out.contentType, ...out.headers }, body: out.body });
          },
        });
      }
    },
  });
  const request = (req: ServiceRequest): Promise<ServiceResponse> => {
    calls.push(req);
    const answer = (status: number, body: unknown): Promise<ServiceResponse> => Promise.resolve({ status, headers: {}, body });
    if (req.service === 'identity' && req.path === '/v1/sessions/current/admin-state') return answer(200, req.method === 'GET' ? identity.adminState : {});
    if (req.service === 'identity' && req.path === '/v1/sessions/current') return answer(identity.userStatus, { user: identity.user });
    if (req.service === 'identity' && req.path === '/v1/csrf/tokens') {
      const { contexts } = req.json as { contexts: string[] };
      return answer(200, { tokens: contexts.map((context) => ({ context, csrf_token: `T-${context}`, csrf_token_expires: '260630235959000' })) });
    }
    if (req.service === 'identity' && req.path === CSRF_CONSUME_PATH) {
      consumed.push(req.json as CsrfConsumeRequest);
      return answer(200, { valid: identity.csrfValid });
    }
    return Promise.reject(new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`));
  };
  Object.defineProperty(t.app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.db.reset();
  calls.length = 0;
  consumed.length = 0;
  last = {};
  Object.assign(identity, { adminState: {}, user: { userID: USER_ID, fname: 'Ada', lname: 'Admin', email: 'ada@example.com' }, userStatus: 200, csrfValid: true });
  seedWorld();
});

/** Posts raw `action` with `form` as a user of tenant-a: an S2 unless `roles` names an editor's grants. */
async function raw(action: RawAction, form: Record<string, string> = {}, opts: { roles?: readonly string[]; headers?: Record<string, string> } = {}) {
  const roles = opts.roles ?? [Roles.s2];
  const auth = await userHeaders({ sub: USER_ID, site: SITE, roles, s2: roles.includes(Roles.s2) });
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/raw/carch/${action}?siteid=${SITE}`,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', ...opts.headers },
    payload: new URLSearchParams(form).toString(),
  });
  return { res, out: last.out, error: last.error };
}

/** The session effects a raw answer carries, parsed. */
function effectsOf(out: CarchRawResult | undefined): Json | undefined {
  const header = out?.headers?.[SESSION_EFFECTS_HEADER];
  return header === undefined ? undefined : (JSON.parse(header) as Json);
}

/** Whether any recorded statement matches `pattern`. */
const ran = (pattern: RegExp): boolean => t.db.statements.some((statement) => pattern.test(statement.sql));

/** The row a single-row `INSERT INTO <table> (columns) VALUES ($1, …)` binds, by column. */
function boundRow(sql: string, params: readonly unknown[]): Json {
  const columns = (/^INSERT INTO \S+ \(([^)]*)\)/.exec(sql)?.[1] ?? '').split(', ').map((column) => column.replace(/"/g, ''));
  return Object.fromEntries(columns.map((column, i) => [column, params[i]]));
}

/** The rows `INSERT INTO "content"."<table>"` statements bound. */
const inserted = (table: string): Json[] =>
  t.db.statements.filter((statement) => statement.sql.startsWith(`INSERT INTO "content"."${table}" (`)).map((statement) => boundRow(statement.sql, statement.params));

/** Statements other than transaction control, settings and gate reads. */
const dataStatements = () => t.db.statements.filter((statement) => !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SELECT set_config|SELECT unit, )/.test(statement.sql));

describe('raw entry table', () => {
  it('names a CSRF context only for lockfile, savequickedit, unlockfile and unlocknode: rc.contentid then the action suffix', () => {
    const request = { query: { ContentID: 'AbC-1' }, headers: {} } as unknown as FastifyRequest;
    const contexts = Object.entries(carchRawActions).flatMap(([action, spec]) => ('csrfContext' in spec ? [[action, spec.csrfContext(request)]] : []));
    expect(contexts).toEqual([
      ['lockfile', 'AbC-1lockfile'],
      ['savequickedit', 'AbC-1quickedit'],
      ['unlockfile', 'AbC-1unlockfile'],
      ['unlocknode', 'AbC-1unlocknode'],
    ]);
  });
});

describe('savequickedit', () => {
  it.each([
    ['isnav', { isnav: '0' }, { isnav: 0 }],
    ['display', { display: '2', displayStart: '2026-07-01 08:00:00', displayStop: '', displayInterval: 'Daily' }, { display: 2, displayinterval: 'Daily' }],
    ['Template', { template: 'two.cfm', childTemplate: 'one.cfm' }, { template: 'two.cfm', childtemplate: 'one.cfm' }],
    ['inheritObjects', { inheritObjects: 'Reject' }, { inheritobjects: 'Reject' }],
  ] as const)('saves attribute %s of an Editor’s node without drafts, consuming `<contentid>quickedit`, with an empty body', async (attribute, fields, saved) => {
    versions = versions.filter((row) => row.contenthistid !== DRAFT_HIST);
    t.db.respond(/^INSERT INTO "content"\."content" \(/, (params, sql) => [{ ...boundRow(sql, params), tcontent_id: 7 }]);
    const { res } = await raw('savequickedit', { contentID: PAGE, attribute, ...fields }, { headers: TOKEN });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe(HTML);
    expect(res.body).toBe('');
    expect(consumed.map(({ context }) => context)).toEqual([`${PAGE}quickedit`]);
    const [row] = inserted('content');
    expect(row).toMatchObject({ contentid: PAGE, approved: 1, active: 1, ...saved });
  });

  it.each([
    ['a refused token', { attribute: 'isnav', isnav: '0' }, false, [Roles.s2], () => versions.filter((row) => row.contenthistid !== DRAFT_HIST)],
    ['an attribute outside the switch', { attribute: 'title', title: 'New' }, true, [Roles.s2], () => versions.filter((row) => row.contenthistid !== DRAFT_HIST)],
    ['a node with drafts', { attribute: 'isnav', isnav: '0' }, true, [Roles.s2], () => versions],
    ['a user who is no Editor of the node', { attribute: 'isnav', isnav: '0' }, true, EDITOR_ROLES, () => versions.filter((row) => row.contenthistid !== DRAFT_HIST)],
  ] as const)('saves nothing for %s and still answers the empty 200', async (_case, form, valid, roles, world) => {
    versions = world();
    identity.csrfValid = valid;
    const { res } = await raw('savequickedit', { contentID: PAGE, ...form }, { roles, headers: TOKEN });
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, HTML, '']);
    expect(ran(/^INSERT INTO "content"\."content" /)).toBe(false);
    if (!valid) expect(ran(/"content"\."content"/)).toBe(false);
  });
});

describe('lockfile', () => {
  it('file-locks the node for an S2 and redirects to the attachment download of its file', async () => {
    const { res, out } = await raw('lockfile', { contentid: PAGE }, { headers: TOKEN });
    expect(res.statusCode).toBe(302);
    const location = `/index.cfm/_api/render/file/?fileid=${FILE}&method=attachment`;
    expect(res.headers.location).toBe(location);
    expect(out).toEqual({ status: 302, contentType: HTML, body: '', redirect: location, headers: { location } });
    expect(consumed.map(({ context }) => context)).toEqual([`${PAGE}lockfile`]);
    expect(t.db.statements.filter((s) => /"content"\."content_stats"/.test(s.sql) && /^(INSERT|UPDATE)/.test(s.sql)).flatMap((s) => s.params)).toEqual(
      expect.arrayContaining([USER_ID, 'file']),
    );
  });

  it('answers the empty abort without reading content when the token is refused', async () => {
    identity.csrfValid = false;
    const { res } = await raw('lockfile', { contentid: PAGE }, { headers: TOKEN });
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, HTML, '']);
    expect(dataStatements()).toEqual([]);
  });

  it('answers the empty abort without a lock for a user who is neither author nor editor of the node', async () => {
    const { res } = await raw('lockfile', { contentid: PAGE }, { roles: EDITOR_ROLES, headers: TOKEN });
    expect([res.statusCode, res.body]).toEqual([200, '']);
    expect(ran(/^(INSERT INTO|UPDATE) "content"\."content_stats"/)).toBe(false);
  });

  it('fails as legacy does on an ajax request without a contentid', async () => {
    const { res, error } = await raw('lockfile', { ajaxrequest: 'true' }, { headers: TOKEN });
    expect(res.statusCode).toBe(500);
    expect(error).toBeInstanceOf(UndefinedLegacyElementError);
    expect((error as Error).message).toBe('Element CONTENTID is undefined in RC.');
  });
});

describe.each(['unlockfile', 'unlocknode'] as const)('%s', (action) => {
  it('clears the actor’s own lock, consuming `<contentid><action>`, with an empty body', async () => {
    stats = [{ contentid: PAGE, siteid: SITE, lockid: USER_ID, locktype: 'file' }];
    const { res, out } = await raw(action, { contentid: PAGE }, { roles: EDITOR_ROLES, headers: TOKEN });
    expect(out).toEqual({ status: 200, contentType: HTML, body: '' });
    expect(res.body).toBe('');
    expect(consumed.map(({ context }) => context)).toEqual([`${PAGE}${action}`]);
    expect(ran(/^(INSERT INTO|UPDATE) "content"\."content_stats"/)).toBe(true);
  });

  it.each([
    ['a refused token', false, USER_ID, EDITOR_ROLES],
    ['another user’s lock held against a non-S2', true, OTHER_USER, EDITOR_ROLES],
  ] as const)('writes nothing for %s', async (_case, valid, lockId, roles) => {
    identity.csrfValid = valid;
    stats = [{ contentid: PAGE, siteid: SITE, lockid: lockId, locktype: 'node' }];
    const { res } = await raw(action, { contentid: PAGE }, { roles, headers: TOKEN });
    expect([res.statusCode, res.body]).toEqual([200, '']);
    expect(ran(/^(INSERT INTO|UPDATE) "content"\."content_stats"/)).toBe(false);
  });

  it('lets an S2 clear another user’s lock', async () => {
    stats = [{ contentid: PAGE, siteid: SITE, lockid: OTHER_USER, locktype: 'node' }];
    await raw(action, { contentid: PAGE }, { headers: TOKEN });
    expect(ran(/^(INSERT INTO|UPDATE) "content"\."content_stats"/)).toBe(true);
  });
});

describe('savecopyinfo and sitemanagertab', () => {
  it('records the clipboard as session effects without consuming a token or touching the database', async () => {
    const { res, out } = await raw('savecopyinfo', { contentID: PAGE, moduleid: COMPONENTS, copyAll: 'true' }, { headers: TOKEN });
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, HTML, '']);
    expect(effectsOf(out)).toEqual({ mura: { copySiteID: SITE, copyContentID: PAGE, copyModuleID: COMPONENTS, copyAll: 'true' } });
    expect(res.headers[SESSION_EFFECTS_HEADER]).toBe(out?.headers?.[SESSION_EFFECTS_HEADER]);
    expect([consumed, dataStatements()]).toEqual([[], []]);
  });

  it('records the tab under the session’s site, keeping its other flat view arguments, without consuming a token', async () => {
    identity.adminState = { siteid: 'Tenant-A', mura: { flatViewArgs: { 'Tenant-A': { sortby: 'title', TAB: 0 }, other: { tab: 3 } } } };
    const { res, out } = await raw('sitemanagertab', { tab: '2' }, { headers: TOKEN });
    expect([res.statusCode, res.body]).toEqual([200, '']);
    expect(effectsOf(out)).toEqual({ mura: { flatViewArgs: { 'Tenant-A': { sortby: 'title', TAB: '2' }, other: { tab: 3 } } } });
    expect(consumed).toEqual([]);
  });

  it('keys the tab by the token’s site when the session holds none', async () => {
    const { out } = await raw('sitemanagertab', { tab: '1' });
    expect(effectsOf(out)).toEqual({ mura: { flatViewArgs: { [SITE]: { tab: '1' } } } });
  });

  it.each([
    ['savecopyinfo', { contentID: PAGE }, 'Element COPYALL is undefined in RC.'],
    ['savecopyinfo', { copyAll: 'false' }, 'Element CONTENTID is undefined in RC.'],
    ['sitemanagertab', {}, 'Element TAB is undefined in RC.'],
  ] as const)('%s fails as legacy does without %j', async (action, form, message) => {
    const { res, error } = await raw(action, { ajaxrequest: 'true', ...form });
    expect(res.statusCode).toBe(500);
    expect((error as Error).message).toBe(message);
  });
});

describe('approvalaction', () => {
  const PENDING = { tenant_id: TENANT_A.tenantId, requestid: REQUEST, contenthistid: DRAFT_HIST, chainid: CHAIN, groupid: GROUP, siteid: SITE, userid: OTHER_USER, status: 'Pending', created: PUBLISHED_AT };

  it('rejects a pending request and answers {contenthistid, previewurl} as bare JSON, consuming no token', async () => {
    t.db.respond(/^SELECT \* FROM "content"\."approval_request" WHERE /, [PENDING]);
    t.db.respond(/^UPDATE "content"\."approval_request" /, [{ ...PENDING, status: 'Rejected' }]);
    const { res, out } = await raw('approvalaction', { requestID: REQUEST, action: 'reject', comment: 'Not yet' }, { headers: TOKEN });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=UTF-8');
    expect(out?.headers).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ contenthistid: DRAFT_HIST, previewurl: `/about-us/?previewid=${DRAFT_HIST}` });
    expect(res.body.endsWith('} ')).toBe(true);
    expect(consumed).toEqual([]);
    expect('csrfContext' in carchRawActions.approvalaction).toBe(false);
    expect(inserted('approval_action')).toEqual([expect.objectContaining({ requestid: REQUEST, actiontype: 'Rejection', comments: 'Not yet', userid: USER_ID })]);
  });

  it('fails as legacy does without a comment, before writing', async () => {
    const { res, error } = await raw('approvalaction', { ajaxrequest: 'true', requestID: REQUEST, action: 'approve' });
    expect(res.statusCode).toBe(500);
    expect((error as Error).message).toBe('Element COMMENT is undefined in RC.');
    expect(dataStatements()).toEqual([]);
  });
});

describe('getaudittrail and getimagesizeurl', () => {
  it('lists a version’s id as the JSON audit trail, and [] for an unknown version', async () => {
    const found = await raw('getaudittrail', { contenthistid: PAGE_HIST });
    expect([found.res.statusCode, found.res.headers['content-type'], found.res.body]).toEqual([200, JSON_UTF8, `["${PAGE_HIST}"]`]);
    const missing = await raw('getaudittrail', { contenthistid: 'nope' });
    expect(missing.res.body).toBe('[]');
  });

  it.each([
    ['a stored file, with the extension read in the file pool', FILE, [{ fileid: FILE, fileext: 'png' }], `"/sites/${TENANT_UMBRELLA.siteId}/cache/file/${FILE}_small.png"`],
    ['no file id, without a file read', '', [], ''],
  ] as const)('answers the rendition URL of %s as a JSON string', async (_case, fileid, files, body) => {
    t.db.respond(/^SELECT fileid, fileext, filesize, filename AS assocfilename/, files);
    const { res } = await raw('getimagesizeurl', { fileid, size: 'small' });
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, JSON_UTF8]);
    if (body !== '') expect(res.body).toBe(body);
    else expect(JSON.parse(res.body)).toEqual(expect.any(String));
    expect(t.db.statements.find((s) => /^SELECT fileid, fileext/.test(s.sql))?.tenantId).toBe(fileid === '' ? undefined : TENANT_UMBRELLA.tenantId);
  });
});

describe('downloaddata', () => {
  it('sends the form’s responses as the legacy CSV download with its Content-Disposition and Expires headers', async () => {
    versions.push(version('A1000000-0009-4A5B-8C7D9E0F1A2B3C4D', 'B1000000-0009-4A5B-8C7D9E0F1A2B3C4D', { type: 'Form', title: 'Contact Us Now', moduleid: '00000000000000000000000000000000004' }));
    t.db.respond(/^SELECT responsedisplayfields FROM "content"\."content"/, [{ responsedisplayfields: 'Name^Comment' }]);
    const packet = "<wddxPacket version='1.0'><header/><data><struct><var name='NAME'><string>Ann \"A\"</string></var><var name='COMMENT'><string>Hi</string></var></struct></data></wddxPacket>";
    t.db.respond(/FROM "content"\."form_response_packet"/, [{ responseid: 'R', formid: 'A1000000-0009-4A5B-8C7D9E0F1A2B3C4D', entered: PUBLISHED_AT, data: packet, fieldlist: 'Name,Comment' }]);
    const { res, out } = await raw('downloaddata', { contentid: 'A1000000-0009-4A5B-8C7D9E0F1A2B3C4D', sortby: 'Entered', sortdirection: 'asc', keywords: '', columns: 'fixed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(out?.contentType).toBe('application/msexcel');
    expect(out?.headers).toEqual({ 'content-disposition': 'attachment;filename=Contact-Us-Now_063026.csv', expires: '0' });
    expect(res.headers['content-disposition']).toBe('attachment;filename=Contact-Us-Now_063026.csv');
    expect(res.body).toBe('DATE/TIME ENTERED,Name,Comment,\r\n2026-06-01 09:00:00.0,"Ann ""A""","Hi",\r\n');
  });
});

describe('loaddiff', () => {
  it('diffs the older version against the newer as a bare fragment, one heading per differing property', async () => {
    const { res, out } = await raw('loaddiff', { contenthistid1: DRAFT_HIST, contenthistid2: PAGE_HIST });
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, HTML]);
    expect(out?.headers).toBeUndefined();
    expect(res.body).toMatch(/^<h3>[A-Z]+<\/h3>/);
    expect(res.body).toContain('<h3>TITLE</h3>');
    expect(res.body).toContain('<h3>MENUTITLE</h3>');
    expect(res.body).not.toMatch(/<html|<body|mura-header/i);
  });

  it('prints the no-difference label for two unknown versions', async () => {
    const { res } = await raw('loaddiff', { contenthistid1: 'x', contenthistid2: 'y' });
    expect(res.body).toBe('There are no differences between the content versions');
  });

  it('fails as legacy does without the second version id', async () => {
    const { error } = await raw('loaddiff', { ajaxrequest: 'true', contenthistid1: PAGE_HIST });
    expect((error as Error).message).toBe('Element CONTENTHISTID2 is undefined in RC.');
  });
});

describe('draftpromptdata', () => {
  /** The prompt's JSON answer, parsed. */
  const prompt = async (form: Record<string, string>) => {
    const { res, out } = await raw('draftpromptdata', form);
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, JSON_UTF8]);
    return { data: JSON.parse(res.body) as Json, out };
  };

  it('prompts for the newer draft of a published node', async () => {
    const { data } = await prompt({ contentid: PAGE });
    expect(data).toMatchObject({ verdict: 'editor', publishedhistoryid: PAGE_HIST, hasdraft: 'true', historyid: DRAFT_HIST });
  });

  it('prompts for the home node when no node is named', async () => {
    const { data } = await prompt({ contentid: '', homeid: HOME });
    expect(data).toMatchObject({ publishedhistoryid: HOME_HIST, hasdraft: 'false' });
  });

  it.each([
    ['true', PAGE_HIST],
    ['maybe', ''],
  ] as const)('reads targetversion=%s as a CFML boolean', async (targetversion, contenthistid) => {
    const { data } = await prompt({ contentid: PAGE, targetversion, contenthistid });
    expect(data).toMatchObject({ publishedhistoryid: PAGE_HIST });
  });

  it('fails as legacy does on a target version without a contenthistid', async () => {
    const { error } = await raw('draftpromptdata', { ajaxrequest: 'true', contentid: PAGE, targetversion: 'true' });
    expect((error as Error).message).toBe('Element CONTENTHISTID is undefined in RC.');
  });
});

describe.each(['loadnotify', 'loadexpirenotify'] as const)('%s', (action) => {
  it('halts with the legacy 503 error page, reading nothing, as its recipients are people and identity data', async () => {
    const { res, error } = await raw(action, { contentid: PAGE });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(HTML);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(error).toMatchObject({ name: 'CarchHaltedError', reason: `carch-${action}-halted`, surface: 'admin' });
    expect([dataStatements(), calls]).toEqual([[], []]);
  });
});

describe('loadsitemanager', () => {
  it('answers the home tree under topid as {perm, sortby, html} JSON with the open section’s kids and the tab reset', async () => {
    identity.adminState = { siteid: SITE, openSectionList: PAGE, mura: { nextN: 20, flatViewArgs: { [SITE]: { tab: 2 } } } };
    const { res, out } = await raw('loadsitemanager', { topid: HOME, moduleid: SITE_MANAGER, sortby: '', startrow: '1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_UTF8);
    // mura.json escapes single quotes as \', which strict JSON rejects, so the struct is read off the text.
    expect(res.body).toMatch(/^\{"perm":"editor","sortby":"orderno","html":".*"\}$/s);
    expect(res.body).toContain(PAGE);
    expect(res.body).toContain(KID);
    expect(effectsOf(out)).toEqual({ mura: { flatViewArgs: { [SITE]: { tab: 0 } } } });
    expect(calls.some((call) => call.method === 'POST' && call.path === '/v1/sessions/current/admin-state')).toBe(false);
  });

  it('reads the module and its top from the session when the request names neither, offering the extended sort fields', async () => {
    identity.adminState = { moduleid: SITE_MANAGER, moduleTopIds: { [`m${SITE_MANAGER}`]: PAGE } };
    const subtype = (subtypeid: string, extra: Json): Json => ({ subtypeid, siteid: SITE, type: 'Page', subtype: 'Default', basetable: 'tcontent', adminonly: 0, isactive: 1, ...extra });
    t.db.respond(/^SELECT \* FROM "content"\."extend_subtype"/, [
      subtype(SUBTYPE, {}),
      subtype('E3000000-0007-4A5B-8C7D9E0F1A2B3C4D', { type: 'User', basetable: 'tusers' }),
      subtype('E3000000-0008-4A5B-8C7D9E0F1A2B3C4D', { subtype: 'Hidden', adminonly: 1 }),
    ]);
    t.db.respond(/^SELECT \* FROM "content"\."extend_set" /, (params) => (bound(params, SUBTYPE) ? [{ extendsetid: EXTEND_SET, subtypeid: SUBTYPE }] : []));
    t.db.respond(/^SELECT \* FROM "content"\."extend_attribute" /, [
      { attributeid: 1, extendsetid: EXTEND_SET, name: 'xAttrZeta', adminonly: 0 },
      { attributeid: 2, extendsetid: EXTEND_SET, name: 'xAttrSecret', adminonly: 1 },
      { attributeid: 3, extendsetid: EXTEND_SET, name: 'xAttrAlpha', adminonly: 0 },
    ]);
    const { res } = await raw('loadsitemanager', { sortby: 'orderno', sortdirection: 'asc', startrow: '1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(KID);
    const top = t.db.statements.find((s) => / WHERE tcontent\.siteid = \$1 AND tcontent\.active = 1 AND tcontent\.contentid = ANY/.test(s.sql));
    expect(bound(top?.params ?? [], PAGE)).toBe(true);
    expect(res.body).toContain('Page/Default - xAttrAlpha');
    expect(res.body.indexOf('xAttrAlpha')).toBeLessThan(res.body.indexOf('xAttrZeta'));
    expect(res.body).not.toContain('xAttrSecret');
    expect(t.db.statements.filter((s) => /^SELECT \* FROM "content"\."extend_set" /.test(s.sql))).toHaveLength(1);
  });

  it('falls back to the module top for an empty tree and stores the reset top in the session', async () => {
    versions.push(version(COMPONENTS, 'B1000000-0010-4A5B-8C7D9E0F1A2B3C4D', { parentid: END, moduleid: COMPONENTS, type: 'Module', title: 'Components', menutitle: 'Components', filename: null }));
    identity.adminState = { moduleTopIds: { m00000000000000000000000000000000000: HOME } };
    const { res } = await raw('loadsitemanager', { topid: 'missing', moduleid: COMPONENTS, sortby: 'title', sortdirection: 'desc', startrow: '1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toMatch(/^\{"perm":"editor","sortby":"title","html":/);
    const save = calls.find((call) => call.method === 'POST' && call.path === '/v1/sessions/current/admin-state');
    expect(save?.json).toEqual({ moduleTopIds: { m00000000000000000000000000000000000: HOME, [COMPONENTS]: COMPONENTS } });
  });

  it('fails on a tree without a root', async () => {
    versions = [];
    const { error } = await raw('loadsitemanager', { topid: HOME, moduleid: SITE_MANAGER });
    expect((error as Error).message).toBe(`The tree of ${HOME} has no root`);
  });
});

describe('loadsitesection and refreshsitesection', () => {
  const form = { contentid: PAGE, sortby: 'orderno', sortdirection: 'asc', startrow: '1', moduleid: SITE_MANAGER };

  it('opens a closed section: its rows as {html} and the section appended to the open list', async () => {
    identity.adminState = { openSectionList: HOME };
    const { res, out } = await raw('loadsitesection', form);
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, JSON_UTF8]);
    expect(Object.keys(JSON.parse(res.body) as Json)).toEqual(['html']);
    expect(res.body).toContain(KID);
    expect(effectsOf(out)).toEqual({ openSectionList: `${HOME},${PAGE}` });
  });

  it('closes an open section with an empty body, reading no crumbs or rows', async () => {
    identity.adminState = { openSectionList: `${HOME},${PAGE}` };
    const { res, out } = await raw('loadsitesection', form);
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, HTML, '']);
    expect(effectsOf(out)).toEqual({ openSectionList: HOME });
    expect(ran(/tapprovalassignments\.exemptid FROM /)).toBe(false);
    expect(ran(/ tcontent\.parentid = ANY/)).toBe(false);
  });

  it('refreshes a section as mura.json {html} without changing the open list', async () => {
    identity.adminState = { openSectionList: PAGE };
    const { res, out } = await raw('refreshsitesection', form);
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, HTML]);
    expect(res.body.endsWith(' ')).toBe(true);
    expect(res.body).toContain(KID);
    expect(effectsOf(out)).toBeUndefined();
  });

  it('fails as legacy does on a section request without its sort', async () => {
    const { error } = await raw('refreshsitesection', { ...form, sortdirection: '' });
    expect((error as Error).message).toBe('Element RSTOP is undefined in RC.');
  });
});

describe('siteparents', () => {
  it('shows only the search box for a new node', async () => {
    const { res, out } = await raw('siteparents', { contentid: '', parentid: HOME, keywords: 'about' });
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, HTML]);
    expect(res.body).toContain('id="parentSearch"');
    expect(out?.headers).toBeUndefined();
    expect(ran(/ AS supersort FROM /)).toBe(false);
  });

  it('lists the matches of a moved component under its module tree with each verdict and the module title', async () => {
    versions.push(version(COMPONENTS, 'B1000000-0010-4A5B-8C7D9E0F1A2B3C4D', { parentid: END, moduleid: COMPONENTS, type: 'Module', title: 'Components', menutitle: 'Components', filename: null }));
    t.db.respond(/ AS supersort FROM /, [{ ...version(BANNER, 'B1000000-0006-4A5B-8C7D9E0F1A2B3C4D', { parentid: COMPONENTS, moduleid: COMPONENTS, type: 'Folder', title: 'Banners' }), haskids: 0 }]);
    versions.push(version(BANNER, 'B1000000-0006-4A5B-8C7D9E0F1A2B3C4D', { parentid: COMPONENTS, moduleid: COMPONENTS, type: 'Folder', title: 'Banners', menutitle: 'Banners' }));
    const { res } = await raw('siteparents', { contentid: PROMO, parentid: COMPONENTS, isNew: '0', keywords: 'ban' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(BANNER);
    expect(res.body).toContain('Components');
    const search = t.db.statements.find((s) => / AS supersort FROM /.test(s.sql));
    expect(search?.params.flat()).toContain(COMPONENTS);
  });
});

describe('loadnewcontentmenu', () => {
  it('lists the add-content types of a page for a power user', async () => {
    t.db.respond(/^SELECT \* FROM "content"\."extend_subtype"/, [
      { subtypeid: SUBTYPE, siteid: SITE, type: 'Page', subtype: 'Default', isactive: 1, availablesubtypes: ' Page/Default,Folder/Default ', iconclass: '', adminonly: 0 },
    ]);
    const { res } = await raw('loadnewcontentmenu', { contentid: PAGE, contenthistid: PAGE_HIST, topid: HOME });
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, HTML]);
    expect(res.body).toContain('add-content-ui');
    expect(res.body).toContain(`parentid=${PAGE}`);
  });

  it.each([
    ['the session’s Admin membership', { memberships: `Admin;${SITE};0` }],
    ['no Admin membership', { memberships: 'Editors;tenant-a;0' }],
    ['the membership list loginByQuery builds', {}],
  ] as const)('answers an editor holding %s', async (_case, user) => {
    identity.user = { userID: USER_ID, ...user };
    const { res } = await raw('loadnewcontentmenu', { contentid: 'unknown' }, { roles: EDITOR_ROLES });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('add-content-ui');
  });

  it('halts the front-end toolbar menu, which legacy keeps in the admin layout', async () => {
    const { res, error } = await raw('loadnewcontentmenu', { contentid: PAGE, frontEndProxyLoc: 'http://tenant-a.opt2.test' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(error).toMatchObject({ name: 'CarchHaltedError', reason: 'carch-loadnewcontentmenu-halted' });
  });

  it('answers identity’s failure to read the session user as the legacy 503', async () => {
    identity.userStatus = 500;
    const { res } = await raw('loadnewcontentmenu', { contentid: PAGE }, { roles: EDITOR_ROLES });
    expect(res.statusCode).toBe(503);
  });
});

describe('loadsiteflat', () => {
  const FEED = /^SELECT tcontent\.siteid AS siteid, tcontent\.title AS title/;
  /** A feed row of the flat view. */
  const feedRow = (contentid: string, contenthistid: string, extra: Json = {}): Json => ({
    ...version(contentid, contenthistid),
    ...Object.fromEntries(['lockid', 'locktype', 'majorversion', 'minorversion', 'expires', 'created', 'islocked', 'filesize', 'fileext', 'tags'].map((column) => [column, null])),
    ...extra,
  });

  beforeEach(() => {
    identity.adminState = { siteid: SITE, mura: { flatViewArgs: { [SITE]: { tab: 1 } } } };
  });

  it('lists a page of the feed with each row’s crumbs, verdict, categories and lock owner, recording the flat view arguments', async () => {
    t.db.respond(FEED, [feedRow(PAGE, PAGE_HIST, { lockid: USER_ID }), feedRow(KID, KID_HIST, { fileid: FILE, fileext: 'png' })]);
    t.db.respond(/FROM "content"\."content_category_assign" a WHERE /, (params) => (bound(params, PAGE_HIST) ? [{ contenthistid: PAGE_HIST, categoryid: CAT_B }, { contenthistid: PAGE_HIST, categoryid: CAT_A }] : []));
    t.db.respond(/^SELECT \* FROM "content"\."category" WHERE tenant_id = \$1 AND categoryid/, (params) =>
      bound(params, CAT_A) ? [{ categoryid: CAT_A, name: 'Alpha', filename: 'alpha' }] : [{ categoryid: CAT_B, name: 'Beta', filename: 'beta' }],
    );
    t.db.respond(/AS haskids FROM "content"\."category" c/, (params) =>
      bound(params, CAT_A) ? [{ categoryid: CAT_B, name: 'Beta', isopen: 0, haskids: 0, parentid: CAT_A }] : [{ categoryid: CAT_A, name: 'Alpha', isopen: 1, haskids: 1, parentid: null }],
    );
    t.db.respond(/count\(\*\)::integer AS thecount FROM "content"\."category"/, [{ thecount: 2 }]);
    const { res, out } = await raw('loadsiteflat', { page: '1', sortby: 'lastupdate', sortdirection: 'desc' });
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, HTML]);
    expect(res.body).toContain('mura-table-grid');
    expect(res.body).toContain('Ada');
    expect(res.body).toContain(`<img src="/sites/${TENANT_UMBRELLA.siteId}/cache/file/${FILE}_small.png" /></a></div>`);
    expect(res.body.indexOf('Alpha')).toBeLessThan(res.body.indexOf('Beta'));
    const effects = effectsOf(out) as { mura: { flatViewArgs: Record<string, Json> } };
    expect(effects.mura.flatViewArgs[SITE]).toMatchObject({ tab: 1 });
    expect(t.db.statements.find((s) => /FROM "content"\."category" WHERE tenant_id = \$1 AND categoryid/.test(s.sql))?.tenantId).toBe(TENANT_UMBRELLA.tenantId);
  });

  it('halts a row locked by another user, whose name is people data', async () => {
    t.db.respond(FEED, [feedRow(PAGE, PAGE_HIST, { lockid: OTHER_USER })]);
    const { res, error } = await raw('loadsiteflat', {});
    expect(res.statusCode).toBe(503);
    expect(error).toMatchObject({ reason: 'carch-loadsiteflat-halted' });
  });

  it.each([
    ['lockedfiles', {}, (params: unknown[]) => params.includes('')],
    ['mylockedcontent', {}, (params: unknown[]) => params.flat().includes(USER_ID)],
    ['expires', {}, (params: unknown[]) => JSON.stringify(params).includes('2026-07-30') && JSON.stringify(params).includes('2025-06-30')],
    ['myexpires', {}, (params: unknown[]) => params.flat().includes(PAGE)],
    ['mydrafts', {}, (params: unknown[]) => params.flat().includes(PAGE)],
    ['myapprovals', {}, (params: unknown[]) => params.flat().includes(PAGE)],
    ['mysubmissions', {}, (params: unknown[]) => params.flat().includes(PAGE)],
  ] as const)('filters the feed by report %s', async (report, sort, check) => {
    const draft = { contentid: PAGE, contenthistid: DRAFT_HIST, lastupdate: DRAFTED_AT, publishdate: null, displaystart: PUBLISHED_AT, approvalstatus: 'Pending' };
    t.db.respond(/^SELECT contentid FROM "content"\."content" WHERE lower\(rtrim\(lastupdatebyid\)\)/, [{ contentid: PAGE }]);
    t.db.respond(/^SELECT \* FROM \(SELECT (DISTINCT )?draft\.contenthistid/, [draft]);
    t.db.respond(FEED, (params) => (check([...params]) ? [feedRow(PAGE, PAGE_HIST)] : []));
    const { res } = await raw('loadsiteflat', { report, ...sort });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(`${PAGE}deleteall`);
  });

  it.each([
    ['myapprovals', 'duedate', 'asc', LATER, null, ['Team', 'About Us']],
    ['mysubmissions', 'duedate', 'desc', PUBLISHED_AT, DRAFTED_AT, ['About Us', 'Team']],
    ['mysubmissions', 'lastupdate', 'desc', PUBLISHED_AT, null, ['About Us', 'Team']],
    ['myapprovals', 'lastupdate', 'asc', DRAFTED_AT, null, ['About Us', 'Team']],
    ['mydrafts', 'lastupdate', 'asc', PUBLISHED_AT, null, ['Team', 'About Us']],
    ['mysubmissions', 'title', 'asc', LATER, null, ['About Us', 'Team']],
  ] as const)('orders report %s by %s %s from the items’ latest drafts', async (report, sortby, sortdirection, kidUpdated, kidPublished, order) => {
    // About Us is due on its latest publish date, Team on its own publish date or else its display start; ties fall to the
    // latest update, then to the feed's order.
    const pageDraft = { contentid: PAGE, contenthistid: DRAFT_HIST, lastupdate: DRAFTED_AT, publishdate: DRAFTED_AT, displaystart: PUBLISHED_AT, approvalstatus: 'Pending' };
    const pageOlder = { ...pageDraft, contenthistid: PAGE_HIST, lastupdate: PUBLISHED_AT, publishdate: null };
    const kidDraft = { contentid: KID, contenthistid: KID_HIST, lastupdate: kidUpdated, publishdate: kidPublished, displaystart: PUBLISHED_AT, approvalstatus: 'Pending' };
    t.db.respond(/^SELECT \* FROM \(SELECT (DISTINCT )?draft\.contenthistid/, [pageDraft, pageOlder, kidDraft]);
    t.db.respond(FEED, [feedRow(PAGE, PAGE_HIST, { menutitle: 'About Us' }), feedRow(KID, KID_HIST, { menutitle: 'Team' })]);
    const { res } = await raw('loadsiteflat', { report, sortby, sortdirection });
    expect(res.statusCode, res.body).toBe(200);
    const [first, second] = order;
    expect(res.body.indexOf(`>${first}`)).toBeGreaterThan(0);
    expect(res.body.indexOf(`>${first}`)).toBeLessThan(res.body.indexOf(`>${second}`));
    if (report !== 'mydrafts') expect(res.body).toContain('Pending');
  });

  it.each([
    ['site manager keywords through the private search', { keywords: 'about', moduleid: SITE_MANAGER }, / AS supersort FROM /],
    ['module keywords as title, summary and body matches', { keywords: 'about', moduleid: COMPONENTS }, /tcontent\.title/],
    ['tags, type, subtype and category', { tags: 'news', type: 'Page', subtype: 'Default', categoryID: CAT_A }, /tcontenttags\.tag/],
  ] as const)('filters the feed by %s', async (_case, form, pattern) => {
    const { res } = await raw('loadsiteflat', form);
    expect(res.statusCode, res.body).toBe(200);
    expect(ran(pattern)).toBe(true);
    expect(res.body).toContain(ctxLabel('sitemanager.noresults'));
  });

  it('hides admin-only subtypes from a user who is no power user', async () => {
    t.db.respond(/^SELECT \* FROM "content"\."extend_subtype"/, [
      { subtypeid: SUBTYPE, siteid: SITE, type: 'Page', subtype: 'Secret', isactive: 1, adminonly: 1 },
      { subtypeid: 'E3000000-0009-4A5B-8C7D9E0F1A2B3C4D', siteid: SITE, type: 'Folder', subtype: 'Default', isactive: 1, adminonly: 0 },
    ]);
    identity.user = { userID: USER_ID, memberships: '' };
    const { res } = await raw('loadsiteflat', {}, { roles: EDITOR_ROLES });
    expect(res.statusCode, res.body).toBe(200);
    const feed = t.db.statements.find((s) => FEED.test(s.sql));
    expect(feed?.sql).toContain('NOT (');
    expect(feed?.params.flat()).toEqual(expect.arrayContaining(['Page', 'Secret']));
  });
});

/** The en label of `key` as the views print it. */
function ctxLabel(key: string): string {
  return { 'sitemanager.noresults': 'Your search returned no results.' }[key] ?? key;
}

describe('availablechangesets, assocfiles and loadfilemetadata', () => {
  it('lists the open change sets with the current one named, without the module link for an editor', async () => {
    t.db.respond(/^SELECT \* FROM "content"\."changeset" WHERE tenant_id = \$1 AND changesetid/, [{ changesetid: CHANGESET, siteid: SITE, name: 'Summer', published: 0 }]);
    t.db.respond(/^SELECT changesetid, siteid, name, description/, [{ changesetid: CHANGESET, name: 'Summer' }, { changesetid: 'E1000000-0002-4A5B-8C7D9E0F1A2B3C4D', name: 'Autumn' }]);
    const { res } = await raw('availablechangesets', { changesetID: CHANGESET, siteID: SITE }, { roles: EDITOR_ROLES });
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, HTML]);
    expect(res.body).toContain('Summer');
    expect(res.body).toContain('Autumn');
    expect(t.db.statements.find((s) => /^SELECT changesetid, siteid, name/.test(s.sql))?.params).toEqual(expect.arrayContaining([SITE, 0]));
  });

  it('searches associated files only for keywords, reading each match’s verdict once', async () => {
    t.db.respond(/ AS supersort FROM /, [
      { ...version(PAGE, PAGE_HIST, { fileid: FILE }), fileext: 'pdf', assocfilename: 'guide.pdf' },
      { ...version(PAGE, PAGE_HIST, { fileid: FILE }), fileext: 'pdf', assocfilename: 'guide.pdf' },
    ]);
    const empty = await raw('assocfiles', { type: 'File', property: 'fileid', keywords: '' });
    expect(empty.res.statusCode, empty.res.body).toBe(200);
    expect(ran(/ AS supersort FROM /)).toBe(false);
    t.db.clear();
    const found = await raw('assocfiles', { type: 'File', property: 'fileid', keywords: 'guide' }, { roles: EDITOR_ROLES });
    expect([found.res.statusCode, found.res.headers['content-type']], found.res.body).toEqual([200, HTML]);
    expect(found.res.body).toContain('value="guide"');
    expect(t.db.statements.filter((s) => /tapprovalassignments\.exemptid FROM /.test(s.sql) && bound(s.params, PAGE))).toHaveLength(1);
  });

  it.each([
    ['the version’s own metadata', [{ fileid: FILE, caption: 'Version caption', credits: 'V', alttext: 'v-alt' }], 'Version caption'],
    ['the file’s values where the version has none', [], 'File caption'],
  ] as const)('edits %s', async (_case, metadata, caption) => {
    t.db.respond(/FROM "content"\."file_metadata" WHERE /, metadata);
    t.db.respond(/^SELECT "tenant_id", "fileid", "contentid"/, [{ fileid: FILE, fileext: 'jpg', caption: 'File caption', credits: 'F', alttext: 'f-alt' }]);
    const { res } = await raw('loadfilemetadata', { fileid: FILE, contenthistid: PAGE_HIST });
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, HTML]);
    expect(res.body).toContain(caption);
  });

  it('reads no file for an empty file id', async () => {
    const { res } = await raw('loadfilemetadata', { fileid: '', contenthistid: PAGE_HIST });
    expect(res.statusCode, res.body).toBe(200);
    expect(ran(/^SELECT "tenant_id", "fileid", "contentid"/)).toBe(false);
  });
});

describe('panel answers', () => {
  it('turns a panel renderer’s session.mura writes into session effects', async () => {
    const { res, out } = await raw('loadextendedattributes', { contentHistID: 'unknown', type: 'Page', subtype: 'Default' });
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, JSON_UTF8]);
    expect(effectsOf(out)).toEqual({ mura: { editBean: null } });
  });

  it('halts a panel branch only CFML renders with the legacy 503', async () => {
    const { res, error } = await raw('loadclass', { classid: 'plugins' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(error).toMatchObject({ name: 'CarchHaltedError', reason: 'carch-loadclass-halted', message: 'carch.loadclass: plugin object classes are rendered by the CFML plugin runtime' });
  });
});

describe('loadcategoryassignment, loadcategoryfeaturestartstop and loadtagarray', () => {
  const schedule = { categoryAssignment: '2', cattrim: 'cat1', featurestart: '7/1/2026', featureStop: '7/31/2026', startHour: '8', startMinute: '0', startDayPart: 'AM', stopHour: '5', stopMinute: '30', stopDayPart: 'PM' };

  it.each([
    ['a scheduled assignment with day parts', schedule, true, 'value="07/182/2026"'],
    ['a non-numeric assignment as 0, without day parts', { ...schedule, categoryAssignment: 'x', startDayPart: '', stopDayPart: '' }, false, 'cat1'],
  ] as const)('edits %s', async (_case, form, dayParts, text) => {
    identity.adminState = { localeHasDayParts: dayParts };
    const { res } = await raw('loadcategoryassignment', form);
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, HTML]);
    expect(res.body).toContain(text);
  });

  it('fails as legacy does when the editor lacks a schedule field it prints', async () => {
    const form = Object.fromEntries(Object.entries(schedule).filter(([name]) => name !== 'startMinute'));
    const { error } = await raw('loadcategoryassignment', { ...form, ajaxrequest: 'true' });
    expect((error as Error).message).toBe('Element STARTMINUTE is undefined in RC.');
  });

  it.each([
    ['a scheduled assignment', schedule, 'scheduled'],
    ['an assignment that is not scheduled, its schedule fields unread', { categoryAssignment: '1', cattrim: 'cat1' }, 'categoryassignmentcontent'],
  ] as const)('shows the feature state of %s', async (_case, form, text) => {
    const { res } = await raw('loadcategoryfeaturestartstop', form);
    expect([res.statusCode, res.headers['content-type']], res.body).toEqual([200, HTML]);
    expect(res.body).toContain(text);
  });

  it('answers the tag cloud of a tag group as a JavaScript array literal', async () => {
    t.db.respond(/^SELECT min\(tcontenttags\.tag\) AS tag/, [{ tag: 'News', tagcount: 2 }]);
    const { res } = await raw('loadtagarray', { taggroup: 'topics' });
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, JSON_UTF8]);
    expect(res.body).toBe("[{id: 'News', toString: function() { return 'News'; } }]");
    expect(t.db.statements.find((s) => /^SELECT min\(tcontenttags\.tag\)/.test(s.sql))?.params).toEqual(expect.arrayContaining(['topics', SITE]));
  });
});
