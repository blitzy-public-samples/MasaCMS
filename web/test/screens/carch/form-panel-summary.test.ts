// carch form/dsp_panel_summary.cfm: the content editor's Summary panel, against legacy captures.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { EditFormState, EditPageData } from '@/screens/carch/form/custom-tags';
import { renderPanelSummary, type PanelSummaryInput } from '@/screens/carch/form/panel-summary';
import { COMPONENT_MODULE_ID, CONTENT_MODULE_ID, ROOT_CONTENT_ID } from '@/screens/carch/model';
import { adminS2Request } from '../../helpers/admin-request';

// `cArch.edit` on the default site of the legacy ACF 2023 server as admin, cut from the include's leading newline
// through the blank lines before `</cfoutput>`: Home and new Page, Component and File nodes as installed, then Home
// rated 4 and 5, versioned 2.3, with the RATED field values and a pending approval request, opened as a Page and as
// a File, and unapproved under an approval chain (`pending`); then published with keywords stored and the server
// started with MURA_KEEPMETAKEYWORDS=true (`keywords`).
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/edit-panel-summary-${name}.html`, import.meta.url), 'utf8');

const HOME_HIST_ID = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const NODE_ID = 'C1000000-0000-0000-0000000000000001';
const NODE_HIST_ID = 'C2000000-0000-0000-0000000000000001';
const CHANGESET_ID = 'C3000000-0000-0000-0000000000000001';

type Bean = Readonly<Record<string, unknown>>;

/** Home as the legacy capture shows it: published, unrated, edited 2026-11-13 02:43. */
const HOME: Bean = {
  contentID: ROOT_CONTENT_ID,
  contentHistID: HOME_HIST_ID,
  siteID: 'default',
  isNew: 0,
  active: 1,
  approved: 1,
  approvalStatus: '',
  changesetID: '',
  filename: '',
  majorVersion: 0,
  minorVersion: 0,
  summary: '',
  credits: '',
  metaDesc: '',
  metaKeywords: '',
  notes: '',
  lastUpdate: '2026-11-13T02:43:00.000',
};

/** Home with the stored values of the rated captures. */
const RATED: Bean = {
  ...HOME,
  approvalStatus: 'Pending',
  majorVersion: 2,
  minorVersion: 3,
  metaKeywords: 'https://example.com/canon',
  credits: 'Ann "Lee"',
  metaDesc: 'Home <desc>',
  notes: 'Note & more',
  summary: '<p>Sum</p>',
};

/** `raterManager.getAvgRating` of the rated captures: SQL Server's integer average of 4 and 5. */
const RATED_ROWS = [{ theavg: 4, thecount: 2, upvotes: 2, downvotes: null }];

/** A new node's bean, created at the capture's 04:22. */
const NEW: Bean = { ...HOME, contentID: '', contentHistID: '', isNew: 1, active: 0, approved: 0, lastUpdate: '2026-11-13T04:22:00.000' };

/** A stored Page below Home. */
const NODE: Bean = { ...HOME, contentID: NODE_ID, contentHistID: NODE_HIST_ID, filename: 'about-us' };

const STATE: EditFormState = {
  tabAssignments: '',
  pageLevelList: 'Page,Folder,Calendar',
  baseTypeList: 'Page,Folder,Calendar',
  subTypes: [],
  subtypeFilter: '',
  isExtended: false,
  requiresApproval: false,
  showApprovalStatus: false,
  hasChangesets: true,
  ptype: 'Page',
  compactDisplay: '',
  preview: '0',
};

interface Case {
  readonly bean?: Bean;
  readonly type?: string;
  readonly contentid?: string;
  readonly moduleid?: string;
  readonly rsRating?: unknown;
  readonly state?: Partial<EditFormState>;
}

/** The panel's input as the edit view passes it, with the request's admin bundle. */
const inputOf = (req: AdminRequest, data: EditPageData, state: EditFormState): PanelSummaryInput => ({
  ctx: { rb: rbFor(req.session.rb) },
  req,
  data,
  state,
});

function render(c: Case = {}): string {
  const bean = c.bean ?? HOME;
  const req = adminS2Request({
    circuit: 'cArch',
    item: 'edit',
    rc: {
      type: c.type ?? 'Page',
      contentid: c.contentid ?? String(bean.contentID),
      moduleid: c.moduleid ?? CONTENT_MODULE_ID,
    },
  });
  const data: EditPageData = { rc: { contentBean: bean, ...(c.rsRating === undefined ? {} : { rsRating: c.rsRating }) } };
  const panel = renderPanelSummary(inputOf(req, data, { ...STATE, ...c.state }));
  expect(isSafeHtml(panel.html)).toBe(true);
  expect(panel.tabId).toBe('tabSummary');
  expect(panel.tabLabel).toBe('Summary');
  return toString(panel.html);
}

/** The status span's content, from after `<span>` through the line before its `</span>`. */
function statusText(markup: string): string {
  const start = markup.indexOf('Status:\n\t\t\t\t\t\t<span>') + 'Status:\n\t\t\t\t\t\t<span>'.length;
  return markup.slice(start, markup.indexOf('\n\t\t\t\t\t\t</span>\n\t\t\t\t\t</span>', start));
}

/** The status span of a stored node whose `viewStatusInfo` link leads with `tabs` tabs and trails with one fewer. */
const statusLink = (tabs: number, label: string): string =>
  `\n\t\t\t\t\t\t\t\n${'\t'.repeat(tabs)}<a href="#" onclick="return viewStatusInfo('${NODE_HIST_ID.replaceAll('-', '\\x2D')}','default');">` +
  `${label}</a>\n${'\t'.repeat(tabs - 1)}`;

beforeEach(() => {
  vi.stubEnv('MURA_HTMLEDITORTYPE', '');
  vi.stubEnv('MURA_KEEPMETAKEYWORDS', undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('carch.edit Summary panel', () => {
  it.each<[string, Case]>([
    ['home', {}],
    ['new-page', { bean: NEW, contentid: '' }],
    ['new-component', { bean: NEW, contentid: '', type: 'Component', moduleid: COMPONENT_MODULE_ID }],
    ['new-file', { bean: NEW, contentid: '', type: 'File' }],
    ['rated-page', { bean: RATED, rsRating: RATED_ROWS }],
    ['rated-file', { bean: RATED, type: 'File', rsRating: RATED_ROWS }],
    ['pending', { bean: { ...RATED, approved: 0 }, rsRating: RATED_ROWS, state: { showApprovalStatus: true } }],
  ])('matches the legacy %s capture byte for byte', (name, c) => {
    expect(render(c)).toBe(legacy(name));
  });

  it('matches the legacy keywords capture byte for byte', () => {
    vi.stubEnv('MURA_KEEPMETAKEYWORDS', 'true');
    resetLegacySettingsForTests();
    const bean = { ...RATED, approvalStatus: '', metaKeywords: 'masa, cms' };
    expect(render({ bean, rsRating: RATED_ROWS })).toBe(legacy('keywords'));
  });

  it.each<[string, Bean, Partial<EditFormState>, string]>([
    ['published', NODE, {}, '\n\t\t\t\t\t\t\tPublished '],
    ['published with boolean flags', { ...NODE, active: true, approved: true }, {}, '\n\t\t\t\t\t\t\tPublished '],
    ['published with an approval status', { ...NODE, approvalStatus: 'Pending' }, {}, statusLink(10, 'Published')],
    [
      'pending approval',
      { ...NODE, approved: 0, approvalStatus: 'Pending' },
      { requiresApproval: true },
      statusLink(9, 'Pending Approval'),
    ],
    [
      'rejected, shown without exemptions',
      { ...NODE, approved: 0, approvalStatus: 'Rejected' },
      { showApprovalStatus: true },
      statusLink(9, 'Rejected'),
    ],
    ['pending without an approval chain', { ...NODE, approved: 0, approvalStatus: 'Pending' }, {}, '\n\t\t\t\t\t\t\tDraft '],
    ['queued in a change set', { ...NODE, approved: 0, changesetID: CHANGESET_ID }, {}, '\n\t\t\t\t\t\t\tQueued '],
    ['draft', { ...NODE, approved: 0 }, {}, '\n\t\t\t\t\t\t\tDraft '],
    ['archived', { ...NODE, active: 0 }, {}, '\n\t\t\t\t\t\t\tArchived '],
    ['new', { ...NEW, approvalStatus: 'Pending' }, { requiresApproval: true }, '\n\t\t\t\t\t\t\tDraft '],
  ])('labels the status of a %s version as legacy does', (_case, bean, state, expected) => {
    expect(statusText(render({ bean, state }))).toBe(expected);
  });

  it.each<[string, string]>([
    ['0', 'zero'],
    ['', 'zero'],
    ['0.5', 'half'],
    ['1', 'one'],
    ['1.5', 'onehalf'],
    ['2', 'two'],
    ['2.5', 'twohalf'],
    ['3', 'three'],
    ['3.5', 'threehalf'],
    ['4', 'four'],
    ['4.5', 'fourhalf'],
    ['5', 'five'],
  ])('shows the votes and the %j-average stars (%s) of a rated node', (theAvg, stars) => {
    const markup = render({ bean: NODE, rsRating: [{ theavg: theAvg === '' ? null : Number(theAvg), thecount: 7 }] });
    expect(markup).toContain(
      '<div class="help-block" id="mura-content-metadata">\n\t\t\t\t\n\t\t\t\t\t\t\t<span class="meta-label">Vote(s): <span>7</span></span>' +
        `\n\t\t\t\t\t\t\t<span class="meta-label">Average Rating: <img id="ratestars" src="assets/images/rater/star_${stars}.gif"` +
        ` alt="${theAvg} stars" border="0"></span>\n\t\t\t\t\t\t\n\t\t\t\t\t<span class="meta-label">Update: <span>`,
    );
  });

  it.each<[string, Case]>([
    ['an unrated node', { bean: NODE, rsRating: [] }],
    ['a node without rsRating', { bean: NODE }],
    ['a rated Component', { bean: NODE, type: 'Component', rsRating: [{ theavg: 4, thecount: 2 }] }],
    ['a new rated node', { bean: NEW, contentid: '', rsRating: [{ theavg: 4, thecount: 2 }] }],
  ])('shows no ratings for %s', (_case, c) => {
    expect(render(c)).not.toContain('Vote(s)');
  });

  it('rejects an rsRating that is not a query', () => {
    expect(() => render({ bean: NODE, rsRating: { theavg: 1 } })).toThrow(TypeError);
  });

  it.each<[string, Case, boolean]>([
    ['a versioned file', { bean: { ...NODE, majorVersion: 2, minorVersion: 3 }, type: 'file' }, true],
    ['an unversioned file', { bean: NODE, type: 'File' }, false],
    ['a versioned page', { bean: { ...NODE, majorVersion: 2, minorVersion: 3 }, type: 'Page' }, false],
    ['a new versioned file', { bean: { ...NEW, majorVersion: 2, minorVersion: 3 }, contentid: '', type: 'File' }, false],
  ])('shows the file version only for %s', (_case, c, shown) => {
    const version =
      'id="mura-content-metadata">\n\t\t\t\t\n\t\t\t\t\t\t\t<span class="meta-label">File Version: <span>2.3</span></span>' +
      '\n\t\t\t\t\t\n\t\t\t\t\t<span class="meta-label">Update:';
    const markup = render(c);
    expect(markup.includes(version)).toBe(shown);
    expect(markup.includes('File Version')).toBe(shown);
  });

  it.each<[string, Case, string | undefined]>([
    ['the stored node', { bean: NODE }, '<span class="clicktocopy">about-us</span>'],
    ['Home', {}, 'Empty String'],
    ['a node opened without its id', { bean: NODE, contentid: '' }, 'Not Available'],
    ['a Gallery', { bean: NODE, type: 'Gallery' }, '<span class="clicktocopy">about-us</span>'],
    ['a File', { bean: NODE, type: 'File' }, undefined],
    ['a lower-case page, which listFind misses', { bean: NODE, type: 'page' }, undefined],
  ])('prints the filename of %s as legacy does', (_case, c, expected) => {
    const markup = render(c);
    const filename = /Filename: \n\t\t\t\t\t\t(.*)\n\t\t\t\t\t\t<\/span>/.exec(markup)?.[1];
    expect(filename).toBe(expected);
  });

  it.each<[string, Case, string]>([
    ['the stored node', { bean: NODE }, `<span class="clicktocopy">${NODE_ID}</span>`],
    ['a node opened without its id', { bean: NODE, contentid: '' }, 'Not Available'],
  ])('prints the content id of %s', (_case, c, expected) => {
    expect(render(c)).toContain(`Content ID: \n\t\t\t\t      ${expected}\n\t\t\t\t    </span>`);
  });

  it.each<[string, string | undefined, string, string]>([
    ['an empty summary in CKEditor', '', '', ''],
    ['an empty summary without an editor', 'none', '', '<p></p>'],
    ['a stored summary without an editor', 'NONE', '<p>A & B</p>', '&lt;p&gt;A &amp; B&lt;&#x2f;p&gt;'],
    ['a stored summary in CKEditor', 'ckeditor', '<p>A</p>', '&lt;p&gt;A&lt;&#x2f;p&gt;'],
  ])('fills the summary textarea of %s', (_case, editor, summary, expected) => {
    vi.stubEnv('MURA_HTMLEDITORTYPE', editor);
    resetLegacySettingsForTests();
    expect(render({ bean: { ...NODE, summary } })).toContain(
      `<textarea name="summary" id="summary" cols="96" rows="10">${expected}</textarea>`,
    );
  });

  it('leaves the summary editor closed for an extended type', () => {
    const markup = render({ state: { isExtended: true } });
    expect(markup).not.toContain('showSummaryEditor();');
    expect(markup).toContain('\t\t\t\t\t\t}\n\t\t\t\t\t\t\n\t\t\t\t\t</script>\n\t\t\t\t\n\t\t\t\t\t\n');
  });

  it.each<[string, Case, boolean, boolean]>([
    ['a Page in the site tree', {}, true, true],
    ['a Link', { type: 'Link' }, true, true],
    ['a Form', { type: 'Form' }, false, false],
    ['a Component', { type: 'component', moduleid: COMPONENT_MODULE_ID }, false, false],
    ['a Variation', { type: 'Variation' }, true, false],
  ])('renders the summary and page fields for %s', (_case, c, summary, credits) => {
    const markup = render(c);
    expect(markup.includes('id="editSummary"')).toBe(summary);
    expect(markup.includes('id="credits"')).toBe(credits);
  });

  it.each<[string, string, string, boolean]>([
    ['no tab assignments in the Site Manager', CONTENT_MODULE_ID, '', true],
    ['no tab assignments outside the Site Manager', COMPONENT_MODULE_ID, '', false],
    ['other tabs in the Site Manager', CONTENT_MODULE_ID, 'Basic,Publishing', false],
    ['the SEO tab outside the Site Manager', COMPONENT_MODULE_ID, 'Basic,seo', true],
    ['the SEO tab in the Site Manager', CONTENT_MODULE_ID, 'SEO', true],
    ['a numerically equal module id', '0', '', true],
  ])('shows the SEO fields with %s as CFML precedence decides', (_case, moduleid, tabAssignments, shown) => {
    const markup = render({ type: 'Folder', moduleid, state: { tabAssignments } });
    expect(markup.includes('id="metadesc"')).toBe(shown);
    expect(markup.includes('id="canonicalURL"')).toBe(shown);
    expect(markup).toContain('<input type="text" id="credits" name="credits" value=""  maxlength="255">');
  });

  it.each<[string, string, string, string]>([
    ['keywords', 'masa, cms', 'masa, cms', ''],
    ['a canonical URL', 'https://example.com/about?x=1', '', 'https&#x3a;&#x2f;&#x2f;example.com&#x2f;about&#x3f;x&#x3d;1'],
    ['nothing', '', '', ''],
  ])('splits stored %s between the keywords and canonical URL fields', (_case, stored, keywords, canonical) => {
    vi.stubEnv('MURA_KEEPMETAKEYWORDS', 'true');
    resetLegacySettingsForTests();
    const markup = render({ bean: { ...NODE, metaKeywords: stored, metaDesc: 'A "desc"' } });
    expect(markup).toContain(
      '<textarea name="metadesc" id="metadesc">A &quot;desc&quot;</textarea>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\t' +
        '\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>Meta Keywords</label>' +
        `\n\t\t\t\t\t\t\t\t<textarea name="metakeywords" rows="3" id="metakeywords">${keywords}</textarea>` +
        '\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\n\t\t\t\t\t\t<div class="mura-control-group">' +
        '\n\t\t\t\t\t\t\t<label>Canonical URL</label>' +
        `\n\t\t\t\t\t\t\t<input type="text" id="canonicalURL" name="canonicalURL" value="${canonical}"  maxlength="255">`,
    );
  });

  it('hides the keywords field unless keepMetaKeywords is set', () => {
    expect(render({ bean: { ...NODE, metaKeywords: 'masa' } })).not.toContain('id="metakeywords"');
  });

  it('encodes credits and notes as legacy does', () => {
    const markup = render({ bean: { ...NODE, credits: 'A "B" <C>', notes: 'x < y & z' } });
    expect(markup).toContain('id="credits" name="credits" value="A&#x20;&quot;B&quot;&#x20;&lt;C&gt;"  maxlength="255">');
    expect(markup).toContain('<textarea name="notes" rows="3" id="abstract">x &lt; y &amp; z</textarea>');
  });

  it('throws as CFML does when the request has no type', () => {
    const req = adminS2Request({ circuit: 'cArch', item: 'edit' });
    const input = inputOf(req, { rc: { contentBean: HOME } }, STATE);
    expect(() => renderPanelSummary(input)).toThrow('Element TYPE is undefined in RC.');
  });
});
