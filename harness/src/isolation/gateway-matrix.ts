// Cross-tenant reads and writes through the gateway with real seeded logins of tenant-a, tenant-b and umbrella.
import { createHash } from 'node:crypto';
import { LEGACY_ERROR_MAP, getApiVersion, isCfUuid } from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  crossTenantPairs,
  fixtureForSite,
  poolTenantExpectation,
  type CrossTenantPair,
  type TenantFixture,
} from '@opt2/platform/testing';
import { FIXTURES_UNAVAILABLE, readFixtureStatus, type FixtureStatus, type ServiceName } from '../golden/catalogue.js';
import {
  adminLogin,
  basicAuth,
  createScenarioContext,
  jsonApiLogin,
  jsonApiTokens,
  originBaseUrl,
  resolvePlaceholders,
  type ScenarioContext,
} from '../golden/session.js';
import { createHttpSession, type FetchLike, type HttpResult, type HttpSession } from '../lib/http.js';
import type { EnvLike } from '../lib/paths.js';

/** A seeded tenant the matrix logs in as or probes. */
export type TenantKey = 'a' | 'b' | 'umbrella';

/** The platform fixture of each tenant key. */
export const TENANTS_BY_KEY: Readonly<Record<TenantKey, TenantFixture>> = Object.freeze({
  a: TENANT_A,
  b: TENANT_B,
  umbrella: TENANT_UMBRELLA,
});

/** Tenant keys in TENANT_LIST order. */
const TENANT_KEYS: readonly TenantKey[] = Object.freeze(TENANT_LIST.map(keyOf));

function keyOf(fixture: TenantFixture): TenantKey {
  return fixture.key.toLowerCase() as TenantKey;
}

function siteOf(tenant: TenantKey): string {
  return TENANTS_BY_KEY[tenant].siteId;
}

/** Route families the matrix probes. */
export type FamilyId = 'content' | 'user' | 'timesheets' | 'finance' | 'surveys';

/** Seeded account of one tenant for one family, as credential placeholders. */
export interface ActorRef {
  /** Role key of the seed credential file's `roles.<site>` map. */
  role: string;
  /** `admin` (admin login form) for system users, `jsonapi` (JSON API `login`) for public-pool members. */
  login: 'admin' | 'jsonapi';
  /** `${user:<site>:<role>}`. */
  username: string;
  /** `${secret:seed:${user:<site>:<role>}}`. */
  password: string;
}

function actorRef(tenant: TenantKey, role: string, login: ActorRef['login'] = 'admin'): ActorRef {
  const username = `\${user:${siteOf(tenant)}:${role}}`;
  return Object.freeze({ role, login, username, password: `\${secret:seed:${username}}` });
}

const SITE_ADMIN = 'site-admin';
const MEMBER = 'member';

/**
 * Account per family and tenant. A synthetic-family actor holds the module role in its own site, so a refusal
 * elsewhere is attributable to tenancy.
 */
export const ACTORS: Readonly<Record<FamilyId, Readonly<Partial<Record<TenantKey, ActorRef>>>>> = Object.freeze({
  content: Object.freeze({
    a: actorRef('a', SITE_ADMIN),
    b: actorRef('b', SITE_ADMIN),
    umbrella: actorRef('umbrella', MEMBER, 'jsonapi'),
  }),
  // Umbrella's only seeded account is a public member, whom legacy refuses every user list, so umbrella is an
  // owner here but never an actor; its records are read through the site whose public user pool it is.
  user: Object.freeze({ a: actorRef('a', SITE_ADMIN), b: actorRef('b', SITE_ADMIN) }),
  timesheets: Object.freeze({ a: actorRef('a', 'timesheets.employee'), b: actorRef('b', 'timesheets.employee') }),
  finance: Object.freeze({ a: actorRef('a', 'finance.preparer'), b: actorRef('b', 'finance.preparer') }),
  surveys: Object.freeze({ a: actorRef('a', 'surveys.manager'), b: actorRef('b', 'surveys.manager') }),
});

/** Roles of the multi-site survey grant check: the grantor's survey targets `granted` and not `ungranted`. */
export const SURVEY_GRANT = Object.freeze({
  grantor: 'a' as TenantKey,
  granted: 'b' as TenantKey,
  ungranted: 'umbrella' as TenantKey,
  /** Respondent of the ungranted site; the grantor and granted respondent are the surveys actors. */
  ungrantedRespondent: actorRef('umbrella', MEMBER, 'jsonapi'),
});

/** Path templates of one route family; `{site}` and `{id}` are filled per request. */
export interface RouteSet {
  list: string;
  byId: string;
  write: string;
  /** Owner re-read that shows a write's effect; default `byId`. */
  effect?: string;
  /** Own-site list restricted to the pooled rows. */
  pooledList?: string;
  /** Body encoding of writes. */
  encoding: 'form' | 'json';
  /** Whether a session write carries CSRF tokens of the target id context. */
  csrf: boolean;
}

/** Fields of a family's records, matched ignoring case, first name first. */
export interface RecordShape {
  idFields: readonly string[];
  siteFields: readonly string[];
  /** Fields whose owner values a by-id response must not carry. */
  identityFields: readonly string[];
  /** Fields naming the person a record belongs to, matched against the reserved rehearsal persons. */
  personFields?: readonly string[];
  /** Fields naming the username a record belongs to, matched against the reserved rehearsal usernames. */
  usernameFields?: readonly string[];
}

/** Write target and probe fields for one owner record. */
export interface ProbeTarget {
  id: string;
  fields: Record<string, string>;
}

/** One target-served route family. */
export interface RouteFamily extends RouteSet {
  id: FamilyId;
  service: ServiceName;
  /** `public`: rows of the addressed site are anonymously readable in legacy. */
  access: 'public' | 'protected';
  pooled?: 'publicUserPool' | 'categoryPool';
  /** Whether `list`, `byId` and `write` are legacy-fixture routes, replaced by `v1` without fixtures. */
  fixtureRoute: boolean;
  v1?: RouteSet;
  /** Tenants whose records are probed; default every tenant. */
  owners?: readonly TenantKey[];
  /** `basic`: sessionless REST with the actor's credentials; `session`: the logged-in session. */
  writeAuth: 'basic' | 'session';
  /** Whether the write is an id-addressed transition or edit, which `write-foreign-id` probes. */
  idAddressedWrite: boolean;
  shape: RecordShape;
  /** Write target and probe fields for `record`, or undefined when it offers none. */
  probe(record: Readonly<Record<string, unknown>>, recordId: string, marker: string): ProbeTarget | undefined;
}

const FIXTURE_API = '/legacy-fixtures/cfml/api.cfm';
const PAGE = 'itemsPerPage=50';
// Program sites only: umbrella holds no program data and no module-role account, and its members belong to
// tenant-a's public user pool, so their writes to tenant-a member routes are legitimate.
const PROGRAM_SITES: readonly TenantKey[] = Object.freeze(['a', 'b']);
const DRAFT = 'DRAFT';

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === 'string' && /^(?:true|yes|1)$/i.test(value));
}

/** A non-blackout day of the sheet, DRAFT first, by sorted day id. */
function dayProbe(record: Readonly<Record<string, unknown>>, _id: string, marker: string): ProbeTarget | undefined {
  const days = arrayField(record, ['days'])
    .flatMap((value) => {
      const day = asRecord(value);
      const id = stringField(day, ['day_id', 'dayId']);
      return id === undefined || isTrue(field(day, ['isblackout', 'blackout']))
        ? []
        : [{ id, draft: stringField(day, ['state']) === DRAFT }];
    })
    .sort((x, y) => compareText(x.id, y.id));
  const pick = days.find((day) => day.draft) ?? days[0];
  return pick === undefined ? undefined : { id: pick.id, fields: { comment: marker } };
}

/** An edit keeping the record's amount and period, so only the title would change. */
function financeProbe(record: Readonly<Record<string, unknown>>, id: string, marker: string): ProbeTarget | undefined {
  const amount = stringField(record, ['amount']);
  const period = stringField(record, ['period']);
  return amount === undefined || period === undefined ? undefined : { id, fields: { title: marker, amount, period } };
}

/** The target-served families with their legacy and fixture paths and, for fixture families, the `/v1/` paths. */
export const ROUTE_FAMILIES: readonly RouteFamily[] = Object.freeze([
  {
    id: 'content',
    service: 'strategies-content',
    access: 'public',
    fixtureRoute: false,
    list: `/_api/json/v1/{site}/content?${PAGE}`,
    byId: '/_api/json/v1/{site}/content/{id}',
    write: '/_api/rest/v1/{site}/content/{id}',
    encoding: 'form',
    csrf: false,
    writeAuth: 'basic',
    idAddressedWrite: false,
    shape: {
      idFields: ['contentid', 'id'],
      siteFields: ['siteid'],
      identityFields: ['title', 'filename', 'contenthistid'],
    },
    probe: (_record, id, marker) => ({ id, fields: { title: marker } }),
  },
  {
    id: 'user',
    service: 'people',
    access: 'protected',
    pooled: 'publicUserPool',
    fixtureRoute: false,
    list: `/_api/json/v1/{site}/user?${PAGE}`,
    byId: '/_api/json/v1/{site}/user/{id}',
    write: '/_api/rest/v1/{site}/user/{id}',
    pooledList: `/_api/json/v1/{site}/user?${PAGE}&isPublic=1`,
    encoding: 'form',
    csrf: false,
    writeAuth: 'basic',
    idAddressedWrite: false,
    shape: {
      idFields: ['userid', 'id'],
      siteFields: ['siteid'],
      identityFields: ['username', 'email', 'fname', 'lname'],
      personFields: ['userid'],
      usernameFields: ['username'],
    },
    probe: (_record, id, marker) => ({ id, fields: { jobtitle: marker } }),
  },
  {
    id: 'timesheets',
    service: 'timesheets',
    access: 'protected',
    fixtureRoute: true,
    owners: PROGRAM_SITES,
    list: `${FIXTURE_API}/timesheets/sheets?siteid={site}&${PAGE}`,
    byId: `${FIXTURE_API}/timesheets/sheets/{id}?siteid={site}`,
    write: `${FIXTURE_API}/timesheets/days/{id}/submit?siteid={site}`,
    encoding: 'form',
    csrf: true,
    v1: {
      list: `/v1/timesheets/sheets?siteid={site}&${PAGE}`,
      byId: '/v1/timesheets/sheets/{id}?siteid={site}',
      write: '/v1/timesheets/days/{id}/submit?siteid={site}',
      encoding: 'json',
      csrf: true,
    },
    writeAuth: 'session',
    idAddressedWrite: true,
    shape: {
      idFields: ['timesheet_id', 'timesheetId'],
      siteFields: ['siteid'],
      identityFields: ['person_id', 'personId'],
      personFields: ['person_id', 'personId'],
    },
    probe: dayProbe,
  },
  {
    id: 'finance',
    service: 'finance',
    access: 'protected',
    fixtureRoute: true,
    owners: PROGRAM_SITES,
    list: `${FIXTURE_API}/finance/records?siteid={site}&${PAGE}`,
    byId: `${FIXTURE_API}/finance/records/{id}?siteid={site}`,
    write: `${FIXTURE_API}/finance/records/{id}/edit?siteid={site}`,
    encoding: 'form',
    csrf: true,
    v1: {
      list: '/v1/finance/records?siteid={site}&pageSize=50',
      byId: '/v1/finance/records/{id}?siteid={site}',
      write: '/v1/finance/records/{id}/transitions/edit?siteid={site}',
      encoding: 'json',
      csrf: true,
    },
    writeAuth: 'session',
    idAddressedWrite: true,
    shape: {
      idFields: ['record_id', 'recordId'],
      siteFields: ['siteid'],
      identityFields: ['title', 'createdbyid', 'created'],
    },
    probe: financeProbe,
  },
  {
    id: 'surveys',
    service: 'surveys',
    access: 'protected',
    fixtureRoute: true,
    owners: PROGRAM_SITES,
    list: `${FIXTURE_API}/surveys/surveys?siteid={site}&${PAGE}`,
    byId: `${FIXTURE_API}/surveys/surveys/{id}?siteid={site}`,
    write: `${FIXTURE_API}/surveys/surveys/{id}/responses?siteid={site}`,
    effect: `${FIXTURE_API}/surveys/surveys/{id}/responses?siteid={site}&itemsPerPage=1000`,
    encoding: 'form',
    csrf: true,
    // No `v1`: the surveys contract has no /v1/ response write.
    writeAuth: 'session',
    idAddressedWrite: false,
    shape: {
      idFields: ['survey_id', 'surveyId'],
      siteFields: ['siteid'],
      identityFields: ['title', 'createdbyid', 'created'],
    },
    probe: (_record, id, marker) => ({ id, fields: { answers: marker } }),
  },
] satisfies RouteFamily[]);

/** What one case probes. */
export type CaseKind =
  | 'read-list'
  | 'read-by-id'
  | 'write-owner-site'
  | 'write-site-mismatch'
  | 'write-foreign-id'
  | 'pooled-read'
  | 'survey-grant';

/** Outcome of one case. */
export type CaseResult = 'pass' | 'violation' | 'inconclusive' | 'skipped';

/** What a passing case shows. */
export type CaseExpectation =
  | 'no-owner-rows'
  | 'no-owner-record'
  | 'refused-no-effect'
  | 'registry-pools-only'
  | 'granted-sites-only';

/** Response facts a case recorded. */
export interface CaseObservation {
  status?: number;
  errorCode?: string;
  /** Owner ids (or, for `pooled-read`, foreign rows) the actor received. */
  leakedIds?: number;
  /** Whether the owner's re-read changed across the write. */
  effect?: boolean;
}

/** One (family, kind, actor, owner) probe; `id` is `<family>:<kind>:<actor>-><owner>`. */
export interface IsolationCase {
  id: string;
  family: FamilyId;
  kind: CaseKind;
  actor: TenantKey;
  owner: TenantKey;
  method: 'GET' | 'POST';
  /** Path probed; `{id}` stays a placeholder until the case runs. */
  route: string;
  expected: CaseExpectation;
  result: CaseResult;
  observed: CaseObservation;
  reason?: string;
}

/** Totals and cases of one gateway run. */
export interface GatewayIsolationResult {
  crossTenantReads: number;
  crossTenantWrites: number;
  surveyGrantOnly: boolean;
  cases: IsolationCase[];
}

/** Reserved rehearsal identities that no probe may target. */
export interface ReservedIdentities {
  persons: string[];
  usernames: string[];
}

/** Inputs of {@link runGatewayIsolation}; every field has a default. */
export interface GatewayIsolationDeps {
  env?: EnvLike;
  /** Default `originBaseUrl('gateway', env)`. */
  baseUrl?: string;
  /** Passed to every HTTP session. */
  fetch?: FetchLike;
  /** Default `readFixtureStatus(env)`. */
  fixtures?: FixtureStatus;
  /** Default {@link ROUTE_FAMILIES}. */
  families?: readonly RouteFamily[];
  /** Default `reserved.rehearsal` of the seed configuration. */
  reserved?: ReservedIdentities;
  /** Marker every probe value contains; default {@link DEFAULT_PROBE_SUFFIX}. */
  probeSuffix?: string;
}

/** Options of {@link buildCases}. */
export interface BuildCasesOptions {
  fixtures: Pick<FixtureStatus, 'available'>;
  /** Default `crossTenantPairs()`; each pair's reader is the actor and its writer the owner. */
  pairs?: readonly CrossTenantPair[];
}

/** Probe marker used when none is supplied. */
export const DEFAULT_PROBE_SUFFIX = 'opt2-isolation-probe';

/** Reason of a built case until it runs. */
export const NOT_RUN = 'not run';

/** Owner records discovered per family and tenant. */
export const MAX_OWNER_RECORDS = 5;

const SCENARIO_ID = 'isolation-gateway-matrix';
const READ_KINDS: ReadonlySet<CaseKind> = new Set(['read-list', 'read-by-id']);
const WRITE_KINDS: ReadonlySet<CaseKind> = new Set(['write-owner-site', 'write-site-mismatch', 'write-foreign-id']);
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['apiversion', 'method', 'params', 'error']);
const VOLATILE_KEY = /csrf|token/i;
const RESPONSES_PAGE = 1000;
type PoolKind = Parameters<typeof poolTenantExpectation>[1];
const POOL_KINDS: Readonly<Record<NonNullable<RouteFamily['pooled']>, readonly PoolKind[]>> = Object.freeze({
  publicUserPool: Object.freeze(['publicUser', 'privateUser'] as const),
  categoryPool: Object.freeze(['category'] as const),
});
const SURVEY_ROUTES = Object.freeze({
  list: `${FIXTURE_API}/surveys/surveys?siteid={site}&itemsPerPage=${RESPONSES_PAGE}`,
  detail: `${FIXTURE_API}/surveys/surveys/{id}?siteid={site}`,
  create: `${FIXTURE_API}/surveys/surveys?siteid={site}`,
  bulk: `${FIXTURE_API}/surveys/surveys/{id}/targets/bulk?siteid={site}`,
  respond: `${FIXTURE_API}/surveys/surveys/{id}/responses?siteid={site}`,
  responses: `${FIXTURE_API}/surveys/surveys/{id}/responses?siteid={site}&itemsPerPage=${RESPONSES_PAGE}`,
});
const SURVEY_ID_FIELDS: readonly string[] = ['survey_id', 'surveyId'];
const RESPONSE_ID_FIELDS: readonly string[] = ['response_id', 'responseId'];

function compareText(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Value of the first of `names` `record` holds, keys matched ignoring case. */
function field(record: Readonly<Record<string, unknown>> | undefined, names: readonly string[]): unknown {
  if (record === undefined) return undefined;
  for (const name of names) {
    if (Object.hasOwn(record, name)) return record[name];
    const lower = name.toLowerCase();
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === lower);
    if (key !== undefined) return record[key];
  }
  return undefined;
}

/** Non-empty string or number form of {@link field}. */
function stringField(
  record: Readonly<Record<string, unknown>> | undefined,
  names: readonly string[],
): string | undefined {
  const value = field(record, names);
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function arrayField(record: Readonly<Record<string, unknown>> | undefined, names: readonly string[]): unknown[] {
  const value = field(record, names);
  return Array.isArray(value) ? value : [];
}

/** `template` with `{site}` and, when given, `{id}` filled, each URL-encoded. */
function fill(template: string, site: string, id?: string): string {
  const withSite = template.replaceAll('{site}', encodeURIComponent(site));
  return id === undefined ? withSite : withSite.replaceAll('{id}', encodeURIComponent(id));
}

function caseId(family: FamilyId, kind: CaseKind, actor: TenantKey, owner: TenantKey): string {
  return `${family}:${kind}:${actor}->${owner}`;
}

/** The family's routes under `fixtures`: fixture paths when available, else `v1`, else none. */
function routesFor(family: RouteFamily, fixtures: Pick<FixtureStatus, 'available'>): RouteSet | undefined {
  return !family.fixtureRoute || fixtures.available ? family : family.v1;
}

/** Tenants whose `pooled` pools a site of `tenant` reads, other than its own. */
function poolTenants(family: RouteFamily, tenant: TenantKey): TenantKey[] {
  if (family.pooled === undefined) return [];
  const fixture = TENANTS_BY_KEY[tenant];
  const pooled = POOL_KINDS[family.pooled].map((kind) => poolTenantExpectation(fixture, kind));
  return TENANT_KEYS.filter((key) => key !== tenant && pooled.includes(TENANTS_BY_KEY[key].tenantId));
}

/** Whether `owner`'s rows are legitimately visible to `actor` in a request addressing `addressedSite`. */
function legitimate(family: RouteFamily, actor: TenantKey, owner: TenantKey, addressedSite: string): boolean {
  if (actor === owner || poolTenants(family, actor).includes(owner)) return true;
  return family.access === 'public' && fixtureForSite(addressedSite)?.tenantId === TENANTS_BY_KEY[owner].tenantId;
}

/**
 * Every case of `families` per (actor, owner) pair, plus one `pooled-read` per pooled family and one `survey-grant`,
 * sorted by id. Cases that need absent fixtures are `skipped`; the rest are `inconclusive` with {@link NOT_RUN}.
 */
export function buildCases(families: readonly RouteFamily[], opts: BuildCasesOptions): IsolationCase[] {
  const pairs = opts.pairs ?? crossTenantPairs();
  const cases: IsolationCase[] = [];
  for (const family of families) {
    const routes = routesFor(family, opts.fixtures);
    const set: RouteSet = routes ?? family;
    const actors = ACTORS[family.id];
    const owners = new Set(family.owners ?? TENANT_KEYS);
    const add = (
      kind: CaseKind,
      actor: TenantKey,
      owner: TenantKey,
      template: string,
      site: string,
      expected: CaseExpectation,
      runnable: boolean = routes !== undefined,
    ): void => {
      cases.push({
        id: caseId(family.id, kind, actor, owner),
        family: family.id,
        kind,
        actor,
        owner,
        method: kind === 'read-list' || kind === 'read-by-id' || kind === 'pooled-read' ? 'GET' : 'POST',
        route: fill(template, site),
        expected,
        result: runnable ? 'inconclusive' : 'skipped',
        observed: {},
        reason: runnable ? NOT_RUN : FIXTURES_UNAVAILABLE,
      });
    };

    for (const pair of pairs) {
      const actor = keyOf(pair.reader);
      const owner = keyOf(pair.writer);
      if (actors[actor] === undefined || !owners.has(owner)) continue;
      add('read-list', actor, owner, set.list, siteOf(owner), 'no-owner-rows');
      add('read-by-id', actor, owner, set.byId, siteOf(actor), 'no-owner-record');
      add('write-owner-site', actor, owner, set.write, siteOf(owner), 'refused-no-effect');
      add('write-site-mismatch', actor, owner, set.write, siteOf(actor), 'refused-no-effect');
      if (family.idAddressedWrite) add('write-foreign-id', actor, owner, set.write, siteOf(actor), 'refused-no-effect');
    }

    const actorKeys = TENANT_KEYS.filter((key) => actors[key] !== undefined);
    const first = actorKeys[0];
    if (family.pooled !== undefined && first !== undefined) {
      const viewer = actorKeys.find((key) => poolTenants(family, key).length > 0) ?? first;
      const pool = poolTenants(family, viewer)[0] ?? viewer;
      add('pooled-read', viewer, pool, set.pooledList ?? set.list, siteOf(viewer), 'registry-pools-only');
    }
    if (family.id === 'surveys') {
      const { grantor, ungranted } = SURVEY_GRANT;
      // The grant check needs the fixture create, bulk-target and response routes, which have no /v1/ equivalent.
      const runnable = opts.fixtures.available;
      add('survey-grant', ungranted, grantor, family.write, siteOf(ungranted), 'granted-sites-only', runnable);
    }
  }
  return cases.sort((x, y) => compareText(x.id, y.id));
}


function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isOk(result: Pick<HttpResult, 'status'>): boolean {
  return result.status >= 200 && result.status < 300;
}

function sameSite(site: string | undefined, other: string): boolean {
  return site !== undefined && site.toLowerCase() === other.toLowerCase();
}

/** The legacy JSON envelope `text` holds: `apiversion` v1, a string `method`, and `params` an object when present. */
function legacyEnvelope(text: string): Record<string, unknown> | undefined {
  const body = asRecord(parseJson(text));
  if (body === undefined || body.apiversion !== getApiVersion() || typeof body.method !== 'string') return undefined;
  return body.params === undefined || asRecord(body.params) !== undefined ? body : undefined;
}

function envelopeError(body: Record<string, unknown> | undefined): { code: string; message: string } | undefined {
  const error = asRecord(body?.error);
  return typeof error?.code === 'string' && typeof error.message === 'string'
    ? { code: error.code, message: error.message }
    : undefined;
}

/** A body's data: the envelope's `data`, an envelope flattened by `useDataNamespace=false`, or a `/v1/` body. */
function bodyData(body: unknown): unknown {
  const record = asRecord(body);
  if (record === undefined) return body;
  if (Object.hasOwn(record, 'data')) return record.data;
  if (record.apiversion === undefined) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !ENVELOPE_KEYS.has(key.toLowerCase())));
}

function listItems(result: HttpResult): Record<string, unknown>[] {
  const data = bodyData(parseJson(result.text));
  const items = Array.isArray(data) ? data : arrayField(asRecord(data), ['items']);
  return items.flatMap((item) => {
    const record = asRecord(item);
    return record === undefined ? [] : [record];
  });
}

function recordOf(result: HttpResult): Record<string, unknown> | undefined {
  return asRecord(bodyData(parseJson(result.text)));
}

function errorCodeOf(result: HttpResult): string | undefined {
  return envelopeError(asRecord(parseJson(result.text)))?.code;
}

function isCsrfRefusal(result: HttpResult): boolean {
  const { invalidTokens } = LEGACY_ERROR_MAP;
  return (
    result.status === invalidTokens.status &&
    envelopeError(asRecord(parseJson(result.text)))?.message === invalidTokens.message
  );
}

function hasSaveErrors(body: Record<string, unknown>): boolean {
  const errors = asRecord(field(asRecord(bodyData(body)), ['errors']));
  return errors !== undefined && Object.keys(errors).length > 0;
}

/** Options of {@link isLegacyRefusal}. */
export interface RefusalOptions {
  /** A legacy-fixture route, whose 400 `badRequest` is a refusal too. */
  fixture?: boolean;
}

/**
 * Whether `result` refuses in the legacy shape: 401, 403 or 404 with the legacy JSON envelope carrying an `error`
 * (or, for 403, save errors under `data.errors`); on a fixture route also a 400 `badRequest`. A CSRF refusal never is.
 */
export function isLegacyRefusal(result: Pick<HttpResult, 'status' | 'text'>, opts: RefusalOptions = {}): boolean {
  const body = legacyEnvelope(result.text);
  if (body === undefined) return false;
  const error = envelopeError(body);
  if (error?.message === LEGACY_ERROR_MAP.invalidTokens.message) return false;
  if (REFUSAL_STATUSES.has(result.status)) return error !== undefined || (result.status === 403 && hasSaveErrors(body));
  const { badRequest } = LEGACY_ERROR_MAP;
  return (
    opts.fixture === true &&
    result.status === badRequest.status &&
    error?.code === badRequest.code &&
    error.message === badRequest.message
  );
}

/** `value` with object keys sorted and token or CSRF keys dropped, at every depth. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = asRecord(value);
  if (record === undefined) return value;
  const keys = Object.keys(record)
    .filter((key) => !VOLATILE_KEY.test(key))
    .sort(compareText);
  return Object.fromEntries(keys.map((key) => [key, canonical(record[key])]));
}

/** SHA-256 of the stable JSON of a response's data. */
function dataDigest(result: HttpResult): string {
  const text = JSON.stringify(canonical(bodyData(parseJson(result.text))) ?? null);
  return createHash('sha256').update(text).digest('hex');
}

const reservedSchema = z.object({ persons: z.array(z.string()), usernames: z.array(z.string()) });

function readReserved(ctx: ScenarioContext): ReservedIdentities {
  return reservedSchema.parse(ctx.seed.select({ as: 'rehearsal', source: 'reserved', path: 'reserved.rehearsal' }));
}

/** One logged-in seeded account; accounts are shared across families by site, login kind and username. */
interface Account {
  tenant: TenantKey;
  site: string;
  username: string;
  password: string;
  session: HttpSession;
  ok: boolean;
  status: number;
}

interface ListView {
  status: number;
  items: Record<string, unknown>[];
}

interface OwnerRecord {
  id: string;
  record: Record<string, unknown>;
}

/** An owner's records as its viewer reads them: the owner's own actor, or a site whose pool the owner is. */
interface OwnerView {
  viewer?: Account;
  knownIds: Set<string>;
  records: OwnerRecord[];
  reason?: string;
}

interface FamilyRun {
  family: RouteFamily;
  routes: RouteSet;
  /** Whether `routes` are fixture routes. */
  fixture: boolean;
  actors: Map<TenantKey, Account>;
  /** Each actor's own-site list, the control of its cases. */
  own: Map<TenantKey, ListView>;
  owners: Map<TenantKey, OwnerView>;
  /** Ids more than one tenant lists, such as Masa's fixed system content ids; attributed by site only. */
  shared: Set<string>;
}

interface Runtime {
  ctx: ScenarioContext;
  baseUrl: string;
  fetch?: FetchLike;
  marker: string;
  persons: ReadonlySet<string>;
  usernames: ReadonlySet<string>;
  accounts: Map<string, Account>;
}

/** Logs `ref` of `tenant` in once per run through the admin login form or the JSON API `login`. */
async function account(rt: Runtime, tenant: TenantKey, ref: ActorRef): Promise<Account> {
  const site = siteOf(tenant);
  const username = resolvePlaceholders(ref.username, rt.ctx);
  const key = `${ref.login}:${site}:${username}`;
  const known = rt.accounts.get(key);
  if (known !== undefined) return known;
  const password = resolvePlaceholders(ref.password, rt.ctx);
  const session = createHttpSession({ baseUrl: rt.baseUrl, fetch: rt.fetch });
  const credentials = { username, password };
  // Public-pool members cannot use the admin login, so they log in as golden JSON API sessions do.
  const { result, ok } =
    ref.login === 'admin'
      ? await adminLogin(session, credentials)
      : await jsonApiLogin(session, { ...credentials, site });
  const created: Account = { tenant, site, username, password, session, ok, status: result.status };
  rt.accounts.set(key, created);
  return created;
}

async function listView(session: HttpSession, path: string): Promise<ListView> {
  const result = await session.get(path);
  return { status: result.status, items: isOk(result) ? listItems(result) : [] };
}

function isReserved(rt: Runtime, shape: RecordShape, record: Readonly<Record<string, unknown>>): boolean {
  const person = stringField(record, shape.personFields ?? []);
  const username = stringField(record, shape.usernameFields ?? []);
  return (
    (person !== undefined && rt.persons.has(person.toUpperCase())) ||
    (username !== undefined && rt.usernames.has(username.toLowerCase()))
  );
}

/** CF UUIDs before Masa's fixed system ids, each group by sorted id. */
function discoveryOrder(x: string, y: string): number {
  return Number(!isCfUuid(x)) - Number(!isCfUuid(y)) || compareText(x, y);
}


function emptyView(reason: string): OwnerView {
  return { knownIds: new Set(), records: [], reason };
}

/**
 * Up to {@link MAX_OWNER_RECORDS} non-reserved records of `owner`, read by its own actor from its own-site list, or,
 * for an owner the family has no actor for, by the first actor whose pool the owner is, from its pooled list.
 */
async function discover(rt: Runtime, run: FamilyRun, owner: TenantKey): Promise<OwnerView> {
  const { family, routes } = run;
  const { shape } = family;
  const ownerSite = siteOf(owner);
  const own = run.actors.get(owner);
  let viewer: Account;
  let attributed: Record<string, unknown>[];
  if (own !== undefined) {
    if (!own.ok) return emptyView(`${owner} ${family.id} actor login failed (status ${own.status})`);
    viewer = own;
    attributed = (run.own.get(owner)?.items ?? []).filter((item) => {
      const site = stringField(item, shape.siteFields);
      return site === undefined || sameSite(site, ownerSite);
    });
  } else {
    const poolViewer = [...run.actors.values()].find((a) => a.ok && poolTenants(family, a.tenant).includes(owner));
    if (poolViewer === undefined) return emptyView(`no ${family.id} actor of ${owner} and no site whose pool it is`);
    viewer = poolViewer;
    const pooled = await listView(viewer.session, fill(routes.pooledList ?? routes.list, viewer.site));
    attributed = pooled.items.filter((item) => sameSite(stringField(item, shape.siteFields), ownerSite));
  }
  const knownIds = new Set(
    attributed.flatMap((item) => {
      const id = stringField(item, shape.idFields);
      return id === undefined ? [] : [id];
    }),
  );
  const candidates = attributed
    .filter((item) => !isReserved(rt, shape, item))
    .flatMap((item) => {
      const id = stringField(item, shape.idFields);
      return id === undefined ? [] : [id];
    });
  const records: OwnerRecord[] = [];
  for (const id of [...new Set(candidates)].sort(discoveryOrder)) {
    if (records.length >= MAX_OWNER_RECORDS) break;
    const result = await viewer.session.get(fill(routes.byId, viewer.site, id));
    const record = isOk(result) ? recordOf(result) : undefined;
    if (record !== undefined && !isReserved(rt, shape, record)) records.push({ id, record });
  }
  const reason = records.length === 0 ? `no ${family.id} records of ${owner} found through ${viewer.site}` : undefined;
  return { viewer, knownIds, records, reason };
}

/** Logs the family's actors in, reads their own-site lists and discovers every owner's records. */
async function prepareFamily(rt: Runtime, family: RouteFamily, routes: RouteSet, fixture: boolean): Promise<FamilyRun> {
  const run: FamilyRun = {
    family,
    routes,
    fixture,
    actors: new Map(),
    own: new Map(),
    owners: new Map(),
    shared: new Set(),
  };
  for (const tenant of TENANT_KEYS) {
    const ref = ACTORS[family.id][tenant];
    if (ref === undefined) continue;
    const acct = await account(rt, tenant, ref);
    run.actors.set(tenant, acct);
    if (acct.ok) run.own.set(tenant, await listView(acct.session, fill(routes.list, acct.site)));
  }
  for (const owner of family.owners ?? TENANT_KEYS) run.owners.set(owner, await discover(rt, run, owner));
  const seen = new Map<string, number>();
  for (const view of run.owners.values()) for (const id of view.knownIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [id, count] of seen) if (count > 1) run.shared.add(id);
  return run;
}

/** Whether `item` is a row of `owner`: its site field names the owner's site, or it has an id only the owner lists. */
function belongsTo(run: FamilyRun, item: Readonly<Record<string, unknown>>, owner: TenantKey): boolean {
  const { shape } = run.family;
  if (sameSite(stringField(item, shape.siteFields), siteOf(owner))) return true;
  const id = stringField(item, shape.idFields);
  return id !== undefined && !run.shared.has(id) && (run.owners.get(owner)?.knownIds.has(id) ?? false);
}

/** Tenant `item` belongs to, by its site field, else by an id only one tenant lists. */
function tenantOf(run: FamilyRun, item: Readonly<Record<string, unknown>>): TenantKey | undefined {
  const { shape } = run.family;
  const site = stringField(item, shape.siteFields);
  const bySite = site === undefined ? undefined : fixtureForSite(site);
  if (bySite !== undefined) return keyOf(bySite);
  const id = stringField(item, shape.idFields);
  if (id === undefined || run.shared.has(id)) return undefined;
  return [...run.owners].find(([, view]) => view.knownIds.has(id))?.[0];
}

/** Whether a by-id response carries `owned`: the owner's site, or, for an unshared id, an owner identity value. */
function carriesOwnerRecord(
  run: FamilyRun,
  response: Readonly<Record<string, unknown>> | undefined,
  owned: OwnerRecord,
  owner: TenantKey,
): boolean {
  if (response === undefined) return false;
  const { shape } = run.family;
  if (sameSite(stringField(response, shape.siteFields), siteOf(owner))) return true;
  if (run.shared.has(owned.id)) return false;
  return shape.identityFields.some((name) => {
    const value = stringField(owned.record, [name]);
    return value !== undefined && stringField(response, [name]) === value;
  });
}

function settle(c: IsolationCase, result: CaseResult, observed: CaseObservation, reason?: string): void {
  c.result = result;
  c.observed = observed;
  c.reason = reason;
}

function observe(result: HttpResult, extra: CaseObservation = {}): CaseObservation {
  const errorCode = errorCodeOf(result);
  return { status: result.status, ...(errorCode === undefined ? {} : { errorCode }), ...extra };
}

/** Why `c` cannot prove anything for `acct`, or undefined: failed login, failed control, or no owner records. */
function blocker(run: FamilyRun, c: IsolationCase, acct: Account): string | undefined {
  const { family } = run;
  if (!acct.ok) return `${c.actor} ${family.id} login failed (status ${acct.status})`;
  const own = run.own.get(c.actor);
  if (family.access === 'protected' && (own === undefined || !isOk(own) || own.items.length === 0)) {
    const answer = `${own?.status ?? 'nothing'} with ${own?.items.length ?? 0} items`;
    return `control: ${c.actor}'s own ${family.id} list answered ${answer}`;
  }
  const view = run.owners.get(c.owner);
  if (view === undefined) return `${c.owner} is not a ${family.id} owner`;
  const empty = c.kind === 'read-list' ? view.knownIds.size === 0 : view.records.length === 0;
  return empty ? (view.reason ?? `no ${family.id} records of ${c.owner}`) : undefined;
}

function readResult(c: IsolationCase, leaked: number, status: number): void {
  if (leaked > 0) settle(c, 'violation', c.observed, `${leaked} ${c.owner} ids returned to ${c.actor}`);
  else if (status >= 500) settle(c, 'inconclusive', c.observed, `answered ${status}`);
  else settle(c, 'pass', c.observed);
}

/** The owner's site's list as the actor: no owner row the registry does not grant the actor. */
async function readList(run: FamilyRun, c: IsolationCase, acct: Account): Promise<void> {
  const ownerSite = siteOf(c.owner);
  c.route = fill(run.routes.list, ownerSite);
  const result = await acct.session.get(c.route);
  const leakedIds = legitimate(run.family, c.actor, c.owner, ownerSite)
    ? 0
    : new Set(
        listItems(result)
          .filter((item) => belongsTo(run, item, c.owner))
          .map((item, index) => stringField(item, run.family.shape.idFields) ?? `#${index}`),
      ).size;
  c.observed = observe(result, { leakedIds });
  readResult(c, leakedIds, result.status);
}

/** Each owner record's id under the actor's site: never the owner's record unless the registry grants it. */
async function readById(run: FamilyRun, c: IsolationCase, acct: Account): Promise<void> {
  const actorSite = siteOf(c.actor);
  const legit = legitimate(run.family, c.actor, c.owner, actorSite);
  let leakedIds = 0;
  let worst = 0;
  let first: HttpResult | undefined;
  for (const owned of run.owners.get(c.owner)?.records ?? []) {
    const path = fill(run.routes.byId, actorSite, owned.id);
    const result = await acct.session.get(path);
    if (first === undefined) {
      first = result;
      c.route = path;
    }
    worst = Math.max(worst, result.status);
    if (!legit && isOk(result) && carriesOwnerRecord(run, recordOf(result), owned, c.owner)) leakedIds += 1;
  }
  c.observed = first === undefined ? { leakedIds } : observe(first, { leakedIds });
  readResult(c, leakedIds, worst);
}

function classifyWrite(result: HttpResult, effect: boolean, fixture: boolean): { result: CaseResult; reason?: string } {
  if (effect) return { result: 'violation', reason: "the owner's record changed" };
  if (isOk(result)) return { result: 'violation', reason: `the write was accepted (status ${result.status})` };
  if (isCsrfRefusal(result)) return { result: 'inconclusive', reason: 'refused for CSRF, not for tenancy' };
  if (result.status >= 500) return { result: 'inconclusive', reason: `answered ${result.status}` };
  if (isLegacyRefusal(result, { fixture })) return { result: 'pass' };
  // Neither accepted nor refused in the legacy shape: not shown to be a cross-tenant write, nor shown refused.
  return { result: 'inconclusive', reason: `answered ${result.status}, neither accepted nor a legacy refusal` };
}

async function writeHeaders(run: FamilyRun, acct: Account, context: string): Promise<Record<string, string>> {
  if (run.family.writeAuth === 'basic') return { authorization: basicAuth(acct.username, acct.password) };
  return run.routes.csrf ? jsonApiTokens(acct.session, acct.site, context) : {};
}

/**
 * A probe write to the owner's first record that offers a target. The owner's re-read is taken right before and
 * after the probe, since seeded accounts' own logins change their records between discovery and probe.
 */
async function writeCase(rt: Runtime, run: FamilyRun, c: IsolationCase, acct: Account): Promise<void> {
  const view = run.owners.get(c.owner);
  const viewer = view?.viewer;
  const target = (view?.records ?? []).flatMap((owned) => {
    const probe = run.family.probe(owned.record, owned.id, rt.marker);
    return probe === undefined ? [] : [{ owned, probe }];
  })[0];
  if (viewer === undefined || target === undefined) {
    settle(c, 'inconclusive', {}, `no ${run.family.id} write target among ${c.owner}'s records`);
    return;
  }
  const site = c.kind === 'write-owner-site' ? siteOf(c.owner) : siteOf(c.actor);
  const fields =
    c.kind === 'write-site-mismatch' ? { ...target.probe.fields, siteid: siteOf(c.owner) } : target.probe.fields;
  c.route = fill(run.routes.write, site, target.probe.id);
  const effectPath = fill(run.routes.effect ?? run.routes.byId, viewer.site, target.owned.id);
  const before = await viewer.session.get(effectPath);
  if (!isOk(before)) {
    settle(c, 'inconclusive', {}, `the owner's re-read answered ${before.status} before the write`);
    return;
  }
  const headers = await writeHeaders(run, acct, target.probe.id);
  const body = run.routes.encoding === 'json' ? { json: fields } : { form: fields };
  const result = await acct.session.post(c.route, { headers, ...body });
  const after = await viewer.session.get(effectPath);
  if (!isOk(after)) {
    settle(c, 'inconclusive', observe(result), `the owner's re-read answered ${after.status} after the write`);
    return;
  }
  const effect = dataDigest(before) !== dataDigest(after);
  const outcome = classifyWrite(result, effect, run.fixture);
  settle(c, outcome.result, observe(result, { effect }), outcome.reason);
}

/** Each actor's own pooled list holds only its own and its registry pools' rows, and at least one row of each pool. */
async function pooledRead(run: FamilyRun, c: IsolationCase): Promise<void> {
  const { family, routes } = run;
  let foreign = 0;
  let serverError: number | undefined;
  const missing: string[] = [];
  for (const [tenant, acct] of run.actors) {
    if (!acct.ok) {
      settle(c, 'inconclusive', {}, `${tenant} ${family.id} login failed (status ${acct.status})`);
      return;
    }
    const result = await acct.session.get(fill(routes.pooledList ?? routes.list, acct.site));
    if (result.status >= 500) serverError ??= result.status;
    const pools = poolTenants(family, tenant);
    const allowed = new Set<TenantKey>([tenant, ...pools]);
    const seen = new Set<TenantKey>();
    for (const item of isOk(result) ? listItems(result) : []) {
      const owner = tenantOf(run, item);
      if (owner === undefined) continue;
      seen.add(owner);
      if (!allowed.has(owner)) foreign += 1;
    }
    for (const pool of pools) {
      if (!seen.has(pool)) missing.push(`${tenant} saw no ${pool} rows (status ${result.status})`);
    }
  }
  const observed: CaseObservation =
    serverError === undefined ? { leakedIds: foreign } : { status: serverError, leakedIds: foreign };
  if (foreign > 0) settle(c, 'violation', observed, `${foreign} rows outside the registry pools`);
  else if (serverError !== undefined) settle(c, 'inconclusive', observed, `answered ${serverError}`);
  else if (missing.length > 0) settle(c, 'violation', observed, missing.join('; '));
  else settle(c, 'pass', observed);
}


function surveyTargets(record: Readonly<Record<string, unknown>> | undefined): string[] {
  return arrayField(record, ['targets']).flatMap((target) => {
    const site = stringField(asRecord(target), ['siteid']);
    return site === undefined ? [] : [site.toLowerCase()];
  });
}

/** A grantor survey targeting the granted site but not the ungranted one; created and bulk-targeted if none exists. */
async function grantSurvey(rt: Runtime, grantor: Account): Promise<{ id: string } | { reason: string }> {
  const granted = siteOf(SURVEY_GRANT.granted).toLowerCase();
  const ungranted = siteOf(SURVEY_GRANT.ungranted).toLowerCase();
  const list = await grantor.session.get(fill(SURVEY_ROUTES.list, grantor.site));
  if (!isOk(list)) return { reason: `the grantor's survey list answered ${list.status}` };
  const ids = listItems(list).flatMap((item) => {
    const id = stringField(item, SURVEY_ID_FIELDS);
    return id === undefined ? [] : [id];
  });
  for (const id of [...new Set(ids)].sort(compareText)) {
    const detail = await grantor.session.get(fill(SURVEY_ROUTES.detail, grantor.site, id));
    const targets = isOk(detail) ? surveyTargets(recordOf(detail)) : [];
    if (targets.includes(granted) && !targets.includes(ungranted)) return { id };
  }
  const created = await grantor.session.post(fill(SURVEY_ROUTES.create, grantor.site), {
    headers: await jsonApiTokens(grantor.session, grantor.site, ''),
    form: { title: `${rt.marker} survey-grant` },
  });
  const id = isOk(created) ? stringField(recordOf(created), SURVEY_ID_FIELDS) : undefined;
  if (id === undefined) return { reason: `the survey create answered ${created.status}` };
  const bulk = await grantor.session.post(fill(SURVEY_ROUTES.bulk, grantor.site, id), {
    headers: await jsonApiTokens(grantor.session, grantor.site, id),
    form: { targets: JSON.stringify([{ siteID: siteOf(SURVEY_GRANT.granted) }]) },
  });
  return isOk(bulk) ? { id } : { reason: `bulk targeting answered ${bulk.status}` };
}

/** Every page of the survey's responses as the grantor reads them. */
async function allResponses(acct: Account, id: string): Promise<ListView> {
  const items: Record<string, unknown>[] = [];
  let pages = 1;
  for (let page = 1; page <= pages; page += 1) {
    const result = await acct.session.get(`${fill(SURVEY_ROUTES.responses, acct.site, id)}&pageIndex=${page}`);
    if (!isOk(result)) return { status: result.status, items };
    items.push(...listItems(result));
    pages = Number(stringField(asRecord(bodyData(parseJson(result.text))), ['totalpages']) ?? 1);
  }
  return { status: 200, items };
}

/** A response from the granted site is stored for the grantor; one from the ungranted site is refused and absent. */
async function surveyGrant(rt: Runtime, c: IsolationCase): Promise<void> {
  const grantorRef = ACTORS.surveys[SURVEY_GRANT.grantor];
  const grantedRef = ACTORS.surveys[SURVEY_GRANT.granted];
  if (grantorRef === undefined || grantedRef === undefined) {
    settle(c, 'inconclusive', {}, 'no surveys actor of the grantor or granted site');
    return;
  }
  const grantor = await account(rt, SURVEY_GRANT.grantor, grantorRef);
  const granted = await account(rt, SURVEY_GRANT.granted, grantedRef);
  const ungranted = await account(rt, SURVEY_GRANT.ungranted, SURVEY_GRANT.ungrantedRespondent);
  const failed = [grantor, granted, ungranted].find((acct) => !acct.ok);
  if (failed !== undefined) {
    settle(c, 'inconclusive', {}, `${failed.tenant} survey respondent login failed (status ${failed.status})`);
    return;
  }
  const survey = await grantSurvey(rt, grantor);
  if ('reason' in survey) {
    settle(c, 'inconclusive', {}, survey.reason);
    return;
  }
  const respond = async (acct: Account, answers: string): Promise<HttpResult> =>
    acct.session.post(fill(SURVEY_ROUTES.respond, acct.site, survey.id), {
      headers: await jsonApiTokens(acct.session, acct.site, survey.id),
      form: { answers },
    });
  const grantedAnswers = `${rt.marker} granted`;
  const ungrantedAnswers = `${rt.marker} ungranted`;
  const grantedResult = await respond(granted, grantedAnswers);
  const grantedId = isOk(grantedResult) ? stringField(recordOf(grantedResult), RESPONSE_ID_FIELDS) : undefined;
  const ungrantedResult = await respond(ungranted, ungrantedAnswers);
  c.route = fill(SURVEY_ROUTES.respond, ungranted.site, survey.id);
  const listed = await allResponses(grantor, survey.id);
  if (!isOk(listed)) {
    settle(c, 'inconclusive', observe(ungrantedResult), `the grantor's response list answered ${listed.status}`);
    return;
  }
  const grantedShown =
    grantedId !== undefined &&
    listed.items.some(
      (item) =>
        stringField(item, RESPONSE_ID_FIELDS) === grantedId &&
        sameSite(stringField(item, ['respondentsiteid']), granted.site),
    );
  const ungrantedShown = listed.items.some((item) => stringField(item, ['answers']) === ungrantedAnswers);
  const effect = isOk(ungrantedResult) || ungrantedShown;
  const observed = observe(ungrantedResult, { effect });
  if (effect) settle(c, 'violation', observed, `the ${ungranted.site} response was accepted`);
  else if (isCsrfRefusal(grantedResult) || grantedResult.status >= 500) {
    settle(c, 'inconclusive', observed, `the granted response answered ${grantedResult.status}`);
  } else if (!grantedShown) {
    settle(c, 'violation', observed, `no ${granted.site} response is listed (status ${grantedResult.status})`);
  } else if (isCsrfRefusal(ungrantedResult) || ungrantedResult.status >= 500) {
    settle(c, 'inconclusive', observed, `the ungranted response answered ${ungrantedResult.status}`);
  } else if (!isLegacyRefusal(ungrantedResult, { fixture: true })) {
    const answer = `${ungrantedResult.status}, not a legacy refusal`;
    settle(c, 'inconclusive', observed, `the ungranted response answered ${answer}`);
  } else settle(c, 'pass', observed);
}

async function runCase(rt: Runtime, run: FamilyRun, c: IsolationCase): Promise<void> {
  if (c.kind === 'survey-grant') return surveyGrant(rt, c);
  if (c.kind === 'pooled-read') return pooledRead(run, c);
  const acct = run.actors.get(c.actor);
  const blocked = acct === undefined ? `no ${run.family.id} actor of ${c.actor}` : blocker(run, c, acct);
  if (acct === undefined || blocked !== undefined) return settle(c, 'inconclusive', {}, blocked);
  if (c.kind === 'read-list') return readList(run, c, acct);
  if (c.kind === 'read-by-id') return readById(run, c, acct);
  return writeCase(rt, run, c, acct);
}

function totals(cases: IsolationCase[]): GatewayIsolationResult {
  let crossTenantReads = 0;
  let crossTenantWrites = 0;
  for (const c of cases) {
    if (READ_KINDS.has(c.kind)) crossTenantReads += c.observed.leakedIds ?? 0;
    else if (c.kind === 'pooled-read' && c.result === 'violation') crossTenantReads += 1;
    else if (WRITE_KINDS.has(c.kind) && c.result === 'violation') crossTenantWrites += 1;
    else if (c.kind === 'survey-grant' && c.result === 'violation' && c.observed.effect === true) {
      crossTenantWrites += 1;
    }
  }
  const surveyGrantOnly = cases.some((c) => c.kind === 'survey-grant' && c.result === 'pass');
  return { crossTenantReads, crossTenantWrites, surveyGrantOnly, cases };
}

/**
 * Runs every case of {@link buildCases} through the gateway, one at a time, as real seeded logins; identity comes
 * only from those logins. Returns the cases sorted by id with their totals.
 */
export async function runGatewayIsolation(deps: GatewayIsolationDeps = {}): Promise<GatewayIsolationResult> {
  const env = deps.env ?? process.env;
  const fixtures = deps.fixtures ?? readFixtureStatus(env);
  const families = deps.families ?? ROUTE_FAMILIES;
  const ctx = createScenarioContext({ id: SCENARIO_ID }, { origin: 'gateway', env, fetch: deps.fetch });
  const reserved = deps.reserved ?? readReserved(ctx);
  const rt: Runtime = {
    ctx,
    baseUrl: deps.baseUrl ?? originBaseUrl('gateway', env),
    fetch: deps.fetch,
    marker: deps.probeSuffix ?? DEFAULT_PROBE_SUFFIX,
    persons: new Set(reserved.persons.map((person) => person.toUpperCase())),
    usernames: new Set(reserved.usernames.map((username) => username.toLowerCase())),
    accounts: new Map(),
  };
  const cases = buildCases(families, { fixtures });
  const runs = new Map<FamilyId, FamilyRun>();
  for (const family of families) {
    const routes = routesFor(family, fixtures);
    if (routes !== undefined) {
      runs.set(family.id, await prepareFamily(rt, family, routes, family.fixtureRoute && fixtures.available));
    }
  }
  for (const c of cases) {
    const run = runs.get(c.family);
    if (c.result !== 'skipped' && run !== undefined) await runCase(rt, run, c);
  }
  return totals(cases);
}

