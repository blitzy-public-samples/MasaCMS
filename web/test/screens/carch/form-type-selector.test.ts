import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import type { SubTypeRow } from '@/screens/carch/form/custom-tags';
import { renderTypeSelector, type TypeSelectorInput } from '@/screens/carch/form/type-selector';
import { adminS2Request, editorRequest, unservedEditorRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

/** One captured `cArch.edit` of a new node: the edit view's inputs and the include's exact output. */
interface Capture {
  readonly user: 'admin' | 'editor';
  readonly rcType: string;
  readonly subType: string;
  readonly contentId: string;
  readonly contentHistId: string;
  readonly subtypeFilter: string;
  readonly subTypes: readonly SubTypeRow[];
  readonly html: string;
}

// New nodes of each type on `default` from the legacy ACF 2023 server, as admin (S2) or qa_editor, cut from the
// include's first byte to its last. `shared-folder` has no class extensions; the others were captured with
// tclassextend rows seeded (Page/Product and Component/Widget admin-only), the `filter-*` ones with Home's subtype
// offering only `Page/Product,Folder/Default,Link/External`. `subTypes` is `rsSubTypes` as edit.cfm filters it.
const CAPTURES: Readonly<Record<string, Capture>> = JSON.parse(
  readFileSync(new URL('../../fixtures/strategies-content/edit-type-selector.json', import.meta.url), 'utf8'),
) as Record<string, Capture>;

const PAGE_LEVEL_LIST = 'Page,Folder,Calendar';
const ROWS: readonly SubTypeRow[] = CAPTURES['admin-page-default']?.subTypes ?? [];

/** The request of `user` on `default`, whose served site uses the installed theme. */
function requestFor(user: Capture['user'], rc: Record<string, string> = {}): AdminRequest {
  const partial = { rc, site: { record: { theme: 'default' } } };
  return user === 'admin' ? adminS2Request(partial) : editorRequest(partial);
}

/** edit.cfm's `baseTypeList` for `rc.type`. */
const baseTypeListOf = (rcType: string): string =>
  ['component', 'file', 'link', 'form', 'variation'].includes(rcType.toLowerCase()) ? rcType : PAGE_LEVEL_LIST;

/** The selector's input for a new node of `c.rcType`; `rc.type` comes from the request. */
function inputFor(c: Omit<Capture, 'html' | 'user'>, req: AdminRequest, rb: RbLookup = rbFor('en')): TypeSelectorInput {
  return {
    ctx: { rb },
    req,
    data: {
      rc: {
        contentBean: { contentID: c.contentId, contentHistID: c.contentHistId, type: c.rcType, subType: c.subType },
      },
    },
    state: {
      pageLevelList: PAGE_LEVEL_LIST,
      baseTypeList: baseTypeListOf(c.rcType),
      subTypes: c.subTypes,
      subtypeFilter: c.subtypeFilter,
    },
  };
}

function render(input: TypeSelectorInput): string {
  const markup = renderTypeSelector(input);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** Optional inputs of {@link renderNode}. */
interface NodeOptions {
  readonly subType?: string;
  readonly subtypeFilter?: string;
  readonly req?: AdminRequest;
  readonly rb?: RbLookup;
}

/** A new node of `rcType` with `subTypes`, rendered for `req` (admin by default). */
function renderNode(rcType: string, subTypes: readonly SubTypeRow[], options: NodeOptions = {}): string {
  const req = options.req ?? requestFor('admin', { type: rcType });
  const node = { rcType, subType: options.subType ?? 'Default', contentId: 'CID', contentHistId: 'CHID' };
  return render(inputFor({ ...node, subtypeFilter: options.subtypeFilter ?? '', subTypes }, req, options.rb));
}

const row = (type: string, subtype: string, adminonly = 0): SubTypeRow => ({ type, subtype, adminonly });

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
  // Legacy settings resolve from no MURA_ variable, as on the capture server: an empty context.
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('carch.edit type selector', () => {
  it.each(Object.entries(CAPTURES))('matches the legacy include for %s', (_name, capture) => {
    const req = requestFor(capture.user, { type: capture.rcType, subtype: capture.subType });
    expect(render(inputFor(capture, req))).toBe(capture.html);
  });

  it('renders the Form branch with the Component branch markup', () => {
    const component = CAPTURES['admin-component'];
    if (component === undefined) throw new Error('admin-component capture missing');
    const expected = component.html
      .replaceAll(component.contentId, 'CID')
      .replaceAll(component.contentHistId, 'CHID')
      .replaceAll('Component', 'Form')
      .replaceAll('Widget', 'Survey');
    expect(renderNode('Form', ROWS)).toBe(expected);
  });

  it.each<[string, readonly SubTypeRow[]]>([
    ['File', [row('Link', 'External')]],
    ['Link', [row('File', 'Doc'), row('Link', 'Default'), row('Link', 'default')]],
    ['Component', [row('Form', 'Survey')]],
    ['Form', [row('Component', 'Widget')]],
    // `t = rc.type` is matched case-sensitively, so a lower-cased type finds no rows.
    ['component', ROWS],
    ['Variation', ROWS],
    ['Gallery', ROWS],
  ])('renders nothing for %s without subtypes of its own', (rcType, subTypes) => {
    expect(renderNode(rcType, subTypes)).toBe('');
  });

  it('JavaScript-encodes the site id in the page-level branch only', () => {
    const rcFor = (type: string): Record<string, string> => ({ type, siteid: 'tenant-a' });
    const page = renderNode('Page', ROWS, { req: requestFor('admin', rcFor('Page')) });
    expect(page).toContain(`,this.value,'tenant\\x2Da','',`);
    for (const type of ['File', 'Link', 'Component']) {
      expect(renderNode(type, ROWS, { req: requestFor('admin', rcFor(type)) })).toContain(`,this.value,'tenant-a','',`);
    }
  });

  it('builds each branch label from its own key case and spacing', () => {
    const rb: RbLookup = { locale: 'en', rbKey: (key) => `[${key}]`, messageFormat: () => '' };
    expect(renderNode('Page', ROWS, { rb })).toContain(
      '<option value="Page^Article" >[sitemanager.content.type.page]  / Article</option>',
    );
    const file = renderNode('File', ROWS, { rb });
    expect(file).toContain('<option value="File^Default" selected>[sitemanager.content.type.File]</option>');
    expect(file).toContain('<option value="File^Doc" >[sitemanager.content.type.file] / Doc</option>');
    expect(renderNode('Link', ROWS, { rb })).toContain(
      '<option value="Link^External" >[sitemanager.content.type.link]  / External</option> ',
    );
  });

  it('matches types and subtypes case-sensitively but selects and filters without case', () => {
    const rows = [
      row('page', 'Lower'),
      row('Page', 'DEFAULT'),
      row('Page', 'Product', 1),
      row('Link', 'DEFAULT'),
      row('Link', 'Ext'),
    ];
    const subtypeFilter = 'page/default,PAGE/DEFAULT,folder/DEFAULT';
    const page = renderNode('page', rows, { subType: 'default', subtypeFilter });
    expect(page).toContain('<option value="Page^Default" selected>Page</option>');
    expect(page).toContain('<option value="Page^DEFAULT" selected>Page  / DEFAULT</option>');
    expect(page).toContain('<option value="Folder^Default" >Folder</option>');
    expect(page).not.toContain('Lower');
    expect(page).not.toContain('Product');
    expect(page).not.toContain('Calendar');
    // The Link branch also drops a subtype CFML reads as `Default`.
    const link = renderNode('Link', rows);
    expect(link).toContain('<option value="Link^Ext" >Link  / Ext</option> ');
    expect(link).not.toContain('Link^DEFAULT');
  });

  it("offers a non-admin an admin-only subtype only when it is the content's own", () => {
    const rows = [row('Page', 'Product', 1), row('Folder', 'Product', 1)];
    const own = renderNode('Page', rows, { subType: 'Product', req: requestFor('editor', { type: 'Page' }) });
    expect(own).toContain('<option value="Page^Product" selected>Page  / Product</option>');
    expect(own).not.toContain('Folder^Product');
    const other = renderNode('Page', rows, { req: requestFor('editor', { type: 'Page' }) });
    expect(other).not.toContain('^Product');
    expect(renderNode('Page', rows)).toContain('<option value="Folder^Product" >Folder  / Product</option>');
  });

  it('prints the installed theme path when programs-sites serves no site', () => {
    vi.stubEnv('MURA_CONTEXT', '/masa');
    resetLegacySettingsForTests();
    const req = unservedEditorRequest({ rc: { type: 'Page' } });
    expect(req.site).toBeUndefined();
    expect(renderNode('Page', [], { req })).toContain(",this.value,'default','/masa','/masa/themes/default');");
  });
});
