// Halt attribution of a replayed 503: an import-pending window, or a halted roster operation whose user the request
// names, on a unit of the route's cut-over entry halts it; every operation people lists as once halted is recorded once.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldenSet, GoldenStep } from '../../src/golden/capture.js';
import { loadCatalogue, scenarioById, type Scenario } from '../../src/golden/catalogue.js';
import { loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import { replayScenario, routeUnits, type ReplayDeps } from '../../src/golden/replay.js';
import { rosterHaltEntry } from '../../src/golden/roster-halts.js';
import type { SecretStore, SeedStore } from '../../src/golden/session.js';
import type { FetchLike } from '../../src/lib/http.js';
import { pinnedSha } from '../../src/lib/pin.js';

const CATALOGUE_FIXTURE = fileURLToPath(new URL('../fixtures/golden/catalogue.valid.yaml', import.meta.url));
const SHA = pinnedSha();
const GATEWAY = 'http://gateway.test';
const MIGRATION = 'http://migration.test';
const PEOPLE = 'http://people.test';
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

/** One operation of the fake people `listHaltedRosterOperationsPage`. */
type HaltedFake = {
  operationId: string;
  tenantId: string;
  userId: string;
  kind: 'admin-add' | 'admin-update' | 'profile-update';
  state: 'started' | 'people-committed' | 'done' | 'rolled-back' | 'halted';
  startedAt: string;
  updatedAt: string;
  haltedAt: string;
  identityUnreachableSince: string | null;
  units: string[];
};

/**
 * How the fake people service answers `listHaltedRosterOperationsPage`: its halted operations, `pageSize` a page (all on
 * one when absent) with the next offset as cursor, or, when `stalls`, none a page and the cursor it was sent; or a bare status.
 */
type PeopleFake = { operations: readonly HaltedFake[]; pageSize?: number; stalls?: boolean } | { status: number };

const NO_HALTS: PeopleFake = { operations: [] };

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

/** Fake gateway (503 on `/admin/` and `/_api/`), migration `gatesList`, people `listHaltedRosterOperationsPage` and Mailpit, collecting their URLs. */
function fakeStack(
  gates: GatesFake,
  people: PeopleFake = NO_HALTS,
): { fetch: FetchLike; gatesCalls: URL[]; peopleCalls: URL[] } {
  const gatesCalls: URL[] = [];
  const peopleCalls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    if (url.origin === MAILPIT) return json({ total: 0, messages: [] });
    if (url.origin === PEOPLE && url.pathname === '/internal/v2/roster-operations/halted') {
      peopleCalls.push(url);
      if ('status' in people) return json({}, people.status);
      const start = Number(url.searchParams.get('after') ?? 0);
      const end = people.stalls === true ? start : start + (people.pageSize ?? people.operations.length);
      return json({ operations: people.operations.slice(start, end), next: end < people.operations.length ? String(end) : null });
    }
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
    if ((url.pathname === '/admin/' && action === null) || url.pathname.startsWith('/_api/')) return html(UNAVAILABLE_PAGE, 503);
    return html(PAGE);
  };
  return { fetch, gatesCalls, peopleCalls };
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
    sideEffects: { mail: [], rows: {}, files: [] },
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
    sideEffects: { config: { serviceUrls: { people: PEOPLE }, mailpitUrl: MAILPIT } },
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

const OPERATION_1 = '2D8B1C4E-0000-4A11-9F3E2B7C6D5A4E31';
const OPERATION_2 = '2D8B1C4E-0000-4A11-9F3E2B7C6D5A4E32';
const ROSTER_USER = '6A1F0C2E-1111-4B22-8C3D4E5F60718293';
const ROSTER_TENANT = '5b2f6f0e-7c1d-5a2e-9f3b-0c4d5e6f7a8b';
const ROSTER_UNITS = ['people.person', 'people.user_address', 'identity.user_account', 'identity.membership'];
const ADMIN_UPDATE_KEY = 'admin:cusers.update{type=2,action=update}';
/** A user no halted operation keeps closed. */
const OTHER_USER = '7B2E1D3F-2222-4C33-9D4E5F6071829304';
/** Route key of the JSON API user read, answered 503 by the fake gateway. */
const USER_READ_KEY = 'api:user.findone';
const ROSTER_ROUTES = [
  { route: ROUTE_A, units: ['identity.user_account'] },
  { route: USER_READ_KEY, units: ['identity.user_account'] },
];

type HomeStep = Scenario['steps'][number];

/** GS-ID-01 with its `home` step, the one the fake gateway answers 503, changed by `home`. */
function withHome(home: Partial<HomeStep>): Scenario {
  return { ...id01, steps: id01.steps.map((step) => (step.name === 'home' ? { ...step, ...home } : step)) };
}

/** An operation people lists as once halted, in `state`; a resolved one has its unreachability cleared. */
function haltedOperation(operationId: string, kind: HaltedFake['kind'] = 'admin-update', state: HaltedFake['state'] = 'halted'): HaltedFake {
  const resolved = state !== 'halted';
  return {
    operationId,
    tenantId: ROSTER_TENANT,
    userId: ROSTER_USER,
    kind,
    state,
    startedAt: '2026-01-02T02:50:00.000Z',
    updatedAt: resolved ? '2026-01-02T03:00:00.000Z' : '2026-01-02T02:56:01.000Z',
    haltedAt: '2026-01-02T02:56:01.000Z',
    identityUnreachableSince: resolved ? null : '2026-01-02T02:50:31.000Z',
    units: ROSTER_UNITS,
  };
}

/** The entry replay records for operation `operationId`, in `state`, first listed while replaying GS-ID-01. */
function rosterEntry(operationId: string, state: HaltedFake['state'] = 'halted'): Record<string, unknown> {
  const since = state === 'halted' ? ' since 2026-01-02T02:50:31.000Z' : '';
  const resolved = state === 'halted' ? '' : ` An operator had already resolved it to ${state} when replay recorded it.`;
  return {
    id: `EX-ROSTER-HALT-${operationId}`,
    scenario: 'GS-ID-01',
    routeKey: ADMIN_UPDATE_KEY,
    difference:
      `Roster operation ${operationId} (admin-update, started 2026-01-02T02:50:00.000Z) of user ${ROSTER_USER} in tenant ` +
      `${ROSTER_TENANT} halted at 2026-01-02T02:56:01.000Z: recovery could not reach identity${since}. While it is ` +
      `halted the user stays closed on people and identity, so every read or write of it answers the legacy-shaped 503.`,
    decision: 'preserve',
    reason:
      'Identity stayed unreachable for more than 5 minutes, so recovery stopped and an operator resolves the operation ' +
      `with \`opt2-people resolve-operation ${operationId} --to rolled-back|done\`.${resolved}`,
    status: 'halted',
    evidence: { golden: 'harness/golden/sets/GS-ID-01.json', replay: '${OPT2_STATE_DIR}/golden/replay/GS-ID-01.json' },
    sourceSha: SHA,
  };
}

describe('halted roster operations', () => {
  it.each<{ name: string; home: Partial<HomeStep>; routeKey: string }>([
    { name: 'a query value in another case', home: { route: `/admin/?userid=${ROSTER_USER.toLowerCase()}` }, routeKey: ROUTE_A },
    { name: 'a path segment', home: { route: `/_api/json/v1/tenant-a/user/${ROSTER_USER}` }, routeKey: USER_READ_KEY },
    { name: 'a form value', home: { method: 'POST', route: '/admin/', form: { userid: ROSTER_USER } }, routeKey: ROUTE_A },
    { name: 'a padded JSON body value', home: { method: 'POST', route: '/admin/', body: { user: { userid: ` ${ROSTER_USER} ` } } }, routeKey: ROUTE_A },
  ])('halts a 503 whose request names the user of a halted roster operation closing its unit, by $name, recorded once', async ({ home, routeKey }) => {
    const stack = fakeStack(
      { rows: [{ unit: 'identity.user_account', holderId: null, phase: null }], ignoresFilter: false },
      { operations: [haltedOperation(OPERATION_1)] },
    );
    const deps = depsOf(await writeVersion(ROSTER_ROUTES), stack.fetch);
    const scenario = withHome(home);
    const exceptionId = `EX-ROSTER-HALT-${OPERATION_1}`;
    const reason = `halted roster operation ${OPERATION_1} keeps user ${ROSTER_USER} closed`;

    const result = await replayScenario(scenario, deps);

    expect(result.status).toBe('replayed');
    if (!('output' in result)) throw new Error('no replay output');
    expect(result.output.halted).toEqual([{ step: 'home', routeKey, reason, exceptionId }]);
    expect(result.output.steps.map((step) => [step.name, step.normalised.status, step.exceptionId])).toEqual([
      ['main', 200, undefined],
      ['login', 200, undefined],
      ['home', 503, exceptionId],
    ]);
    const recorded = await readFile(exceptionsFile, 'utf8');
    expect((JSON.parse(recorded) as { entries: unknown[] }).entries).toEqual([rosterEntry(OPERATION_1)]);

    const again = await replayScenario(scenario, deps);

    expect('output' in again && again.output.halted).toEqual([{ step: 'home', routeKey, reason, exceptionId }]);
    expect(await readFile(exceptionsFile, 'utf8')).toBe(recorded);
  });

  it('halts a 503 that made its step throw by the multipart field the request sent naming the halted user', async () => {
    const stack = fakeStack(
      { rows: [{ unit: 'identity.user_account', holderId: null, phase: null }], ignoresFilter: false },
      { operations: [haltedOperation(OPERATION_1)] },
    );
    const deps = depsOf(await writeVersion(ROSTER_ROUTES), stack.fetch);
    const scenario = withHome({
      method: 'POST',
      route: '/admin/',
      multipart: { fields: { userid: ROSTER_USER }, files: [{ field: 'file', fixture: 'pdf-one-page', filename: 'a.pdf', contentType: 'application/pdf' }] },
      extract: { token: { from: 'dom', selector: 'input[name=csrf_token]', attr: 'value' } },
    });
    const exceptionId = `EX-ROSTER-HALT-${OPERATION_1}`;
    const reason = `halted roster operation ${OPERATION_1} keeps user ${ROSTER_USER} closed`;

    const result = await replayScenario(scenario, deps);

    expect(result.status).toBe('replayed');
    if (!('output' in result)) throw new Error('no replay output');
    expect(result.output.error).toBeUndefined();
    expect(result.output.halted).toEqual([{ step: 'home', routeKey: ROUTE_A, reason, exceptionId }]);
    expect(result.output.steps.map((step) => step.name)).toEqual(['main', 'login']);
    expect((JSON.parse(await readFile(exceptionsFile, 'utf8')) as { entries: unknown[] }).entries).toEqual([rosterEntry(OPERATION_1)]);
  });

  it.each<{ name: string; home: Partial<HomeStep>; state: HaltedFake['state'] }>([
    { name: 'a request naming another user', home: { route: `/admin/?userid=${OTHER_USER}` }, state: 'halted' },
    { name: 'a request naming no user', home: {}, state: 'halted' },
    { name: 'an operation an operator already resolved', home: { route: `/admin/?userid=${ROSTER_USER}` }, state: 'rolled-back' },
  ])('leaves the 503 a difference and replays on for $name, still recording the operation once', async ({ home, state }) => {
    const stack = fakeStack(
      { rows: [{ unit: 'identity.user_account', holderId: null, phase: null }], ignoresFilter: false },
      { operations: [haltedOperation(OPERATION_1, 'admin-update', state)] },
    );
    const deps = depsOf(await writeVersion(ROSTER_ROUTES), stack.fetch);

    const result = await replayScenario(withHome(home), deps);

    expect(result.status).toBe('replayed');
    if (!('output' in result)) throw new Error('no replay output');
    expect(result.output.halted).toEqual([]);
    expect(result.output.error).toBeUndefined();
    expect(result.output.steps.map((step) => [step.name, step.normalised.status, step.exceptionId])).toEqual([
      ['main', 200, undefined],
      ['login', 200, undefined],
      ['home', 503, undefined],
      ['logout', 200, undefined],
    ]);
    expect((JSON.parse(await readFile(exceptionsFile, 'utf8')) as { entries: unknown[] }).entries).toEqual([rosterEntry(OPERATION_1, state)]);
  });

  it.each<{ name: string; pageSize: number | undefined; afters: (string | null)[] }>([
    { name: 'listed on one page', pageSize: undefined, afters: [null, null] },
    { name: 'listed one a page, following next until null', pageSize: 1, afters: [null, '1', null, '1'] },
  ])('records each halted operation a scenario never touched once, apart from another halt on its route, leaving the 503 a difference, $name', async ({ pageSize, afters }) => {
    const caseHalt = {
      id: 'EX-HALT-GS-ID-01-01',
      scenario: 'GS-ID-01',
      routeKey: ADMIN_UPDATE_KEY,
      difference: 'an earlier import-pending halt',
      decision: 'preserve',
      reason: 'write window win-x is import-pending on people.person',
      status: 'halted',
      evidence: { golden: 'harness/golden/sets/GS-ID-01.json', replay: '${OPT2_STATE_DIR}/golden/replay/GS-ID-01.json' },
      sourceSha: SHA,
    };
    await writeFile(exceptionsFile, `${JSON.stringify({ sourceSha: SHA, entries: [caseHalt] }, null, 2)}\n`);
    const stack = fakeStack(
      { rows: QUIET_A, ignoresFilter: false },
      { operations: [haltedOperation(OPERATION_1), haltedOperation(OPERATION_2)], pageSize },
    );
    const deps = depsOf(await writeVersion(BOTH_ROUTES), stack.fetch);

    const result = await replayScenario(id01, deps);

    expect(result.status).toBe('replayed');
    if (!('output' in result)) throw new Error('no replay output');
    expect(result.output.halted).toEqual([]);
    expect(result.output.steps.map((step) => [step.name, step.normalised.status])).toEqual([
      ['main', 200],
      ['login', 200],
      ['home', 503],
      ['logout', 200],
    ]);
    const recorded = await readFile(exceptionsFile, 'utf8');
    expect((JSON.parse(recorded) as { entries: unknown[] }).entries).toEqual([
      caseHalt,
      rosterEntry(OPERATION_1),
      rosterEntry(OPERATION_2),
    ]);
    expect(stack.peopleCalls.map((url) => url.searchParams.get('after'))).toEqual(afters);

    await replayScenario(id01, deps);

    expect(await readFile(exceptionsFile, 'utf8')).toBe(recorded);
  });

  it.each(['rolled-back', 'done'] as const)(
    'records once an operation an operator resolved to %s before any replay, stating that state, and appends nothing on a second run',
    async (state) => {
      const stack = fakeStack(
        { rows: QUIET_A, ignoresFilter: false },
        { operations: [haltedOperation(OPERATION_1, 'admin-update', state)] },
      );
      const deps = depsOf(await writeVersion(BOTH_ROUTES), stack.fetch);

      const result = await replayScenario(id01, deps);

      expect(result.status).toBe('replayed');
      if (!('output' in result)) throw new Error('no replay output');
      expect(result.output.halted).toEqual([]);
      const recorded = await readFile(exceptionsFile, 'utf8');
      expect((JSON.parse(recorded) as { entries: unknown[] }).entries).toEqual([rosterEntry(OPERATION_1, state)]);

      await replayScenario(id01, deps);

      expect(await readFile(exceptionsFile, 'utf8')).toBe(recorded);
    },
  );

  it.each<{ name: string; serviceUrls: Record<string, string>; people: PeopleFake; message: RegExp }>([
    { name: 'people answering 503', serviceUrls: { people: PEOPLE }, people: { status: 503 }, message: /people listHaltedRosterOperationsPage answered 503/ },
    {
      name: 'people answering the cursor it was sent as its next cursor',
      serviceUrls: { people: PEOPLE },
      people: { operations: [haltedOperation(OPERATION_1)], stalls: true },
      message: /people listHaltedRosterOperationsPage answered the cursor it was sent as its next cursor/,
    },
    { name: 'OPT2_SERVICE_URLS naming no people URL', serviceUrls: {}, people: { status: 503 }, message: /OPT2_SERVICE_URLS has no URL for people/ },
  ])('fails the replay, keeping its exchanges and the list, given $name', async ({ serviceUrls, people, message }) => {
    const before = await readFile(exceptionsFile, 'utf8');
    const stack = fakeStack({ rows: [], ignoresFilter: false }, people);
    const deps = depsOf(await writeVersion([{ route: ROUTE_B, units: [UNIT_B] }]), stack.fetch);

    const result = await replayScenario(id01, { ...deps, sideEffects: { config: { serviceUrls, mailpitUrl: MAILPIT } } });

    expect(result.status).toBe('error');
    if (!('output' in result)) throw new Error('no replay output');
    expect(result.output.error?.message).toMatch(message);
    expect(result.output.steps.map((step) => step.name)).toEqual(['main', 'login', 'home', 'logout']);
    expect(await readFile(exceptionsFile, 'utf8')).toBe(before);
  });
});

describe('rosterHaltEntry', () => {
  it.each([
    { kind: 'admin-add', routeKey: 'admin:cusers.update{type=2,action=add}', appliesTo: undefined },
    { kind: 'admin-update', routeKey: ADMIN_UPDATE_KEY, appliesTo: undefined },
    { kind: 'profile-update', routeKey: 'admin:ceditprofile.update', appliesTo: undefined },
  ] as const)('keys a halted $kind operation by the route it runs on', ({ kind, routeKey, appliesTo }) => {
    const entry = rosterHaltEntry({ ...haltedOperation(OPERATION_1.toLowerCase()), kind }, 'GS-PE-02', SHA);

    expect(entry.id).toBe(`EX-ROSTER-HALT-${OPERATION_1}`);
    expect(entry.id).toMatch(/^EX-[A-Z0-9]+(?:-[A-Z0-9]+)*$/);
    expect([entry.routeKey, entry.appliesTo]).toEqual([routeKey, appliesTo]);
    expect(entry.evidence).toEqual({
      golden: 'harness/golden/sets/GS-PE-02.json',
      replay: '${OPT2_STATE_DIR}/golden/replay/GS-PE-02.json',
    });
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
