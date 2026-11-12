import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  cfUuid,
  isCfUuid,
} from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import { loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import {
  TOKEN_PLACEHOLDER,
  URL_PLACEHOLDER,
  isTokenKey,
  normaliseText,
  normaliseTimestamp,
  normaliseTokens,
  normaliseUrl,
  normaliseValue,
  timestampClassOf,
  type TimestampClass,
} from '../../../src/golden/normalise/values.js';

interface ItemLinks {
  crumbs: string;
  history: string;
  parent: string;
  rendered: string;
  self: string;
}

interface ContentItem {
  contenthistid: string;
  contentid: string;
  created: string;
  lastupdate: string;
  links: ItemLinks;
  moduleid: string;
  parentid: string;
  path: string;
  title: string;
}

interface Envelope {
  apiversion: string;
  method: string;
  params: { entityname: string; siteid: string; type: string };
  data: {
    csrf_token: string;
    csrf_token_expires: string;
    entityname: string;
    items: ContentItem[];
    links: { entities: string; permissions: string; properties: string; self: string };
  };
}

interface TimestampSample {
  readonly instants: readonly [string, string];
  readonly key?: string;
}

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL('../../fixtures/http/envelope-success.json', import.meta.url)),
  'utf8',
);
const LEGACY_ORIGIN = 'http://127.0.0.1:8500';
const GATEWAY_ORIGIN = 'http://127.0.0.1:8100';
const LEGACY_TOKEN = 'FIXTURE-TOKEN-1';
const GATEWAY_TOKEN = 'FIXTURE-TOKEN-2';
const SERIALIZER_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const RUN_35 = /(?<![0-9A-Za-z-])[0-9A-Za-z-]{35}(?![0-9A-Za-z-])/g;

const TIMESTAMP_SAMPLES: Readonly<Record<TimestampClass, TimestampSample>> = {
  'cf-odbc': { instants: ["{ts '2026-06-30 12:00:00'}", "{ts '2027-01-15 08:30:45.5'}"] },
  serializer: { instants: ['2026-06-30T12:00:00', '2027-01-15T08:30:45'] },
  'iso-local': { instants: ['2026-06-30T12:00:00.123Z', '2027-01-15T08:30:45.9+02:00'] },
  'jdbc-timestamp': { instants: ['2026-06-30 12:00:00.0', '2027-01-15 08:30:45.123456'] },
  'cf-datetime': { instants: ['June, 30 2026 12:00:00', 'January, 15 2027 08:30:45 +0100'] },
  'http-date': { instants: ['Tue, 30 Jun 2026 12:00:00 GMT', 'Fri, 15 Jan 2027 08:30:45 GMT'] },
  'cookie-expires': { instants: ['Wed, 30-Jun-2027 12:00:00 GMT', 'Fri, 15-Jan-2027 08:30:45 GMT'] },
  'iso-date': { instants: ['2026-06-30', '2027-01-15'] },
  'csrf-expires': { instants: ['260630131500000', '270115083045123'], key: CSRF_FIELD_EXPIRES },
  'admin-date': { instants: ['6/30/2026', '10/302/2026'] },
  'admin-time': { instants: ['12:00 PM', '8:30 AM'] },
  'epoch-ms': { instants: ['1782820800000', '1800000000000'], key: 'createdAt' },
};

let rules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
});

const fixture = (): Envelope => JSON.parse(FIXTURE_TEXT) as Envelope;

function at<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`the fixture has no element ${index}`);
  return found;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...stringsIn(child)]);
  }
  return [];
}

const cfUuidsIn = (value: unknown): string[] =>
  stringsIn(value).flatMap((s) => (s.match(RUN_35) ?? []).filter(isCfUuid));

// The fixture as the gateway would answer it: other origin, ids, instants and tokens of the same formats.
function gatewayCopy(source: Envelope): Envelope {
  const ids = new Map<string, string>();
  const text = JSON.stringify(source)
    .replaceAll(LEGACY_ORIGIN, GATEWAY_ORIGIN)
    .replaceAll(LEGACY_TOKEN, GATEWAY_TOKEN)
    .replace(RUN_35, (run) => {
      if (!isCfUuid(run)) return run;
      const mapped = ids.get(run) ?? cfUuid();
      ids.set(run, mapped);
      return mapped;
    });
  const copy = JSON.parse(text) as Envelope;
  copy.data.csrf_token = GATEWAY_TOKEN;
  copy.data.csrf_token_expires = '270115083045123';
  copy.data.items.forEach((entry, index) => {
    entry.created = `2027-01-1${index}T08:30:45`;
    entry.lastupdate = `2027-02-1${index}T17:05:59`;
  });
  return copy;
}

describe('timestamp classes', () => {
  it('has a sample for every class the committed rules declare', () => {
    expect(Object.keys(TIMESTAMP_SAMPLES).sort()).toStrictEqual(rules.timestamps.classes.map((c) => c.name).sort());
  });

  it.each(Object.entries(TIMESTAMP_SAMPLES))(
    'classifies two instants of %s alike and gives both its class placeholder',
    (name, { instants, key }) => {
      const [first, second] = instants;
      expect(timestampClassOf(first, rules, key)).toBe(name);
      expect(timestampClassOf(second, rules, key)).toBe(name);
      expect(normaliseTimestamp(first, rules, key)).toBe(`<ts:${name}>`);
      expect(normaliseTimestamp(second, rules, key)).toBe(normaliseTimestamp(first, rules, key));
    },
  );

  it('gives every class its own placeholder, so a format change between sides still differs', () => {
    const placeholders = Object.values(TIMESTAMP_SAMPLES).map(({ instants, key }) =>
      normaliseTimestamp(instants[0], rules, key),
    );
    expect(new Set(placeholders).size).toBe(placeholders.length);
    expect(normaliseValue({ created: '2026-06-30T12:00:00' }, createIdOrdinals(), rules)).not.toStrictEqual(
      normaliseValue({ created: '2026-06-30 12:00:00.0' }, createIdOrdinals(), rules),
    );
  });

  it.each(['Café', '12345'])('leaves the non-timestamp %s unclassified and unchanged', (value) => {
    expect(timestampClassOf(value, rules)).toBeUndefined();
    expect(normaliseTimestamp(value, rules)).toBe(value);
  });
});

describe('token keys', () => {
  it.each([
    CSRF_FIELD_TOKEN,
    CSRF_FIELD_EXPIRES,
    'access_token',
    'refresh_token',
    'authToken',
    'returnID',
    CSRF_HEADER_TOKEN,
    CSRF_HEADER_EXPIRES,
  ])('treats %s as a token key', (key) => {
    expect(isTokenKey(key, rules)).toBe(true);
  });

  it.each(['title', 'contentid', 'siteid'])('does not treat %s as a token key', (key) => {
    expect(isTokenKey(key, rules)).toBe(false);
  });

  it('masks the envelope CSRF fields and leaves every other key of the data untouched', () => {
    const source = fixture();
    const out = normaliseTokens(source.data, rules) as Envelope['data'];
    expect(out).toStrictEqual({ ...source.data, csrf_token: TOKEN_PLACEHOLDER, csrf_token_expires: TOKEN_PLACEHOLDER });
    expect(out.links.self).toBe(source.data.links.self);
  });

  it('masks token keys inside nested objects and arrays', () => {
    const source = fixture();
    const nested = { response: source, grants: [{ access_token: 'FIXTURE-TOKEN-3', refresh_token: 'FIXTURE-TOKEN-4' }] };
    expect(normaliseTokens(nested, rules)).toStrictEqual({
      response: { ...source, data: { ...source.data, csrf_token: TOKEN_PLACEHOLDER, csrf_token_expires: TOKEN_PLACEHOLDER } },
      grants: [{ access_token: TOKEN_PLACEHOLDER, refresh_token: TOKEN_PLACEHOLDER }],
    });
  });
});

describe('signed and download URLs', () => {
  it('replaces a URL carrying each declared signed query parameter with the URL placeholder', () => {
    expect(rules.urls.signedQueryParams.length).toBeGreaterThan(0);
    for (const name of rules.urls.signedQueryParams) {
      const url = `https://storage.googleapis.com/content-files/tenant-a/about.pdf?X-Goog-Algorithm=GOOG4-RSA-SHA256&${name}=FIXTURE-SIGNATURE-1`;
      expect(normaliseUrl(url, createIdOrdinals(), rules), name).toBe(URL_PLACEHOLDER);
    }
  });

  it('replaces an absolute or relative URL under each declared file path prefix with the URL placeholder', () => {
    expect(rules.urls.pathPrefixes.length).toBeGreaterThan(0);
    for (const prefix of rules.urls.pathPrefixes) {
      for (const url of [`${LEGACY_ORIGIN}${prefix}content-files/about.pdf`, `${prefix}finance-attachments/receipt.pdf`]) {
        expect(normaliseUrl(url, createIdOrdinals(), rules), url).toBe(URL_PLACEHOLDER);
      }
    }
  });

  it('replaces the value of each declared download field with the URL placeholder', () => {
    expect(rules.urls.downloadFields.length).toBeGreaterThan(0);
    for (const { key, whenContains } of rules.urls.downloadFields) {
      const values = (whenContains ?? ['/v1/exports/']).map((part) =>
        part.startsWith('/') ? `https://files.example.test${part}report.csv` : `https://${part}/reporting-exports/report.csv`,
      );
      for (const value of values) {
        expect(normaliseValue({ [key]: value }, createIdOrdinals(), rules), `${key}: ${value}`).toStrictEqual({
          [key]: URL_PLACEHOLDER,
        });
      }
    }
  });
});

describe('normaliseUrl', () => {
  it('replaces the legacy origin and masks the authToken parameter of the findQuery self link', () => {
    const out = normaliseUrl(fixture().data.links.self, createIdOrdinals(), rules);
    expect(out).toBe(
      '<origin>/_api/json/v1/tenant-a/?&entityname=content&siteid=tenant-a&type=Page&authToken=<token>&method=findQuery&pageIndex=1',
    );
    expect(out).not.toContain(LEGACY_TOKEN);
  });

  it('normalises an entity link on the gateway origin with another id exactly as on legacy', () => {
    const { contentid, links } = at(fixture().data.items, 0);
    const gateway = links.crumbs.replace(LEGACY_ORIGIN, GATEWAY_ORIGIN).replace(contentid, cfUuid());
    expect(gateway).not.toContain(contentid);
    expect(normaliseUrl(links.crumbs, createIdOrdinals(), rules)).toBe(
      '<origin>/_api/json/v1/tenant-a/content/<id:1>/crumbs',
    );
    expect(normaliseUrl(gateway, createIdOrdinals(), rules)).toBe(normaliseUrl(links.crumbs, createIdOrdinals(), rules));
  });

  it('lower-cases the muraAction value of an admin link and numbers its userid', () => {
    const userid = at(fixture().data.items, 0).parentid;
    const url = `${LEGACY_ORIGIN}/admin/?muraAction=cUsers.editUser&userid=${userid}&siteid=tenant-a`;
    expect(normaliseUrl(url, createIdOrdinals(), rules)).toBe(
      '<origin>/admin/?muraAction=cusers.edituser&userid=<id:1>&siteid=tenant-a',
    );
  });

  it('normalises the ids and tokens of a URL without an origin', () => {
    const { contentid } = at(fixture().data.items, 0);
    const url = `/_api/json/v1/tenant-a/content/${contentid}?authToken=${LEGACY_TOKEN}`;
    expect(normaliseUrl(url, createIdOrdinals(), rules)).toBe('/_api/json/v1/tenant-a/content/<id:1>?authToken=<token>');
  });
});

describe('normaliseValue over the findQuery envelope', () => {
  it('leaves no CF UUID, token, legacy origin or serializer timestamp in any key or string', () => {
    const source = fixture();
    expect(new Set(cfUuidsIn(source)).size).toBe(5);
    const strings = stringsIn(normaliseValue(source, createIdOrdinals(), rules));
    expect(cfUuidsIn(strings)).toStrictEqual([]);
    const leaked = strings.filter(
      (s) =>
        s.includes(LEGACY_TOKEN) ||
        s.includes(source.data.csrf_token) ||
        s.includes('127.0.0.1:8500') ||
        SERIALIZER_TIMESTAMP.test(s),
    );
    expect(leaked).toStrictEqual([]);
  });

  it('keeps the envelope fields and the non-UUID module id, numbering ids by first sight in sorted key order', () => {
    const out = normaliseValue(fixture(), createIdOrdinals(), rules) as Envelope;
    expect(out.apiversion).toBe('v1');
    expect(out.method).toBe('findQuery');
    expect(out.params).toStrictEqual({ entityname: 'content', siteid: 'tenant-a', type: 'Page' });
    expect(out.data.entityname).toBe('content');
    expect(at(out.data.items, 0)).toStrictEqual({
      active: 1,
      approved: 1,
      changesetid: '',
      contenthistid: '<id:1>',
      contentid: '<id:2>',
      created: '<ts:serializer>',
      filename: 'about-us',
      isnew: 0,
      lastupdate: '<ts:serializer>',
      links: {
        crumbs: '<origin>/_api/json/v1/tenant-a/content/<id:2>/crumbs',
        history: '<origin>/_api/json/v1/tenant-a/content/<id:2>/history',
        parent: '<origin>/_api/json/v1/tenant-a/content/<id:3>',
        rendered: '<origin>/_api/json/v1/tenant-a/content/_path/about-us',
        self: '<origin>/_api/json/v1/tenant-a/content/<id:2>',
      },
      menutitle: 'About Us',
      moduleid: '00000000000000000000000000000000000',
      parentid: '<id:3>',
      path: '00000000000000000000000000000000001,<id:3>,<id:2>',
      siteid: 'tenant-a',
      title: 'About Us',
      type: 'Page',
      url: '/tenant-a/about-us/',
    });
    expect(at(out.data.items, 1).title).toBe('Contact Us');
    expect(out.data.links).toStrictEqual({
      entities: '<origin>/_api/json/v1/tenant-a',
      permissions: '<origin>/_api/json/v1/tenant-a/content/permissions',
      properties: '<origin>/_api/json/v1/tenant-a/content/properties',
      self: '<origin>/_api/json/v1/tenant-a/?&entityname=content&siteid=tenant-a&type=Page&authToken=<token>&method=findQuery&pageIndex=1',
    });
  });

  it('gives the shared parent id one ordinal in every field that carries it', () => {
    const out = normaliseValue(fixture(), createIdOrdinals(), rules) as Envelope;
    const first = at(out.data.items, 0);
    const second = at(out.data.items, 1);
    expect(first.parentid).toMatch(/^<id:\d+>$/);
    expect(second.parentid).toBe(first.parentid);
    for (const item of [first, second]) {
      expect(item.links.parent).toBe(`<origin>/_api/json/v1/tenant-a/content/${first.parentid}`);
      expect(item.path.split(',')[1]).toBe(first.parentid);
    }
    expect(second.contentid).not.toBe(first.contentid);
  });

  it('returns its own output unchanged when normalised again with a fresh state', () => {
    const out = normaliseValue(fixture(), createIdOrdinals(), rules);
    expect(normaliseValue(out, createIdOrdinals(), rules)).toStrictEqual(out);
  });
});

describe('legacy and gateway parity', () => {
  it('normalises the legacy response and its gateway copy to the same value', () => {
    const legacy = fixture();
    const gateway = gatewayCopy(legacy);
    const legacyIds = cfUuidsIn(legacy);
    expect(new Set(cfUuidsIn(gateway)).size).toBe(new Set(legacyIds).size);
    expect(cfUuidsIn(gateway).filter((id) => legacyIds.includes(id))).toStrictEqual([]);
    expect(at(gateway.data.items, 0).created).not.toBe(at(legacy.data.items, 0).created);
    expect(gateway.data.links.self).toContain(GATEWAY_TOKEN);
    expect(normaliseValue(gateway, createIdOrdinals(), rules)).toStrictEqual(
      normaliseValue(legacy, createIdOrdinals(), rules),
    );
  });

  it('still tells the sides apart when a non-volatile field differs', () => {
    const legacy = fixture();
    const gateway = gatewayCopy(legacy);
    at(gateway.data.items, 0).title = 'About Our Team';
    expect(normaliseValue(gateway, createIdOrdinals(), rules)).not.toStrictEqual(
      normaliseValue(legacy, createIdOrdinals(), rules),
    );
  });
});

describe('normaliseText', () => {
  it('normalises the id, timestamp and legacy URL in a prose message', () => {
    const { parentid, links } = at(fixture().data.items, 0);
    const text = `Moved under ${parentid} at 2026-06-30T10:15:00; see ${links.parent}.`;
    expect(normaliseText(text, createIdOrdinals(), rules)).toBe(
      'Moved under <id:1> at <ts:serializer>; see <origin>/_api/json/v1/tenant-a/content/<id:1>.',
    );
  });
});
