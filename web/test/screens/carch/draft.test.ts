// cArch.draft inside the shell over the recorded strategies-content drafts, against carch/draft.cfm 76-122;
// draft-coverage.test.ts and draft-listing.test.ts cover each screen step and the row filter on their own.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftScreen } from '@/screens/carch/draft';
import { carchJs } from '@/screens/carch/partials/js';
import { dspZoom, type ZoomOptions } from '@/screens/carch/partials/zoom';
import { CARCH_PATHS, CONTENT_IDS, carchDraftData } from '../../fixtures/strategies-content/carch';
import { anonymousRequest, editorRequest, siteAdminRequest, subjectClaims } from '../../helpers/admin-request';
import { domModel, fragmentModel, normaliseAdminUrl, type DomLink, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

type DraftRequest = ReturnType<typeof siteAdminRequest>;
type DraftContext = ReturnType<typeof makeScreenContext>;
type DraftViewModel = typeof carchDraftData;

/** A recorded `getDraftList` row, its columns keyed as the fixture keys them. */
interface DraftFixtureRow {
  readonly ContentID: string;
  readonly Type: string;
  readonly ParentID: string;
  readonly ModuleID: string;
  readonly Module: string;
  readonly crumbdata: ZoomOptions['crumbdata'];
}

const screen = draftScreen as Required<typeof draftScreen>;
const SITE = 'tenant-a';
const ROOT = '00000000000000000000000000000000001';
const SITE_MANAGER = '00000000000000000000000000000000000';
const FORMS = '00000000000000000000000000000000004';
// The contract serves cArch.draft at `/content/drafts`; it names no `/carch/draft` path.
const DRAFTS = routeKey('GET', 'strategies-content', CARCH_PATHS.draft);
const DRAFT_ACTION = { circuit: 'cArch', item: 'draft' } as const;
const ROWS = carchDraftData.rc.rslist as readonly DraftFixtureRow[];
const NO_DRAFTS = 'You currently have no drafts available for review.';

/** A screen context whose drafts read answers `data`. */
const draftContext = (req: DraftRequest, data: DraftViewModel = carchDraftData): DraftContext =>
  makeScreenContext({ req, gateway: fakeGatewayClient({ [DRAFTS]: { status: 200, body: data } }) });

const siteAdminDraft = (): DraftRequest => siteAdminRequest(SITE, DRAFT_ACTION);

/** The drafts model with no `rslist` rows. */
function noDrafts(): DraftViewModel {
  const data = structuredClone(carchDraftData);
  data.rc.rslist = [];
  return data;
}

interface DraftPage {
  readonly html: string;
  readonly model: DomModel;
  /** Links of the drafts table only, in document order. */
  readonly tableLinks: DomLink[];
}

/** The document `ctx` renders inside the shell. */
async function renderPage(ctx: DraftContext): Promise<DraftPage> {
  const page = await renderScreenPage(draftScreen, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  const $ = cheerio.load(page.html);
  return {
    html: page.html,
    model: domModel(page.html),
    tableLinks: fragmentModel($.html($('table.mura-table-grid'))).links,
  };
}

// draft.cfm links each draft to cArch.hist only and prints no date column, so neither cArch.edit nor a date is asserted.
/** The view's `cArch.hist` link of `row`, as legacy writes it. */
const historyHref = (row: Omit<DraftFixtureRow, 'Module' | 'crumbdata'>): string =>
  `./?muraAction=cArch.hist&contentid=${row.ContentID}&type=${row.Type}&parentid=${row.ParentID}` +
  `&topid=${ROOT}&siteid=${SITE}&moduleid=${row.ModuleID}`;

/** The links of `$.dspZoom(itemcrumbdata)` for `row`. */
const zoomLinks = (ctx: DraftContext, row: DraftFixtureRow): DomLink[] =>
  fragmentModel(dspZoom(ctx, { crumbdata: row.crumbdata }).value).links;

/** The strategies-content calls `gateway` received, as `METHOD path`. */
const contentCalls = (gateway: FakeGatewayClient): string[] =>
  gateway.calls.filter(({ service }) => service === 'strategies-content').map(({ method, path }) => `${method} ${path}`);

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('carch.draft page', () => {
  it('lists each draft with its history link, breadcrumb and module under the legacy headers', async () => {
    const ctx = draftContext(siteAdminDraft());

    const { model, tableLinks } = await renderPage(ctx);

    expect(model.title).toBe('Masa CMS - Site Content');
    expect(model.headings).toEqual(['Drafts']);
    expect(model.tables).toEqual([
      {
        headers: ['', 'Title', 'Content Type'],
        rows: ROWS.map((row) => [
          'Version History',
          zoomLinks(ctx, row)
            .map(({ text }) => text)
            .join(' '),
          row.Module,
        ]),
      },
    ]);
    expect(tableLinks).toEqual(
      ROWS.flatMap((row): DomLink[] => [
        { href: 'javascript:;', text: '' },
        { href: normaliseAdminUrl(historyHref(row)), text: 'Version History' },
        ...zoomLinks(ctx, row),
      ]),
    );
    const crumbHref = (topId: string): string =>
      `/admin/?muraAction=carch.list&activeTab=0&moduleid=${SITE_MANAGER}&siteid=${SITE}&topid=${topId}`;
    expect(tableLinks.slice(2, 4)).toEqual([
      { href: crumbHref(ROOT), text: 'Home' },
      { href: crumbHref(CONTENT_IDS.aboutUs), text: 'About Us' },
    ]);
    expect(contentCalls(ctx.gateway)).toContain(`GET ${CARCH_PATHS.draft}`);
  });

  it('links a form draft by its menu title, a numeric title printed as CFML text', async () => {
    const form = {
      ContentID: CONTENT_IDS.contactForm,
      Type: 'Form',
      ParentID: FORMS,
      ModuleID: FORMS,
      Module: 'Forms',
      MenuTitle: 2026,
      verdict: 'editor',
    };
    const data = noDrafts();
    data.rc.rslist = [form];

    const { model, tableLinks } = await renderPage(draftContext(siteAdminDraft(), data));

    expect(model.tables[0]?.rows).toEqual([['Version History', '2026', 'Forms']]);
    const history = normaliseAdminUrl(historyHref(form));
    expect(tableLinks).toEqual([
      { href: 'javascript:;', text: '' },
      { href: history, text: 'Version History' },
      { href: history, text: '2026' },
    ]);
  });

  it('prints the no-drafts row when getDraftList returns no rows', async () => {
    const { model, tableLinks } = await renderPage(draftContext(siteAdminDraft(), noDrafts()));

    expect(model.tables).toEqual([{ headers: ['', 'Title', 'Content Type'], rows: [[NO_DRAFTS]] }]);
    expect(tableLinks).toEqual([]);
  });

  it('places no secondary menu, as draft.cfm includes none', async () => {
    const ctx = draftContext(siteAdminDraft());

    const { html } = await renderPage(ctx);

    expect(ctx.hooks.secondaryMenus.carch).toBeDefined();
    expect(cheerio.load(html)('.nav-module-specific')).toHaveLength(0);
  });

  it('hands the shell the js.cfm script of the draft action', async () => {
    const ctx = draftContext(siteAdminDraft());

    expect(await screen.redirect(ctx)).toBeUndefined();
    const view = await screen.render(ctx, await screen.load(ctx));

    expect(view.ajax?.value).toBe(carchJs(ctx, 'draft').value);
    expect(view.ajax?.value).toContain('architecture.min.js');
  });
});

describe('carch.draft gate', () => {
  it('sends anonymous to the login form with the draft return URL through secure()', async () => {
    const req = anonymousRequest(DRAFT_ACTION);
    const ctx = draftContext(req);

    const page = await renderScreenPage(draftScreen, ctx);

    expect(page.kind).toBe('redirect');
    const location = page.kind === 'redirect' ? page.location : '';
    const [path, query = ''] = location.split('?');
    expect(path).toBe('./');
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      muraAction: 'cLogin.main',
      returnURL: `http://${req.serverName}/admin/?&muraAction=cArch.draft`,
      compactDisplay: 'false',
    });
    expect(contentCalls(ctx.gateway)).toEqual([]);
  });

  it('sends qa_editor without the Site Manager module back through secure()', async () => {
    const roles = (subjectClaims('qaEditor')?.roles ?? []).filter((role) => !role.startsWith('m:'));
    const ctx = draftContext(editorRequest({ ...DRAFT_ACTION, user: { roles } }));

    expect(await renderScreenPage(draftScreen, ctx)).toEqual({ kind: 'redirect', location: './' });
    expect(contentCalls(ctx.gateway)).toEqual([]);
  });
});
