// cperm.cfc before(), controller secure(), the cperm views' Back and empty-group markup and dspZoom, against legacy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { secure, type GateDecision } from '@/lib/access-gate';
import { legacySettings } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  CONTENT_MODULE_ID,
  TOP_NODE_ID,
  cpermDefaults,
  cpermGate,
  htmlEditFormat,
  renderBackNav,
  renderIcon,
  renderNoGroups,
  renderZoom,
  type ZoomCrumb,
  type ZoomIconSource,
} from '@/screens/cperm/partials';
import { fragmentModel } from '../../helpers/dom-model';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

const MAIN = { circuit: 'cperm', item: 'main' } as const;
const ALLOW: GateDecision = { kind: 'allow' };
const REFERER = 'http://localhost/admin/?muraAction=cArch.list&siteid=default';
const COMPONENTS_MODULE_ID = '00000000000000000000000000000000003';
const NODE_ID = 'C1000000-0000-0000-0000000000000001';
const PARENT_ID = 'C1000000-0000-0000-0000000000000002';
const NO_GROUPS = 'There are currently no groups available.';

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The gate's decision for `req`, with how often it called `secure()`. */
async function gate(req: AdminRequest): Promise<{ decision: GateDecision; secureCalls: number }> {
  const spy = vi.fn(() => secure(req));
  const decision = await cpermGate(req, { secure: spy });
  return { decision, secureCalls: spy.mock.calls.length };
}

/** A Site Manager page crumb on `default`; `fields` overrides any member. */
const crumb = (contentid: string, menutitle: string, fields: Partial<ZoomCrumb> = {}): ZoomCrumb => ({
  menutitle,
  siteid: 'default',
  contentid,
  type: 'Page',
  restricted: 0,
  icon: 'mi-file',
  ...fields,
});

const HOME = crumb(TOP_NODE_ID, 'Home');

/** dspZoom's non-ajax `cArch.list` link of a crumb. */
function listHref(contentid: string, moduleid = CONTENT_MODULE_ID, siteid = 'default'): string {
  const { context, adminDir } = legacySettings();
  const query = `siteid=${siteid}&topid=${contentid}&moduleid=${moduleid}&activeTab=0`;
  return `${context}${adminDir}/?muraAction=cArch.list&${query}`;
}

/** The opening `<li>` tags of `markup`, root first. */
const itemTags = (markup: string): string[] => markup.match(/<li[^>]*>/g) ?? [];

describe('constants', () => {
  it('names the home node and the Site Manager module', () => {
    expect([TOP_NODE_ID, CONTENT_MODULE_ID]).toEqual([
      '00000000000000000000000000000000001',
      '00000000000000000000000000000000000',
    ]);
  });
});

describe('cpermGate', () => {
  it.each<[string, () => AdminRequest]>([
    ['S2', () => adminS2Request(MAIN)],
    [
      'the s2 claim alone',
      () => makeAdminRequest({ ...MAIN, user: { roles: [Roles.systemUser], s2: true } }, 'qaEditor'),
    ],
    ['the private-pool Admin', () => siteAdminRequest('tenant-a', MAIN)],
  ])('allows %s without secure()', async (_who, req) => {
    expect(await gate(req())).toEqual({ decision: ALLOW, secureCalls: 0 });
  });

  it.each<[string, AdminRequestPartial, string]>([
    ['without a referer to ./', {}, './'],
    [
      'whose rc claims S2 and Admin',
      { rc: { s2: '1', isS2: 'true', isAdmin: 'true', isSiteAdmin: 'true', memberships: 'S2,Admin;default;0' } },
      './',
    ],
    ['back to the referer', { headers: new Headers({ referer: REFERER }) }, REFERER],
  ])('secures the editor %s', async (_case, partial, location) => {
    expect(await gate(editorRequest({ ...MAIN, ...partial }))).toEqual({
      decision: { kind: 'redirect', location },
      secureCalls: 1,
    });
  });

  it('secures a system user without the Admin group', async () => {
    const req = makeAdminRequest({ ...MAIN, session: { siteid: 'tenant-a' } }, 'systemUser');
    expect(await gate(req)).toEqual({ decision: { kind: 'redirect', location: './' }, secureCalls: 1 });
  });

  it.each([
    ['false', {}],
    ['true', { compactDisplay: 'true' }],
  ])('sends anonymous users to the login form with compactDisplay=%s', async (compactDisplay, rc) => {
    const req = anonymousRequest({ ...MAIN, rc });
    const { decision, secureCalls } = await gate(req);
    expect(secureCalls).toBe(1);
    expect(decision).toEqual({
      kind: 'redirect',
      location:
        './?muraAction=cLogin.main&returnURL=http%3A%2F%2Flocalhost%2Fadmin%2F%3F%26muraAction%3Dcperm.main' +
        `&compactDisplay=${compactDisplay}`,
    });
  });
});

describe('cpermDefaults', () => {
  it('adds the before() params in order: startrow 1, topid left empty', () => {
    expect(Object.entries(cpermDefaults({}))).toEqual([
      ['parentid', ''],
      ['topid', ''],
      ['contentid', ''],
      ['body', ''],
      ['groupid', ''],
      ['url', ''],
      ['type', ''],
      ['startrow', '1'],
      ['siteid', ''],
      ['approvalExempt', ''],
      ['chainID', ''],
      ['exemptID', ''],
    ]);
  });

  it('keeps sent values under their own casing, matched case-insensitively', () => {
    const sent = { ContentID: 'C1', TOPID: 'T1', StartRow: '3' };
    const rc = cpermDefaults(sent);
    expect(Object.keys(rc)).toEqual([
      'ContentID',
      'TOPID',
      'StartRow',
      'parentid',
      'body',
      'groupid',
      'url',
      'type',
      'siteid',
      'approvalExempt',
      'chainID',
      'exemptID',
    ]);
    expect([rc['contentid'], rc['Contentid'], rc['topid'], rc['startrow']]).toEqual(['C1', 'C1', 'T1', '3']);
    expect(Object.keys(sent)).toEqual(['ContentID', 'TOPID', 'StartRow']);
  });

  it('fills an admin request rc without replacing its values', () => {
    const rc = cpermDefaults(editorRequest({ ...MAIN, rc: { contentid: 'C1' } }).rc);
    expect([rc['siteid'], rc['muraAction'], rc['contentid'], rc['startrow'], rc['groupid']]).toEqual([
      'default',
      'core:cperm.main',
      'C1',
      '1',
      '',
    ]);
    expect(Object.keys(rc).filter((name) => name.toLowerCase() === 'groupid')).toEqual(['groupID']);
  });

  it('is a read-only view', () => {
    const rc = cpermDefaults({ ContentID: 'C1' });
    expect(['CONTENTID' in rc, 'missing' in rc, Symbol.iterator in rc]).toEqual([true, false, false]);
    expect(Object.getOwnPropertyDescriptor(rc, 'contentId')).toEqual({
      value: 'C1',
      enumerable: true,
      configurable: true,
      writable: false,
    });
    expect(Object.getOwnPropertyDescriptor(rc, 'missing')).toBeUndefined();
    expect(Reflect.get(rc, Symbol.toPrimitive)).toBeUndefined();
    expect(Reflect.set(rc, 'contentid', 'X')).toBe(false);
    expect(Reflect.defineProperty(rc, 'extra', { value: 'X' })).toBe(false);
    expect(Reflect.deleteProperty(rc, 'contentid')).toBe(false);
    expect([rc['contentid'], rc['extra']]).toEqual(['C1', undefined]);
  });
});

describe('renderBackNav', () => {
  it('renders the Back group of the views with the en label', () => {
    expect(toString(renderBackNav(rbFor('en_US')))).toBe(
      '<div class="nav-module-specific btn-group">\n' +
        '    <a class="btn" href="#" title="Back" onclick="window.history.back(); return false;">' +
        '<i class="mi-arrow-circle-left"></i> Back</a>\n' +
        '  </div>',
    );
  });

  it('encodes the label as html_attr in the title and as html in the text', () => {
    const rbKey = vi.fn(() => 'Zurück & "weiter" <');
    const markup = toString(renderBackNav({ rbKey }));
    expect(rbKey).toHaveBeenCalledWith('sitemanager.back');
    expect(markup).toContain('title="Zur&uuml;ck&#x20;&amp;&#x20;&quot;weiter&quot;&#x20;&lt;"');
    expect(markup).toContain('</i> Zur&uuml;ck &amp; &quot;weiter&quot; &lt;</a>');
  });
});

describe('renderNoGroups', () => {
  it.each<[string, { leadingSpace?: boolean } | undefined, string]>([
    ['by default', undefined, `<div class="help-block-empty">${NO_GROUPS}</div>`],
    ['without leadingSpace', { leadingSpace: false }, `<div class="help-block-empty">${NO_GROUPS}</div>`],
    ['for cperm.main member groups', { leadingSpace: true }, `<div class="help-block-empty"> ${NO_GROUPS}</div>`],
  ])('renders the en notice %s', (_case, options, expected) => {
    expect(toString(renderNoGroups(rbFor('en_US'), options))).toBe(expected);
  });

  it('writes the label unencoded', () => {
    const rbKey = vi.fn(() => '<b>None</b> & more');
    expect(toString(renderNoGroups({ rbKey }))).toBe('<div class="help-block-empty"><b>None</b> & more</div>');
    expect(rbKey).toHaveBeenCalledWith('permissions.nogroups');
  });
});

describe('htmlEditFormat', () => {
  it.each([
    ['plain text', 'About Us', 'About Us'],
    ['markup', '<a href="x">R&D</a>', '&lt;a href=&quot;x&quot;&gt;R&amp;D&lt;/a&gt;'],
    ['an entity', '&amp;', '&amp;amp;'],
    ['line breaks', 'a\r\nb\rc\nd', 'a\nbc\nd'],
    ['apostrophes and non-ASCII', "Zoë's café", "Zoë's café"],
  ])('formats %s', (_case, input, expected) => {
    expect(htmlEditFormat(input)).toBe(expected);
  });
});

describe('renderIcon', () => {
  it.each<[string, ZoomIconSource, string]>([
    ['the extension icon class first', { iconClass: 'mi-star', type: 'File', fileExt: 'pdf' }, 'mi-star'],
    ['the lower-cased type', { iconClass: '', type: 'Page' }, 'page'],
    ['the lower-cased extension of a file', { iconClass: '', type: 'File', fileExt: 'PDF' }, 'pdf'],
    ['an extension for a type matched case-insensitively', { iconClass: '', type: 'FILE', fileExt: 'Doc' }, 'doc'],
    ['page for a file without fileExt', { iconClass: '', type: 'File' }, 'page'],
    ['an empty fileExt as given', { iconClass: '', type: 'File', fileExt: '' }, ''],
  ])('returns %s', (_case, source, expected) => {
    expect(renderIcon(source)).toBe(expected);
  });
});

describe('renderZoom', () => {
  it('renders the lone home crumb byte for byte as legacy does', () => {
    const markup = renderZoom([HOME]);
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(
      '<ul class="breadcrumb">\n\t\t\n\t\t<li class=""><strong>\n\t\t<a \n\t\t\thref="' +
        listHref(TOP_NODE_ID) +
        '"\n\t\t><i class="mi-file"></i>Home</a></strong></li>\n\t\t</ul>',
    );
  });

  it('renders root to node with the node in <strong>, locks after a restricted crumb and escapes titles', () => {
    const node = crumb(NODE_ID, 'R&D <Team>');
    const parent = crumb(PARENT_ID, 'Private "Area"', { type: 'Folder', icon: 'mi-folder', restricted: 1 });
    const markup = toString(renderZoom([node, parent, HOME]));
    expect(markup).toBe(
      [
        '<ul class="breadcrumb">\n\t\t',
        '\n\t\t\t<li class="">\n\t\t\t<a \n\t\t\t\thref="',
        listHref(TOP_NODE_ID),
        '"\n\t\t\t><i class="mi-file"></i>Home</a></li>\n\t\t',
        '\n\t\t\t<li class="locked">\n\t\t\t<a \n\t\t\t\thref="',
        listHref(PARENT_ID),
        '"\n\t\t\t><i class="mi-folder"></i>Private &quot;Area&quot;</a></li>\n\t\t',
        '\n\t\t<li class="locked"><strong>\n\t\t<a \n\t\t\thref="',
        listHref(NODE_ID),
        '"\n\t\t><i class="mi-file"></i>R&amp;D &lt;Team&gt;</a></strong></li>\n\t\t</ul>',
      ].join(''),
    );
    expect(fragmentModel(markup).links.map((link) => link.text)).toEqual(['Home', 'Private "Area"', 'R&D <Team>']);
  });

  it.each<[string, readonly number[], readonly string[]]>([
    ['keeps the lock on every crumb after a restricted ancestor', [0, 0, 1, 0], ['', 'locked', 'locked', 'locked']],
    ['locks everything below a restricted root', [0, 1], ['locked', 'locked']],
    ['does not lock a restricted node itself', [1, 0, 0], ['', '', '']],
    ['locks nothing without a restricted crumb', [0, 0], ['', '']],
  ])('%s', (_case, restrictedNodeFirst, classesRootFirst) => {
    const crumbs = restrictedNodeFirst.map((restricted, i) => crumb(`C${i}`, `Crumb ${i}`, { restricted }));
    const classes = itemTags(toString(renderZoom(crumbs))).map((tag) => /class="([^"]*)"/.exec(tag)?.[1]);
    expect(classes).toEqual(classesRootFirst);
  });

  it.each<[string, Partial<ZoomCrumb>, string]>([
    ['a file icon', { type: 'File', icon: 'pdf' }, '<li class=" file" data-filetype="pdf">'],
    ['the first four icon characters', { type: 'File', icon: 'jpeg2000' }, '<li class=" file" data-filetype="jpeg">'],
    ['a type matched case-insensitively', { type: 'FILE', icon: 'doc' }, '<li class=" file" data-filetype="doc">'],
    ['an empty icon', { type: 'File', icon: '' }, '<li class=" file" data-filetype="">'],
    ['an mi- icon as no file', { type: 'File', icon: 'mi-file-pdf' }, '<li class="">'],
    ['an MI- icon as no file', { type: 'File', icon: 'MI-file' }, '<li class="">'],
    ['the first non-empty icon part', { type: 'File', icon: '-mi-file' }, '<li class="">'],
    ['a page with a file icon as no file', { type: 'Page', icon: 'pdf' }, '<li class="">'],
  ])('tags %s on an ancestor and on the node', (_case, fields, tag) => {
    const file = crumb(NODE_ID, 'Report', fields);
    expect(itemTags(toString(renderZoom([file, file, HOME])))).toEqual(['<li class="">', tag, tag]);
  });

  it('combines the lock with the file class', () => {
    const file = crumb(NODE_ID, 'Report', { type: 'File', icon: 'pdf' });
    const locked = crumb(PARENT_ID, 'Private', { restricted: 1 });
    expect(itemTags(toString(renderZoom([file, locked])))).toEqual([
      '<li class="locked">',
      '<li class="locked file" data-filetype="pdf">',
    ]);
  });

  it('links each crumb to its own module, defaulting to Site Manager, with ids and class unencoded', () => {
    const component = crumb(NODE_ID, 'Footer', {
      siteid: 'my site',
      moduleid: COMPONENTS_MODULE_ID,
      type: 'Component',
      icon: 'mi-cube',
    });
    const markup = toString(renderZoom([component, crumb(COMPONENTS_MODULE_ID, 'Components', { siteid: 'my site' })], {
      className: 'mura-breadcrumb crumbs',
    }));
    expect(markup.startsWith('<ul class="mura-breadcrumb crumbs">')).toBe(true);
    expect(Array.from(markup.matchAll(/href="([^"]*)"/g), (m) => m[1])).toEqual([
      listHref(COMPONENTS_MODULE_ID, CONTENT_MODULE_ID, 'my site'),
      listHref(NODE_ID, COMPONENTS_MODULE_ID, 'my site'),
    ]);
  });

  it('throws on an empty crumb list', () => {
    expect(() => renderZoom([])).toThrow(RangeError);
  });
});
