// Unit suite of the gateway reach map against v0002: edge paths per route, skips, response verdicts and owner evidence.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Roles, serviceRole, type RouteMatrixEntry } from '@opt2/platform/auth';
import { ADMIN_NOACCESS_ACTION } from '@opt2/platform/legacy-compat';
import { REQUEST_ID_HEADER, requestIdFrom } from '@opt2/platform/service-kit';
import { verifySignedUrl } from '@opt2/platform/storage';
import { ROLE_SET } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CapturedLogLine } from '../../src/events/traces.js';
import { loadInventoryVariants } from '../../src/inventory/route-keys.js';
import { readJson } from '../../src/lib/report.js';
import {
  diffOutcomes,
  expectationsFor,
  routeMatrixFileSchema,
  type Expectation,
  type LoadedMatrix,
} from '../../src/security/authz-matrix.js';
import {
  PROBE_REQUEST_ID_PREFIX,
  REQUEST_COMPLETED_MESSAGE,
  classifyResponse,
  cutoverVersionFile,
  gatewayReach,
  indexRequestRecords,
  isControl,
  loadCutoverVersion,
  localFileSigner,
  newProbeRequestId,
  ownerRecord,
  parseRequestRecord,
  reachAccounting,
  reachVerdicts,
  skipReason,
  type CutoverVersion,
  type GatewayPath,
  type GatewayResponse,
  type NotProbedReason,
  type NotProbedRoute,
  type ProbedRoute,
  type ReachKind,
  type ReachMap,
  type ReachProbe,
  type ReachState,
  type RequestRecord,
  type SkippedCell,
} from '../../src/security/gateway-reach.js';

const GATEWAY_MATRIX_FILE = fileURLToPath(
  new URL('../fixtures/security/gateway-route-matrix.sample.json', import.meta.url),
);
const ID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}';
const FIXTURE = '/legacy-fixtures/cfml/api.cfm';
const RECORD = `${FIXTURE}/finance/records/:id`;
const FILE_ROUTE = '/opt2/files/finance-attachments/:tenantId/:objectName';
const SIGNED_QUERY = '?expires=1&sig=test';
const FINANCE_ACTIONS = ['approve', 'edit', 'reject', 'resubmit', 'submit'];
const RELAY_URL = '/internal/v1/relay/:service/*';
const RELAY_TARGET = 'identity';

/** A service-transport route that requires `system-user`, or is public. */
function route(method: string, url: string, opts: { public?: true } = {}): RouteMatrixEntry {
  return opts.public === true
    ? { method, url, transport: 'service', public: true, siteCheck: true }
    : { method, url, transport: 'service', requires: [Roles.systemUser], siteCheck: true };
}

function matrixOf(pkg: string, routes: RouteMatrixEntry[]): LoadedMatrix {
  return { package: pkg, file: `${pkg}.json`, matrix: { routes } };
}

/** Anchored pattern of a template's filled path: each named parameter as a CF UUID. */
function filledPattern(url: string, suffix = ''): RegExp {
  return new RegExp(`^${url.replaceAll('.', '\\.').replace(/:\w+/g, ID)}${suffix}$`);
}

const FINANCE = matrixOf('finance', [
  route('GET', '/healthz', { public: true }),
  route('GET', '/internal/v1/migration/export'),
  route('GET', `${FIXTURE}/finance/records`),
  route('POST', `${FIXTURE}/finance/records`),
  route('GET', RECORD),
  route('POST', `${RECORD}/:action`),
  route('GET', `${RECORD}/versions`),
  route('GET', `${RECORD}/attachments`),
  route('POST', `${RECORD}/attachments`),
  route('GET', `${RECORD}/attachments/:aid`),
  route('GET', FILE_ROUTE, { public: true }),
  route('GET', '/v1/finance/records'),
]);

const STUB = matrixOf('stub', [
  route('GET', '/healthz', { public: true }),
  route('GET', '/opt2/stub/notes'),
  route('POST', '/opt2/stub/notes'),
  route('GET', '/opt2/stub/notes/:noteId'),
  route('GET', '/opt2/stub/*'),
  route('GET', '/opt2/stub/opt2-authz-probe/:id'),
  route('POST', '/internal/v1/events/stub.stub.note.created.v1'),
]);

const PEOPLE = matrixOf('people', [
  route('GET', `${FIXTURE}/people/persons/:userId/archive`),
  route('POST', `${FIXTURE}/people/persons/:userId/archive`),
  route('GET', `${FIXTURE}/finance/records`),
  route('GET', '/gateway/legacy-bridge/session'),
  route('GET', '/opt2/svc/people/v1/users'),
]);

let version: CutoverVersion;
let gateway: LoadedMatrix;
let matrices: LoadedMatrix[];
let reach: ReachMap;
const signed: string[] = [];

/** Test signer: records each path and appends a fixed query. */
function sign(path: string): string {
  signed.push(path);
  return `${path}${SIGNED_QUERY}`;
}

/** The reach of `pkg`'s `method url`, asserted to be listed exactly once. */
function reachOf(pkg: string, method: string, url: string): ProbedRoute | NotProbedRoute {
  const found = [...reach.probed, ...reach.notProbed].filter(
    (entry) => entry.package === pkg && entry.method === method && entry.url === url,
  );
  expect(found, `${pkg} ${method} ${url}`).toHaveLength(1);
  return found[0] as ProbedRoute | NotProbedRoute;
}

function probedOf(pkg: string, method: string, url: string): ProbedRoute {
  const found = reachOf(pkg, method, url);
  if (!('paths' in found)) throw new Error(`${pkg} ${method} ${url} is not probed: ${found.detail}`);
  return found;
}

beforeAll(async () => {
  version = await loadCutoverVersion('v0002');
  const { variants } = await loadInventoryVariants();
  const gatewayRoutes = await readJson(GATEWAY_MATRIX_FILE, routeMatrixFileSchema);
  gateway = { package: 'gateway', file: GATEWAY_MATRIX_FILE, matrix: gatewayRoutes };
  matrices = [gateway, FINANCE, STUB, PEOPLE];
  reach = gatewayReach({ matrices, version, variants, sign, gatewayParams: { service: RELAY_TARGET } });
});

describe('loadCutoverVersion', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opt2-reach-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the committed v0002 entries with their owner, state and kind', () => {
    expect(cutoverVersionFile('v0002')).toMatch(/gateway\/cutover\/versions\/v0002\.json$/);
    expect(version.tableVersion).toBe('v0002');
    expect(version.entries).toContainEqual({
      route: 'fixture:finance/records/{id}/approve@post',
      owningService: 'finance',
      state: 'target',
      kind: 'write',
    });
  });

  it('refuses a file that names another version', async () => {
    await expect(loadCutoverVersion('v0003', cutoverVersionFile('v0002'))).rejects.toThrow(
      /differs from the requested v0003/,
    );
  });

  it('refuses an entry with an unknown kind', async () => {
    const file = join(dir, 'v0009.json');
    const entries = [{ route: 'x', owningService: 'stub', state: 'target', kind: 'other' }];
    await writeFile(file, JSON.stringify({ tableVersion: 'v0009', entries }));
    await expect(loadCutoverVersion('v0009', file)).rejects.toThrow(/v0009\.json/);
  });
});

describe('gatewayReach', () => {
  it('probes every non-edge gateway route at its own filled path', () => {
    const own = reach.probed.filter((entry) => entry.package === 'gateway');
    expect(own.map((entry) => `${entry.method} ${entry.url}`)).toEqual(
      gateway.matrix.routes.filter((entry) => entry.edge !== true).map((entry) => `${entry.method} ${entry.url}`),
    );
    expect(own.every((entry) => entry.reach === 'gateway-own' && entry.paths.length === 1)).toBe(true);
    expect(probedOf('gateway', 'GET', '/healthz').paths).toEqual([{ path: '/healthz' }]);
    expect(probedOf('gateway', 'POST', '/internal/v1/inflight::clear-orphans').paths).toEqual([
      { path: '/internal/v1/inflight:clear-orphans' },
    ]);
    expect(probedOf('gateway', 'GET', RELAY_URL).paths[0]?.path).toMatch(
      new RegExp(`^/internal/v1/relay/${RELAY_TARGET}/opt2-authz-probe/${ID}$`),
    );
  });

  it.each<[string, Record<string, string> | undefined, string]>([
    ['fills the relay :service with the given relay target', { service: RELAY_TARGET }, RELAY_TARGET],
    ['fills the relay :service with a CF UUID when no value is given', undefined, ID],
    ['leaves a non-gateway parameter of the same name to a CF UUID', { noteId: 'given' }, ID],
  ])('%s', async (_name, gatewayParams, service) => {
    const { variants } = await loadInventoryVariants();
    const filled = gatewayReach({ matrices, version, variants, sign: (path) => path, gatewayParams });
    const relay = filled.probed.find((entry) => entry.package === 'gateway' && entry.method === 'GET' && entry.url === RELAY_URL);
    expect(relay?.paths[0]?.path).toMatch(new RegExp(`^/internal/v1/relay/${service}/opt2-authz-probe/${ID}$`));
    const note = filled.probed.find((entry) => entry.package === 'stub' && entry.url === '/opt2/stub/notes/:noteId');
    expect(note?.paths[0]?.path).toMatch(filledPattern('/opt2/stub/notes/:noteId'));
  });

  it.each<[string, string, string, NotProbedReason, RegExp]>([
    ['finance', 'GET', '/healthz', 'served-by-gateway', /gateway route GET \/healthz answers GET \/healthz/],
    ['stub', 'GET', '/healthz', 'served-by-gateway', /gateway route GET \/healthz/],
    ['people', 'GET', '/opt2/svc/people/v1/users', 'served-by-gateway', /relay alias \/opt2\/svc\//],
    ['finance', 'GET', '/internal/v1/migration/export', 'no-target-entry', /page:render matches page:render, legacy/],
    ['finance', 'GET', '/v1/finance/records', 'no-target-entry', /legacy in this version/],
    ['people', 'GET', `${FIXTURE}/people/persons/:userId/archive`, 'no-target-entry', /archive@get, legacy/],
    ['people', 'GET', `${FIXTURE}/finance/records`, 'no-target-entry', /owned by finance rather than people/],
    ['people', 'GET', '/gateway/legacy-bridge/session', 'no-target-entry', /which the gateway answers with 404/],
    ['stub', 'POST', '/internal/v1/events/stub.stub.note.created.v1', 'no-target-entry', /matches no entry/],
    ['stub', 'GET', '/opt2/stub/*', 'no-target-entry', /is served by GET \/opt2\/stub\/opt2-authz-probe\/:id/],
  ])('leaves %s %s %s unprobed as %s', (pkg, method, url, reason, detail) => {
    const found = reachOf(pkg, method, url);
    expect(found).toMatchObject({ reason, coveredBy: `npm run test:security in services/${pkg}` });
    expect('detail' in found ? found.detail : '').toMatch(detail);
  });

  it('expands the finance :action parameter to exactly the five literal transition entries', () => {
    const { paths, reach: kind } = probedOf('finance', 'POST', `${RECORD}/:action`);
    expect(kind).toBe('cut-over');
    expect(paths.map((entry) => entry.entry?.route)).toEqual(
      FINANCE_ACTIONS.map((action) => `fixture:finance/records/{id}/${action}@post`),
    );
    paths.forEach((entry, index) => {
      expect(entry.path).toMatch(filledPattern(RECORD, `/${FINANCE_ACTIONS[index]}`));
      expect(entry.entry?.kind).toBe('write');
    });
  });

  it.each<[string, string, string, string]>([
    ['finance', 'POST', `${RECORD}/attachments`, 'fixture:finance/records/{id}/attachments@post'],
    ['finance', 'GET', `${RECORD}/attachments/:aid`, 'fixture:finance/records/{id}/attachments/{id}@get'],
    ['finance', 'GET', RECORD, 'fixture:finance/records/{id}@get'],
    ['people', 'POST', `${FIXTURE}/people/persons/:userId/archive`, 'fixture:people/persons/{id}/archive@post'],
    ['stub', 'GET', '/opt2/stub/notes', 'opt2:/opt2/stub/**'],
    ['stub', 'POST', '/opt2/stub/notes', 'opt2:/opt2/stub/**'],
    ['stub', 'GET', '/opt2/stub/notes/:noteId', 'opt2:/opt2/stub/**'],
  ])('probes %s %s %s through %s on one path', (pkg, method, url, entry) => {
    const { paths, reach: kind } = probedOf(pkg, method, url);
    expect(kind).toBe('cut-over');
    expect(paths).toHaveLength(1);
    expect(paths[0]?.entry?.route).toBe(entry);
    expect(paths[0]?.path).toMatch(filledPattern(url));
  });

  it('sends the finance attachment file route on a path the injected signer signed', () => {
    const { paths } = probedOf('finance', 'GET', FILE_ROUTE);
    const unsigned = filledPattern(FILE_ROUTE);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.entry).toEqual({ route: 'opt2:/opt2/files/finance-attachments/**', kind: 'read' });
    expect(paths[0]?.path.endsWith(SIGNED_QUERY)).toBe(true);
    expect(paths[0]?.path.slice(0, -SIGNED_QUERY.length)).toMatch(unsigned);
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatch(unsigned);
  });

  it('accounts for every non-edge declared route exactly once', () => {
    expect(reachAccounting(matrices, reach)).toEqual({ missing: [], repeated: [], undeclared: [] });
    const declared = matrices.flatMap((matrix) => matrix.matrix.routes.filter((entry) => entry.edge !== true));
    expect(reach.probed.length + reach.notProbed.length).toBe(declared.length);
  });
});

describe('reachAccounting', () => {
  it('names a missing, a repeated and an undeclared route', () => {
    const [first, second, ...rest] = reach.probed;
    if (first === undefined || second === undefined) throw new Error('fewer than two probed routes');
    const extra: ProbedRoute = { ...first, url: '/undeclared' };
    const probed = [second, second, ...rest, extra];
    expect(reachAccounting(matrices, { probed, notProbed: reach.notProbed })).toEqual({
      missing: [`${first.package} ${first.method} ${first.url}`],
      repeated: [`${second.package} ${second.method} ${second.url}`],
      undeclared: [`${first.package} ${first.method} /undeclared`],
    });
  });
});

describe('localFileSigner', () => {
  const key = Buffer.from('opt2-test-storage-key', 'utf8');
  const expires = 2_000_000_000;

  it('signs a bucket path so that the local verifier accepts it for that bucket and key', () => {
    const url = localFileSigner(key, expires)('/opt2/files/finance-attachments/tenant/object');
    expect(verifySignedUrl(url, (expires - 1) * 1000, key)).toEqual({
      ok: true,
      bucket: 'finance-attachments',
      key: 'tenant/object',
      expires,
    });
  });

  it.each(['/opt2/stub/notes', '/opt2/files/no-such-bucket/object', '/opt2/files/finance-attachments'])(
    'refuses %s',
    (path) => {
      expect(() => localFileSigner(key, expires)(path)).toThrow(/not a local signed-file path/);
    },
  );
});

describe('skipReason', () => {
  type Cell = Pick<Expectation, 'outcome' | 'method' | 'url'>;
  const LAUNCH = 'fixture:surveys/surveys/{id}/launch@get';
  const cell = (outcome: 'allow' | 'deny', method: string, url = '/opt2/x'): Cell => ({ outcome, method, url });
  const at = (entry?: GatewayPath['entry']): GatewayPath => (entry === undefined ? { path: '/x' } : { path: '/x', entry });

  it.each<[string, Cell, GatewayPath, string | undefined]>([
    ['an expected deny', cell('deny', 'POST'), at({ route: LAUNCH, kind: 'write' }), undefined],
    ['a logout route', cell('allow', 'GET', '/admin/logout'), at(), 'session-ending'],
    ['a write method', cell('allow', 'POST'), at(), 'not-read-only'],
    ['a GET on a method-keyed write entry', cell('allow', 'GET'), at({ route: LAUNCH, kind: 'write' }), 'not-read-only'],
    ['a GET on a job entry', cell('allow', 'GET'), at({ route: 'sitemonitor:run', kind: 'job' }), 'not-read-only'],
    ['a GET on a write glob entry', cell('allow', 'GET'), at({ route: 'opt2:/opt2/stub/**', kind: 'write' }), undefined],
    ['a GET on a read entry', cell('allow', 'GET'), at({ route: 'fixture:finance/records@get', kind: 'read' }), undefined],
    ["a GET on a gateway's own route", cell('allow', 'GET'), at(), undefined],
  ])('answers %s', (_name, expectation, path, reason) => {
    expect(skipReason(expectation, path)).toBe(reason);
  });
});

describe('isControl', () => {
  it.each<[string, 'allow' | 'deny', ReachKind, boolean]>([
    [Roles.member, 'allow', 'cut-over', true],
    ['anonymous', 'allow', 'cut-over', true],
    [serviceRole('web'), 'allow', 'cut-over', false],
    [serviceRole('web'), 'allow', 'gateway-own', true],
    [Roles.member, 'deny', 'cut-over', false],
    ['forged-token', 'allow', 'gateway-own', false],
  ])('%s expected to %s on a %s route: %s', (subject, outcome, kind, control) => {
    expect(isControl({ subject, outcome }, kind)).toBe(control);
  });
});

/** A captured `request completed` line of `source`, or another line when `fields.message` overrides it. */
function logLine(source: string, fields: Record<string, unknown>): CapturedLogLine {
  return { source, line: JSON.stringify({ severity: 'INFO', service: source, message: REQUEST_COMPLETED_MESSAGE, ...fields }) };
}

describe('newProbeRequestId', () => {
  it('mints distinct ids that service-kit adopts verbatim as the request id', () => {
    const [first, second] = [newProbeRequestId(), newProbeRequestId()];
    expect(first).toMatch(new RegExp(`^${PROBE_REQUEST_ID_PREFIX}[0-9a-f-]{36}$`));
    expect(second).not.toBe(first);
    expect(requestIdFrom({ [REQUEST_ID_HEADER]: first })).toBe(first);
  });
});

describe('parseRequestRecord and indexRequestRecords', () => {
  const fields = { requestId: 'r1', route: '/opt2/stub/notes', httpMethod: 'GET', statusCode: 200, latencyMs: 3 };

  it.each<[string, CapturedLogLine]>([
    ['a non-JSON line', { source: 'stub', line: 'node: warning' }],
    ['a JSON scalar', { source: 'stub', line: '42' }],
    ['JSON null', { source: 'stub', line: 'null' }],
    ['another message', logLine('stub', { ...fields, message: 'shutdown failed' })],
    ['a record without a status', logLine('stub', { ...fields, statusCode: undefined })],
    ['a record with a non-string route', logLine('stub', { ...fields, route: 7 })],
  ])('ignores %s', (_name, line) => {
    expect(parseRequestRecord(line)).toBeUndefined();
  });

  it('indexes the records of every package by request id and skips every other line', () => {
    const lines = [
      { source: 'gateway', line: 'not json' },
      logLine('gateway', { ...fields, route: '/*' }),
      logLine('stub', { ...fields, message: 'listening' }),
      logLine('stub', fields),
      logLine('stub', { ...fields, requestId: 'r2', statusCode: 404 }),
    ];
    const record = (source: string, extra: Partial<RequestRecord> = {}): RequestRecord => ({
      source,
      requestId: 'r1',
      route: '/opt2/stub/notes',
      httpMethod: 'GET',
      statusCode: 200,
      ...extra,
    });
    expect(indexRequestRecords(lines)).toEqual(
      new Map([
        ['r1', [record('gateway', { route: '/*' }), record('stub')]],
        ['r2', [record('stub', { requestId: 'r2', statusCode: 404 })]],
      ]),
    );
  });
});

describe('ownerRecord', () => {
  const owner = { package: 'stub', method: 'GET', url: '/opt2/stub/notes/:noteId' };
  const matching = { requestId: 'r1', route: owner.url, httpMethod: 'GET', statusCode: 404 };

  it.each<[string, CapturedLogLine, boolean]>([
    ["the owner's record at the declared template and method", logLine('stub', matching), true],
    ["another package's record", logLine('gateway', matching), false],
    ["another request id's record", logLine('stub', { ...matching, requestId: 'r2' }), false],
    ['a record at the raw path no route matched', logLine('stub', { ...matching, route: '/opt2/stub/notes/N1' }), false],
    ["another route's record", logLine('stub', { ...matching, route: '/opt2/stub/notes' }), false],
    ["another method's record", logLine('stub', { ...matching, httpMethod: 'POST' }), false],
  ])('takes %s as evidence: %s', (_name, line, found) => {
    const record = ownerRecord(owner, { requestId: 'r1' }, indexRequestRecords([line]));
    expect(record !== undefined).toBe(found);
  });
});

describe('reachVerdicts', () => {
  const NOTE = '/opt2/stub/notes/:noteId';
  const NOTE_PATH = '/opt2/stub/notes/N1';
  const STUB_GET = { package: 'stub', method: 'GET' } as const;
  const noteRoute: ProbedRoute = { ...STUB_GET, url: NOTE, reach: 'cut-over', paths: [{ path: NOTE_PATH }] };
  const cellAt = (url: string, subject: string, outcome: 'allow' | 'deny', status?: 401 | 403): Expectation => ({
    ...STUB_GET,
    url,
    transport: 'service',
    subject,
    outcome,
    ...(status === undefined ? {} : { status }),
    reason: outcome === 'allow' ? 'role' : 'missing-role',
  });
  const probeAt = (url: string, subject: string, observed: number, requestId: string): ReachProbe => ({
    ...STUB_GET,
    url,
    subject,
    status: observed,
    path: NOTE_PATH,
    requestId,
    observedStatus: observed,
    detail: `HTTP ${observed}`,
  });

  describe('finance POST records/:id/:action, every allow cell left unsent', () => {
    let action: ProbedRoute;
    let cells: Expectation[];
    let probes: ReachProbe[];
    let skipped: SkippedCell[];

    beforeAll(() => {
      action = probedOf('finance', 'POST', `${RECORD}/:action`);
      cells = expectationsFor(FINANCE, ROLE_SET).filter((cell) => cell.method === 'POST' && cell.url === action.url);
      probes = [];
      skipped = [];
      for (const cell of cells) {
        for (const path of action.paths) {
          const reason = skipReason(cell, path);
          const { package: pkg, method, url, subject } = cell;
          if (reason !== undefined) skipped.push({ package: pkg, method, url, subject, path: path.path, reason });
          else {
            const status = cell.status as number;
            const sent = { package: pkg, method, url, subject, status, observedStatus: status, detail: `HTTP ${status}` };
            probes.push({ ...sent, path: path.path, requestId: `${subject}@${path.path}` });
          }
        }
      }
    });

    it('sends only the deny cells, on all five transition paths', () => {
      const allows = cells.filter((cell) => cell.outcome === 'allow').length;
      const denies = cells.length - allows;
      expect(allows).toBeGreaterThan(0);
      expect(skipped).toHaveLength(allows * FINANCE_ACTIONS.length);
      expect(probes).toHaveLength(denies * FINANCE_ACTIONS.length);
    });

    it('fails without an owner record and is not left unclaimed', () => {
      const [verdict] = reachVerdicts([action], cells, probes, skipped, new Map());
      expect(verdict).toMatchObject({ state: 'failed', basis: 'deny', proving: 0, sent: probes.length });
      expect(verdict?.judged.every((probe) => probe.ownerStatus === null)).toBe(true);
      expect(verdict?.reason).toMatch(/no deny probe has an owner record .* refused with 401 or 403/);
    });

    it.each<[string, string, number, ReachState]>([
      ["is proven by the owner's own 403", 'finance', 403, 'proven-by-owner-denial'],
      ["fails on the gateway's 403 at the owner's template", 'gateway', 403, 'failed'],
      ['fails on an owner record that did not refuse', 'finance', 200, 'failed'],
    ])('%s', (_name, source, statusCode, state) => {
      const member = probes.find((probe) => probe.subject === Roles.member) as ReachProbe;
      const line = logLine(source, { requestId: member.requestId, route: action.url, httpMethod: 'POST', statusCode });
      const [verdict] = reachVerdicts([action], cells, probes, skipped, indexRequestRecords([line]));
      expect(verdict).toMatchObject({ state, basis: 'deny', proving: state === 'failed' ? 0 : 1 });
    });
  });

  it.each<[string, number, { source: string; route: string } | undefined, number | null, ReachState]>([
    ['a control answered 404 without any owner record', 404, undefined, null, 'failed'],
    ['a control 404 the owner logged at the raw path', 404, { source: 'stub', route: NOTE_PATH }, null, 'failed'],
    ['a control answered 500 without any owner record', 500, undefined, null, 'failed'],
    ['a gateway fail-closed 503 logged by the gateway only', 503, { source: 'gateway', route: '/*' }, null, 'failed'],
    ['an owner record of 503', 503, { source: 'stub', route: NOTE }, 503, 'failed'],
    ['an owner record of 500', 500, { source: 'stub', route: NOTE }, 500, 'failed'],
    ['an owner record denying the control', 403, { source: 'stub', route: NOTE }, 403, 'failed'],
    ['a resource 404 the owner route answered', 404, { source: 'stub', route: NOTE }, 404, 'proven-by-control'],
    ['a 200 the owner route answered', 200, { source: 'stub', route: NOTE }, 200, 'proven-by-control'],
  ])('judges %s', (_name, observed, logged, ownerStatus, state) => {
    const expected = [cellAt(NOTE, 'anonymous', 'deny', 401), cellAt(NOTE, Roles.systemUser, 'allow')];
    const probes = [probeAt(NOTE, 'anonymous', 401, 'anon'), probeAt(NOTE, Roles.systemUser, observed, 'ctl')];
    // The owner's own 401 to anonymous never stands in for a control.
    const lines = [logLine('stub', { requestId: 'anon', route: NOTE, httpMethod: 'GET', statusCode: 401 })];
    if (logged !== undefined) {
      lines.push(logLine(logged.source, { requestId: 'ctl', route: logged.route, httpMethod: 'GET', statusCode: observed }));
    }
    const [verdict] = reachVerdicts([noteRoute], expected, probes, [], indexRequestRecords(lines));
    expect(verdict).toMatchObject({ state, basis: 'control', sent: 2, proving: state === 'failed' ? 0 : 1 });
    expect(verdict?.judged).toEqual([
      { subject: Roles.systemUser, path: NOTE_PATH, requestId: 'ctl', observedStatus: observed, ownerStatus },
    ]);
    if (state === 'failed') expect(verdict?.reason).toMatch(/no authorised control has an owner record/);
  });

  it.each<[string, Expectation[], string[], ReachState, RegExp]>([
    [
      'leaves a route whose every cell is an allow left unsent as not-sent',
      [cellAt(NOTE, 'anonymous', 'allow'), cellAt(NOTE, Roles.systemUser, 'allow')],
      ['anonymous', Roles.systemUser],
      'not-sent',
      /every cell is an allow left unsent \(not-read-only\)/,
    ],
    [
      'fails a route whose deny cell was not observed',
      [cellAt(NOTE, 'anonymous', 'deny', 401), cellAt(NOTE, Roles.systemUser, 'allow')],
      [Roles.systemUser],
      'failed',
      /no probe of this route was observed/,
    ],
    [
      'fails a route whose allow cell was neither sent nor left unsent',
      [cellAt(NOTE, 'anonymous', 'allow'), cellAt(NOTE, Roles.systemUser, 'allow')],
      ['anonymous'],
      'failed',
      /no probe of this route was observed/,
    ],
    ['fails a route with no cell', [], [], 'failed', /no probe of this route was observed/],
  ])('%s', (_name, expected, unsentSubjects, state, reason) => {
    const skipped = unsentSubjects.map(
      (subject): SkippedCell => ({ ...STUB_GET, url: NOTE, subject, path: NOTE_PATH, reason: 'not-read-only' }),
    );
    const [verdict] = reachVerdicts([noteRoute], expected, [], skipped, new Map());
    expect(verdict).toMatchObject({ state, sent: 0, basis: 'none', proving: 0, judged: [] });
    expect(verdict?.reason).toMatch(reason);
    expect(verdict?.coveredBy).toBe(state === 'not-sent' ? 'npm run test:security in services/stub' : undefined);
  });

  it('fails a route on which only a service subject the owner never sees was sent', () => {
    const web = serviceRole('web');
    const owner = logLine('stub', { requestId: 'web', route: NOTE, httpMethod: 'GET', statusCode: 200 });
    const [verdict] = reachVerdicts(
      [noteRoute],
      [cellAt(NOTE, web, 'allow')],
      [probeAt(NOTE, web, 200, 'web')],
      [],
      indexRequestRecords([owner]),
    );
    expect(verdict).toMatchObject({ state: 'failed', basis: 'none', sent: 1, judged: [] });
    expect(verdict?.reason).toBe('neither an authorised control nor a deny cell was sent');
  });

  it("proves the gateway's relay GET by the web control the gateway's own relay route logged", () => {
    const relay = probedOf('gateway', 'GET', RELAY_URL);
    const path = relay.paths[0]?.path as string;
    const expected = expectationsFor(gateway, ROLE_SET).filter((cell) => cell.method === 'GET' && cell.url === RELAY_URL);
    const probes = expected.map(
      (cell): ReachProbe => ({
        package: 'gateway',
        method: 'GET',
        url: RELAY_URL,
        subject: cell.subject,
        status: cell.status ?? 404,
        path,
        requestId: `relay-${cell.subject}`,
        observedStatus: cell.status ?? 404,
        detail: 'relayed',
      }),
    );
    const web = serviceRole('web');
    const record = logLine('gateway', { requestId: `relay-${web}`, route: RELAY_URL, httpMethod: 'GET', statusCode: 404 });
    const [verdict] = reachVerdicts([relay], expected, probes, [], indexRequestRecords([record]));
    expect(path.startsWith(`/internal/v1/relay/${RELAY_TARGET}/`)).toBe(true);
    expect(verdict).toMatchObject({ state: 'proven-by-control', basis: 'control', proving: 1 });
    expect(verdict?.judged.map((probe) => probe.subject)).toEqual([web]);
  });
});

describe('classifyResponse', () => {
  const response = (status: number, opts: { text?: string; location?: string } = {}): GatewayResponse => ({
    status,
    url: 'http://127.0.0.1:8100/admin/?muraAction=cusers.list',
    text: opts.text ?? '',
    headers: opts.location === undefined ? {} : { location: opts.location },
  });
  const tokenRefusal = JSON.stringify({ error: { code: 'invalid_token', message: 'Invalid Access Token' } });

  it.each<[string, GatewayResponse, 'denied' | 'allowed', number, RegExp]>([
    ['a 404', response(404), 'allowed', 404, /HTTP 404: no route or resource answered, which is not a denial/],
    ['a 401', response(401), 'denied', 401, /^HTTP 401$/],
    ['a 403', response(403), 'denied', 403, /^HTTP 403$/],
    ['a credential-refusal envelope', response(200, { text: tokenRefusal }), 'denied', 401, /invalid_token/],
    ['a redirect to the login gate', response(302, { location: './?muraAction=clogin.main' }), 'denied', 401, /clogin/],
    [
      'a redirect to the no-access gate',
      response(302, { location: `./?muraAction=${ADMIN_NOACCESS_ACTION}` }),
      'denied',
      403,
      /to cmessage\.noaccess/,
    ],
    ['a redirect to the back-up target', response(302, { location: './' }), 'denied', 403, /back-up target/],
    ['a redirect elsewhere', response(302, { location: '/sites/default/' }), 'allowed', 302, /to \/sites\/default\//],
    ['a 200', response(200, { text: 'not json' }), 'allowed', 200, /^HTTP 200$/],
  ])('classifies %s', (_name, answer, verdict, status, detail) => {
    const classified = classifyResponse(answer);
    expect(classified).toMatchObject({ verdict, status });
    expect(classified.detail).toMatch(detail);
  });

  it('turns an expected deny answered 404 into an unexpected allow', () => {
    const cell = { package: 'stub', method: 'GET', url: '/opt2/stub/notes', subject: 'anonymous' };
    const expectation: Expectation = { ...cell, transport: 'service', outcome: 'deny', status: 401, reason: 'anonymous' };
    const diff = diffOutcomes([expectation], [{ ...cell, status: classifyResponse(response(404)).status }]);
    expect(diff.unexpectedAllows).toHaveLength(1);
    expect(diff.pass).toBe(false);
  });
});
