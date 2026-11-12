/** Masa user and address validation, requestHasRestrictedFiles and the errors struct, against outcomes observed on ACF 2023. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cfHash } from '@opt2/platform/legacy-compat';
import { USER_BEAN_DEFAULTS } from '../../src/domain/person.js';
import {
  FM_ALLOWED_EXTENSIONS,
  FM_PUBLIC_ALLOWED_EXTENSIONS,
  PEOPLE_MESSAGES,
  hasErrors,
  mergeUserErrors,
  requestHasRestrictedFiles,
  validateAddressValues,
  validatePersonValues,
  type RestrictedFilesOptions,
} from '../../src/domain/validation.js';

const CAPTCHA_KEY = 'captcha-key';
// hash('captcha-key', 'CFMX_COMPAT') as ACF 2023 returned it.
const CAPTCHA_HASH = 'D11AFE9FD0A531CF3F4424A4DEE52453';

const person = (overrides: Partial<typeof USER_BEAN_DEFAULTS> = {}) => ({ ...USER_BEAN_DEFAULTS, siteid: 'default', ...overrides });

const options = (overrides: Partial<RestrictedFilesOptions> = {}): RestrictedFilesOptions => ({
  allowedExtensions: FM_PUBLIC_ALLOWED_EXTENSIONS,
  fileAttributeNames: new Set(),
  postedFiles: new Map(),
  ...overrides,
});

describe('messages and extension lists', () => {
  it('carries the English bundle texts and the configBean defaults', () => {
    expect(PEOPLE_MESSAGES).toEqual({
      emailRequired: "The 'Email Address' field is required.",
      captchaError: "The 'Security Code' entered was not correct.",
      captchaSpam: 'This submission has been marked as spam.',
      restrictedFiles: 'The posted request contained restricted file types',
      siteIdMissing: "The 'SiteID' variable is missing.",
    });
    const configBean = readFileSync(fileURLToPath(new URL('../../../../core/mura/configBean.cfc', import.meta.url)), 'utf8');
    const setting = (name: string) => new RegExp(`variables\\.instance\\.${name}='([^']*)'`).exec(configBean)?.[1];
    expect(FM_ALLOWED_EXTENSIONS).toBe(setting('FMAllowedExtensions'));
    expect(FM_PUBLIC_ALLOWED_EXTENSIONS).toBe(setting('FMPublicAllowedExtensions'));
  });
});

describe('validatePersonValues', () => {
  it('hashes the captcha key as ACF CFMX_COMPAT does', () => {
    expect(cfHash(CAPTCHA_KEY, 'CFMX_COMPAT')).toBe(CAPTCHA_HASH);
  });

  it.each([
    ['a blank site id alone', { siteid: '', email: '', hkey: 'x', ukey: 'y', passedprotect: false }, { siteid: PEOPLE_MESSAGES.siteIdMissing }],
    ['a whitespace site id', { siteid: '   ', email: '' }, { siteid: PEOPLE_MESSAGES.siteIdMissing }],
    ['an empty email', { email: '' }, { email: PEOPLE_MESSAGES.emailRequired }],
    ['an empty email on a numeric-text type', { email: '', type: '2' }, { email: PEOPLE_MESSAGES.emailRequired }],
    ['no email check for a group', { email: '', type: 1 }, {}],
    ['a captcha match in another case', { email: 'a@b.c', hkey: CAPTCHA_HASH.toLowerCase(), ukey: CAPTCHA_KEY }, {}],
    ['a captcha mismatch', { email: 'a@b.c', hkey: `${CAPTCHA_HASH}x`, ukey: CAPTCHA_KEY }, { SecurityCode: PEOPLE_MESSAGES.captchaError }],
    ['no captcha posted', { email: 'a@b.c', hkey: '', ukey: CAPTCHA_KEY }, {}],
    ['a failed form protection', { email: 'a@b.c', passedprotect: 'no' }, { Spam: PEOPLE_MESSAGES.captchaSpam }],
    ['a passed form protection', { email: 'a@b.c', passedprotect: 'yes' }, {}],
  ])('reports %s', (_name, overrides, expected) => {
    expect(validatePersonValues(person(overrides))).toEqual(expected);
  });

  it('sets email, SecurityCode and Spam in legacy order', () => {
    const errors = validatePersonValues(person({ email: '', hkey: 'bad', ukey: CAPTCHA_KEY, passedprotect: false }));
    expect(Object.keys(errors)).toEqual(['email', 'SecurityCode', 'Spam']);
  });
});

describe('mergeUserErrors', () => {
  it('keys a duplicate-username save as ACF iterates the struct', () => {
    const errors = mergeUserErrors({
      extended: {},
      identity: { username: "The username 'admin' that you entered is being used by another user." },
      people: validatePersonValues(person({ email: '', hkey: 'bad', ukey: CAPTCHA_KEY, passedprotect: false })),
    });
    expect(Object.keys(errors)).toEqual(['username', 'email', 'SecurityCode', 'Spam']);
    expect(hasErrors(errors)).toBe(true);
  });

  it('places extended data, identity, people and the restricted-file flag by struct bucket', () => {
    const errors = mergeUserErrors({
      extended: { myAttr: 'x', zeta: 'z', alpha: 'a' },
      identity: { password: 'p', username: 'u' },
      people: { email: 'm', SecurityCode: 's', Spam: 'sp' },
      restrictedFiles: true,
    });
    // ACF 2023 listed ZETA,REQUESTHASRESTRICTEDFILES,PASSWORD,MYATTR,ALPHA,USERNAME,EMAIL,SECURITYCODE,SPAM.
    expect(Object.keys(errors)).toEqual([
      'zeta', 'requestHasRestrictedFiles', 'password', 'myAttr', 'alpha', 'username', 'email', 'SecurityCode', 'Spam',
    ]);
    expect(errors.requestHasRestrictedFiles).toBe(PEOPLE_MESSAGES.restrictedFiles);
  });

  it('keeps the struct order across a table resize', () => {
    const extended = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`attr${String(i + 1).padStart(2, '0')}`, 'e']));
    const errors = mergeUserErrors({
      extended,
      identity: { password: 'p', username: 'u' },
      people: { email: 'm', SecurityCode: 's', Spam: 'sp' },
      restrictedFiles: true,
    });
    // coldfusion.runtime.Struct's iteration order for the same insertion sequence.
    expect(Object.keys(errors)).toEqual([
      'attr01', 'attr12', 'attr02', 'attr13', 'attr10', 'attr11', 'requestHasRestrictedFiles', 'attr05', 'attr06', 'attr03',
      'attr14', 'attr04', 'attr09', 'attr07', 'attr08', 'email', 'Spam', 'password', 'username', 'SecurityCode',
    ]);
  });

  it('lets a later key in another casing take the value under the first spelling', () => {
    const errors = mergeUserErrors({ extended: { Email: 'ext' }, people: { email: PEOPLE_MESSAGES.emailRequired } });
    expect(errors).toEqual({ Email: PEOPLE_MESSAGES.emailRequired });
  });

  it('adds nothing for passing parts and keeps a __proto__ attribute as data', () => {
    expect(hasErrors(mergeUserErrors({ extended: {}, people: {}, restrictedFiles: false }))).toBe(false);
    const errors = mergeUserErrors({ extended: JSON.parse('{"__proto__":"bad"}') as Record<string, string>, people: {} });
    expect(Object.keys(errors)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(errors)).toBe(Object.prototype);
  });
});

describe('validateAddressValues', () => {
  it('returns the extended-data errors in struct order', () => {
    expect(Object.keys(validateAddressValues({ zeta: 'z', myAttr: 'x', alpha: 'a' }))).toEqual(['zeta', 'myAttr', 'alpha']);
    expect(validateAddressValues({})).toEqual({});
  });
});

describe('requestHasRestrictedFiles', () => {
  const posted = (field: string, fileName: string) => new Map([[field, fileName]]);

  it.each([
    ['evil.exe', true],
    ['ok.pdf', false],
    ['OK.PDF', false],
    ['abc', true],
    ['noext', false],
    ['a.', true],
    ['a.x,y', true],
    ['x.tar.gz.longer', false],
  ])('checks the posted client file name %s', (fileName, expected) => {
    const input = new Map([['siteid', 'default'], ['upl', '/opt/tmp/neotmp1.tmp']]);
    expect(requestHasRestrictedFiles(input, options({ postedFiles: posted('upl', fileName) }))).toBe(expected);
  });

  it.each([
    ['http://x.com/a.exe', true],
    ['https://x.com/a.exe', true],
    ['https://x.com', true],
    ['http://x.com', false],
    ['HTTP://x.com', false],
    ['ftp://x.com', true],
    ['http://x.com/a.pdf', false],
    ['http://x.com/a.pdf?x=a.exe', false],
    ['http://x.com/a/..', true],
    ['http://x.com/a/', false],
    ['http://x.com/a.EXE', true],
    ['http://x.com/a.longext', false],
    ['news:a.exe', false],
    ['http://x.com/?a.exe', true],
    ['http://x.com/a.exe ', true],
    ['mailto:xa@b.com', false],
  ])('checks a newfile URL %s', (url, expected) => {
    expect(requestHasRestrictedFiles(new Map([['siteid', 'default'], ['newfile', url]]), options())).toBe(expected);
  });

  it('checks a File attribute URL only for a name the site defines in that casing', () => {
    const input = new Map([['siteid', 'default'], ['resumefile', 'http://x.com/cv.exe']]);
    expect(requestHasRestrictedFiles(input, options({ fileAttributeNames: new Set(['resumefile']) }))).toBe(true);
    expect(requestHasRestrictedFiles(input, options({ fileAttributeNames: new Set(['resumeFile']) }))).toBe(false);
  });

  it('stops the whole scan at a website URL that iterates first', () => {
    // In the bean's 128-bin struct WEBSITE (bin 62) iterates before RESUME (bin 77).
    const values = (website: string) =>
      new Map<string, unknown>([...Object.entries({ ...USER_BEAN_DEFAULTS, website }), ['resume', '/opt/tmp/neotmp1.tmp']]);
    const opts = options({ postedFiles: posted('resume', 'evil.exe') });
    expect(requestHasRestrictedFiles(values('http://example.com/me'), opts)).toBe(false);
    expect(requestHasRestrictedFiles(values(''), opts)).toBe(true);
  });

  it('scans in struct order, not insertion order', () => {
    // UPL (bin 0) iterates before WEBSITE (bin 14) whatever order they were set in.
    const opts = options({ postedFiles: posted('upl', 'evil.exe') });
    expect(requestHasRestrictedFiles(new Map([['website', 'http://x.com/a'], ['upl', 't.tmp']]), opts)).toBe(true);
    expect(requestHasRestrictedFiles(new Map([['upl', 't.tmp'], ['website', 'http://x.com/a']]), opts)).toBe(true);
  });

  it('matches a file part name ignoring case and skips complex values and empty lists', () => {
    expect(requestHasRestrictedFiles(new Map([['up5', 't.tmp']]), options({ postedFiles: posted('Up5', 'A.JS') }))).toBe(true);
    expect(requestHasRestrictedFiles(new Map([['up5', { a: 1 }]]), options({ postedFiles: posted('up5', 'A.JS') }))).toBe(false);
    expect(requestHasRestrictedFiles(new Map([['newfile', 'http://x.com/a.exe']]), options({ allowedExtensions: '' }))).toBe(false);
    expect(requestHasRestrictedFiles(new Map([['newfile', 'http://x.com/a.exe']]), options({ allowedExtensions: 'exe' }))).toBe(false);
  });

  it('fails like ACF on a bare mailto: value', () => {
    expect(() => requestHasRestrictedFiles(new Map([['website', 'mailto:']]), options())).toThrow(RangeError);
  });
});

// ACF isValid('url') outcomes, ACF 2023 and its validator classes agreeing on each. A value ACF accepts that does not
// end in '/' stops the scan before ADDRESSURL's successor DOCUMENT (bins 2 and 9), whose posted file is restricted.
const ACF_URL_VALIDITY: ReadonlyArray<readonly [string, boolean]> = [
  ['http://example.com', true],
  ['HTTPS://Example.COM/A.EXE', true],
  ['ftp://files.example.com/a.exe', true],
  ['file://host/share/a', true],
  ['file:///etc/passwd', false],
  ['gopher://example.com', false],
  ['sftp://example.com', false],
  ['javascript:alert(1)', false],
  ['www.example.com', false],
  ['example.com', false],
  ['http:/example.com', false],
  ['http://', false],
  ['https://x', true],
  [' http://example.com ', true],
  ['\thttp://example.com\n', true],
  ['1', false],
  ['', false],
  ['http://user:pass@example.com/a', true],
  ['http://user@example.com', true],
  ['http://a%20b@example.com', true],
  ['http://a%zz@example.com', false],
  ['http://a@b@example.com', false],
  ['http://@example.com', true],
  ['http://us er@example.com', false],
  ['http://x_y.example.com', false],
  ['http://-x.example.com', false],
  ['http://x-.example.com', false],
  ['http://x..example.com', false],
  ['http://.example.com', false],
  ['http://example.com.', true],
  ['http://123', true],
  ['http://x.123', false],
  ['http://123.x', true],
  ['http://a1-b2.c3', true],
  ['http://localhost', true],
  ['http://x%41.com', false],
  ['http://xn--bcher-kva.de', true],
  ['http://xn--zz.com', true],
  ['http://1.2.3.4', true],
  ['http://255.255.255.255', true],
  ['http://256.1.1.1', false],
  ['http://1.2.3', false],
  ['http://1.2.3.4.5', false],
  ['http://0001.2.3.4', true],
  ['http://1.2.3.4a', false],
  ['http://1.2.3.4:8080/x', true],
  ['http://99999999999.1.1.1', false],
  ['http://example.com:', true],
  ['http://example.com:80', true],
  ['http://example.com:0080/a', true],
  ['http://example.com:+80', false],
  ['http://example.com:x', false],
  ['http://example.com:2147483647', true],
  ['http://example.com:2147483648', false],
  ['http://example.com:80:80', false],
  ['http://example.com/a b', false],
  ['http://example.com/a%20b', true],
  ['http://example.com/a%2', false],
  ['http://example.com/a|b', false],
  ['http://example.com/a^b', false],
  ['http://example.com/a{b}', false],
  ['http://example.com/a\\b', false],
  ['http://example.com/a\'b(c)!*~', true],
  ['http://example.com/a;b,c=d&e+f$g', true],
  ['http://example.com/@:x', true],
  ['http://example.com/?q=1&r=2', true],
  ['http://example.com/?q=a b', false],
  ['http://example.com/#frag', true],
  ['http://example.com/#a#b', false],
  ['http://example.com?x', true],
  ['http://example.com#x', true],
  ['http://example.com/a"b', false],
  ['http://example.com/a<b>', false],
  ['http://[::1]/', true],
  ['http://[::1]:8080/a', true],
  ['http://[fe80::1%eth0]/', false],
  ['http://[2001:db8::1]/a.exe', true],
  ['http://[5e6]/a', true],
  ['http://[]/', false],
  ['http://example.com/?a[b]', false],
  ['http://[::1]/a b', false],
  ['http://u:p@[::1]/', true],
  ['http://user0:0@[::1]/', true],
  ['https://[::1].com/x', true],
  ['news:[x]', false],
  ['ftp://[1.2.3.4]/x', true],
  ['http://[::1]/%41', true],
  ['http://[::1]/%4g', false],
  ['http://[::1]]', false],
  ['mailto:x[a]@b.com', false],
  ['news:comp.lang.java', true],
  ['news:', false],
  ['news:a b', false],
  ['news://host/a', true],
  ['news:///a', true],
  ['news:/a', true],
  ['news:a#b', true],
  ['news:a#b c', false],
  ['news://', false],
  ['news://a_b/x', true],
  ['http://example.com/ä', true],
  ['http://bücher.de/', true],
  ['http://bücher.de:8080/a', true],
  ['http://bücher.de:+80/', true],
  ['http://bücher.de:-1/', true],
  ['http://bücher.de:-5/', false],
  ['http://bücher.de:٨٠/', true],
  ['http://x_ä.com/', false],
  ['http://ä%41.com/', false],
  ['http://a@b@ä.com/', false],
  ['http:////ä', false],
  ['http://[::1]/ä', false],
  ['http://[::1]x/ä', false],
  ['http://[::1]:80/ä', false],
  ['http://[zz]/ä', false],
  ['http://xn--.example.ä/', false],
  ['http://xn--zz.example.com/ä', false],
  ['http://example.com:/ä', true],
  ['http://ä.123/', false],
  ['http://user@example.com/ä', true],
  ['http://ä', true],
  ['http:///ä', false],
  ['news:ä', true],
  ['http://example.com/\u00a0', true],
  ['http://example.com/\u0085', true],
  ['mailto:x', false],
  ['mailto:a@b.com', false],
  ['mailto:xa@b.com', true],
  ['mailto:xjohn.doe@example.com', true],
  ['mailto:x.a@b.com', false],
  ['mailto:xa.@b.com', false],
  ['mailto:xa..b@c.com', false],
  ['mailto:xa@b', true],
  ['mailto:xa@.b', false],
  ['mailto:xa@b.', false],
  ['mailto:xa@b..c', false],
  ['mailto:xa@b_c.com', false],
  ['mailto:xa@[1.2.3.4]', true],
  ['mailto:xa@[1.2.3.4]x', false],
  ['mailto:xa@x[1]', false],
  ['mailto:x"a b"@c.com', true],
  ['mailto:"a b"@c.com', false],
  ['mailto:x"a"b@c.com', false],
  ['mailto:xa\\ b@c.com', true],
  ['mailto:xJohn <j@x.com>', true],
  ['mailto:x<j@x.com>', true],
  ['mailto:x<j@x.com', false],
  ['mailto:xa@b.com>', false],
  ['mailto:x<j@x.com> <k@x.com>', false],
  ['mailto:xa@b.com, c@d.com', false],
  ['mailto:xa@b.com (comment)', true],
  ['mailto:xa@b.com (unclosed', false],
  ['mailto:xa@b.com )', false],
  ['mailto:xa(c)@b.com', false],
  ['mailto:xgrp: a@b.com, c@d.com;', true],
  ['mailto:xgrp:;', true],
  ['mailto:xgrp: a@b.com', false],
  ['mailto:xa@b.com;', false],
  ['mailto:xg1: g2: a@b;;', false],
  ['mailto:x@a,@b:c@d.com', false],
  ['mailto:x<@a,@b:c@d.com>', true],
  ['mailto:x<@a,b:c@d.com>', false],
  ['mailto:xa b@c.com', false],
  ['mailto:x a@b.com', true],
  ['mailto:xa@b c.com', false],
  ['mailto:xa@b-c.com', true],
  ['mailto:xa@ä.com', true],
  ['mailto:x"a@b.com', false],
  ['mailto:x"a"@b.com', true],
  ['mailto:x"a"x@b.com', false],
  ['mailto:x\r\n a@b.com', true],
  ['mailto:xa\rb@c.com', false],
  ['mailto:xa\nb@c.com', false],
  ['mailto:x[a@b.com', false],
  ['mailto:x"a\\"@b.com', false],
  ['mailto:xa@b.com;c', false],
  ['mailto:x,a@b.com', true],
  ['mailto:x:a@b.com', false],
  ['MAILTO:XA@B.COM', true],
  [' mailto:xa@b.com', true],
  ['http://[::1/', false],
  ['http://[ä/', false],
  ['http://:80/', false],
  ['http://@:80/', false],
  ['http://bücher.de:x/', false],
  ['http://bücher.de?x', true],
  ['http://ä.com/?q#f', true],
  ['mailto:x<@abc>', false],
  ['mailto:x<>', false],
  ['mailto:xa"b"@c.com', false],
  ['mailto:xa\\"b"@c.com', false],
  ['mailto:xa@b.com (a(b)\\)c)', true],
  ['mailto:x"q" <"a>b"@c.com>', true],
  ['mailto:x<a\\>b@c.com>', true],
  ['mailto:x;a@b.com', true],
  ['http://bücher.de:/', true],
  ['http://ä.com:99999999999/', false],
  ['http://x.com:99999999999/', false],
  ['http://x.com:8x/', false],
  ['http://a:b@x.com:80/', true],
  ['news://a%zz/x', false],
  ['http://a b.com/', false],
  ['http://x.com/%zz', false],
];

describe("ACF isValid('url') as the scan applies it", () => {
  it.each(ACF_URL_VALIDITY)('treats %j as valid: %s', (value, valid) => {
    const input = new Map([['addressurl', value], ['document', '/opt/tmp/neotmp1.tmp']]);
    const stops = valid && !value.endsWith('/');
    expect(requestHasRestrictedFiles(input, options({ postedFiles: new Map([['document', 'evil.exe']]) }))).toBe(!stops);
  });
});
