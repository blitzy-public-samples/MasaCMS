import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEGACY_JSON_CONTENT_TYPE, cfHash, cfUuid, legacyHeaders } from '@opt2/platform/legacy-compat';
import { encodeRow, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { goldenRun, readGoldenSet, type GoldenSet } from '../../../src/golden/capture.js';
import {
  loadCatalogue,
  scenarioById,
  scenarioSchema,
  type Catalogue,
  type CompareKind,
  type Scenario,
} from '../../../src/golden/catalogue.js';
import {
  ETAG_OK,
  SIDE_EFFECTS_STEP,
  compareNormalised,
  createNormaliseState,
  loadRules,
  normaliseBody,
  normaliseSideEffects,
  normaliseStep,
  type Difference,
  type DomControl,
  type NormaliseRules,
  type NormaliseState,
  type NormalisedRun,
  type NormalisedSideEffects,
  type NormalisedStep,
  type StateTransitions,
} from '../../../src/golden/normalise/index.js';
import type { RowSnapshot, SideEffects } from '../../../src/golden/side-effects.js';
import type { RecordedResponse, StepRecord } from '../../../src/golden/steps.js';

const LEGACY = 'http://127.0.0.1:8500';
const GATEWAY = 'http://127.0.0.1:8100';
const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=UTF-8';
const CF_UUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}/g;
const CONTENT_ROUTE = 'api:content.findone';
const EDIT_USER_ROUTE = 'admin:cusers.edituser';
const ROWS_UNIT = 'content.content';
const ROW_COLUMNS: CanonicalColumn[] = [
  { name: 'ContentID', type: 's' },
  { name: 'Title', type: 's' },
];

const ENVELOPES: readonly [string, number][] = [
  ['envelope-success.json', 200],
  ['envelope-error-400-invalid-parameters.json', 400],
  ['envelope-error-400-invalid-method.json', 400],
  ['envelope-error-400-bad-request.json', 400],
  ['envelope-error-400-invalid-csrf.json', 400],
  ['envelope-error-401-insufficient-permissions.json', 401],
  ['envelope-error-401-invalid-token.json', 401],
  ['envelope-error-500-server-error.json', 500],
];

const fixturePath = (path: string): string => fileURLToPath(new URL(`../../fixtures/${path}`, import.meta.url));
const readFixture = (path: string): string => readFileSync(fixturePath(path), 'utf8');

const SUCCESS = readFixture('http/envelope-success.json');
const EDIT_USER_HTML = readFixture('html/admin-edituser.html');
const SITE_MANAGER = readFixture('html/site-manager.json');

let rules: NormaliseRules;
let catalogue: Catalogue;
let contentRead: Scenario;

beforeAll(async () => {
  rules = loadRules(undefined, { PORT: '8500' });
  catalogue = await loadCatalogue(fixturePath('golden/catalogue.valid.yaml'));
  contentRead = scenarioById(catalogue, 'GS-CO-05');
});

interface RecordSpec {
  name?: string;
  index?: number;
  routeKey?: string;
  status?: number;
  contentType: string;
  text?: string;
  bytes?: Buffer;
  headers?: Record<string, string | string[]>;
  hops?: RecordedResponse['hops'];
}

/** A step record shaped as the step runner records it; a JSON body carries the legacy ETag of its exact text. */
function stepRecord(spec: RecordSpec): StepRecord {
  const raw = spec.bytes ?? Buffer.from(spec.text ?? '', 'utf8');
  const headers: Record<string, string | string[]> = { 'content-type': spec.contentType };
  if (spec.text !== undefined && spec.contentType.startsWith('application/json')) headers.etag = cfHash(spec.text);
  const base = {
    status: spec.status ?? 200,
    headers: { ...headers, ...spec.headers },
    contentType: spec.contentType,
    sha256: createHash('sha256').update(raw).digest('hex'),
    hops: spec.hops ?? [],
  };
  const response: RecordedResponse =
    spec.bytes === undefined ? { ...base, text: spec.text ?? '' } : { ...base, bytesBase64: spec.bytes.toString('base64') };
  return {
    name: spec.name ?? 'findone',
    index: spec.index ?? 0,
    routeKey: spec.routeKey ?? CONTENT_ROUTE,
    request: { method: 'GET', url: '/index.cfm/_api/json/v1/tenant-a/content/', headers: {}, body: { kind: 'none' } },
    response,
    extracted: {},
  };
}

function comparing(compare: CompareKind[], extra: Partial<Scenario> = {}): Scenario {
  return scenarioSchema.parse({ ...contentRead, compare, ...extra });
}

async function normalise(records: readonly StepRecord[], scenario: Scenario): Promise<NormalisedStep[]> {
  const ctx = { state: createNormaliseState(), rules, scenario };
  const steps: NormalisedStep[] = [];
  for (const record of records) steps.push(await normaliseStep(record, ctx));
  return steps;
}

async function normaliseOne(
  record: StepRecord,
  scenario: Scenario,
  state: NormaliseState = createNormaliseState(),
): Promise<NormalisedStep> {
  return normaliseStep(record, { state, rules, scenario });
}

const run = (steps: readonly NormalisedStep[], sideEffects: NormalisedSideEffects = {}): NormalisedRun => ({
  steps,
  sideEffects,
});

const ordinal = (n: number): string => rules.ids.placeholder.replace('{n}', String(n));

const verdicts = (differences: readonly Difference[]): Record<string, string> =>
  Object.fromEntries(
    differences.map((d) => [d.path, d.maskId === undefined ? d.classification : `${d.classification}:${d.maskId}`]),
  );

function gatewayCopy(text: string): string {
  const remapped = new Map<string, string>();
  return text
    .replaceAll(LEGACY, GATEWAY)
    .replaceAll('FIXTURE-TOKEN-1', 'FIXTURE-TOKEN-2')
    .replace(/"csrf_token": "[^"]*"/, '"csrf_token": "FIXTURECSRFTOKEN0000000000000002"')
    .replace(/"csrf_token_expires": "[^"]*"/, '"csrf_token_expires": "260630140000000"')
    .replace(CF_UUID, (id) => {
      const next = remapped.get(id) ?? cfUuid();
      remapped.set(id, next);
      return next;
    });
}

function controlPath(step: NormalisedStep, match: (control: DomControl) => boolean, field: string): string {
  const index = step.domModel?.controls.findIndex(match) ?? -1;
  expect(index, 'fixture control').toBeGreaterThanOrEqual(0);
  return `domModel.controls[${index}].${field}`;
}

function replaced(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe('normaliseStep representations', () => {
  it.each(ENVELOPES)('represents %s by its envelope alone', async (file, status) => {
    const text = readFixture(`http/${file}`);
    const raw = JSON.parse(text) as Record<string, unknown>;
    const step = await normaliseOne(stepRecord({ status, contentType: JSON_TYPE, text }), comparing(['status', 'envelope']));
    const envelope = step.envelope as Record<string, unknown>;
    expect(step.status).toBe(status);
    expect(envelope).toMatchObject({ apiversion: 'v1', method: raw.method });
    expect(Object.keys(envelope).sort()).toStrictEqual(Object.keys(raw).sort());
    expect(envelope.error).toStrictEqual(raw.error);
    expect(envelope.params).toStrictEqual(raw.params);
    expect(step.maskedPaths).toStrictEqual({});
    for (const part of ['body', 'domModel', 'export', 'headers', 'auth'] as const) expect(step[part]).toBeUndefined();
  });

  it('adds headers only when compared, with the ETag checked against the raw body', async () => {
    const record = stepRecord({
      contentType: JSON_TYPE,
      text: SUCCESS,
      headers: { date: 'Tue, 30 Jun 2026 12:00:00 GMT', generator: 'Masa CMS 7.6.1' },
    });
    const without = await normaliseOne(record, comparing(['status', 'envelope']));
    const step = await normaliseOne(record, comparing(['status', 'envelope', 'headers']));
    expect(without.headers).toBeUndefined();
    expect(step.headers).toStrictEqual({ 'content-type': JSON_TYPE, etag: ETAG_OK, generator: 'Masa CMS 7.6.1' });
    expect(step.auth).toBeUndefined();
  });

  it('adds auth only when compared, from the Set-Cookie of every hop', async () => {
    const setCookie = ['CFID=FIXTURE-CFID-1;Path=/;HttpOnly'];
    const hop = {
      method: 'GET',
      url: `${LEGACY}/index.cfm/_api/json/v1/tenant-a/content/`,
      status: 200,
      setCookie,
      requestHeaders: {},
      responseHeaders: { 'content-type': JSON_TYPE, 'set-cookie': setCookie },
    };
    const record = stepRecord({ contentType: JSON_TYPE, text: SUCCESS, headers: { 'set-cookie': setCookie }, hops: [hop] });
    const without = await normaliseOne(record, comparing(['status', 'envelope']));
    const step = await normaliseOne(record, comparing(['status', 'envelope', 'auth']));
    expect(without.auth).toBeUndefined();
    expect(step.auth).toStrictEqual({
      cookies: [
        {
          name: 'CFID',
          value: rules.auth.cookies.value,
          path: '/',
          httpOnly: true,
          secure: false,
          persistence: 'session',
          hop: 0,
          rotation: 'first',
        },
      ],
      wwwAuthenticate: [],
      redirectTargets: [],
    });
    expect(step.headers).toBeUndefined();
  });

  it('represents admin HTML by its DOM model when the DOM is compared, else as normalised text', async () => {
    const record = stepRecord({ name: 'form', routeKey: EDIT_USER_ROUTE, contentType: HTML_TYPE, text: EDIT_USER_HTML });
    const step = await normaliseOne(record, comparing(['status', 'dom']));
    expect(step.domModel?.controls).toContainEqual(expect.objectContaining({ name: 'fname', value: 'Fixture' }));
    expect(step.envelope).toBeUndefined();
    expect(step.body).toBeUndefined();
    const text = await normaliseOne(record, comparing(['status', 'envelope']));
    expect(text.domModel).toBeUndefined();
    expect(typeof text.body).toBe('string');
  });

  it('represents a CSV download by its cell grid when exports are compared', async () => {
    const csv = readFixture('exports/users.csv');
    const record = stepRecord({ routeKey: 'admin:cusers.download', contentType: 'text/csv', text: csv });
    const step = await normaliseOne(record, comparing(['status', 'export']));
    expect(step.export?.kind).toBe('csv');
    expect(step.export).toMatchObject({ rows: expect.arrayContaining([expect.arrayContaining(['COMPANY', 'USERID'])]) });
    expect(JSON.stringify(step.export)).not.toMatch(new RegExp(CF_UUID.source));
    expect(step.body).toBeUndefined();
  });

  it('represents a PDF download by the text of each page when exports are compared, else by its digest', async () => {
    const bytes = readFileSync(fixturePath('exports/tiny.pdf'));
    const record = stepRecord({ routeKey: 'admin:carch.downloaddata', contentType: 'application/pdf', bytes });
    const step = await normaliseOne(record, comparing(['status', 'export']));
    const digest = await normaliseOne(record, comparing(['status', 'envelope']));
    expect(step.export).toStrictEqual({ kind: 'pdf', pages: ['Fixture report page 1'] });
    expect(digest.export).toStrictEqual({ kind: 'file', sha256: record.response.sha256, contentType: 'application/pdf' });
  });

  it("reads a legacy body whose JSON escapes ' as \\'", async () => {
    const text = String.raw`{"apiversion":"v1","method":"findOne","data":{"title":"Masa\'s page"}}`;
    const step = await normaliseOne(stepRecord({ contentType: JSON_TYPE, text }), comparing(['status', 'envelope']));
    expect(step.envelope).toStrictEqual({ apiversion: 'v1', data: { title: "Masa's page" }, method: 'findOne' });
  });
});

describe('normaliseBody', () => {
  it('turns embedded admin markup into its DOM model and keeps the other fields of the response', () => {
    const scenario = comparing(['status', 'dom']);
    const body = normaliseBody(JSON_TYPE, SITE_MANAGER, { state: createNormaliseState(), rules, scenario });
    expect(body.envelope).toBeUndefined();
    expect(body.body).toMatchObject({ perm: 'editor', sortby: 'orderno', html: { controls: expect.any(Array) } });
    expect(JSON.stringify(body)).not.toMatch(/77777777-|88888888-|FIXTURECSRFTOKEN/);
    expect(body.maskedPaths).toStrictEqual({});
  });

  it('normalises a JSON XHR body by the same rules as a step envelope', async () => {
    const scenario = comparing(['status', 'envelope']);
    const xhr = normaliseBody(JSON_TYPE, SUCCESS, { state: createNormaliseState(), rules, scenario });
    const step = await normaliseOne(stepRecord({ contentType: JSON_TYPE, text: SUCCESS }), scenario);
    expect(xhr).toStrictEqual({ envelope: step.envelope, maskedPaths: {} });
    const plain = JSON.stringify({ contentid: cfUuid(), csrf_token: 'FIXTURECSRFTOKEN0000000000000001' });
    expect(normaliseBody(JSON_TYPE, plain, { state: createNormaliseState(), rules, scenario })).toStrictEqual({
      body: { contentid: ordinal(1), csrf_token: rules.tokens.placeholder },
      maskedPaths: {},
    });
  });
});

describe('scenario normalisationOverrides', () => {
  it('drops, sorts and keeps literal the JSON paths a scenario names', async () => {
    const scenario = comparing(['status', 'envelope'], {
      normalisationOverrides: {
        dropPaths: ['data.links'],
        sortArrays: ['data.items'],
        literalPaths: ['data.items[*].contenthistid'],
      },
    });
    const raw = JSON.parse(SUCCESS) as { data: { items: unknown[]; links: Record<string, string> } };
    const reordered = JSON.stringify({
      ...raw,
      data: { ...raw.data, items: [...raw.data.items].reverse(), links: { self: `${GATEWAY}/elsewhere` } },
    });
    const golden = await normaliseOne(stepRecord({ contentType: JSON_TYPE, text: SUCCESS }), scenario);
    const replay = await normaliseOne(stepRecord({ contentType: JSON_TYPE, text: reordered }), scenario);
    const data = (golden.envelope as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('links');
    expect(data.items).toContainEqual(
      expect.objectContaining({ contenthistid: '8A9B0C1D-2E3F-4A5B-9C6D7E8F9A0B1C2D', contentid: expect.stringMatching(/^<id:\d+>$/) }),
    );
    expect(compareNormalised(run([golden]), run([replay]), { rules, scenario })).toStrictEqual([]);
  });

  it('drops the error stack trace only when the scenario applies error-stacktrace', async () => {
    const raw = JSON.parse(readFixture('http/envelope-error-500-server-error.json')) as { error: object };
    const text = JSON.stringify({ ...raw, error: { ...raw.error, stacktrace: { type: 'expression' } } });
    const record = stepRecord({ status: 500, contentType: JSON_TYPE, text });
    const kept = await normaliseOne(record, comparing(['status', 'envelope']));
    const dropped = await normaliseOne(
      record,
      comparing(['status', 'envelope'], { normalisationOverrides: { applyRules: ['error-stacktrace'] } }),
    );
    expect(kept.envelope).toHaveProperty('error.stacktrace');
    expect(dropped.envelope).toMatchObject({ error: raw.error });
    expect(dropped.envelope).not.toHaveProperty('error.stacktrace');
  });
});

describe('compareNormalised steps', () => {
  it('normalises a legacy response and its gateway replay to the same step', async () => {
    const served = { ...legacyHeaders(), date: 'Tue, 30 Jun 2026 12:00:00 GMT' };
    const replayText = gatewayCopy(SUCCESS);
    expect(replayText.match(CF_UUID)).not.toStrictEqual(SUCCESS.match(CF_UUID));
    const legacy = stepRecord({ contentType: LEGACY_JSON_CONTENT_TYPE, text: SUCCESS, headers: served });
    const gateway = stepRecord({
      contentType: LEGACY_JSON_CONTENT_TYPE,
      text: replayText,
      headers: {
        ...served,
        traceparent: '00-00000000000000000000000000000001-0000000000000001-01',
        'x-request-id': 'fixture-request-2',
      },
    });
    const golden = await normaliseOne(legacy, contentRead);
    const replay = await normaliseOne(gateway, contentRead);
    expect(replay).toStrictEqual(golden);
    expect(golden.headers).toMatchObject({ etag: ETAG_OK });
    expect(compareNormalised(run([golden]), run([replay]), { rules, scenario: contentRead })).toStrictEqual([]);
  });

  it('finds no difference between the committed golden set and replay output samples', async () => {
    const golden = goldenRun(await readGoldenSet('GS-CO-05', fixturePath('golden/golden-set.sample.json')));
    const output = JSON.parse(readFixture('golden/replay-output.sample.json')) as Pick<GoldenSet, 'steps' | 'sideEffects'>;
    const replay = goldenRun(output);
    expect(replay.steps.map((step) => [step.name, step.routeKey])).toStrictEqual([['findone', CONTENT_ROUTE]]);
    expect(compareNormalised(golden, replay, { rules, scenario: contentRead })).toStrictEqual([]);
  });

  it('reports a step on one side only as missing or extra at the root path', async () => {
    const scenario = comparing(['status', 'envelope']);
    const record = (name: string, index: number): StepRecord =>
      stepRecord({ name, index, contentType: JSON_TYPE, text: SUCCESS });
    const golden = await normalise([record('findone', 0), record('again', 1)], scenario);
    const replay = await normalise([record('findone', 0), record('later', 2)], scenario);
    expect(compareNormalised(run(golden), run(replay), { rules, scenario })).toStrictEqual([
      {
        step: 'again',
        path: '',
        kind: 'missing',
        expected: { index: 1, routeKey: CONTENT_ROUTE },
        actual: undefined,
        classification: 'difference',
      },
      {
        step: 'later',
        path: '',
        kind: 'extra',
        expected: undefined,
        actual: { index: 2, routeKey: CONTENT_ROUTE },
        classification: 'difference',
      },
    ]);
  });

  it('compares the status exactly', async () => {
    const scenario = comparing(['status', 'envelope']);
    const golden = await normaliseOne(stepRecord({ contentType: JSON_TYPE, text: SUCCESS }), scenario);
    const replay = await normaliseOne(stepRecord({ status: 201, contentType: JSON_TYPE, text: SUCCESS }), scenario);
    expect(compareNormalised(run([golden]), run([replay]), { rules, scenario })).toStrictEqual([
      { step: 'findone', path: 'status', kind: 'status', expected: 200, actual: 201, classification: 'difference' },
    ]);
  });

  it('reports a changed body field at its envelope path', async () => {
    const scenario = comparing(['status', 'envelope']);
    const renamed = replaced(SUCCESS, '"title": "About Us"', '"title": "About Them"');
    const golden = await normaliseOne(stepRecord({ contentType: JSON_TYPE, text: SUCCESS }), scenario);
    const replay = await normaliseOne(stepRecord({ contentType: JSON_TYPE, text: renamed }), scenario);
    expect(compareNormalised(run([golden]), run([replay]), { rules, scenario })).toStrictEqual([
      {
        step: 'findone',
        path: 'envelope.data.items[0].title',
        kind: 'changed',
        expected: 'About Us',
        actual: 'About Them',
        classification: 'difference',
      },
    ]);
  });
});

describe('compareNormalised side effects', () => {
  const sequences = (a: string[], b: string[]): StateTransitions[] => [
    { aggregate: ordinal(1), states: a },
    { aggregate: ordinal(2), states: b },
  ];

  it('compares state sequences per aggregate, whatever order the aggregates are listed in', () => {
    const scenario = comparing(['status', 'envelope', 'transitions']);
    const golden = sequences(['DRAFT', 'SUBMITTED', 'APPROVED'], ['DRAFT', 'SUBMITTED']);
    const listedOtherwise = [...golden].reverse();
    const reordered = sequences(['DRAFT', 'APPROVED', 'SUBMITTED'], ['DRAFT', 'SUBMITTED']);
    const compare = (replay: StateTransitions[]): Difference[] =>
      compareNormalised(run([], { transitions: golden }), run([], { transitions: replay }), { rules, scenario });
    expect(compare(listedOtherwise)).toStrictEqual([]);
    expect(compare(reordered)).toStrictEqual([
      {
        step: SIDE_EFFECTS_STEP,
        path: `${SIDE_EFFECTS_STEP}.transitions.${ordinal(1)}`,
        kind: 'order',
        expected: ['DRAFT', 'SUBMITTED', 'APPROVED'],
        actual: ['DRAFT', 'APPROVED', 'SUBMITTED'],
        classification: 'difference',
      },
    ]);
  });

  it('compares stored rows as multisets of canonical encodings', async () => {
    const scenario = comparing(['status', 'rows'], { rows: [{ table: 'tcontent', where: { siteID: 'tenant-a' } }] });
    const about = { ContentID: cfUuid(), Title: 'About Us' };
    const contact = { ContentID: cfUuid(), Title: 'Contact Us' };
    const effects = (rows: Record<string, string>[]): SideEffects => {
      const snapshot: RowSnapshot = {
        unit: ROWS_UNIT,
        owner: 'strategies-content',
        legacyTable: 'tcontent',
        columns: ROW_COLUMNS,
        keyColumns: [],
        keyless: true,
        rows: rows.map((row) => encodeRow(ROW_COLUMNS, row)),
      };
      return { mail: [], rows: { [ROWS_UNIT]: snapshot }, tasks: [], files: [] };
    };
    const side = async (rows: Record<string, string>[]): Promise<NormalisedRun> => {
      const ctx = { state: createNormaliseState(), rules, scenario };
      return run([], await normaliseSideEffects(effects(rows), ctx));
    };
    const golden = await side([about, about, contact]);
    expect(Object.keys(golden.sideEffects)).toStrictEqual(['rows']);
    const duplicated = golden.sideEffects.rows?.[ROWS_UNIT]?.entries.find((entry) => entry.count === 2)?.encoding;
    expect(duplicated).toContain('About Us');
    const compare = async (rows: Record<string, string>[]): Promise<Difference[]> =>
      compareNormalised(golden, await side(rows), { rules, scenario });
    expect(await compare([contact, about, about])).toStrictEqual([]);
    expect(await compare([contact, about])).toStrictEqual([
      {
        step: SIDE_EFFECTS_STEP,
        path: `${SIDE_EFFECTS_STEP}.rows.${ROWS_UNIT}`,
        kind: 'missing',
        expected: duplicated,
        actual: undefined,
        classification: 'difference',
      },
    ]);
  });

  it('normalises and compares only the side-effect kinds the scenario compares', async () => {
    const scenario = comparing(['status', 'mail', 'tasks', 'files'], {
      tasks: { source: 'scheduled-tasks', prefix: 'opt2-survey-' },
    });
    const effects = (fileId: string, smallSha: string): SideEffects => ({
      mail: [
        {
          to: ['member@example.test'],
          from: 'admin@example.test',
          subject: 'Login information',
          text: 'Your login information',
          htmlText: 'Your login information',
          headers: {},
        },
      ],
      rows: {},
      tasks: [
        {
          name: 'opt2-survey-1-launch',
          kind: 'launch',
          target: '/internal/v1/surveys/1/launch',
          scheduledAt: '2026-06-30T09:00:00',
          base: '2026-06-30T09:00:00',
        },
      ],
      files: [
        { fileId, name: '_small', contentType: 'image/png', sha256: smallSha, size: 10 },
        { fileId, name: 'original', contentType: 'image/png', sha256: 'a'.repeat(64), size: 40 },
      ],
    });
    const side = async (fileId: string, smallSha: string): Promise<NormalisedRun> =>
      run([], await normaliseSideEffects(effects(fileId, smallSha), { state: createNormaliseState(), rules, scenario }));
    const golden = await side(cfUuid(), 'b'.repeat(64));
    expect(Object.keys(golden.sideEffects).sort()).toStrictEqual(['files', 'mail', 'tasks']);
    expect(golden.sideEffects.files?.map((file) => [file.variant, file.name])).toStrictEqual([
      ['original', ordinal(1)],
      ['_small', ordinal(1)],
    ]);
    expect(compareNormalised(golden, await side(cfUuid(), 'b'.repeat(64)), { rules, scenario })).toStrictEqual([]);
    expect(verdicts(compareNormalised(golden, await side(cfUuid(), 'c'.repeat(64)), { rules, scenario }))).toStrictEqual({
      [`${SIDE_EFFECTS_STEP}.files[1].sha256`]: 'difference',
    });
  });

  it('rejects a files.compare field it cannot produce', async () => {
    const scenario = comparing(['status', 'files']);
    const misnamed = { ...rules, files: { ...rules.files, compare: ['variant', 'checksum'] } };
    const effects: SideEffects = {
      mail: [],
      rows: {},
      tasks: [],
      files: [{ fileId: cfUuid(), name: 'original', contentType: 'image/png', sha256: 'a'.repeat(64), size: 1 }],
    };
    await expect(
      normaliseSideEffects(effects, { state: createNormaliseState(), rules: misnamed, scenario }),
    ).rejects.toThrow(RangeError);
  });
});

describe('compareNormalised known-issue masks', () => {
  const editUser = (text: string, scenario: Scenario): Promise<NormalisedStep> =>
    normaliseOne(stepRecord({ name: 'form', routeKey: EDIT_USER_ROUTE, contentType: HTML_TYPE, text }), scenario);
  const datepicker = (control: DomControl): boolean => control.type === 'text' && control.name === undefined;
  const named =
    (name: string, value?: string) =>
    (control: DomControl): boolean =>
      control.name === name && (value === undefined || control.value === value);

  it('classifies the datepicker difference as date-mask and keeps a sibling control a difference', async () => {
    const roster = scenarioById(catalogue, 'GS-PE-01');
    const date = 'value="10/302/2026" maxlength="12" id="mura-datepicker-startDate"';
    const firstName = 'id="fname" name="fname" type="text" value="Fixture"';
    const replayHtml = replaced(
      replaced(EDIT_USER_HTML, date, date.replace('10/302/2026', '2026-06-30')),
      firstName,
      firstName.replace('"Fixture"', '"Replayed"'),
    );
    const golden = await editUser(EDIT_USER_HTML, roster);
    const replay = await editUser(replayHtml, roster);
    expect(verdicts(compareNormalised(run([golden]), run([replay]), { rules, scenario: roster }))).toStrictEqual({
      [controlPath(golden, datepicker, 'value')]: 'known-issue:date-mask',
      [controlPath(golden, named('fname'), 'value')]: 'difference',
    });
  });

  // date-mask is declared for every scenario and route, so scenario scoping is shown with default-member, the
  // edit-user page mask declared for listed scenarios only.
  it.each<[string, string, () => Scenario]>([
    ['GS-PE-01', 'known-issue:default-member', () => scenarioById(catalogue, 'GS-PE-01')],
    ['GS-CO-05', 'difference', () => comparing(['status', 'dom'])],
  ])('classifies a User Type change under %s as %s', async (_id, verdict, scenarioOf) => {
    const scenario = scenarioOf();
    const replayHtml = replaced(
      replaced(EDIT_USER_HTML, 'value="1" Checked> Site Member', 'value="1"> Site Member'),
      'value="0"> System User',
      'value="0" checked> System User',
    );
    const golden = await editUser(EDIT_USER_HTML, scenario);
    const replay = await editUser(replayHtml, scenario);
    expect(verdicts(compareNormalised(run([golden]), run([replay]), { rules, scenario }))).toStrictEqual({
      [controlPath(golden, named('isPublic', '1'), 'checked')]: verdict,
      [controlPath(golden, named('isPublic', '0'), 'checked')]: verdict,
    });
  });
});

describe('NormaliseState', () => {
  it('carries id ordinals across scenarios that share it, and a fresh state restores them', async () => {
    const other = scenarioById(catalogue, 'GS-ID-01');
    const replayed = stepRecord({ contentType: JSON_TYPE, text: gatewayCopy(SUCCESS) });
    const shared = createNormaliseState();
    const first = await normaliseOne(stepRecord({ contentType: JSON_TYPE, text: SUCCESS }), contentRead, shared);
    const continued = await normaliseOne(replayed, other, shared);
    const fresh = await normaliseOne(replayed, other);
    expect(continued.envelope).not.toStrictEqual(first.envelope);
    expect(JSON.stringify(continued.envelope)).toContain(ordinal(new Set(SUCCESS.match(CF_UUID)).size + 1));
    expect(fresh.envelope).toStrictEqual(first.envelope);
  });
});
