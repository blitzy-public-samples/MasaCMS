// Halt attribution of a replayed 503: only an import-pending window on a unit of the route's cut-over entry halts it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldenSet, GoldenStep } from '../../src/golden/capture.js';
import { loadCatalogue, scenarioById, type Scenario } from '../../src/golden/catalogue.js';
import { loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import { replayScenario, routeUnits, type ReplayDeps } from '../../src/golden/replay.js';
import type { SecretStore, SeedStore } from '../../src/golden/session.js';
import type { FetchLike } from '../../src/lib/http.js';
import { pinnedSha } from '../../src/lib/pin.js';

const CATALOGUE_FIXTURE = fileURLToPath(new URL('../fixtures/golden/catalogue.valid.yaml', import.meta.url));
const SHA = pinnedSha();
const GATEWAY = 'http://gateway.test';
const MIGRATION = 'http://migration.test';
const MAILPIT = 'http://mailpit.test';
const VERSION = 'v0002';
/** Route A: the replayed `home` step, answered 503. */
const ROUTE_A = 'admin:home.redirect';
const UNITS_A = ['content.content_tag', 'content.content'];
/** Route B: a route the scenario never sends, whose unit an unrelated window holds. */
const ROUTE_B = 'admin:cusers.list';
const UNIT_B = 'people.person';
const HALT_ID = 'EX-HALT-GS-ID-01-01';
const ADMIN_PASSWORD = ['replay', 'halt', 'fixture'].join('-');
const LOGIN_PAGE =
  '<html><head><title>Login</title></head><body><form name="frmLogin" method="post" action="./index.cfm">' +
  '<input type="hidden" name="csrf_token" value="tok"><input type="hidden" name="csrf_token_expires" value="exp">' +
  '<input type="text" name="username"></form></body></html>';
const PAGE = '<html><head><title>Masa CMS</title></head><body><h1>Dashboard</h1></body></html>';
const UNAVAILABLE_PAGE = '<html><head><title>Service Unavailable</title></head><body>Service Unavailable</body></html>';

/** One gate row of the fake `gatesList`. */
interface GateRow {
  unit: string;
  holderId: string | null;
  phase: string | null;
}

/** How the fake migration service answers `gatesList`. */
interface GatesFake {
  rows: readonly GateRow[];
  /** Answers every row whatever the `units` query asks for. */
  ignoresFilter: boolean;
}

let id01: Scenario;
let rules: NormaliseRules;
let dir: string;
let exceptionsFile: string;

beforeAll(async () => {
  id01 = scenarioById(await loadCatalogue(CATALOGUE_FIXTURE), 'GS-ID-01');
  rules = loadRules(undefined, { PORT: '8500' });
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'replay-halt-'));
  exceptionsFile = path.join(dir, 'exceptions-list.json');
  await writeFile(exceptionsFile, `${JSON.stringify({ sourceSha: SHA, entries: [] }, null, 2)}\n`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes `<dir>/cutover/versions/<VERSION>.json` holding `entries`; returns the cut-over directory. */
async function writeVersion(
  entries: readonly { route: string; units: readonly string[] }[],
  version = VERSION,
): Promise<string> {
  const cutover = path.join(dir, 'cutover');
  await mkdir(path.join(cutover, 'versions'), { recursive: true });
  const table = {
    tableVersion: version,
    entries: entries.map((entry) => ({ ...entry, owningService: 'strategies-content', state: 'target', kind: 'read' })),
  };
  await writeFile(path.join(cutover, 'versions', `${VERSION}.json`), JSON.stringify(table));
  return cutover;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Fake gateway (503 on `/admin/`), migration `gatesList` and Mailpit; `gatesCalls` collects every gates URL. */
function fakeStack(gates: GatesFake): { fetch: FetchLike; gatesCalls: URL[] } {
  const gatesCalls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    if (url.origin === MAILPIT) return json({ total: 0, messages: [] });
    if (url.origin === MIGRATION && url.pathname === '/internal/v1/gates') {
      gatesCalls.push(url);
      // Without `units`, gatesList lists every unit.
      const asked = url.searchParams.get('units')?.split(',');
      const rows = gates.rows.filter((row) => gates.ignoresFilter || asked === undefined || asked.includes(row.unit));
      return json({ units: rows.map(({ unit, holderId, phase }) => ({ unit, gate: { holderId, phase } })) });
    }
    if (url.origin !== GATEWAY) throw new Error(`unexpected request to ${url.href}`);
    const action = url.searchParams.get('muraAction');
    if (action === 'cLogin.main') return html(LOGIN_PAGE);
    if (url.pathname === '/admin/' && action === null) return html(UNAVAILABLE_PAGE, 503);
    return html(PAGE);
  };
  return { fetch, gatesCalls };
}

/** One golden exchange legacy answered 200. */
function exchange(name: string, index: number, routeKey: string): GoldenStep {
  return {
    name,
    index,
    routeKey,
    request: { method: 'GET', url: '/admin/', headers: {}, body: { kind: 'none' } },
    response: { status: 200, headers: {}, body: '', rawSha256: '0'.repeat(64) },
    normalised: { name, index, routeKey, status: 200, maskedPaths: {} },
  };
}

function goldenOf(scenario: Scenario): GoldenSet {
  return {
    sourceSha: SHA,
    scenarioId: scenario.id,
    capturedAt: '2026-01-01T00:00:00.000Z',
    origin: 'legacy',
    tableVersion: null,
    fixtures: { available: true, reason: null },
    steps: scenario.steps.map((step, i) => exchange(step.name, i, scenario.covers[i] ?? 'admin:unknown')),
    sideEffects: { mail: [], rows: {}, tasks: [], files: [] },
  };
}

const secrets: SecretStore = {
  secret: () => ADMIN_PASSWORD,
  username: () => 'admin',
  values: () => [ADMIN_PASSWORD],
};

const seed: SeedStore = {
  select: () => {
    throw new Error('GS-ID-01 declares no seed refs');
  },
  businessDate: () => '2026-01-01',
};

function depsOf(cutoverDir: string, fetch: FetchLike): ReplayDeps {
  return {
    env: {
      OPT2_STATE_DIR: path.join(dir, 'state'),
      OPT2_CUTOVER_DIR: cutoverDir,
      OPT2_GATEWAY_URL: GATEWAY,
      OPT2_MIGRATION_URL: MIGRATION,
    },
    fetch,
    invoker: { headersFor: async () => ({}) },
    rules,
    fixtures: { available: true, reason: null },
    sourceSha: SHA,
    tableVersion: VERSION,
    secrets,
    seed,
    sideEffects: { config: { serviceUrls: {}, mailpitUrl: MAILPIT } },
    clock: () => new Date('2026-01-02T03:04:05.000Z'),
    exceptions: { path: exceptionsFile },
    readGolden: async () => goldenOf(id01),
  };
}

const BOTH_ROUTES = [
  { route: ROUTE_A, units: UNITS_A },
  { route: ROUTE_B, units: [UNIT_B] },
];
const PENDING_B: GateRow = { unit: UNIT_B, holderId: 'win-b', phase: 'import-pending' };
const QUIET_A: GateRow[] = UNITS_A.map((unit) => ({ unit, holderId: null, phase: null }));

describe('replayScenario halt attribution', () => {
  it.each([
    {
      name: 'import-pending only on a unit of another route',
      entries: BOTH_ROUTES,
      gates: { rows: [...QUIET_A, PENDING_B], ignoresFilter: false },
      query: 'content.content,content.content_tag',
    },
    {
      name: 'a gates answer listing units outside the filter',
      entries: BOTH_ROUTES,
      gates: { rows: [...QUIET_A, PENDING_B], ignoresFilter: true },
      query: 'content.content,content.content_tag',
    },
    {
      name: 'a route without a cut-over entry',
      entries: [{ route: ROUTE_B, units: [UNIT_B] }],
      gates: { rows: [PENDING_B], ignoresFilter: true },
      query: undefined,
    },
  ])('keeps the 503 as a step difference for $name', async ({ entries, gates, query }) => {
    const before = await readFile(exceptionsFile, 'utf8');
    const stack = fakeStack(gates);

    const result = await replayScenario(id01, depsOf(await writeVersion(entries), stack.fetch));

    expect(result.status).toBe('replayed');
    if (!('output' in result)) throw new Error('no replay output');
    expect(result.output.halted).toEqual([]);
    expect(result.output.error).toBeUndefined();
    expect(result.output.steps.map((step) => [step.name, step.normalised.status])).toEqual([
      ['main', 200],
      ['login', 200],
      ['home', 503],
      ['logout', 200],
    ]);
    expect(await readFile(exceptionsFile, 'utf8')).toBe(before);
    const asked = stack.gatesCalls.map((url) => url.searchParams.get('units'));
    expect(asked).toEqual(query === undefined ? [] : [query]);
  });

  it.each([
    {
      name: 'a gates answer honouring the filter',
      gates: {
        rows: [
          { unit: 'content.content_tag', holderId: null, phase: null },
          { unit: 'content.content', holderId: 'win-a', phase: 'import-pending' },
          PENDING_B,
        ],
        ignoresFilter: false,
      },
      reason: 'write window win-a is import-pending on content.content',
    },
    {
      name: 'a gates answer listing units outside the filter',
      gates: {
        rows: [
          { unit: 'content.content_tag', holderId: 'win-a', phase: 'import-pending' },
          { unit: 'content.content', holderId: 'win-a', phase: 'import-pending' },
          PENDING_B,
        ],
        ignoresFilter: true,
      },
      reason: 'write window win-a is import-pending on content.content, content.content_tag',
    },
  ])('halts the route when a window holds one of its units import-pending, given $name', async ({ gates, reason }) => {
    const stack = fakeStack(gates);

    const result = await replayScenario(id01, depsOf(await writeVersion(BOTH_ROUTES), stack.fetch));

    expect(result.status).toBe('replayed');
    if (!('output' in result)) throw new Error('no replay output');
    expect(result.output.halted).toEqual([{ step: 'home', routeKey: ROUTE_A, reason, exceptionId: HALT_ID }]);
    expect(result.output.steps.map((step) => [step.name, step.normalised.status, step.exceptionId])).toEqual([
      ['main', 200, undefined],
      ['login', 200, undefined],
      ['home', 503, HALT_ID],
    ]);
    const list = JSON.parse(await readFile(exceptionsFile, 'utf8')) as { entries: Record<string, unknown>[] };
    expect(list.entries).toEqual([
      expect.objectContaining({ id: HALT_ID, scenario: 'GS-ID-01', routeKey: ROUTE_A, status: 'halted', reason }),
    ]);
    const asked = stack.gatesCalls.map((url) => url.searchParams.get('units'));
    expect(asked).toEqual(['content.content,content.content_tag']);
  });
});

describe('routeUnits', () => {
  it.each([
    { routeKey: 'ADMIN:Home.Redirect', units: ['admin.home'] },
    { routeKey: 'static:/admin/assets/css/admin.css', units: ['static.assets'] },
    { routeKey: 'static:/admin/other.css', units: ['static.admin'] },
    { routeKey: 'admin:carch.update{approved=1}', units: [] },
    { routeKey: 'unknown-family', units: [] },
  ])('resolves $routeKey as the gateway matches it', async ({ routeKey, units }) => {
    const cutover = await writeVersion([
      { route: 'admin:home.redirect', units: ['admin.home'] },
      { route: 'admin:carch.update', units: ['content.content'] },
      { route: 'static:/admin/**', units: ['static.admin'] },
      { route: 'static:/admin/assets/**', units: ['static.assets'] },
    ]);

    expect(await routeUnits(routeKey, VERSION, { OPT2_CUTOVER_DIR: cutover })).toEqual(units);
  });

  it('rejects a version file naming another version', async () => {
    const cutover = await writeVersion([{ route: ROUTE_A, units: UNITS_A }], 'v0003');

    await expect(routeUnits(ROUTE_A, VERSION, { OPT2_CUTOVER_DIR: cutover })).rejects.toThrow(
      /tableVersion v0003 is not the active v0002/,
    );
  });
});
