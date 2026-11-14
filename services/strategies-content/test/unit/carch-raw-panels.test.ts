/** carch raw panels and carch.update of routes/v1/carch.ts over the recording pool: quick edit, related content, object classes, extended attributes, status modal and update outcomes. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthDenial, Roles, moduleRole } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  CSRF_CONSUME_PATH,
  sendLegacyResponse,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { SESSION_EFFECTS_HEADER, circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { carchRawActions } from '../../src/routes/v1/carch.js';
import { TEST_CLOCK, buildContentApp, createRecordingDb, userHeaders, type ContentTestApp } from '../helpers/app.js';

type Json = Record<string, unknown>;

const RECORDED = (
  JSON.parse(readFileSync(new URL('../fixtures/legacy-admin-panels-recorded.json', import.meta.url), 'utf8')) as {
    responses: Record<string, { status: number; contentType: string; body: string }>;
  }
).responses;

const SITE = TENANT_A.siteId;
const USER = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const HOME = '00000000000000000000000000000000001';
const HOME_HIST = 'B0000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const END = '00000000000000000000000000000000END';
const SITE_TREE = '00000000000000000000000000000000000';
const NODE = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const NODE_HIST = 'A1B2C3D4-0002-4A5B-8C7D9E0F1A2B3C4D';
const OTHER = 'A1B2C3D4-0003-4A5B-8C7D9E0F1A2B3C4D';
const OTHER_HIST = 'A1B2C3D4-0004-4A5B-8C7D9E0F1A2B3C4D';
const CHAIN = 'C0000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const REQUEST = 'C0000000-0002-4A5B-8C7D9E0F1A2B3C4D';
const GROUP = 'C0000000-0003-4A5B-8C7D9E0F1A2B3C4D';
const UPDATED = new Date(2026, 5, 2, 14, 5, 6, 7);
const TOKEN = { csrf_token: 'T0KEN', csrf_token_expires: '260630235959000' } as const;
const EDITOR_ROLES = [Roles.systemUser, moduleRole(SITE_TREE)];

const CRUMBS = /tfiles\.fileext, tapprovalassignments\.chainid, tapprovalassignments\.exemptid FROM/;
const ACTIVE = /^SELECT tcontent\.active, .* WHERE tcontent\.contentid = ANY/;
const BY_HIST = /^SELECT tcontent\.active, .* WHERE tcontent\.contenthistid = ANY/;
const DRAFTS = /AND tcontent\.approved = 0 AND tcontent\.changesetid IS NULL ORDER BY tcontent\.lastupdate DESC/;
const SUBTYPES = /^SELECT \* FROM "content"\."extend_subtype" WHERE/;
const RCSETS = /^SELECT \* FROM "content"\."extend_rc_set" WHERE/;
const SETS = /^SELECT \* FROM "content"\."extend_set" WHERE/;
const ATTRIBUTES = /^SELECT \* FROM "content"\."extend_attribute" WHERE/;
const EXTEND_DATA = /^SELECT \* FROM "content"\."extend_data" WHERE tenant_id = \$1 AND baseid/;
const RELATED = /tcr\.orderno AS relatedlinkorderno, tcontent\.created AS relatedcreated FROM/;
const RELATED_LINKS = /^SELECT tcr\.relatedid, tcr\.contentid, tcr\.relatedcontentsetid, tcr\.orderno FROM/;
const MERGE = /^SELECT tcontent\.i FROM unnest/;
const FEED = /^SELECT tcontent\.siteid AS siteid, tcontent\.title AS title, /;
const PRIVATE_SEARCH = /^SELECT \* FROM \(SELECT tcontent\.contenthistid, tcontent\.contentid, tcontent\.approved/;
const SECTIONS = /^SELECT tcontent\.contentid, tcontent\.menutitle, tcontent\.type, tcontent\.siteid, tcontent\.path FROM/;
const COMPONENTS = /^SELECT tcontent\.contentid, tcontent\.menutitle, tcontent\.body, tcontent\.title, tcontent\.filename FROM/;
const FORMS = /^SELECT tcontent\.contentid, tcontent\.menutitle, tcontent\.responsechart FROM/;
const FEEDS = /^SELECT tcontentfeeds\.feedid/;
const CHAINS = /^SELECT \* FROM "content"\."approval_chain" WHERE/;
const REQUESTS = /^SELECT \* FROM "content"\."approval_request" WHERE/;
const ACTIONS = /^SELECT \* FROM "content"\."approval_action" WHERE/;
const GROUPS = /^SELECT \* FROM "content"\."group_projection" WHERE/;
const CHANGESET = /^SELECT \* FROM "content"\."changeset" WHERE/;
const STATS = /FROM "content"\."content_stats" s WHERE/;
const REGISTRY_ENTRY = /^SELECT site_id, tenant_id, .* FROM content\.tenant_registry WHERE tenant_id = \$1$/;
const CONTENT_INSERT = /^INSERT INTO "content"\."content" \(/;

const db = createRecordingDb();
const ctx = {
  domain: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS },
  clock: TEST_CLOCK,
  actorFor: (request: FastifyRequest) => Promise.resolve(actorFromClaims(request.opt2Auth.user, 'Admin User')),
} as Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'> as ContentRouteContext;

const identity: { state: Json; user: Json; csrfValid: (context: string) => boolean } = { state: {}, user: {}, csrfValid: () => true };
const consumed: CsrfConsumeRequest[] = [];
let thrown: unknown;
let t: ContentTestApp;

beforeAll(async () => {
  t = await buildContentApp({
    declare: (app: FastifyInstance) => {
      // What the planned raw route does for each entry: the circuit gate on the token's site, then the entry, sent unchanged.
      for (const [action, spec] of Object.entries(carchRawActions)) {
        app.route({
          method: ['GET', 'POST'],
          url: `/v1/raw/carch/${action}`,
          config: circuitRouteConfig('carch'),
          handler: async (request, reply) => {
            try {
              const actor = await requireCircuitAccess(request, ctx, 'carch', SITE);
              const out = await spec.run(request, ctx, actor);
              return sendLegacyResponse(reply, { status: out.status, headers: { 'content-type': out.contentType, ...out.headers }, body: out.body });
            } catch (error) {
              thrown = error;
              throw error;
            }
          },
        });
      }
    },
  });
  ctx.storage = t.storage;
  const answer = (req: ServiceRequest): ServiceResponse => {
    if (req.service === 'identity' && req.method === 'GET' && req.path === '/v1/sessions/current/admin-state') return { status: 200, headers: {}, body: identity.state };
    if (req.service === 'identity' && req.method === 'GET' && req.path === '/v1/sessions/current') return { status: 200, headers: {}, body: { user: identity.user } };
    if (req.service === 'identity' && req.method === 'POST' && req.path === '/v1/csrf/tokens') {
      const { contexts } = req.json as { contexts: string[] };
      return { status: 200, headers: {}, body: { tokens: contexts.map((context) => ({ context, csrf_token: `ISSUED-${context}`, csrf_token_expires: '260630235959000' })) } };
    }
    if (req.service === 'identity' && req.method === 'POST' && req.path === CSRF_CONSUME_PATH) {
      const consume = req.json as CsrfConsumeRequest;
      consumed.push(consume);
      return { status: 200, headers: {}, body: { valid: identity.csrfValid(consume.context) } };
    }
    throw new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`);
  };
  const request = (req: ServiceRequest): Promise<ServiceResponse> => new Promise((resolve) => resolve(answer(req)));
  Object.defineProperty(t.app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  db.reset();
  consumed.length = 0;
  thrown = undefined;
  Object.assign(identity, { state: {}, user: { userID: USER, fname: 'Admin', lname: 'User' }, csrfValid: () => true });
});

type Part = { name: string; value: string } | { name: string; filename: string; type: string; data: Buffer };

/** A multipart/form-data payload of `parts` in order. */
function multipart(parts: readonly Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----opt2-carch-test';
  const chunks = parts.flatMap((part) =>
    'data' in part
      ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`), part.data, Buffer.from('\r\n')]
      : [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`)],
  );
  return { payload: Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Injects the raw action with the actor's user token; a form makes it a POST, `parts` a multipart POST. */
async function raw(
  action: string,
  opts: { query?: Record<string, string>; form?: Record<string, string>; parts?: readonly Part[]; roles?: readonly string[]; headers?: Record<string, string> } = {},
) {
  const roles = opts.roles ?? [Roles.s2];
  const auth = await userHeaders({ sub: USER, site: SITE, roles, s2: roles.includes(Roles.s2) });
  const url = `/v1/raw/carch/${action}?${new URLSearchParams({ siteid: SITE, ...opts.query }).toString()}`;
  if (opts.parts !== undefined) {
    const body = multipart(opts.parts);
    return t.app.inject({ method: 'POST', url, headers: { ...auth, ...body.headers, ...opts.headers }, payload: body.payload });
  }
  if (opts.form !== undefined) {
    return t.app.inject({ method: 'POST', url, headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', ...opts.headers }, payload: new URLSearchParams(opts.form).toString() });
  }
  return t.app.inject({ method: 'GET', url, headers: { ...auth, ...opts.headers } });
}

/** The session effects a raw answer carries, or undefined. */
const effectsOf = (res: { headers: Record<string, unknown> }): unknown => {
  const header = res.headers[SESSION_EFFECTS_HEADER];
  return typeof header === 'string' ? JSON.parse(header) : undefined;
};

/** Asserts the legacy-shaped 503 of a halted carch case. */
function expectHalted(res: { statusCode: number }, action: string): void {
  expect(res.statusCode).toBe(503);
  expect(thrown).toBeInstanceOf(LegacyServiceUnavailableError);
  expect((thrown as LegacyServiceUnavailableError).reason).toBe(`carch-${action}-halted`);
}

/** A statement's parameters with array parameters flattened, as id lists bind them. */
const flat = (params: readonly unknown[]): unknown[] => params.flatMap((value) => (Array.isArray(value) ? (value as unknown[]) : [value]));

/** The recorded statements matching `pattern`. */
const ran = (pattern: RegExp) => db.statements.filter((statement) => pattern.test(statement.sql));

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rows each column the statement binds by `= $n`, `= ANY($n…)` or `lower(rtrim(col)) = lower(rtrim($n…))` matches, ignoring case and trailing spaces. */
const matching =
  (rows: readonly Json[], ...columns: string[]) =>
  (params: readonly unknown[], sql: string): Json[] =>
    rows.filter((row) =>
      columns.every((column) => {
        const name = escape(column);
        const bound = new RegExp(`(?:(?<![\\w.])${name} = (?:ANY\\()?|lower\\(rtrim\\(${name}\\)\\) = lower\\(rtrim\\()\\$(\\d+)`).exec(sql);
        if (bound === null) return true;
        const wanted = [params[Number(bound[1]) - 1]].flat().map((value) => String(value).trimEnd().toLowerCase());
        const value = row[column.replace(/^\w+\./, '')];
        const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
        return wanted.includes(text.trimEnd().toLowerCase());
      }),
    );

/** A content version row of tenant-a, a published Page under the home page unless overridden. */
const version = (overrides: Json = {}): Json => ({
  tenant_id: TENANT_A.tenantId,
  contentid: NODE,
  contenthistid: NODE_HIST,
  siteid: SITE,
  parentid: HOME,
  path: `${HOME},${NODE}`,
  type: 'Page',
  subtype: 'Default',
  title: 'Node',
  menutitle: 'Node',
  filename: 'node',
  active: 1,
  approved: 1,
  display: 1,
  displaystart: null,
  displaystop: null,
  displayinterval: null,
  isnav: 1,
  inheritobjects: 'Inherit',
  template: '',
  childtemplate: '',
  moduleid: SITE_TREE,
  lastupdate: UPDATED,
  lastupdateby: 'Admin User',
  lastupdatebyid: USER,
  changesetid: null,
  remoteurl: null,
  ...overrides,
});

/** The home page's active version. */
const home = (overrides: Json = {}): Json => version({ contentid: HOME, contenthistid: HOME_HIST, parentid: END, path: HOME, title: 'Home', menutitle: 'Home', filename: '', ...overrides });

/** Answers the content reads over `rows`; each version insert appends to them and deactivates the item's other versions. */
function seedContent(rows: Json[]): Json[] {
  const active = (): Json[] => rows.filter((row) => row.active === 1);
  db.respond(ACTIVE, (params, sql) => matching(active(), 'tcontent.contentid', 'tcontent.siteid')(params, sql));
  db.respond(BY_HIST, (params, sql) => matching(rows, 'tcontent.contenthistid')(params, sql));
  db.respond(CRUMBS, (params, sql) =>
    matching(active(), 'tcontent.contentid')(params, sql)
      .sort((a, b) => String(b.path).length - String(a.path).length)
      .map((row) => ({ fileext: null, chainid: null, exemptid: null, ...row })),
  );
  db.respond(CONTENT_INSERT, (params, sql) => {
    const columns = (/^INSERT INTO \S+ \(([^)]*)\) VALUES/.exec(sql)?.[1] ?? '').split(', ').map((column) => column.replace(/"/g, ''));
    const row: Json = { ...Object.fromEntries(columns.map((column, i) => [column, params[i] ?? null])), tcontent_id: rows.length + 1 };
    if (row.active === 1) for (const other of rows) if (String(other.contentid).toLowerCase() === String(row.contentid).toLowerCase()) other.active = 0;
    rows.push(row);
    return [row];
  });
  return rows;
}

/** A subtype row of tenant-a. */
const subtype = (subtypeid: string, type: string, sub: string, overrides: Json = {}): Json => ({
  tenant_id: TENANT_A.tenantId,
  subtypeid,
  siteid: SITE,
  type,
  subtype: sub,
  isactive: 1,
  basetable: 'tcontent',
  hassummary: 1,
  hasbody: 1,
  hasassocfile: 1,
  hasconfigurator: 0,
  adminonly: 0,
  iconclass: '',
  ...overrides,
});

/** Answers the extend reads over subtypes, related-content sets, extend sets, attributes and values. */
function seedExtend(data: { subtypes?: Json[]; rcsets?: Json[]; sets?: Json[]; attributes?: Json[]; values?: Json[] }): void {
  db.respond(SUBTYPES, matching(data.subtypes ?? [], 'type', 'subtype'));
  db.respond(RCSETS, matching(data.rcsets ?? [], 'subtypeid'));
  db.respond(SETS, matching(data.sets ?? [], 'subtypeid'));
  db.respond(ATTRIBUTES, matching(data.attributes ?? [], 'extendsetid'));
  db.respond(EXTEND_DATA, matching(data.values ?? [], 'baseid'));
}

describe('carchRawActions', () => {
  it('holds exactly the carch raw actions, four of them with the CSRF context legacy validates first', () => {
    expect(Object.keys(carchRawActions)).toEqual([
      'approvalaction',
      'assocfiles',
      'availablechangesets',
      'downloaddata',
      'draftpromptdata',
      'getaudittrail',
      'getimagesizeurl',
      'loadcategoryassignment',
      'loadcategoryfeaturestartstop',
      'loadclass',
      'loadclassconfigurator',
      'loaddiff',
      'loadexpirenotify',
      'loadextendedattributes',
      'loadfilemetadata',
      'loadnewcontentmenu',
      'loadnotify',
      'loadquickedit',
      'loadrelatedcontent',
      'loadselectedrelatedcontent',
      'loadsiteflat',
      'loadsitemanager',
      'loadsitesection',
      'loadtagarray',
      'lockfile',
      'refreshsitesection',
      'savecopyinfo',
      'savequickedit',
      'sitemanagertab',
      'siteparents',
      'statusmodal',
      'unlockfile',
      'unlocknode',
      'update',
    ]);
    expect(Object.entries(carchRawActions).filter(([, spec]) => 'csrfContext' in spec).map(([action]) => action)).toEqual(['lockfile', 'savequickedit', 'unlockfile', 'unlocknode']);
  });

  it.each([
    ['lockfile', 'lockfile'],
    ['savequickedit', 'quickedit'],
    ['unlockfile', 'unlockfile'],
    ['unlocknode', 'unlocknode'],
  ] as const)('derives the %s context from the request contentid and the %s suffix', (action, suffix) => {
    const request = { query: { siteid: SITE }, body: { ContentID: NODE }, headers: { 'content-type': 'application/x-www-form-urlencoded' } } as unknown as FastifyRequest;
    expect(carchRawActions[action].csrfContext(request)).toBe(`${NODE}${suffix}`);
    expect(carchRawActions[action].csrfContext({ query: {}, headers: {} } as unknown as FastifyRequest)).toBe(suffix);
  });
});

describe('loadquickedit', () => {
  const PARENT = 'A1B2C3D4-0005-4A5B-8C7D9E0F1A2B3C4D';

  it.each([
    ['isnav', { isnav: 0 }, /<select id="mura-quickEdit-isnav">\s*<option value="1">Yes<\/option>\s*<option value="0" selected>No<\/option>/],
    ['inheritObjects', { inheritobjects: 'Reject' }, /<option value="Reject" selected>/],
  ] as const)('edits %s of the node’s active version without drafts', async (attribute, overrides, markup) => {
    seedContent([home(), version(overrides)]);
    const res = await raw('loadquickedit', { query: { contentID: NODE, attribute } });
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/html;charset=UTF-8']);
    expect(res.body).toMatch(markup);
    expect(res.body).not.toContain('hasDraftsMessage');
    expect(ran(ACTIVE).map((statement) => statement.tenantId)).toEqual([TENANT_A.tenantId]);
  });

  it('answers the drafts notice for a node with drafts, without reading the attribute', async () => {
    seedContent([home(), version()]);
    db.respond(DRAFTS, [version({ contenthistid: OTHER_HIST, active: 0, approved: 0 })]);
    const res = await raw('loadquickedit', { query: { contentID: NODE } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('<p id="hasDraftsMessage">');
    expect(res.body).not.toContain('<select');
    expect(flat(ran(DRAFTS)[0]?.params ?? [])).toContain(NODE);
  });

  it('fails as legacy does without an attribute on a node without drafts', async () => {
    seedContent([version()]);
    const res = await raw('loadquickedit', { query: { contentID: NODE } });
    expect(res.statusCode).toBe(500);
    expect((thrown as Error).message).toBe('Element ATTRIBUTE is undefined in RC.');
  });

  it('halts the template editor, whose theme template list is on the legacy web root', async () => {
    seedContent([version()]);
    expectHalted(await raw('loadquickedit', { query: { contentID: NODE, attribute: 'Template' } }), 'loadquickedit');
  });

  it.each([
    ['a Calendar parent', NODE, 'Page', 'Calendar', true],
    ['a Page parent', NODE, 'Calendar', 'Page', false],
    ['the home page with ptype Calendar', HOME, 'Calendar', 'Calendar', true],
    ['the home page with ptype Page', HOME, 'Page', 'Calendar', false],
  ] as const)('schedules the display of a node under %s', async (_label, contentId, ptype, parentType, calendar) => {
    const start = new Date(2026, 6, 1, 8, 30);
    const schedule = { display: 2, displaystart: start, displaystop: new Date(2026, 6, 31, 17, 0), parentid: PARENT };
    seedContent([
      home(contentId === HOME ? schedule : {}),
      version({ contentid: PARENT, contenthistid: OTHER_HIST, type: parentType, path: `${HOME},${PARENT}` }),
      version(contentId === NODE ? schedule : {}),
    ]);
    const res = await raw('loadquickedit', { query: { contentID: contentId, attribute: 'display', ptype } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toMatch(/<option value="2"\s+selected>/);
    expect(res.body).toContain(calendar ? 'var isCalendar=true;' : 'var isCalendar=false;');
    expect(res.body).toContain('name="displayStart" value="&#x7b;ts&#x20;&#x27;2026-07-01&#x20;08&#x3a;30&#x3a;00&#x27;&#x7d;"');
    const parentReads = ran(ACTIVE).filter((statement) => flat(statement.params).includes(PARENT));
    expect(parentReads).toHaveLength(contentId === HOME ? 0 : 1);
  });
});

describe('related content', () => {
  const RS_FIRST = 'D0000000-0001-4A5B-8C7D9E0F1A2B3C4D';
  const RS_SECOND = 'D0000000-0002-4A5B-8C7D9E0F1A2B3C4D';
  const RS_FOREIGN = 'D0000000-0003-4A5B-8C7D9E0F1A2B3C4D';
  const RS_PAGE = 'D0000000-0004-4A5B-8C7D9E0F1A2B3C4D';
  const RS_BASE = 'D0000000-0005-4A5B-8C7D9E0F1A2B3C4D';
  const REMOTE = 'A1B2C3D4-0006-4A5B-8C7D9E0F1A2B3C4D';

  /** A related-content set row of `subtypeid`. */
  const rcset = (relatedcontentsetid: string, subtypeid: string, name: string, orderno: number, overrides: Json = {}): Json => ({
    tenant_id: TENANT_A.tenantId,
    relatedcontentsetid,
    subtypeid,
    siteid: SITE,
    name,
    orderno,
    entitytype: 'content',
    availablesubtypes: '',
    ...overrides,
  });

  /** Page/News with two sets out of order and one of another site, Page/Default and Base/Default with one set each. */
  function seedSets(extra: Json[] = []): void {
    seedExtend({
      subtypes: [subtype('S1', 'Page', 'News'), subtype('S2', 'Page', 'Default'), subtype('S3', 'Base', 'Default')],
      rcsets: [
        rcset(RS_SECOND, 'S1', 'Second', 2),
        rcset(RS_FIRST, 'S1', 'First', 1),
        rcset(RS_FOREIGN, 'S1', 'Foreign', 0, { siteid: TENANT_B.siteId }),
        rcset(RS_PAGE, 'S2', 'Page Default', 1),
        rcset(RS_BASE, 'S3', 'Base Default', 1),
        ...extra,
      ],
    });
  }

  /** The set ids loadselectedrelatedcontent prints, in order. */
  const printedSets = (body: string): string[] => [...body.matchAll(/<div id="rcGroup-([^"]+)" class="list-table">/g)].map((m) => m[1] ?? '');

  /** The item ids a set prints, in order. */
  const printedItems = (body: string): string[] => [...body.matchAll(/<li class="item" data-contentid="([^"]+)"/g)].map((m) => m[1] ?? '');

  /** A getRelatedContent row of `contentid` in the set `relatedcontentsetid`. */
  const related = (contentid: string, relatedcontentsetid: string, overrides: Json = {}): Json => ({
    contentid,
    contenthistid: OTHER_HIST,
    siteid: SITE,
    type: 'Page',
    subtype: 'Default',
    menutitle: 'Other',
    title: 'Other',
    filename: 'other',
    orderno: 1,
    relatedcontentsetid,
    relatedlinkorderno: 1,
    relatedcreated: UPDATED,
    ...overrides,
  });

  describe('loadselectedrelatedcontent', () => {
    it.each([
      ['Page/News', 'Page', 'News', [RS_FIRST, RS_SECOND, SITE_TREE, RS_PAGE, RS_BASE]],
      ['Page/Default', 'Page', 'Default', [RS_PAGE, SITE_TREE, RS_BASE]],
      ['Component/Default', 'Component', 'Default', [SITE_TREE]],
    ] as const)('prints the related-content sets of %s in getRelatedContentSets order', async (_label, type, sub, sets) => {
      seedContent([home(), version()]);
      seedSets();
      const res = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type, subtype: sub } });
      expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/html;charset=UTF-8']);
      expect(printedSets(res.body)).toEqual(sets);
    });

    it('prints one requested set with its related rows and crumbs, and every set for an unknown id', async () => {
      seedContent([home(), version(), version({ contentid: OTHER, contenthistid: OTHER_HIST, menutitle: 'Other', path: `${HOME},${OTHER}` })]);
      seedSets();
      db.respond(RELATED, matching([related(OTHER, RS_FIRST)], 'tcr.relatedcontentsetid'));
      const one = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'News', relatedcontentsetid: RS_FIRST.toLowerCase() } });
      expect(printedSets(one.body)).toEqual([RS_FIRST]);
      expect(printedItems(one.body)).toEqual([OTHER]);
      expect(one.body).toContain('Other');
      expect(ran(RELATED)).toHaveLength(1);
      expect(flat(ran(RELATED)[0]?.params ?? [])).toContain(NODE_HIST);
      const unknown = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'News', relatedcontentsetid: 'nope' } });
      expect(printedSets(unknown.body)).toEqual([RS_FIRST, RS_SECOND, SITE_TREE, RS_PAGE, RS_BASE]);
    });

    it('reads a related row of a content-pool site with the crumbs of that site’s tenant', async () => {
      const entry = registryEntry({ content_pool_ids: [SITE, TENANT_B.siteId], content_pool_tenants: [TENANT_A.tenantId, TENANT_B.tenantId] });
      db.respond(REGISTRY_ENTRY, (params) => [entry].filter((row) => row.tenant_id === params[0]));
      seedContent([home(), version(), version({ contentid: REMOTE, contenthistid: OTHER_HIST, siteid: TENANT_B.siteId, menutitle: 'Remote', path: REMOTE })]);
      seedSets();
      db.respond(RELATED_LINKS, [{ relatedid: REMOTE, contentid: NODE, relatedcontentsetid: RS_FIRST, orderno: 1 }]);
      db.respond(RELATED, () => (db.statements.at(-1)?.tenantId === TENANT_B.tenantId ? [related(REMOTE, RS_FIRST, { siteid: TENANT_B.siteId })] : []));
      const res = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'News', relatedcontentsetid: RS_FIRST } });
      expect(res.statusCode, res.body).toBe(200);
      expect(printedItems(res.body)).toEqual([REMOTE]);
      const remoteCrumbs = ran(CRUMBS).filter((statement) => flat(statement.params).includes(REMOTE));
      expect(remoteCrumbs.map((statement) => statement.tenantId)).toEqual([TENANT_B.tenantId]);
    });

    it.each([
      ['a related set row', { relatedcontentsetid: RS_FIRST }],
      [
        'a client row of the ad-hoc set',
        { relatedcontentsetid: 'custom', relateditems: JSON.stringify([{ contentid: REMOTE, siteid: TENANT_B.siteId, type: 'Page', subtype: 'Default', url: '', title: 'Remote' }]) },
      ],
    ] as const)('answers 403 for %s of a site outside the registered content pool, reading nothing in its tenant', async (_label, query) => {
      seedContent([home(), version(), version({ contentid: REMOTE, contenthistid: OTHER_HIST, siteid: TENANT_B.siteId, menutitle: 'Remote', path: REMOTE })]);
      seedSets();
      db.respond(RELATED, matching([related(REMOTE, RS_FIRST, { siteid: TENANT_B.siteId })], 'tcr.relatedcontentsetid'));
      const res = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'News', ...query } });
      expect(res.statusCode, res.body).toBe(403);
      expect(thrown).toBeInstanceOf(AuthDenial);
      expect((thrown as AuthDenial).reason).toBe('site-mismatch');
      expect(ran(CRUMBS).filter((statement) => flat(statement.params).includes(REMOTE))).toEqual([]);
      expect(db.statements.filter((statement) => statement.tenantId === TENANT_B.tenantId)).toEqual([]);
    });

    it('merges each content-pool tenant’s rows of the version’s links', async () => {
      const entry = registryEntry({ content_pool_ids: [SITE, TENANT_B.siteId], content_pool_tenants: [TENANT_A.tenantId, TENANT_B.tenantId] });
      db.respond(REGISTRY_ENTRY, (params) => [entry].filter((row) => row.tenant_id === params[0]));
      seedContent([home(), version(), version({ contentid: OTHER, contenthistid: OTHER_HIST, path: `${HOME},${OTHER}` }), version({ contentid: REMOTE, contenthistid: 'R', siteid: TENANT_B.siteId, path: REMOTE })]);
      seedSets();
      db.respond(RELATED_LINKS, [{ relatedid: OTHER, contentid: NODE, relatedcontentsetid: RS_FIRST, orderno: 2 }, { relatedid: REMOTE, contentid: NODE, relatedcontentsetid: RS_FIRST, orderno: 1 }]);
      db.respond(RELATED, () => {
        const tenant = db.statements.at(-1)?.tenantId;
        return tenant === TENANT_B.tenantId ? [related(REMOTE, RS_FIRST, { siteid: TENANT_B.siteId })] : [related(OTHER, RS_FIRST)];
      });
      db.respond(MERGE, [{ i: 1 }, { i: 0 }]);
      const res = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'News', relatedcontentsetid: RS_FIRST } });
      expect(res.statusCode, res.body).toBe(200);
      expect(printedItems(res.body)).toEqual([REMOTE, OTHER]);
      expect(ran(RELATED_LINKS).map((statement) => statement.tenantId)).toEqual([TENANT_A.tenantId]);
      expect(ran(RELATED).map((statement) => statement.tenantId)).toEqual([TENANT_A.tenantId, TENANT_B.tenantId]);
      expect(ran(MERGE)).toHaveLength(1);
    });

    it('prints the ad-hoc set from the client’s rows and the listed ids that exist, reading no set rows', async () => {
      const entry = registryEntry({ content_pool_ids: [SITE, TENANT_B.siteId], content_pool_tenants: [TENANT_A.tenantId, TENANT_B.tenantId] });
      db.respond(REGISTRY_ENTRY, (params) => [entry].filter((row) => row.tenant_id === params[0]));
      seedContent([
        home(),
        version(),
        version({ contentid: OTHER, contenthistid: OTHER_HIST, menutitle: 'Other', path: `${HOME},${OTHER}` }),
        version({ contentid: REMOTE, contenthistid: 'R', siteid: TENANT_B.siteId, menutitle: 'Remote', path: REMOTE }),
      ]);
      seedSets();
      const rows = JSON.stringify([
        { ContentID: OTHER, siteid: SITE, type: 'Page', subtype: 'Default', url: '', title: 'Other' },
        { contentid: REMOTE, siteid: TENANT_B.siteId, type: 3, subtype: null, url: 'http://example.com', title: 'Example' },
      ]);
      const custom = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'News', relatedcontentsetid: 'custom', relateditems: rows } });
      expect(custom.statusCode, String(thrown)).toBe(200);
      expect(printedSets(custom.body)).toEqual(['custom']);
      expect(printedItems(custom.body)).toEqual([OTHER, REMOTE]);
      expect(custom.body).toContain(`data-contentid="${REMOTE}" data-content-type="3/"`);
      expect(ran(CRUMBS).filter((statement) => flat(statement.params).includes(REMOTE)).map((statement) => statement.tenantId)).toEqual([TENANT_B.tenantId]);
      const listed = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'News', relatedcontentsetid: 'calendar', relateditems: `${OTHER},${REMOTE}` } });
      expect(printedItems(listed.body)).toEqual([OTHER]);
      expect(ran(RELATED)).toEqual([]);
    });

    it('fails as legacy does on a client row without a url', async () => {
      seedContent([home(), version()]);
      seedSets();
      const rows = JSON.stringify([{ contentid: OTHER, siteid: SITE, type: 'Page', subtype: 'Default', title: 'Other' }]);
      const res = await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'News', relatedcontentsetid: 'custom', relateditems: rows } });
      expect(res.statusCode).toBe(500);
      expect((thrown as Error).message).toBe('Element URL is undefined in ITEM.');
    });

    it('halts a set of another entity type, whose display name only the CFML entity registry holds', async () => {
      seedContent([home(), version()]);
      seedSets([rcset('D0000000-0009-4A5B-8C7D9E0F1A2B3C4D', 'S2', 'People', 3, { entitytype: 'user' })]);
      expectHalted(await raw('loadselectedrelatedcontent', { query: { contenthistid: NODE_HIST, type: 'Page', subtype: 'Default' } }), 'loadselectedrelatedcontent');
    });
  });

  describe('loadrelatedcontent', () => {
    const CATEGORY = 'E0000000-0001-4A5B-8C7D9E0F1A2B3C4D';

    /** The search results' item ids, in order. */
    const results = (body: string): string[] => [...body.matchAll(/<li class="item" data-content-type="[^"]*" data-contentid="([^"]+)">/g)].map((m) => m[1] ?? '');

    /** The node, a page the search finds and the feed's rows of it. */
    function seedSearch(): void {
      seedContent([home(), version(), version({ contentid: OTHER, contenthistid: OTHER_HIST, menutitle: 'Found Page', path: `${HOME},${OTHER}` })]);
      seedSets();
      db.respond(PRIVATE_SEARCH, [{ contentid: OTHER, contenthistid: OTHER_HIST, siteid: SITE, type: 'Page', subtype: 'Default', haskids: 0 }]);
      db.respond(FEED, [{ contentid: OTHER, contenthistid: OTHER_HIST, siteid: SITE, type: 'Page', subtype: 'Default', menutitle: 'Found Page' }]);
    }

    it('nests the category pool tree in the search form, checking the requested open category', async () => {
      seedSearch();
      const PARENT_CAT = 'D1000000-0001-4A5B-8C7D9E0F1A2B3C4D';
      const CHILD_CAT = 'D1000000-0002-4A5B-8C7D9E0F1A2B3C4D';
      const cats = [
        { siteid: SITE, categoryid: PARENT_CAT, name: 'News', parentid: null, isopen: 1, haskids: 1 },
        { siteid: SITE, categoryid: CHILD_CAT, name: 'Local <Events>', parentid: PARENT_CAT, isopen: 0, haskids: 0 },
      ];
      db.respond(/AS haskids FROM "content"\."category" c /, (params, sql) =>
        / c\.parentid IS NULL/.test(sql) ? cats.filter((cat) => cat.parentid === null) : matching(cats.filter((cat) => cat.parentid !== null), 'c.parentid')(params, sql),
      );
      const res = await raw('loadrelatedcontent', { query: { contenthistid: NODE_HIST, rcCategoryID: PARENT_CAT } });
      expect(res.statusCode, String(thrown)).toBe(200);
      expect(res.body).toContain(
        `<ul class="categories checkboxTree">\n\n<li>\n<input type="checkbox" name="rcCategoryID" class="checkbox" checked value="${PARENT_CAT}"/> News \n<ul class="categories">\n\n<li>\nLocal &lt;Events&gt; \n</li>\n\n</ul>\n\n</li>\n\n</ul>`,
      );
    });

    it('answers the search form alone for a new search, running no feed', async () => {
      seedSearch();
      const res = await raw('loadrelatedcontent', { query: { contenthistid: NODE_HIST } });
      expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/html;charset=UTF-8']);
      expect(res.body).toContain('id="rcSearch"');
      expect(res.body).not.toContain('draggableContainmentInternal');
      expect(ran(FEED)).toEqual([]);
    });

    it('searches the site with the request filters and lists the readable results with their crumbs', async () => {
      seedSearch();
      db.respond(/^SELECT \* FROM "content"\."category" WHERE tenant_id = \$1 AND upper\(path\) LIKE/, [{ categoryid: CATEGORY, path: CATEGORY }]);
      const res = await raw('loadrelatedcontent', {
        query: { contenthistid: NODE_HIST, contentid: NODE, isNew: 'false', keywords: 'found', searchTypeSelector: 'Page^Custom', rcStartDate: '6/1/2026', rcEndDate: '6/30/2026', rcCategoryID: CATEGORY },
      });
      expect(res.statusCode, String(thrown)).toBe(200);
      expect(results(res.body)).toEqual([OTHER]);
      expect(res.body).toContain('Found Page');
      const [feed] = ran(FEED);
      expect(feed?.tenantId).toBe(TENANT_A.tenantId);
      const params = flat(feed?.params ?? []);
      expect(params).toEqual(expect.arrayContaining([SITE, NODE, 'Page', 'Custom', new Date(2026, 5, 1), new Date(2026, 6, 1), OTHER, CATEGORY, 100]));
      expect(flat(ran(PRIVATE_SEARCH)[0]?.params ?? [])).toContain('%found%');
    });

    it('restricts the calendar set’s search to calendars and ignores the type selector', async () => {
      seedSearch();
      const res = await raw('loadrelatedcontent', { query: { contenthistid: NODE_HIST, isNew: '0', relatedcontentsetid: 'calendar', searchTypeSelector: 'Page^Custom' } });
      expect(res.statusCode, String(thrown)).toBe(200);
      const params = flat(ran(FEED)[0]?.params ?? []);
      expect(params).toContain('Calendar');
      expect(params).not.toContain('Custom');
      expect(ran(PRIVATE_SEARCH)).toEqual([]);
    });

    it('lists no result the actor cannot read', async () => {
      seedSearch();
      const res = await raw('loadrelatedcontent', { query: { contenthistid: NODE_HIST, isNew: '0' }, roles: EDITOR_ROLES });
      expect(res.statusCode, String(thrown)).toBe(200);
      expect(results(res.body)).toEqual([]);
      expect(res.body).toContain('<li class="item">Your search returned no results.</li>');
    });

    it('fails as legacy does on an end date that is no date', async () => {
      seedSearch();
      const res = await raw('loadrelatedcontent', { query: { contenthistid: NODE_HIST, isNew: '0', rcEndDate: 'notadate' } });
      expect(res.statusCode).toBe(500);
      expect((thrown as Error).message).toBe('The value notadate cannot be converted to a date.');
      expect(ran(FEED)).toEqual([]);
    });

    it.each([
      ['another entity type', { entitytype: 'user' }, [SITE]],
      ['a content pool of several sites', {}, [SITE, TENANT_B.siteId]],
    ] as const)('halts the results of %s', async (_label, query, pool) => {
      db.respond(REGISTRY_ENTRY, (params) => [registryEntry({ content_pool_ids: [...pool] })].filter((row) => row.tenant_id === params[0]));
      seedSearch();
      expectHalted(await raw('loadrelatedcontent', { query: { contenthistid: NODE_HIST, isNew: '0', ...query } }), 'loadrelatedcontent');
      expect(ran(FEED)).toEqual([]);
    });

    it('halts the search form of a subtype with a set of another entity type', async () => {
      seedContent([home(), version()]);
      seedSets([rcset('D0000000-0009-4A5B-8C7D9E0F1A2B3C4D', 'S2', 'People', 3, { entitytype: 'user' })]);
      expectHalted(await raw('loadrelatedcontent', { query: { contenthistid: NODE_HIST } }), 'loadrelatedcontent');
    });
  });
});

/** tenant-a's registry entry, with `overrides`. */
function registryEntry(overrides: Json = {}): Json {
  const umbrella = 'umbrella';
  return {
    site_id: SITE,
    tenant_id: TENANT_A.tenantId,
    public_user_pool_id: umbrella,
    private_user_pool_id: SITE,
    category_pool_id: umbrella,
    file_pool_id: umbrella,
    display_pool_id: umbrella,
    content_pool_ids: [SITE],
    public_user_pool_tenant: tenantIdForSite(umbrella),
    private_user_pool_tenant: TENANT_A.tenantId,
    category_pool_tenant: tenantIdForSite(umbrella),
    file_pool_tenant: tenantIdForSite(umbrella),
    display_pool_tenant: tenantIdForSite(umbrella),
    content_pool_tenants: [TENANT_A.tenantId],
    domains: [`${SITE}.opt2.test`],
    aggregate_version: '1',
    updated_at: UPDATED,
    ...overrides,
  };
}

describe('loadclass', () => {
  const ALPHA = 'F0000000-0001-4A5B-8C7D9E0F1A2B3C4D';
  const BETA = 'F0000000-0002-4A5B-8C7D9E0F1A2B3C4D';
  const ZED = 'F0000000-0003-4A5B-8C7D9E0F1A2B3C4D';

  /** The `subClassSelector` option values, in order. */
  const options = (body: string): string[] => [...body.matchAll(/<option value="([^"]+)" (?:selected)?>/g)].map((m) => m[1] ?? '');

  it.each([
    ['component', COMPONENTS, [{ contentid: ALPHA, menutitle: 'Footer Block', title: 'Footer Block', body: '', filename: '' }], 'Footer Block'],
    ['form', FORMS, [{ contentid: ALPHA, menutitle: 'Contact Us', responsechart: 0 }], 'Contact Us'],
  ] as const)('lists the site’s %s objects', async (classid, pattern, rows, name) => {
    db.respond(pattern, rows);
    const res = await raw('loadclass', { query: { classid } });
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/html;charset=UTF-8']);
    expect(res.body).toContain(ALPHA);
    expect(res.body).toContain(name);
    expect(ran(pattern).map((statement) => statement.tenantId)).toEqual([TENANT_A.tenantId]);
  });

  it.each([
    ['folder', 'Folder'],
    ['Calendar', 'Calendar'],
    ['gallery', 'Gallery'],
  ] as const)('lists the live %s sections by their case-sensitive crumb path', async (classid, type) => {
    seedContent([
      home(),
      version({ contentid: ALPHA, contenthistid: 'H1', menutitle: 'alpha', path: `${HOME},${ALPHA}` }),
      version({ contentid: BETA, contenthistid: 'H2', menutitle: 'Beta', path: `${HOME},${BETA}` }),
      version({ contentid: ZED, contenthistid: 'H3', menutitle: 'Zed', path: `${HOME},${BETA},${ZED}` }),
    ]);
    db.respond(SECTIONS, [
      { contentid: ALPHA, menutitle: 'alpha', type, siteid: SITE, path: `${HOME},${ALPHA}` },
      { contentid: ZED, menutitle: 'Zed', type, siteid: SITE, path: `${HOME},${BETA},${ZED}` },
      { contentid: BETA, menutitle: 'Beta', type, siteid: SITE, path: `${HOME},${BETA}` },
    ]);
    const res = await raw('loadclass', { query: { classid, subclassid: BETA } });
    expect(res.statusCode, String(thrown)).toBe(200);
    expect(options(res.body)).toEqual([BETA, ZED, ALPHA]);
    expect(res.body).toContain('Home  &gt; Beta  &gt; Zed');
    expect(ran(SECTIONS)[0]?.params).toContain(type);
  });

  it('fails as legacy does on a section without crumbs', async () => {
    db.respond(SECTIONS, [{ contentid: ALPHA, menutitle: 'Orphan', type: 'Folder', siteid: SITE, path: ALPHA }]);
    const res = await raw('loadclass', { query: { classid: 'folder' } });
    expect(res.statusCode).toBe(500);
    expect((thrown as Error).message).toBe('The element at position 1 cannot be found.');
  });

  it.each([
    ['localfeed', 'Local'],
    ['slideshow', 'Local'],
    ['remotefeed', 'Remote'],
  ] as const)('lists the site’s %s feeds of type %s', async (classid, type) => {
    db.respond(FEEDS, (params) => [{ feedid: ALPHA, name: 'Local News', type: 'Local' }, { feedid: BETA, name: 'Remote News', type: 'Remote' }].filter((row) => params.includes(row.type)));
    const res = await raw('loadclass', { query: { classid } });
    expect(res.statusCode, String(thrown)).toBe(200);
    expect(res.body).toContain(type === 'Local' ? ALPHA : BETA);
    expect(res.body).not.toContain(type === 'Local' ? BETA : ALPHA);
    expect(res.body).toContain(`${type} News`);
  });

  it('answers an unknown object class without reading data', async () => {
    const res = await raw('loadclass', { query: { classid: 'nothing' } });
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/html;charset=UTF-8']);
    expect(res.body.trim()).toBe(RECORDED.class_none?.body);
    expect(db.statements.some((statement) => /"content"\."content"|tcontentfeeds/.test(statement.sql))).toBe(false);
  });

  it.each(['mailinglist', 'system', 'navigation', 'plugins', 'plugin'])('halts the %s object class, whose rows another owner or the CFML runtime holds', async (classid) => {
    expectHalted(await raw('loadclass', { query: { classid } }), 'loadclass');
  });

  it('fails as legacy does without a classid', async () => {
    const res = await raw('loadclass');
    expect(res.statusCode).toBe(500);
    expect((thrown as Error).message).toBe('Element CLASSID is undefined in RC.');
  });

  it('halts the class configurator, whose registry and configurators are legacy CFML', async () => {
    expectHalted(await raw('loadclassconfigurator', { query: { classid: 'feed', container: 'layout' } }), 'loadclassconfigurator');
    expect(db.statements).toEqual([]);
  });
});

describe('loadextendedattributes', () => {
  /** An extend set row of `subtypeid` in `container`. */
  const set = (extendsetid: string, subtypeid: string, container: string, orderno: number, overrides: Json = {}): Json => ({
    tenant_id: TENANT_A.tenantId,
    extendsetid,
    subtypeid,
    categoryid: '',
    siteid: SITE,
    name: `Set ${extendsetid}`,
    orderno,
    isactive: 1,
    container,
    ...overrides,
  });

  /** A text attribute of `extendsetid`. */
  const attribute = (attributeid: number, extendsetid: string, name: string, orderno: number, overrides: Json = {}): Json => ({
    tenant_id: TENANT_A.tenantId,
    attributeid,
    extendsetid,
    siteid: SITE,
    name,
    label: name,
    hint: '',
    type: 'TextBox',
    orderno,
    isactive: 1,
    required: 'false',
    validation: '',
    regex: '',
    message: '',
    defaultvalue: '',
    optionlist: '',
    optionlabellist: '',
    adminonly: 0,
    ...overrides,
  });

  /** Page/News, active unless overridden, with Page/Default and three Base subtypes, each with sets in the Basic tab. */
  function seedSubtypes(own: Json = {}, attributes: Json[] = []): void {
    seedExtend({
      subtypes: [
        subtype('S1', 'Page', 'News', { hassummary: 0, hasassocfile: 0, hasconfigurator: 1, ...own }),
        subtype('S2', 'Page', 'Default'),
        subtype('S3', 'Base', 'News'),
        subtype('S4', 'Base', 'Default'),
        subtype('S5', 'Base', 'Other'),
      ],
      sets: [
        set('OWN-2', 'S1', 'Basic', 2),
        set('OWN-1', 'S1', 'Basic', 1),
        set('OWN-SEO', 'S1', 'SEO', 1),
        set('OWN-B', 'S1', 'Basic', 0, { siteid: TENANT_B.siteId }),
        set('PAGE-1', 'S2', 'Basic', 1),
        set('BASE-NEWS', 'S3', 'Basic', 2),
        set('BASE-DEFAULT', 'S4', 'Basic', 1),
        set('BASE-OTHER', 'S5', 'Basic', 1),
      ],
      attributes,
      values: [
        { tenant_id: TENANT_A.tenantId, dataid: 1, baseid: NODE_HIST, attributeid: 2, attributevalue: 'Stored teaser', siteid: SITE },
        { tenant_id: TENANT_A.tenantId, dataid: 2, baseid: NODE_HIST, attributeid: 99, attributevalue: 'orphan', siteid: SITE },
      ],
    });
  }

  /** The extend set ids a tab's markup prints, in order. */
  const setsIn = (markup: unknown): string[] => [...String(markup).matchAll(/<span class="extendset" extendsetid="([^"]+)"/g)].map((m) => m[1] ?? '');

  const query = { contentHistID: NODE_HIST, type: 'Page', subtype: 'News', tablist: 'tabBasic' };

  it('answers a subtype without extend sets as legacy records it, clearing the kept edit bean', async () => {
    seedContent([home(), version()]);
    seedExtend({});
    const recorded = RECORDED.extattr;
    const res = await raw('loadextendedattributes', { query: { contentHistID: NODE_HIST, type: 'Page', subtype: 'Default', tablist: 'tabBasic' } });
    expect([res.statusCode, res.headers['content-type']]).toEqual([recorded?.status, recorded?.contentType]);
    expect(res.json()).toEqual(JSON.parse(recorded?.body ?? 'null'));
    expect(effectsOf(res)).toEqual({ mura: { editBean: null } });
  });

  it('prints the inherited sets of each tab by level then order, with the version’s stored values', async () => {
    seedContent([home(), version()]);
    seedSubtypes({}, [attribute(2, 'OWN-1', 'teaser', 1), attribute(3, 'OWN-1', 'Alpha', 1), attribute(4, 'BASE-NEWS', 'title', 1)]);
    const res = await raw('loadextendedattributes', { query });
    expect(res.statusCode, String(thrown)).toBe(200);
    const json = res.json<Json>();
    expect(setsIn(json.basic)).toEqual(['BASE-DEFAULT', 'BASE-NEWS', 'PAGE-1', 'OWN-1', 'OWN-2']);
    expect(setsIn(json.seo)).toEqual(['OWN-SEO']);
    expect(String(json.basic).indexOf('name="Alpha"')).toBeLessThan(String(json.basic).indexOf('name="teaser"'));
    expect(json.basic).toContain('value="Stored teaser"');
    expect(json.basic).toContain('value="Node"');
    expect([json.hassummary, json.hasbody, json.hasassocfile, json.hasconfigurator]).toEqual([0, 1, 0, 1]);
    expect(json).toHaveProperty('tabbasictop', '');
    expect(flat(ran(EXTEND_DATA)[0]?.params ?? [])).toContain(NODE_HIST);
  });

  it('skips an inactive own subtype’s sets', async () => {
    seedContent([home(), version()]);
    seedSubtypes({ isactive: 0 });
    const json = (await raw('loadextendedattributes', { query })).json<Json>();
    expect(setsIn(json.basic)).toEqual(['BASE-DEFAULT', 'BASE-NEWS', 'PAGE-1']);
  });

  it('prints the values of the edit bean a rejected save kept for this version, without reading the version', async () => {
    seedContent([home(), version()]);
    seedSubtypes({}, [
      attribute(2, 'OWN-1', 'teaser', 1),
      attribute(3, 'OWN-1', 'count', 2),
      attribute(5, 'OWN-1', 'flag', 3),
      attribute(6, 'OWN-1', 'shape', 4),
      attribute(7, 'OWN-1', 'cleared', 5, { defaultvalue: 'Fallback' }),
    ]);
    identity.state = { mura: { EditBean: { ContentHistID: NODE_HIST.toLowerCase(), teaser: 'Kept <teaser>', TEASER: 'shadowed', count: 5, flag: true, shape: { x: 1 }, cleared: null } } };
    const res = await raw('loadextendedattributes', { query });
    const json = res.json<Json>();
    expect(json.basic).toContain('value="Kept &lt;teaser&gt;"');
    expect(json.basic).toContain('value="5"');
    expect(json.basic).toContain('value="true"');
    expect(json.basic).toContain('name="cleared" class="text" id="cleared" data-label="cleared" value=""');
    expect(json.basic).not.toContain('Fallback');
    expect(json.basic).not.toContain('shadowed');
    expect(ran(BY_HIST)).toEqual([]);
    expect(ran(EXTEND_DATA)).toEqual([]);
  });

  it('prints a new version’s bean values with the requested type and subtype, dates as CFML prints them, reading no extended data', async () => {
    seedContent([home()]);
    seedSubtypes({}, [attribute(2, 'OWN-1', 'subtype', 1), attribute(3, 'OWN-1', 'lastupdate', 2)]);
    const res = await raw('loadextendedattributes', { query });
    expect(res.statusCode, String(thrown)).toBe(200);
    // mura.json escapes apostrophes with JSStringFormat, so a date's text leaves the body as legacy's invalid JSON.
    expect(res.body).toContain('value=\\"News\\"');
    expect(res.body).toContain("value=\\\"{ts \\'2026-06-30 12:00:00\\'}\\\"");
    expect(ran(EXTEND_DATA)).toEqual([]);
  });

  it('halts an attribute only the CFML file selector renders', async () => {
    seedContent([home(), version()]);
    seedSubtypes({}, [attribute(2, 'OWN-1', 'download', 1, { type: 'File' })]);
    expectHalted(await raw('loadextendedattributes', { query }), 'loadextendedattributes');
  });

  it('fails as legacy does without a subtype', async () => {
    const res = await raw('loadextendedattributes', { query: { contentHistID: NODE_HIST, type: 'Page' } });
    expect(res.statusCode).toBe(500);
    expect((thrown as Error).message).toBe('Element SUBTYPE is undefined in RC.');
  });
});

describe('statusmodal', () => {
  const CS = 'C0000000-0004-4A5B-8C7D9E0F1A2B3C4D';
  const OTHER_USER = 'C1D2E3F4-0009-4A5B-8C7D9E0F1A2B3C4D';
  const CREATED = new Date(2026, 9, 29, 14, 5);

  /** A pending version under a node assigned to the approval chain, with its stored request and one action. */
  function seedApproval(request: Json = {}, actions: Json[] = [{ actiontype: 'Approval', comments: 'Looks good', userid: USER, created: CREATED }], content: Json = {}): void {
    seedContent([home(), version({ active: 0, approved: 0, approvalstatus: 'Pending', ...content })]);
    db.respond(CRUMBS, (params, sql) => (flat(params).includes(NODE) ? [{ ...version(), chainid: CHAIN, exemptid: null, fileext: null }] : matching([home()], 'tcontent.contentid')(params, sql)));
    db.respond(CHAINS, matching([{ tenant_id: TENANT_A.tenantId, chainid: CHAIN, siteid: SITE, name: 'Chain' }], 'chainid'));
    const stored = { tenant_id: TENANT_A.tenantId, requestid: REQUEST, contenthistid: NODE_HIST, chainid: CHAIN, siteid: SITE, groupid: GROUP, userid: USER, status: 'Pending', created: CREATED, ...request };
    db.respond(REQUESTS, matching([stored], 'contenthistid', 'chainid', 'siteid'));
    db.respond(ACTIONS, matching(actions.map((action, i) => ({ tenant_id: TENANT_A.tenantId, actiontid: `A${i}`, requestid: REQUEST, siteid: SITE, groupid: GROUP, chainid: CHAIN, ...action })), 'requestid'));
  }

  /** Answers the group projection of each pool tenant with `rows`. */
  const seedGroups = (rows: (tenantId: string | null | undefined) => Json[]): void =>
    db.respond(GROUPS, (params) => rows(db.statements.at(-1)?.tenantId).filter((row) => flat(params).map((id) => String(id).toLowerCase()).includes(String(row.group_id).toLowerCase())));

  it('answers the published home version as legacy records it', async () => {
    seedContent([home({ lastupdate: new Date(2026, 10, 10, 9, 6, 12), lastupdatebyid: '' })]);
    const recorded = RECORDED.status;
    const res = await raw('statusmodal', { query: { contenthistid: HOME_HIST, compactDisplay: 'true' } });
    expect({ status: res.statusCode, contentType: res.headers['content-type'], body: res.body }).toEqual({ status: recorded?.status, contentType: recorded?.contentType, body: recorded?.body });
    expect(ran(STATS).map((statement) => statement.tenantId)).toEqual([TENANT_A.tenantId]);
  });

  it('names the session user as the version’s author and prints its change set', async () => {
    seedContent([home(), version({ changesetid: CS, approved: 0 })]);
    db.respond(CHANGESET, matching([{ tenant_id: TENANT_A.tenantId, changesetid: CS, siteid: SITE, name: 'Spring <Launch>', published: 0 }], 'changesetid'));
    const res = await raw('statusmodal', { query: { contenthistid: NODE_HIST } });
    expect(res.statusCode, String(thrown)).toBe(200);
    expect(res.body).toContain('<p>Admin User </p>');
    expect(res.body).toContain('<p>Spring &lt;Launch&gt;</p>');
  });

  it('halts a version another user wrote, whose name is people data', async () => {
    seedContent([home(), version({ lastupdatebyid: OTHER_USER })]);
    expectHalted(await raw('statusmodal', { query: { contenthistid: NODE_HIST } }), 'statusmodal');
  });

  it('halts the front-end mode before reading anything', async () => {
    expectHalted(await raw('statusmodal', { query: { contenthistid: NODE_HIST, mode: 'FrontEnd' } }), 'statusmodal');
    expect(db.statements).toEqual([]);
  });

  it('shows the pending request of the chain the node is assigned to, with its group, actions and action form', async () => {
    seedApproval();
    seedGroups((tenantId) => (tenantId === TENANT_A.tenantId ? [{ group_id: GROUP, group_name: 'Approvers & Co', deleted: 0 }] : [{ group_id: GROUP, group_name: 'Gone', deleted: 1 }]));
    const res = await raw('statusmodal', { query: { contenthistid: NODE_HIST } });
    expect(res.statusCode, String(thrown)).toBe(200);
    expect(res.body).toContain('<p>Approvers &amp; Co</p>');
    expect(res.body).toContain('<p>Looks good</p>');
    expect(res.body).toMatch(/By Admin User On/i);
    expect(res.body).toContain(`applyApprovalAction('${REQUEST}'`);
    expect(flat(ran(REQUESTS)[0]?.params ?? [])).toEqual(expect.arrayContaining([NODE_HIST, CHAIN, SITE]));
    expect(ran(GROUPS).map((statement) => statement.tenantId)).toEqual([tenantIdForSite('umbrella'), TENANT_A.tenantId]);
  });

  it.each([
    ['a deleted group as the empty user bean', [{ group_id: GROUP, group_name: 'Gone', deleted: 1 }], GROUP, ''],
    ['a requesting user that is the session user', [], USER, 'Admin User'],
    ['no group as the empty user bean', [], '', ''],
  ] as const)('waits for %s', async (_label, groups, groupid, name) => {
    seedApproval({ groupid });
    seedGroups(() => [...groups]);
    const res = await raw('statusmodal', { query: { contenthistid: NODE_HIST } });
    expect(res.statusCode, String(thrown)).toBe(200);
    expect(res.body).toMatch(new RegExp(`<em>[^<]*:</em>\\s*<p>${name}</p>`));
    expect(res.body).not.toContain('Gone');
  });

  it('names the request’s user for a version without an author', async () => {
    seedApproval({}, [], { lastupdatebyid: '' });
    seedGroups(() => [{ group_id: GROUP, group_name: 'Approvers', deleted: 0 }]);
    const res = await raw('statusmodal', { query: { contenthistid: NODE_HIST } });
    expect(res.statusCode, String(thrown)).toBe(200);
    expect(res.body).toContain('<p>Admin User </p>');
  });

  it.each([
    ['an action by another user', {}, [{ actiontype: 'Approval', comments: '', userid: OTHER_USER, created: CREATED }]],
    ['a group that is no projected group nor the session user', { groupid: OTHER_USER }, []],
  ] as const)('halts %s, whose name is people data', async (_label, request, actions) => {
    seedApproval(request, [...actions]);
    seedGroups(() => []);
    expectHalted(await raw('statusmodal', { query: { contenthistid: NODE_HIST } }), 'statusmodal');
  });
});

describe('update', () => {
  const OLD_HIST = 'A1B2C3D4-0005-4A5B-8C7D9E0F1A2B3C4D';
  const CS = 'C0000000-0005-4A5B-8C7D9E0F1A2B3C4D';
  const WRITE = /^(INSERT|UPDATE|DELETE)\b/;
  const CONTENT_LOCK = /^SELECT \* FROM "content"\."content" WHERE tenant_id = \$1 AND \(siteid = \$2 AND (contentid|contenthistid) = ANY\(\$3::bpchar\[\]\)(.*) FOR UPDATE$/;
  const CONTENT_DELETE = /^DELETE FROM "content"\."content" /;

  /** The edit form's add of the node's active version. */
  const add = (form: Record<string, string> = {}): Record<string, string> => ({
    contentid: NODE,
    contenthistid: NODE_HIST,
    parentid: HOME,
    type: 'Page',
    title: 'Node',
    menutitle: 'Node',
    action: 'add',
    approved: '1',
    ...TOKEN,
    ...form,
  });

  /** The tree the update branches read: home and the node's active and archived versions, whose locks answer the versions they name. */
  const seedTree = (node: Json = {}): Json[] => {
    const rows = seedContent([home(), version(node), version({ contenthistid: OLD_HIST, active: 0, lastupdate: new Date(2026, 4, 1) })]);
    db.respond(CONTENT_LOCK, (params, sql) =>
      matching(rows, 'contentid', 'contenthistid')(params, sql)
        .filter((row) => !/ AND active = 0 /.test(sql) || row.active === 0)
        .map((row) => ({ tcontent_id: rows.indexOf(row) + 1, ...row })),
    );
    return rows;
  };

  /** The writes the request ran, without the changelog bookkeeping. */
  const writes = () => db.statements.filter((statement) => WRITE.test(statement.sql) && !/"changelog"/.test(statement.sql));

  const contexts = (): string[] => consumed.map(({ context }) => context);

  describe('CSRF', () => {
    it.each([
      ['deletehistall', { contentid: NODE, action: 'deletehistall', murakeepediting: 'true' }, `${NODE}deletehistall`, OLD_HIST],
      ['delete', { contentid: NODE, contenthistid: NODE_HIST, action: 'delete', murakeepediting: 'true' }, `${NODE_HIST}delete`, NODE_HIST],
    ] as const)('consumes the %s context once and deletes only with a valid token, redirecting to the history either way', async (_branch, form, context, deleted) => {
      const rows = seedTree();
      identity.csrfValid = () => false;
      const refused = await raw('update', { form: { ...form, ...TOKEN } });
      expect([refused.statusCode, contexts()]).toEqual([302, [context]]);
      expect(writes()).toEqual([]);
      consumed.length = 0;
      identity.csrfValid = () => true;
      const res = await raw('update', { form: { ...form, ...TOKEN } });
      expect(res.statusCode, String(thrown)).toBe(302);
      expect(res.headers.location).toBe(`/admin/index.cfm?muraAction=cArch.hist&contentid=${NODE}&siteid=${SITE}&startrow=1&moduleid=${SITE_TREE}&parentid=&type=Page&compactDisplay=`);
      expect(contexts()).toEqual([context]);
      expect(ran(CONTENT_DELETE).map(({ params }) => flat(params))).toEqual([[TENANT_A.tenantId, rows.findIndex((row) => row.contenthistid === deleted) + 1]]);
    });

    it('consumes the deleteall context and deletes the node, then fails on the missing bean as legacy does', async () => {
      seedTree();
      const res = await raw('update', { form: { contentid: NODE, action: 'deleteall', ...TOKEN } });
      expect(res.statusCode).toBe(500);
      expect((thrown as Error).message).toBe('Element RC.contentBean is undefined in ARGUMENTS.');
      expect(contexts()).toEqual([`${NODE}deleteall`]);
      expect(writes().length).toBeGreaterThan(0);
    });

    it('answers the bare abort of a home-page deleteall after consuming its token', async () => {
      seedTree();
      const res = await raw('update', { form: { contentid: HOME, action: 'deleteall', ...TOKEN } });
      expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, 'text/html;charset=UTF-8', '']);
      expect(contexts()).toEqual([`${HOME}deleteall`]);
      expect(writes()).toEqual([]);
    });

    it('consumes the multifileupload context of the parent and keeps the sticky session flag', async () => {
      seedTree();
      const res = await raw('update', { form: { parentid: HOME, action: 'multifileupload', subtype: 'Default', approved: '1', ...TOKEN } });
      expect([res.statusCode, res.body]).toEqual([200, '']);
      expect(contexts()).toEqual([`${HOME}multifileupload`]);
      expect(effectsOf(res)).toEqual({ mura: { multifileupload: true } });
    });

    it('rejects a bad add token with the token error and writes nothing', async () => {
      seedTree();
      identity.csrfValid = () => false;
      const res = await raw('update', { form: add({ ajaxrequest: 'true' }) });
      expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/html;charset=UTF-8']);
      expect(res.body).toBe(
        `{success:false,\n\t\terrors:{"csrf":"Your request contained invalid tokens"},\n\t\tcsrf_token: 'ISSUED-${NODE_HIST}add',\n\t\tcsrf_token_expires: '260630235959000'\n}`,
      );
      expect(contexts()).toEqual([`${NODE_HIST}add`]);
      expect(writes()).toEqual([]);
    });

    it('halts the re-rendered edit form of a refused non-ajax add, before any write', async () => {
      seedTree();
      identity.csrfValid = () => false;
      expectHalted(await raw('update', { form: add() }), 'update');
      expect(contexts()).toEqual([`${NODE_HIST}add`]);
      expect(writes()).toEqual([]);
    });

    it('consumes no token for an actor without node permission', async () => {
      seedTree();
      const res = await raw('update', { form: add(), roles: EDITOR_ROLES });
      expect(res.statusCode).toBe(500);
      expect((thrown as Error).message).toBe('Element RC.contentBean is undefined in ARGUMENTS.');
      expect([contexts(), writes()]).toEqual([[], []]);
    });

    it('consumes no token where neither the node nor a parent sets the permission and the request carries none', async () => {
      seedTree();
      const res = await raw('update', { form: add({ contentid: OTHER, contenthistid: '', parentid: '' }) });
      expect(res.statusCode).toBe(500);
      expect((thrown as Error).message).toBe('Element RC.perm is undefined in ARGUMENTS.');
      expect([contexts(), writes()]).toEqual([[], []]);
    });
  });

  describe('outcomes', () => {
    const LIVE = `{success:true,location:\n\t'\\x2Fnode\\x2F'\n} `;

    /** ESAPI's JavaScript encoding of `text`: everything but alphanumerics and `,._` as `\xHH`. */
    const js = (text: string): string => text.replace(/[^A-Za-z0-9,._]/g, (c) => `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

    /** The version the add saved: the last inserted row. */
    const savedOf = (rows: readonly Json[]): Json => rows[rows.length - 1] ?? {};

    /** The parts of a multi-file upload of `file` into the home page. */
    const upload = (file: { filename: string; type: string }, extraParams: string): Part[] => [
      { name: 'siteid', value: SITE },
      { name: 'parentid', value: HOME },
      { name: 'action', value: 'multifileupload' },
      { name: 'subtype', value: 'Default' },
      { name: 'approved', value: '1' },
      { name: 'extraParams', value: extraParams },
      { name: 'csrf_token', value: TOKEN.csrf_token },
      { name: 'csrf_token_expires', value: TOKEN.csrf_token_expires },
      { name: 'files', ...file, data: Buffer.from('hello') },
    ];

    it.each([
      ['the site tree list after a published add', {}, `./?muraAction=cArch.list&topid=${HOME}&siteid=${SITE}&startrow=1&moduleid=${SITE_TREE}`],
      ['the history for return=hist', { return: 'hist' }, `/admin/index.cfm?muraAction=cArch.hist&contentid=${NODE}&siteid=${SITE}&startrow=1&moduleid=${SITE_TREE}&parentid=${HOME}&type=Page&compactDisplay=`],
      ['the change set assignments for return=changesets', { return: 'changesets', changesetid: CS }, `./?muraAction=cChangesets.assignments&changesetID=${CS}&siteid=${SITE}`],
      ['the front-end page for frontend=1', { frontend: '1' }, 'http://tenant-a.opt2.test/node/'],
      ['a return URL on a registered domain unchanged', { returnurl: 'https://tenant-a.opt2.test/back/' }, 'https://tenant-a.opt2.test/back/'],
      ['a foreign return URL on the site domain', { returnurl: 'https://evil.example/x' }, 'https://tenant-a.opt2.test/x'],
      ['a protocol-relative return URL as a local path', { returnurl: '//evil.example/x' }, '/evil.example/x'],
    ])('redirects a saved add to %s', async (_target, form, location) => {
      seedTree();
      const res = await raw('update', { form: add(form) });
      expect([res.statusCode, res.headers['content-type'], res.headers.location, res.body]).toEqual([302, 'text/html;charset=UTF-8', location, '']);
      expect(contexts()).toEqual([`${NODE_HIST}add`]);
      expect(ran(CONTENT_INSERT)).toHaveLength(1);
    });

    it.each([
      ['preview=1', { preview: '1' }, '1'],
      ['murakeepediting', { murakeepediting: 'true' }, '0'],
    ])('returns to cArch.edit on the saved version with %s', async (_why, form, preview) => {
      const rows = seedTree();
      const res = await raw('update', { form: add(form) });
      const hist = String(savedOf(rows).contenthistid);
      expect(hist).not.toBe(NODE_HIST);
      expect([res.statusCode, res.headers.location]).toEqual([
        302,
        `./?muraAction=cArch.edit&contenthistid=${hist}&contentid=${NODE}&type=Page&parentid=${HOME}&topid=${HOME}&siteid=${SITE}&moduleid=${SITE_TREE}&preview=${preview}&startrow=1&return=&compactDisplay=`,
      ]);
      expect(effectsOf(res)).toEqual({ openSectionList: HOME, mura: { editBean: null } });
    });

    it('normalises a non-numeric orderno to 0 and URL-decodes non-JSON object params before the save', async () => {
      const rows = seedTree();
      await raw('update', { form: add({ orderno: 'abc', objectparams: '%7B%22a%22%3A1%7D' }) });
      expect(savedOf(rows)).toMatchObject({ orderno: 0, objectparams: '{"a":1}' });
    });

    it.each([
      ['appends the parent to an open section list that lacks it', { openSectionList: OTHER }, { openSectionList: `${OTHER},${HOME}`, mura: { editBean: null } }],
      ['leaves the list alone when the parent is open under the module top', { openSectionList: HOME, moduleTopIds: { [SITE_TREE]: HOME, [`m${SITE_TREE}`]: OTHER } }, { mura: { editBean: null } }],
      ['ignores the m-prefixed top ids before() keeps', { openSectionList: HOME, moduleTopIds: { [`m${SITE_TREE}`]: HOME } }, { openSectionList: `${HOME},${HOME}`, mura: { editBean: null } }],
    ])('%s', async (_case, state, effects) => {
      seedTree();
      identity.state = state;
      const res = await raw('update', { form: add() });
      expect(res.statusCode).toBe(302);
      expect(effectsOf(res)).toEqual(effects);
    });

    it('answers a compact-display save with the close data of the saved, current and home beans', async () => {
      const rows = seedTree();
      const res = await raw('update', { form: add({ closecompactdisplay: 'true', homeID: HOME }) });
      const hist = String(savedOf(rows).contenthistid);
      expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'application/json; charset=utf-8']);
      expect(JSON.parse(res.body)).toEqual({
        saved: true,
        errors: {},
        redirect: null,
        data: {
          contentBean: { type: 'Page', contentID: NODE, remoteURL: '', active: 1 },
          useLayoutManager: false,
          homeURL: '/',
          currentBean: { active: 1, isOnDisplay: true, type: 'Page', contentID: NODE, contentHistID: hist, url: '/node/', previewURL: `/node/?previewid=${hist}`, editedPreviewURL: `/node/?previewID=${hist}` },
        },
      });
      expect(effectsOf(res)).toEqual({ openSectionList: HOME, mura: { editBean: null } });
    });

    it.each([
      ['without a parent version', {}, {}],
      ['with the parent version it previews', { parenthistid: HOME_HIST }, { parentHistPreviewURL: `/?previewid=${HOME_HIST}`, parentHistExists: true }],
      ['with a parent version that does not exist', { parenthistid: OTHER_HIST }, { parentHistPreviewURL: `/?previewid=${OTHER_HIST}`, parentHistExists: false }],
    ])('adds the parent bean to the close data of a saved link %s', async (_case, form, extra) => {
      seedTree();
      const res = await raw('update', { form: add({ closecompactdisplay: 'true', type: 'Link', body: 'https://x.example/', ...form }) });
      const data = (JSON.parse(res.body) as { data: Json }).data;
      expect(data.contentBean).toEqual({ type: 'Link', contentID: NODE, remoteURL: '', active: 1 });
      expect(data.parentBean).toEqual({ active: 1, isOnDisplay: true, type: 'Page', contentID: HOME, contentHistID: HOME_HIST, url: '/', previewURL: `/?previewid=${HOME_HIST}`, ...extra });
      expect(data).not.toHaveProperty('homeURL');
    });

    it.each([
      ['shown', { display: '1' }, true],
      ['hidden', { display: '0' }, false],
      ['scheduled from a past start with no stop', { display: '2', displaystart: '2026-06-01 10:00:00' }, true],
      ['scheduled from a future start', { display: '2', displaystart: '2026-12-01 10:00:00' }, false],
      ['scheduled with its stop still ahead', { display: '2', displaystart: '2026-06-01 10:00:00', displaystop: '2026-07-01 10:00:00' }, true],
      ['scheduled with a past stop', { display: '2', displaystart: '2026-06-01 10:00:00', displaystop: '2026-06-15 10:00:00' }, false],
    ])('answers an ajax save of a %s version with its live or preview location', async (_case, form, live) => {
      const rows = seedTree();
      const res = await raw('update', { form: add({ ajaxrequest: 'true', ...form }) });
      const hist = String(savedOf(rows).contenthistid);
      expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'text/html;charset=UTF-8']);
      expect(res.body).toBe(live ? LIVE : `{success:true,location:\n\t'${js(`/node/?previewid=${hist}`)}'\n} `);
      expect(effectsOf(res)).toBeUndefined();
    });

    it.each(['qqfile', 'QQFile'])('answers the uploader with {success:true} where the query names %s', async (key) => {
      seedTree();
      identity.csrfValid = () => false;
      const res = await raw('update', { query: { [key]: 'notes.txt' }, form: { parentid: HOME, action: 'multiFileUpload', murakeepediting: 'true', ...TOKEN } });
      expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, RECORDED.up_qqfile?.contentType, RECORDED.up_qqfile?.body]);
      expect(effectsOf(res)).toEqual({ mura: { multifileupload: false } });
    });

    it.each([
      ['a sticky session flag', { mura: { multifileupload: 'true' } }, 200, '', true],
      ['a non-boolean session flag', { mura: { multifileupload: 'maybe' } }, 200, RECORDED.up_multi?.body, false],
      ['no session flag', {}, 200, RECORDED.up_multi?.body, false],
    ])('lets a refused multifileupload token through only on %s', async (_case, state, status, body, allowed) => {
      seedTree();
      identity.state = state;
      identity.csrfValid = () => false;
      const res = await raw('update', { form: { parentid: HOME, action: 'multiFileUpload', subtype: 'Default', approved: '1', murakeepediting: 'true', ...TOKEN } });
      expect([res.statusCode, res.body]).toEqual([status, body]);
      expect(effectsOf(res)).toEqual({ mura: { multifileupload: allowed } });
      expect(contexts()).toEqual([`${HOME}multifileupload`]);
    });

    it.each([
      ['text/plain without a JSON Accept', {}, 'text/plain; charset=utf-8'],
      ['JSON for a JSON Accept', { accept: 'application/json, text/javascript, */*; q=0.01' }, 'application/json; charset=utf-8'],
    ])('carries a non-image upload into a file under the parent, typed %s', async (_case, headers, type) => {
      seedTree();
      const res = await raw('update', { headers, parts: upload({ filename: 'notes.txt', type: 'text/plain' }, JSON.stringify({ body: 'notes.txt' })) });
      expect([res.statusCode, res.headers['content-type']]).toEqual([200, type]);
      const { files } = JSON.parse(res.body) as { files: Json[] };
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ filename: 'notes.txt', title: 'notes.txt', size: 5, body: 'notes.txt', delete_type: 'DELETE' });
      expect(String(files[0]?.edit_url)).toMatch(new RegExp(`^/admin/\\?muraAction=cArch\\.edit&contenthistid=[0-9A-F-]{35}&contentid=[0-9A-F-]{35}&type=File&siteid=${SITE}&topid=${HOME}&parentid=${HOME}&moduleid=${SITE_TREE}&compactdisplay=false$`));
      expect(ran(CONTENT_INSERT).map(({ params }) => params.includes('File'))).toEqual([true]);
      expect(effectsOf(res)).toEqual({ mura: { multifileupload: true } });
    });

    it('answers the partial {"files":[ body where the extra params are not JSON', async () => {
      seedTree();
      const res = await raw('update', { headers: { accept: 'application/json' }, parts: upload({ filename: 'notes.txt', type: 'text/plain' }, '{oops') });
      expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, 'application/json; charset=utf-8', '{"files":[']);
    });

    it('refuses an image upload, whose renditions legacy writes, before any content write', async () => {
      seedTree();
      const res = await raw('update', { parts: upload({ filename: 'photo.png', type: 'image/png' }, JSON.stringify({ body: 'photo.png' })) });
      expect(res.statusCode).toBe(500);
      expect((thrown as Error).name).toBe('ImageUploadHaltedError');
      expect(ran(CONTENT_INSERT)).toEqual([]);
    });
  });
});
