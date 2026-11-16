// Parity replay through a fake gateway and migration service: outputs, candidate order, halts, cut-over status,
// replay-only faults, the rehearsal gate and sessions carried across a cut-over transition.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import {
  EXCEPTIONS_LIST_PATH,
  GOLDEN_SETS_DIR,
  readGoldenSet,
  type FetchLike,
  type GoldenSet,
  type GoldenStep,
} from '../../src/golden/capture.js';
import { loadCatalogue, scenarioById, scenarioSchema, type Scenario } from '../../src/golden/catalogue.js';
import type { ExceptionEntry } from '../../src/golden/errors.js';
import { RULES_PATH, loadRules, type NormaliseRules } from '../../src/golden/normalise/index.js';
import {
  CUTOVER_STATUS_PATH,
  DEFAULT_MIGRATION_URL,
  activeTableVersion,
  main,
  readSessionState,
  replayOutputPath,
  replayOutputSchema,
  replayScenario,
  sessionStatePath,
  withFaults,
  type MainDeps,
  type ReplayDeps,
  type ReplayOutput,
} from '../../src/golden/replay.js';
import type { SecretStore, SeedStore } from '../../src/golden/session.js';
import type { SideEffectConfig } from '../../src/golden/side-effects.js';
import { GAP_REASON } from '../../src/golden/steps.js';
import { UsageError } from '../../src/lib/cli.js';
import { createHarnessInvoker, type HarnessInvoker } from '../../src/lib/invocation.js';
import { repoPath, type EnvLike } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const fixture = (relative: string): string => fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url));
const CATALOGUE_FIXTURE = fixture('golden/catalogue.valid.yaml');
const GOLDEN_SAMPLE = fixture('golden/golden-set.sample.json');
const REPLAY_SAMPLE = fixture('golden/replay-output.sample.json');
const EXCEPTIONS_SAMPLE = fixture('inventory/mini-exceptions-list.json');

const SHA = pinnedSha();
const GATEWAY = 'http://127.0.0.1:8100';
const MIGRATION = DEFAULT_MIGRATION_URL;
const PEOPLE = 'http://127.0.0.1:8112';
const MAILPIT = 'http://127.0.0.1:8025';
const SIDE_EFFECTS: SideEffectConfig = { serviceUrls: { people: PEOPLE }, mailpitUrl: MAILPIT };
const OPERATOR_CREDENTIAL = 'Bearer FIXTURE-OPERATOR-TOKEN';
const CONTENT_ID = 'B1B1B1B1-1111-1111-1111111111111111';
const HISTORY_ID = 'B2B2B2B2-2222-2222-2222222222222222';
const CONTENT_PATH = `/index.cfm/_api/json/v1/tenant-a/content/${CONTENT_ID}`;
const ROUTE_KEY = 'api:content.findone';
const SESSION_COOKIE = 'CFID=FIXTURE-CFID-0001';
const REPLAYED_AT = '2026-06-30T13:00:00.000Z';

const goldenSample = JSON.parse(readFileSync(GOLDEN_SAMPLE, 'utf8')) as GoldenSet;
const replaySample = JSON.parse(readFileSync(REPLAY_SAMPLE, 'utf8')) as ReplayOutput;
const sampleStep = goldenSample.steps[0] as GoldenStep;

/** sha256 of every committed golden set and of the committed exceptions list, keyed by path. */
async function committedOutputs(): Promise<Record<string, string>> {
  const setsDir = repoPath(GOLDEN_SETS_DIR);
  const files = (await readdir(setsDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  const digests: Record<string, string> = {};
  for (const file of [...files, EXCEPTIONS_LIST_PATH].sort()) {
    digests[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return digests;
}

let committed: Record<string, string>;
let rules: NormaliseRules;
let catalogueFixtureCo05: Scenario;

beforeAll(async () => {
  committed = await committedOutputs();
  rules = loadRules(RULES_PATH, { PORT: '8500' });
  catalogueFixtureCo05 = scenarioById(await loadCatalogue(CATALOGUE_FIXTURE), 'GS-CO-05');
});

afterAll(async () => {
  expect(await committedOutputs()).toEqual(committed);
});

let root: string;
let env: EnvLike;
let setsDir: string;
let exceptionsFile: string;
let catalogueFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'golden-replay-'));
  env = { OPT2_STATE_DIR: path.join(root, 'state'), PORT: '8500' };
  setsDir = path.join(root, 'sets');
  await mkdir(setsDir, { recursive: true });
  exceptionsFile = path.join(root, 'exceptions-list.json');
  await writeFile(exceptionsFile, await readFile(EXCEPTIONS_SAMPLE, 'utf8'));
  catalogueFile = path.join(root, 'catalogue.yaml');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One request the fake stack received. */
interface Sent {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

interface StackOptions {
  /** Version `cutoverStatus` reports active. */
  tableVersion?: string | null;
  /** Status `cutoverStatus` answers with. */
  statusCode?: number;
  /** Status the migration service answers `faultSet` with. */
  faultSetStatus?: number;
  /** Gateway answer for a scenario request; `undefined` falls through to the defaults. */
  gateway?: (sent: Sent) => Response | undefined;
}

interface FakeStack {
  fetch: FetchLike;
  sent: Sent[];
  /** Gateway requests other than `cutoverStatus`, in arrival order. */
  steps(): Sent[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The GS-CO-05 findone body and headers of the replay sample, its ids raw and its ETag the body's own hash. */
function contentResponse(): Response {
  const body = JSON.stringify(replaySample.steps[0]?.response.body)
    .replaceAll('<id:1>', HISTORY_ID)
    .replaceAll('<id:2>', CONTENT_ID);
  const headers = { ...(replaySample.steps[0]?.response.headers as Record<string, string>) };
  headers.etag = createHash('sha256').update(body, 'utf8').digest('hex').toUpperCase();
  headers['x-request-id'] = 'FIXTURE-REQUEST-0001';
  headers.traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  return new Response(body, { status: 200, headers });
}

/** Admin page; the dashboard opens the session the transition scenario carries across. */
function adminResponse(url: URL): Response {
  const headers: [string, string][] = [['content-type', 'text/html; charset=utf-8']];
  if (url.searchParams.get('muraAction') === 'cDashboard.main') headers.push(['set-cookie', `${SESSION_COOKIE}; Path=/`]);
  return new Response('<html><head><title>Masa CMS</title></head><body><h1>Admin</h1></body></html>', { headers });
}

/** Fake gateway, migration service, people and Mailpit on their loopback ports, recording every request. */
function fakeStack(opts: StackOptions = {}): FakeStack {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const request: Sent = {
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    sent.push(request);
    if (url.origin === MAILPIT) return json({ total: 0, messages: [] });
    if (url.origin === PEOPLE && url.pathname === '/internal/v1/roster-operations/halted') return json({ operations: [] });
    if (url.origin === MIGRATION && url.pathname.startsWith('/internal/v1/faults/')) {
      const status = request.method === 'PUT' ? (opts.faultSetStatus ?? 204) : 204;
      return new Response(null, { status });
    }
    if (url.origin !== GATEWAY) throw new Error(`unexpected request to ${url.href}`);
    if (url.pathname === CUTOVER_STATUS_PATH) {
      return json({ tableVersion: opts.tableVersion === undefined ? 'v0002' : opts.tableVersion, epoch: 7 }, opts.statusCode);
    }
    const answer = opts.gateway?.(request);
    if (answer !== undefined) return answer;
    if (url.pathname.startsWith('/index.cfm/_api/json/v1/')) return contentResponse();
    if (url.pathname.startsWith('/admin/')) return adminResponse(url);
    return new Response('not found', { status: 404 });
  };
  const steps = (): Sent[] => sent.filter((s) => s.url.origin === GATEWAY && s.url.pathname !== CUTOVER_STATUS_PATH);
  return { fetch, sent, steps };
}

/** Operator invoker whose minter returns the fixture credential and records each callee. */
async function operatorInvoker(callees: string[] = []): Promise<HarnessInvoker> {
  return createHarnessInvoker({
    caller: 'operator',
    env,
    minterFactory: () => ({
      async headersFor({ name }) {
        callees.push(name);
        return { [INVOCATION_HEADER]: OPERATOR_CREDENTIAL };
      },
    }),
  });
}

const secrets: SecretStore = {
  secret: (name) => {
    throw new Error(`no scenario here resolves \${secret:${name}}`);
  },
  username: (site, role) => {
    throw new Error(`no scenario here resolves \${user:${site}:${role}}`);
  },
  values: () => [],
};

const seed: SeedStore = {
  select: () => ({ contentid: CONTENT_ID, siteID: 'tenant-a', type: 'Page' }),
  businessDate: () => '2026-06-30',
};

const clock = (): Date => new Date(REPLAYED_AT);

function readGolden(id: string): Promise<GoldenSet> {
  return readGoldenSet(id, path.join(setsDir, `${id}.json`));
}

function mainDeps(stack: FakeStack, invoker: HarnessInvoker): MainDeps {
  return {
    fetch: stack.fetch,
    invoker,
    secrets,
    seed,
    sideEffects: { config: SIDE_EFFECTS },
    clock,
    exceptions: { path: exceptionsFile },
    readGolden,
  };
}

async function replayDeps(stack: FakeStack, over: Partial<ReplayDeps> = {}): Promise<ReplayDeps> {
  return {
    ...mainDeps(stack, await operatorInvoker()),
    env,
    rules,
    fixtures: { available: true, reason: null },
    sourceSha: SHA,
    tableVersion: 'v0002',
    ...over,
  };
}


/** How GS-CO-04's `probe` step is impossible to replay equivalently. */
type HaltVariant = 'gap' | 'declared';

const DECLARED_ID = 'EX-GS-CO-04-DECLARED';

function contentRoute(query?: string): string {
  const route = '/index.cfm/_api/json/v1/tenant-a/content/${seed.page.contentid}';
  return query === undefined ? route : `${route}?${query}`;
}

function contentStep(name: string, query?: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, method: 'GET', route: contentRoute(query), as: 'anon', auth: 'anonymous', csrf: 'none', ...over };
}

function contentScenario(id: string, steps: Record<string, unknown>[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `${id} replay fixture`,
    service: 'strategies-content',
    role: 'anonymous',
    sessions: { anon: { login: 'none', via: 'public' } },
    seedRefs: [{ as: 'page', source: 'dataset', path: 'masa.content', where: { siteID: 'tenant-a', type: 'Page' }, index: 0 }],
    steps,
    compare: ['status', 'envelope', 'headers'],
    normalisationOverrides: [],
    covers: [ROUTE_KEY],
    ...over,
  };
}

/** Catalogue documents in capture order; GS-CO-04 is impossible to replay as `halt` describes. */
function catalogueScenarios(halt: HaltVariant): Record<string, unknown>[] {
  const probe =
    halt === 'gap'
      ? contentStep('probe', 'step=probe', {
          candidates: [{ route: contentRoute('candidate=0') }, { route: contentRoute('candidate=1') }],
        })
      : contentStep('probe', 'step=probe', { expected: 'halted', exceptionId: DECLARED_ID });
  return [
    contentScenario('GS-CO-04', [probe]),
    contentScenario('GS-CO-05', [
      contentStep('findone', undefined, { extract: { contentid: { from: 'body', path: 'data.contentid' } } }),
    ]),
    contentScenario('GS-CO-14', [
      contentStep('list', 'step=list'),
      contentStep('probe', 'step=probe', {
        candidates: [0, 1, 2].map((n) => ({ route: contentRoute(`candidate=${n}`) })),
      }),
      contentStep('after', 'step=after'),
    ]),
    contentScenario('GS-BR-01', [contentStep('first', 'step=first'), contentStep('second', 'step=second')], {
      replayFaults: [{ fault: 'projector-delay', ms: 3000 }],
    }),
    {
      id: 'GS-ID-09',
      title: 'Session carried across the cut-over transition',
      service: 'identity',
      role: 'admin',
      sessions: { admin: { login: 'none', via: 'admin' } },
      seedRefs: [],
      steps: [
        { name: 'opened', method: 'GET', route: '/admin/?muraAction=cDashboard.main', as: 'admin' },
        { name: 'after', method: 'GET', route: '/admin/?muraAction=cUsers.list', as: 'admin' },
      ],
      compare: ['status'],
      normalisationOverrides: [],
      covers: ['admin:cdashboard.main', 'admin:cusers.list'],
      acrossTransition: [{ before: 'after', from: 'v0001', to: 'v0002' }],
    },
    contentScenario('GS-PE-RH-01', [contentStep('rehearsal', 'scenario=rehearsal')], {
      service: 'people',
      tableVersion: 'v0003',
    }),
  ];
}

/** Writes the catalogue as JSON, which the YAML loader reads unchanged. */
async function writeCatalogue(halt: HaltVariant = 'gap'): Promise<void> {
  await writeFile(catalogueFile, JSON.stringify({ sourceSha: SHA, scenarios: catalogueScenarios(halt) }));
}

function scenarioOf(id: string, halt: HaltVariant = 'gap'): Scenario {
  return scenarioSchema.parse(catalogueScenarios(halt).find((doc) => doc.id === id));
}

interface GoldenStepSpec {
  name: string;
  /** Origin-relative URL capture sent. */
  url: string;
  candidateIndex?: number;
  /** Captured without a deterministic legacy trigger. */
  gap?: boolean;
}

/** Temp golden set of `id`, each step a copy of the sample's findone renamed and re-addressed. */
async function writeGolden(id: string, specs: readonly GoldenStepSpec[]): Promise<GoldenSet> {
  const steps = specs.map((spec, index): GoldenStep => {
    const copy = structuredClone(sampleStep);
    const step: GoldenStep = {
      ...copy,
      name: spec.name,
      index,
      request: { ...copy.request, url: spec.url },
      normalised: { ...copy.normalised, name: spec.name, index },
    };
    if (spec.candidateIndex !== undefined) step.candidateIndex = spec.candidateIndex;
    if (spec.gap === true) step.gap = { reason: GAP_REASON, candidatesTried: 2 };
    return step;
  });
  const set: GoldenSet = { ...structuredClone(goldenSample), scenarioId: id, steps };
  await writeFile(path.join(setsDir, `${id}.json`), JSON.stringify(set));
  return set;
}

async function readOutput(id: string): Promise<ReplayOutput> {
  return replayOutputSchema.parse(JSON.parse(await readFile(replayOutputPath(id, env), 'utf8')));
}

async function readExceptions(): Promise<{ text: string; entries: ExceptionEntry[] }> {
  const text = await readFile(exceptionsFile, 'utf8');
  return { text, entries: (JSON.parse(text) as { entries: ExceptionEntry[] }).entries };
}

/** Migration and gateway scenario requests as `<method> <callee> <path and query>`, in arrival order. */
function trace(stack: FakeStack): string[] {
  return stack.sent
    .filter((s) => s.url.origin === MIGRATION || (s.url.origin === GATEWAY && s.url.pathname !== CUTOVER_STATUS_PATH))
    .map((s) => `${s.method} ${s.url.origin === MIGRATION ? 'migration' : 'gateway'} ${s.url.pathname}${s.url.search}`);
}

const summaryOf = (over: Record<string, unknown>): Record<string, unknown> => ({
  replayed: 0,
  skipped: 0,
  paused: 0,
  halted: [],
  errors: [],
  tableVersion: 'v0002',
  ...over,
});

describe('replayScenario', () => {
  it('writes the GS-CO-05 findone normalised exactly as its golden set, under the version the gateway reports', async () => {
    const stack = fakeStack();
    const invoker = await operatorInvoker();
    const tableVersion = await activeTableVersion({ env, fetch: stack.fetch, invoker });
    const deps = await replayDeps(stack, {
      invoker,
      tableVersion: tableVersion ?? 'v0001',
      readGolden: (id) => readGoldenSet(id, GOLDEN_SAMPLE),
    });

    const result = await replayScenario(catalogueFixtureCo05, deps);

    const file = replayOutputPath('GS-CO-05', { OPT2_STATE_DIR: env.OPT2_STATE_DIR });
    expect(file).toBe(path.join(root, 'state', 'golden', 'replay', 'GS-CO-05.json'));
    expect(result).toMatchObject({ status: 'replayed', path: file });
    const output = await readOutput('GS-CO-05');
    expect(output).toMatchObject({
      sourceSha: SHA,
      scenarioId: 'GS-CO-05',
      replayedAt: REPLAYED_AT,
      origin: 'gateway',
      tableVersion: 'v0002',
      halted: [],
    });
    expect(output.error).toBeUndefined();
    expect(output.steps.map((step) => step.normalised)).toEqual(goldenSample.steps.map((step) => step.normalised));
    expect(output.steps.map((step) => step.request.url)).toEqual([CONTENT_PATH]);
    expect(stack.steps().map((s) => s.url.pathname)).toEqual([CONTENT_PATH]);
  });

  it('sends the steps in golden order, a candidate step only with the candidate its golden set kept', async () => {
    const golden = await writeGolden('GS-CO-14', [
      { name: 'list', url: `${CONTENT_PATH}?step=list` },
      { name: 'probe', url: `${CONTENT_PATH}?candidate=1`, candidateIndex: 1 },
      { name: 'after', url: `${CONTENT_PATH}?step=after` },
    ]);
    const stack = fakeStack();

    const result = await replayScenario(scenarioOf('GS-CO-14'), await replayDeps(stack));

    expect(result.status).toBe('replayed');
    expect(stack.steps().map((s) => `${s.url.pathname}${s.url.search}`)).toEqual(
      golden.steps.map((step) => step.request.url),
    );
    const output = await readOutput('GS-CO-14');
    expect(output.steps.map((step) => [step.name, step.candidateIndex])).toEqual([
      ['list', undefined],
      ['probe', 1],
      ['after', undefined],
    ]);
  });
});

describe('halted cases', () => {
  it.each<{ name: string; halt: HaltVariant; exceptionId: string; reason: string }>([
    {
      name: 'a golden step without a deterministic legacy trigger',
      halt: 'gap',
      exceptionId: 'EX-HALT-GS-CO-04-01',
      reason: GAP_REASON,
    },
    {
      name: 'a step declared halted under an exceptions entry',
      halt: 'declared',
      exceptionId: DECLARED_ID,
      reason: `declared halted under ${DECLARED_ID}; served by legacy`,
    },
  ])('records $name once as a halted preserve entry and still replays the next scenario', async ({ halt, exceptionId, reason }) => {
    await writeCatalogue(halt);
    await writeGolden('GS-CO-04', [
      halt === 'gap'
        ? { name: 'probe', url: `${CONTENT_PATH}?candidate=1`, candidateIndex: 1, gap: true }
        : { name: 'probe', url: `${CONTENT_PATH}?step=probe` },
    ]);
    await writeGolden('GS-CO-05', [{ name: 'findone', url: CONTENT_PATH }]);
    const seeded = await readExceptions();
    const deps = mainDeps(fakeStack(), await operatorInvoker());
    const argv = ['--only', 'GS-CO-04,GS-CO-05', '--catalogue', catalogueFile];

    const outcome = await main(argv, env, deps);

    const halted = [{ id: 'GS-CO-04', step: 'probe', exceptionId }];
    expect(outcome).toEqual({ code: 0, summary: summaryOf({ replayed: 2, halted }) });
    const first = await readOutput('GS-CO-04');
    expect(first.halted).toEqual([{ step: 'probe', routeKey: ROUTE_KEY, reason, exceptionId }]);
    expect(first.steps.map((step) => [step.name, step.exceptionId])).toEqual([['probe', exceptionId]]);
    const second = await readOutput('GS-CO-05');
    expect(second.halted).toEqual([]);
    expect(second.error).toBeUndefined();
    expect(second.steps.map((step) => step.name)).toEqual(['findone']);
    const recorded = await readExceptions();
    expect(recorded.entries).toEqual([
      ...seeded.entries,
      {
        id: exceptionId,
        scenario: 'GS-CO-04',
        routeKey: ROUTE_KEY,
        difference: reason,
        decision: 'preserve',
        reason,
        status: 'halted',
        evidence: {
          golden: 'harness/golden/sets/GS-CO-04.json',
          replay: '${OPT2_STATE_DIR}/golden/replay/GS-CO-04.json',
        },
        sourceSha: SHA,
      },
    ]);

    const again = await main(argv, env, deps);

    expect(again).toEqual({ code: 0, summary: summaryOf({ replayed: 2, halted }) });
    expect((await readExceptions()).text).toBe(recorded.text);
  });
});


describe('activeTableVersion', () => {
  it.each(['v0002', null])('reads %s from the gateway cutoverStatus with the operator invocation credential', async (version) => {
    const stack = fakeStack({ tableVersion: version });
    const callees: string[] = [];

    const active = await activeTableVersion({ env, fetch: stack.fetch, invoker: await operatorInvoker(callees) });

    expect(active).toBe(version);
    expect(stack.sent.map((s) => [s.method, s.url.href, s.headers.get(INVOCATION_HEADER)])).toEqual([
      ['GET', `${GATEWAY}${CUTOVER_STATUS_PATH}`, OPERATOR_CREDENTIAL],
    ]);
    expect(callees).toEqual(['gateway']);
  });

  it.each([404, 503])('rejects a cutoverStatus answered %i', async (statusCode) => {
    const stack = fakeStack({ statusCode });

    await expect(activeTableVersion({ env, fetch: stack.fetch, invoker: await operatorInvoker() })).rejects.toThrow(
      `gateway cutoverStatus answered ${statusCode}`,
    );
  });
});

describe('replay-only faults', () => {
  const FAULT = '/internal/v1/faults/projector-delay';
  const PROJECTOR_DELAY = [{ fault: 'projector-delay', ms: 3000 }];

  beforeEach(async () => {
    await writeGolden('GS-BR-01', [
      { name: 'first', url: `${CONTENT_PATH}?step=first` },
      { name: 'second', url: `${CONTENT_PATH}?step=second` },
    ]);
  });

  it('arms the projector delay at the migration service before the first step and clears it after the last', async () => {
    const stack = fakeStack();
    const callees: string[] = [];

    const result = await replayScenario(
      scenarioOf('GS-BR-01'),
      await replayDeps(stack, { invoker: await operatorInvoker(callees) }),
    );

    expect(result.status).toBe('replayed');
    expect(trace(stack)).toEqual([
      `PUT migration ${FAULT}`,
      `GET gateway ${CONTENT_PATH}?step=first`,
      `GET gateway ${CONTENT_PATH}?step=second`,
      `DELETE migration ${FAULT}`,
    ]);
    const faultCalls = stack.sent.filter((s) => s.url.origin === MIGRATION);
    expect(faultCalls.map((s) => s.headers.get(INVOCATION_HEADER))).toEqual([OPERATOR_CREDENTIAL, OPERATOR_CREDENTIAL]);
    expect(JSON.parse(faultCalls[0]?.body ?? 'null')).toEqual({ params: { delayMs: 3000 } });
    expect(callees.filter((callee) => callee === 'migration')).toHaveLength(2);
  });

  it('clears the fault after a step whose request fails and records that step as the error', async () => {
    const stack = fakeStack({
      gateway: (s) => {
        if (s.url.searchParams.get('step') === 'first') throw new TypeError('fetch failed');
        return undefined;
      },
    });

    const result = await replayScenario(scenarioOf('GS-BR-01'), await replayDeps(stack));

    expect(result.status).toBe('error');
    expect((await readOutput('GS-BR-01')).error).toMatchObject({ step: 'first' });
    expect(trace(stack)).toEqual([
      `PUT migration ${FAULT}`,
      `GET gateway ${CONTENT_PATH}?step=first`,
      `DELETE migration ${FAULT}`,
    ]);
  });

  it('disarms the fault when the wrapped run throws, rethrowing the run error', async () => {
    const stack = fakeStack();
    const deps = { env, fetch: stack.fetch, invoker: await operatorInvoker() };

    await expect(
      withFaults(deps, PROJECTOR_DELAY, async () => {
        throw new Error('step exploded');
      }),
    ).rejects.toThrow('step exploded');

    expect(trace(stack)).toEqual([`PUT migration ${FAULT}`, `DELETE migration ${FAULT}`]);
  });

  it('disarms a fault whose arming failed without running the wrapped run', async () => {
    const stack = fakeStack({ faultSetStatus: 500 });
    const deps = { env, fetch: stack.fetch, invoker: await operatorInvoker() };
    let ran = false;

    await expect(
      withFaults(deps, PROJECTOR_DELAY, async () => {
        ran = true;
      }),
    ).rejects.toThrow('migration faultSet projector-delay answered 500');

    expect(ran).toBe(false);
    expect(trace(stack)).toEqual([`PUT migration ${FAULT}`, `DELETE migration ${FAULT}`]);
  });
});


describe('main flags', () => {
  beforeEach(async () => {
    await writeCatalogue();
    await writeGolden('GS-CO-05', [{ name: 'findone', url: CONTENT_PATH }]);
    await writeGolden('GS-PE-RH-01', [{ name: 'rehearsal', url: `${CONTENT_PATH}?scenario=rehearsal` }]);
    await writeGolden('GS-ID-09', [
      { name: 'opened', url: '/admin/?muraAction=cDashboard.main' },
      { name: 'after', url: '/admin/?muraAction=cUsers.list' },
    ]);
  });

  it('refuses --rehearsal while the gateway serves v0002, before any scenario request', async () => {
    const stack = fakeStack({ tableVersion: 'v0002' });

    const outcome = await main(['--rehearsal', '--catalogue', catalogueFile], env, mainDeps(stack, await operatorInvoker()));

    expect(outcome).toEqual({
      code: 1,
      summary: summaryOf({ error: 'the gateway has v0002 active; replay needs v0003' }),
    });
    expect(stack.sent.map((s) => s.url.pathname)).toEqual([CUTOVER_STATUS_PATH]);
    await expect(access(path.join(root, 'state', 'golden'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects --rehearsal naming a scenario that replays under v0002 as a usage error, sending nothing', async () => {
    const stack = fakeStack();
    const argv = ['--rehearsal', '--only', 'GS-CO-05', '--catalogue', catalogueFile];

    const run = main(argv, env, mainDeps(stack, await operatorInvoker()));

    await expect(run).rejects.toBeInstanceOf(UsageError);
    await expect(run).rejects.toThrow('GS-CO-05 (v0002) do not replay under v0003');
    expect(stack.sent).toEqual([]);
  });

  it('replays only the rehearsal scenarios under v0003', async () => {
    const stack = fakeStack({ tableVersion: 'v0003' });

    const outcome = await main(['--rehearsal', '--catalogue', catalogueFile], env, mainDeps(stack, await operatorInvoker()));

    expect(outcome).toEqual({ code: 0, summary: summaryOf({ replayed: 1, tableVersion: 'v0003' }) });
    expect(stack.steps().map((s) => s.url.search)).toEqual(['?scenario=rehearsal']);
    expect(await readdir(path.join(root, 'state', 'golden', 'replay'))).toEqual(['GS-PE-RH-01.json']);
    expect((await readOutput('GS-PE-RH-01')).tableVersion).toBe('v0003');
  });

  it('saves the jars of an acrossTransition scenario before its transition step and resumes them after it', async () => {
    const invoker = await operatorInvoker();
    const argv = (phase: string): string[] => ['--phase', phase, '--only', 'GS-ID-09', '--catalogue', catalogueFile];
    const before = fakeStack({ tableVersion: 'v0001' });

    const paused = await main(argv('pre-transition'), env, mainDeps(before, invoker));

    expect(paused).toEqual({ code: 0, summary: summaryOf({ paused: 1, tableVersion: 'v0001' }) });
    expect(before.steps().map((s) => s.url.search)).toEqual(['?muraAction=cDashboard.main']);
    const file = sessionStatePath('GS-ID-09', env);
    expect(file).toBe(path.join(root, 'state', 'golden', 'sessions', 'GS-ID-09.json'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = await readSessionState('GS-ID-09', env);
    expect(saved).toMatchObject({ sourceSha: SHA, tableVersion: 'v0001', nextIndex: 1, completed: false });
    expect(saved?.jars.admin?.cookies).toEqual([expect.objectContaining({ key: 'CFID', value: 'FIXTURE-CFID-0001' })]);
    await expect(access(replayOutputPath('GS-ID-09', env))).rejects.toMatchObject({ code: 'ENOENT' });

    const after = fakeStack({ tableVersion: 'v0002' });

    const resumed = await main(argv('resume'), env, mainDeps(after, invoker));

    expect(resumed).toEqual({ code: 0, summary: summaryOf({ replayed: 1 }) });
    const resumedSteps = after.steps();
    expect(resumedSteps.map((s) => s.url.search)).toEqual(['?muraAction=cUsers.list']);
    expect(resumedSteps[0]?.headers.get('cookie')).toBe(SESSION_COOKIE);
    const output = await readOutput('GS-ID-09');
    expect(output.steps.map((step) => [step.name, step.normalised.status])).toEqual([
      ['opened', 200],
      ['after', 200],
    ]);
    expect((await readSessionState('GS-ID-09', env))?.completed).toBe(true);
  });

  it.each<{
    label: string;
    flags: string[];
    code: number;
    summary: Record<string, unknown>;
    /** Resumed gateway requests as `[query, cookie]`. */
    steps: (string | null)[][];
    completed: boolean;
  }>([
    {
      label: 'refuses the resume without --rehearsal, which needs v0002',
      flags: [],
      code: 1,
      summary: { error: 'the gateway has v0003 active; replay needs v0002' },
      steps: [],
      completed: false,
    },
    {
      label: 'resumes the session saved under v0002 with --rehearsal --only',
      flags: ['--rehearsal'],
      code: 0,
      summary: { replayed: 1 },
      steps: [['?muraAction=cUsers.list', SESSION_COOKIE]],
      completed: true,
    },
  ])('GS-ID-09 after the v0003 activation: $label', async ({ flags, code, summary, steps, completed }) => {
    const invoker = await operatorInvoker();
    const only = ['--only', 'GS-ID-09', '--catalogue', catalogueFile];
    const paused = await main(['--phase', 'pre-transition', ...only], env, mainDeps(fakeStack(), invoker));
    expect(paused).toEqual({ code: 0, summary: summaryOf({ paused: 1 }) });
    const after = fakeStack({ tableVersion: 'v0003' });

    const resumed = await main([...flags, '--phase', 'resume', ...only], env, mainDeps(after, invoker));

    expect(resumed).toEqual({ code, summary: summaryOf({ ...summary, tableVersion: 'v0003' }) });
    expect(after.steps().map((s) => [s.url.search, s.headers.get('cookie')])).toEqual(steps);
    expect((await readSessionState('GS-ID-09', env))?.completed).toBe(completed);
  });

  it('masks a configured reload key in the admin reload link of the saved sessions and the replay output', async () => {
    const invoker = await operatorInvoker();
    const key = ['FIXTURE', 'reload', 'key'].join('-');
    const keyed = { ...env, MURA_APPRELOADKEY: key };
    const page =
      '<html><head><title>Masa CMS</title></head><body>' +
      `<a href="/admin/?${key}&amp;reload=${key}">Reload</a></body></html>`;
    const gateway = (sent: Sent): Response | undefined =>
      sent.url.pathname.startsWith('/admin/')
        ? new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : undefined;
    const run = (phase: string, tableVersion: string): ReturnType<typeof main> => {
      const argv = ['--phase', phase, '--only', 'GS-ID-09', '--catalogue', catalogueFile];
      return main(argv, keyed, mainDeps(fakeStack({ tableVersion, gateway }), invoker));
    };

    const paused = await run('pre-transition', 'v0001');
    const saved = await readFile(sessionStatePath('GS-ID-09', keyed), 'utf8');
    const resumed = await run('resume', 'v0002');
    const output = await readFile(replayOutputPath('GS-ID-09', keyed), 'utf8');

    expect([paused.code, resumed.code]).toEqual([0, 0]);
    expect(saved).toContain('/admin/?<secret>&amp;reload=<secret>');
    expect(output).toContain('/admin/?<token>&reload=<token>');
    for (const text of [saved, output]) expect(text).not.toContain(key);
  });
});

