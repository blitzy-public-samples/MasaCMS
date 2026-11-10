import { describe, expect, it } from 'vitest';
import {
  ADMIN_HOME_ACTION,
  ADMIN_LOGIN_REDIRECT,
  ADMIN_LOGIN_REDIRECT_ACTION,
  ADMIN_NOACCESS,
  ADMIN_NOACCESS_ACTION,
  type AdminParam,
  type AdminUrlOptions,
  type ParsedAdminUrl,
  adminUrl,
  esapiUrlEncode,
  fallbackSiteId,
  htmlAttr,
  parseAdminUrl,
} from '../../src/legacy-compat/admin-url.js';

describe('access-gate actions', () => {
  it('names the FW/1 home action without its subsystem', () => {
    expect(ADMIN_HOME_ACTION).toBe('home.redirect');
  });

  it('sends users without site access to clogin.logout', () => {
    expect(ADMIN_LOGIN_REDIRECT).toEqual({ circuit: 'clogin', action: 'logout' });
    expect(ADMIN_LOGIN_REDIRECT_ACTION).toBe('clogin.logout');
  });

  it('sends unauthorised users to cMessage.noaccess', () => {
    expect(ADMIN_NOACCESS).toEqual({ circuit: 'cMessage', action: 'noaccess' });
    expect(ADMIN_NOACCESS_ACTION).toBe('cMessage.noaccess');
  });

  it('freezes the gate targets', () => {
    expect(Object.isFrozen(ADMIN_LOGIN_REDIRECT)).toBe(true);
    expect(Object.isFrozen(ADMIN_NOACCESS)).toBe(true);
  });

  it.each([
    { target: ADMIN_LOGIN_REDIRECT, expected: '/admin/?muraAction=clogin.logout' },
    { target: ADMIN_NOACCESS, expected: '/admin/?muraAction=cMessage.noaccess' },
  ])('builds the legacy gate location $expected', ({ target, expected }) => {
    expect(adminUrl({ ...target })).toBe(expected);
  });
});

describe('esapiUrlEncode', () => {
  it.each([
    ['an empty string', '', ''],
    ['letters, digits and . - * _', 'AZaz09.-*_', 'AZaz09.-*_'],
    ['a space', 'my site', 'my+site'],
    ['a plus sign', 'a+b', 'a%2Bb'],
    ['URL delimiters', '&=?#/%', '%26%3D%3F%23%2F%25'],
    ['ASCII just outside the safe ranges', '/:@[`{', '%2F%3A%40%5B%60%7B'],
    ['characters JavaScript leaves unescaped', "~!'()", '%7E%21%27%28%29'],
    ['control characters', '\u0000\n\u007f', '%00%0A%7F'],
    ['two-byte code points', '\u0080\u00e9\u07ff', '%C2%80%C3%A9%DF%BF'],
    ['three-byte code points', '\u0800\u20ac\uffff', '%E0%A0%80%E2%82%AC%EF%BF%BF'],
    ['four-byte code points', '\u{10000}\u{1f600}', '%F0%90%80%80%F0%9F%98%80'],
    ['a lone high surrogate', 'a\ud800b', 'a%3Fb'],
    ['a lone low surrogate', '\udfff', '%3F'],
  ])('encodes %s', (_label, input, expected) => {
    expect(esapiUrlEncode(input)).toBe(expected);
  });
});

describe('htmlAttr', () => {
  it.each([
    ['a&b&&c', 'a&amp;b&amp;&amp;c'],
    ['&amp;', '&amp;amp;'],
    ['<a href="x">\'y\'</a>', '<a href="x">\'y\'</a>'],
    ['', ''],
  ])('escapes only ampersands in %j', (input, expected) => {
    expect(htmlAttr(input)).toBe(expected);
  });
});

describe('adminUrl', () => {
  const cases: Array<{ label: string; options: AdminUrlOptions; expected: string }> = [
    {
      label: 'defaults to /admin with no context and no parameters',
      options: { circuit: 'cArch', action: 'list' },
      expected: '/admin/?muraAction=cArch.list',
    },
    {
      label: 'keeps the case of circuit and action',
      options: { circuit: 'cUsers', action: 'editUser' },
      expected: '/admin/?muraAction=cUsers.editUser',
    },
    {
      label: 'prefixes the context and uses the configured admin directory',
      options: { circuit: 'cLogin', action: 'main', context: '/masa', adminDir: '/manage' },
      expected: '/masa/manage/?muraAction=cLogin.main',
    },
    {
      label: 'allows an empty admin directory',
      options: { circuit: 'cLogin', action: 'main', adminDir: '' },
      expected: '/?muraAction=cLogin.main',
    },
    {
      label: 'appends url-encoded parameters in order, repeats included',
      options: {
        circuit: 'cArch',
        action: 'list',
        params: [
          ['siteid', 'my site & co'],
          ['tag', 'a'],
          ['tag', 'é', 'url'],
          ['empty', ''],
        ],
      },
      expected: '/admin/?muraAction=cArch.list&siteid=my+site+%26+co&tag=a&tag=%C3%A9&empty=',
    },
    {
      label: 'interpolates raw parameters as given',
      options: {
        circuit: 'cLogin',
        action: 'main',
        params: [['returnURL', '/admin/?muraAction=cArch.list&siteid=default', 'raw']],
      },
      expected: '/admin/?muraAction=cLogin.main&returnURL=/admin/?muraAction=cArch.list&siteid=default',
    },
    {
      label: 'stringifies numeric values',
      options: {
        circuit: 'cDashboard',
        action: 'main',
        params: [
          ['span', 30],
          ['ratio', 1.5],
        ],
      },
      expected: '/admin/?muraAction=cDashboard.main&span=30&ratio=1.5',
    },
    {
      label: 'joins parameters with &amp; for HTML attributes',
      options: {
        circuit: 'cDashboard',
        action: 'main',
        params: [
          ['siteid', 'default'],
          ['span', 30],
        ],
        html: true,
      },
      expected: '/admin/?muraAction=cDashboard.main&amp;siteid=default&amp;span=30',
    },
    {
      label: 'adds no separator in HTML mode without parameters',
      options: { circuit: 'cArch', action: 'list', html: true },
      expected: '/admin/?muraAction=cArch.list',
    },
  ];

  it.each(cases)('$label', ({ options, expected }) => {
    expect(adminUrl(options)).toBe(expected);
  });
});

describe('parseAdminUrl', () => {
  it.each([
    ['a path without a query', '/admin/'],
    ['a query only after the fragment', '/admin/#?muraAction=cArch.list'],
    ['a query without an action', '/admin/?siteid=default'],
    ['an empty action', '/admin/?muraAction='],
    ['a subsystem without an action', '/admin/?muraAction=core:'],
    ['an action of dots only', '/admin/?muraAction=...'],
  ])('returns undefined for %s', (_label, href) => {
    expect(parseAdminUrl(href)).toBeUndefined();
  });

  const cases: Array<{ label: string; href: string; expected: ParsedAdminUrl }> = [
    {
      label: 'reads circuit, action and parameters, ignoring the fragment',
      href: 'http://localhost:8080/admin/?muraAction=cArch.list&siteid=default#tabBasic',
      expected: { circuit: 'cArch', action: 'list', params: [['siteid', 'default']] },
    },
    {
      label: 'accepts &amp; separators',
      href: '/admin/?muraAction=cDashboard.main&amp;siteid=default&amp;span=30',
      expected: {
        circuit: 'cDashboard',
        action: 'main',
        params: [
          ['siteid', 'default'],
          ['span', '30'],
        ],
      },
    },
    {
      label: 'drops the subsystem before the last colon',
      href: '/admin/?muraAction=a:core:cUsers.list',
      expected: { circuit: 'cUsers', action: 'list', params: [] },
    },
    {
      label: 'defaults the action of a bare circuit',
      href: '/admin/?muraAction=cArch',
      expected: { circuit: 'cArch', action: 'default', params: [] },
    },
    {
      label: 'takes the first and last parts of a dotted action',
      href: '/admin/?muraAction=..cArch.edit..extra.',
      expected: { circuit: 'cArch', action: 'extra', params: [] },
    },
    {
      label: 'decodes the action value',
      href: '/admin/?muraAction=cArch%2Elist',
      expected: { circuit: 'cArch', action: 'list', params: [] },
    },
    {
      label: 'lets fuseaction override an earlier muraAction',
      href: '/admin/?muraAction=cArch.list&fuseaction=cUsers.list&siteid=default',
      expected: { circuit: 'cUsers', action: 'list', params: [['siteid', 'default']] },
    },
    {
      label: 'lets fuseaction override a later muraAction',
      href: '/admin/?fuseaction=cUsers.list&muraAction=cArch.list',
      expected: { circuit: 'cUsers', action: 'list', params: [] },
    },
    {
      label: 'matches action names case-insensitively and keeps other names as written',
      href: '/admin/?MURAACTION=cArch.list&FuseAction=cPerm.main&SiteID=default',
      expected: { circuit: 'cPerm', action: 'main', params: [['SiteID', 'default']] },
    },
    {
      label: 'joins repeated action values with commas before resolving',
      href: '/admin/?muraAction=cArch.list&muraaction=cUsers.edit',
      expected: { circuit: 'cArch', action: 'edit', params: [] },
    },
    {
      label: 'keeps a name without = as an empty value and skips empty segments',
      href: '/admin/?&&muraAction=cArch.list&&compactDisplay&siteid=default&',
      expected: {
        circuit: 'cArch',
        action: 'list',
        params: [
          ['compactDisplay', ''],
          ['siteid', 'default'],
        ],
      },
    },
    {
      label: 'splits each parameter at its first =',
      href: '/admin/?muraAction=cLogin.main&returnURL=a=b',
      expected: { circuit: 'cLogin', action: 'main', params: [['returnURL', 'a=b']] },
    },
    {
      label: 'form-decodes values',
      href: '/admin/?muraAction=cArch.search&q=my+site+%26+co&e=%C3%A9',
      expected: {
        circuit: 'cArch',
        action: 'search',
        params: [
          ['q', 'my site & co'],
          ['e', 'é'],
        ],
      },
    },
    {
      label: 'keeps a malformed percent sequence as written, plus signs still spaced',
      href: '/admin/?muraAction=cArch.search&p=100%&r=a+%E0%A4%A',
      expected: {
        circuit: 'cArch',
        action: 'search',
        params: [
          ['p', '100%'],
          ['r', 'a %E0%A4%A'],
        ],
      },
    },
  ];

  it.each(cases)('$label', ({ href, expected }) => {
    expect(parseAdminUrl(href)).toEqual(expected);
  });

  const params: AdminParam[] = [
    ['siteid', 'my site'],
    ['q', 'a&b=c#d?e+f%g'],
    ['name', 'é€😀'],
    ['span', 30],
    ['empty', ''],
  ];

  it.each([false, true])('inverts adminUrl when html is %s', (html) => {
    const href = adminUrl({ circuit: 'cUsers', action: 'editUser', params, context: '/masa', adminDir: '/manage', html });
    expect(parseAdminUrl(href)).toEqual({
      circuit: 'cUsers',
      action: 'editUser',
      params: params.map(([name, value]) => [name, String(value)]),
    });
  });
});

describe('fallbackSiteId', () => {
  const known = new Set(['default', 'site2']);

  it.each([
    { label: 'a known site id', siteid: 'site2', expected: 'site2', checked: ['site2'] },
    { label: 'an unknown site id', siteid: 'missing', expected: 'default', checked: ['missing'] },
    { label: 'an empty site id', siteid: '', expected: 'default', checked: [] },
    { label: 'no site id', siteid: undefined, expected: 'default', checked: [] },
  ])('resolves $label to $expected', ({ siteid, expected, checked }) => {
    const seen: string[] = [];
    const siteExists = (id: string): boolean => {
      seen.push(id);
      return known.has(id);
    };
    expect(fallbackSiteId(siteid, siteExists)).toBe(expected);
    expect(seen).toEqual(checked);
  });
});
