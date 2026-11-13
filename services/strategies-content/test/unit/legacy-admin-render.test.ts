// Content admin renderers against Masa 7.6.1 on ACF 2023.0.26 (GS-CO-08 Site Manager tree, GS-CO-04 version diff,
// GS-CO-01/02 notify and lock check): each fixture in test/fixtures/legacy-admin-render holds the model read from a seeded
// legacy instance in the session that then requested the action, and the body it served, CSRF values replaced by `<token>`.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_JSON_CONTENT_TYPE,
  ADMIN_VIEW_CONTENT_TYPE,
  CONTENT_COMPARABLE_EXCLUDED,
  acfStructKeyOrder,
  createAdminLabels,
  renderLoadDiff,
  renderLoadExpireNotify,
  renderLoadNotify,
  renderLoadSiteFlat,
  renderLoadSiteSection,
  renderLockCheck,
  renderNest,
  renderNextN,
  renderRefreshSiteSection,
  renderSiteManagerJson,
  renderSiteManagerTab,
  type AdminRenderContext,
  type AdminRenderResult,
  type AdminSession,
  type DiffVersion,
  type NestNode,
  type SiteManagerModel,
  type SiteManagerRow,
  type SiteSectionModel,
} from '../../src/legacy/admin-render.js';
import { buildCustomIconLookup, type NodePerm, type ZoomCrumb } from '../../src/legacy/admin-markup.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';

type Action =
  | 'loadsitemanager'
  | 'loadsitesection'
  | 'refreshsitesection'
  | 'sitemanagertab'
  | 'loaddiff'
  | 'loadnotify'
  | 'loadexpirenotify'
  | 'lockcheck';
type Text = Record<string, string>;
type RecordedNest = Text & { verdict: NodePerm; kidscount: string; kids?: RecordedNest[] };
type RecordedSession = {
  userid: string;
  siteid: string;
  memberships: string;
  nextN: string;
  dateKeyFormat: string;
  rb: string;
  openSectionList: string;
  flatViewArgs: Record<string, Record<string, unknown>>;
};
type Recorded = {
  user: 'admin' | 'qa_editor';
  request: Text;
  session: RecordedSession;
  site?: { locking: string; hasComments: string; hasLockableNodes: number; privateUserPoolId: string };
  config?: { sortPermission: string; adminDir: string; context: string; coreVersion: string };
  marketing?: boolean;
  tabAssignments?: string;
  rsExtend?: Array<{ type: string; subtype: string; attribute: string }>;
  icons?: Array<{ siteid: string; type: string; subtype: string; iconclass: string }>;
  model?: Record<string, unknown>;
  versions?: Array<{ lastUpdate: string; values: Array<[string, string, boolean, string]> }>;
  status: number;
  contentType: string;
  location?: string | null;
  sessionAfter?: { openSectionList: string; flatViewArgs: Record<string, Record<string, unknown>> };
};

const FIXTURES = new URL('../fixtures/legacy-admin-render/', import.meta.url);
const readText = (path: string): string => readFileSync(new URL(path, FIXTURES), 'utf8');
const recorded = (action: Action, id: string): Recorded => JSON.parse(readText(`${action}/${id}.json`)) as Recorded;
const fixtureIds = (action: Action): string[] =>
  readdirSync(new URL(`${action}/`, FIXTURES))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();

function readBundle(path: string): Record<string, string> {
  const bundle: Record<string, string> = {};
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const at = line.indexOf('=');
    if (at > 0) bundle[line.slice(0, at).trim()] = line.slice(at + 1).replace(/^[ \t\f]+/, '');
  }
  return bundle;
}

const labels = createAdminLabels(readBundle('../../../../core/mura/resourceBundle/resources/en.properties'));
const site = JSON.parse(readText('site.json')) as LegacySiteUrlConfig;
const TOKEN = '<token>';

function context(rec: Recorded): AdminRenderContext {
  const s = rec.session;
  const session: AdminSession = {
    userId: s.userid,
    siteId: s.siteid,
    memberships: s.memberships,
    nextN: Number(s.nextN),
    dateKeyFormat: s.dateKeyFormat,
    rb: s.rb,
    // The recordings ran on the en_US default site.
    locale: 'en_US',
    openSectionList: s.openSectionList,
    flatViewArgs: s.flatViewArgs,
    copyContentId: '',
    copySiteId: '',
    copyAll: false,
  };
  return {
    labels,
    site,
    session,
    siteSettings: {
      locking: rec.site?.locking ?? 'none',
      hasComments: rec.site?.hasComments === '1',
      hasLockableNodes: rec.site?.hasLockableNodes === 1,
      privateUserPoolId: rec.site?.privateUserPoolId ?? 'default',
      extranet: false,
    },
    config: {
      sortPermission: rec.config?.sortPermission ?? 'editor',
      adminDir: rec.config?.adminDir ?? '/admin',
      context: rec.config?.context ?? '',
    },
    csrf: () => ({ token: TOKEN, expires: TOKEN }),
  };
}

/** A recorded `yyyy-mm-ddTHH:nn:ss.lll` server-local timestamp; '' is NULL. */
function localDate(text: string | undefined): Date | null {
  if (text === undefined || text === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(text);
  if (m === null) throw new Error(`Unexpected timestamp ${text}`);
  const [, y, mo, d, h, mi, s, ms] = m.map(Number) as [number, number, number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s, ms);
}

const int = (text: string | undefined): number | null => (text === undefined || text === '' ? null : Number(text));

function managerRow(r: Text): SiteManagerRow {
  return {
    siteid: r['siteid'] ?? '',
    contentid: r['contentid'] ?? '',
    contenthistid: r['contenthistid'] ?? '',
    parentid: r['parentid'] ?? '',
    moduleid: r['moduleid'] ?? '',
    type: r['type'] ?? '',
    subtype: r['subtype'] ?? '',
    title: r['title'] ?? '',
    menutitle: r['menutitle'] ?? '',
    filename: r['filename'] ?? '',
    fileid: r['fileid'] ?? '',
    fileext: r['fileext'] ?? '',
    assocfilename: r['assocfilename'] ?? '',
    display: int(r['display']),
    displaystart: localDate(r['displaystart']),
    displaystop: localDate(r['displaystop']),
    approved: int(r['approved']),
    isnav: int(r['isnav']),
    inheritobjects: r['inheritobjects'] ?? '',
    template: r['template'] ?? '',
    childtemplate: r['childtemplate'] ?? '',
    lastupdate: localDate(r['lastupdate']),
    targetparams: r['targetparams'] ?? '',
    remoteurl: r['remoteurl'] ?? '',
    sortby: r['sortby'] ?? '',
    sortdirection: r['sortdirection'] ?? '',
    lockid: r['lockid'] ?? '',
  };
}

function nestNode(r: RecordedNest): NestNode {
  return {
    ...managerRow(r),
    restricted: int(r['restricted']),
    islocked: int(r['islocked']),
    verdict: r.verdict,
    kidsCount: Number(r.kidscount),
    ...(r.kids === undefined ? {} : { kids: r.kids.map(nestNode) }),
  };
}

function crumb(c: Text): ZoomCrumb {
  return {
    siteid: c['siteid'] ?? '',
    contentid: c['contentid'] ?? '',
    type: c['type'] ?? '',
    subtype: c['subtype'] ?? '',
    menutitle: c['menutitle'] ?? '',
    restricted: int(c['restricted']),
    moduleid: c['moduleid'] ?? '',
  };
}

const truthyFlag = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1' || v === 'YES';

function managerModel(rec: Recorded): SiteManagerModel {
  const m = rec.model as { rsTop: Text; crumbs: Text[]; perm: NodePerm; restricted: unknown; hasKids: string; nest: RecordedNest[] };
  return {
    siteId: 'default',
    topId: rec.request['topid'] ?? '',
    moduleId: rec.request['moduleid'] ?? '',
    type: rec.request['type'] ?? 'Page',
    ptype: rec.request['ptype'] ?? '',
    sortBy: rec.request['sortby'] ?? '',
    sortDirection: rec.request['sortdirection'] ?? '',
    startRow: rec.request['startrow'] ?? '1',
    rsTop: managerRow(m.rsTop),
    crumbs: m.crumbs.map(crumb),
    perm: m.perm,
    restricted: truthyFlag(m.restricted),
    hasKids: Number(m.hasKids),
    tabAssignments: rec.tabAssignments ?? '',
    extendAttributes: rec.rsExtend ?? [],
    hasMarketingManager: rec.marketing === true,
    nest: m.nest.map(nestNode),
    customIcons: buildCustomIconLookup(rec.icons ?? []),
  };
}

function sectionModel(rec: Recorded): SiteSectionModel {
  const m = rec.model as { perm: NodePerm; restricted: unknown; nest: RecordedNest[] };
  return {
    siteId: 'default',
    sectionId: rec.request['contentid'] ?? '',
    moduleId: rec.request['moduleid'] ?? '',
    sortBy: rec.request['sortby'] ?? '',
    sortDirection: rec.request['sortdirection'] ?? '',
    startRow: rec.request['startrow'] ?? '1',
    perm: m.perm,
    restricted: truthyFlag(m.restricted),
    tabAssignments: rec.tabAssignments ?? '',
    nest: m.nest.map(nestNode),
    customIcons: buildCustomIconLookup(rec.icons ?? []),
  };
}

/** A `getValue` result as the dump recorded it: its text, whether it is a date, and its Java class. */
function beanValue([, text, isDate, type]: [string, string, boolean, string]): unknown {
  if (isDate) return localDate(text);
  if (type === 'complex') return { complex: true };
  if (type === 'java.lang.Integer' || type === 'java.lang.Double') return Number(text);
  if (type === 'coldfusion.runtime.CFBoolean' || type === 'java.lang.Boolean') return truthyFlag(text);
  return text;
}

function versions(rec: Recorded): DiffVersion[] {
  return (rec.versions ?? []).map((v) => ({
    lastUpdate: localDate(v.lastUpdate) as Date,
    values: v.values.map((entry) => [entry[0], beanValue(entry)] as const),
  }));
}

/** CSRF values become the token placeholder and CF UUIDs `<id:n>` in order of first appearance, as the golden normaliser does. */
function normalise(body: string): string {
  const ids = new Map<string, string>();
  return body
    .replace(/(csrf_token(?:_expires)?=)[^&"'\\]*/g, `$1${TOKEN}`)
    .replace(/(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}(?![0-9A-Fa-f-])/g, (id) => {
      const key = id.toUpperCase();
      if (!ids.has(key)) ids.set(key, `<id:${ids.size + 1}>`);
      return ids.get(key) as string;
    });
}

/** The members of a mura.json body, which escapes `'` as `\'` (not JSON). */
function muraJsonMembers(body: string): Record<string, unknown> {
  return JSON.parse(body.replace(/\\'/g, "'")) as Record<string, unknown>;
}

/** Markup structure without whitespace: tags with sorted attributes, closing tags and collapsed text, scripts dropped. */
function markupModel(html: string): string[] {
  const nodes: string[] = [];
  const body = normalise(html).replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const tokens = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  for (const [token, name, attrs, text] of body.matchAll(tokens)) {
    if (text !== undefined) {
      const collapsed = text.replace(/\s+/g, ' ').trim();
      if (collapsed !== '') nodes.push(`#${collapsed}`);
      continue;
    }
    if (token.startsWith('</')) {
      nodes.push(`/${(name as string).toLowerCase()}`);
      continue;
    }
    const pairs = [...(attrs ?? '').matchAll(/([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
      .map(([, attr, dq, sq, bare]) => `${(attr as string).toLowerCase()}=${(dq ?? sq ?? bare ?? '').replace(/\s+/g, ' ')}`)
      .sort();
    nodes.push(`<${(name as string).toLowerCase()} ${pairs.join(' ')}`);
  }
  return nodes;
}

/** A CF struct as legacy dumps it: keys compared without case, values by their string form. */
function cfStruct(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([k, v]) => [k.toLowerCase(), v !== null && typeof v === 'object' ? cfStruct(v as Record<string, unknown>) : String(v)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function expectLegacyResponse(result: AdminRenderResult, rec: Recorded, legacy: string): void {
  expect(result.status).toBe(rec.status);
  expect(result.contentType).toBe(rec.contentType);
  expect(normalise(result.body)).toBe(normalise(legacy));
}

function expectSessionAfter(result: AdminRenderResult, rec: Recorded): void {
  const after = rec.sessionAfter;
  if (after === undefined) throw new Error('fixture has no sessionAfter');
  expect(result.sessionEffects?.openSectionList ?? rec.session.openSectionList).toBe(after.openSectionList);
  expect(cfStruct(result.sessionEffects?.flatViewArgs ?? rec.session.flatViewArgs)).toEqual(cfStruct(after.flatViewArgs));
}

describe('renderSiteManagerJson against recorded carch.loadsitemanager responses', () => {
  it.each(fixtureIds('loadsitemanager'))('%s', (id) => {
    const rec = recorded('loadsitemanager', id);
    const legacy = readText(`loadsitemanager/${id}.body`);
    const result = renderSiteManagerJson(managerModel(rec), context(rec));
    const [mine, theirs] = [muraJsonMembers(result.body), muraJsonMembers(legacy)];
    expect(Object.keys(mine)).toEqual(['perm', 'sortby', 'html']);
    expect(Object.keys(theirs)).toEqual(['perm', 'sortby', 'html']);
    expect([mine['perm'], mine['sortby']]).toEqual([theirs['perm'], theirs['sortby']]);
    expect(markupModel(String(mine['html']))).toEqual(markupModel(String(theirs['html'])));
    expectLegacyResponse(result, rec, legacy);
    expectSessionAfter(result, rec);
  });

  const home = recorded('loadsitemanager', 'admin-home');

  it('omits the breadcrumb for Component, Creative and Form requests', () => {
    for (const type of ['Component', 'Creative', 'Form']) {
      const html = String(muraJsonMembers(renderSiteManagerJson({ ...managerModel(home), type }, context(home)).body)['html']);
      expect(html).not.toContain('class="breadcrumb"');
      expect(html).toContain('</div>\n </div>\n\n\n <script>');
    }
  });

  it('marks restricted tops, locks nodes held by others and offers sorting to authors when the configuration allows', () => {
    const base = managerModel(home);
    const ctx = context(home);
    const model: SiteManagerModel = {
      ...base,
      topId: base.nest[0]?.contentid ?? '',
      perm: 'author',
      restricted: true,
      rsTop: { ...base.rsTop, lockid: 'someone-else' },
      hasKids: 0,
    };
    const html = String(
      muraJsonMembers(
        renderSiteManagerJson(model, {
          ...ctx,
          config: { ...ctx.config, sortPermission: 'author' },
          siteSettings: { ...ctx.siteSettings, hasLockableNodes: true },
        }).body,
      )['html'],
    );
    expect(html).toContain('<div class="marker"></div>');
    expect(html).toContain('mura-node-data restricted');
    expect(html).toContain('<li class="edit disabled"><a onclick="draftprompt.call(this,event);return false;"');
    expect(html).toContain('<select name="sortBy"  onchange="siteManager.setAsSorted();">');
    expect(html).not.toContain('class="hasChildren open"');
  });

  it('renders a scheduled top in a non-tree module and the read-only branch for read perm', () => {
    const forms = recorded('loadsitemanager', 'admin-forms');
    const base = managerModel(forms);
    const scheduled: SiteManagerModel = {
      ...base,
      perm: 'read',
      rsTop: {
        ...base.rsTop,
        type: 'Form',
        display: 2,
        approved: 1,
        displaystart: new Date(2026, 11, 1, 9, 0, 0),
        displaystop: new Date(2026, 11, 31, 17, 0, 0),
      },
    };
    const html = String(muraJsonMembers(renderSiteManagerJson(scheduled, context(forms)).body)['html']);
    expect(html).toContain('<dd class="display scheduled">');
    expect(html).toContain('<a href="#" rel="tooltip" title="12&#x2f;1&#x2f;26&amp;nbsp&#x3b;-&amp;nbsp&#x3b;12&#x2f;31&#x2f;26"></a>');
    expect(html).toContain('<a class="title" >');
  });
});

describe('renderLoadSiteSection and renderRefreshSiteSection against recorded responses', () => {
  it.each(fixtureIds('loadsitesection'))('loadsitesection %s', (id) => {
    const rec = recorded('loadsitesection', id);
    const legacy = readText(`loadsitesection/${id}.body`);
    const result = renderLoadSiteSection(sectionModel(rec), context(rec));
    if (legacy !== '') expect(markupModel(String(JSON.parse(result.body).html))).toEqual(markupModel(String(JSON.parse(legacy).html)));
    expectLegacyResponse(result, rec, legacy);
    expectSessionAfter(result, rec);
  });

  it.each(fixtureIds('refreshsitesection'))('refreshsitesection %s', (id) => {
    const rec = recorded('refreshsitesection', id);
    const legacy = readText(`refreshsitesection/${id}.body`);
    const result = renderRefreshSiteSection(sectionModel(rec), context(rec));
    expect(result.body.endsWith('} ')).toBe(true);
    expectLegacyResponse(result, rec, legacy);
    expect(result.sessionEffects).toBeUndefined();
  });

  it('fails as legacy does when the request leaves the sort empty, since neither view defines rc.rstop', () => {
    const rec = recorded('loadsitesection', 'admin-news-open');
    const model = sectionModel(rec);
    expect(() => renderLoadSiteSection({ ...model, sortDirection: '' }, context(rec))).toThrow(/RSTOP/);
    expect(() => renderRefreshSiteSection({ ...model, sortBy: '' }, context(rec))).toThrow(/RSTOP/);
  });
});

describe('renderSiteManagerTab against recorded carch.siteManagerTab responses', () => {
  it.each(fixtureIds('sitemanagertab'))('%s', (id) => {
    const rec = recorded('sitemanagertab', id);
    const result = renderSiteManagerTab(rec.request['tab'] ?? '', context(rec));
    expectLegacyResponse(result, rec, readText(`sitemanagertab/${id}.body`));
    expectSessionAfter(result, rec);
  });

  it('creates the session site entry when the session has none', () => {
    const rec = recorded('sitemanagertab', 'admin-tab1');
    const ctx = context(rec);
    const result = renderSiteManagerTab('2', { session: { ...ctx.session, flatViewArgs: {} } });
    expect(result.sessionEffects?.flatViewArgs).toEqual({ default: { tab: '2' } });
  });
});

describe('renderLoadDiff against recorded carch.loaddiff fragments', () => {
  it.each(fixtureIds('loaddiff'))('%s', (id) => {
    const rec = recorded('loaddiff', id);
    const [v1, v2] = versions(rec) as [DiffVersion, DiffVersion];
    expectLegacyResponse(renderLoadDiff(v1, v2, { labels }), rec, readText(`loaddiff/${id}.body`));
  });

  const v = (lastUpdate: Date, values: Array<readonly [string, unknown]>): DiffVersion => ({ lastUpdate, values });
  const older = new Date(2026, 5, 1, 9, 0, 0);
  const newer = new Date(2026, 5, 2, 9, 0, 0);

  it.each([
    ['case-only text', 'About', 'ABOUT'],
    ['numbers in different notation', '1', 1.0],
    ['a number against numeric text', 3, '3.0'],
    ['a boolean against 1', true, 1],
    ['yes against true', 'yes', true],
    ['dates within one second', new Date(2026, 5, 30, 13, 4, 5, 0), new Date(2026, 5, 30, 13, 4, 5, 999)],
    ['a date against its text', new Date(2026, 5, 30, 0, 0, 0), '2026-06-30'],
  ])('treats %s as equal, as CFML != does', (_label, a, b) => {
    const result = renderLoadDiff(v(older, [['summary', a]]), v(newer, [['summary', b]]), { labels });
    expect(result.body).toBe(labels.key('sitemanager.content.codediffnodifference'));
  });

  it('diffs the older version against the newer, skips non-comparable and complex values, and reads absent values as empty', () => {
    const base = v(older, [
      ['TITLE', 'One'],
      ['contentID', 'a'],
      ['objectParams', { complex: true }],
      ['created', new Date(2026, 0, 2, 3, 4, 5)],
      ['notes', 'kept'],
      ['nav', ''],
    ]);
    const other = v(newer, [
      ['title', 'Two'],
      ['contentID', 'b'],
      ['objectParams', 'x'],
      ['created', new Date(2026, 0, 2, 3, 4, 6)],
      ['nav', 0],
    ]);
    const body = renderLoadDiff(other, base, { labels }).body;
    expect(body.match(/<h3>[^<]*<\/h3>/g)).toEqual(
      acfStructKeyOrder(['TITLE', 'created', 'notes', 'nav']).map((key) => `<h3>${key.toUpperCase()}</h3>`),
    );
    expect(body).toContain("<span>{ts '2026-01-02 03:04:0</span><del style=\"background:#ffe6e6;\">5</del>");
    expect(body).toContain('<h3>NAV</h3><ins style="background:#e6ffe6;">0</ins>');
    expect(body).not.toContain('CONTENTID');
    expect(body).not.toContain('OBJECTPARAMS');
  });

  it('lists every property contentBean and its bases declare comparable="false"', () => {
    expect(CONTENT_COMPARABLE_EXCLUDED).toHaveLength(19);
    expect(new Set(CONTENT_COMPARABLE_EXCLUDED.map((p) => p.toLowerCase())).size).toBe(19);
  });
});

describe('renderLoadNotify and renderLoadExpireNotify against recorded fragments', () => {
  it.each(fixtureIds('loadnotify'))('loadnotify %s', (id) => {
    const rec = recorded('loadnotify', id);
    const result = renderLoadNotify(rec.model as never, context(rec));
    expectLegacyResponse(result, rec, readText(`loadnotify/${id}.body`));
  });

  it.each(fixtureIds('loadexpirenotify'))('loadexpirenotify %s', (id) => {
    const rec = recorded('loadexpirenotify', id);
    const result = renderLoadExpireNotify(rec.model as never, context(rec));
    expectLegacyResponse(result, rec, readText(`loadexpirenotify/${id}.body`));
  });

  it('omits the approval toggle for authors and prints names as stored', () => {
    const rec = recorded('loadnotify', 'admin-about');
    const row = { userid: 'u1', fname: 'Ann', lname: '<b>', type: 'Author' };
    const body = renderLoadNotify({ perm: 'author', rows: [row] }, context(rec)).body;
    expect(body).toContain('<select id="notifyEditor" name="notify" multiple="multiple" >');
    expect(body).toContain('<option value="u1"><b>, Ann (Author)</option>');
  });
});

describe('renderLockCheck against the recorded carch.lockcheck page', () => {
  it.each(fixtureIds('lockcheck'))('%s', (id) => {
    const rec = recorded('lockcheck', id);
    const page = readText(`lockcheck/${id}.body`);
    const r = rec.request;
    const model = {
      lockId: String((rec.model as { lockId: string }).lockId),
      queryString: r['queryString'] ?? '',
      destAction: r['destAction'] ?? '',
      contentId: r['contentid'] ?? '',
      siteId: r['siteid'] ?? '',
      contentHistId: r['contenthistid'] ?? '',
      homeId: r['homeid'] ?? '',
      coreVersion: rec.config?.coreVersion ?? '',
    };
    const result = renderLockCheck(model, context(rec));
    expect(result).toMatchObject({ status: rec.status, contentType: rec.contentType, layout: true });
    expect(page).toContain(`<div class="main mura-layout-row">${result.body}</div>`);
    expect(page).toContain(`${result.ajax ?? '<none>'}\n\t</head>`);
    expect(result.body.startsWith('\n<div id="configuratorContainer">')).toBe(true);
  });

  it('forwards the lock holder to the destination action', () => {
    const rec = recorded('lockcheck', 'admin-about');
    const ctx = context(rec);
    const model = {
      lockId: ctx.session.userId.toLowerCase(),
      queryString: 'muraAction=carch.lockcheck&destAction=carch.edit&x=carch.lockcheck',
      destAction: 'carch.edit',
      contentId: 'c',
      siteId: 'default',
      contentHistId: 'h',
      homeId: '',
      coreVersion: '7.6.1',
    };
    expect(renderLockCheck(model, ctx)).toEqual({
      status: 302,
      contentType: ADMIN_VIEW_CONTENT_TYPE,
      body: '',
      redirect: './?muraAction=carch.edit&destAction=carch.edit&x=carch.lockcheck',
    });
  });
});

describe('renderNest and renderNextN', () => {
  const rec = recorded('loadsitemanager', 'admin-home');
  const ctx = context(rec);
  const nest = managerModel(rec).nest;
  const attrs = {
    topId: '00000000000000000000000000000000001',
    parentId: '00000000000000000000000000000000001',
    locking: 'none',
    nestLevel: 1,
    perm: 'editor' as NodePerm,
    siteId: 'default',
    restricted: false,
    nextN: 20,
    startRow: '1',
    sortBy: 'orderno',
    isSectionRequest: false,
  };

  it('skips denied rows under a restricted parent and inherits the parent verdict for none', () => {
    const [first, second] = nest as [NestNode, NestNode];
    const rows = [{ ...first, verdict: 'deny' as NodePerm, restricted: 1 }, { ...second, verdict: 'none' as NodePerm }];
    const html = renderNest(rows, { ...attrs, perm: 'read' }, ctx, { tabAssignments: '' });
    expect(html).not.toContain(first.contentid);
    expect(html).toContain('<li class="edit disabled"><a><i class="mi-pencil"></i></a></li>');
  });

  it('renders denied rows of an unrestricted parent read-only and locks nodes held by others', () => {
    const [first] = nest as [NestNode];
    const html = renderNest(
      [{ ...first, verdict: 'deny', lockid: 'other' }],
      attrs,
      { ...ctx, siteSettings: { ...ctx.siteSettings, hasLockableNodes: true } },
      { tabAssignments: 'Basic' },
    );
    expect(html).toContain('<li class="edit disabled"><a><i class="mi-pencil"></i></a></li>');
    expect(html).not.toContain('mura-quickEditItem');
  });

  it('rejects an open section without its rows and a start row legacy cannot window', () => {
    const [first] = nest as [NestNode];
    const open = { ...ctx, session: { ...ctx.session, openSectionList: first.contentid ?? '' } };
    expect(() => renderNest([{ ...first, kidsCount: 2 }], attrs, open, { tabAssignments: '' })).toThrow(RangeError);
    expect(() => renderNest(nest, { ...attrs, startRow: '0' }, ctx, { tabAssignments: '' })).toThrow(RangeError);
  });

  it('pages with previous and next links around the current page', () => {
    const pager = renderNextN(
      { siteId: 'default', topId: 't', moduleId: 'm', ptype: 'Folder', startRow: 7, totalRecords: 25 },
      { ...ctx, session: { ...ctx.session, nextN: 3 } },
    );
    expect(pager).toContain('Showing 7-9 of 25 Results');
    expect(pager).toContain("loadSiteManager('default','t','m','','','Folder',4);\"><i class=\"mi-angle-left\">");
    expect(pager).toContain("loadSiteManager('default','t','m','','','Folder',10);\"><i class=\"mi-angle-right\">");
    expect(pager).toContain('<li class="active"><a href="#">3</a></li>');
  });
});

describe('admin-render barrel', () => {
  it('re-exports the sub-renderers and the label factory', () => {
    expect(typeof renderLoadSiteFlat).toBe('function');
    expect(typeof createAdminLabels).toBe('function');
    expect(ADMIN_JSON_CONTENT_TYPE).toBe('application/json;charset=utf-8');
  });

  // StructKeyArray of a struct assigned in key order, recorded on ACF 2023.0.26; 30 and 40 keys resize the table twice.
  it.each([
    [['html', 'perm', 'sortBy'], ['perm', 'sortBy', 'html']],
    [
      Array.from({ length: 40 }, (_, i) => `k${String(i).padStart(2, '0')}`),
      ['k20', 'k00', 'k22', 'k21', 'k02', 'k24', 'k01', 'k23', 'k04', 'k26', 'k03', 'k25', 'k06', 'k28', 'k05', 'k27', 'k08', 'k07', 'k29', 'k09',
       'k31', 'k30', 'k11', 'k33', 'k10', 'k32', 'k13', 'k35', 'k12', 'k34', 'k15', 'k37', 'k14', 'k36', 'k17', 'k39', 'k16', 'k38', 'k19', 'k18'],
    ],
    [
      ['title', 'menuTitle', 'body', 'summary', 'filename', 'urltitle', 'htmltitle', 'metadesc', 'metakeywords', 'tags', 'notes', 'remoteURL',
       'remoteSource', 'credits', 'audience', 'keyPoints', 'template', 'childTemplate', 'inheritObjects', 'target', 'targetParams',
       'responseMessage', 'responseSendTo', 'releaseDate', 'expires', 'displayStart', 'displayStop', 'isNav', 'isFeature', 'searchExclude'],
      ['target', 'targetParams', 'menuTitle', 'metadesc', 'releaseDate', 'audience', 'metakeywords', 'notes', 'summary', 'responseSendTo',
       'expires', 'template', 'filename', 'responseMessage', 'displayStart', 'isFeature', 'credits', 'remoteURL', 'keyPoints', 'childTemplate',
       'inheritObjects', 'searchExclude', 'isNav', 'displayStop', 'remoteSource', 'htmltitle', 'title', 'urltitle', 'body', 'tags'],
    ],
  ])('orders the struct keys %j as ACF 2023 iterates them', (keys, acf) => {
    expect(acfStructKeyOrder(keys)).toEqual(acf);
  });

  it('keeps the first spelling of a key assigned twice', () => {
    expect(acfStructKeyOrder(['perm', 'html', 'PERM'])).toEqual(acfStructKeyOrder(['perm', 'html']));
  });
});
