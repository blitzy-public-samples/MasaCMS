import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOGUE_PATH,
  FIXTURES_UNAVAILABLE,
  REHEARSAL_SCENARIO_IDS,
  SCENARIO_ID_PATTERN,
  catalogueSchema,
  isRehearsalScenario,
  loadCatalogue,
  readFixtureStatus,
  scenarioById,
  scenarioSchema,
  skipReason,
  stepSchema,
  type Catalogue,
  type FixtureStatus,
} from '../../src/golden/catalogue.js';
import { GoldenConfigError } from '../../src/golden/errors.js';
import { pinnedSha } from '../../src/lib/pin.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/golden/${name}`, import.meta.url));
const VALID = fixture('catalogue.valid.yaml');
const DUPLICATE_ID = fixture('catalogue.duplicate-id.yaml');
const RESERVED_MISUSE = fixture('catalogue.reserved-misuse.yaml');
const STATUS_SAMPLE = fileURLToPath(new URL('../fixtures/reporting/fixtures-unavailable.json', import.meta.url));

const range = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);

const STARTING_SET = [
  ...range('GS-ID', 9),
  ...range('GS-PE', 5),
  ...range('GS-PS', 6),
  ...range('GS-CO', 15),
  ...range('GS-PUB', 5),
  ...range('GS-UI', 5),
  'GS-BR-01',
  ...range('GS-PE-RH', 3),
];
const SYNTHETIC_PREFIXES = ['GS-TS', 'GS-FI', 'GS-SU', 'GS-RE', 'GS-CM', 'GS-ES'];
const CREDENTIAL_KEY = /password|secret/i;
const PLACEHOLDER = /^\$\{.+\}$/s;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opt2-catalogue-'));
  tempDirs.push(dir);
  return dir;
}

function writeTemp(text: string): string {
  const file = path.join(tempDir(), 'catalogue.yaml');
  writeFileSync(file, text);
  return file;
}

/** Path of a temporary copy of the valid fixture with `search` replaced once. */
function validVariant(search: string | RegExp, replacement: string): string {
  const text = readFileSync(VALID, 'utf8');
  const changed = text.replace(search, replacement);
  expect(changed).not.toBe(text);
  return writeTemp(changed);
}

async function loadError(file: string): Promise<GoldenConfigError> {
  const err = await loadCatalogue(file).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GoldenConfigError);
  return err as GoldenConfigError;
}

/** Every `[path, value]` held under a credential-named key, at any depth. */
function* credentialEntries(value: unknown, at = ''): Generator<[string, unknown]> {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const where = `${at}.${key}`;
    if (CREDENTIAL_KEY.test(key)) yield [where, child];
    yield* credentialEntries(child, where);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadCatalogue', () => {
  let valid: Catalogue;

  beforeAll(async () => {
    valid = await loadCatalogue(VALID);
  });

  it('loads a valid catalogue under the pinned source SHA, keeping file order', () => {
    expect(valid.sourceSha).toBe(pinnedSha());
    expect(valid.version).toBe(1);
    expect(valid.scenarios.map((s) => s.id)).toEqual(['GS-ID-01', 'GS-CO-05', 'GS-PE-01', 'GS-PE-RH-01']);
  });

  it('returns scenarios and steps that already satisfy their schemas', () => {
    for (const scenario of valid.scenarios) {
      expect(scenarioSchema.parse(scenario), scenario.id).toEqual(scenario);
      expect(Array.isArray(scenario.covers), scenario.id).toBe(true);
      expect(scenario.compare.length, scenario.id).toBeGreaterThan(0);
      for (const step of scenario.steps) expect(stepSchema.parse(step), `${scenario.id} ${step.name}`).toEqual(step);
    }
  });

  it('parses step fields and leaves secret placeholders unresolved', () => {
    const steps = scenarioById(valid, 'GS-ID-01').steps;
    expect(steps.find((s) => s.name === 'login')).toMatchObject({
      method: 'POST',
      route: '/admin/index.cfm',
      as: 'admin',
      csrf: 'fetch-form',
      csrfFrom: 'main',
      form: { muraAction: 'cLogin.login', username: 'admin', password: '${secret:admin}' },
    });
    expect(steps.find((s) => s.name === 'home')).toMatchObject({ method: 'GET', csrf: 'none' });
    expect(scenarioById(valid, 'GS-CO-05').steps[0]?.extract).toEqual({
      contentid: { from: 'body', path: 'data.contentid' },
    });
  });

  it('applies scenario defaults: v0002 unless a rehearsal, and an empty override list as no overrides', () => {
    expect(valid.scenarios.map((s) => [s.id, s.tableVersion])).toEqual([
      ['GS-ID-01', 'v0002'],
      ['GS-CO-05', 'v0002'],
      ['GS-PE-01', 'v0002'],
      ['GS-PE-RH-01', 'v0003'],
    ]);
    for (const scenario of valid.scenarios) expect(scenario.normalisationOverrides, scenario.id).toEqual({});
  });

  it('fills keys a scenario omits from the catalogue defaults', () => {
    const { compare: _compare, ...withoutCompare } = scenarioById(valid, 'GS-CO-05');
    const explicit = scenarioById(valid, 'GS-ID-01');
    const doc = catalogueSchema.parse({
      sourceSha: pinnedSha(),
      defaults: { compare: ['status'] },
      scenarios: [withoutCompare, explicit],
    });
    expect(doc.scenarios[0]?.compare).toEqual(['status']);
    expect(doc.scenarios[1]?.compare).toEqual(explicit.compare);
  });

  it('rejects a duplicate scenario id, naming it', async () => {
    const err = await loadError(DUPLICATE_ID);
    expect(err.message).toContain('duplicate scenario id GS-ID-01');
    expect(err.path).toBe(`${DUPLICATE_ID}#/scenarios/1/id`);
  });

  it.each([
    ['a missing file', () => path.join(tempDir(), 'absent.yaml'), /cannot be read/, null],
    ['malformed YAML', () => writeTemp('scenarios: [unclosed\n'), /is not valid YAML/, null],
    [
      'a source SHA other than the pin',
      () => validVariant(/^sourceSha: .*$/m, `sourceSha: "${'0'.repeat(40)}"`),
      /does not match the pinned source SHA/,
      'sourceSha',
    ],
    [
      'an invalid scenario id',
      () => validVariant('- id: GS-ID-01', '- id: GS-ID-1'),
      /scenarios\.0\.id: must match GS-<AREA>-NN/,
      'scenarios/0/id',
    ],
    [
      'a rehearsal scenario outside v0003',
      () => validVariant('tableVersion: v0003', 'tableVersion: v0002'),
      /tableVersion: must be v0003 for GS-PE-RH-01/,
      'scenarios/3/tableVersion',
    ],
    [
      'a session site that is not a kebab-case site id',
      () => validVariant('        via: public', '        via: public\n        site: Tenant_A'),
      /scenarios\.1\.sessions\.anon\.site: must be a lower-case kebab-case id/,
      'scenarios/1/sessions/anon/site',
    ],
  ])('rejects %s with GoldenConfigError', async (_label, makeFile, message, pointer) => {
    const file = makeFile();
    const err = await loadError(file);
    expect(err.message).toMatch(message);
    expect(err.path).toBe(pointer === null ? file : `${file}#/${pointer}`);
  });

  it('reads a session site and keeps sessions without one as declared', async () => {
    const catalogue = await loadCatalogue(validVariant('        via: public', '        via: public\n        site: tenant-a'));
    expect(scenarioById(catalogue, 'GS-CO-05').sessions).toStrictEqual({
      anon: { login: 'none', via: 'public', site: 'tenant-a' },
    });
    expect(scenarioById(catalogue, 'GS-ID-01').sessions).toStrictEqual(scenarioById(valid, 'GS-ID-01').sessions);
  });

  it('loads reserved-identity misuse, which coverage reports rather than the schema', async () => {
    const catalogue = await loadCatalogue(RESERVED_MISUSE);
    expect(catalogue.scenarios.map((s) => s.id)).toEqual(expect.arrayContaining(['GS-PE-02', 'GS-PE-RH-02']));
    expect(scenarioById(catalogue, 'GS-PE-RH-02').seedRefs).toEqual([
      { as: 'rehearsalPerson', source: 'reserved', path: 'reserved.rehearsal.persons', index: 1 },
    ]);
  });

  it('finds a scenario by id and throws GoldenConfigError for an unknown one', () => {
    expect(scenarioById(valid, 'GS-CO-05')).toBe(valid.scenarios[1]);
    expect(() => scenarioById(valid, 'GS-XX-99')).toThrow(GoldenConfigError);
    expect(() => scenarioById(valid, 'GS-XX-99')).toThrow('catalogue has no scenario GS-XX-99');
  });
});

describe('scenario ids', () => {
  it.each(['GS-ID-01', 'GS-CO-15', 'GS-PE-RH-01', 'GS-PUB-05', 'GS-UI-01'])('accepts %s', (id) => {
    expect(SCENARIO_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(['gs-id-01', 'GS-ID-1', 'GS-ID-001', 'GS-PE-RH-1', 'GS-01', 'GS-ID-01 '])('rejects %j', (id) => {
    expect(SCENARIO_ID_PATTERN.test(id)).toBe(false);
  });

  it.each([
    ['GS-PE-RH-01', true],
    ['GS-PE-RH-03', true],
    ['GS-PE-01', false],
    ['GS-PE-RH-04', false],
  ])('isRehearsalScenario(%s) is %s', (id, expected) => {
    expect(isRehearsalScenario(id)).toBe(expected);
  });
});

describe('stepSchema mergeHidden', () => {
  const save = { name: 'save', method: 'POST', route: '/admin/?muraAction=cArch.update', form: { title: 'FIXTURE' } };

  it.each<[Record<string, unknown>, boolean | undefined]>([
    [{ csrf: 'fetch-form', mergeHidden: false }, false],
    [{ csrf: 'fetch-form', mergeHidden: true }, true],
    [{ csrf: 'fetch-form' }, undefined],
  ])('accepts %j, parsing mergeHidden as %s without a default', (fields, expected) => {
    const step = stepSchema.parse({ ...save, ...fields });
    expect(step.mergeHidden).toBe(expected);
    expect(Object.hasOwn(step, 'mergeHidden')).toBe(expected !== undefined);
  });

  it.each<Record<string, unknown>>([
    { mergeHidden: false },
    { csrf: 'none', mergeHidden: true },
    { csrf: 'json-api:editContent', mergeHidden: false },
  ])('rejects %j: mergeHidden needs csrf fetch-form', (fields) => {
    const result = stepSchema.safeParse({ ...save, ...fields });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toStrictEqual([
      expect.objectContaining({ path: ['mergeHidden'], message: 'mergeHidden is allowed only with csrf: fetch-form' }),
    ]);
  });
});

describe('readFixtureStatus', () => {
  it('reads <state>/fixtures.json as written', () => {
    const dir = tempDir();
    copyFileSync(STATUS_SAMPLE, path.join(dir, 'fixtures.json'));
    expect(readFixtureStatus({ OPT2_STATE_DIR: dir })).toEqual(JSON.parse(readFileSync(STATUS_SAMPLE, 'utf8')));
  });

  it('reads an available status', () => {
    const dir = tempDir();
    const status: FixtureStatus = { available: true, reason: null, checkedAt: '2026-06-30T00:00:00Z' };
    writeFileSync(path.join(dir, 'fixtures.json'), JSON.stringify(status));
    expect(readFixtureStatus({ OPT2_STATE_DIR: dir })).toEqual(status);
  });

  it('reads a missing file as unavailable, checked now', () => {
    const before = Date.now();
    const status = readFixtureStatus({ OPT2_STATE_DIR: tempDir() });
    expect(status).toMatchObject({ available: false, reason: 'fixtures.json not found' });
    expect(Date.parse(status.checkedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(status.checkedAt)).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['unreadable', (file: string) => mkdirSync(file), /cannot be read/],
    ['not JSON', (file: string) => writeFileSync(file, '{'), /is not valid JSON/],
    ['off-schema', (file: string) => writeFileSync(file, '{"available":"no"}'), /available/],
  ])('throws GoldenConfigError when the status file is %s', (_label, write, message) => {
    const dir = tempDir();
    const file = path.join(dir, 'fixtures.json');
    write(file);
    let err: unknown;
    try {
      readFixtureStatus({ OPT2_STATE_DIR: dir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect((err as GoldenConfigError).message).toMatch(message);
    expect((err as GoldenConfigError).path).toBe(file);
  });
});

describe('skipReason', () => {
  let valid: Catalogue;

  beforeAll(async () => {
    valid = await loadCatalogue(VALID);
  });

  it.each([
    [true, false, 'skipped: fixtures unavailable'],
    [true, true, null],
    [false, false, null],
    [false, true, null],
  ])('fixtures required: %s, available: %s gives %j', (required, available, expected) => {
    const base = scenarioById(valid, 'GS-CO-05');
    const scenario = required ? scenarioSchema.parse({ ...base, fixtures: 'required' }) : base;
    expect(scenario.fixtures).toBe(required ? 'required' : undefined);
    expect(skipReason(scenario, { available })).toBe(expected);
  });

  it('skips a fixture-dependent scenario under the recorded unavailable status', () => {
    const dir = tempDir();
    copyFileSync(STATUS_SAMPLE, path.join(dir, 'fixtures.json'));
    expect(skipReason({ fixtures: 'required' }, readFixtureStatus({ OPT2_STATE_DIR: dir }))).toBe(FIXTURES_UNAVAILABLE);
  });
});

describe('committed catalogue', () => {
  let catalogue: Catalogue;
  let ids: string[];

  beforeAll(async () => {
    catalogue = await loadCatalogue();
    ids = catalogue.scenarios.map((s) => s.id);
  });

  it('is the default catalogue path', () => {
    expect(CATALOGUE_PATH).toBe(fileURLToPath(new URL('../../golden/catalogue.yaml', import.meta.url)));
    expect(catalogue.sourceSha).toBe(pinnedSha());
  });

  it('has unique, well-formed ids and every scenario has steps and covers', () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of catalogue.scenarios) {
      expect(scenario.id).toMatch(SCENARIO_ID_PATTERN);
      expect(scenario.steps.length, scenario.id).toBeGreaterThan(0);
      expect(Array.isArray(scenario.covers), scenario.id).toBe(true);
    }
  });

  it('holds the starting scenario set', () => {
    expect(ids).toEqual(expect.arrayContaining(STARTING_SET));
  });

  it.each([
    { id: 'GS-ID-09', sessions: ['admin', 'member'] },
    { id: 'GS-PUB-01', sessions: ['visitor'] },
    { id: 'GS-PUB-02', sessions: ['member'] },
    { id: 'GS-PUB-03', sessions: ['member', 'visitor'] },
    { id: 'GS-PUB-04', sessions: ['member'] },
    { id: 'GS-PUB-05', sessions: ['visitor'] },
    { id: 'GS-LS-02', sessions: ['visitor'] },
    { id: 'GS-BR-01', sessions: ['admin'] },
  ])('addresses the tenant-a public pages of $id on its own domain through sessions $sessions', ({ id, sessions }) => {
    const scenario = scenarioById(catalogue, id);
    const onSite = Object.keys(scenario.sessions).filter((name) => scenario.sessions[name]?.site === 'tenant-a');
    expect(onSite).toStrictEqual(sessions);
    for (const step of scenario.steps) expect(step.route, `${id} ${step.name}`).not.toMatch(/^\/tenant-a\//);
  });

  it.each(SYNTHETIC_PREFIXES)('holds %s scenarios that all require the legacy fixtures', (prefix) => {
    const scenarios = catalogue.scenarios.filter((s) => s.id.startsWith(`${prefix}-`));
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) expect(scenario.fixtures, scenario.id).toBe('required');
  });

  it('replays exactly the rehearsal scenarios under v0003', () => {
    const v0003 = catalogue.scenarios.filter((s) => s.tableVersion === 'v0003').map((s) => s.id);
    expect(v0003).toEqual([...REHEARSAL_SCENARIO_IDS]);
    expect(v0003).toEqual(ids.filter(isRehearsalScenario));
    for (const scenario of catalogue.scenarios.filter((s) => !isRehearsalScenario(s.id))) {
      expect(scenario.tableVersion, scenario.id).toBe('v0002');
    }
  });

  it('gives each GS-UI scenario its own browser flow', () => {
    const flows = range('GS-UI', 5).map((id) => scenarioById(catalogue, id).browser);
    for (const flow of flows) expect(flow).toEqual({ flow: expect.any(String), console: 'no-new-errors' });
    expect(new Set(flows.map((f) => f?.flow)).size).toBe(flows.length);
  });

  it("posts GS-CO-02's edit save without the form's other hidden fields", () => {
    expect(scenarioById(catalogue, 'GS-CO-02').steps.find((s) => s.name === 'page')?.mergeHidden).toBe(false);
  });

  it('holds credentials only as placeholders', () => {
    const entries = [...credentialEntries(catalogue.scenarios)];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter(([, value]) => typeof value !== 'string' || !PLACEHOLDER.test(value))).toEqual([]);

    const auths = catalogue.scenarios
      .flatMap((s) => s.steps.map((step) => step.auth))
      .filter((auth): auth is NonNullable<typeof auth> => auth !== undefined && /^(?:basic|bearer):/.test(auth));
    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) expect(auth).toMatch(/^(?:basic:.+:\$\{secret:.+\}|bearer:\$\{.+\})$/s);
  });
});
