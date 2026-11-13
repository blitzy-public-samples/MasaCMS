import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { businessClock } from '@opt2/platform/testing';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { datetimeSelector, type EditFormInput, type EditFormState } from '@/screens/carch/form/custom-tags';
import { renderPanelRemote } from '@/screens/carch/form/panel-remote';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';

// `cArch.edit` of a new Page under Home on the default site, captured from the legacy ACF 2023 server as admin (S2)
// and cut from the include's newline after `<cfoutput>` through `</div> \n`.
const LEGACY = readFileSync(
  new URL('../../fixtures/strategies-content/edit-panel-remote.html', import.meta.url),
  'utf8',
);

const NEW_PAGE_BEAN = Object.freeze({
  remoteID: '',
  remoteURL: '',
  remotePubDate: '',
  remoteSource: '',
  remoteSourceURL: '',
});

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

/** The S2 admin's context with only what the panel reads: the session's date settings, its labels and the clock. */
function adminContext(): ScreenContext {
  const req = adminS2Request();
  return { req, rb: rbFor(req.session.rb), now: businessClock().now() } as unknown as ScreenContext;
}

type Bean = Readonly<Record<string, unknown>>;

function editInput(bean: Bean, rc: Record<string, unknown> = { contentBean: bean }): EditFormInput {
  const ctx = adminContext();
  return { ctx, req: ctx.req, data: { rc }, state: STATE };
}

function render(bean: Bean = NEW_PAGE_BEAN): string {
  const panel = renderPanelRemote(editInput(bean));
  expect(isSafeHtml(panel.html)).toBe(true);
  return toString(panel.html);
}

describe('carch.edit Remote panel', () => {
  it('matches the legacy include byte for byte and names its tab', () => {
    const panel = renderPanelRemote(editInput(NEW_PAGE_BEAN));
    expect(toString(panel.html)).toBe(LEGACY);
    expect(panel.tabId).toBe('tabRemote');
    expect(panel.tabLabel).toBe('Remote');
    expect(panel.bodyContent).toBeUndefined();
    expect(panel.htmlHead).toBeUndefined();
  });

  const RAW_FIELDS = ['remoteID', 'remoteURL', 'remoteSource', 'remoteSourceURL'];

  it.each(RAW_FIELDS)('prints %s unencoded, as legacy does', (field) => {
    const value = `a"b' <c> & d`;
    const markup = render({ ...NEW_PAGE_BEAN, [field]: value });
    expect(markup).toBe(LEGACY.replace(`name="${field}" value=""`, `name="${field}" value="${value}"`));
  });

  it('reads bean values by case-insensitive name and SQL NULL as empty', () => {
    const markup = render({ REMOTEID: 'r-1', remoteurl: null, remotesourceurl: 7 });
    expect(markup).toBe(
      LEGACY.replace('name="remoteID" value=""', 'name="remoteID" value="r-1"').replace(
        'name="remoteSourceURL" value=""',
        'name="remoteSourceURL" value="7"',
      ),
    );
  });

  // The bean holds remotePubDate as a date object, which the tag prints as its CFML `ToString` text.
  it.each<[string, Date]>([
    ["{ts '2026-10-29 14:05:00'}", new Date(2026, 9, 29, 14, 5, 0)],
    ['2026-10-29 14:05:00.0', new Date(2026, 9, 29, 14, 5, 0)],
    ['2026-10-29T14:05:00.123', new Date(2026, 9, 29, 14, 5, 0)],
    ['2026-10-29 14:05', new Date(2026, 9, 29, 14, 5, 0)],
    ['2026-10-29', new Date(2026, 9, 29, 0, 0, 0)],
  ])('renders the stored remotePubDate %s as the date selector of the bean date', (stored, date) => {
    const input = editInput({ ...NEW_PAGE_BEAN, remotePubDate: stored });
    const selector = datetimeSelector(input.ctx, { name: 'remotePubDate', datetime: date, timeselectwrapper: true });
    const markup = toString(renderPanelRemote(input).html);
    expect(markup).toContain(`</label>\t\t\t\t\t\t\n\t\t\t\t\t\t${selector.value}\n\t\t\t\t\t</div>`);
  });

  it('throws when the edit model holds no content bean', () => {
    expect(() => renderPanelRemote(editInput(NEW_PAGE_BEAN, {}))).toThrow(TypeError);
  });

  it('throws when a remote field is not a simple value', () => {
    expect(() => render({ ...NEW_PAGE_BEAN, remoteID: { nested: true } })).toThrow(TypeError);
  });
});
