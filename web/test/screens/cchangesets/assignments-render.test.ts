// cChangesets.assignments against cchangesets/assignments.cfm and dspZoom: the owner's model, then the list markup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { encodeUrl, isSafeHtml, raw, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import {
  changesetAssignmentsScreen,
  loadChangesetAssignments,
  renderChangesetAssignments,
  renderZoom,
  type ChangesetAssignmentCrumb,
  type ChangesetAssignmentRow,
  type ChangesetAssignmentsData,
} from '@/screens/cchangesets/assignments';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { domModel, fragmentModel, normaliseAdminUrl, type DomLink, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

// The registry imports every circuit barrel; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Fields = Readonly<Record<string, unknown>>;
type RcFields = Readonly<Record<string, string>>;

const CHANGESET_ID = '7C1A2B3D-4E5F-4A6B-8C9D0E1F2A3B4C5D';
const PREVIEW_LINK = `http://localhost:8080/default/?changesetID=${CHANGESET_ID}`;
const HOME_ID = '00000000000000000000000000000000001';
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';
const COMPONENTS_MODULE_ID = '00000000000000000000000000000000003';
const FORMS_MODULE_ID = '00000000000000000000000000000000004';
const VARIATIONS_MODULE_ID = '00000000000000000000000000000000099';
const CSRF_URL = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;
const OPERATION = 'listChangesetAssignments';

const contentId = (n: number): string => `C1000000-0000-0000-00000000000000${String(n).padStart(2, '0')}`;
const histId = (n: number): string => `A1000000-0000-0000-00000000000000${String(n).padStart(2, '0')}`;
const assignmentsPath = (siteid: string): ServicePath => `/v1/sites/${siteid}/changesets/${CHANGESET_ID}/assignments`;

/** The rc the controller's `before()` leaves for the assignments view, `rc` laid over it. */
const assignmentsRc = (rc: RcFields = {}): RcFields => ({
  changesetID: CHANGESET_ID,
  startrow: '1',
  keywords: '',
  ...rc,
});

const adminOn = (rc: RcFields = {}): AdminRequest =>
  adminS2Request({ circuit: 'cChangesets', item: 'assignments', rc: assignmentsRc(rc) });

/** Clears every `MURA_` variable, then sets `vars`, so dspZoom's context and admin directory come from `vars` alone. */
function useSettings(vars: RcFields = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
  useSettings();
});

afterEach(() => {
  restore();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

// ---- Screen model, as strategies-content reports the view's values ----

/** A crumbdata entry of `contentid`; `fields` overrides any key. */
const crumbStruct = (contentid: string, menutitle: string, fields: Fields = {}): Fields => ({
  menutitle,
  siteid: 'default',
  contentid,
  moduleid: CONTENT_MODULE_ID,
  type: 'Page',
  restricted: 0,
  icon: 'mi-file',
  ...fields,
});

/** A published Site Manager page under Home with its crumbdata; `fields` overrides any column. */
const rowStruct = (n: number, fields: Fields = {}): Fields => ({
  contentHistID: histId(n),
  contentID: contentId(n),
  changesetID: CHANGESET_ID,
  type: 'Page',
  parentID: HOME_ID,
  moduleID: CONTENT_MODULE_ID,
  menuTitle: `Page ${n}`,
  approvalStatus: '',
  approved: 1,
  active: 1,
  verdict: 'editor',
  previewURL: `http://localhost:8080/default/page-${n}/?previewid=${histId(n)}`,
  crumbdata: [crumbStruct(contentId(n), `Page ${n}`), crumbStruct(HOME_ID, 'Home', { icon: 'mi-home' })],
  ...fields,
});

/** The rc of an unpublished change set with nothing assigned; `fields` overrides any member. */
const screenModel = (fields: Fields = {}, changeset: Fields = {}): Fields => ({
  changeset: { changesetID: CHANGESET_ID, name: 'Spring Launch', published: 0, closeDate: '', ...changeset },
  hasPendingApprovals: false,
  previewLink: PREVIEW_LINK,
  siteAssignments: [],
  componentAssignments: [],
  formAssignments: [],
  ...fields,
});

const viewReply = (rc: Fields): FakeReply => ({ status: 200, body: { rc } });

/** A screen context for `req` whose strategies-content answers the assignments read with `reply`. */
function contextFor(reply: FakeReply, req: AdminRequest = adminOn()) {
  const route = routeKey('GET', 'strategies-content', assignmentsPath(req.rc.siteid ?? ''));
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [route]: reply }) });
}

/** The data `screenModel(fields, changeset)` loads into. */
const loaded = (fields: Fields = {}, changeset: Fields = {}): Promise<ChangesetAssignmentsData> =>
  loadChangesetAssignments(contextFor(viewReply(screenModel(fields, changeset))));

/** The class and message `run` fails with; undefined when it succeeds. */
async function failureOf(run: () => unknown): Promise<{ type: unknown; message: string } | undefined> {
  try {
    await run();
  } catch (error) {
    const { constructor, message } = error as Error;
    return { type: constructor, message };
  }
  return undefined;
}

describe('loadChangesetAssignments', () => {
  it.each<{ name: string; req: () => AdminRequest; siteid: string }>([
    { name: 'the admin on default', req: () => adminOn({ keywords: 'spring sale' }), siteid: 'default' },
    {
      name: 'a tenant-a site admin',
      req: () =>
        siteAdminRequest('tenant-a', {
          circuit: 'cChangesets',
          item: 'assignments',
          rc: assignmentsRc({ keywords: 'spring sale' }),
        }),
      siteid: 'tenant-a',
    },
  ])('reads the filtered set for $name and prefetches its tokens', async ({ req, siteid }) => {
    const ctx = contextFor(viewReply(screenModel()), req());

    await loadChangesetAssignments(ctx);

    expect(ctx.gateway.calls).toEqual([
      {
        service: 'strategies-content',
        method: 'GET',
        path: assignmentsPath(siteid),
        query: { keywords: 'spring sale' },
      },
      { service: 'identity', method: 'POST', path: '/v1/csrf/tokens', json: { contexts: [CHANGESET_ID] } },
    ]);
    expect(toString(ctx.csrf.render(CHANGESET_ID, 'url'))).toBe(CSRF_URL);
  });

  it('maps fields case-insensitively as CFML values', async () => {
    const site = rowStruct(1, {
      contentHistID: undefined,
      CONTENTHISTID: histId(1),
      approvalStatus: null,
      approved: true,
      active: 'no',
      menuTitle: 2026,
      crumbdata: [
        crumbStruct(contentId(1), 'Page 1', { restricted: '1' }),
        {
          MenuTitle: 'Home',
          SiteID: 'default',
          ContentID: HOME_ID,
          ModuleID: null,
          Type: 'Page',
          Restricted: true,
          Icon: 'mi-home',
        },
      ],
    });
    const data = await loaded({ SITEASSIGNMENTS: [site], siteAssignments: undefined });

    expect(data.site).toHaveLength(1);
    const [row] = data.site;
    expect({ ...row, zoom: undefined }).toEqual({
      contentHistId: histId(1),
      contentId: contentId(1),
      changesetId: CHANGESET_ID,
      type: 'Page',
      parentId: HOME_ID,
      moduleId: CONTENT_MODULE_ID,
      menuTitle: '2026',
      approvalStatus: '',
      approved: true,
      active: false,
      verdict: 'editor',
      previewUrl: `http://localhost:8080/default/page-1/?previewid=${histId(1)}`,
      remoteUrl: '',
      zoom: undefined,
    });
    expect(row?.zoom).toStrictEqual([
      {
        menutitle: 'Page 1',
        siteid: 'default',
        contentid: contentId(1),
        moduleid: CONTENT_MODULE_ID,
        type: 'Page',
        restricted: true,
        icon: 'mi-file',
      },
      { menutitle: 'Home', siteid: 'default', contentid: HOME_ID, type: 'Page', restricted: true, icon: 'mi-home' },
    ]);
  });

  it('keeps rendered zoom markup as markup', async () => {
    const zoom = '<ul class="breadcrumb"><li>Footer</li></ul>';
    const data = await loaded({ componentAssignments: [rowStruct(2, { zoom, crumbdata: undefined })] });

    const markup = data.components[0]?.zoom;
    expect(isSafeHtml(markup)).toBe(true);
    expect(String(markup)).toBe(zoom);
  });

  it.each<{ name: string; fields: Fields; changeset: Fields; expected: ChangesetAssignmentsData['changeset'] }>([
    {
      name: 'rc-level pending approvals and a close date',
      fields: { hasPendingApprovals: 'yes' },
      changeset: { closeDate: '2026-10-29 00:00:00' },
      expected: {
        changesetId: CHANGESET_ID,
        name: 'Spring Launch',
        published: false,
        hasPendingApprovals: true,
        closeDate: '2026-10-29 00:00:00',
      },
    },
    {
      name: 'pending approvals on the bean',
      fields: { hasPendingApprovals: undefined },
      changeset: { hasPendingApprovals: 1 },
      expected: {
        changesetId: CHANGESET_ID,
        name: 'Spring Launch',
        published: false,
        hasPendingApprovals: true,
        closeDate: null,
      },
    },
    {
      name: 'a published set without pending approvals or preview link',
      fields: { hasPendingApprovals: undefined, previewLink: undefined },
      changeset: { published: 'true', closeDate: '2026-10-29 00:00:00' },
      expected: {
        changesetId: CHANGESET_ID,
        name: 'Spring Launch',
        published: true,
        hasPendingApprovals: false,
        closeDate: '2026-10-29 00:00:00',
      },
    },
  ])('reads $name', async ({ fields, changeset, expected }) => {
    const data = await loaded(fields, changeset);

    expect(data.changeset).toEqual(expected);
    expect(data.previewLink).toBe(expected.published ? '' : PREVIEW_LINK);
  });

  it.each<{ name: string; fields: Fields; keys: string[] }>([
    {
      name: 'leaves variations out when the model has none',
      fields: {},
      keys: ['changeset', 'previewLink', 'site', 'components', 'forms'],
    },
    {
      name: 'reads variations when the model carries them',
      fields: { variationAssignments: [rowStruct(4, { remoteURL: 'https://remote.example/page-4' })] },
      keys: ['changeset', 'previewLink', 'site', 'components', 'forms', 'variations'],
    },
  ])('$name', async ({ fields, keys }) => {
    const data = await loaded(fields);

    expect(Object.keys(data)).toEqual(keys);
    expect(data.variations?.map((row) => row.remoteUrl)).toEqual(
      keys.includes('variations') ? ['https://remote.example/page-4'] : undefined,
    );
  });

  it.each<{ name: string; fields: Fields; changeset?: Fields; message: string }>([
    { name: 'no changeset struct', fields: { changeset: 'x' }, message: `${OPERATION} returned no changeset struct` },
    { name: 'a changeset array', fields: { changeset: [] }, message: `${OPERATION} returned no changeset struct` },
    {
      name: 'no pending approvals for an unpublished set',
      fields: { hasPendingApprovals: null },
      message: `${OPERATION} returned no hasPendingApprovals`,
    },
    {
      name: 'no preview link for an unpublished set',
      fields: { previewLink: null },
      message: `${OPERATION} returned no previewLink`,
    },
    {
      name: 'no site assignments',
      fields: { siteAssignments: undefined },
      message: `${OPERATION} returned no siteAssignments`,
    },
    {
      name: 'component assignments that are not rows',
      fields: { componentAssignments: [1] },
      message: `${OPERATION} returned componentAssignments that is not rows`,
    },
    {
      name: 'form assignments that are a struct',
      fields: { formAssignments: {} },
      message: `${OPERATION} returned formAssignments that is not rows`,
    },
    {
      name: 'a row without its verdict',
      fields: { siteAssignments: [rowStruct(1, { verdict: undefined })] },
      message: `${OPERATION} returned no verdict`,
    },
    {
      name: 'a row with a complex title',
      fields: { siteAssignments: [rowStruct(1, { menuTitle: { text: 'Page 1' } })] },
      message: `${OPERATION} returned menuTitle that is not a simple value`,
    },
    {
      name: 'a row with neither zoom nor crumbdata',
      fields: { siteAssignments: [rowStruct(1, { crumbdata: undefined })] },
      message: `${OPERATION} returned a row with neither zoom nor crumbdata`,
    },
    {
      name: 'crumbdata that is not rows',
      fields: { siteAssignments: [rowStruct(1, { crumbdata: 'Home' })] },
      message: `${OPERATION} returned crumbdata that is not rows`,
    },
    {
      name: 'a published flag CFML cannot convert',
      fields: {},
      changeset: { published: 'maybe' },
      message: 'Cannot convert maybe to a boolean',
    },
  ])('throws a TypeError for $name', async ({ fields, changeset, message }) => {
    expect(await failureOf(() => loaded(fields, changeset))).toEqual({ type: TypeError, message });
  });

  it('fails before any call without rc.changesetID', async () => {
    const req = adminS2Request({ circuit: 'cChangesets', item: 'assignments', rc: { startrow: '1', keywords: '' } });
    const ctx = contextFor(viewReply(screenModel()), req);

    expect(await failureOf(() => loadChangesetAssignments(ctx))).toEqual({
      type: TypeError,
      message: 'Element CHANGESETID is undefined in RC.',
    });
    expect(ctx.gateway.calls).toEqual([]);
  });

  it.each([401, 403] as const)('throws GatewayDenialError for %i', async (status) => {
    const failure = loadChangesetAssignments(contextFor({ status }));

    await expect(failure).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(failure).rejects.toMatchObject({ service: 'strategies-content', operation: OPERATION, status });
  });

  it.each([404, 500])('throws for any other status: %i', async (status) => {
    expect(await failureOf(() => loadChangesetAssignments(contextFor({ status })))).toEqual({
      type: Error,
      message: `${OPERATION} answered HTTP ${status}`,
    });
  });

  it('propagates gateway unavailability', async () => {
    await expect(loadChangesetAssignments(contextFor({ status: 503 }))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

// ---- View data ----

/** A Site Manager crumb on `default`; `fields` overrides any member. */
const crumb = (
  contentid: string,
  menutitle: string,
  fields: Partial<ChangesetAssignmentCrumb> = {},
): ChangesetAssignmentCrumb => ({
  menutitle,
  siteid: 'default',
  contentid,
  type: 'Page',
  restricted: false,
  icon: 'mi-file',
  ...fields,
});

const HOME = crumb(HOME_ID, 'Home', { icon: 'mi-home' });

/** A published, editable assignment of module `moduleId` under `parentId`; `fields` overrides any member. */
const row = (
  n: number,
  moduleId: string,
  parentId: string,
  fields: Partial<ChangesetAssignmentRow> = {},
): ChangesetAssignmentRow => ({
  contentHistId: histId(n),
  contentId: contentId(n),
  changesetId: CHANGESET_ID,
  type: 'Page',
  parentId,
  moduleId,
  menuTitle: `Item ${n}`,
  approvalStatus: '',
  approved: true,
  active: true,
  verdict: 'editor',
  previewUrl: `http://localhost:8080/default/item-${n}/?previewid=${histId(n)}`,
  remoteUrl: '',
  zoom: [crumb(contentId(n), `Item ${n}`, { moduleid: moduleId }), HOME],
  ...fields,
});

const DATA: ChangesetAssignmentsData = {
  changeset: {
    changesetId: CHANGESET_ID,
    name: 'Spring Launch',
    published: false,
    hasPendingApprovals: false,
    closeDate: null,
  },
  previewLink: PREVIEW_LINK,
  site: [],
  components: [],
  forms: [],
};

/** `DATA` with `changeset` laid over its change set and `fields` over the rest. */
const dataWith = (
  fields: Partial<ChangesetAssignmentsData> = {},
  changeset: Partial<ChangesetAssignmentsData['changeset']> = {},
): ChangesetAssignmentsData => ({ ...DATA, ...fields, changeset: { ...DATA.changeset, ...changeset } });

/** The view body for `data` in `req`, after the token prefetch `load` makes, with its DOM model. */
async function rendered(
  data: ChangesetAssignmentsData,
  req: AdminRequest = adminOn(),
): Promise<{ markup: string; model: DomModel }> {
  const ctx = makeScreenContext({ req });
  await ctx.csrf.prefetch([CHANGESET_ID]);
  const markup = toString((await renderChangesetAssignments(ctx, data)).body);
  return { markup, model: domModel(markup) };
}

const link = (href: string, text = ''): DomLink => ({ href: normaliseAdminUrl(href), text });

/** The links of each row's `td.actions` cell in `markup`, in row order. */
const actionLinks = (markup: string): DomLink[][] =>
  [...markup.matchAll(/<td class="actions">[\s\S]*?<\/td>/g)].map(([cell]) => fragmentModel(cell).links);

/** The `cArch.list` URL dspZoom gives a crumb under `prefix`, the default settings' admin directory unless given. */
const crumbHref = (siteid: string, contentid: string, moduleid = CONTENT_MODULE_ID, prefix = '/admin'): string =>
  `${prefix}/?muraAction=cArch.list&siteid=${siteid}&topid=${contentid}&moduleid=${moduleid}&activeTab=0`;

const SHOW_ACTIONS: DomLink = { href: 'javascript:;', text: '' };
const PAGE_LINKS: readonly DomLink[] = [
  link('./?muraAction=cChangesets.list&siteid=default', 'Back to Change Sets'),
  link(`./?muraAction=cChangesets.edit&siteid=default&changesetID=${CHANGESET_ID}`, 'View Edit Form'),
  link('#', 'Preview Change Set'),
  link(PREVIEW_LINK, PREVIEW_LINK),
];
const SECTIONS = ['Site Architecture', 'Components', 'Forms'];
const NO_RESULTS = { headers: ['', 'Title', 'Status'], rows: [['Your search returned no results.']] };

const removeHref = (contentHistId: string): string =>
  `./?muraAction=cChangesets.removeItem&contentHistId=${contentHistId}&siteid=default&changesetID=${CHANGESET_ID}` +
  `&keywords=${CSRF_URL}`;

const deleteLink = (r: ChangesetAssignmentRow): DomLink => link(removeHref(r.contentHistId), 'Delete');

/** The component, form and variation `editlink`. */
const editHref = (r: ChangesetAssignmentRow): string =>
  `./?muraAction=cArch.edit&contenthistid=${r.contentHistId}&contentid=${r.contentId}&type=${r.type}` +
  `&parentid=${r.parentId}&siteid=default&moduleid=${r.moduleId}&startrow=1&return=changesets`;

const histHref = (r: ChangesetAssignmentRow, beforeSiteid: string): string =>
  `./?muraAction=cArch.hist&contentid=${r.contentId}&type=${r.type}&parentid=${r.parentId}` +
  `${beforeSiteid}siteid=default&moduleid=${r.moduleId}&startrow=1`;

const SITE_ROW = row(1, CONTENT_MODULE_ID, HOME_ID);
const COMPONENT_ROW = row(2, COMPONENTS_MODULE_ID, COMPONENTS_MODULE_ID, { type: 'Component' });
const FORM_ROW = row(3, FORMS_MODULE_ID, FORMS_MODULE_ID, { type: 'Form' });
const VARIATION_ROW = row(4, VARIATIONS_MODULE_ID, VARIATIONS_MODULE_ID, {
  type: 'Variation',
  remoteUrl: 'https://remote.example/page-4',
});

describe('renderChangesetAssignments', () => {
  it('renders the header, preview, filter and empty tables', async () => {
    const { markup, model } = await rendered(DATA, adminOn({ keywords: 'spring "sale"' }));

    expect(model.headings).toEqual(['Change Set Content List', 'Spring Launch', ...SECTIONS]);
    expect(model.labels).toEqual([]);
    expect(model.alerts).toEqual([]);
    expect(model.links).toEqual(PAGE_LINKS);
    expect(markup).toContain(
      '<form class="form-inline separate" novalidate="novalidate" id="assignmentSearch" name="assignmentSearch" ' +
        'method="get">',
    );
    expect(model.controls.map(({ name, type, value }) => ({ name, type, value }))).toEqual([
      { name: 'keywords', type: 'text', value: 'spring "sale"' },
      { name: 'muraAction', type: 'hidden', value: 'cChangesets.assignments' },
      { name: 'siteid', type: 'hidden', value: 'default' },
      { name: 'changesetID', type: 'hidden', value: CHANGESET_ID },
    ]);
    expect(model.buttons).toEqual([{ text: 'Filter View', type: 'button', hasOnclick: true }]);
    expect(model.tables).toEqual([NO_RESULTS, NO_RESULTS, NO_RESULTS]);
  });

  it.each<{ name: string; variations?: readonly ChangesetAssignmentRow[]; sections: string[] }>([
    { name: 'without variations', sections: SECTIONS },
    { name: 'with variations on', variations: [], sections: [...SECTIONS, 'Remote Variations'] },
  ])('lists the module sections $name', async ({ variations, sections }) => {
    const { model } = await rendered(dataWith(variations === undefined ? {} : { variations }));

    expect(model.headings.slice(2)).toEqual(sections);
    expect(model.tables).toEqual(sections.map(() => NO_RESULTS));
  });

  it.each<{ name: string; changeset: Partial<ChangesetAssignmentsData['changeset']>; alerts: DomModel['alerts'] }>([
    { name: 'nothing for an unpublished set', changeset: {}, alerts: [] },
    {
      name: 'the published notice alone',
      changeset: { published: true, closeDate: '2026-10-29 00:00:00' },
      alerts: [{ text: 'This change set has been published.', className: 'alert alert-info' }],
    },
    {
      name: 'pending approvals and the masked close date',
      changeset: { hasPendingApprovals: true, closeDate: '2026-10-29 00:00:00' },
      alerts: [
        { text: 'This change set contains content that has not been approved.', className: 'alert alert-error' },
        { text: 'This change set has a close date of 10/302/2026.', className: 'alert alert-info' },
      ],
    },
    { name: 'nothing for a close date that is not a date', changeset: { closeDate: 'soon' }, alerts: [] },
  ])('alerts $name', async ({ changeset, alerts }) => {
    const { model } = await rendered(dataWith({}, changeset));

    expect(model.alerts).toEqual(alerts);
  });

  it('leaves out both preview links of a published set', async () => {
    const { model } = await rendered(dataWith({ previewLink: '' }, { published: true }));

    expect(model.links).toEqual(PAGE_LINKS.slice(0, 2));
  });

  it.each<{ name: string; data: Partial<ChangesetAssignmentsData>; table: number; actions: DomLink[] }>([
    {
      name: 'a site architecture row',
      data: { site: [SITE_ROW] },
      table: 0,
      actions: [
        link(
          `./?muraAction=cArch.edit&contenthistid=${histId(1)}&contentid=${contentId(1)}&type=Page` +
            `&parentid=${HOME_ID}&topid=${contentId(1)}&siteid=default&moduleid=${CONTENT_MODULE_ID}` +
            '&startrow=1&return=changesets',
          'Edit',
        ),
        link('#', 'Preview'),
        link(
          `./?muraAction=cArch.hist&contentid=${contentId(1)}&type=Page&parentid=${HOME_ID}&topid=${contentId(1)}` +
            `&siteid=default&moduleid=${CONTENT_MODULE_ID}&startrow=1`,
          'Version History',
        ),
        deleteLink(SITE_ROW),
      ],
    },
    {
      name: 'a component row',
      data: { components: [COMPONENT_ROW] },
      table: 1,
      actions: [
        link(editHref(COMPONENT_ROW), 'Edit'),
        link(histHref(COMPONENT_ROW, '&&'), 'Version History'),
        deleteLink(COMPONENT_ROW),
      ],
    },
    {
      name: 'a form row',
      data: { forms: [FORM_ROW] },
      table: 2,
      actions: [
        link(editHref(FORM_ROW), 'Edit'),
        link(histHref(FORM_ROW, '&'), 'Version History'),
        deleteLink(FORM_ROW),
      ],
    },
    {
      name: 'a variation row',
      data: { variations: [VARIATION_ROW] },
      table: 3,
      actions: [
        link(editHref(VARIATION_ROW)),
        link(histHref(VARIATION_ROW, '&')),
        link('#'),
        deleteLink(VARIATION_ROW),
      ],
    },
  ])('links the actions of $name with a node permission', async ({ data, table, actions }) => {
    const { markup, model } = await rendered(dataWith(data));

    expect(actionLinks(markup)).toEqual([[SHOW_ACTIONS, ...actions]]);
    expect(model.tables[table]?.rows).toHaveLength(1);
  });

  it.each<{ name: string; data: Partial<ChangesetAssignmentsData>; table: number; actions: DomLink[]; cell: string }>([
    {
      name: 'a site row keeps preview and a disabled "Preview" item',
      data: { site: [{ ...SITE_ROW, verdict: 'none' }] },
      table: 0,
      actions: [link('#'), deleteLink(SITE_ROW)],
      cell: 'Preview Delete',
    },
    {
      name: 'a component row keeps only the delete',
      data: { components: [{ ...COMPONENT_ROW, verdict: 'NONE' }] },
      table: 1,
      actions: [deleteLink(COMPONENT_ROW)],
      cell: 'Delete',
    },
    {
      name: 'a form row keeps only the delete',
      data: { forms: [{ ...FORM_ROW, verdict: 'none' }] },
      table: 2,
      actions: [deleteLink(FORM_ROW)],
      cell: 'Delete',
    },
  ])('without a node permission, $name', async ({ data, table, actions, cell }) => {
    const { markup, model } = await rendered(dataWith(data));

    expect(actionLinks(markup)).toEqual([[SHOW_ACTIONS, ...actions]]);
    expect(model.tables[table]?.rows[0]?.[0]).toBe(cell);
  });

  it('fails on a variation row without a node permission', async () => {
    const ctx = makeScreenContext({ req: adminOn() });
    await ctx.csrf.prefetch([CHANGESET_ID]);

    const data = dataWith({ variations: [{ ...VARIATION_ROW, verdict: 'none' }] });

    expect(await failureOf(() => renderChangesetAssignments(ctx, data))).toEqual({
      type: TypeError,
      message: 'Element RSTOP is undefined in RC.',
    });
  });

  it('writes the action URLs, scripts and title cells as legacy does', async () => {
    const zoom = raw('<ul class="breadcrumb"><li>Footer</li></ul>');
    const component = { ...COMPONENT_ROW, zoom };
    const { markup, model } = await rendered(
      dataWith({ site: [SITE_ROW], components: [component], forms: [FORM_ROW], variations: [VARIATION_ROW] }),
    );

    expect(markup).toContain(
      `<a href="#" onclick="return preview('${SITE_ROW.previewUrl}');"><i class="mi-globe"></i>Preview</a>`,
    );
    expect(markup).toContain(`parentid=${COMPONENTS_MODULE_ID}&&siteid=default&moduleid=${COMPONENTS_MODULE_ID}`);
    expect(markup).toContain(`<td class="title var-width">${toString(zoom)}</td>`);
    expect(markup).toContain(
      `<td class="title var-width"><a href="${editHref(VARIATION_ROW)}"><ul class="breadcrumb">`,
    );
    expect(markup).toContain(
      `<a title="View" href="#" onclick="return preview('https://remote.example/page-4?previewid=${histId(4)}');">`,
    );
    expect(markup).toContain(
      `onclick="return confirmDialog('Remove\\x20item\\x20from\\x20change\\x20set\\x3F',this.href)">` +
        '<i class="mi-trash"></i>Delete</a>',
    );
    expect(model.tables.map((t) => t.rows.map((cells) => cells[1]))).toEqual([
      ['Home Item 1'],
      ['Footer'],
      ['Home Item 3'],
      ['Home Item 4'],
    ]);
    expect(model.links.filter((l) => l.text === 'Item 1')).toEqual([
      link(crumbHref('default', contentId(1)), 'Item 1'),
    ]);
  });

  it('encodes site, start row and keywords as legacy does', async () => {
    const req = adminOn({ siteid: 'a b', startrow: '2/3', keywords: 'R&D <x>' });
    const { markup, model } = await rendered(dataWith({ forms: [FORM_ROW] }), req);

    expect(markup).toContain(
      `./?muraAction=cChangesets.removeItem&contentHistId=${histId(3)}&siteid=a+b` +
        `&changesetID=${encodeUrl(CHANGESET_ID)}&keywords=R&amp;D &lt;x&gt;${CSRF_URL}"`,
    );
    expect(markup).toContain(`&siteid=a+b&moduleid=${FORMS_MODULE_ID}&startrow=2%2F3&return=changesets"`);
    expect(model.controls.slice(0, 3).map((c) => c.value)).toEqual(['R&D <x>', 'cChangesets.assignments', 'a b']);
  });

  it.each<{ status: string; fields: Partial<ChangesetAssignmentRow> }>([
    { status: 'Pending Approval', fields: { approvalStatus: 'Pending' } },
    { status: 'Rejected', fields: { approvalStatus: 'Rejected', approved: false } },
    { status: 'Published', fields: {} },
    { status: 'Archived', fields: { active: false } },
    { status: 'Queued', fields: { approved: false } },
  ])('labels the status $status', async ({ status, fields }) => {
    const { model } = await rendered(dataWith({ site: [{ ...SITE_ROW, ...fields }] }));

    expect(model.tables[0]?.rows[0]?.[2]).toBe(status);
  });

  it('renders what it loaded, using the tokens load prefetched', async () => {
    const component = rowStruct(2, {
      type: 'Component',
      moduleID: COMPONENTS_MODULE_ID,
      approvalStatus: 'Rejected',
      verdict: 'none',
    });
    const ctx = contextFor(
      viewReply(screenModel({ siteAssignments: [rowStruct(1)], componentAssignments: [component] })),
    );

    const { body } = await renderChangesetAssignments(ctx, await loadChangesetAssignments(ctx));

    const markup = toString(body);
    expect(domModel(markup).tables).toEqual([
      { headers: ['', 'Title', 'Status'], rows: [['Edit Preview Version History Delete', 'Home Page 1', 'Published']] },
      { headers: ['', 'Title', 'Status'], rows: [['Delete', 'Home Page 2', 'Rejected']] },
      NO_RESULTS,
    ]);
    expect(actionLinks(markup).map((links) => links.at(-1))).toEqual([
      link(removeHref(histId(1)), 'Delete'),
      link(removeHref(histId(2)), 'Delete'),
    ]);
  });
});

describe('renderZoom', () => {
  /** The `<li …>` opening tags of a breadcrumb, root first. */
  const itemTags = (markup: string): string[] => markup.match(/<li [^>]*>/g) ?? [];

  it.each<{ name: string; crumbs: readonly ChangesetAssignmentCrumb[]; bytes: string }>([
    {
      // As the ACF 2023 oracle serves it in cArch.hist of Home on `default`.
      name: 'the lone item crumb',
      crumbs: [crumb(HOME_ID, 'Home')],
      bytes:
        '<ul class="breadcrumb">\n\t\t\n\t\t<li class=""><strong>\n\t\t<a \n\t\t\thref="' +
        crumbHref('default', HOME_ID) +
        '"\n\t\t><i class="mi-file"></i>Home</a></strong></li>\n\t\t</ul>',
    },
    {
      name: 'root to item with an HTMLEditFormat-ed title',
      crumbs: [crumb(contentId(1), 'R&D\r\n<"Team">', { moduleid: COMPONENTS_MODULE_ID, icon: 'mi-cube' }), HOME],
      bytes: [
        '<ul class="breadcrumb">\n\t\t',
        '\n\t\t\t<li class="">\n\t\t\t<a \n\t\t\t\thref="',
        crumbHref('default', HOME_ID),
        '"\n\t\t\t><i class="mi-home"></i>Home</a></li>\n\t\t',
        '\n\t\t<li class=""><strong>\n\t\t<a \n\t\t\thref="',
        crumbHref('default', contentId(1), COMPONENTS_MODULE_ID),
        '"\n\t\t><i class="mi-cube"></i>R&amp;D\n&lt;&quot;Team&quot;&gt;</a></strong></li>\n\t\t</ul>',
      ].join(''),
    },
  ])('renders $name byte for byte, the item in <strong>', ({ crumbs, bytes }) => {
    const markup = renderZoom(crumbs);

    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(bytes);
  });

  it.each<{ name: string; settings: RcFields; prefix: string }>([
    { name: 'the default admin directory', settings: {}, prefix: '/admin' },
    {
      name: 'the configured context and admin directory',
      settings: { MURA_CONTEXT: '/cms', MURA_ADMINDIR: 'manage' },
      prefix: '/cms/manage',
    },
  ])('links under $name', ({ settings, prefix }) => {
    useSettings(settings);

    expect(fragmentModel(toString(renderZoom([HOME]))).links).toEqual([
      link(crumbHref('default', HOME_ID, CONTENT_MODULE_ID, prefix), 'Home'),
    ]);
  });

  it.each<{ name: string; restrictedItemFirst: boolean[]; classesRootFirst: string[] }>([
    {
      name: 'keeps the lock on every crumb after a restricted ancestor',
      restrictedItemFirst: [false, false, true, false],
      classesRootFirst: ['', 'locked', 'locked', 'locked'],
    },
    {
      name: 'locks the item below a restricted root',
      restrictedItemFirst: [false, true],
      classesRootFirst: ['locked', 'locked'],
    },
    {
      name: 'does not lock a restricted item itself',
      restrictedItemFirst: [true, false, false],
      classesRootFirst: ['', '', ''],
    },
    {
      name: 'locks nothing without a restricted crumb',
      restrictedItemFirst: [false, false],
      classesRootFirst: ['', ''],
    },
  ])('$name', ({ restrictedItemFirst, classesRootFirst }) => {
    const crumbs = restrictedItemFirst.map((restricted, i) => crumb(contentId(i), `Crumb ${i}`, { restricted }));

    expect(itemTags(toString(renderZoom(crumbs))).map((tag) => /class="([^"]*)"/.exec(tag)?.[1])).toEqual(
      classesRootFirst,
    );
  });

  it.each<{ name: string; fields: Partial<ChangesetAssignmentCrumb>; tag: string }>([
    { name: 'a file icon', fields: { type: 'File', icon: 'pdf' }, tag: '<li class=" file" data-filetype="pdf">' },
    {
      name: 'the first four icon characters',
      fields: { type: 'file', icon: 'jpeg2000' },
      tag: '<li class=" file" data-filetype="jpeg">',
    },
    { name: 'an empty icon', fields: { type: 'File', icon: '' }, tag: '<li class=" file" data-filetype="">' },
    { name: 'an mi- icon as no file', fields: { type: 'File', icon: 'MI-file-pdf' }, tag: '<li class="">' },
    { name: 'a page with a file icon as no file', fields: { type: 'Page', icon: 'pdf' }, tag: '<li class="">' },
  ])('tags $name on an ancestor and on the item', ({ fields, tag }) => {
    const file = crumb(contentId(1), 'Report', fields);

    expect(itemTags(toString(renderZoom([file, file, HOME])))).toEqual(['<li class="">', tag, tag]);
  });

  it('throws a RangeError without the item crumb', async () => {
    expect(await failureOf(() => renderZoom([]))).toEqual({
      type: RangeError,
      message: 'dspZoom needs at least the item crumb',
    });
  });
});

describe('changesetAssignmentsScreen', () => {
  it('declares the strategies-content page with the change-set menu', () => {
    expect(changesetAssignmentsScreen).toEqual({
      circuit: 'cchangesets',
      action: 'assignments',
      mode: 'page',
      owner: 'strategies-content',
      secondaryMenu: 'cchangesets',
      load: loadChangesetAssignments,
      render: renderChangesetAssignments,
    });
    expect(Object.isFrozen(changesetAssignmentsScreen)).toBe(true);
  });
});
