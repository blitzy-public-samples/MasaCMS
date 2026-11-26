import { describe, expect, it } from 'vitest';
import {
  INVALID_ACCESS_TOKEN_HEADER_SEQUENCE,
  LEGACY_JSON_CONTENT_TYPE,
  LEGACY_SHUNTER_CONTENT_TYPE,
  WWW_AUTHENTICATE,
  accessControlOriginDomains,
  cfHash,
  corsHeaders,
  effectiveWwwAuthenticate,
  etag,
  legacyHeaders,
  type AccessControlConfig,
  type AccessControlSite,
} from '../../src/legacy-compat/headers.js';

// Body and ETag of GET /_api/json/v1/default/content/00000000000000000000000000000000001?fields=title on Masa 7.6.1.
const LEGACY_BODY =
  '{"apiversion":"v1","data":{"contentid":"00000000000000000000000000000000001","title":"Home",' +
  '"id":"00000000000000000000000000000000001","siteid":"default","isnew":0,"entityname":"content"},"method":"findOne"}';
const LEGACY_ETAG = 'AD331FE7344E2E70404BB503ED8B4D1826F109588C92D2A09D9EC80BB4216F71';

const ALLOWED_DOMAINS = ['localhost', 'example.com'];

function echoed(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' };
}

describe('cfHash', () => {
  it.each([
    { label: 'the empty string', input: '', expected: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855' },
    { label: 'ASCII text', input: 'abc', expected: 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD' },
    {
      label: 'multi-byte text encoded as UTF-8',
      input: 'café ✓',
      expected: '3C15BBB0672EC7F843BE05677DCE1B0C2FB7E64A16618E498DECBBDF3B6CD6E2',
    },
  ])('returns the uppercase SHA-256 hex of $label', ({ input, expected }) => {
    expect(cfHash(input)).toBe(expected);
  });

  // hash(s, "CFMX_COMPAT") on ACF 2023.0.26, the algorithm Masa passes as defaultHashAlgorithm.
  it.each([
    { label: 'the empty string', input: '', expected: 'D41D8CD98F00B204E9800998ECF8427E' },
    { label: 'ASCII text', input: 'abc', expected: '900150983CD24FB0D6963F7D28E17F72' },
    { label: 'a URL', input: 'http://example.com/a?b=1&c=2', expected: '2A9F971E93DBC26601B86298F1954773' },
    { label: 'multi-byte text, truncated to low bytes', input: 'café ✓', expected: '1ACC886451B173DE25EEE59089E8B75C' },
    { label: 'U+0100, whose low byte is zero', input: '\u0100', expected: '93B885ADFE0DA089CDF634904FD59F71' },
    { label: 'a surrogate pair', input: '\u{1F600}', expected: 'C151C5FA0F424DBF71E349896C45EC16' },
  ])('returns the uppercase CFMX_COMPAT hex of $label', ({ input, expected }) => {
    expect(cfHash(input, 'CFMX_COMPAT')).toBe(expected);
  });
});

describe('etag', () => {
  it('equals the unquoted ETag legacy sends for the same serialized body', () => {
    expect(etag(LEGACY_BODY)).toBe(LEGACY_ETAG);
  });
});

describe('legacyHeaders', () => {
  it.each([
    {
      label: 'sends Generator 7.6.1 and HSTS max-age=1200 by default',
      version: undefined,
      maxAge: undefined,
      expected: { Generator: 'Masa CMS 7.6.1', 'Strict-Transport-Security': 'max-age=1200' },
    },
    {
      label: 'uses the given version and max-age',
      version: '7.6.2',
      maxAge: 31_536_000,
      expected: { Generator: 'Masa CMS 7.6.2', 'Strict-Transport-Security': 'max-age=31536000' },
    },
    {
      label: 'omits HSTS when max-age is 0',
      version: '7.6.1',
      maxAge: 0,
      expected: { Generator: 'Masa CMS 7.6.1' },
    },
  ])('$label', ({ version, maxAge, expected }) => {
    expect(legacyHeaders(version, maxAge)).toEqual(expected);
  });
});

describe('legacy content types', () => {
  it.each([
    { label: 'JSON API', actual: LEGACY_JSON_CONTENT_TYPE, expected: 'application/json;charset=utf-8' },
    { label: 'shunter layout', actual: LEGACY_SHUNTER_CONTENT_TYPE, expected: 'application/x-shunter+json;charset=utf-8' },
  ])('$label content type has no space before charset', ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });
});

describe('corsHeaders', () => {
  it.each([
    { label: 'an allowed host with a port', origin: 'http://localhost:3000' },
    { label: 'a sub-domain of an allowed domain', origin: 'https://www.example.com' },
    { label: 'a nested sub-domain', origin: 'https://a.b.example.com' },
    { label: 'an allowed host in another case, unchanged', origin: 'HTTP://LOCALHOST/x' },
    { label: 'a scheme-less origin naming an allowed host', origin: 'localhost' },
  ])('echoes $label', ({ origin }) => {
    expect(corsHeaders(origin, ALLOWED_DOMAINS)).toEqual(echoed(origin));
  });

  it.each([
    { label: 'no Origin header', origin: undefined, domains: ALLOWED_DOMAINS },
    { label: 'an empty Origin', origin: '', domains: ALLOWED_DOMAINS },
    { label: 'an unlisted host', origin: 'http://evil.example', domains: ALLOWED_DOMAINS },
    { label: 'a host ending in an allowed domain without a dot', origin: 'http://notlocalhost', domains: ALLOWED_DOMAINS },
    { label: 'an allowed domain used as a sub-domain', origin: 'https://example.com.evil.test', domains: ALLOWED_DOMAINS },
    { label: 'an empty allow-list', origin: 'http://localhost', domains: [] },
  ])('omits CORS headers for $label', ({ origin, domains }) => {
    expect(corsHeaders(origin, domains)).toEqual({});
  });
});

describe('accessControlOriginDomains', () => {
  const cases: { label: string; sites: AccessControlSite[]; cfg: AccessControlConfig; expected: string[] }[] = [
    { label: 'returns nothing without sites', sites: [], cfg: {}, expected: [] },
    {
      label: 'splits the comma domain list and drops empty elements',
      sites: [{ domain: 'a.test,,b.test,' }],
      cfg: {},
      expected: ['a.test', 'b.test'],
    },
    {
      label: 'adds the current admin domain, not the admin domain, when an admin domain is set',
      sites: [{ domain: 'a.test' }],
      cfg: { adminDomain: 'admin.test', currentAdminDomain: 'current.admin.test' },
      expected: ['a.test', 'current.admin.test'],
    },
    {
      label: 'adds no admin domain when the current admin domain is unset',
      sites: [{ domain: 'a.test' }],
      cfg: { adminDomain: 'admin.test' },
      expected: ['a.test'],
    },
    {
      label: 'ignores the current admin domain when no admin domain is set',
      sites: [{ domain: 'a.test' }],
      cfg: { adminDomain: '', currentAdminDomain: 'current.admin.test' },
      expected: ['a.test'],
    },
    {
      label: 'skips a current admin domain already listed in another case',
      sites: [{ domain: 'Admin.Test' }],
      cfg: { adminDomain: 'admin.test', currentAdminDomain: 'admin.test' },
      expected: ['Admin.Test'],
    },
    {
      label: 'adds the resource domain of a remote site',
      sites: [{ domain: 'a.test', isRemote: true, resourceDomain: 'cdn.test' }],
      cfg: {},
      expected: ['a.test', 'cdn.test'],
    },
    {
      label: 'ignores the resource domain of a local site',
      sites: [{ domain: 'a.test', isRemote: false, resourceDomain: 'cdn.test' }],
      cfg: {},
      expected: ['a.test'],
    },
    {
      label: 'ignores an empty resource domain of a remote site',
      sites: [{ domain: 'a.test', isRemote: true, resourceDomain: '' }],
      cfg: {},
      expected: ['a.test'],
    },
    {
      label: 'splits aliases on CR and LF, dropping empty and case-insensitively repeated ones',
      sites: [{ domain: 'a.test', domainAlias: 'b.test\r\nA.TEST\nc.test\r\r\nB.test' }],
      cfg: {},
      expected: ['a.test', 'b.test', 'c.test'],
    },
    {
      label: 'adds each element of an alias that contains commas',
      sites: [{ domain: 'a.test', domainAlias: 'x.test,y.test' }],
      cfg: {},
      expected: ['a.test', 'x.test', 'y.test'],
    },
    {
      label: 'deduplicates across sites case-sensitively in site order',
      sites: [{ domain: 'a.test' }, { domain: 'A.TEST,a.test,b.test' }],
      cfg: {},
      expected: ['a.test', 'A.TEST', 'b.test'],
    },
  ];

  it.each(cases)('$label', ({ sites, cfg, expected }) => {
    expect(accessControlOriginDomains(sites, cfg)).toEqual(expected);
  });
});

describe('WWW_AUTHENTICATE', () => {
  it('holds the legacy values, including the unbalanced invalid_grant_type quote', () => {
    expect(WWW_AUTHENTICATE).toEqual({
      basic: 'Basic',
      bearerInvalidAccessToken: 'Bearer error="invalid_access_token"',
      bearer: 'Bearer',
      bearerInvalidClientCredentials: 'Bearer error="invalid_client_credentials"',
      bearerInvalidAuthorizationCode: 'Bearer error="invalid_authorization_code"',
      bearerInvalidClientRefreshToken: 'Bearer error="invalid_client_refresh_token"',
      bearerInvalidGrantType: 'Bearer error="invalid_grant_type',
    });
  });
});

describe('INVALID_ACCESS_TOKEN_HEADER_SEQUENCE', () => {
  it('sets invalid_access_token then Bearer', () => {
    expect(INVALID_ACCESS_TOKEN_HEADER_SEQUENCE).toEqual(['Bearer error="invalid_access_token"', 'Bearer']);
  });
});

describe('effectiveWwwAuthenticate', () => {
  it.each([
    { label: 'Bearer after the invalid-access-token sequence', sequence: INVALID_ACCESS_TOKEN_HEADER_SEQUENCE, expected: 'Bearer' },
    { label: 'the only header set', sequence: [WWW_AUTHENTICATE.basic], expected: 'Basic' },
    { label: 'an empty value when no header was set', sequence: [], expected: '' },
  ])('returns $label', ({ sequence, expected }) => {
    expect(effectiveWwwAuthenticate(sequence)).toBe(expected);
  });
});
