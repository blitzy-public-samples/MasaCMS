// Seam checks run against a scripted gateway, owner exports and clock: no socket, emulator or real timer is used.
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_EXPORT_LIMIT,
  MIGRATION_PATH_PREFIX,
  encodeKey,
  encodeRow,
  sha256Hex,
  type CanonicalColumn,
  type CanonicalType,
  type ExportResponse,
  type ExportTable,
  type GateRequest,
  type UnitGate,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, registryPayloads, testVerifier, writeTestSecrets } from '@opt2/platform/testing';

import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REDELIVERY_POLL,
  DEFAULT_SEAM_SITE,
  NOTE_PROJECTION_UNIT,
  NOTE_UNIT,
  fanoutDestinations,
  noteSeamFanout,
  pollUntil,
  readOwnerExport,
  runNoteSeam,
  siteRegistry,
  stubDeliveryLog,
  unitFor,
  type DeliveryAnswer,
  type DeliveryLog,
  type NoteSeamOptions,
  type RegistrySite,
  type SeamDeps,
} from '../../src/events/seams.js';
import type { SecretStore } from '../../src/golden/session.js';
import type { FetchLike } from '../../src/lib/http.js';
import { createHarnessInvoker, harnessCallerRoles, type HarnessInvoker } from '../../src/lib/invocation.js';
import type { PackageName } from '../../src/repro/ports.js';
import { writeUpState } from '../../src/repro/up-state.js';

type Row = Record<string, unknown>;

// No listener on these ports; every request goes to the fake fetch of its test.
const GATEWAY = 'http://127.0.0.1:8500';
const PEOPLE_URL = 'http://127.0.0.1:8512';
const SITES_URL = 'http://127.0.0.1:8513';
const STUB_URL = 'http://127.0.0.1:8599';
const SERVICE_URLS = {
  people: PEOPLE_URL,
  'programs-sites': SITES_URL,
  stub: STUB_URL,
} as const satisfies Partial<Record<PackageName, string>>;
const SERVICE_BY_ORIGIN: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SERVICE_URLS).map(([service, url]) => [url, service]),
);

const EXPORT_PATH = `${MIGRATION_PATH_PREFIX}/export`;
const GATE_PATH = `${MIGRATION_PATH_PREFIX}/gate`;
const POSITION_PATH = `${MIGRATION_PATH_PREFIX}/position`;
const NOTE_PUSH_ROUTE = '/internal/v1/events/stub.stub.note.created.v1';
const NOTES_PATH = '/opt2/stub/notes';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;
// Wire names are spelled as Cloud Run and legacy Masa spell them, so the suite needs no platform subpath beyond its
// declared ones and fails if the harness ever sends another name.
const INVOCATION_HEADER = 'x-serverless-authorization';
const CSRF_FIELD_TOKEN = 'csrf_token';
const CSRF_FIELD_EXPIRES = 'csrf_token_expires';
const CSRF_EXPIRES = '260630120000000';
const INVOCATION_CREDENTIAL = 'Bearer FIXTURE-invocation-credential';
const SESSION_COOKIES = ['CFID=FIXTURE-cfid; Path=/; HttpOnly', 'CFTOKEN=FIXTURE-cftoken; Path=/; HttpOnly'];

const CLOCK_START = Date.parse('2026-06-30T08:00:00');
const POLL = { timeoutMs: 3_000, intervalMs: 1_000 };
/** Delay after the note create at which the consumer's projection rows become visible. */
const DELIVERY_MS = 1_000;
/** How long a delivery attempt whose note read is blocked waits before the stub answers it 503. */
const BLOCKED_MS = 30_000;
/** Pub/Sub's wait after a nack before it redelivers. */
const RETRY_MS = 10_000;

const PERSON = 'A1B2C3D4-0001-0001-0001000000000001';
const PERSON_B = 'A1B2C3D4-0001-0001-0001000000000005';
const NOTE = 'C1B2C3D4-0003-0003-0003000000000001';
const NOTE_EVENT = '0b9f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4';
const NOTE_VERSION = 1;

/** Seeded accounts the gateway accepts, as `[site, role]`. */
const ACCOUNTS: readonly (readonly [string, string])[] = [
  [TENANT_A.siteId, 'system-user'],
  [TENANT_B.siteId, 'system-user'],
];

const SECRETS: SecretStore = {
  username: (site, role) => `FIXTURE-${site}-${role}`,
  secret: (name) => `FIXTURE-password-${name}`,
  values: () => [],
};

interface UnitTable {
  unit: string;
  legacyTable: string;
  key: string;
  columns: CanonicalColumn[];
}

function columns(...specs: (readonly [string, CanonicalType])[]): CanonicalColumn[] {
  return specs.map(([name, type]) => ({ name, type }));
}

const SITE: UnitTable = {
  unit: 'programs_sites.site',
  legacyTable: 'tsettings',
  key: 'SiteID',
  columns: columns(['SiteID', 's'], ['publicUserPoolID', 's'], ['privateUserPoolID', 's']),
};
const NOTE_PROJECTION: UnitTable = {
  unit: NOTE_PROJECTION_UNIT,
  legacyTable: 'note_projection',
  key: 'note_id',
  columns: columns(['note_id', 's'], ['aggregate_version', 'i'], ['apply_count', 'i'], ['last_event_id', 's']),
};
const PERSON_ARCHIVE: UnitTable = {
  unit: 'people.person_archive',
  legacyTable: 'person_archive',
  key: 'archive_id',
  columns: columns(['archive_id', 's'], ['person_id', 's'], ['siteID', 's'], ['effective_from', 't']),
};
const PERSON_TABLE: UnitTable = {
  unit: 'people.person',
  legacyTable: 'tusers',
  key: 'UserID',
  columns: columns(['UserID', 's'], ['SiteID', 's']),
};

/** One unit's rows on an export page, encoded by the migration kit. */
function exportTable(table: UnitTable, rows: readonly Row[]): ExportTable {
  return {
    unit: table.unit,
    legacyTable: table.legacyTable,
    targetTable: table.unit,
    keyless: false,
    columns: table.columns,
    rows: rows.map((row) => {
      const encoded = encodeRow(table.columns, row);
      return { key: encodeKey(table.columns, [table.key], row), row: encoded, hash: sha256Hex(encoded) };
    }),
  };
}

function exportPage(unit: string, tenantId: string, tables: ExportTable[], next: string | null = null): ExportResponse {
  return { unit, tenantId, tables, next };
}

/** One request the fake fetch received; header names as the session sent them (lower-cased). */
interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

interface Route {
  method: 'GET' | 'POST';
  /** Matched against the request's origin and path, without its query. */
  url: RegExp;
  reply: (request: RecordedRequest, match: RegExpExecArray) => Response;
}

/** Fetch answering the first matching route and 404 otherwise, recording every request. */
function fakeFetch(routes: readonly Route[]): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const raw = init.body;
    const body = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : undefined;
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body,
    };
    requests.push(request);
    const target = `${url.origin}${url.pathname}`;
    for (const route of routes) {
      const match = route.method === request.method ? route.url.exec(target) : null;
      if (match !== null) return route.reply(request, match);
    }
    return new Response(`no fake route for ${request.method} ${target}`, { status: 404 });
  };
  return { fetch, requests };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Route pattern of `origin` plus `pathPattern`, a regular-expression source. */
function at(origin: string, pathPattern: string): RegExp {
  return new RegExp(`^${escapeRegExp(origin)}${pathPattern}$`);
}

function cookieHeaders(setCookie: readonly string[]): [string, string][] {
  return setCookie.map((line) => ['set-cookie', line]);
}

function json(body: unknown, status = 200, setCookie: readonly string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: [['content-type', 'application/json; charset=utf-8'], ...cookieHeaders(setCookie)],
  });
}

function html(markup: string, setCookie: readonly string[] = []): Response {
  return new Response(`<!DOCTYPE html><html><body>${markup}</body></html>`, {
    headers: [['content-type', 'text/html; charset=utf-8'], ...cookieHeaders(setCookie)],
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** Owner export route answering 401 without an invocation credential, else the tables `tables` gives. */
function exportRoute(origin: string, tables: (unit: string, tenantId: string) => ExportTable[]): Route {
  return {
    method: 'GET',
    url: at(origin, escapeRegExp(EXPORT_PATH)),
    reply: (request) => {
      if (request.headers[INVOCATION_HEADER] === undefined) return json({ error: 'unauthenticated' }, 401);
      const unit = request.url.searchParams.get('unit') ?? '';
      const tenantId = request.url.searchParams.get('tenantId') ?? '';
      return json(exportPage(unit, tenantId, tables(unit, tenantId)));
    },
  };
}

const ADMIN_LOGIN_FORM = `
<form novalidate="novalidate" id="loginForm" name="frmLogin" method="post" action="index.cfm">
  <input id="username" name="username" type="text">
  <input id="password" type="password" name="password">
  <input type="hidden" name="muraAction" value="cLogin.login">
  <input type="hidden" name="isAdminLogin" value="true">
  <input type="hidden" name="${CSRF_FIELD_TOKEN}" value="FIXTURE-csrf-login">
  <input type="hidden" name="${CSRF_FIELD_EXPIRES}" value="${CSRF_EXPIRES}">
</form>`;

/** Programs-sites site rows of the three fixture tenants, pools as registryPayloads() seeds them. */
function registryRows(): Row[] {
  return registryPayloads().map((site) => ({
    SiteID: site.siteId,
    publicUserPoolID: site.publicUserPoolId,
    privateUserPoolID: site.privateUserPoolId,
  }));
}

const SITE_IDS = registryPayloads().map((site) => site.siteId);

/** The fixture registry as the seam reads it. */
const REGISTRY: readonly RegistrySite[] = registryPayloads().map((site) => ({
  siteId: site.siteId,
  tenantId: tenantIdForSite(site.siteId),
  publicUserPoolId: site.publicUserPoolId ?? site.siteId,
  privateUserPoolId: site.privateUserPoolId ?? site.siteId,
}));

/** A projection row of the seam's note, applied `applyCount` times. */
function projection(applyCount: number, version = NOTE_VERSION): Row {
  return { note_id: NOTE.toLowerCase(), aggregate_version: version, apply_count: applyCount, last_event_id: NOTE_EVENT.toUpperCase() };
}

/** The correct effect of a tenant-a note: one projection in tenant-a, its own tenant, and none elsewhere. */
const NOTE_EFFECT: Readonly<Record<string, readonly Row[]>> = { [TENANT_A.tenantId]: [projection(1)] };

/** The pooled note's tenants: umbrella stores it, and tenant-a, whose public user pool umbrella is, receives its fan-out. */
const POOLED = { origin: TENANT_UMBRELLA.tenantId, fanout: [TENANT_A.tenantId] } as const;
const POOLED_RECEIPTS = [TENANT_A.tenantId, TENANT_UMBRELLA.tenantId].map((tenantId) => tenantId.toLowerCase()).sort();

/** How the scripted stub consumer departs from the platform consumer when it applies a pooled note's deliveries. */
interface ConsumerOptions {
  /** The note's tenant applies while `stub.note` reads are blocked. */
  ignoresReadBlock?: boolean;
  /** A redelivery applies again in a tenant that holds a receipt. */
  ignoresReceipts?: boolean;
  /** A failed attempt writes no completion line. */
  silentFailures?: boolean;
  /** The note's event is never delivered. */
  undelivered?: boolean;
  /** Tenants outside the destinations the note's tenant's apply also writes a projection and a receipt in. */
  leaksTo?: readonly string[];
}

interface StackOptions {
  /** Projection rows of the note the consumer writes per tenant, {@link DELIVERY_MS} after the create. */
  effect?: Readonly<Record<string, readonly Row[]>>;
  /** A consumer applying a pooled note per the stub's gates and receipts, in place of `effect`. */
  consumer?: ConsumerOptions;
  /** Gates other than open, unheld and quiet before the seam. */
  gates?: Readonly<Record<string, UnitGate>>;
  /** Answer of the stub's migration position instead of its receipts. */
  positionAnswer?: () => Response;
  /** Gate requests the stub answers 409 instead of applying. */
  refuseGate?: (request: GateRequest) => boolean;
  /** Answer of the notes route instead of saving. */
  createRefusal?: () => Response;
  refuseLogins?: boolean;
}

interface SeamStack {
  deps: SeamDeps;
  requests: RecordedRequest[];
  sleeps: number[];
  /** Callee of every invocation credential minted, in order. */
  callees: string[];
  /** The stub's push answers to the scripted consumer's deliveries, on the stack's clock. */
  log: DeliveryLog;
  /** Every gate request the stub received, refused ones included, in order. */
  gateCalls: GateRequest[];
  /** The stub's gates now. */
  gates(): UnitGate[];
  /** Fake ms since the stack started. */
  elapsed(): number;
}

let stateRoot: string;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(os.tmpdir(), 'opt2-seams-'));
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

/** Harness invoker whose minter returns a placeholder credential and records each callee. */
async function stubInvoker(callees: string[] = []): Promise<HarnessInvoker> {
  return createHarnessInvoker({
    caller: 'migration',
    env: { OPT2_STATE_DIR: stateRoot },
    minterFactory: () => ({
      async headersFor({ name }) {
        callees.push(name);
        return { [INVOCATION_HEADER]: INVOCATION_CREDENTIAL };
      },
    }),
  });
}

/** Gateway, stub notes route, owner exports and a clock that only `sleep` advances. */
async function seamStack(options: StackOptions = {}): Promise<SeamStack> {
  let now = CLOCK_START;
  const sleeps: number[] = [];
  const callees: string[] = [];
  const delivered: { tenantId: string; at: number; row: Row }[] = [];
  const consumer = scriptedConsumer(options, () => now);
  const accounts = new Map(
    ACCOUNTS.map(([site, role]) => {
      const username = SECRETS.username(site, role);
      return [username, SECRETS.secret(`seed:${username}`)];
    }),
  );
  const accepts = (form: URLSearchParams): boolean =>
    options.refuseLogins !== true && accounts.get(form.get('username') ?? '') === form.get('password');
  const inSession = (request: RecordedRequest): boolean => (request.headers.cookie ?? '').includes('CFID=');

  const { fetch, requests } = fakeFetch([
    {
      method: 'GET',
      url: at(GATEWAY, '/admin/'),
      reply: (request) =>
        request.url.searchParams.get('muraAction') === 'clogin.main'
          ? html(ADMIN_LOGIN_FORM, inSession(request) ? [] : SESSION_COOKIES)
          : html('<h1>Masa CMS - Site Content</h1>'),
    },
    {
      method: 'POST',
      url: at(GATEWAY, '/admin/index\\.cfm'),
      reply: (request) => {
        const form = new URLSearchParams(request.body);
        const valid = accepts(form) && form.get(CSRF_FIELD_TOKEN) === 'FIXTURE-csrf-login';
        return redirect(valid ? './' : './?muraAction=clogin.main');
      },
    },
    {
      method: 'POST',
      url: at(GATEWAY, escapeRegExp(NOTES_PATH)),
      reply: (request) => {
        if (!inSession(request)) return json({ error: { message: 'Insufficient Permissions' } }, 401);
        if (options.createRefusal !== undefined) return options.createRefusal();
        if (options.consumer === undefined) {
          for (const [tenantId, rows] of Object.entries(options.effect ?? NOTE_EFFECT)) {
            for (const row of rows) delivered.push({ tenantId, at: now + DELIVERY_MS, row });
          }
        } else {
          consumer.publish(now + DELIVERY_MS);
        }
        const { title, body } = JSON.parse(request.body ?? '{}') as { title: string; body: string };
        const data = { noteid: NOTE, title, body, created: '2026-06-30 08:00:00.000', rowversion: String(NOTE_VERSION) };
        return json({ apiversion: 'v1', method: 'save', params: {}, data });
      },
    },
    exportRoute(SITES_URL, (unit, tenantId) =>
      unit === SITE.unit ? [exportTable(SITE, registryRows().filter((row) => tenantIdForSite(String(row.SiteID)) === tenantId))] : [],
    ),
    exportRoute(STUB_URL, (unit, tenantId) =>
      unit === NOTE_PROJECTION.unit
        ? [
            exportTable(NOTE_PROJECTION, [
              ...delivered.filter((entry) => entry.tenantId === tenantId && entry.at <= now).map((entry) => entry.row),
              ...consumer.projectionsIn(tenantId),
            ]),
          ]
        : [],
    ),
    {
      method: 'POST',
      url: at(STUB_URL, escapeRegExp(GATE_PATH)),
      reply: (request) => {
        if (request.headers[INVOCATION_HEADER] === undefined) return json({ error: 'unauthenticated' }, 401);
        const body = JSON.parse(request.body ?? '{}') as GateRequest;
        consumer.gateCalls.push(body);
        if (options.refuseGate?.(body) === true) return json({ error: 'gate-conflict', units: body.units }, 409);
        return consumer.gate(body);
      },
    },
    {
      method: 'GET',
      url: at(STUB_URL, escapeRegExp(POSITION_PATH)),
      reply: (request) => {
        if (request.headers[INVOCATION_HEADER] === undefined) return json({ error: 'unauthenticated' }, 401);
        if (options.positionAnswer !== undefined) return options.positionAnswer();
        const eventId = request.url.searchParams.get('eventIds') ?? '';
        return json({ outbox: { unpublished: 0 }, inbox: { bySubscription: {}, receipts: consumer.receipts(eventId) } });
      },
    },
  ]);

  return {
    deps: {
      env: { OPT2_GATEWAY_URL: GATEWAY, OPT2_STATE_DIR: stateRoot },
      fetch,
      invoker: await stubInvoker(callees),
      secrets: SECRETS,
      serviceUrls: SERVICE_URLS,
      siteIds: SITE_IDS,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      poll: POLL,
    },
    requests,
    sleeps,
    callees,
    log: consumer.log,
    gateCalls: consumer.gateCalls,
    gates: () => consumer.gateRows(),
    elapsed: () => now - CLOCK_START,
  };
}

/**
 * The stub's gates and a consumer of one pooled umbrella note, evaluated lazily on the stack's clock. Each attempt
 * applies the fan-out tenants first and the note's tenant last, each once per receipt: it waits {@link BLOCKED_MS} and
 * answers 503 while the projection gate is closed or, at the note's tenant, while `stub.note` is in an executing phase;
 * Pub/Sub redelivers {@link RETRY_MS} after a 503.
 */
function scriptedConsumer(options: StackOptions, clock: () => number) {
  const script = options.consumer ?? {};
  const gates = new Map<string, UnitGate>(
    [NOTE_UNIT, NOTE_PROJECTION_UNIT].map((unit) => [
      unit,
      options.gates?.[unit] ?? { unit, state: 'open', holderId: null, phase: 'quiet' },
    ]),
  );
  const gateCalls: GateRequest[] = [];
  const held = new Set<string>();
  const rows = new Map<string, Row>();
  const answers: { at: number; answer: DeliveryAnswer }[] = [];
  let pending: { at: number; done: boolean } | undefined;

  const applyIn = (tenantId: string): void => {
    if (held.has(tenantId) && script.ignoresReceipts !== true) return;
    held.add(tenantId);
    const row = rows.get(tenantId);
    rows.set(tenantId, row === undefined ? projection(1) : { ...row, apply_count: Number(row.apply_count) + 1 });
  };
  const fail = (attempt: { at: number }, at: number): void => {
    if (script.silentFailures !== true) answers.push({ at, answer: { statusCode: 503, latencyMs: BLOCKED_MS } });
    attempt.at = at + RETRY_MS;
  };
  const advance = (): void => {
    while (pending !== undefined && !pending.done && pending.at <= clock()) {
      const startedAt = pending.at;
      if (gates.get(NOTE_PROJECTION_UNIT)?.state !== 'open') {
        fail(pending, startedAt + BLOCKED_MS);
        continue;
      }
      for (const tenantId of POOLED.fanout) applyIn(tenantId);
      if (gates.get(NOTE_UNIT)?.phase === 'executing' && script.ignoresReadBlock !== true) {
        fail(pending, startedAt + BLOCKED_MS);
        continue;
      }
      applyIn(POOLED.origin);
      for (const tenantId of script.leaksTo ?? []) {
        rows.set(tenantId, projection(1));
        held.add(tenantId);
      }
      answers.push({ at: startedAt, answer: { statusCode: 204, latencyMs: 12 } });
      pending.done = true;
    }
  };
  const visible = (): DeliveryAnswer[] => {
    advance();
    return answers.filter((entry) => entry.at <= clock()).map((entry) => entry.answer);
  };
  const gateRows = (units: readonly string[] = [...gates.keys()]): UnitGate[] =>
    units.flatMap((unit) => {
      const gate = gates.get(unit);
      return gate === undefined ? [] : [{ ...gate }];
    });

  return {
    publish(at: number): void {
      if (script.undelivered !== true) pending = { at, done: false };
    },
    projectionsIn(tenantId: string): Row[] {
      advance();
      const row = rows.get(tenantId);
      return row === undefined ? [] : [row];
    },
    receipts(eventId: string): Record<string, string[]> {
      advance();
      return eventId === NOTE_EVENT && held.size > 0 ? { [NOTE_EVENT]: [...held] } : {};
    },
    gate(body: GateRequest): Response {
      advance();
      const units = body.units ?? [...gates.keys()];
      if (body.op === 'status') return json({ units: gateRows(units) });
      if (body.op === 'close') {
        const refused = units.filter((unit) => {
          const gate = gates.get(unit);
          return gate === undefined || (gate.state === 'closed' ? gate.holderId !== body.holderId : gate.state !== 'open');
        });
        if (refused.length > 0) return json({ error: 'gate-conflict', units: refused }, 409);
        for (const unit of units) gates.set(unit, { unit, state: 'closed', holderId: body.holderId, phase: body.phase ?? 'quiet' });
        return json({ units: gateRows(units) });
      }
      if (body.op === 'open') {
        const state = body.state ?? 'open';
        for (const unit of units) {
          if (gates.get(unit)?.holderId === body.holderId) gates.set(unit, { unit, state, holderId: null, phase: 'quiet' });
        }
        const refused = gateRows(units).filter((gate) => gate.holderId !== null || gate.state !== state);
        if (refused.length > 0) return json({ error: 'gate-conflict', units: refused.map((gate) => gate.unit) }, 409);
        return json({ units: gateRows(units) });
      }
      return json({ error: 'invalidParameters' }, 400);
    },
    gateCalls,
    gateRows: () => gateRows(),
    log: {
      mark: () => ({ stub: visible().length }),
      answers: (eventId: string, from: Readonly<Record<string, number>>) =>
        eventId === NOTE_EVENT ? visible().slice(from.stub ?? 0) : [],
    } satisfies DeliveryLog,
  };
}

function posts(stack: SeamStack, suffix: string): RecordedRequest[] {
  return stack.requests.filter((request) => request.method === 'POST' && request.url.pathname.endsWith(suffix));
}

function exportRequests(stack: SeamStack): RecordedRequest[] {
  return stack.requests.filter((request) => request.url.pathname === EXPORT_PATH);
}

describe('runNoteSeam', () => {
  it('creates a tenant-a note once through the gateway and finds its projection applied once in tenant-a alone', async () => {
    const stack = await seamStack();

    const { passed, evidence } = await runNoteSeam(stack.deps);

    expect(passed).toBe(true);
    expect(evidence).toMatchObject({
      siteId: DEFAULT_SEAM_SITE,
      pool: null,
      noteSiteId: DEFAULT_SEAM_SITE,
      noteId: NOTE,
      rowVersion: NOTE_VERSION,
      create: { status: 200, body: { method: 'save', data: { noteid: NOTE } } },
      fanout: 'userPool',
      polls: 2,
      elapsedMs: DELIVERY_MS,
      timedOut: false,
    });
    expect(evidence.destinations).toEqual([
      {
        siteId: TENANT_A.siteId,
        tenantId: TENANT_A.tenantId,
        reason: 'origin-tenant',
        projections: [{ applyCount: 1, aggregateVersion: NOTE_VERSION, lastEventId: NOTE_EVENT }],
      },
    ]);
    expect(evidence.otherTenants).toEqual([
      { siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId, projectionRows: 0 },
      { siteId: TENANT_UMBRELLA.siteId, tenantId: TENANT_UMBRELLA.tenantId, projectionRows: 0 },
    ]);
    expect(stack.sleeps).toEqual([DELIVERY_MS]);

    const creates = posts(stack, NOTES_PATH);
    expect(creates).toHaveLength(1);
    const [create] = creates;
    expect(create?.url.origin).toBe(GATEWAY);
    expect(create?.url.searchParams.get('siteid')).toBe(TENANT_A.siteId);
    expect(JSON.parse(create?.body ?? 'null')).toEqual({ title: `Note seam ${evidence.traceId}`, body: 'Event seam evidence.' });
    expect(create?.headers.traceparent).toMatch(TRACEPARENT);
    expect(create?.headers.traceparent?.split('-')[1]).toBe(evidence.traceId);

    const login = posts(stack, '/admin/index.cfm');
    expect(new URLSearchParams(login[0]?.body).get('username')).toBe(SECRETS.username(TENANT_A.siteId, 'system-user'));
    const exports = exportRequests(stack);
    expect(exports.map((request) => request.headers[INVOCATION_HEADER])).toEqual(exports.map(() => INVOCATION_CREDENTIAL));
    expect(exports.filter((request) => request.headers.authorization !== undefined)).toEqual([]);
    expect(stack.callees).toEqual(exports.map((request) => SERVICE_BY_ORIGIN[request.url.origin]));
    expect(evidence).not.toHaveProperty('interruption');
    expect(stack.gateCalls).toEqual([]);
  });

  it('creates a pooled note in umbrella and finds it applied once there and in tenant-a, whose public user pool it is', async () => {
    const stack = await seamStack({ effect: { [TENANT_UMBRELLA.tenantId]: [projection(1)], [TENANT_A.tenantId]: [projection(1)] } });

    const { passed, evidence } = await runNoteSeam({ ...stack.deps, pool: 'public' });

    expect(passed).toBe(true);
    expect(evidence).toMatchObject({ siteId: TENANT_A.siteId, pool: 'public', noteSiteId: TENANT_UMBRELLA.siteId, polls: 2 });
    expect(evidence.destinations.map(({ siteId, reason, projections }) => [siteId, reason, projections.length])).toEqual([
      [TENANT_UMBRELLA.siteId, 'origin-tenant', 1],
      [TENANT_A.siteId, 'userPool', 1],
    ]);
    expect(evidence.otherTenants).toEqual([{ siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId, projectionRows: 0 }]);
    const [create] = posts(stack, NOTES_PATH);
    expect(create?.url.searchParams.get('siteid')).toBe(TENANT_A.siteId);
    expect(JSON.parse(create?.body ?? 'null')).toEqual({ title: `Note seam ${evidence.traceId}`, body: 'Event seam evidence.', pool: 'public' });
    expect(stack.gateCalls).toEqual([]);
  });

  it.each([
    {
      title: 'fails naming tenant-b when a projection lands there outside the destinations',
      effect: { ...NOTE_EFFECT, [TENANT_B.tenantId]: [projection(1)] },
      projections: [[{ applyCount: 1, aggregateVersion: NOTE_VERSION, lastEventId: NOTE_EVENT }]],
      tenantBRows: 1,
      polls: 2,
      timedOut: false,
    },
    {
      title: 'fails once the poll budget runs out when the delivery never reaches tenant-a',
      effect: {},
      projections: [[]],
      tenantBRows: 0,
      polls: 4,
      timedOut: true,
    },
    {
      title: 'fails without waiting out the budget when the note is applied twice',
      effect: { [TENANT_A.tenantId]: [projection(2)] },
      projections: [[{ applyCount: 2, aggregateVersion: NOTE_VERSION, lastEventId: NOTE_EVENT }]],
      tenantBRows: 0,
      polls: 2,
      timedOut: false,
    },
  ])('$title', async ({ effect, projections, tenantBRows, polls, timedOut }) => {
    const stack = await seamStack({ effect });

    const { passed, evidence } = await runNoteSeam(stack.deps);

    expect(passed).toBe(false);
    expect(evidence.destinations.map((destination) => destination.projections)).toEqual(projections);
    expect(evidence.otherTenants.find((tenant) => tenant.tenantId === TENANT_B.tenantId)?.projectionRows).toBe(tenantBRows);
    expect(evidence).toMatchObject({ polls, timedOut, elapsedMs: (polls - 1) * POLL.intervalMs });
    expect(posts(stack, NOTES_PATH)).toHaveLength(1);
  });

  it('creates a tenant-b note as tenant-b’s system user when the seam is given that site', async () => {
    const stack = await seamStack({ effect: { [TENANT_B.tenantId]: [projection(1)] } });

    const { passed, evidence } = await runNoteSeam({ ...stack.deps, siteId: TENANT_B.siteId });

    expect(passed).toBe(true);
    expect(evidence.destinations.map(({ siteId, reason }) => [siteId, reason])).toEqual([[TENANT_B.siteId, 'origin-tenant']]);
    expect(evidence.otherTenants.map((tenant) => tenant.siteId)).toEqual([TENANT_A.siteId, TENANT_UMBRELLA.siteId]);
    const [create] = posts(stack, NOTES_PATH);
    expect(create?.url.searchParams.get('siteid')).toBe(TENANT_B.siteId);
    const login = posts(stack, '/admin/index.cfm');
    expect(new URLSearchParams(login[0]?.body).get('username')).toBe(SECRETS.username(TENANT_B.siteId, 'system-user'));
  });

  it.each([
    {
      title: 'a JSON 403',
      refusal: () => json({ error: { message: 'Insufficient Permissions' } }, 403),
      create: { status: 403, body: { error: { message: 'Insufficient Permissions' } } },
    },
    {
      title: 'a plain-text 503',
      refusal: () => new Response('stub unavailable', { status: 503 }),
      create: { status: 503, body: 'stub unavailable' },
    },
    {
      title: 'a save envelope without a note',
      refusal: () => json({ apiversion: 'v1', method: 'save', data: {} }),
      create: { status: 200, body: { apiversion: 'v1', method: 'save', data: {} } },
    },
  ])('fails without reading projections when the gateway answers the create with $title', async ({ refusal, create }) => {
    const stack = await seamStack({ createRefusal: refusal });

    const { passed, evidence } = await runNoteSeam(stack.deps);

    expect(passed).toBe(false);
    expect(evidence.create).toEqual(create);
    expect(evidence).toMatchObject({ polls: 0, timedOut: false, otherTenants: [] });
    const createAt = stack.requests.findIndex((request) => request.url.pathname === NOTES_PATH);
    expect(stack.requests.slice(createAt + 1)).toEqual([]);
    expect(stack.sleeps).toEqual([]);
  });

  it('rejects before creating when the gateway refuses the seeded system user', async () => {
    const stack = await seamStack({ refuseLogins: true });
    const username = SECRETS.username(TENANT_A.siteId, 'system-user');

    await expect(runNoteSeam(stack.deps)).rejects.toThrow(`admin login as ${username} through the gateway failed (status 200)`);
    expect(posts(stack, NOTES_PATH)).toEqual([]);
  });

  it('rejects without a request to the gateway for a site the registry does not hold', async () => {
    const stack = await seamStack();

    await expect(runNoteSeam({ ...stack.deps, siteId: 'tenant-z' })).rejects.toThrow('the site registry holds no tenant-z');
    expect(stack.requests.filter((request) => request.url.origin === GATEWAY)).toEqual([]);
  });

  it.each([
    {
      title: 'a pooled note of a site the registry does not hold',
      options: { siteId: 'tenant-z', pool: 'public' as const },
      message: 'the site registry holds no tenant-z',
    },
    {
      title: 'an interrupted note without a user-pool fan-out destination',
      options: { interrupt: true },
      message: `a note of ${TENANT_A.siteId} has no user-pool fan-out destination, so its delivery cannot be interrupted between destinations`,
    },
  ])('rejects without a request to the gateway or a gate change for $title', async ({ options, message }) => {
    const stack = await seamStack();

    await expect(runNoteSeam({ ...stack.deps, ...options })).rejects.toThrow(message);
    expect(stack.requests.filter((request) => request.url.origin === GATEWAY)).toEqual([]);
    expect(stack.gateCalls).toEqual([]);
  });
});

/** The seam's gate requests for a holder, as `[op, units, phase or state]`. */
function gateSteps(stack: SeamStack): [string, readonly string[] | undefined, string | undefined][] {
  return stack.gateCalls.map((call) => [
    call.op,
    call.units,
    call.op === 'close' ? call.phase : call.op === 'open' ? call.state : undefined,
  ]);
}

const OPEN_GATES: UnitGate[] = [NOTE_UNIT, NOTE_PROJECTION_UNIT].map((unit) => ({ unit, state: 'open', holderId: null, phase: 'quiet' }));
const GATED = [NOTE_UNIT, NOTE_PROJECTION_UNIT];
const STEPS_TO_FANOUT: ReturnType<typeof gateSteps> = [
  ['status', GATED, undefined],
  ['close', [NOTE_PROJECTION_UNIT], undefined],
  ['close', [NOTE_UNIT], 'executing'],
  ['open', [NOTE_PROJECTION_UNIT], 'open'],
];
const RESTORE: ReturnType<typeof gateSteps>[number] = ['open', GATED, 'open'];
const PROJECTED = [{ applyCount: 1, aggregateVersion: NOTE_VERSION, lastEventId: NOTE_EVENT }];
const INTERRUPTED: Pick<NoteSeamOptions, 'pool' | 'interrupt'> = { pool: 'public', interrupt: true };

describe('runNoteSeam with an interrupted pooled delivery', () => {
  it('sees tenant-a apply and the note tenant answer 503 before umbrella applies the redelivery, once per destination', async () => {
    const stack = await seamStack({ consumer: {} });

    const { passed, evidence } = await runNoteSeam({ ...stack.deps, ...INTERRUPTED, deliveryLog: stack.log });

    expect(evidence.interruption?.problems).toEqual([]);
    expect(passed).toBe(true);
    expect(evidence).toMatchObject({ pool: 'public', noteSiteId: TENANT_UMBRELLA.siteId, timedOut: false, polls: 6, elapsedMs: 10_000 });
    expect(evidence.destinations.map(({ siteId, reason, projections }) => [siteId, reason, projections])).toEqual([
      [TENANT_UMBRELLA.siteId, 'origin-tenant', PROJECTED],
      [TENANT_A.siteId, 'userPool', PROJECTED],
    ]);
    expect(evidence.otherTenants).toEqual([{ siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId, projectionRows: 0 }]);
    expect(evidence.interruption).toMatchObject({
      holderId: `note-seam-${evidence.traceId}`,
      gatesBefore: OPEN_GATES,
      gatesAfter: OPEN_GATES,
      eventId: NOTE_EVENT,
      fanoutApplied: {
        polls: 2,
        timedOut: false,
        state: { projections: { [TENANT_UMBRELLA.siteId]: [], [TENANT_A.siteId]: PROJECTED }, receipts: [TENANT_A.tenantId] },
      },
      interruptedAnswers: { polls: 16, elapsedMs: BLOCKED_MS, timedOut: false, answers: [{ statusCode: 503, latencyMs: BLOCKED_MS }] },
      betweenAttempts: { projections: { [TENANT_UMBRELLA.siteId]: [], [TENANT_A.siteId]: PROJECTED }, receipts: [TENANT_A.tenantId] },
      recovered: {
        timedOut: false,
        state: { projections: { [TENANT_UMBRELLA.siteId]: PROJECTED, [TENANT_A.siteId]: PROJECTED }, receipts: POOLED_RECEIPTS },
      },
      answers: [
        { statusCode: 503, latencyMs: BLOCKED_MS },
        { statusCode: 204, latencyMs: 12 },
      ],
    });
    expect(gateSteps(stack)).toEqual([...STEPS_TO_FANOUT, ['open', [NOTE_UNIT], 'open'], RESTORE]);
    expect(stack.gateCalls.every((call) => call.op === 'status' || call.holderId === evidence.interruption?.holderId)).toBe(true);
    expect(stack.gates()).toEqual(OPEN_GATES);
    expect(stack.elapsed()).toBeLessThanOrEqual(3 * DEFAULT_REDELIVERY_POLL.timeoutMs);

    const stubCalls = stack.requests.filter((request) => request.url.origin === STUB_URL);
    expect(stubCalls.map((request) => request.headers[INVOCATION_HEADER])).toEqual(stubCalls.map(() => INVOCATION_CREDENTIAL));
    const positions = stack.requests.filter((request) => request.url.pathname === POSITION_PATH);
    expect(new Set(positions.map((request) => request.url.searchParams.get('eventIds')))).toEqual(new Set([NOTE_EVENT]));
    const [create] = posts(stack, NOTES_PATH);
    expect(JSON.parse(create?.body ?? 'null')).toMatchObject({ pool: 'public' });
  });

  it.each([
    {
      title: 'umbrella applying the first delivery while its note reads are blocked',
      consumer: { ignoresReadBlock: true },
      problems: [`${TENANT_UMBRELLA.siteId} applied the first delivery although its note reads were blocked`],
      steps: [...STEPS_TO_FANOUT, RESTORE],
    },
    {
      title: 'no logged answer to the interrupted delivery',
      consumer: { silentFailures: true },
      problems: ['the stub logged no non-2xx answer to the interrupted delivery within 10000 ms'],
      steps: [...STEPS_TO_FANOUT, RESTORE],
      redeliveryPoll: { timeoutMs: 10_000, intervalMs: 2_000 },
    },
    {
      title: 'a redelivery applying tenant-a again despite its receipt',
      consumer: { ignoresReceipts: true },
      problems: [
        `${TENANT_A.siteId} holds ${JSON.stringify([{ ...PROJECTED[0], applyCount: 2 }])}, not event ${NOTE_EVENT} applied once`,
      ],
      steps: [...STEPS_TO_FANOUT, ['open', [NOTE_UNIT], 'open'], RESTORE],
    },
    {
      title: 'a projection and a receipt in tenant-b, outside the destinations',
      consumer: { leaksTo: [TENANT_B.tenantId] },
      problems: [
        `receipts of ${NOTE_EVENT} are in ${JSON.stringify([...POOLED_RECEIPTS, TENANT_B.tenantId].sort())}, not exactly ${JSON.stringify(POOLED_RECEIPTS)}`,
        `${TENANT_B.siteId}, outside the destinations, holds 1 projection rows`,
      ],
      steps: [...STEPS_TO_FANOUT, ['open', [NOTE_UNIT], 'open'], RESTORE],
    },
    {
      title: 'a delivery that never reaches tenant-a',
      consumer: { undelivered: true },
      problems: ['no fan-out destination applied the first delivery within 10000 ms', `${TENANT_A.siteId} did not apply the first delivery once`],
      steps: [...STEPS_TO_FANOUT, RESTORE],
      redeliveryPoll: { timeoutMs: 10_000, intervalMs: 2_000 },
    },
  ] satisfies {
    title: string;
    consumer: ConsumerOptions;
    problems: string[];
    steps: ReturnType<typeof gateSteps>;
    redeliveryPoll?: NoteSeamOptions['redeliveryPoll'];
  }[])('fails on $title and reopens every gate', async ({ consumer, problems, steps, redeliveryPoll }) => {
    const stack = await seamStack({ consumer });

    const { passed, evidence } = await runNoteSeam({ ...stack.deps, ...INTERRUPTED, deliveryLog: stack.log, redeliveryPoll });

    expect(passed).toBe(false);
    expect(evidence.interruption?.problems).toEqual(problems);
    expect(gateSteps(stack)).toEqual(steps);
    expect(evidence.interruption?.gatesAfter).toEqual(OPEN_GATES);
    expect(stack.gates()).toEqual(OPEN_GATES);
  });

  it('fails without reading projections when the create is refused, and reopens the projection gate', async () => {
    const stack = await seamStack({ consumer: {}, createRefusal: () => json({ error: { message: 'Insufficient Permissions' } }, 403) });

    const { passed, evidence } = await runNoteSeam({ ...stack.deps, ...INTERRUPTED, deliveryLog: stack.log });

    expect(passed).toBe(false);
    expect(evidence.interruption?.problems).toEqual(['the note create answered 403 without a saved note']);
    expect(gateSteps(stack)).toEqual([STEPS_TO_FANOUT[0], STEPS_TO_FANOUT[1], RESTORE]);
    expect(exportRequests(stack).filter((request) => request.url.origin === STUB_URL)).toEqual([]);
    expect(stack.gates()).toEqual(OPEN_GATES);
  });

  it('fails when the gates do not reopen after an otherwise passing seam', async () => {
    const stack = await seamStack({ consumer: {}, refuseGate: (request) => request.op === 'open' && request.units.length === 2 });

    const { passed, evidence } = await runNoteSeam({ ...stack.deps, ...INTERRUPTED, deliveryLog: stack.log });

    expect(passed).toBe(false);
    expect(evidence.interruption?.problems).toEqual([
      `the stub gates did not reopen: stub gate open of ${GATED.join(', ')} answered 409: ${JSON.stringify({ error: 'gate-conflict', units: GATED })}`,
    ]);
  });

  it('rejects without closing a gate or creating a note when a gate is held before the seam', async () => {
    const held: UnitGate = { unit: NOTE_UNIT, state: 'closed', holderId: 'window-1', phase: 'executing' };
    const stack = await seamStack({ consumer: {}, gates: { [NOTE_UNIT]: held } });

    await expect(runNoteSeam({ ...stack.deps, ...INTERRUPTED, deliveryLog: stack.log })).rejects.toThrow(
      `the stub gates of ${GATED.join(', ')} must be open, unheld and quiet before the seam`,
    );
    expect(gateSteps(stack)).toEqual([STEPS_TO_FANOUT[0]]);
    expect(posts(stack, NOTES_PATH)).toEqual([]);
    expect(stack.gates()).toEqual([held, OPEN_GATES[1]]);
  });

  it.each([
    {
      title: 'the position answers 500',
      positionAnswer: () => new Response('position unavailable', { status: 500 }),
      refuseRestore: false,
      message: 'stub migration position answered 500: position unavailable',
    },
    {
      title: 'the position lacks its inbox',
      positionAnswer: () => json({ outbox: null, inbox: null }),
      refuseRestore: false,
      message: `stub migration position lacks its inbox: ${JSON.stringify({ outbox: null, inbox: null })}`,
    },
    {
      title: 'the position answers 500 and the gates do not reopen',
      positionAnswer: () => new Response('position unavailable', { status: 500 }),
      refuseRestore: true,
      message: `stub migration position answered 500: position unavailable; the stub gates did not reopen: stub gate open of ${GATED.join(', ')} answered 409`,
    },
  ])('rethrows when $title, after reopening the gates it closed', async ({ positionAnswer, refuseRestore, message }) => {
    const stack = await seamStack({
      consumer: {},
      positionAnswer,
      refuseGate: (request) => refuseRestore && request.op === 'open' && request.units.length === 2,
    });

    await expect(runNoteSeam({ ...stack.deps, ...INTERRUPTED, deliveryLog: stack.log })).rejects.toThrow(message);
    expect(gateSteps(stack)).toEqual([...STEPS_TO_FANOUT, RESTORE]);
    expect(stack.gates().map((gate) => gate.state)).toEqual(refuseRestore ? ['closed', 'open'] : ['open', 'open']);
  });
});

describe('stubDeliveryLog', () => {
  const completion = (fields: Row): string =>
    JSON.stringify({ severity: 'INFO', message: 'request completed', service: 'stub', route: NOTE_PUSH_ROUTE, eventId: NOTE_EVENT, ...fields });

  it('reads the stub log up.json records for completion lines of the note push route and the event, from a mark on', async () => {
    const env = { OPT2_STATE_DIR: stateRoot };
    const logFile = path.join(stateRoot, 'stub.log');
    writeUpState({ processes: { stub: { pid: 4242, cwd: stateRoot, command: 'node dist/main.js', log: 'stub.log' } } }, { env });
    const log = stubDeliveryLog(env);
    const start = log.mark();
    const lines = [
      completion({ statusCode: 503, latencyMs: 30_012, eventId: NOTE_EVENT.toUpperCase() }),
      'request completed, not JSON: a crash trace',
      completion({ message: 'request denied', statusCode: 401 }),
      completion({ route: '/internal/v1/events/stub.stub.note.commented.v1', statusCode: 503 }),
      completion({ eventId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', statusCode: 503 }),
      completion({ statusCode: '204' }),
      completion({ statusCode: 204 }),
    ];
    await appendFile(logFile, `${lines.join('\n')}\n`);

    expect(start).toEqual({ stub: 0 });
    expect(log.answers(NOTE_EVENT, start)).toEqual([
      { statusCode: 503, latencyMs: 30_012 },
      { statusCode: 204, latencyMs: null },
    ]);
    const later = log.mark();
    await appendFile(logFile, `${completion({ statusCode: 204, latencyMs: 9 })}\n`);
    expect(log.answers(NOTE_EVENT, later)).toEqual([{ statusCode: 204, latencyMs: 9 }]);
  });
});

describe('fanoutDestinations', () => {
  it.each([
    {
      title: 'a topic without fan-out reaches the origin tenant alone',
      siteId: TENANT_UMBRELLA.siteId,
      fanout: null,
      destinations: [[TENANT_UMBRELLA.siteId, 'origin-tenant']],
    },
    {
      title: 'a user-pool fan-out of umbrella adds tenant-a, whose public user pool it is',
      siteId: 'Umbrella',
      fanout: 'userPool' as const,
      destinations: [
        [TENANT_UMBRELLA.siteId, 'origin-tenant'],
        [TENANT_A.siteId, 'userPool'],
      ],
    },
    {
      title: 'a user-pool fan-out of tenant-b adds no tenant',
      siteId: TENANT_B.siteId,
      fanout: 'userPool' as const,
      destinations: [[TENANT_B.siteId, 'origin-tenant']],
    },
  ])('$title', ({ siteId, fanout, destinations }) => {
    const derived = fanoutDestinations(siteId, REGISTRY, fanout);

    expect(derived.map((destination) => [destination.siteId, destination.reason])).toEqual(destinations);
    expect(derived.map((destination) => destination.tenantId)).toEqual(
      destinations.map(([site]) => tenantIdForSite(site ?? '')),
    );
  });

  it('throws naming a site the registry does not hold', () => {
    expect(() => fanoutDestinations('tenant-z', REGISTRY, 'userPool')).toThrow('the site registry holds no tenant-z');
  });
});

describe('noteSeamFanout', () => {
  it('reads the stub note topic schema, which declares a user-pool fan-out', () => {
    expect(noteSeamFanout()).toBe('userPool');
  });
});

describe('unitFor', () => {
  it.each([
    ['programs_sites', 'site'],
    ['people', 'person_archive'],
  ])('names %s.%s as opt2/table-ownership.json assigns it', (schema, table) => {
    expect(unitFor(schema, table)).toBe(`${schema}.${table}`);
  });

  it('throws naming a unit the ownership file does not assign', () => {
    expect(() => unitFor('people', 'holiday')).toThrow('opt2/table-ownership.json assigns no unit people.holiday');
  });
});

describe('readOwnerExport', () => {
  const firstPage = [{ archive_id: 'ARC-1', person_id: PERSON, siteID: TENANT_A.siteId, effective_from: '2026-06-01T00:00:00' }];
  const secondPage = [{ archive_id: 'ARC-2', person_id: PERSON_B, siteID: TENANT_A.siteId, effective_from: null }];

  it('pages the export with a platform.migration credential alone and decodes the requested unit', async () => {
    await writeTestSecrets(stateRoot);
    const { fetch, requests } = fakeFetch([
      {
        method: 'GET',
        url: at(PEOPLE_URL, escapeRegExp(EXPORT_PATH)),
        reply: (request) =>
          request.url.searchParams.get('after') === null
            ? json(
                exportPage(
                  PERSON_ARCHIVE.unit,
                  TENANT_A.tenantId,
                  [exportTable(PERSON_ARCHIVE, firstPage), exportTable(PERSON_TABLE, [{ UserID: PERSON, SiteID: TENANT_A.siteId }])],
                  'FIXTURE-cursor-1',
                ),
              )
            : json(exportPage(PERSON_ARCHIVE.unit, TENANT_A.tenantId, [exportTable(PERSON_ARCHIVE, secondPage)])),
      },
    ]);

    const out = await readOwnerExport(
      { service: 'people', unit: PERSON_ARCHIVE.unit, tenantId: TENANT_A.tenantId },
      { env: { OPT2_STATE_DIR: stateRoot }, fetch, serviceUrls: SERVICE_URLS },
    );

    expect(out.columns).toEqual(PERSON_ARCHIVE.columns);
    expect(out.rows).toEqual([
      { archive_id: 'ARC-1', person_id: PERSON, siteID: TENANT_A.siteId, effective_from: '2026-06-01T00:00:00.000' },
      { archive_id: 'ARC-2', person_id: PERSON_B, siteID: TENANT_A.siteId, effective_from: null },
    ]);
    expect(out.entries).toEqual([...exportTable(PERSON_ARCHIVE, firstPage).rows, ...exportTable(PERSON_ARCHIVE, secondPage).rows]);
    const query = { unit: PERSON_ARCHIVE.unit, tenantId: TENANT_A.tenantId, limit: String(MAX_EXPORT_LIMIT) };
    expect(requests.map((request) => [request.url.origin, request.url.pathname, Object.fromEntries(request.url.searchParams)])).toEqual([
      [PEOPLE_URL, EXPORT_PATH, query],
      [PEOPLE_URL, EXPORT_PATH, { ...query, after: 'FIXTURE-cursor-1' }],
    ]);

    const { invocationVerifier } = testVerifier('people');
    for (const request of requests) {
      expect(Object.keys(request.headers)).toEqual([INVOCATION_HEADER]);
      const credential = request.headers[INVOCATION_HEADER] ?? '';
      expect(credential.startsWith('Bearer ')).toBe(true);
      const identity = await invocationVerifier.verify(credential);
      expect(identity).toEqual({ name: 'migration', roles: harnessCallerRoles('migration') });
      expect(identity.roles).toContain('platform.migration');
    }
  });

  it('leaves tenantId out of the query when the target names no tenant', async () => {
    const { fetch, requests } = fakeFetch([
      exportRoute(PEOPLE_URL, () => [exportTable(PERSON_ARCHIVE, firstPage)]),
    ]);

    const out = await readOwnerExport(
      { service: 'people', unit: PERSON_ARCHIVE.unit },
      { fetch, invoker: await stubInvoker(), serviceUrls: SERVICE_URLS },
    );

    expect(out.rows).toHaveLength(1);
    expect(requests.map((request) => request.url.searchParams.has('tenantId'))).toEqual([false]);
  });

  it('rejects with the owner status and body on a non-2xx answer', async () => {
    const { fetch } = fakeFetch([
      { method: 'GET', url: at(STUB_URL, escapeRegExp(EXPORT_PATH)), reply: () => new Response('unit gate closed', { status: 503 }) },
    ]);

    await expect(
      readOwnerExport(
        { service: 'stub', unit: NOTE_PROJECTION.unit, tenantId: TENANT_B.tenantId },
        { fetch, invoker: await stubInvoker(), serviceUrls: SERVICE_URLS },
      ),
    ).rejects.toThrow('stub export of stub.note_projection answered 503: unit gate closed');
  });
});

describe('siteRegistry', () => {
  it('reads the installed default and every seed-config site, an empty or NULL pool falling back to the site', async () => {
    const rows = [...registryRows(), { SiteID: 'Default', publicUserPoolID: null, privateUserPoolID: '' }];
    const { fetch, requests } = fakeFetch([
      exportRoute(SITES_URL, (_unit, tenantId) => [
        exportTable(SITE, rows.filter((row) => tenantIdForSite(String(row.SiteID)) === tenantId)),
      ]),
    ]);

    const registry = await siteRegistry({ fetch, invoker: await stubInvoker(), serviceUrls: SERVICE_URLS });

    expect(requests.map((request) => request.url.searchParams.get('unit'))).toEqual(requests.map(() => SITE.unit));
    expect(requests.map((request) => request.url.searchParams.get('tenantId'))).toEqual(
      ['default', TENANT_UMBRELLA.siteId, TENANT_A.siteId, TENANT_B.siteId].map((site) => tenantIdForSite(site)),
    );
    expect(registry).toEqual([
      { siteId: 'Default', tenantId: tenantIdForSite('default'), publicUserPoolId: 'default', privateUserPoolId: 'default' },
      {
        siteId: TENANT_UMBRELLA.siteId,
        tenantId: TENANT_UMBRELLA.tenantId,
        publicUserPoolId: TENANT_UMBRELLA.siteId,
        privateUserPoolId: TENANT_UMBRELLA.siteId,
      },
      {
        siteId: TENANT_A.siteId,
        tenantId: TENANT_A.tenantId,
        publicUserPoolId: TENANT_UMBRELLA.siteId,
        privateUserPoolId: TENANT_A.siteId,
      },
      { siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId, publicUserPoolId: TENANT_B.siteId, privateUserPoolId: TENANT_B.siteId },
    ]);
  });
});

describe('pollUntil', () => {
  function testClock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
    let now = 0;
    const sleeps: number[] = [];
    return {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      sleeps,
    };
  }

  function counter(): () => Promise<number> {
    let calls = 0;
    return async () => {
      calls += 1;
      return calls;
    };
  }

  it('resolves with the first value done accepts, sleeping the interval between calls', async () => {
    const clock = testClock();

    const outcome = await pollUntil(counter(), (calls) => calls === 3, { ...clock, poll: { timeoutMs: 10_000, intervalMs: 250 } });

    expect(outcome).toEqual({ value: 3, polls: 3, elapsedMs: 500, timedOut: false });
    expect(clock.sleeps).toEqual([250, 250]);
  });

  it('times out with the last value read, the final sleep clipped to the remaining budget', async () => {
    const clock = testClock();

    const outcome = await pollUntil(counter(), () => false, { ...clock, poll: { timeoutMs: 2_500, intervalMs: 1_000 } });

    expect(outcome).toEqual({ value: 4, polls: 4, elapsedMs: 2_500, timedOut: true });
    expect(clock.sleeps).toEqual([1_000, 1_000, 500]);
  });

  it('sleeps the default interval when no bounds are given', async () => {
    const clock = testClock();

    const outcome = await pollUntil(counter(), (calls) => calls === 2, clock);

    expect(outcome).toEqual({ value: 2, polls: 2, elapsedMs: DEFAULT_POLL_INTERVAL_MS, timedOut: false });
    expect(clock.sleeps).toEqual([DEFAULT_POLL_INTERVAL_MS]);
  });

  it('returns after one call without sleeping when the first value is done', async () => {
    const outcome = await pollUntil(async () => 'ready', (value) => value === 'ready');

    expect(outcome).toMatchObject({ value: 'ready', polls: 1, timedOut: false });
  });
});
