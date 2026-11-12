// Admin markup primitives against legacy output: ESAPI vectors from esapi-2.5.1.0.jar (the encoder ACF 2023.0.26
// ships), breadcrumbs and Site Manager values captured from carch.loadsitemanager and carch.edit on Masa 7.6.1.
import { describe, expect, it } from 'vitest';
import * as contentUrls from '../../src/legacy/content-urls.js';
import {
  buildCustomIconLookup,
  cfHtmlEditFormat,
  createAdminLabels,
  esapiEncode,
  getNextN,
  iconClass,
  isFileIcon,
  isS2,
  isSiteAdmin,
  lsDateFormat,
  lsTimeFormat,
  newContentPerm,
  nodeIconClass,
  renderCsrfTokensForm,
  renderCsrfTokensUrl,
  renderZoom,
  yesNoFormat,
  type NodePerm,
  type ZoomCrumb,
} from '../../src/legacy/admin-markup.js';

const HOME_ID = '00000000000000000000000000000000001';
const SITE_MODULE = '00000000000000000000000000000000000';

describe('esapiEncode', () => {
  it.each([
    [
      "<script>alert('x')</script>",
      '&lt;script&gt;alert&#x28;&#x27;x&#x27;&#x29;&lt;&#x2f;script&gt;',
      '&lt;script&gt;alert&#x28;&#x27;x&#x27;&#x29;&lt;&#x2f;script&gt;',
      '\\x3Cscript\\x3Ealert\\x28\\x27x\\x27\\x29\\x3C\\x2Fscript\\x3E',
      '%3Cscript%3Ealert%28%27x%27%29%3C%2Fscript%3E',
    ],
    ['a b', 'a b', 'a&#x20;b', 'a\\x20b', 'a+b'],
    ['\u{1F600}', '&#x1f600;', '&#x1f600;', '\u{1F600}', '%F0%9F%98%80'],
    ['x\uD83D', 'x&#xd83d;', 'x&#xd83d;', 'x\\uD83D', 'x%3F'],
    ['\u{10020}', '\u{10020}', '&#x10020;', '\u{10020}', '%F0%90%80%A0'],
    ['\u{1002C}\u{10041}', '\u{1002C}&#x10041;', '\u{1002C}&#x10041;', '\u{1002C}\u{10041}', '%F0%90%80%AC%F0%90%81%81'],
    [
      'caf\u00e9 \u00a0\u00ff\u0100',
      'caf&eacute; &nbsp;&yuml;&#x100;',
      'caf&eacute;&#x20;&nbsp;&yuml;&#x100;',
      'caf\\xE9\\x20\\xA0\\xFF\\u0100',
      'caf%C3%A9+%C2%A0%C3%BF%C4%80',
    ],
    [
      '\u0000\u0001\t\n\r\u007f\u0080\u009f\u00a0',
      '&#xfffd;&#xfffd;&#x9;&#xa;&#xd;&#xfffd;&#xfffd;&#xfffd;&nbsp;',
      '&#xfffd;&#xfffd;&#x9;&#xa;&#xd;&#xfffd;&#xfffd;&#xfffd;&nbsp;',
      '\\x00\\x01\\x09\\x0A\\x0D\\x7F\\x80\\x9F\\xA0',
      '%00%01%09%0A%0D%7F%C2%80%C2%9F%C2%A0',
    ],
    [
      'Tom & "Jerry" / 50%',
      'Tom &amp; &quot;Jerry&quot; &#x2f; 50&#x25;',
      'Tom&#x20;&amp;&#x20;&quot;Jerry&quot;&#x20;&#x2f;&#x20;50&#x25;',
      'Tom\\x20\\x26\\x20\\x22Jerry\\x22\\x20\\x2F\\x2050\\x25',
      'Tom+%26+%22Jerry%22+%2F+50%25',
    ],
    ['\u4e2d\u6587', '&#x4e2d;&#x6587;', '&#x4e2d;&#x6587;', '\\u4E2D\\u6587', '%E4%B8%AD%E6%96%87'],
    ['\ufffe\uffff', '&#xfffe;&#xffff;', '&#xfffe;&#xffff;', '\\uFFFE\\uFFFF', '%EF%BF%BE%EF%BF%BF'],
    ['a,b.c-d_e f', 'a,b.c-d_e f', 'a,b.c-d_e&#x20;f', 'a,b.c\\x2Dd_e\\x20f', 'a%2Cb.c-d_e+f'],
    ['\u2014\u20ac\u2666\u03a9', '&mdash;&euro;&diams;&Omega;', '&mdash;&euro;&diams;&Omega;', '\\u2014\\u20AC\\u2666\\u03A9', '%E2%80%94%E2%82%AC%E2%99%A6%CE%A9'],
    ['', '', '', '', ''],
  ])('encodes %j for html, html_attr, javascript and url', (input, html, htmlAttr, javascript, url) => {
    expect(esapiEncode('html', input)).toBe(html);
    expect(esapiEncode('html_attr', input)).toBe(htmlAttr);
    expect(esapiEncode('javascript', input)).toBe(javascript);
    expect(esapiEncode('url', input)).toBe(url);
  });

  it('matches values captured from admin fragments', () => {
    expect(esapiEncode('javascript', '6300ED69-1320-5CC3-F922E3012E2C6BAE')).toBe('6300ED69\\x2D1320\\x2D5CC3\\x2DF922E3012E2C6BAE');
    expect(esapiEncode('html_attr', 20)).toBe('20');
    expect(esapiEncode('html', null)).toBe('');
  });

  it('re-exports the single cfHtmlEditFormat implementation', () => {
    expect(cfHtmlEditFormat).toBe(contentUrls.cfHtmlEditFormat);
  });
});

describe('yesNoFormat', () => {
  it.each([
    [1, 'Yes'],
    [0, 'No'],
    [true, 'Yes'],
    ['no', 'No'],
    ['', 'No'],
    [null, 'No'],
  ] as const)('formats %j as %s', (value, expected) => {
    expect(yesNoFormat(value)).toBe(expected);
  });

  it('throws for a value CF cannot read as boolean', () => {
    expect(() => yesNoFormat('maybe')).toThrow(TypeError);
  });
});

describe('createAdminLabels', () => {
  const labels = createAdminLabels(
    {
      'sitemanager.yes': 'Yes',
      'sitemanager.paginationmeta': 'Showing {1} of {2} Results',
      'x.quote': "Don''t",
      'both.key': 'site',
    },
    { 'only.en': 'English', 'both.key': 'core' },
  );

  it('looks keys up case-insensitively, un-doubles quotes and falls back to en_US', () => {
    expect(labels.key('SiteManager.YES')).toBe('Yes');
    expect(labels.key('x.quote')).toBe("Don't");
    expect(labels.key('only.en')).toBe('English');
    expect(labels.key('both.key')).toBe('site');
    expect(labels.key('sitemanager.nope')).toBe('sitemanager.nope_missing');
  });

  it.each([
    ['Showing {1} of {2} Results', ['1-20', 5000], 'Showing 1-20 of 5,000 Results'],
    ["Deleting '{1}' will also delete all content nested beneath it", 'Home', "Deleting 'Home' will also delete all content nested beneath it"],
    ['{1} and {2}', 'a,,b', 'a and b'],
    ['[{0}] {1} {3}', ['x'], '[] x {3}'],
    ['{1}/{2}/{3}', [null, true, 1234.5678], 'null/true/1,234.568'],
    ['{01}{+2}{1,}', ['a', 'b'], 'aba'],
    ['}{1}', 'x', '}x'],
  ])('formats %j with %j', (pattern, args, expected) => {
    expect(labels.messageFormat(pattern, args)).toBe(expected);
  });

  it('groups numbers for the bundle locale', () => {
    expect(createAdminLabels({}, {}, 'de_DE').messageFormat('{1}', [5000])).toBe('5.000');
  });

  it.each([
    ['{1', 'Unmatched braces in the pattern.'],
    ['{1,number}', 'Unsupported MessageFormat element {1,number}'],
    ['{x}', "can't parse argument number: x"],
    ['{ 1}', "can't parse argument number:  1"],
    ['{9999999999}', "can't parse argument number: 9999999999"],
    ['{-1}', 'negative argument number: -1'],
  ])('rejects %j as Java MessageFormat does', (pattern, message) => {
    expect(() => labels.messageFormat(pattern, ['a'])).toThrow(message);
  });

  it('rejects argument types MessageFormat would format as dates or objects', () => {
    expect(() => labels.messageFormat('{1}', [new Date(0)])).toThrow(TypeError);
  });
});

describe('session membership checks', () => {
  const session = { memberships: 'S2IsPrivate;default,S2,Admin;default;0,Editor;default;0' };

  it('finds S2 and the site Admin group as exact list items', () => {
    expect(isS2(session)).toBe(true);
    expect(isS2({ memberships: 's2,S2IsPrivate;default' })).toBe(false);
    expect(isSiteAdmin(session, 'default')).toBe(true);
    expect(isSiteAdmin(session, 'tenant-a')).toBe(false);
  });
});

describe('CSRF and date fragments', () => {
  const tokens = { token: 'F'.repeat(64), expires: '261112125429677' };

  it('prints tokens as renderCSRFTokens does', () => {
    expect(renderCsrfTokensUrl(tokens)).toBe(`&csrf_token=${tokens.token}&csrf_token_expires=${tokens.expires}`);
    expect(renderCsrfTokensForm(tokens)).toBe(
      `<input type="hidden" name="csrf_token" value="${tokens.token}" /><input type="hidden" name="csrf_token_expires" value="${tokens.expires}" />`,
    );
  });

  it('prints the Site Manager updated cell with the session date mask', () => {
    const lastUpdate = new Date(2026, 10, 10, 9, 6, 0);
    expect(`${lsDateFormat(lastUpdate, 'MM/DD/YYYY')} ${lsTimeFormat(lastUpdate, 'short')}`).toBe('11/314/2026 9:06 AM');
    expect(lsDateFormat(lastUpdate, 'short')).toBe('11/10/26');
    expect(lsDateFormat(null, 'short')).toBe('');
    expect(lsTimeFormat(null, 'short')).toBe('');
  });
});

describe('getNextN', () => {
  it.each([
    [95, 20, 41, 2, { numberOfPages: 5, currentPageNumber: 3, firstPage: 1, lastPage: 5, next: 61, previous: 21, through: 60 }],
    [95, 20, 81, 2, { numberOfPages: 5, currentPageNumber: 5, firstPage: 1, lastPage: 5, next: 1, previous: 61, through: 95 }],
    [30, 20, 1, 5, { numberOfPages: 2, currentPageNumber: 1, firstPage: 1, lastPage: 2, next: 21, previous: 1, through: 20 }],
    [1000, 10, 501, 5, { numberOfPages: 100, currentPageNumber: 51, firstPage: 46, lastPage: 56, next: 511, previous: 491, through: 510 }],
    [0, 20, 1, 2, { numberOfPages: 0, currentPageNumber: 1, firstPage: 1, lastPage: 0, next: 1, previous: 1, through: 0 }],
  ])('pages %i records by %i from row %i (buffer %i)', (records, perPage, startRow, buffer, expected) => {
    expect(getNextN(records, perPage, startRow, buffer)).toEqual({
      totalRecords: records,
      recordsPerPage: perPage,
      startRow,
      ...expected,
    });
  });

  it('defaults the page buffer to 5', () => {
    expect(getNextN(1000, 10, 501)).toEqual(getNextN(1000, 10, 501, 5));
  });

  it('fails like CF on zero rows per page', () => {
    expect(() => getNextN(10, 0, 1)).toThrow('Division by zero is not allowed.');
  });
});

describe('icons', () => {
  const lookup = buildCustomIconLookup([
    { siteid: 'default', type: 'Page', subtype: 'Landing', iconclass: 'icon-star icon-x' },
    { siteid: 'default', type: 'Component', subtype: 'Default', iconclass: 'mi-ignored' },
    { siteid: 'default', type: 'File', subtype: 'Report', iconclass: 'pdf' },
    { siteid: 'default', type: 'Link', subtype: 'Default', iconclass: 'mi-first' },
    { siteid: 'default', type: 'link', subtype: 'default', iconclass: 'mi-second' },
    { siteid: null, type: null, subtype: null, iconclass: null },
  ]);

  it('builds the extendManager lookup', () => {
    expect(lookup('DEFAULT', 'page', 'landing')).toBe('mi-star icon-x');
    expect(lookup('default', 'Component', 'Default')).toBe('');
    expect(lookup('default', 'Link', 'Default')).toBe('mi-second');
    expect(lookup('tenant-a', 'Page', 'Landing')).toBe('');
  });

  it.each([
    ['Page', 'Landing', 'mi-star icon-x'],
    ['Page', 'Default', 'mi-file'],
    ['FOLDER', null, 'mi-folder-open-o'],
    ['File', 'Default', 'mi-file-text-o'],
    ['Gallery', null, 'mi-th'],
    ['Form', null, 'mi-toggle-on'],
    ['Component', null, 'mi-align-justify'],
    ['Variation', null, 'mi-cloud'],
    ['Calendar', null, 'mi-calendar'],
    ['2', null, 'mi-user'],
    ['1', null, 'mi-group'],
    ['constructor', null, 'mi-cog'],
    [null, null, 'mi-cog'],
  ])('renders the icon of type %j subtype %j as %s', (type, subtype, expected) => {
    expect(iconClass(lookup, { siteid: 'default', type, subtype })).toBe(expected);
  });

  it.each([
    [{ type: 'Page', subtype: 'Default', fileext: null }, '', false, 'icon-mura-page Default'],
    [{ type: 'Link', subtype: null, fileext: null }, '', true, 'icon-mura-link locked '],
    [{ type: 'Page', subtype: 'Landing', fileext: null }, 'mi-star', true, 'mi-star locked Landing'],
    [{ type: 'File', subtype: 'Default', fileext: 'PDF' }, '', true, 'pdf locked'],
    [{ type: 'file', subtype: 'Report', fileext: 'pdf' }, 'doc', false, 'doc'],
    [{ type: 'File', subtype: 'Default', fileext: null }, '', false, ''],
  ])('chooses the Site Manager node icon of %j', (row, customIconClass, restricted, expected) => {
    expect(nodeIconClass(row, { customIconClass, restricted })).toBe(expected);
  });

  it.each([
    ['File', 'report.PDF', 'pdf', true],
    ['File', 'photo.JPG', 'jpg', false],
    ['File', 'report.pdf', 'icon-mura-file', false],
    ['File', null, '', true],
    ['File', 'archive.', 'zip', true],
    ['Page', 'report.pdf', 'pdf', false],
  ])('decides isFileIcon for a %s row with file %j and icon %j', (type, assocfilename, icon, expected) => {
    expect(isFileIcon({ type, assocfilename }, icon)).toBe(expected);
  });
});

describe('renderZoom', () => {
  const home: ZoomCrumb = {
    siteid: 'default',
    contentid: HOME_ID,
    moduleid: SITE_MODULE,
    type: 'Page',
    subtype: 'Default',
    menutitle: 'Home',
    restricted: 0,
  };

  it('reproduces the captured Site Manager breadcrumb (ajax)', () => {
    expect(renderZoom([home], { ajax: true, class: 'breadcrumb' })).toBe(
      '<ul class="breadcrumb">\n\t\t\n\t\t<li class=""><strong>\n\t\t<a \n\t\t\thref="" onclick="return siteManager.' +
        "loadSiteManagerInTab(function(){siteManager.loadSiteManager('default','00000000000000000000000000000000001'," +
        "'00000000000000000000000000000000000','','','Page',1)});\"\n\t\t><i class=\"mi-file\"></i>Home</a></strong></li>" +
        '\n\t\t</ul>',
    );
  });

  it('reproduces the captured edit-screen breadcrumb (links)', () => {
    expect(renderZoom([home])).toBe(
      '<ul class="breadcrumb">\n\t\t\n\t\t<li class=""><strong>\n\t\t<a \n\t\t\thref="/admin/?muraAction=cArch.list&siteid=' +
        'default&topid=00000000000000000000000000000000001&moduleid=00000000000000000000000000000000000&activeTab=0"' +
        '\n\t\t><i class="mi-file"></i>Home</a></strong></li>\n\t\t</ul>',
    );
  });

  it('prints ancestors first with the loop whitespace, sticky locking and file icons', () => {
    const about: ZoomCrumb = {
      siteid: 'default',
      contentid: 'A1',
      type: 'Folder',
      subtype: 'Default',
      menutitle: 'About & "Us"',
      restricted: 1,
    };
    const report: ZoomCrumb = { ...home, contentid: 'R1', moduleid: null, type: 'File', subtype: 'Report', menutitle: '<Q3>', restricted: 0 };
    const customIcons = buildCustomIconLookup([{ siteid: 'default', type: 'File', subtype: 'Report', iconclass: 'pdf-icon' }]);
    expect(renderZoom([report, about, home], { customIcons, context: '/cms', adminDir: '/manage' })).toBe(
      '<ul class="breadcrumb">\n\t\t' +
        '\n\t\t\t<li class="">\n\t\t\t<a \n\t\t\t\thref="/cms/manage/?muraAction=cArch.list&siteid=default&topid=' +
        `${HOME_ID}&moduleid=${SITE_MODULE}&activeTab=0"\n\t\t\t><i class="mi-file"></i>Home</a></li>\n\t\t` +
        '\n\t\t\t<li class="locked">\n\t\t\t<a \n\t\t\t\thref="/cms/manage/?muraAction=cArch.list&siteid=default&topid=A1' +
        `&moduleid=${SITE_MODULE}&activeTab=0"\n\t\t\t><i class="mi-folder-open-o"></i>About &amp; &quot;Us&quot;</a></li>\n\t\t` +
        '\n\t\t<li class="locked file" data-filetype="pdf-"><strong>\n\t\t<a \n\t\t\thref="/cms/manage/?muraAction=cArch.list' +
        '&siteid=default&topid=R1&moduleid=&activeTab=0"\n\t\t><i class="pdf-icon"></i>&lt;Q3&gt;</a></strong></li>\n\t\t</ul>',
    );
  });

  it('needs at least one crumb, as dspZoom reads crumbdata[1]', () => {
    expect(() => renderZoom([])).toThrow(RangeError);
  });
});

describe('newContentPerm', () => {
  it.each<[string | undefined, NodePerm, string, NodePerm]>([
    [HOME_ID, 'editor', 'none', 'editor'],
    [HOME_ID, 'editor', 'top', 'read'],
    [HOME_ID, 'none', 'top', 'none'],
    [HOME_ID, 'deny', 'none', 'deny'],
    ['A1', 'author', 'top', 'author'],
    ['A1', 'author', 'ALL', 'read'],
    [undefined, 'editor', 'top', 'editor'],
    [undefined, 'editor', '', 'editor'],
    [undefined, 'none', 'all', 'none'],
  ])('top %j with perm %s and locking %j gives %s', (topId, perm, locking, expected) => {
    expect(newContentPerm(topId, perm, locking)).toBe(expected);
  });
});
