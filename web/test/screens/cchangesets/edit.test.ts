// cChangesets.edit over the tenant-a strategies-content fixtures, against cchangesets/edit.cfm and cf_datetimeselector.
import * as cheerio from 'cheerio';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateField } from '@/lib/dates';
import type { ServicePath } from '@/lib/gateway-client';
import { toString, type SafeHtml } from '@/lib/html';
import { cchangesetsScreens } from '@/screens/cchangesets';
import type { ChangesetCategoryNode } from '@/screens/cchangesets/dsp_categories_nest';
import {
  changesetEditScreen,
  loadChangesetEdit,
  renderChangesetEditView,
  renderDateTimeSelector,
  renderDisplayErrors,
  type ChangesetEditData,
  type DateTimeSelectorSession,
} from '@/screens/cchangesets/edit';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { domModel, fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { CATEGORY_IDS, INTEREST_CATEGORY_IDS } from '../../fixtures/strategies-content/categories';
import {
  CCHANGESETS_PATHS,
  CHANGESET_IDS,
  cchangesetsEditNew,
  cchangesetsEditOpen,
  cchangesetsEditPublished,
  cchangesetsEditScheduled,
} from '../../fixtures/strategies-content/changesets';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

// An empty rc.changesetID reads a fresh CF UUID; the spy pins it to the new-bean fixture's id.
vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

type Fields = Readonly<Record<string, unknown>>;
type ViewModel = typeof cchangesetsEditOpen;

const SITE = 'tenant-a';
const URL_CSRF = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;
const FORM_FIELDS = ['changesetID', 'action', 'csrf_token', 'csrf_token_expires'];
const DELETE_CONFIRM = 'Delete\\x20Change\\x20Set\\x3F';
const PUBLISH_CONFIRM = 'Publish\\x20Changeset\\x20Now\\x3F';
const ROLLBACK_CONFIRM = 'Roll\\x20Back\\x20Change\\x20Set\\x3F';

// The edit read is the contract's getChangeset path, as the loader calls it; no /cchangesets/edit path exists.
/** The read path of rc `changesetid`; an empty id reads the pinned new-bean id. */
const readPath = (changesetid: string): ServicePath =>
  changesetid === '' ? `/v1/sites/${SITE}/changesets/${CHANGESET_IDS.newSet}` : `/v1/sites/${SITE}/changesets/${changesetid}`;

const ok = (body: unknown): FakeReply => ({ status: 200, body });

/** `fixture` with `rc` members, then `bean` members of its change set, laid over it. */
const variant = (fixture: ViewModel, rc: Fields = {}, bean: Fields = {}): ViewModel => ({
  rc: { ...fixture.rc, ...rc, changeset: { ...(fixture.rc.changeset as Fields), ...bean } },
});

// The request's `action` is derived from circuit and item, which the preset takes instead.
const editRequest = (changesetid: string) =>
  adminS2Request({ circuit: 'cChangesets', item: 'edit', rc: { siteid: SITE, changesetid } });

/** A context whose strategies-content answers the read of rc `changesetid` with `model`. */
const contextFor = (changesetid: string, model: ViewModel) =>
  makeScreenContext({
    req: editRequest(changesetid),
    gateway: fakeGatewayClient({ [routeKey('GET', 'strategies-content', readPath(changesetid))]: ok(model) }),
  });

/** The context and edit data `model` loads into for rc `changesetid`. */
async function loaded(
  changesetid: string,
  model: ViewModel,
): Promise<{ ctx: ReturnType<typeof contextFor>; data: ChangesetEditData }> {
  const ctx = contextFor(changesetid, model);
  if (changesetid === '') vi.mocked(cfUuid).mockReturnValueOnce(CHANGESET_IDS.newSet);
  const data = await loadChangesetEdit(ctx);
  return { ctx, data };
}

const $of = (markup: string): cheerio.CheerioAPI => cheerio.load(markup, null, false);

/** The edit view of `model` for rc `changesetid`. */
async function rendered(changesetid: string, model: ViewModel) {
  const { ctx, data } = await loaded(changesetid, model);
  const markup = toString(renderChangesetEditView(ctx, data));
  return { ctx, data, markup, $: $of(markup) };
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const tabs = ($: cheerio.CheerioAPI): string[][] =>
  $('ul.mura-tabs.nav-tabs[data-toggle="tabs"] > li')
    .toArray()
    .map((li) => {
      const a = $(li).children('a');
      return [$(li).attr('class') ?? '', a.attr('href') ?? '', a.attr('onclick') ?? '', a.children('span').text()];
    });

const buttons = ($: cheerio.CheerioAPI): string[][] =>
  $('.form-actions button')
    .toArray()
    .map((b) => [$(b).text().trim(), $(b).attr('onclick') ?? '']);

const confirmCall = (label: string, action: string, id: string): string =>
  `confirmDialog('${label}','./?muraAction=cChangesets.${action}&changesetID=${id}&siteid=${SITE}${URL_CSRF}')`;

const alerts = ($: cheerio.CheerioAPI): string[][] =>
  $('.alert')
    .toArray()
    .map((a) => [$(a).attr('class') ?? '', $(a).text()]);

const menu = ($: cheerio.CheerioAPI): string[][] =>
  $('.mura-header .nav-module-specific a')
    .toArray()
    .map((a) => [$(a).text().trim(), $(a).attr('href') ?? '']);

/** The form's own hidden fields, as name and value, in document order. */
const formFields = (markup: string): string[][] =>
  fragmentModel(markup)
    .controls.filter((c) => c.type === 'hidden' && FORM_FIELDS.includes(c.name))
    .map((c) => [c.name, c.value]);

const selected = ($: cheerio.CheerioAPI, id: string): string[] =>
  $(`#${id} option[selected]`)
    .toArray()
    .map((o) => $(o).attr('value') ?? '');

/** Category names of `nodes`, each followed by its children's. */
const treeNames = (nodes: readonly ChangesetCategoryNode[]): unknown[] =>
  nodes.map((node) => (node.children.length === 0 ? node.name : [node.name, treeNames(node.children)]));

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('loadChangesetEdit', () => {
  it.each<[string, string, ViewModel, ServicePath, Fields]>([
    [
      'open',
      CHANGESET_IDS.open,
      cchangesetsEditOpen,
      CCHANGESETS_PATHS.editOpen,
      {
        changesetId: CHANGESET_IDS.open,
        siteId: SITE,
        name: 'Summer Refresh',
        closeDate: null,
        publishDate: null,
        lastUpdate: new Date(2026, 5, 29, 16, 20),
        published: false,
        isNew: false,
        tags: 'refresh,summer',
        categoryId: CATEGORY_IDS.topicsNews,
      },
    ],
    [
      'scheduled',
      CHANGESET_IDS.scheduled,
      cchangesetsEditScheduled,
      CCHANGESETS_PATHS.editScheduled,
      {
        changesetId: CHANGESET_IDS.scheduled,
        name: 'Autumn Launch',
        publishDate: new Date(2026, 6, 15, 9, 0),
        published: false,
        categoryId: `${CATEGORY_IDS.topicsEvents},${CATEGORY_IDS.topicsEventsLocal}`,
      },
    ],
    [
      'published',
      CHANGESET_IDS.published,
      cchangesetsEditPublished,
      CCHANGESETS_PATHS.editPublished,
      { changesetId: CHANGESET_IDS.published, published: true, lastUpdate: new Date(2026, 5, 28, 14, 30), tags: 'cleanup' },
    ],
    ['new', '', cchangesetsEditNew, readPath(''), { changesetId: CHANGESET_IDS.newSet, siteId: '', isNew: true }],
  ])('reads the %s change set and issues its CSRF context', async (_case, changesetid, fixture, path, changeset) => {
    const { ctx, data } = await loaded(changesetid, fixture);

    expect(ctx.gateway.calls.map(({ service, method, path: called }) => [service, method, called])).toEqual([
      ['strategies-content', 'GET', path],
      ['identity', 'POST', '/v1/csrf/tokens'],
    ]);
    expect(ctx.gateway.calls[1]?.json).toEqual({ contexts: [data.changeset.changesetId] });
    expect(data.changeset).toMatchObject({ hasPendingApprovals: false, errors: [], ...changeset });
    expect(data.categoryCount).toBe(10);
    expect(treeNames(data.categories)).toEqual([
      ['General Topics', ['Agency News', ['Events', ['Local Events']]]],
      ['Interests', ['Newsletter', 'Outreach Volunteering', 'Skills Training']],
      'Legacy Archive',
      'Restricted Notices',
    ]);
    expect(data.previewLink).toBe((fixture.rc as Fields).previewLink);
    expect(ctx.req.rc.changesetID).toBe(changesetid);
  });
});

describe('renderChangesetEditView', () => {
  it('renders an open change set with Delete, Update and Publish Now', async () => {
    const { markup, $ } = await rendered(CHANGESET_IDS.open, cchangesetsEditOpen);

    expect($('.mura-header h1').text()).toBe('Edit Change Set');
    expect($('.mura-header h1').next().is('div.nav-module-specific')).toBe(true);
    expect(alerts($)).toEqual([]);
    expect(tabs($)).toEqual([
      ['active', '#tabBasic', 'return false;', 'Basic'],
      ['', '#tabCategorization', 'return false;', 'Categories'],
      ['', '#tabTags', 'return false;', 'Tags'],
    ]);
    expect($('form').attr()).toEqual({
      novalidate: 'novalidate',
      action: `./?muraAction=cChangesets.save&siteid=${SITE}`,
      method: 'post',
      name: 'form1',
      onsubmit: 'return validate(this);',
    });
    expect($('#tabBasic').attr('class')).toBe('tab-pane active');
    expect($('#tabBasic input[name="name"]').attr()).toEqual({
      name: 'name',
      type: 'text',
      required: 'true',
      message: "The 'Title' field is required.",
      value: 'Summer Refresh',
      maxlength: '50',
    });
    expect($('#tabBasic textarea[name="description"]').attr('rows')).toBe('6');
    expect(fragmentModel(markup).labels).toEqual([
      'Name',
      'Description',
      'Close Date',
      'Publish Date',
      'Category Assignments',
      'Tags',
    ]);
    expect(buttons($)).toEqual([
      ['Delete', confirmCall(DELETE_CONFIRM, 'delete', CHANGESET_IDS.open)],
      ['Update', "submitForm(document.forms.form1,'update');"],
      ['Publish Now', confirmCall(PUBLISH_CONFIRM, 'publish', CHANGESET_IDS.open)],
    ]);
    expect(formFields(markup)).toEqual([
      ['changesetID', CHANGESET_IDS.open],
      ['action', ''],
      ['csrf_token', FIXED_CSRF.token],
      ['csrf_token_expires', FIXED_CSRF.expires],
    ]);
    expect(menu($).map(([text]) => text)).toEqual([
      'Back to Change Sets',
      'View Content Assignments List',
      'Preview Change Set',
    ]);
  });

  it('defaults the empty close date to 11:59 PM and leaves the publish date blank', async () => {
    const { $ } = await rendered(CHANGESET_IDS.open, cchangesetsEditOpen);

    expect($('#mura-datepicker-closeDate').val()).toBe('');
    expect($('#mura-closeDate').val()).toBe('');
    expect([selected($, 'mura-closeDateHour'), selected($, 'mura-closeDateMinute'), selected($, 'mura-closeDateDayPart')]).toEqual([
      ['11'],
      ['59'],
      ['PM'],
    ]);
    expect($('#mura-closeDateMinute option[selected]').text()).toBe('59');
    expect($('#mura-datepicker-publishDate').val()).toBe('');
    expect($('#mura-publishDate').val()).toBe('');
    expect([selected($, 'mura-publishDateHour'), selected($, 'mura-publishDateMinute'), selected($, 'mura-publishDateDayPart')]).toEqual([
      ['12'],
      ['0'],
      [],
    ]);
  });

  it('writes the scheduled publish date in the session mask with its time', async () => {
    const { ctx, $ } = await rendered(CHANGESET_IDS.scheduled, cchangesetsEditScheduled);
    const raw = (cchangesetsEditScheduled.rc.changeset as Fields).publishDate as string;

    expect($('#mura-datepicker-publishDate').val()).toBe('07/196/2026');
    expect($('#mura-datepicker-publishDate').val()).toBe(formatDateField(raw, ctx.req.session.dateKeyFormat, ctx.now));
    expect([selected($, 'mura-publishDateHour'), selected($, 'mura-publishDateMinute'), selected($, 'mura-publishDateDayPart')]).toEqual([
      ['9'],
      ['0'],
      [],
    ]);
    expect($('#mura-publishDate').attr()).toEqual({
      type: 'hidden',
      id: 'mura-publishDate',
      name: 'publishDate',
      value: "{ts '2026-07-15 09:00:00'}",
      'data-required': 'false',
    });
  });

  it('reproduces the day-of-year mask on a PM close date', async () => {
    const { $ } = await rendered(
      CHANGESET_IDS.scheduled,
      variant(cchangesetsEditScheduled, {}, { closeDate: '2026-10-29T17:30:00.000' }),
    );

    expect($('#mura-datepicker-closeDate').val()).toBe('10/302/2026');
    expect($('#mura-closeDate').val()).toBe("{ts '2026-10-29 17:30:00'}");
    expect([selected($, 'mura-closeDateHour'), selected($, 'mura-closeDateMinute'), selected($, 'mura-closeDateDayPart')]).toEqual([
      ['5'],
      ['30'],
      ['PM'],
    ]);
  });

  it('clears a close date more than 50 years ahead but keeps its time', async () => {
    const { $ } = await rendered(CHANGESET_IDS.open, variant(cchangesetsEditOpen, {}, { closeDate: '2099-12-31T08:45:00.000' }));

    expect($('#mura-datepicker-closeDate').val()).toBe('');
    expect($('#mura-closeDate').val()).toBe('');
    expect([selected($, 'mura-closeDateHour'), selected($, 'mura-closeDateMinute'), selected($, 'mura-closeDateDayPart')]).toEqual([
      ['8'],
      ['45'],
      [],
    ]);
  });

  it.each<[string, Fields, string]>([
    ['no close date, under the last update', {}, '06/179/2026 2:30:00 PM'],
    ['a close date', { closeDate: '2026-10-29T17:30:00.000' }, '10/302/2026 5:30:00 PM'],
  ])('prints a published change set with %s, offering Roll Back', async (_case, bean, closeText) => {
    const { $ } = await rendered(CHANGESET_IDS.published, variant(cchangesetsEditPublished, {}, bean));
    const groups = $('#tabBasic .mura-control-group')
      .toArray()
      .map((group) => squash($(group).text()));

    expect(alerts($)).toEqual([['alert alert-info', 'This change set has been published.']]);
    expect(groups.slice(2)).toEqual([`Close Date ${closeText}`, 'Publish Date 06/179/2026 2:30:00 PM']);
    expect($('[id^="mura-datepicker-"]')).toHaveLength(0);
    expect($('select')).toHaveLength(0);
    expect(buttons($)).toEqual([
      ['Delete', confirmCall(DELETE_CONFIRM, 'delete', CHANGESET_IDS.published)],
      ['Update', "submitForm(document.forms.form1,'update');"],
      ['Roll Back', confirmCall(ROLLBACK_CONFIRM, 'rollback', CHANGESET_IDS.published)],
    ]);
    expect(menu($).map(([text]) => text)).toEqual(['Back to Change Sets', 'View Content Assignments List']);
  });

  it('renders Add for an empty rc.changesetID', async () => {
    const { markup, $ } = await rendered('', cchangesetsEditNew);

    expect($('.mura-header h1').text()).toBe('Add Change Set');
    expect(buttons($)).toEqual([['Add', "submitForm(document.forms.form1,'add');"]]);
    expect($('.form-actions button').attr('class')).toBe('btn mura-primary');
    expect(formFields(markup)).toEqual([
      ['changesetID', CHANGESET_IDS.newSet],
      ['action', ''],
      ['csrf_token', FIXED_CSRF.token],
      ['csrf_token_expires', FIXED_CSRF.expires],
    ]);
    expect(menu($)).toEqual([['Back to Change Sets', `./?muraAction=cChangesets.list&siteid=${SITE}`]]);
  });

  it('warns of pending approvals and offers no Publish Now', async () => {
    const { $ } = await rendered(CHANGESET_IDS.open, variant(cchangesetsEditOpen, { hasPendingApprovals: 1 }));

    expect(alerts($)).toEqual([['alert alert-error', 'This change set contains content that has not been approved.']]);
    expect(buttons($).map(([text]) => text)).toEqual(['Delete', 'Update']);
  });

  it("shows the change set's errors in displayErrors form", async () => {
    const errors = { name: "The 'Title' field is required.", description: 'Keep it <b>short</b>.' };
    const { data, $ } = await rendered(CHANGESET_IDS.open, variant(cchangesetsEditOpen, {}, { errors }));
    const span = $('div.alert.alert-error > span');

    expect(span).toHaveLength(1);
    expect(span.html()).toBe(toString(renderDisplayErrors(data.changeset.errors)));
    expect(squash(span.text())).toBe("The 'Title' field is required. Keep it short.");
    expect(span.find('b').text()).toBe('short');
  });

  it.each<[string, string, ViewModel, string[]]>([
    ['open', CHANGESET_IDS.open, cchangesetsEditOpen, [CATEGORY_IDS.topicsNews]],
    ['scheduled', CHANGESET_IDS.scheduled, cchangesetsEditScheduled, [CATEGORY_IDS.topicsEvents, CATEGORY_IDS.topicsEventsLocal]],
    ['published', CHANGESET_IDS.published, cchangesetsEditPublished, []],
  ])('checks the %s change set categories in the level-0 nest', async (_case, changesetid, fixture, checked) => {
    const { $ } = await rendered(changesetid, fixture);
    const pane = $('#tabCategorization');
    const boxes = pane.find('input[name="categoryID"]').toArray();

    expect(pane.attr('class')).toBe('tab-pane');
    expect(pane.find('label').text()).toBe('Category Assignments');
    expect(pane.find('#mura-list-tree.mura-control.justify > ul.categories.checkboxTree')).toHaveLength(1);
    expect(pane.find('ul.checkboxTree')).toHaveLength(1);
    expect(pane.find('ul.categories')).toHaveLength(4);
    expect(boxes.map((box) => [$(box).val(), $(box).is('[disabled]')])).toEqual([
      [CATEGORY_IDS.topics, false],
      [CATEGORY_IDS.topicsNews, false],
      [CATEGORY_IDS.topicsEvents, false],
      [CATEGORY_IDS.topicsEventsLocal, false],
      [INTEREST_CATEGORY_IDS.newsletter, false],
      [INTEREST_CATEGORY_IDS.volunteering, false],
      [INTEREST_CATEGORY_IDS.training, false],
      [CATEGORY_IDS.inactiveArchive, false],
      [CATEGORY_IDS.restricted, true],
    ]);
    expect(boxes.filter((box) => $(box).is('[checked]')).map((box) => $(box).val())).toEqual(checked);
  });

  it('leaves out the Categorization tab and pane for a site without categories', async () => {
    const { $ } = await rendered(CHANGESET_IDS.open, variant(cchangesetsEditOpen, { categoryCount: 0, categories: [] }));

    expect(tabs($)).toEqual([
      ['active', '#tabBasic', 'return false;', 'Basic'],
      ['', '#tabTags', 'return false;', 'Tags'],
    ]);
    expect($('#tabCategorization')).toHaveLength(0);
    expect($('input[name="categoryID"]')).toHaveLength(0);
  });

  it.each<[string, string, ViewModel, string[]]>([
    ['open', CHANGESET_IDS.open, cchangesetsEditOpen, ['refresh', 'summer']],
    ['published', CHANGESET_IDS.published, cchangesetsEditPublished, ['cleanup']],
    ['new', '', cchangesetsEditNew, []],
    ['encoded', CHANGESET_IDS.open, variant(cchangesetsEditOpen, {}, { tags: 'R&D,"beta" <2>' }), ['R&D', '"beta" <2>']],
  ])('lists the %s tags in the tag selector', async (_case, changesetid, fixture, expected) => {
    const { $ } = await rendered(changesetid, fixture);
    const entry = $('#tabTags input[type="text"][name="tags"]');
    const tags = $('#tags.tagSelector > span.tag').toArray();

    expect(entry).toHaveLength(1);
    expect(entry.next().is('div#tags.mura-control.justify.tagSelector')).toBe(true);
    expect(tags.map((tag) => $(tag).contents().first().text().trim())).toEqual(expected);
    expect(tags.map((tag) => $(tag).find('input[type="hidden"][name="tags"]').val())).toEqual(expected);
  });
});

describe('renderDateTimeSelector', () => {
  const now = new Date(2026, 5, 30, 12, 0, 0);
  /** The date-time session of an admin request in `locale`. */
  const sessionIn = (locale: string): DateTimeSelectorSession => {
    const { dateKeyFormat, localeHasDayParts } = adminS2Request({ session: { locale } }).session;
    return { dateKeyFormat, localeHasDayParts, now };
  };
  const $html = (markup: SafeHtml): cheerio.CheerioAPI => $of(toString(markup));
  const options = ($: cheerio.CheerioAPI, id: string): string[][] =>
    $(`#${id} option`)
      .toArray()
      .map((o) => [$(o).attr('value') ?? '', $(o).text()]);
  const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it('writes the en_US date field, the 12-hour selects and the hidden value', () => {
    const $ = $html(
      renderDateTimeSelector(
        { name: 'closeDate', datetime: new Date(2026, 9, 29, 17, 30), defaultHour: 23, defaultMinute: 59 },
        sessionIn('en_US'),
      ),
    );
    const selectAttrs = (id: string) => ({ id, class: 'time mura-datepickercloseDate', name: '' });

    expect($('input[type="text"]').attr()).toEqual({
      type: 'text',
      autocomplete: 'off',
      class: 'datepicker span3 mura-datepickercloseDate',
      value: '10/302/2026',
      maxlength: '12',
      id: 'mura-datepicker-closeDate',
    });
    expect($('select').toArray().map((s) => $(s).attr())).toEqual([
      selectAttrs('mura-closeDateHour'),
      selectAttrs('mura-closeDateMinute'),
      selectAttrs('mura-closeDateDayPart'),
    ]);
    expect(options($, 'mura-closeDateHour')).toEqual(range(1, 12).map((h) => [String(h), String(h)]));
    expect(options($, 'mura-closeDateMinute')).toEqual(range(0, 59).map((m) => [String(m), String(m).padStart(2, '0')]));
    expect(options($, 'mura-closeDateDayPart')).toEqual([
      ['AM', 'AM'],
      ['PM', 'PM'],
    ]);
    expect([selected($, 'mura-closeDateHour'), selected($, 'mura-closeDateMinute'), selected($, 'mura-closeDateDayPart')]).toEqual([
      ['5'],
      ['30'],
      ['PM'],
    ]);
    expect($('input[type="hidden"]').attr()).toEqual({
      type: 'hidden',
      id: 'mura-closeDate',
      name: 'closeDate',
      value: "{ts '2026-10-29 17:30:00'}",
      'data-required': 'false',
    });
  });

  it.each<[number, string, string[]]>([
    [0, '12', []],
    [11, '11', []],
    [12, '12', ['PM']],
    [23, '11', ['PM']],
  ])('shows default hour %i as %s on the 12-hour clock', (defaultHour, hour, dayPart) => {
    const $ = $html(renderDateTimeSelector({ name: 'when', datetime: null, defaultHour }, sessionIn('en_US')));

    expect(selected($, 'mura-whenHour')).toEqual([hour]);
    expect(selected($, 'mura-whenMinute')).toEqual(['0']);
    expect(selected($, 'mura-whenDayPart')).toEqual(dayPart);
    expect($('#mura-datepicker-when').val()).toBe('');
    expect($('#mura-when').val()).toBe('');
  });

  it('writes 0-23 hours and no day-part select for a locale without day parts', () => {
    const session = sessionIn('de_DE');
    const $ = $html(renderDateTimeSelector({ name: 'closeDate', datetime: new Date(2026, 9, 29, 17, 30) }, session));

    expect(session.localeHasDayParts).toBe(false);
    expect($('select').toArray().map((s) => $(s).attr('id'))).toEqual(['mura-closeDateHour', 'mura-closeDateMinute']);
    expect(options($, 'mura-closeDateHour')).toEqual(range(0, 23).map((h) => [String(h), String(h)]));
    expect(selected($, 'mura-closeDateHour')).toEqual(['17']);
    expect($('#mura-datepicker-closeDate').val()).toBe('302.10.2026');
  });

  it.each<[string, Date, string, string, string, string]>([
    ['a day short of 51 years', new Date(2077, 5, 29, 8, 45), '06/180/2077', "{ts '2077-06-29 08:45:00'}", '8', '45'],
    ['51 years', new Date(2077, 5, 30, 12, 0), '', '', '12', '0'],
  ])('keeps the time of a date %s ahead, blanking the date only beyond 50 years', (_case, datetime, text, hidden, hour, minute) => {
    const $ = $html(renderDateTimeSelector({ name: 'when', datetime }, sessionIn('en_US')));

    expect($('#mura-datepicker-when').val()).toBe(text);
    expect($('#mura-when').val()).toBe(hidden);
    expect([selected($, 'mura-whenHour'), selected($, 'mura-whenMinute')]).toEqual([[hour], [minute]]);
  });
});

describe('renderDisplayErrors', () => {
  it.each<[string, ReadonlyArray<readonly [string, string]>, string]>([
    ['name then description', [['name', 'A'], ['description', 'B']], ' A <br> B '],
    ['siteID then name', [['siteID', 'x'], ['name', 'A']], ' A '],
    ['name then siteID', [['name', 'A'], ['siteID', 'x']], ' A <br> '],
  ])('writes %s as utility.displayErrors does', (_case, errors, markup) => {
    expect(toString(renderDisplayErrors(errors))).toBe(markup);
  });
});

describe('changesetEditScreen', () => {
  it('declares the strategies-content page of cchangesets.edit', () => {
    expect(changesetEditScreen).toMatchObject({
      circuit: 'cchangesets',
      action: 'edit',
      mode: 'page',
      owner: 'strategies-content',
      load: loadChangesetEdit,
    });
    expect(Object.isFrozen(changesetEditScreen)).toBe(true);
    expect('gate' in changesetEditScreen).toBe(false);
  });

  it('renders the edit view as the shell body', async () => {
    const { ctx, data } = await loaded(CHANGESET_IDS.open, cchangesetsEditOpen);

    const view = await changesetEditScreen.render(ctx, data);

    expect(toString(view.body)).toBe(toString(renderChangesetEditView(ctx, data)));
  });

  it('renders inside the shell through the registered cchangesets entry', async () => {
    const def = cchangesetsScreens.find((screen) => screen.action === 'edit');
    if (def === undefined) throw new Error('cchangesets.edit is not registered');
    const ctx: ScreenContext = contextFor(CHANGESET_IDS.open, cchangesetsEditOpen);

    const page = await renderScreenPage(def, ctx);

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const $ = cheerio.load(page.html);
    expect($('#page-container nav#sidebar')).toHaveLength(1);
    expect($('header#header-navbar')).toHaveLength(1);
    expect($('#mura-content .mura-header h1').text()).toBe('Edit Change Set');
    expect($('#mura-content form[name="form1"]')).toHaveLength(1);
    expect(domModel(page.html).buttons.filter((b) => b.hasOnclick).map((b) => b.text)).toEqual(
      expect.arrayContaining(['Delete', 'Update', 'Publish Now']),
    );
  });
});
