import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEGACY_ADMIN_SENTINEL_ID, isCfUuid } from '@opt2/platform/legacy-compat';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CF_UUID_IN_TEXT,
  createIdOrdinals,
  normaliseIds,
  normaliseIdsInString,
  ordinalFor,
  peekOrdinal,
} from '../../../src/golden/normalise/ids.js';
import { loadRules, type IdRules } from '../../../src/golden/normalise/rules.js';

interface FixtureItem {
  moduleid: string;
  parentid: string;
  path: string;
  links: Record<string, string>;
}

interface Fixture {
  data: { items: FixtureItem[] };
}

const FIXTURE_URL = new URL('../../fixtures/http/envelope-success.json', import.meta.url);
const readFixture = (): unknown => JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), 'utf8'));

const A = '2B3C4D5E-6F7A-4B8C-9D0E1F2A3B4C5D6E';
const B = '3C4D5E6F-7A8B-4C9D-8E0F1A2B3C4D5E6F';
const C = '4D5E6F7A-8B9C-4DAE-9F0A1B2C3D4E5F6A';
const PARENT = '1A2B3C4D-5E6F-4A7B-8C9D0E1F2A3B4C5D';
const RFC4122 = '6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c';
const NUM_RUNS = 150;

const cfUuid = fc.stringMatching(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/).filter(isCfUuid);
// Ids joined by delimiters that never adjoin hex, as in path lists, URLs and prose.
const idText = fc
  .tuple(fc.array(cfUuid, { minLength: 1, maxLength: 3 }), fc.constantFrom(',', ' ', '/', '&userid='))
  .map(([ids, separator]) => ids.join(separator));
const idValue = fc.oneof(cfUuid, idText, fc.dictionary(fc.string({ maxLength: 4 }), cfUuid, { maxKeys: 3 }));

const count = (text: string, needle: string): number => text.split(needle).length - 1;

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...stringsIn(child)]);
  }
  return [];
}

let ids: IdRules;

beforeAll(() => {
  ids = loadRules(undefined, { PORT: '8500' }).ids;
});

describe('ordinalFor', () => {
  it('numbers ids <id:1>…<id:n> in first-seen order, equal ids sharing one placeholder', () => {
    const sequence = fc
      .uniqueArray(cfUuid, { minLength: 1, maxLength: 8 })
      .chain((pool) => fc.array(fc.constantFrom(...pool), { minLength: 1, maxLength: 30 }));
    fc.assert(
      fc.property(sequence, (seen) => {
        const firstSeen = new Map<string, number>();
        for (const id of seen) if (!firstSeen.has(id)) firstSeen.set(id, firstSeen.size + 1);
        const state = createIdOrdinals();
        const placeholders = seen.map((id) => ordinalFor(id, state, ids));
        expect(placeholders).toEqual(seen.map((id) => `<id:${firstSeen.get(id)}>`));
        expect(new Set(placeholders).size).toBe(firstSeen.size);
        expect(state.next).toBe(firstSeen.size + 1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keys ordinals as the committed rules declare and folds case without rules', () => {
    expect(ids.placeholder).toBe('<id:{n}>');
    expect(ids.ordinalKey).toBe('exact');
    const withRules = createIdOrdinals();
    expect([ordinalFor(A, withRules, ids), ordinalFor(A.toLowerCase(), withRules, ids)]).toEqual(['<id:1>', '<id:2>']);
    const withoutRules = createIdOrdinals();
    expect([ordinalFor(A, withoutRules), ordinalFor(A.toLowerCase(), withoutRules)]).toEqual(['<id:1>', '<id:1>']);
  });

  it('folds case under a case-insensitive ordinal key and keeps literals listed in any case', () => {
    const folded: IdRules = { ...ids, ordinalKey: 'case-insensitive', keepLiteral: [C.toLowerCase()] };
    const state = createIdOrdinals();
    expect(normaliseIdsInString(`${A} ${A.toLowerCase()} ${C} ${B}`, state, folded)).toBe(`<id:1> <id:1> ${C} <id:2>`);
    expect(peekOrdinal(C, state, folded)).toBeUndefined();
  });
});

describe('peekOrdinal', () => {
  it('reports an unseen id as undefined without assigning it an ordinal', () => {
    const state = createIdOrdinals();
    expect(peekOrdinal(A, state, ids)).toBeUndefined();
    expect(ordinalFor(B, state, ids)).toBe('<id:1>');
    expect(peekOrdinal(A, state, ids)).toBeUndefined();
    expect(ordinalFor(A, state, ids)).toBe('<id:2>');
    expect(peekOrdinal(A, state, ids)).toBe('<id:2>');
    expect(peekOrdinal(B, state)).toBe('<id:1>');
    expect(state.next).toBe(3);
  });
});

describe('normaliseIds', () => {
  it('keeps ordinals across the steps sharing one state and restarts at <id:1> with a fresh state', () => {
    const step1 = { parentid: B, id: A };
    const step2 = { items: [{ id: C }, { parent: A }] };
    const state = createIdOrdinals();
    expect(normaliseIds(step1, state, ids)).toEqual({ id: '<id:1>', parentid: '<id:2>' });
    expect(normaliseIds(step2, state, ids)).toEqual({ items: [{ id: '<id:3>' }, { parent: '<id:1>' }] });
    expect(normaliseIds(step2, createIdOrdinals(), ids)).toEqual({ items: [{ id: '<id:1>' }, { parent: '<id:2>' }] });
  });

  it('gives the same output whatever the key order of the input', () => {
    const entries = fc.uniqueArray(fc.tuple(fc.oneof(cfUuid, fc.string({ maxLength: 6 })), idValue), {
      minLength: 2,
      maxLength: 8,
      selector: ([key]) => key,
    });
    const reordered = entries.chain((list) =>
      fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length })),
    );
    fc.assert(
      fc.property(reordered, ([original, shuffled]) => {
        const left = normaliseIds(Object.fromEntries(original), createIdOrdinals(), ids);
        const right = normaliseIds(Object.fromEntries(shuffled), createIdOrdinals(), ids);
        expect(right).toEqual(left);
        expect(Object.keys(right as object)).toEqual(Object.keys(left as object));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is idempotent: placeholders are never matched again', () => {
    const value = fc.record({
      json: fc.jsonValue({ maxDepth: 2 }),
      id: cfUuid,
      text: idText,
      list: fc.array(idValue, { maxLength: 4 }),
      byId: fc.dictionary(cfUuid, fc.jsonValue({ maxDepth: 1 }), { maxKeys: 3 }),
    });
    fc.assert(
      fc.property(value, (input) => {
        const once = normaliseIds(input, createIdOrdinals(), ids);
        expect(normaliseIds(once, createIdOrdinals(), ids)).toEqual(once);
        expect(normaliseIds(input, createIdOrdinals(), ids)).toEqual(once);
        expect(stringsIn(once).filter(isCfUuid)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns numbers, booleans, null and non-plain objects as they are', () => {
    const at = new Date(Date.UTC(2026, 5, 30));
    const out = normaliseIds([1, true, null, at], createIdOrdinals(), ids) as unknown[];
    expect(out).toEqual([1, true, null, at]);
    expect(out[3]).toBe(at);
  });

  it.each([
    ['module id', '00000000000000000000000000000000008'],
    ['fixture moduleid', '00000000000000000000000000000000000'],
    ['admin sentinel', LEGACY_ADMIN_SENTINEL_ID],
  ])('leaves the 35-character %s %s unchanged', (_label, literal) => {
    expect(literal).toHaveLength(35);
    expect(isCfUuid(literal)).toBe(false);
    const state = createIdOrdinals();
    expect(normaliseIdsInString(literal, state, ids)).toBe(literal);
    expect(normaliseIds({ [literal]: literal }, state, ids)).toEqual({ [literal]: literal });
    expect(state.next).toBe(1);
  });

  it('treats RFC 4122 uuids as the committed rules declare, numbered apart from CF UUIDs', () => {
    expect(isCfUuid(RFC4122)).toBe(false);
    const rfc = ids.rfc4122.placeholder.replace('{n}', '1');
    const state = createIdOrdinals();
    expect(normaliseIdsInString(`${RFC4122} ${A}`, state, ids)).toBe(`${rfc} <id:1>`);
    expect(normaliseIds({ tenantId: RFC4122, id: B }, state, ids)).toEqual({ id: '<id:2>', tenantId: rfc });
    expect(state.next).toBe(3);
    expect(state.rfc4122.next).toBe(2);
    expect(normaliseIdsInString(`${RFC4122} ${A}`, createIdOrdinals())).toBe(`${RFC4122} <id:1>`);
  });
});

describe('embedded ids', () => {
  const url = `/admin/?muraAction=cusers.edituser&userid=${A}&parentid=${B}`;

  it('CF_UUID_IN_TEXT finds every id the same way on repeated use', () => {
    const first = [...url.matchAll(CF_UUID_IN_TEXT)].map((match) => match[0]);
    const second = [...url.matchAll(CF_UUID_IN_TEXT)].map((match) => match[0]);
    expect(first).toEqual([A, B]);
    expect(second).toEqual(first);
    expect(url.match(CF_UUID_IN_TEXT)).toEqual([A, B]);
    expect(url.match(CF_UUID_IN_TEXT)).toEqual([A, B]);
    expect(normaliseIdsInString(url, createIdOrdinals())).toBe(normaliseIdsInString(url, createIdOrdinals()));
    expect(CF_UUID_IN_TEXT.lastIndex).toBe(0);
  });

  it.each([
    ['a leading hex digit', `0${A}`],
    ['a trailing hex digit', `${A}0`],
    ['a trailing hyphen', `${A}-`],
  ])('CF_UUID_IN_TEXT skips an id adjoining %s', (_label, text) => {
    expect(text.match(CF_UUID_IN_TEXT)).toBeNull();
    expect(normaliseIdsInString(text, createIdOrdinals())).toBe(text);
  });

  it('replaces ids inside URLs, path lists and prose with the shared ordinals', () => {
    const state = createIdOrdinals();
    expect(normaliseIdsInString(url, state, ids)).toBe(
      '/admin/?muraAction=cusers.edituser&userid=<id:1>&parentid=<id:2>',
    );
    expect(normaliseIdsInString(`${B},${A},${C}`, state, ids)).toBe('<id:2>,<id:1>,<id:3>');
    expect(normaliseIdsInString(`Moved ${C} under ${A}.`, state, ids)).toBe('Moved <id:3> under <id:1>.');
  });

  it('replaces ids used as object keys', () => {
    expect(normaliseIds({ [A]: { parentid: B, [B]: 'child' } }, createIdOrdinals(), ids)).toEqual({
      '<id:1>': { '<id:2>': 'child', parentid: '<id:2>' },
    });
  });
});

describe('envelope fixture', () => {
  it('masks every CF UUID, giving the parent id one placeholder everywhere and keeping moduleid', () => {
    const fixture = readFixture();
    const state = createIdOrdinals();
    const out = normaliseIds(fixture, state, ids) as Fixture;
    expect(fixture).toEqual(readFixture());

    const parent = peekOrdinal(PARENT, state, ids);
    expect(parent).toBe('<id:3>');
    const placeholder = parent ?? '';
    expect(count(JSON.stringify(out), placeholder)).toBe(count(JSON.stringify(fixture), PARENT));
    expect(out.data.items).toHaveLength(2);
    for (const item of out.data.items) {
      expect(item.parentid).toBe(placeholder);
      expect(item.links.parent).toBe(`http://127.0.0.1:8500/_api/json/v1/tenant-a/content/${placeholder}`);
      expect(item.path.split(',').slice(0, 2)).toEqual([LEGACY_ADMIN_SENTINEL_ID, placeholder]);
      expect(item.moduleid).toBe('00000000000000000000000000000000000');
    }

    const strings = stringsIn(out);
    expect(strings.filter(isCfUuid)).toEqual([]);
    expect(strings.flatMap((s) => s.split(/[^0-9A-Za-z-]+/)).filter(isCfUuid)).toEqual([]);
  });
});
