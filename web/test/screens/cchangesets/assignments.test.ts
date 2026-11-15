// cChangesets.assignments over the shared strategies-content fixture, against cchangesets/assignments.cfm and dspZoom.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacySettings } from '@/lib/env';
import { encodeJs, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cchangesetsScreens } from '@/screens/cchangesets';
import {
  changesetAssignmentsScreen,
  loadChangesetAssignments,
  renderChangesetAssignments,
  renderZoom,
  type ChangesetAssignmentCrumb,
  type ChangesetAssignmentRow,
  type ChangesetAssignmentsData,
} from '@/screens/cchangesets/assignments';
import { CONTENT_HIST_IDS, CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import {
  CCHANGESETS_PATHS,
  CHANGESET_IDS,
  cchangesetsAssignmentsData,
} from '../../fixtures/strategies-content/changesets';
import { adminS2Request } from '../../helpers/admin-request';
import { domModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry imports every circuit barrel; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Cheerio = cheerio.CheerioAPI;
type Transform = (data: ChangesetAssignmentsData) => ChangesetAssignmentsData;

const SITE = 'tenant-a';
// The fixture models the scheduled change set, so the request names that set.
const CHANGESET_ID = CHANGESET_IDS.scheduled;
const PREVIEW_LINK = `http://${SITE}.localhost:8100/?changesetID=${CHANGESET_ID}`;
const ROOT_ID = '00000000000000000000000000000000001';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const FORMS_MODULE = '00000000000000000000000000000000004';
const VARIATIONS_MODULE = '00000000000000000000000000000000099';
const CSRF_URL = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;
const HEADERS = ['', 'Title', 'Status'];
const SECTIONS = ['Site Architecture', 'Components', 'Forms'];
const REMOTE_URL = 'https://remote.example/about-us';
const ASSIGNMENTS_ROUTE = routeKey('GET', 'strategies-content', CCHANGESETS_PATHS.assignments);

const assignmentsRequest = (rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  adminS2Request({
    circuit: 'cChangesets',
    item: 'assignments',
    rc: { siteid: SITE, changesetid: CHANGESET_ID, keywords: '', startrow: '1', ...rc },
  });

/** A screen context whose strategies-content answers the assignments read with the shared fixture. */
const contextFor = (req: AdminRequest = assignmentsRequest()) =>
  makeScreenContext({
    req,
    gateway: fakeGatewayClient({ [ASSIGNMENTS_ROUTE]: { status: 200, body: cchangesetsAssignmentsData } }),
  });

/** Entry `index` of `items`; throws when the fixture has no such entry. */
function at<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no entry ${index}`);
  return item;
}

/** The crumbs a loaded row carries for dspZoom. */
function crumbsOf(row: ChangesetAssignmentRow): readonly ChangesetAssignmentCrumb[] {
  if (isSafeHtml(row.zoom)) throw new Error('row carries rendered zoom markup');
  return row.zoom;
}

/** The loaded fixture, `transform`ed, rendered in `req` with the tokens `load` prefetched. */
async function rendered(
  transform: Transform = (data) => data,
  req: AdminRequest = assignmentsRequest(),
): Promise<{ data: ChangesetAssignmentsData; markup: string; $: Cheerio; model: DomModel }> {
  const ctx = contextFor(req);
  const data = transform(await loadChangesetAssignments(ctx));
  const markup = toString((await renderChangesetAssignments(ctx, data)).body);
  return { data, markup, $: cheerio.load(markup), model: domModel(markup) };
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Table `index` of the module sections. */
const tableAt = ($: Cheerio, index: number) => $('table.mura-table-grid').eq(index);

/** Href and collapsed text of the `li.<item> a` of the first row in table `index`. */
function actionLink($: Cheerio, index: number, item: string): { href?: string; text: string } {
  const anchor = tableAt($, index).find(`li.${item} a`).first();
  return { href: anchor.attr('href'), text: collapse(anchor.text()) };
}

const crumbHref = (contentid: string, moduleid = SITE_MANAGER_MODULE): string => {
  const { context, adminDir } = legacySettings();
  return (
    `${context}${adminDir}/?muraAction=cArch.list&siteid=${SITE}&topid=${contentid}` +
    `&moduleid=${moduleid}&activeTab=0`
  );
};

const removeHref = (contentHistId: string, keywords = ''): string =>
  `./?muraAction=cChangesets.removeItem&contentHistId=${contentHistId}&siteid=${SITE}&changesetID=${CHANGESET_ID}` +
  `&keywords=${keywords}${CSRF_URL}`;

const withSite =
  (rows: (site: readonly ChangesetAssignmentRow[]) => readonly ChangesetAssignmentRow[]): Transform =>
  (data) => ({ ...data, site: rows(data.site) });

const withChangeset =
  (changeset: Partial<ChangesetAssignmentsData['changeset']>, previewLink?: string): Transform =>
  (data) => ({
    ...data,
    changeset: { ...data.changeset, ...changeset },
    ...(previewLink === undefined ? {} : { previewLink }),
  });

/** The fixture's first site row as a remote variation, which only the variations setting lists. */
const withVariations: Transform = (data) => ({
  ...data,
  variations: [{ ...at(data.site), moduleId: VARIATIONS_MODULE, type: 'Variation', remoteUrl: REMOTE_URL }],
});

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('loadChangesetAssignments', () => {
  it('forwards changesetID and keywords and prefetches the remove tokens', async () => {
    const ctx = contextFor(assignmentsRequest({ keywords: 'Autumn & <Launch>' }));

    await loadChangesetAssignments(ctx);

    expect(ctx.gateway.calls).toEqual([
      {
        service: 'strategies-content',
        method: 'GET',
        path: `/v1/sites/${SITE}/changesets/${CHANGESET_ID}/assignments`,
        query: { keywords: 'Autumn & <Launch>' },
      },
      { service: 'identity', method: 'POST', path: '/v1/csrf/tokens', json: { contexts: [CHANGESET_ID] } },
    ]);
  });

  it('maps the fixture model', async () => {
    const data = await loadChangesetAssignments(contextFor());

    expect(data.changeset).toEqual({
      changesetId: CHANGESET_ID,
      name: 'Autumn Launch',
      published: false,
      hasPendingApprovals: false,
      closeDate: null,
    });
    expect(data.previewLink).toBe(PREVIEW_LINK);
    expect('variations' in data).toBe(false);
    expect(
      [data.site, data.components, data.forms].map((rows) =>
        rows.map(({ contentHistId, contentId, moduleId, type, verdict }) => ({
          contentHistId,
          contentId,
          moduleId,
          type,
          verdict,
        })),
      ),
    ).toEqual([
      [
        {
          contentHistId: CONTENT_HIST_IDS.aboutUsDraft,
          contentId: CONTENT_IDS.aboutUs,
          moduleId: SITE_MANAGER_MODULE,
          type: 'Page',
          verdict: 'editor',
        },
        {
          contentHistId: CONTENT_HIST_IDS.newsArticleDraft,
          contentId: CONTENT_IDS.newsArticle,
          moduleId: SITE_MANAGER_MODULE,
          type: 'Page',
          verdict: 'editor',
        },
      ],
      [
        {
          contentHistId: CONTENT_HIST_IDS.homeBanner,
          contentId: CONTENT_IDS.homeBanner,
          moduleId: COMPONENTS_MODULE,
          type: 'Component',
          verdict: 'editor',
        },
      ],
      [
        {
          contentHistId: CONTENT_HIST_IDS.contactForm,
          contentId: CONTENT_IDS.contactForm,
          moduleId: FORMS_MODULE,
          type: 'Form',
          verdict: 'editor',
        },
      ],
    ]);
    expect(crumbsOf(at(data.site, 1)).map((crumb) => crumb.menutitle)).toEqual(['Program Update', 'News', 'Home']);
  });
});

describe('renderChangesetAssignments', () => {
  it('renders the header, change-set name and keyword filter', async () => {
    const { $ } = await rendered();

    expect($('h1').text()).toBe('Change Set Content List');
    expect($('h1').next().is('div.nav-module-specific')).toBe(true);
    expect($('h2').text()).toBe('Autumn Launch');
    const form = $('form#assignmentSearch');
    expect(form.attr('method')).toBe('get');
    const keywords = form.find('input[name="keywords"]');
    expect([keywords.attr('placeholder'), keywords.attr('maxlength')]).toEqual(['Keywords', '50']);
    expect(form.find('input[type="button"]').attr('value')).toBe('Filter View');
    expect(
      form
        .find('input[type="hidden"]')
        .toArray()
        .map((input) => [$(input).attr('name'), $(input).attr('value')]),
    ).toEqual([
      ['muraAction', 'cChangesets.assignments'],
      ['siteid', SITE],
      ['changesetID', CHANGESET_ID],
    ]);
  });

  it('HTML-encodes the change-set name', async () => {
    const { markup, $ } = await rendered(withChangeset({ name: 'R&D <Launch>' }));

    expect(markup).toContain('<h2>R&amp;D &lt;Launch&gt;</h2>');
    expect($('p:has(i.mi-link) a').attr('title')).toBe('R&D <Launch>');
  });

  it('links the preview the secondary menu set for an unpublished set', async () => {
    const { $ } = await rendered();

    const link = $('p:has(i.mi-link) a');
    expect(link.attr('href')).toBe(PREVIEW_LINK);
    expect(link.text()).toBe(PREVIEW_LINK);
    expect(link.attr('onclick')).toBe(`return preview('${encodeJs(PREVIEW_LINK)}','');`);
    expect($('div.nav-module-specific a[onclick^="return preview("]').attr('onclick')).toBe(link.attr('onclick'));
  });

  it('leaves out both preview links of a published set', async () => {
    const { $ } = await rendered(withChangeset({ published: true }, ''));

    expect($('p:has(i.mi-link)')).toHaveLength(0);
    expect($('div.nav-module-specific a[onclick^="return preview("]')).toHaveLength(0);
  });

  it.each<{ name: string; changeset: Partial<ChangesetAssignmentsData['changeset']>; alerts: DomModel['alerts'] }>([
    { name: 'no alert for an open set', changeset: {}, alerts: [] },
    {
      name: 'the pending-approval alert',
      changeset: { hasPendingApprovals: true },
      alerts: [
        { text: 'This change set contains content that has not been approved.', className: 'alert alert-error' },
      ],
    },
    {
      name: 'the close date in the day-of-year mask',
      changeset: { closeDate: '2026-10-29T00:00:00.000' },
      alerts: [{ text: 'This change set has a close date of 10/302/2026.', className: 'alert alert-info' }],
    },
    {
      name: 'the published notice alone, without the close date',
      changeset: { published: true, closeDate: '2026-10-29T00:00:00.000' },
      alerts: [{ text: 'This change set has been published.', className: 'alert alert-info' }],
    },
  ])('shows $name', async ({ changeset, alerts }) => {
    const { model } = await rendered(withChangeset(changeset));

    expect(model.alerts).toEqual(alerts);
  });

  it.each<{ name: string; transform?: Transform; sections: string[] }>([
    { name: 'without variations', sections: SECTIONS },
    { name: 'with variations', transform: withVariations, sections: [...SECTIONS, 'Remote Variations'] },
  ])('lists one table per module section $name', async ({ transform, sections }) => {
    const { $, model } = await rendered(transform);

    expect($('h3').toArray().map((h3) => $(h3).text())).toEqual(sections);
    expect($('h3').toArray().every((h3) => $(h3).next().is('table.mura-table-grid'))).toBe(true);
    expect($('table.mura-table-grid')).toHaveLength(sections.length);
    expect(model.tables.map((table) => table.headers)).toEqual(sections.map(() => HEADERS));
  });

  it('links a site architecture row', async () => {
    const { $ } = await rendered();

    expect(actionLink($, 0, 'edit')).toEqual({
      href:
        `./?muraAction=cArch.edit&contenthistid=${CONTENT_HIST_IDS.aboutUsDraft}&contentid=${CONTENT_IDS.aboutUs}` +
        `&type=Page&parentid=${ROOT_ID}&topid=${CONTENT_IDS.aboutUs}&siteid=${SITE}&moduleid=${SITE_MANAGER_MODULE}` +
        '&startrow=1&return=changesets',
      text: 'Edit',
    });
    expect(actionLink($, 0, 'preview')).toEqual({ href: '#', text: 'Preview' });
    expect(tableAt($, 0).find('li.preview a').first().attr('onclick')).toBe(
      `return preview('http://${SITE}.localhost:8100/about-us/?previewid=${CONTENT_HIST_IDS.aboutUsDraft}');`,
    );
    expect(actionLink($, 0, 'version-history')).toEqual({
      href:
        `./?muraAction=cArch.hist&contentid=${CONTENT_IDS.aboutUs}&type=Page&parentid=${ROOT_ID}` +
        `&topid=${CONTENT_IDS.aboutUs}&siteid=${SITE}&moduleid=${SITE_MANAGER_MODULE}&startrow=1`,
      text: 'Version History',
    });
    expect(actionLink($, 0, 'delete')).toEqual({ href: removeHref(CONTENT_HIST_IDS.aboutUsDraft), text: 'Delete' });
    expect(tableAt($, 0).find('li.delete a').first().attr('onclick')).toBe(
      `return confirmDialog('${encodeJs('Remove item from change set?')}',this.href)`,
    );
    expect(
      tableAt($, 0)
        .find('td.title.var-width')
        .toArray()
        .map((cell) => $(cell).children('ul.breadcrumb').length),
    ).toEqual([1, 1]);
  });

  it.each<{
    name: string;
    index: number;
    contentId: string;
    contentHistId: string;
    type: string;
    moduleId: string;
    beforeSiteid: string;
  }>([
    {
      name: 'a component row, its history link doubling the & before siteid',
      index: 1,
      contentId: CONTENT_IDS.homeBanner,
      contentHistId: CONTENT_HIST_IDS.homeBanner,
      type: 'Component',
      moduleId: COMPONENTS_MODULE,
      beforeSiteid: '&&',
    },
    {
      name: 'a form row',
      index: 2,
      contentId: CONTENT_IDS.contactForm,
      contentHistId: CONTENT_HIST_IDS.contactForm,
      type: 'Form',
      moduleId: FORMS_MODULE,
      beforeSiteid: '&',
    },
  ])('links $name', async ({ index, contentId, contentHistId, type, moduleId, beforeSiteid }) => {
    const { markup, $ } = await rendered();

    expect(actionLink($, index, 'edit')).toEqual({
      href:
        `./?muraAction=cArch.edit&contenthistid=${contentHistId}&contentid=${contentId}&type=${type}` +
        `&parentid=${moduleId}&siteid=${SITE}&moduleid=${moduleId}&startrow=1&return=changesets`,
      text: 'Edit',
    });
    const history =
      `./?muraAction=cArch.hist&contentid=${contentId}&type=${type}&parentid=${moduleId}` +
      `${beforeSiteid}siteid=${SITE}&moduleid=${moduleId}&startrow=1`;
    expect(actionLink($, index, 'version-history')).toEqual({ href: history, text: 'Version History' });
    expect(markup).toContain(`href="${history}"`);
    expect(actionLink($, index, 'delete')).toEqual({ href: removeHref(contentHistId), text: 'Delete' });
    expect(tableAt($, index).find('li.preview')).toHaveLength(0);
  });

  it('HTML-encodes keywords inside the remove link, after which the CSRF fields follow', async () => {
    const { markup, $ } = await rendered(undefined, assignmentsRequest({ keywords: 'a&b' }));

    const href = removeHref(CONTENT_HIST_IDS.aboutUsDraft, 'a&amp;b');
    expect(markup).toContain(`href="${href}"`);
    expect(href.endsWith(`csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`)).toBe(true);
    expect($('input[name="keywords"]').attr('value')).toBe('a&b');
  });

  it('keeps only the preview icon and a disabled "Preview" item on a site row without a node permission', async () => {
    const { $ } = await rendered(withSite((site) => [{ ...at(site), verdict: 'none' }]));

    const actions = tableAt($, 0).find('ul.actions-list');
    expect(actions.find('li.edit')).toHaveLength(0);
    expect(actionLink($, 0, 'preview')).toEqual({ href: '#', text: '' });
    expect(actions.find('li.preview i.mi-globe')).toHaveLength(1);
    const disabled = actions.find('li.version-history.disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled.text()).toBe('Preview');
    expect(disabled.find('a')).toHaveLength(0);
    expect(actionLink($, 0, 'delete')).toEqual({ href: removeHref(CONTENT_HIST_IDS.aboutUsDraft), text: 'Delete' });
  });

  it.each<{ name: string; index: number; transform: Transform }>([
    {
      name: 'a component row',
      index: 1,
      transform: (data) => ({ ...data, components: [{ ...at(data.components), verdict: 'none' }] }),
    },
    {
      name: 'a form row',
      index: 2,
      transform: (data) => ({ ...data, forms: [{ ...at(data.forms), verdict: 'none' }] }),
    },
  ])('keeps only the delete on $name without a node permission', async ({ index, transform }) => {
    const { $ } = await rendered(transform);

    expect(
      tableAt($, index)
        .find('ul.actions-list > li')
        .toArray()
        .map((li) => $(li).attr('class')),
    ).toEqual(['delete']);
  });

  it('links a variation row with titled icons and the remote preview', async () => {
    const { data, markup, $ } = await rendered(withVariations);

    const variations = tableAt($, 3);
    const edit =
      `./?muraAction=cArch.edit&contenthistid=${CONTENT_HIST_IDS.aboutUsDraft}&contentid=${CONTENT_IDS.aboutUs}` +
      `&type=Variation&parentid=${ROOT_ID}&siteid=${SITE}&moduleid=${VARIATIONS_MODULE}&startrow=1&return=changesets`;
    const anchors = (item: string) => {
      const anchor = variations.find(`li.${item} a`);
      return { title: anchor.attr('title'), href: anchor.attr('href'), text: anchor.text() };
    };
    expect(anchors('edit')).toEqual({ title: 'Edit', href: edit, text: '' });
    expect(anchors('version-history')).toEqual({
      title: 'Version History',
      href:
        `./?muraAction=cArch.hist&contentid=${CONTENT_IDS.aboutUs}&type=Variation&parentid=${ROOT_ID}` +
        `&siteid=${SITE}&moduleid=${VARIATIONS_MODULE}&startrow=1`,
      text: '',
    });
    expect(anchors('preview')).toEqual({ title: 'View', href: '#', text: '' });
    expect(variations.find('li.preview a').attr('onclick')).toBe(
      `return preview('${REMOTE_URL}?previewid=${CONTENT_HIST_IDS.aboutUsDraft}');`,
    );
    // The nested crumb anchors make a parser restructure the cell, so its markup is compared as legacy writes it.
    const zoom = toString(renderZoom(crumbsOf(at(data.variations ?? []))));
    expect(markup).toContain(`<td class="title var-width"><a href="${edit}">${zoom}</a></td>`);
    expect(variations.find('li.delete a').attr('href')).toBe(removeHref(CONTENT_HIST_IDS.aboutUsDraft));
  });

  it('labels the status by approval status, then approval and activity', async () => {
    const { model } = await rendered(
      withSite((site) => {
        const row = at(site);
        return [
          { ...row, approvalStatus: 'pending' },
          { ...row, approvalStatus: 'rejected' },
          { ...row, approved: true, active: true },
          { ...row, approved: true, active: false },
          { ...row, approved: false, active: true },
        ];
      }),
    );

    expect(model.tables[0]?.rows.map((cells) => cells[2])).toEqual([
      'Pending Approval',
      'Rejected',
      'Published',
      'Archived',
      'Queued',
    ]);
  });

  it('renders the no-results row for an empty list', async () => {
    const { $, model } = await rendered((data) => ({ ...data, forms: [] }));

    const forms = tableAt($, 2);
    expect(forms.find('tr')).toHaveLength(2);
    const results = forms.find('td.results[colspan="3"]');
    expect(results).toHaveLength(1);
    expect(results.text()).toBe('Your search returned no results.');
    expect(model.tables[2]).toEqual({ headers: HEADERS, rows: [['Your search returned no results.']] });
  });
});

describe('renderZoom', () => {
  /** The crumbs of the fixture's `index`th row of `list`, item first. */
  async function fixtureCrumbs(list: 'site' | 'components', index = 0): Promise<readonly ChangesetAssignmentCrumb[]> {
    const data = await loadChangesetAssignments(contextFor());
    return crumbsOf(at(data[list], index));
  }

  const fragment = (crumbs: readonly ChangesetAssignmentCrumb[]): Cheerio =>
    cheerio.load(toString(renderZoom(crumbs)), null, false);

  /** Each `li` of the breadcrumb, root first. */
  const items = ($: Cheerio) =>
    $('ul.breadcrumb > li')
      .toArray()
      .map((li) => ({
        className: $(li).attr('class'),
        href: $(li).find('a').attr('href'),
        icon: $(li).find('i').attr('class'),
        text: $(li).text().trim(),
        strong: $(li).find('strong > a').length,
      }));

  it('renders root to item, the item last inside <strong>', async () => {
    const crumbs = await fixtureCrumbs('site', 1);

    expect(crumbs).toHaveLength(3);
    expect(isSafeHtml(renderZoom(crumbs))).toBe(true);
    expect(items(fragment(crumbs))).toEqual([
      { className: '', href: crumbHref(ROOT_ID), icon: 'mi-file', text: 'Home', strong: 0 },
      { className: '', href: crumbHref(CONTENT_IDS.news), icon: 'mi-folder-open-o', text: 'News', strong: 0 },
      { className: '', href: crumbHref(CONTENT_IDS.newsArticle), icon: 'mi-file', text: 'Program Update', strong: 1 },
    ]);
  });

  it('links a crumb without moduleid to the Site Manager module', async () => {
    const crumbs = await fixtureCrumbs('components');
    const { moduleid, ...withoutModule } = at(crumbs);

    expect(moduleid).toBe(COMPONENTS_MODULE);
    expect(items(fragment([withoutModule, ...crumbs.slice(1)])).map((li) => li.href)).toEqual([
      crumbHref(COMPONENTS_MODULE, COMPONENTS_MODULE),
      crumbHref(CONTENT_IDS.homeBanner, SITE_MANAGER_MODULE),
    ]);
  });

  it('HTML-encodes the menu title', async () => {
    const crumbs = await fixtureCrumbs('site');
    const markup = toString(renderZoom([{ ...at(crumbs), menutitle: 'A & <B>' }, ...crumbs.slice(1)]));

    expect(markup).toContain('<i class="mi-file"></i>A &amp; &lt;B&gt;</a></strong>');
    expect(items(cheerio.load(markup, null, false)).at(-1)?.text).toBe('A & <B>');
  });

  it('locks every crumb from a restricted parent on, not the root', async () => {
    const crumbs = await fixtureCrumbs('site', 1);
    const restrictedParent = crumbs.map((crumb, index) => (index === 1 ? { ...crumb, restricted: true } : crumb));

    expect(items(fragment(restrictedParent)).map((li) => li.className)).toEqual(['', 'locked', 'locked']);
  });
});

describe('changesetAssignmentsScreen', () => {
  it('declares the strategies-content page', () => {
    expect(changesetAssignmentsScreen).toMatchObject({
      circuit: 'cchangesets',
      action: 'assignments',
      mode: 'page',
      owner: 'strategies-content',
    });
  });

  it('renders inside the shell as the registered cchangesets entry', async () => {
    const def = cchangesetsScreens.find((screen) => screen.action === 'assignments');
    if (def === undefined) throw new Error('cchangesets.assignments is not registered');

    const page = await renderScreenPage(def, contextFor());

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const $ = cheerio.load(page.html);
    expect(page.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect($('#mura-content h1').text()).toBe('Change Set Content List');
    expect($('#mura-content h2').text()).toBe('Autumn Launch');
  });
});
