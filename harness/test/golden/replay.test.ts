// Parity replay through a fake gateway and migration service: outputs, candidate order, halts, cut-over status,
// replay-only faults, the rehearsal gate and sessions carried across a cut-over transition.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { decodeRow } from '@opt2/platform/migration-kit';
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
import { loadSecretStore, type SecretStore, type SeedStore } from '../../src/golden/session.js';
import type { SideEffectConfig, TableOwnership } from '../../src/golden/side-effects.js';
import { GAP_REASON } from '../../src/golden/steps.js';
import { UsageError } from '../../src/lib/cli.js';
import { createHarnessInvoker, type HarnessInvoker } from '../../src/lib/invocation.js';
import type { ReadOnlyMssql } from '../../src/lib/mssql.js';
import { repoPath, type EnvLike } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const fixture = (relative: string): string => fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url));
const CATALOGUE_FIXTURE = fixture('golden/catalogue.valid.yaml');
const GOLDEN_SAMPLE = fixture('golden/golden-set.sample.json');
const REPLAY_SAMPLE = fixture('golden/replay-output.sample.json');
const EXCEPTIONS_SAMPLE = fixture('inventory/mini-exceptions-list.json');

const SHA = pinnedSha();
const GATEWAY = 'http://127.0.0.1:8100';
/** The gateway addressed by tenant-a's seeded domain, as a session with `site: tenant-a` reaches it. */
const SITE_GATEWAY = 'http://tenant-a.localhost:8100';
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
  catalogueFixtureCo05 = scenarioById(await loadCatalogue(CATALOGUE_FIXTURE), 'GS-CO-75');
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

/** The GS-CO-75 findone body and headers of the replay sample, its ids raw and its ETag the body's own hash. */
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
    if (url.origin === PEOPLE && url.pathname === '/internal/v2/roster-operations/halted') return json({ operations: [], next: null });
    if (url.origin === MIGRATION && url.pathname.startsWith('/internal/v1/faults/')) {
      const status = request.method === 'PUT' ? (opts.faultSetStatus ?? 204) : 204;
      return new Response(null, { status });
    }
    if (url.origin !== GATEWAY && url.origin !== SITE_GATEWAY) throw new Error(`unexpected request to ${url.href}`);
    if (url.pathname === CUTOVER_STATUS_PATH) {
      return json({ tableVersion: opts.tableVersion === undefined ? 'v0002' : opts.tableVersion, epoch: 7 }, opts.statusCode);
    }
    const answer = opts.gateway?.(request);
    if (answer !== undefined) return answer;
    if (url.pathname.startsWith('/index.cfm/_api/json/v1/')) return contentResponse();
    if (url.pathname.startsWith('/admin/')) return adminResponse(url);
    return new Response('not found', { status: 404 });
  };
  const steps = (): Sent[] =>
    sent.filter((s) => (s.url.origin === GATEWAY || s.url.origin === SITE_GATEWAY) && s.url.pathname !== CUTOVER_STATUS_PATH);
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
  select: (ref) =>
    ref.path === 'masa.sites'
      ? { siteID: 'tenant-a', domain: new URL(SITE_GATEWAY).hostname }
      : { contentid: CONTENT_ID, siteID: 'tenant-a', type: 'Page' },
  businessDate: () => '2026-06-30',
};

const clock = (): Date => new Date(REPLAYED_AT);

/** Path of `id`'s temp golden set, or of its rehearsal crossing's under `rehearsal/` when `crossing`. */
function goldenFile(id: string, crossing = false): string {
  return path.join(setsDir, ...(crossing ? ['rehearsal'] : []), `${id}.json`);
}

function readGolden(id: string, crossing = false): Promise<GoldenSet> {
  return readGoldenSet(id, goldenFile(id, crossing));
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

/** Catalogue documents in capture order; GS-CO-04 is impossible to replay as `halt` describes, GS-ID-09 on `site`. */
function catalogueScenarios(halt: HaltVariant, site?: string): Record<string, unknown>[] {
  const probe =
    halt === 'gap'
      ? contentStep('probe', 'step=probe', {
          candidates: [{ route: contentRoute('candidate=0') }, { route: contentRoute('candidate=1') }],
        })
      : contentStep('probe', 'step=probe', { expected: 'halted', exceptionId: DECLARED_ID });
  return [
    contentScenario('GS-CO-04', [probe]),
    contentScenario('GS-CO-75', [
      contentStep('findone', undefined, { extract: { contentid: { from: 'body', path: 'data.contentid' } } }),
    ]),
    contentScenario('GS-CO-84', [
      contentStep('list', 'step=list'),
      contentStep('probe', 'step=probe', {
        candidates: [0, 1, 2].map((n) => ({ route: contentRoute(`candidate=${n}`) })),
      }),
      contentStep('after', 'step=after'),
    ]),
    contentScenario('GS-BR-71', [contentStep('first', 'step=first'), contentStep('second', 'step=second')], {
      replayFaults: [{ fault: 'projector-delay', ms: 3000 }],
    }),
    {
      id: 'GS-ID-09',
      title: 'Session carried across the cut-over transition',
      service: 'identity',
      role: 'admin',
      sessions: { admin: { login: 'none', via: 'admin', ...(site === undefined ? {} : { site }) } },
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
async function writeCatalogue(halt: HaltVariant = 'gap', site?: string): Promise<void> {
  await writeFile(catalogueFile, JSON.stringify({ sourceSha: SHA, scenarios: catalogueScenarios(halt, site) }));
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
async function writeGolden(id: string, specs: readonly GoldenStepSpec[], crossing = false): Promise<GoldenSet> {
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
  const file = goldenFile(id, crossing);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(set));
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
  it('writes the GS-CO-75 findone normalised exactly as its golden set, under the version the gateway reports', async () => {
    const stack = fakeStack();
    const invoker = await operatorInvoker();
    const tableVersion = await activeTableVersion({ env, fetch: stack.fetch, invoker });
    const deps = await replayDeps(stack, {
      invoker,
      tableVersion: tableVersion ?? 'v0001',
      readGolden: (id) => readGoldenSet(id, GOLDEN_SAMPLE),
    });

    const result = await replayScenario(catalogueFixtureCo05, deps);

    const file = replayOutputPath('GS-CO-75', { OPT2_STATE_DIR: env.OPT2_STATE_DIR });
    expect(file).toBe(path.join(root, 'state', 'golden', 'replay', 'GS-CO-75.json'));
    expect(result).toMatchObject({ status: 'replayed', path: file });
    const output = await readOutput('GS-CO-75');
    expect(output).toMatchObject({
      sourceSha: SHA,
      scenarioId: 'GS-CO-75',
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
    const golden = await writeGolden('GS-CO-84', [
      { name: 'list', url: `${CONTENT_PATH}?step=list` },
      { name: 'probe', url: `${CONTENT_PATH}?candidate=1`, candidateIndex: 1 },
      { name: 'after', url: `${CONTENT_PATH}?step=after` },
    ]);
    const stack = fakeStack();

    const result = await replayScenario(scenarioOf('GS-CO-84'), await replayDeps(stack));

    expect(result.status).toBe('replayed');
    expect(stack.steps().map((s) => `${s.url.pathname}${s.url.search}`)).toEqual(
      golden.steps.map((step) => step.request.url),
    );
    const output = await readOutput('GS-CO-84');
    expect(output.steps.map((step) => [step.name, step.candidateIndex])).toEqual([
      ['list', undefined],
      ['probe', 1],
      ['after', undefined],
    ]);
  });

  it("names a seedRef account's stored hash after its seeded credential, as capture does, writing no credential", async () => {
    const account = 'fixture.person';
    const password = ['FIXTURE', 'ACCOUNT', 'PASSWORD'].join('-');
    const userId = 'FIXTURE-USER-0001';
    const unit = 'identity.credential';
    const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(4).replace('$2b$', '$2a$'));
    await mkdir(path.join(root, 'state', 'secrets'), { recursive: true });
    const credentials = { users: { 'tenant-a': { [account]: password } } };
    await writeFile(path.join(root, 'state', 'secrets', 'seed-credentials.json'), JSON.stringify(credentials));
    const accountSeed: SeedStore = {
      ...seed,
      select: (ref) => (ref.path === 'masa.users' ? { userID: userId, siteID: 'tenant-a', username: account } : seed.select(ref)),
    };
    // Legacy SQL holding the account's tusers row; every unit is legacy-authoritative, so replay reads it there.
    const mssql: ReadOnlyMssql = {
      async readOnlyQuery<T>(sql: string): Promise<T[]> {
        const catalog = [
          { COLUMN_NAME: 'UserID', DATA_TYPE: 'char', NUMERIC_SCALE: null },
          { COLUMN_NAME: 'Password', DATA_TYPE: 'varchar', NUMERIC_SCALE: null },
        ];
        return (sql.startsWith('SELECT COLUMN_NAME') ? catalog : [{ UserID: userId, Password: hash }]) as T[];
      },
      close: () => Promise.resolve(),
    };
    const ownership: TableOwnership = {
      tables: [
        {
          table: 'tusers',
          schema: 'dbo',
          owner: 'identity',
          rowIdentity: 'key',
          split: null,
          targets: [{ unit, owner: 'identity', rowPredicate: null, keyColumns: ['UserID'], ownedColumns: ['Password'] }],
        },
      ],
      units: [{ unit, owner: 'identity' }],
    };
    const stack = fakeStack();
    const fetch: FetchLike = async (input, init) =>
      new URL(input).pathname === CUTOVER_STATUS_PATH
        ? json({ tableVersion: 'v0002', epoch: 7, instances: [], groupAuthority: {} })
        : stack.fetch(input, init);
    await writeGolden('GS-PE-75', [{ name: 'findone', url: CONTENT_PATH }]);
    const scenario = scenarioSchema.parse(
      contentScenario('GS-PE-75', [contentStep('findone')], {
        seedRefs: [
          { as: 'page', source: 'dataset', path: 'masa.content', where: { siteID: 'tenant-a', type: 'Page' } },
          { as: 'person', source: 'dataset', path: 'masa.users', where: { siteID: 'tenant-a' } },
        ],
        compare: ['status', 'rows'],
        rows: [{ table: 'tusers', where: { userid: '${seed.person.userID}' } }],
      }),
    );
    const invoker = await operatorInvoker();
    const deps = await replayDeps(stack, {
      fetch,
      invoker,
      secrets: loadSecretStore(env),
      seed: accountSeed,
      sideEffects: { config: SIDE_EFFECTS, mssql, ownership, invoker },
    });

    expect((await replayScenario(scenario, deps)).status).toBe('replayed');
    const output = await readOutput('GS-PE-75');
    expect(output.error).toBeUndefined();
    const table = output.sideEffects.rows[unit];
    if (table === undefined) throw new Error(`no ${unit} rows replayed`);
    expect(table.entries.map((entry) => decodeRow(table.columns, entry.encoding).Password)).toEqual([
      `$2a$04$<verifies:seed:${account}>`,
    ]);
    expect(await readFile(replayOutputPath('GS-PE-75', env), 'utf8')).not.toContain(password);
  });
});

describe('replayScenario without an injected fetch', () => {
  const siteArrivals: string[] = [];
  let site: Server;

  beforeAll(async () => {
    site = createServer((req, res) => {
      siteArrivals.push(`${req.headers.host ?? ''} ${req.url ?? ''}`);
      const answer = contentResponse();
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      void answer.text().then((body) => res.end(body));
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows a gateway redirect to the tenant-a.localhost site domain over loopback', async () => {
    const siteHost = `tenant-a.localhost:${String((site.address() as AddressInfo).port)}`;
    const stack = fakeStack({
      gateway: (sent) =>
        sent.url.pathname === CONTENT_PATH
          ? new Response(null, { status: 302, headers: { location: `http://${siteHost}${CONTENT_PATH}` } })
          : undefined,
    });
    vi.stubGlobal('fetch', stack.fetch);
    const deps = await replayDeps(stack, { fetch: undefined, readGolden: (id) => readGoldenSet(id, GOLDEN_SAMPLE) });

    const result = await replayScenario(catalogueFixtureCo05, deps);

    expect(result.status).toBe('replayed');
    const output = await readOutput('GS-CO-75');
    expect(output.error).toBeUndefined();
    expect(output.steps.map((step) => step.response.status)).toEqual([200]);
    expect(stack.steps().map((s) => s.url.pathname)).toEqual([CONTENT_PATH]);
    expect(siteArrivals).toEqual([`${siteHost} ${CONTENT_PATH}`]);
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
    await writeGolden('GS-CO-75', [{ name: 'findone', url: CONTENT_PATH }]);
    const seeded = await readExceptions();
    const deps = mainDeps(fakeStack(), await operatorInvoker());
    const argv = ['--only', 'GS-CO-04,GS-CO-75', '--catalogue', catalogueFile];

    const outcome = await main(argv, env, deps);

    const halted = [{ id: 'GS-CO-04', step: 'probe', exceptionId }];
    expect(outcome).toEqual({ code: 0, summary: summaryOf({ replayed: 2, halted }) });
    const first = await readOutput('GS-CO-04');
    expect(first.halted).toEqual([{ step: 'probe', routeKey: ROUTE_KEY, reason, exceptionId }]);
    expect(first.steps.map((step) => [step.name, step.exceptionId])).toEqual([['probe', exceptionId]]);
    const second = await readOutput('GS-CO-75');
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
    await writeGolden('GS-BR-71', [
      { name: 'first', url: `${CONTENT_PATH}?step=first` },
      { name: 'second', url: `${CONTENT_PATH}?step=second` },
    ]);
  });

  it('arms the projector delay at the migration service before the first step and clears it after the last', async () => {
    const stack = fakeStack();
    const callees: string[] = [];

    const result = await replayScenario(
      scenarioOf('GS-BR-71'),
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

    const result = await replayScenario(scenarioOf('GS-BR-71'), await replayDeps(stack));

    expect(result.status).toBe('error');
    expect((await readOutput('GS-BR-71')).error).toMatchObject({ step: 'first' });
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
    await writeGolden('GS-CO-75', [{ name: 'findone', url: CONTENT_PATH }]);
    await writeGolden('GS-PE-RH-01', [{ name: 'rehearsal', url: `${CONTENT_PATH}?scenario=rehearsal` }]);
    for (const crossing of [false, true]) {
      await writeGolden(
        'GS-ID-09',
        [
          { name: 'opened', url: '/admin/?muraAction=cDashboard.main' },
          { name: 'after', url: '/admin/?muraAction=cUsers.list' },
        ],
        crossing,
      );
    }
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
    const argv = ['--rehearsal', '--only', 'GS-CO-75', '--catalogue', catalogueFile];

    const run = main(argv, env, mainDeps(stack, await operatorInvoker()));

    await expect(run).rejects.toBeInstanceOf(UsageError);
    await expect(run).rejects.toThrow('GS-CO-75 (v0002) do not replay under v0003');
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

  it.each([
    { site: undefined, origin: GATEWAY },
    { site: 'tenant-a', origin: SITE_GATEWAY },
  ])('saves the jars of an acrossTransition scenario and resumes them on $origin after its transition', async ({ site, origin }) => {
    await writeCatalogue('gap', site);
    const invoker = await operatorInvoker();
    const argv = (phase: string): string[] => ['--phase', phase, '--only', 'GS-ID-09', '--catalogue', catalogueFile];
    const before = fakeStack({ tableVersion: 'v0001' });

    const paused = await main(argv('pre-transition'), env, mainDeps(before, invoker));

    expect(paused).toEqual({ code: 0, summary: summaryOf({ paused: 1, tableVersion: 'v0001' }) });
    expect(before.steps().map((s) => `${s.url.origin}${s.url.search}`)).toEqual([`${origin}?muraAction=cDashboard.main`]);
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
    expect(resumedSteps.map((s) => `${s.url.origin}${s.url.search}`)).toEqual([`${origin}?muraAction=cUsers.list`]);
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
      label: 'resumes the session saved under v0002 with --rehearsal --only in both phases',
      flags: ['--rehearsal'],
      code: 0,
      summary: { replayed: 1 },
      steps: [['?muraAction=cUsers.list', SESSION_COOKIE]],
      completed: true,
    },
  ])('GS-ID-09 after the v0003 activation: $label', async ({ flags, code, summary, steps, completed }) => {
    const invoker = await operatorInvoker();
    const only = ['--only', 'GS-ID-09', '--catalogue', catalogueFile];
    const paused = await main([...flags, '--phase', 'pre-transition', ...only], env, mainDeps(fakeStack(), invoker));
    expect(paused).toEqual({ code: 0, summary: summaryOf({ paused: 1 }) });
    const after = fakeStack({ tableVersion: 'v0003' });

    const resumed = await main([...flags, '--phase', 'resume', ...only], env, mainDeps(after, invoker));

    expect(resumed).toEqual({ code, summary: summaryOf({ ...summary, tableVersion: 'v0003' }) });
    expect(after.steps().map((s) => [s.url.search, s.headers.get('cookie')])).toEqual(steps);
    expect((await readSessionState('GS-ID-09', env, flags.length > 0))?.completed).toBe(completed);
  });

  /** Runs GS-ID-09 in `phase` with `flags` while the gateway serves `tableVersion`. */
  async function crossGsId09(flags: string[], phase: string, tableVersion: string): ReturnType<typeof main> {
    const argv = [...flags, '--phase', phase, '--only', 'GS-ID-09', '--catalogue', catalogueFile];
    return main(argv, env, mainDeps(fakeStack({ tableVersion }), await operatorInvoker()));
  }

  it('keeps the rehearsal crossing of the v0003 activation apart, so the v0002 replay and its sessions stand', async () => {
    await crossGsId09([], 'pre-transition', 'v0001');
    await crossGsId09([], 'resume', 'v0002');
    const parity = await readFile(replayOutputPath('GS-ID-09', env), 'utf8');
    const sessions = await readFile(sessionStatePath('GS-ID-09', env), 'utf8');

    const paused = await crossGsId09(['--rehearsal'], 'pre-transition', 'v0002');
    const resumed = await crossGsId09(['--rehearsal'], 'resume', 'v0003');

    expect([paused, resumed]).toEqual([
      { code: 0, summary: summaryOf({ paused: 1 }) },
      { code: 0, summary: summaryOf({ replayed: 1, tableVersion: 'v0003' }) },
    ]);
    expect(await readFile(replayOutputPath('GS-ID-09', env), 'utf8')).toBe(parity);
    expect(await readFile(sessionStatePath('GS-ID-09', env), 'utf8')).toBe(sessions);
    const crossingFile = replayOutputPath('GS-ID-09', env, true);
    expect(crossingFile).toBe(path.join(root, 'state', 'golden', 'replay', 'rehearsal', 'GS-ID-09.json'));
    const crossing = replayOutputSchema.parse(JSON.parse(await readFile(crossingFile, 'utf8')));
    expect([(await readOutput('GS-ID-09')).tableVersion, crossing.tableVersion]).toEqual(['v0002', 'v0003']);
    expect(crossing.steps.map((step) => [step.name, step.normalised.status])).toEqual([
      ['opened', 200],
      ['after', 200],
    ]);
    const crossingSessions = sessionStatePath('GS-ID-09', env, true);
    expect(crossingSessions).toBe(path.join(root, 'state', 'golden', 'sessions', 'rehearsal', 'GS-ID-09.json'));
    expect((await stat(crossingSessions)).mode & 0o777).toBe(0o600);
    expect(await readSessionState('GS-ID-09', env, true)).toMatchObject({ tableVersion: 'v0002', completed: true });
  });

  it('replays the rehearsal crossing against its rehearsal set and the v0002 crossing against the ordinary set', async () => {
    await writeGolden(
      'GS-ID-09',
      [
        { name: 'opened', url: '/admin/?muraAction=cDashboard.main' },
        { name: 'after', url: '/admin/?muraAction=cUsers.list', gap: true },
      ],
      true,
    );
    const reads = vi.fn(readGolden);
    const invoker = await operatorInvoker();
    const run = (flags: string[], phase: string, tableVersion: string): ReturnType<typeof main> => {
      const argv = [...flags, '--phase', phase, '--only', 'GS-ID-09', '--catalogue', catalogueFile];
      return main(argv, env, { ...mainDeps(fakeStack({ tableVersion }), invoker), readGolden: reads });
    };

    const outcomes = [
      await run([], 'pre-transition', 'v0001'),
      await run([], 'resume', 'v0002'),
      await run(['--rehearsal'], 'pre-transition', 'v0002'),
      await run(['--rehearsal'], 'resume', 'v0003'),
    ];

    const exceptionId = 'EX-HALT-GS-ID-09-01';
    const halted = [{ id: 'GS-ID-09', step: 'after', exceptionId }];
    expect(outcomes).toEqual([
      { code: 0, summary: summaryOf({ paused: 1, tableVersion: 'v0001' }) },
      { code: 0, summary: summaryOf({ replayed: 1 }) },
      { code: 0, summary: summaryOf({ paused: 1 }) },
      { code: 0, summary: summaryOf({ replayed: 1, halted, tableVersion: 'v0003' }) },
    ]);
    expect(reads.mock.calls).toEqual([
      ['GS-ID-09', false],
      ['GS-ID-09', false],
      ['GS-ID-09', true],
      ['GS-ID-09', true],
    ]);
    expect((await readOutput('GS-ID-09')).halted).toEqual([]);
    const crossing = replayOutputSchema.parse(JSON.parse(await readFile(replayOutputPath('GS-ID-09', env, true), 'utf8')));
    expect(crossing.halted).toEqual([{ step: 'after', routeKey: ROUTE_KEY, reason: GAP_REASON, exceptionId }]);
    expect((await readExceptions()).entries.find((entry) => entry.id === exceptionId)?.evidence).toEqual({
      golden: 'harness/golden/sets/rehearsal/GS-ID-09.json',
      replay: '${OPT2_STATE_DIR}/golden/replay/rehearsal/GS-ID-09.json',
    });
  });

  it('fails a rehearsal resume with no crossing sessions saved, writing only the crossing output', async () => {
    await crossGsId09([], 'pre-transition', 'v0001');
    await crossGsId09([], 'resume', 'v0002');
    const parity = await readFile(replayOutputPath('GS-ID-09', env), 'utf8');

    const resumed = await crossGsId09(['--rehearsal'], 'resume', 'v0003');

    const hint = 'run --phase pre-transition --rehearsal before the transition';
    expect(resumed).toMatchObject({ code: 1, summary: { errors: [{ id: 'GS-ID-09', error: expect.stringContaining(hint) }] } });
    expect(await readFile(replayOutputPath('GS-ID-09', env), 'utf8')).toBe(parity);
    const crossing = replayOutputSchema.parse(JSON.parse(await readFile(replayOutputPath('GS-ID-09', env, true), 'utf8')));
    expect(crossing).toMatchObject({ tableVersion: 'v0003', steps: [], error: { message: expect.stringContaining(hint) } });
  });

  it('replays an acrossTransition scenario before the others without --phase, in capture order', async () => {
    await crossGsId09([], 'pre-transition', 'v0001');
    const stack = fakeStack();
    const argv = ['--only', 'GS-CO-75,GS-ID-09', '--catalogue', catalogueFile];

    const outcome = await main(argv, env, mainDeps(stack, await operatorInvoker()));

    expect(outcome).toEqual({ code: 0, summary: summaryOf({ replayed: 2 }) });
    expect(stack.steps().map((s) => `${s.url.pathname}${s.url.search}`)).toEqual([
      '/admin/?muraAction=cUsers.list',
      CONTENT_PATH,
    ]);
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

