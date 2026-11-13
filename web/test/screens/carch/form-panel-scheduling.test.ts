import { readFileSync } from 'node:fs';
import { businessClock } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { EditFormInput, EditFormState } from '@/screens/carch/form/custom-tags';
import { renderSchedulingPanel } from '@/screens/carch/form/panel-scheduling';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';

// `cArch.edit` Scheduling panels captured from the legacy ACF 2023 server as admin (S2) on the default site (locking
// None), cut from the newline after `<cfoutput>` through `</div>\n\n\n`. new-page is a new Page under Home, which
// legacy also prints for a new Component and a new Form; the hidden captures pass contentid=Home with a new version.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/${name}.html`, import.meta.url), 'utf8');
const panel = (name: string): string => fixture(`edit-panel-scheduling-${name}`);
const displayContent = (name: string): string => fixture(`edit-displaycontent-${name}`);

const NEW_PAGE = panel('new-page');
const [PREFIX, SUFFIX] = NEW_PAGE.split(displayContent('new-page')) as [string, string];
/** The captured panel around another display content capture. */
const wrapped = (name: string): string => PREFIX + displayContent(name) + SUFFIX;

const ZONE = 'Etc/UTC';
const ROOT = '00000000000000000000000000000000001';
const COMPONENTS = '00000000000000000000000000000000003';
const FORMS = '00000000000000000000000000000000004';
const CALENDAR = 'C0A1B2C3-0000-0000-0000000000000001';

const NEW_INTERVAL = {
  type: 'Daily', every: 1, repeats: 1, allday: '1', end: 'never', endon: '', endafter: '1', daysofweek: '',
  detectconflicts: '0', detectspan: '12', timezone: ZONE,
};

type Bean = Readonly<Record<string, unknown>>;

/** A new node's bean: display Always, the stored `Daily` interval, no start or stop. */
function newBean(parentType: string): Bean {
  return {
    display: 1, isNew: 1, parentID: '', displayInterval: 'Daily', parent: { type: parentType },
    displayIntervalValues: NEW_INTERVAL, displayStartInTimezone: '', displayStopInTimezone: '',
  };
}

const CALENDAR_CHILD: Bean = {
  display: 2,
  isNew: 0,
  parentID: CALENDAR,
  displayInterval:
    '{"daysofweek":"2,4","endafter":0,"allday":0,"end":"on","endon":"August, 01 2026 00:00:00","timezone":"","repeats":1,"type":"weekly","detectconflicts":1,"detectspan":3,"every":1}',
  parent: { type: 'Calendar' },
  displayIntervalValues: {
    type: 'weekly', every: 1, repeats: 1, allday: 0, end: 'on', endon: "{ts '2026-08-01 00:00:00'}", endafter: 0,
    daysofweek: '2,4', detectconflicts: 1, detectspan: 3, timezone: ZONE,
  },
  displayStartInTimezone: "{ts '2026-07-01 10:00:00'}",
  displayStopInTimezone: '2026-08-01T11:30:00',
};

const STATE: EditFormState = Object.freeze({
  tabAssignments: '',
  pageLevelList: 'Page,Folder,Calendar',
  baseTypeList: 'Page,Folder,Calendar,Gallery,Link,File',
  subTypes: [],
  subtypeFilter: '',
  isExtended: false,
  requiresApproval: false,
  showApprovalStatus: false,
  hasChangesets: false,
  ptype: 'Page',
  compactDisplay: 'false',
  preview: '0',
});

interface Case {
  readonly type?: string;
  readonly parentid?: string;
  readonly contentid?: string;
  readonly bean?: Bean;
  readonly parentBeanType?: string;
  readonly locking?: string;
  readonly model?: Readonly<Record<string, unknown>>;
}

function editInput(c: Case = {}): EditFormInput {
  const rc = { type: c.type ?? 'Page', parentid: c.parentid ?? ROOT, contentid: c.contentid ?? '' };
  const req = adminS2Request({ circuit: 'carch', item: 'edit', rc });
  const ctx = { req, rb: rbFor(req.session.rb), now: businessClock().now() } as unknown as ScreenContext;
  const model = {
    contentBean: c.bean ?? newBean('Page'),
    parentBean: { type: c.parentBeanType ?? 'Page' },
    site: { siteID: 'default', locking: c.locking ?? 'None' },
    defaultTimeZone: ZONE,
    ...c.model,
  };
  return { ctx, req, data: { rc: model }, state: STATE };
}

function render(c: Case = {}): { html: string; ptype: string } {
  const result = renderSchedulingPanel(editInput(c));
  expect(isSafeHtml(result.html)).toBe(true);
  return { html: toString(result.html), ptype: result.ptype };
}

const HIDDEN_PAGE = panel('hidden-page');
const HIDDEN_COMPONENT = panel('hidden-component');

describe('carch.edit Scheduling panel', () => {
  it('matches the legacy include byte for byte and names its tab', () => {
    const result = renderSchedulingPanel(editInput());
    expect(toString(result.html)).toBe(NEW_PAGE);
    expect(result).toMatchObject({ tabId: 'tabSchedule', tabLabel: 'Scheduling', ptype: 'Page' });
    expect(result.bodyContent).toBeUndefined();
    expect(result.htmlHead).toBeUndefined();
  });

  it.each<[string, string]>([
    ['Component', COMPONENTS],
    ['Form', FORMS],
  ])('prints the schedule editor of a new %s as legacy does', (type, parentid) => {
    expect(render({ type, parentid, bean: newBean('Module') }).html).toBe(NEW_PAGE);
  });

  it.each<[string, Case]>([
    ['calendar-child', { parentid: CALENDAR, bean: CALENDAR_CHILD, parentBeanType: 'Calendar' }],
    ['new-calendar-child', { parentid: CALENDAR, bean: newBean('Calendar'), parentBeanType: 'Calendar' }],
  ])('wraps the display content of a %s and passes on its Calendar ptype', (name, c) => {
    expect(render(c)).toEqual({ html: wrapped(name), ptype: 'Calendar' });
  });

  it.each<[string, string]>([
    ['Page', HIDDEN_PAGE],
    ['Component', HIDDEN_COMPONENT],
    ['Form', HIDDEN_COMPONENT],
  ])('prints the hidden display fields of a %s edited as the home node', (type, expected) => {
    expect(render({ type, contentid: ROOT })).toEqual({ html: expected, ptype: 'Page' });
  });

  it.each<[string, string, string, boolean]>([
    ['all', 'under a section', CALENDAR, false],
    ['none', 'under a section', CALENDAR, true],
    ['top', 'under a section', CALENDAR, true],
    ['all', 'under Home', ROOT, false],
    ['top', 'under Home', ROOT, false],
    ['NONE', 'under Home', ROOT, true],
  ])('with locking %s %s shows the schedule editor: %s', (locking, _where, parentid, shows) => {
    const { html } = render({ locking, parentid });
    expect(html === NEW_PAGE).toBe(shows);
    expect(html === HIDDEN_PAGE).toBe(!shows);
  });

  it("keeps the request's ptype when the schedule editor is hidden", () => {
    const input = editInput({ locking: 'all', parentid: CALENDAR, parentBeanType: 'Calendar' });
    expect(renderSchedulingPanel({ ...input, state: { ...STATE, ptype: 'Gallery' } }).ptype).toBe('Gallery');
  });

  it('prints the stored display unencoded in the hidden field', () => {
    const value = `2" data-x='<b>&`;
    const { html } = render({ locking: 'all', parentid: CALENDAR, bean: { ...newBean('Page'), display: value } });
    expect(html).toBe(HIDDEN_PAGE.replace('name="display" value="1"', `name="display" value="${value}"`));
  });

  it.each<[string, string, boolean]>([
    ['under Home', ROOT, false],
    ['under a section', CALENDAR, true],
  ])('takes the parent of a stored node %s when the request names none', (_where, parentID, shows) => {
    const bean = { ...newBean('Page'), isNew: 0, parentID };
    const { html } = render({ locking: 'top', parentid: '', bean });
    expect(html.includes('<select name="display" id="mura-display"')).toBe(shows);
    expect(html === HIDDEN_PAGE).toBe(!shows);
  });

  it.each<[string, Readonly<Record<string, unknown>>]>([
    ['the content bean', { contentBean: undefined }],
    ['the site', { site: undefined }],
  ])('throws when the edit model lacks %s', (_case, model) => {
    expect(() => renderSchedulingPanel(editInput({ model }))).toThrow(TypeError);
  });

  it('throws when the request has no parentid', () => {
    const input = editInput();
    const req = adminS2Request({ circuit: 'carch', item: 'edit', rc: { type: 'Page', contentid: '' } });
    expect(() => renderSchedulingPanel({ ...input, req })).toThrow(TypeError);
  });
});
