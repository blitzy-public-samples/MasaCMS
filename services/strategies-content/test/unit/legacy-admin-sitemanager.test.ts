// Site Manager fragments against Masa 7.6.1 on ACF 2023.0.26 (GS-CO-08 Site Manager tree and tabs): each fixture in
// test/fixtures/legacy-sitemanager holds the model read from a seeded legacy instance and the body that instance served
// for carch.loadsiteflat, carch.siteparents or carch.loadnewcontentmenu, CSRF values replaced by `<token>`.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCustomIconLookup,
  createAdminLabels,
  type AdminRenderContext,
  type AdminSession,
  type AdminSiteSettings,
} from '../../src/legacy/admin-markup.js';
import {
  SITE_MANAGER_FRAGMENT_CONTENT_TYPE,
  normalizeSiteFlatEvent,
  renderLoadNewContentMenu,
  renderLoadSiteFlat,
  renderSiteParents,
  siteFlatPage,
  type LoadSiteFlatModel,
  type NewContentMenuModel,
  type SiteFlatRow,
  type SiteParentsModel,
} from '../../src/legacy/admin-render-sitemanager.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';

type Action = 'loadsiteflat' | 'siteparents' | 'loadnewcontentmenu';
type IconRow = { siteid: string; type: string; subtype: string; iconclass: string };
type Recorded<M> = {
  user: 'admin' | 'qa_editor';
  model: M;
  iconRows: IconRow[];
  session?: AdminSession;
  siteSettings?: AdminSiteSettings;
  config?: AdminRenderContext['config'];
  /** `session.flatViewArgs` as legacy left it after the request. */
  sessionAfter?: Record<string, Record<string, unknown>>;
};
type RecordedFlatRow = Omit<SiteFlatRow, 'lastupdate' | 'created' | 'expires' | 'duedate'> & {
  lastupdate: string | null;
  created: string | null;
  expires: string | null;
  duedate?: string | null;
};

const FIXTURES = new URL('../fixtures/legacy-sitemanager/', import.meta.url);
const readText = (path: string): string => readFileSync(new URL(path, FIXTURES), 'utf8');
const readJson = <T>(path: string): T => JSON.parse(readText(path)) as T;
const fixtureIds = (action: Action): string[] =>
  readdirSync(new URL(`${action}/`, FIXTURES))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();

const labels = createAdminLabels(readJson<Record<string, string>>('labels.json'), {}, 'en_US');
const site = readJson<LegacySiteUrlConfig>('site.json');
const TOKEN = '<token>';

function context(recorded: Recorded<unknown>): AdminRenderContext {
  return {
    labels,
    site,
    session: recorded.session ?? ({} as AdminSession),
    siteSettings: recorded.siteSettings ?? ({} as AdminSiteSettings),
    config: recorded.config ?? ({} as AdminRenderContext['config']),
    csrf: () => ({ token: TOKEN, expires: TOKEN }),
  };
}

/** A recorded `yyyy-mm-ddTHH:nn:ss.lll` server-local timestamp. */
function localDate(text: string | null | undefined): Date | null {
  if (text === null || text === undefined) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(text);
  if (m === null) throw new Error(`Unexpected timestamp ${text}`);
  const [, y, mo, d, h, mi, s, ms] = m.map(Number) as [number, number, number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s, ms);
}

function flatModel(recorded: Recorded<Omit<LoadSiteFlatModel, 'rows'> & { rows: RecordedFlatRow[] }>): LoadSiteFlatModel {
  const rows = recorded.model.rows.map(({ duedate, ...row }): SiteFlatRow => ({
    ...row,
    lastupdate: localDate(row.lastupdate),
    created: localDate(row.created),
    expires: localDate(row.expires),
    ...(duedate === undefined ? {} : { duedate: localDate(duedate) }),
  }));
  return { ...recorded.model, rows, customIcons: buildCustomIconLookup(recorded.iconRows) };
}

/** CSRF values become the token placeholder and CF UUIDs `<id:n>` in order of first appearance, as the golden normaliser does. */
function normalise(html: string): string {
  const ids = new Map<string, string>();
  return html
    .replace(/(csrf_token(?:_expires)?=)[^&"']*/g, `$1${TOKEN}`)
    .replace(/(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}(?![0-9A-Fa-f-])/g, (id) => {
      const key = id.toUpperCase();
      if (!ids.has(key)) ids.set(key, `<id:${ids.size + 1}>`);
      return ids.get(key) as string;
    });
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

function expectLegacyBody(body: string, legacy: string): void {
  const model = markupModel(legacy);
  expect(model.length).toBeGreaterThan(5);
  expect(markupModel(body)).toEqual(model);
  expect(normalise(body)).toBe(normalise(legacy));
}

describe('renderLoadSiteFlat against recorded loadsiteflat responses', () => {
  it.each(fixtureIds('loadsiteflat'))('%s', (id) => {
    const recorded = readJson<Recorded<Omit<LoadSiteFlatModel, 'rows'> & { rows: RecordedFlatRow[] }>>(`loadsiteflat/${id}.json`);
    const result = renderLoadSiteFlat(flatModel(recorded), context(recorded));
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html;charset=UTF-8');
    expectLegacyBody(result.body, readText(`loadsiteflat/${id}.html`));
    expect(cfStruct(result.sessionEffects?.flatViewArgs ?? {})).toEqual(cfStruct(recorded.sessionAfter ?? {}));
  });

  const page1 = readJson<Recorded<Omit<LoadSiteFlatModel, 'rows'> & { rows: RecordedFlatRow[] }>>('loadsiteflat/admin-page1.json');

  it('serves page 1 for a non-numeric page, as the legacy capture with page=abc shows', () => {
    const model = flatModel(page1);
    const result = renderLoadSiteFlat({ ...model, event: { ...model.event, page: 'abc' } }, context(page1));
    expect(normalise(result.body)).toBe(normalise(readText('loadsiteflat/admin-page1.html')));
    expect(cfStruct(result.sessionEffects?.flatViewArgs ?? {})['default']).toMatchObject({ page: '1' });
  });

  it('prints renderFileSize megabytes for files over 1,000,000 bytes', () => {
    const model = flatModel(page1);
    const index = model.rows.findIndex((row) => row.fileext !== null && row.fileext !== '');
    expect(index).toBeGreaterThanOrEqual(0);
    const rows = model.rows.map((row, i) => (i === index ? { ...row, filesize: 2_345_000 } : row));
    expect(renderLoadSiteFlat({ ...model, rows }, context(page1)).body).toContain('<strong>2.35Mb</strong>');
  });

  it('rejects rows that do not fill the requested page', () => {
    const model = flatModel(page1);
    expect(() => renderLoadSiteFlat({ ...model, rows: model.rows.slice(1) }, context(page1))).toThrow(RangeError);
  });

  it('fails as legacy does when the session site has no flatViewArgs entry', () => {
    const ctx = context(page1);
    const session = { ...ctx.session, siteId: 'other', flatViewArgs: {} };
    expect(() => renderLoadSiteFlat(flatModel(page1), { ...ctx, session })).toThrow(/OTHER|other/);
  });
});

describe('normalizeSiteFlatEvent', () => {
  it.each([
    [{ page: 'x', sortBy: 'expiration', report: '' }, { page: 1, sortBy: 'lastupdate', report: '' }],
    [{ page: 2, sortby: 'expiration', report: 'myexpires' }, { page: 2, sortby: 'expiration', report: 'myexpires' }],
    [{ page: '3', sortby: 'duedate', report: 'expires' }, { page: '3', sortby: 'lastupdate', report: 'expires' }],
    [{ page: '1', sortby: 'DueDate', report: 'myapprovals' }, { page: '1', sortby: 'DueDate', report: 'myapprovals' }],
  ])('%o reads as %o', (event, expected) => {
    expect(normalizeSiteFlatEvent(event)).toEqual(expected);
  });
});

describe('siteFlatPage', () => {
  it.each([
    [0, 1, { pageIndex: 1, offset: 0, count: 0, pageCount: 0, firstRecord: 1, lastRecord: 0 }],
    [25, 3, { pageIndex: 3, offset: 20, count: 5, pageCount: 3, firstRecord: 21, lastRecord: 25 }],
    [25, 9, { pageIndex: 1, offset: 0, count: 10, pageCount: 3, firstRecord: 1, lastRecord: 10 }],
  ])('%i rows, page %i', (total, page, expected) => {
    expect(siteFlatPage(total, page)).toEqual(expected);
  });

  it.each([0, 1.25])('fails for page %d, which has no first row', (page) => {
    expect(() => siteFlatPage(25, page)).toThrow(RangeError);
  });
});

describe('renderSiteParents against recorded siteparents responses', () => {
  it.each(fixtureIds('siteparents'))('%s', (id) => {
    const recorded = readJson<Recorded<SiteParentsModel>>(`siteparents/${id}.json`);
    const model = { ...recorded.model, customIcons: buildCustomIconLookup(recorded.iconRows) };
    const result = renderSiteParents(model, context(recorded));
    expect(result).toMatchObject({ status: 200, contentType: SITE_MANAGER_FRAGMENT_CONTENT_TYPE });
    expect(result.sessionEffects).toBeUndefined();
    expectLegacyBody(result.body, readText(`siteparents/${id}.html`));
  });

  it('needs the parent crumbs it lists', () => {
    const recorded = readJson<Recorded<SiteParentsModel>>('siteparents/folder-search.json');
    const parent = { moduleId: recorded.model.parent?.moduleId ?? '', crumbs: [] };
    expect(() => renderSiteParents({ ...recorded.model, parent }, context(recorded))).toThrow(RangeError);
  });

  it('lists at most 150 search rows', () => {
    const recorded = readJson<Recorded<SiteParentsModel>>('siteparents/folder-search.json');
    const { contentId, parentId } = recorded.model;
    const row = recorded.model.rows.find((r) => r.contentid !== parentId && !(r.crumbs[0]?.parentarray ?? []).includes(contentId));
    expect(row).toBeDefined();
    const rows = Array.from({ length: 160 }, () => row as SiteParentsModel['rows'][number]);
    const body = renderSiteParents({ ...recorded.model, rows }, context(recorded)).body;
    expect(body.match(/<input type="radio" name="parentid" value="/g)).toHaveLength(151);
  });
});

describe('renderLoadNewContentMenu against recorded loadnewcontentmenu responses', () => {
  it.each(fixtureIds('loadnewcontentmenu'))('%s', (id) => {
    const recorded = readJson<Recorded<NewContentMenuModel>>(`loadnewcontentmenu/${id}.json`);
    const model = { ...recorded.model, customIcons: buildCustomIconLookup(recorded.iconRows) };
    const result = renderLoadNewContentMenu(model, context(recorded));
    expect(result).toMatchObject({ status: 200, contentType: SITE_MANAGER_FRAGMENT_CONTENT_TYPE });
    // With frontEndProxyLoc legacy keeps the admin layout around the view; the fixture holds the view's part.
    expect(result.layout === true).toBe(model.frontEndProxyLoc);
    expectLegacyBody(result.body, readText(`loadnewcontentmenu/${id}.html`));
  });
});
