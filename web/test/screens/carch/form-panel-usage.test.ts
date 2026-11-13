import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import type { EditFormInput, EditFormState } from '@/screens/carch/form/custom-tags';
import { renderPanelUsage } from '@/screens/carch/form/panel-usage';
import { CONTENT_MODULE_ID, type CarchStruct } from '@/screens/carch/model';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

// `cArch.edit` of a Component the bodies of two pages reference, before and after one page was scheduled and the
// other hidden, and of an unused Form, captured from the legacy ACF 2023 server as admin on the default site and cut
// from the include's newline after `<cfoutput>` through its closing `</script> `.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/${name}.html`, import.meta.url), 'utf8');

const HOME_ID = '00000000000000000000000000000000001';

const STATE: EditFormState = {
  tabAssignments: '',
  pageLevelList: 'Page,Folder,Calendar',
  baseTypeList: 'Component',
  subTypes: [],
  subtypeFilter: '',
  isExtended: false,
  requiresApproval: false,
  showApprovalStatus: false,
  hasChangesets: false,
  ptype: 'Module',
  compactDisplay: 'false',
  preview: '0',
};

/** A Site Manager page crumb on `default` with the class-extension icon legacy resolved. */
const crumb = (contentid: string, menutitle: string): CarchStruct => ({
  siteid: 'default',
  contentid,
  type: 'Page',
  menutitle,
  restricted: 0,
  iconclass: 'mi-file',
});

/** A `getUsage` row of a page under Home, with its crumbs and verdict; `fields` overrides any column. */
function usageRow(contentid: string, contenthistid: string, menutitle: string, fields: CarchStruct = {}): CarchStruct {
  return {
    menutitle,
    type: 'Page',
    filename: '',
    lastupdate: '2026-11-13T04:28:42.960',
    contentid,
    siteid: 'default',
    approved: 1,
    display: 1,
    displaystart: null,
    displaystop: null,
    moduleid: CONTENT_MODULE_ID,
    contenthistid,
    parentid: HOME_ID,
    crumbdata: [crumb(contentid, menutitle), crumb(HOME_ID, 'Home')],
    verdict: 'editor',
    ...fields,
  };
}

const PAGE_A = usageRow('3FA63EA3-C88E-A644-BF557E9AB1C07F26', '3FA65964-E2CF-E173-ACF5ACA04810F916', 'Usage Probe Page A');
const PAGE_B = usageRow(
  '3FA66A17-FD4A-DD29-A40C01B6370791EC',
  '3FA67041-D295-7013-A3BE292B20C8BA00',
  'Usage & <Probe> Page B',
  { lastupdate: '2026-11-13T04:28:43.523' },
);

/** The panel for `rsUsage` rows on a content bean of `type`, under `rb`. */
function render(rows: unknown, type = 'Component', rb: RbLookup = rbFor('en')): ReturnType<typeof renderPanelUsage> {
  const req = adminS2Request();
  const input: EditFormInput = {
    ctx: { req, rb } as unknown as EditFormInput['ctx'],
    req,
    data: { rc: { rsUsage: rows, contentBean: { type, contentid: 'C', isNew: false } } },
    state: STATE,
  };
  return renderPanelUsage(input);
}

const markupOf = (rows: unknown, type?: string, rb?: RbLookup): string => {
  const panel = render(rows, type, rb);
  expect(isSafeHtml(panel.html)).toBe(true);
  return toString(panel.html);
};

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('carch.edit Usage Report panel', () => {
  it('matches legacy byte for byte for a component used on two displayed pages', () => {
    expect(markupOf([PAGE_A, PAGE_B])).toBe(fixture('edit-usage-component'));
  });

  it('matches legacy for a hidden page and a scheduled window, the day-of-year mask included', () => {
    const rows = [
      { ...PAGE_A, display: 0 },
      { ...PAGE_B, display: 2, displaystart: '2026-01-10T08:00:00', displaystop: "{ts '2026-12-20 17:00:00'}" },
    ];
    expect(markupOf(rows)).toBe(fixture('edit-usage-component-scheduled'));
  });

  it('matches legacy for an unused form', () => {
    expect(markupOf([], 'Form')).toBe(fixture('edit-usage-form-unused'));
  });

  it('returns the tab id and label the include appends', () => {
    const panel = render([]);
    expect(panel.tabId).toBe('tabUsagereport');
    expect(panel.tabLabel).toBe('Usage Report');
    expect(panel.bodyContent).toBeUndefined();
    expect(panel.htmlHead).toBeUndefined();
  });

  it.each<[string, CarchStruct, string]>([
    ['Yes for a displayed, approved version', { display: 1, approved: 1 }, 'Yes'],
    ['No for a displayed version that is not approved', { display: 1, approved: 0 }, 'No'],
    ['No for a scheduled version that is not approved', { display: 2, approved: 'false' }, 'No'],
    ['the window with blank ends for a scheduled version without dates', { display: 2, approved: true }, ' - '],
    ['No for a hidden version without reading approved', { display: 0, approved: null }, 'No'],
    ['No for a display value other than 0, 1 and 2', { display: 3, approved: 1 }, 'No'],
  ])('prints %s', (_case, fields, expected) => {
    expect(markupOf([{ ...PAGE_A, ...fields }])).toContain(`\t    ${expected}</td>`);
  });

  it.each(['none', 'NONE'])('prints disabled actions for verdict %s', (verdict) => {
    const markup = markupOf([{ ...PAGE_A, verdict }]);
    expect(markup).toContain(
      '<td nowrap class="actions"><ul><li class="edit disabled">Edit</li><li class="version-history disabled">Version History</li></ul></td>',
    );
    expect(markup).not.toContain('muraAction=cArch.edit');
  });

  it('prints the not-used notice with the lower-cased type label', () => {
    const markup = markupOf([], 'Component');
    expect(markup).toContain('<div class="help-block-empty">This component is currently not being used.</div>');
    expect(markup).toContain('data-label=""');
    expect(markup).toContain('var usageTotal = 0;');
  });

  it('writes labels and row values unencoded, and reads columns case-insensitively', () => {
    const rb: RbLookup = { locale: 'en', rbKey: (key) => `<${key}&>`, messageFormat: () => '' };
    const row = Object.fromEntries(Object.entries(PAGE_A).filter(([key]) => key !== 'contenthistid' && key !== 'type'));
    const markup = markupOf([{ ...row, CONTENTHISTID: 'H&1', Type: 'Page"x' }], 'Component', rb);
    expect(markup).toContain('<label><sitemanager.content.fields.usagedescription&>:</label>');
    expect(markup).toContain('title="<sitemanager.content.fields.edit&>"');
    expect(markup).toContain('href="./?muraAction=cArch.edit&contenthistid=H&1&contentid=');
    expect(markup).toContain('&type=Page"x&parentid=');
  });

  it.each<[string, unknown, ErrorConstructor]>([
    ['rsUsage is absent', undefined, TypeError],
    ['a row is not a struct', ['row'], TypeError],
    ['a row has no crumbs', [{ ...PAGE_A, crumbdata: undefined }], TypeError],
    ['the display flag is NULL', [{ ...PAGE_A, display: null }], TypeError],
    ['a date cannot be read', [{ ...PAGE_A, lastupdate: 'not a date' }], RangeError],
  ])('throws where legacy fails: %s', (_case, rows, error) => {
    expect(() => render(rows)).toThrow(error);
  });
});
