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

/** The committed scenarios, in catalogue order. */
const REAL_SCENARIOS = [
  'GS-ID-01',
  'GS-ID-02',
  'GS-ID-09',
  'GS-PE-01',
  'GS-PE-02',
  'GS-PE-03',
  'GS-PE-05',
  'GS-CO-04',
  'GS-CO-06',
  'GS-PUB-04',
  'GS-UI-04',
  'GS-PE-RH-01',
  'GS-PE-RH-02',
  'GS-PE-RH-03',
  'GS-PS-07',
  'GS-CO-16',
  'GS-CO-20',
  'GS-LS-01',
  'GS-PS-09',
  'GS-CO-22',
  'GS-CO-23',
];
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
    expect(valid.scenarios.map((s) => s.id)).toEqual(['GS-ID-01', 'GS-CO-75', 'GS-PE-01', 'GS-PE-RH-01']);
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
    expect(scenarioById(valid, 'GS-CO-75').steps[0]?.extract).toEqual({
      contentid: { from: 'body', path: 'data.contentid' },
    });
  });

  it('applies scenario defaults: v0002 unless a rehearsal, and an empty override list as no overrides', () => {
    expect(valid.scenarios.map((s) => [s.id, s.tableVersion])).toEqual([
      ['GS-ID-01', 'v0002'],
      ['GS-CO-75', 'v0002'],
      ['GS-PE-01', 'v0002'],
      ['GS-PE-RH-01', 'v0003'],
    ]);
    for (const scenario of valid.scenarios) expect(scenario.normalisationOverrides, scenario.id).toEqual({});
  });

  it('fills keys a scenario omits from the catalogue defaults', () => {
    const { compare: _compare, ...withoutCompare } = scenarioById(valid, 'GS-CO-75');
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
      'a csvKeyOrder entry without its step',
      () => validVariant('normalisationOverrides: []', "normalisationOverrides: {csvKeyOrder: ['home LNAME']}"),
      /csvKeyOrder\.0: must be <step>: <column>\[, <column>…\]/,
      'scenarios/0/normalisationOverrides/csvKeyOrder/0',
    ],
    [
      'a csvKeyOrder entry naming no step',
      () => validVariant('normalisationOverrides: []', "normalisationOverrides: {csvKeyOrder: ['download: LNAME']}"),
      /csvKeyOrder download: LNAME names no step/,
      'scenarios/0/normalisationOverrides/csvKeyOrder/0',
    ],
    [
      'two csvKeyOrder entries for one step',
      () => validVariant('normalisationOverrides: []', "normalisationOverrides: {csvKeyOrder: ['home: LNAME', 'home: FNAME']}"),
      /csvKeyOrder names step home more than once/,
      'scenarios/0/normalisationOverrides/csvKeyOrder/1',
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
    expect(scenarioById(catalogue, 'GS-CO-75').sessions).toStrictEqual({
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
    expect(scenarioById(valid, 'GS-CO-75')).toBe(valid.scenarios[1]);
    expect(() => scenarioById(valid, 'GS-XX-99')).toThrow(GoldenConfigError);
    expect(() => scenarioById(valid, 'GS-XX-99')).toThrow('catalogue has no scenario GS-XX-99');
  });
});

describe('scenario ids', () => {
  it.each(['GS-ID-01', 'GS-CO-16', 'GS-PE-RH-01', 'GS-PUB-04', 'GS-UI-04'])('accepts %s', (id) => {
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

describe('step extractions', () => {
  const parsed = (extraction: Record<string, unknown>) =>
    stepSchema.safeParse({ name: 'read', route: '/admin/', extract: { value: extraction } });

  it.each([
    { from: 'dom', selector: 'h2' },
    { from: 'dom', selector: 'form[name=form1]', attr: 'action', param: 'userid' },
    { from: 'dom', selector: 'input[name=extendSetID]', attr: 'value', path: 'extended' },
    { from: 'dom', selector: '#mura-approval-apply', attr: 'onclick', pattern: "^applyApprovalAction\\('([^']+)'" },
  ])('accepts %j', (extraction) => {
    expect(parsed(extraction).data?.extract?.value).toStrictEqual(extraction);
  });

  it.each([
    { from: 'dom', selector: 'input', path: '' },
    { from: 'dom', path: 'extended' },
    { from: 'body', path: 'data.id', selector: 'input' },
    { from: 'dom', selector: 'h2', pattern: '(unclosed' },
    { from: 'dom', selector: 'h2', pattern: '(?:[0-9A-F-]+)' },
    { from: 'dom', selector: 'a', attr: 'href', param: 'userid', pattern: 'userid=(\\w+)' },
  ])('rejects %j', (extraction) => {
    expect(parsed(extraction).success).toBe(false);
  });
});

describe('scenario normalisationOverrides', () => {
  let base: Record<string, unknown>;
  beforeAll(async () => {
    base = { ...scenarioById(await loadCatalogue(VALID), 'GS-CO-75') };
  });
  const parsed = (overrides: unknown) => scenarioSchema.safeParse({ ...base, normalisationOverrides: overrides });

  it.each<Record<string, string[]>>([
    { domUnordered: ['select[name=userid]'] },
    { domUnordered: ['select[name=userid]', 'ul.sortable'], domExclude: ['.badge'], extraTokenFields: ['secret'] },
  ])('accepts %j', (overrides) => {
    expect(parsed(overrides).data?.normalisationOverrides).toStrictEqual(overrides);
  });

  it.each<unknown>([
    { domUnordered: [] },
    { domUnordered: [''] },
    { domUnordered: [1] },
    { domUnordered: 'select' },
    { domSorted: ['select'] },
  ])('rejects %j', (overrides) => {
    expect(parsed(overrides).success).toBe(false);
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

describe('multipart file sources', () => {
  const FILE_SOURCE = 'must be {field, fixture, filename, contentType} or {field, fromStep, filename, contentType}';
  const exportStep = { name: 'export', route: '/admin/?muraAction=cArch.exportcontent' };
  const upload = (source: Record<string, unknown>) => ({
    name: 'import',
    method: 'POST',
    route: '/admin/?muraAction=cArch.importcontent',
    multipart: { files: [{ field: 'newFile', filename: 'export.zip', contentType: 'application/zip', ...source }] },
  });
  const parsed = (steps: Record<string, unknown>[]) =>
    scenarioSchema.safeParse({
      id: 'GS-CO-22',
      title: 'File sources',
      service: 'strategies-content',
      role: 'admin',
      sessions: { admin: { login: 'admin', via: 'admin' } },
      steps,
      compare: ['status'],
      covers: [],
    });

  it.each<Record<string, string>>([{ fixture: 'masa-plugin-zip' }, { fromStep: 'export' }])(
    'accepts a file with source %j',
    (source) => {
      expect(parsed([exportStep, upload(source)]).data?.steps[1]?.multipart?.files).toStrictEqual([
        { field: 'newFile', filename: 'export.zip', contentType: 'application/zip', ...source },
      ]);
    },
  );

  it.each([
    { label: 'a later step', steps: [upload({ fromStep: 'export' }), exportStep], at: 0, from: 'export' },
    { label: 'its own step', steps: [exportStep, upload({ fromStep: 'import' })], at: 1, from: 'import' },
    { label: 'no step', steps: [exportStep, upload({ fromStep: 'missing' })], at: 1, from: 'missing' },
  ])('rejects a fromStep naming $label', ({ steps, at, from }) => {
    expect(parsed(steps).error?.issues).toStrictEqual([
      expect.objectContaining({
        path: ['steps', at, 'multipart', 'files', 0, 'fromStep'],
        message: `fromStep ${from} names no earlier step`,
      }),
    ]);
  });

  it.each<Record<string, string>>([{ fixture: 'masa-plugin-zip', fromStep: 'export' }, {}])(
    'rejects a file with source %j',
    (source) => {
      expect(parsed([exportStep, upload(source)]).error?.issues.map((issue) => issue.message)).toStrictEqual([
        FILE_SOURCE,
      ]);
    },
  );
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
    const base = scenarioById(valid, 'GS-CO-75');
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

  it('holds exactly the kept real scenarios, in catalogue order', () => {
    expect(ids).toEqual(REAL_SCENARIOS);
  });

  it.each([
    { id: 'GS-ID-09', sessions: ['admin', 'member'] },
    { id: 'GS-PUB-04', sessions: ['member'] },
  ])('addresses the tenant-a public pages of $id on its own domain through sessions $sessions', ({ id, sessions }) => {
    const scenario = scenarioById(catalogue, id);
    const onSite = Object.keys(scenario.sessions).filter((name) => scenario.sessions[name]?.site === 'tenant-a');
    expect(onSite).toStrictEqual(sessions);
    for (const step of scenario.steps) expect(step.route, `${id} ${step.name}`).not.toMatch(/^\/tenant-a\//);
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
    const flows = catalogue.scenarios.filter((s) => s.id.startsWith('GS-UI-')).map((s) => s.browser);
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) expect(flow).toEqual({ flow: expect.any(String), console: 'no-new-errors' });
    expect(new Set(flows.map((f) => f?.flow)).size).toBe(flows.length);
  });

  it('runs the legacy-write flows after the GS-LS scenarios, so their writes reach no earlier scenario', () => {
    const last = ids.findLastIndex((id) => id.startsWith('GS-LS-'));
    const flows = ['GS-PS-09', 'GS-CO-22', 'GS-CO-23'];
    expect(last).toBeGreaterThanOrEqual(0);
    for (const id of flows) expect(ids.indexOf(id), id).toBeGreaterThan(last);
  });

  it('holds credentials only as placeholders', () => {
    const entries = [...credentialEntries(catalogue.scenarios)];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter(([, value]) => typeof value !== 'string' || !PLACEHOLDER.test(value))).toEqual([]);

    const auths = catalogue.scenarios
      .flatMap((s) => s.steps.map((step) => step.auth))
      .filter((auth): auth is NonNullable<typeof auth> => auth !== undefined && /^(?:basic|bearer):/.test(auth));
    for (const auth of auths) expect(auth).toMatch(/^(?:basic:.+:\$\{secret:.+\}|bearer:\$\{.+\})$/s);
  });
});
