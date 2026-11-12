import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadCatalogue, type Scenario } from '../../../src/golden/catalogue.js';
import { GoldenConfigError } from '../../../src/golden/errors.js';
import {
  KNOWN_ISSUE_IDS,
  RULES_PATH,
  applyOverrides,
  loadRules,
  ruleEnabled,
  ruleIds,
  type NormaliseRules,
} from '../../../src/golden/normalise/rules.js';
import type { EnvLike } from '../../../src/lib/paths.js';
import { pinnedSha } from '../../../src/lib/pin.js';

const PIN = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const ENV: EnvLike = { PORT: '8500' };
// The committed file and its strict schema carry the scenario-override operations as a 19th section.
const SECTIONS = [
  'sourceSha',
  'version',
  'origins',
  'ids',
  'timestamps',
  'tokens',
  'urls',
  'headers',
  'auth',
  'envelope',
  'dom',
  'exports',
  'transitions',
  'mail',
  'rows',
  'tasks',
  'files',
  'knownIssues',
  'overrides',
];

interface RulesDoc {
  sourceSha: string;
  headers: { drop: string[] };
  tokens: { fields: string[] };
  [section: string]: unknown;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let dir = '';
let committedText = '';
let committedHash = '';
let rules: NormaliseRules;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-normalise-rules-'));
  const bytes = await readFile(RULES_PATH);
  committedHash = sha256(bytes);
  committedText = bytes.toString('utf8');
  rules = loadRules(undefined, ENV);
});

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  expect(sha256(await readFile(RULES_PATH))).toBe(committedHash);
});

/** Writes `doc` to a temp copy named `name` and returns its path. */
async function writeCopy(name: string, doc: RulesDoc): Promise<string> {
  const file = path.join(dir, `${name}.yaml`);
  await writeFile(file, stringify(doc), 'utf8');
  return file;
}

function loadError(file: string): GoldenConfigError {
  let thrown: unknown;
  try {
    loadRules(file, ENV);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(GoldenConfigError);
  return thrown as GoldenConfigError;
}

describe('loadRules', () => {
  it('loads the committed rules from the default path with every section', () => {
    expect(RULES_PATH.endsWith(path.join('harness', 'golden', 'normalise.yaml'))).toBe(true);
    const raw = parse(committedText) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toStrictEqual([...SECTIONS].sort());
    expect(Object.keys(rules).sort()).toStrictEqual([...SECTIONS].sort());
    expect(rules.origins.values).toStrictEqual(['http://127.0.0.1:8500', 'http://127.0.0.1:8100']);
    expect(Object.isFrozen(rules.headers.drop)).toBe(true);
  });

  it('binds the pinned source SHA', () => {
    expect(rules.sourceSha).toBe(pinnedSha());
    expect(rules.sourceSha).toBe(PIN);
  });

  it('declares exactly the four known-issue masks', () => {
    expect([...KNOWN_ISSUE_IDS].sort()).toStrictEqual([
      'date-mask',
      'default-member',
      'header-search-404',
      'session-rotation',
    ]);
    expect(rules.knownIssues.map((issue) => issue.id).sort()).toStrictEqual([...KNOWN_ISSUE_IDS].sort());
  });

  it('loads an unmodified copy written outside the checkout', async () => {
    const file = await writeCopy('unmodified', parse(committedText) as RulesDoc);
    expect(loadRules(file, ENV)).toStrictEqual(rules);
  });

  it.each<[string, (doc: RulesDoc) => void, string, string]>([
    [
      'a sourceSha that is not the pin',
      (doc) => {
        doc.sourceSha = '0'.repeat(40);
      },
      'sourceSha',
      `does not match the pinned source SHA ${PIN}`,
    ],
    [
      'a dropped-header list without Date',
      (doc) => {
        doc.headers.drop = doc.headers.drop.filter((name) => name.toLowerCase() !== 'date');
      },
      'headers/drop',
      'headers.drop: must include Date',
    ],
    [
      'a token-field list without csrf_token',
      (doc) => {
        doc.tokens.fields = doc.tokens.fields.filter((name) => name.toLowerCase() !== 'csrf_token');
      },
      'tokens/fields',
      'tokens.fields: must include csrf_token',
    ],
  ])('rejects a copy with %s', async (_label, mutate, pointer, message) => {
    const doc = parse(committedText) as RulesDoc;
    mutate(doc);
    const file = await writeCopy(pointer.replaceAll('/', '-'), doc);
    const err = loadError(file);
    expect(err.path).toBe(`${file}#/${pointer}`);
    expect(err.message).toContain(message);
  });

  it.each<[string, string, string | undefined, string]>([
    ['a missing file', 'absent.yaml', undefined, 'cannot be read'],
    ['text that is not YAML', 'broken.yaml', 'origins: [unclosed\n', 'are not valid YAML'],
  ])('rejects %s', async (_label, name, text, message) => {
    const file = path.join(dir, name);
    if (text !== undefined) await writeFile(file, text, 'utf8');
    const err = loadError(file);
    expect(err.path).toBe(file);
    expect(err.message).toContain(message);
  });
});

describe('ruleIds', () => {
  it('lists unique, non-empty ids in the same order on every load', () => {
    const ids = [...ruleIds(rules)];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ruleIds(loadRules(RULES_PATH, ENV))]).toStrictEqual(ids);
  });

  it('includes every known-issue id', () => {
    const ids = ruleIds(rules);
    expect(KNOWN_ISSUE_IDS.filter((id) => !ids.has(id))).toStrictEqual([]);
  });

  it('includes every rule id a catalogue scenario applies', async () => {
    const catalogue = await loadCatalogue();
    const ids = ruleIds(rules);
    const applied = catalogue.scenarios.flatMap((scenario) => scenario.normalisationOverrides.applyRules ?? []);
    expect(applied.filter((id) => !ids.has(id))).toStrictEqual([]);
  });
});

describe('applyOverrides', () => {
  it('enables only the opt-in rule it names and leaves the input untouched', () => {
    const ids = [...ruleIds(rules)];
    const target = ids.find((id) => !ruleEnabled(rules, id));
    if (target === undefined) throw new Error('the committed rules declare no opt-in rule');
    const before = structuredClone(rules);

    const result = applyOverrides(rules, { applyRules: [target] });

    expect(rules).toStrictEqual(before);
    expect(ids.filter((id) => ruleEnabled(result, id) !== ruleEnabled(rules, id))).toStrictEqual([target]);
    expect(result.overrides.applied.applyRules).toStrictEqual([target]);
    expect({ ...result, overrides: { ...result.overrides, applied: rules.overrides.applied } }).toStrictEqual(rules);
  });

  it('records the owning scenario and refuses a second scenario on the same rules', () => {
    const result = applyOverrides(rules, { dropHeaders: ['X-Extra'] }, 'GS-CO-15');
    expect(result.overrides.applied.scenario).toBe('GS-CO-15');
    expect(result.headers.drop).toContain('X-Extra');
    expect(() => applyOverrides(result, { dropHeaders: ['X-Other'] }, 'GS-CO-05')).toThrow(
      'rules already carry the overrides of scenario GS-CO-15',
    );
  });

  it.each<[string, Scenario['normalisationOverrides'] | undefined]>([
    ['an empty override set', {}],
    ['an empty applyRules list', { applyRules: [] }],
    ['no overrides', undefined],
  ])('returns the input rules for %s', (_label, overrides) => {
    const result = applyOverrides(rules, overrides);
    expect(result).toStrictEqual(structuredClone(rules));
    expect(result).toBe(rules);
  });

  it.each([
    ['an unknown rule id', 'no-such-rule', 'applyRules names unknown rule id no-such-rule'],
    ['a known-issue mask', 'date-mask', 'applyRules names known-issue mask date-mask'],
  ])('rejects %s', (_label, id, message) => {
    expect(() => applyOverrides(rules, { applyRules: [id] })).toThrow(GoldenConfigError);
    expect(() => applyOverrides(rules, { applyRules: [id] })).toThrow(message);
  });
});
