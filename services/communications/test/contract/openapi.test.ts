// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Provider contract of communications: every registered route against contracts/openapi.yaml, and every response shape and declared header per operation. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import type { EventEnvelope } from '@opt2/platform/events';
import { WRITE_POSITION_HEADER, parseWritePosition } from '@opt2/platform/migration-kit';
import { QUEUES, taskWireBody, type CreateTaskInput } from '@opt2/platform/tasks';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  findOperation,
  mintServiceToken,
  mintUserToken,
  pushTo,
  registryPayloads,
  withoutTenant,
  type InjectResponse,
  type TenantlessEnvelope,
} from '@opt2/platform/testing';
import { LOGIN_MAIL_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION, SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { LOGIN_MAIL_TOPIC } from '../../src/events/login-mail.js';
import { SURVEY_SCHEDULED_TOPIC } from '../../src/events/survey-scheduled.js';
import { ADOPT_PATH, CANCEL_ADOPTED_PATH } from '../../src/routes/adoption.js';
import { SCHEDULED_TASKS_PATH } from '../../src/routes/scheduled-tasks.js';
import { REMINDER_TASK_PATH } from '../../src/tasks/reminder.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { SAMPLE_IDS, envelopeFor, loginMailPayload, siteChangedPayload, surveyScheduledPayload } from '../helpers/payloads.js';

type HttpMethod = 'GET' | 'POST';
type Payload = Record<string, unknown>;
type OperationObject = Record<string, unknown> & { operationId?: string };
type Json = Record<string, unknown>;

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: unknown;
}

interface ContractOperation {
  method: string;
  path: string;
  operationId: string | undefined;
  op: OperationObject;
}

interface RouteSetDiff {
  undeclared: string[];
  unregistered: string[];
}

/** The auth declaration of one route, as the matrix records it and as the contract's `x-opt2-*` keys state it. */
interface Declaration {
  transport: unknown;
  requires: string[];
  public: boolean;
  siteCheck: boolean;
}

/** What a case seeds before its request through the service's own routes. */
type SeedStep = 'template' | 'message' | 'schedule';

/** Ids the app assigned to what the case seeded; empty strings and undefined when the step was not seeded. */
interface Seeded {
  templateId: string;
  messageId: string;
  /** The reminder task the seeded survey schedule created on `communications-reminders`. */
  reminder: CreateTaskInput | undefined;
  /** Mails sent while seeding, so a case counts only its own. */
  mails: number;
}

/** A response as `sendCase` hands it to a case: the inject response and its body, JSON-parsed when JSON. */
interface Answer {
  res: InjectResponse;
  body: unknown;
}

/** One request against an operation; `as` names the ROLE_SET subject presenting credentials, `push` delivers through `pushTo`. */
interface Case {
  name: string;
  method: HttpMethod;
  url: string | ((seeded: Seeded) => string);
  as?: string;
  site?: string;
  headers?: Record<string, string> | (() => Promise<Record<string, string>>);
  payload?: Payload | string | ((seeded: Seeded) => Payload);
  push?: { subscription: string; envelope: () => TenantlessEnvelope };
  seed?: readonly SeedStep[];
  setup?: (ctx: TestApp, seeded: Seeded) => void | Promise<void>;
  status: number;
  /** The answer commits a communications write, so it carries exactly one communications write position. */
  writes?: true;
  verify?: (answer: Answer, ctx: TestApp, seeded: Seeded) => void;
}

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

// No auto-HEAD filter: service-kit sets exposeHeadRoutes false, so the matrix holds only the methods routes declare.
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

const SERVICE = 'communications';
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const SENDER = 'communications.sender';
const FIXTURE = '/legacy-fixtures/cfml/api.cfm/communications';
const SURVEY_ID = SAMPLE_IDS.surveyId;
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000000' };
const SWEEP_QUEUE = 'communications-outbox-sweep';
const REMINDER_QUEUE = 'communications-reminders';
const LAUNCH_QUEUE = 'surveys-launch';
const TEMPLATE_UNIT = 'communications.message_template';
const TEMPLATE_LEGACY_TABLE = 'synthetic.message_template';
const TEMPLATE_LEGACY_COLUMNS = [
  { name: 'template_id', type: 's' },
  { name: 'siteID', type: 's' },
  { name: 'name', type: 's' },
  { name: 'subject', type: 's' },
  { name: 'body_text', type: 's' },
  { name: 'body_html', type: 's' },
  { name: 'created', type: 't' },
  { name: 'lastUpdate', type: 't' },
];
const LAUNCH_TASK_NAME = `opt2-survey-${SURVEY_ID}-launch`;
const RECIPIENT = 'member1@tenant-a.example';
const TEMPLATE_BODY = { name: 'Welcome', subject: 'Hello {{name}}', bodyText: 'Hi {{name}}', bodyHtml: '<p>Hi {{name}}</p>' };
const MESSAGE_BODY = { to: RECIPIENT, subject: 'Contract subject', bodyText: 'Contract body' };

/** Masa UserIDs, CF UUIDs as the contract types every stored user id, of the user subjects the cases present. */
const USER_IDS: Readonly<Record<string, string>> = {
  [SENDER]: '11111111-2222-3333-4444555566667777',
  'system-user': '22222222-3333-4444-5555666677778888',
};
const FIXTURE_FORBIDDEN = { code: 'invalid_request', message: 'Insufficient Account Permissions' };
const FIXTURE_NOT_FOUND = { code: 'invalid_request', message: 'Not Found' };
const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const AUTHORIZATION = { code: 'invalid_request', message: 'Insufficient Account Permissions' };

/** Response headers that carry legacy wire details: present on every response that declares them. */
const WIRE_HEADERS = ['generator', 'strict-transport-security', 'etag'] as const;

/** One entry per operation of `doc`, its method upper-cased. */
function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const op = item[method] as OperationObject | undefined;
      return op === undefined ? [] : [{ method: method.toUpperCase(), path, operationId: op.operationId, op }];
    }),
  );
}

/** A Fastify route pattern in contract form: `:name` as `{name}`. */
function toOpenApiPath(fastifyUrl: string): string {
  return fastifyUrl.replace(/:([A-Za-z_]\w*)/g, '{$1}');
}

/** `METHOD path` key of a registered route. */
function routeKey(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${toOpenApiPath(route.url)}`;
}

/** `METHOD path` key of a contract operation. */
function operationKey(operation: Pick<ContractOperation, 'method' | 'path'>): string {
  return `${operation.method} ${operation.path}`;
}

/** Routes the contract does not declare, and operations no route serves, each sorted. */
function diffRouteSets(routes: readonly RouteMatrixEntry[], operations: readonly ContractOperation[]): RouteSetDiff {
  const registered = new Set(routes.map(routeKey));
  const declared = new Set(operations.map(operationKey));
  return {
    undeclared: [...registered].filter((key) => !declared.has(key)).sort(),
    unregistered: [...declared].filter((key) => !registered.has(key)).sort(),
  };
}

function routeDeclaration(route: RouteMatrixEntry): Declaration {
  return {
    transport: route.transport,
    requires: [...(route.requires ?? [])].sort(),
    public: route.public === true,
    siteCheck: route.siteCheck,
  };
}

function operationDeclaration(op: OperationObject): Declaration {
  return {
    transport: op['x-opt2-transport'],
    requires: [...((op['x-opt2-requires'] as string[] | undefined) ?? [])].sort(),
    public: op['x-opt2-public'] === true,
    siteCheck: op['x-opt2-site-check'] !== false,
  };
}

/** `<route key>: <registered> != <contract>` for each registered route whose declaration differs from its operation's. */
function declarationMismatches(routes: readonly RouteMatrixEntry[], operations: readonly ContractOperation[]): string[] {
  const byKey = new Map(operations.map((operation) => [operationKey(operation), operation.op]));
  return routes.flatMap((route) => {
    const op = byKey.get(routeKey(route));
    if (op === undefined) return [];
    const registered = JSON.stringify(routeDeclaration(route));
    const contracted = JSON.stringify(operationDeclaration(op));
    return registered === contracted ? [] : [`${routeKey(route)}: ${registered} != ${contracted}`];
  });
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `node` with local `#/…` references followed until a non-reference node. */
function deref(node: unknown): unknown {
  let current = node;
  const seen = new Set<string>();
  while (isRecord(current) && typeof current.$ref === 'string' && current.$ref.startsWith('#/') && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split('/')
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((parent, segment) => (isRecord(parent) ? parent[segment] : undefined), DOC);
  }
  return current;
}

/**
 * Checks the response headers its contract response declares: each one present matches the declared `const` or `pattern`,
 * the legacy wire headers are present, and an ETag is the upper-case SHA-256 of the exact body.
 */
function headerViolations(operation: OperationObject, res: InjectResponse): string[] {
  const response = deref((operation.responses as Json | undefined)?.[String(res.statusCode)]);
  const declared = isRecord(response) && isRecord(response.headers) ? response.headers : {};
  return Object.entries(declared).flatMap(([name, spec]) => {
    const value = res.headers[name.toLowerCase()];
    const schema = deref((deref(spec) as Json | undefined)?.schema) as Json | undefined;
    if (value === undefined) {
      return (WIRE_HEADERS as readonly string[]).includes(name.toLowerCase()) ? [`${name} is declared but absent`] : [];
    }
    const text = String(value);
    if (schema?.const !== undefined && text !== schema.const) return [`${name} ${text} != ${String(schema.const)}`];
    if (typeof schema?.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(text)) return [`${name} ${text} !~ ${schema.pattern}`];
    if (name.toLowerCase() === 'etag' && text !== createHash('sha256').update(res.rawPayload).digest('hex').toUpperCase()) {
      return [`ETag ${text} is not the SHA-256 of the body`];
    }
    return [];
  });
}

/** Headers presenting the ROLE_SET subject `name` for `site`, with its USER_IDS entry as the Masa UserID. */
function subjectHeaders(name: string, site: string = SITE_A): Promise<Record<string, string>> {
  return headersFor(name, { site, sub: USER_IDS[name] });
}

/** Surveys' call of the scheduled-task listing: its invocation credential beside the forwarded tenant-a user token. */
async function surveysForwarding(roles: readonly string[] = ['system-user', 'surveys.manager']): Promise<Record<string, string>> {
  const userToken = await mintUserToken({ sub: SAMPLE_IDS.userId, site: SITE_A, roles: [...roles] });
  return { ...(await headersFor('service:surveys')), authorization: `Bearer ${userToken}` };
}

/** Sends a seeding request as the sender and returns its parsed body; fails the case unless it answers 200. */
async function seedRequest(ctx: TestApp, url: string, payload: Payload): Promise<{ data: Json }> {
  const res = await ctx.app.inject({ method: 'POST', url, headers: { ...(await subjectHeaders(SENDER)), ...CSRF_HEADERS }, payload });
  expect(res.statusCode, `seeding POST ${url}: ${res.body}`).toBe(200);
  return res.json() as { data: Json };
}

/** Seeds the case's steps through the service's own routes, then clears the events and service calls they made and counts their mails. */
async function seed(ctx: TestApp, steps: readonly SeedStep[]): Promise<Seeded> {
  const seeded: Seeded = { templateId: '', messageId: '', reminder: undefined, mails: 0 };
  if (steps.includes('template')) {
    seeded.templateId = String((await seedRequest(ctx, `/v1/templates?siteid=${SITE_A}`, TEMPLATE_BODY)).data.template_id);
  }
  if (steps.includes('message')) {
    seeded.messageId = String((await seedRequest(ctx, `/v1/messages?siteid=${SITE_A}`, MESSAGE_BODY)).data.message_id);
  }
  if (steps.includes('schedule')) {
    const res = await pushTo(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(1)));
    expect(res.statusCode, `seeding the survey schedule: ${res.body}`).toBe(204);
    seeded.reminder = ctx.taskPort.byQueue(REMINDER_QUEUE)[0];
  }
  ctx.publisher.clear();
  ctx.client.clear();
  seeded.mails = ctx.mail.sent.length;
  return seeded;
}

/** The seeded reminder task's target path. */
function reminderUrl(seeded: Seeded): string {
  if (seeded.reminder === undefined) throw new TypeError('the case seeded no survey schedule');
  return new URL(seeded.reminder.url).pathname;
}

/** The seeded reminder task's wire body, naming `tenantId` instead of its own when given. */
function reminderBody(seeded: Seeded, tenantId?: string): Payload {
  if (seeded.reminder === undefined) throw new TypeError('the case seeded no survey schedule');
  const body = taskWireBody(seeded.reminder);
  return { ...body, ...(tenantId === undefined ? {} : { tenantId }) };
}

/** Sends `c` to the app, asserts its status, then validates the body and declared headers against the operation it addresses. */
async function sendCase(ctx: TestApp, c: Case, seeded: Seeded): Promise<Answer> {
  const url = typeof c.url === 'function' ? c.url(seeded) : c.url;
  const payload = typeof c.payload === 'function' ? c.payload(seeded) : c.payload;
  const headers = typeof c.headers === 'function' ? await c.headers() : c.headers;
  const res =
    c.push === undefined
      ? await ctx.app.inject({
          method: c.method,
          url,
          headers: { ...(c.as === undefined ? {} : await subjectHeaders(c.as, c.site)), ...headers },
          ...(payload === undefined ? {} : { payload }),
        })
      : await pushTo(ctx.app, c.push.subscription, c.push.envelope());
  const path = url.split('?')[0] ?? url;
  const { operation } = findOperation(DOC, c.method, path);
  const contentType = res.headers['content-type'];
  const json = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType) && res.body !== '';
  const body: unknown = json ? JSON.parse(res.body) : res.body;
  const id = operation.operationId ?? path;
  expect(res.statusCode, `${id}: ${res.body}`).toBe(c.status);
  assertResponseMatchesOpenApi(DOC, { method: c.method, path, status: res.statusCode, contentType, body });
  expect(headerViolations(operation, res), `${id} headers`).toEqual([]);
  const position = res.headers[WRITE_POSITION_HEADER.toLowerCase()] as string | string[] | undefined;
  if (c.writes === true) {
    expect(position, `${id} ${WRITE_POSITION_HEADER}`).toBeDefined();
    expect([...parseWritePosition(position)], `${id} ${WRITE_POSITION_HEADER}`).toEqual([[SERVICE, expect.stringMatching(/^\d+$/)]]);
  } else if (c.method === 'GET' && (path.startsWith(`${FIXTURE}/`) || path.startsWith('/v1/'))) {
    expect(position, `${id} ${WRITE_POSITION_HEADER}`).toBeUndefined();
  }
  return { res, body };
}

/** The parsed body as a record, for property checks. */
function record(body: unknown): Json {
  expect(body).toBeTypeOf('object');
  return body as Json;
}

/** The `data` member of a parsed envelope or `{data}` body. */
function dataOf(body: unknown): Json {
  return record(record(body).data);
}

/** The `error` member of a parsed envelope. */
function errorOf(body: unknown): unknown {
  return record(body).error;
}

/** Statuses of a message detail's delivery history, in order. */
function historyOf(body: unknown): unknown[] {
  return (dataOf(body).history as Json[]).map((entry) => entry.status);
}

const TENANT_A_TEMPLATES = `${FIXTURE}/templates?siteid=${SITE_A}`;
const TENANT_A_MESSAGES = `${FIXTURE}/messages?siteid=${SITE_A}`;
const V1_TEMPLATES = `/v1/templates?siteid=${SITE_A}`;
const V1_MESSAGES = `/v1/messages?siteid=${SITE_A}`;
const SCHEDULED_TASKS = `${SCHEDULED_TASKS_PATH}?sourceType=survey&sourceId=${SURVEY_ID}`;
const SWEEP_TASK = { queue: SWEEP_QUEUE, name: `${SWEEP_QUEUE}-1782820800`, tenantId: null, payload: null };
const ADOPT_BODY = { tasks: [{ name: LAUNCH_TASK_NAME, siteId: SITE_A, scheduleTime: '2026-07-01T09:00:00.000', scheduleVersion: 1 }] };
const CHANGED_DOMAINS = [`${SITE_A}.opt2.test`, `mail.${SITE_A}.opt2.test`];

/** A version-2 `programs-sites.site.changed.v1` delivery of tenant-a with a second domain. */
function siteChangedEnvelope(): EventEnvelope {
  return envelopeFor('programs-sites.site.changed.v1', { ...siteChangedPayload(SITE_A), domains: CHANGED_DOMAINS }, { aggregateVersion: 2 });
}

/** Mails the case sent after seeding. */
function mailsSent(ctx: TestApp, seeded: Seeded): TestApp['mail']['sent'] {
  return ctx.mail.sent.slice(seeded.mails);
}

const CASES: Record<string, Case[]> = {
  fixtureListTemplates: [
    {
      name: 'lists the tenant-a templates for the sender',
      method: 'GET',
      url: TENANT_A_TEMPLATES,
      as: SENDER,
      seed: ['template'],
      status: 200,
      verify: ({ body }, _ctx, { templateId }) => {
        expect(dataOf(body)).toMatchObject({ totalitems: 1, items: [{ template_id: templateId, siteid: SITE_A, name: 'Welcome' }] });
      },
    },
    {
      name: 'answers an anonymous caller with the authorization 401',
      method: 'GET',
      url: TENANT_A_TEMPLATES,
      status: 401,
      verify: ({ body }) => expect(errorOf(body)).toEqual(AUTHORIZATION),
    },
    {
      name: 'refuses a siteid other than the token site as forbidden',
      method: 'GET',
      url: `${FIXTURE}/templates?siteid=${SITE_B}`,
      as: SENDER,
      status: 403,
      verify: ({ body }) => expect(errorOf(body)).toEqual(FIXTURE_FORBIDDEN),
    },
    {
      name: 'refuses a system user outside the communications.sender role group as forbidden',
      method: 'GET',
      url: TENANT_A_TEMPLATES,
      as: 'system-user',
      status: 403,
      verify: ({ body }) => expect(errorOf(body)).toEqual(FIXTURE_FORBIDDEN),
    },
    {
      name: 'answers an unknown site as invalidParameters before the login check',
      method: 'GET',
      url: `${FIXTURE}/templates?siteid=nowhere`,
      status: 400,
      verify: ({ body }) => expect(errorOf(body)).toEqual(INVALID_PARAMETERS),
    },
    {
      name: 'answers a method override the path does not dispatch on as notFound',
      method: 'GET',
      url: TENANT_A_TEMPLATES,
      as: SENDER,
      headers: { 'x-http-method-override': 'DELETE' },
      status: 404,
      verify: ({ body }) => expect(errorOf(body)).toEqual(FIXTURE_NOT_FOUND),
    },
  ],
  fixtureCreateTemplate: [
    {
      name: 'stores a template for the sender once identity consumed the CSRF token',
      method: 'POST',
      url: TENANT_A_TEMPLATES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: TEMPLATE_BODY,
      status: 200,
      writes: true,
      verify: ({ body }, ctx) => {
        expect(dataOf(body)).toMatchObject({ siteid: SITE_A, name: 'Welcome', subject: 'Hello {{name}}', lastupdate: expect.any(String) });
        expect(ctx.db.rows('message_template')).toHaveLength(1);
      },
    },
    {
      name: 'answers a blank name as invalidParameters and stores nothing',
      method: 'POST',
      url: TENANT_A_TEMPLATES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: { ...TEMPLATE_BODY, name: '  ' },
      status: 400,
      verify: ({ body }, ctx) => {
        expect(errorOf(body)).toEqual(INVALID_PARAMETERS);
        expect(ctx.db.rows('message_template')).toEqual([]);
      },
    },
    {
      name: 'answers a CSRF token identity refuses as invalidTokens and stores nothing',
      method: 'POST',
      url: TENANT_A_TEMPLATES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: TEMPLATE_BODY,
      setup: (ctx) => ctx.client.csrfValid(false),
      status: 400,
      verify: ({ body }, ctx) => {
        expect(errorOf(body)).toEqual({ code: 'invalid_request', message: 'Invalid CSRF tokens' });
        expect(ctx.db.rows('message_template')).toEqual([]);
      },
    },
  ],
  fixtureListMessages: [
    {
      name: 'lists the tenant-a messages for the sender',
      method: 'GET',
      url: TENANT_A_MESSAGES,
      as: SENDER,
      seed: ['message'],
      status: 200,
      verify: ({ body }, _ctx, { messageId }) => {
        expect(dataOf(body)).toMatchObject({ totalitems: 1, items: [{ message_id: messageId, siteid: SITE_A, to_address: RECIPIENT }] });
      },
    },
    {
      name: 'refuses a site admin outside the communications.sender role group as forbidden',
      method: 'GET',
      url: TENANT_A_MESSAGES,
      as: 'site-admin',
      status: 403,
      verify: ({ body }) => expect(errorOf(body)).toEqual(FIXTURE_FORBIDDEN),
    },
  ],
  fixtureSendMessage: [
    {
      name: 'sends literal content over SMTP and answers the delivered message with its history',
      method: 'POST',
      url: TENANT_A_MESSAGES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: MESSAGE_BODY,
      status: 200,
      writes: true,
      verify: ({ body }, ctx, seeded) => {
        expect(dataOf(body)).toMatchObject({ siteid: SITE_A, to_address: RECIPIENT, subject: 'Contract subject', state: 'delivered' });
        expect(historyOf(body)).toEqual(['queued', 'sent', 'delivered']);
        expect(mailsSent(ctx, seeded)).toHaveLength(1);
      },
    },
    {
      name: 'fills a stored template with the variables and answers 200 with state failed when SMTP refuses',
      method: 'POST',
      url: TENANT_A_MESSAGES,
      as: SENDER,
      headers: CSRF_HEADERS,
      seed: ['template'],
      payload: ({ templateId }) => ({ templateId, to: RECIPIENT, variables: '{"name":"Ann"}' }),
      setup: (ctx) => ctx.mail.fail(new Error('connection refused')),
      status: 200,
      writes: true,
      verify: ({ body }, _ctx, { templateId }) => {
        expect(dataOf(body)).toMatchObject({ template_id: templateId, subject: 'Hello Ann', body_text: 'Hi Ann', state: 'failed' });
        expect(historyOf(body)).toEqual(['queued', 'failed']);
      },
    },
    {
      name: 'answers a template the tenant lacks as notFound and sends nothing',
      method: 'POST',
      url: TENANT_A_MESSAGES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: { templateId: UNKNOWN_ID, to: RECIPIENT },
      status: 404,
      verify: ({ body }, ctx, seeded) => {
        expect(errorOf(body)).toEqual(FIXTURE_NOT_FOUND);
        expect(mailsSent(ctx, seeded)).toEqual([]);
      },
    },
    {
      name: 'answers an invalid recipient as invalidParameters and sends nothing',
      method: 'POST',
      url: TENANT_A_MESSAGES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: { ...MESSAGE_BODY, to: 'not-an-address' },
      status: 400,
      verify: ({ body }, ctx, seeded) => {
        expect(errorOf(body)).toEqual(INVALID_PARAMETERS);
        expect(mailsSent(ctx, seeded)).toEqual([]);
      },
    },
  ],
  fixtureGetMessage: [
    {
      name: 'reads the seeded message by its id in lower case, with its delivery history',
      method: 'GET',
      url: ({ messageId }) => `${FIXTURE}/messages/${messageId.toLowerCase()}?siteid=${SITE_A}`,
      as: SENDER,
      seed: ['message'],
      status: 200,
      verify: ({ body }, _ctx, { messageId }) => {
        expect(dataOf(body)).toMatchObject({ message_id: messageId, state: 'delivered' });
        expect(historyOf(body)).toEqual(['queued', 'sent', 'delivered']);
      },
    },
    {
      name: 'answers a message the tenant lacks as notFound',
      method: 'GET',
      url: `${FIXTURE}/messages/${UNKNOWN_ID}?siteid=${SITE_A}`,
      as: SENDER,
      status: 404,
      verify: ({ body }) => expect(errorOf(body)).toEqual(FIXTURE_NOT_FOUND),
    },
  ],
  listTemplates: [
    {
      name: 'lists the tenant-a templates for the sender',
      method: 'GET',
      url: V1_TEMPLATES,
      as: SENDER,
      seed: ['template'],
      status: 200,
      verify: ({ body }, _ctx, { templateId }) => {
        expect(dataOf(body)).toMatchObject({ totalitems: 1, items: [{ template_id: templateId, siteid: SITE_A }] });
      },
    },
    {
      name: 'answers an anonymous caller with the legacy 401',
      method: 'GET',
      url: V1_TEMPLATES,
      status: 401,
    },
    {
      name: 'refuses a siteid other than the token site with the legacy 403',
      method: 'GET',
      url: `/v1/templates?siteid=${SITE_B}`,
      as: SENDER,
      status: 403,
    },
  ],
  createTemplate: [
    {
      name: 'stores a JSON template for the sender once identity consumed the CSRF token',
      method: 'POST',
      url: V1_TEMPLATES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: TEMPLATE_BODY,
      status: 200,
      writes: true,
      verify: ({ body }, ctx) => {
        expect(dataOf(body)).toMatchObject({ siteid: SITE_A, name: 'Welcome', body_html: '<p>Hi {{name}}</p>' });
        expect(ctx.db.rows('message_template')).toHaveLength(1);
      },
    },
    {
      name: 'stores a form-encoded template for the sender',
      method: 'POST',
      url: V1_TEMPLATES,
      as: SENDER,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...CSRF_HEADERS },
      payload: new URLSearchParams({ name: 'Form', subject: 'Form subject', bodyText: 'Form body' }).toString(),
      status: 200,
      writes: true,
      verify: ({ body }) => expect(dataOf(body)).toMatchObject({ name: 'Form', subject: 'Form subject', body_html: '' }),
    },
    {
      name: 'answers a template without a body as invalidParameters',
      method: 'POST',
      url: V1_TEMPLATES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: { name: 'Empty', subject: 'Empty' },
      status: 400,
      verify: ({ body }, ctx) => {
        expect(errorOf(body)).toEqual(INVALID_PARAMETERS);
        expect(ctx.db.rows('message_template')).toEqual([]);
      },
    },
    {
      name: 'answers a write without a CSRF token as invalidTokens and stores nothing',
      method: 'POST',
      url: V1_TEMPLATES,
      as: SENDER,
      payload: TEMPLATE_BODY,
      status: 400,
      verify: ({ body }, ctx) => {
        expect(errorOf(body)).toEqual({ code: 'invalid_request', message: 'Invalid CSRF tokens' });
        expect(ctx.db.rows('message_template')).toEqual([]);
      },
    },
  ],
  listMessages: [
    {
      name: 'lists the tenant-a messages for the sender',
      method: 'GET',
      url: V1_MESSAGES,
      as: SENDER,
      seed: ['message'],
      status: 200,
      verify: ({ body }, _ctx, { messageId }) => {
        expect(dataOf(body)).toMatchObject({ totalitems: 1, items: [{ message_id: messageId, state: 'delivered' }] });
      },
    },
    {
      name: 'refuses an s2 user outside the communications.sender role with the legacy 403',
      method: 'GET',
      url: V1_MESSAGES,
      as: 's2',
      status: 403,
    },
  ],
  sendMessage: [
    {
      name: 'sends literal content and answers the delivered message',
      method: 'POST',
      url: V1_MESSAGES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: MESSAGE_BODY,
      status: 200,
      writes: true,
      verify: ({ body }, ctx, seeded) => {
        expect(dataOf(body)).toMatchObject({ to_address: RECIPIENT, state: 'delivered', template_id: '' });
        expect(historyOf(body)).toEqual(['queued', 'sent', 'delivered']);
        expect(mailsSent(ctx, seeded).map((mail) => mail.to)).toEqual([RECIPIENT]);
      },
    },
    {
      name: 'answers a template the tenant lacks with the legacy 404',
      method: 'POST',
      url: V1_MESSAGES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: { templateId: UNKNOWN_ID, to: RECIPIENT },
      status: 404,
    },
    {
      name: 'answers a blank subject as invalidParameters',
      method: 'POST',
      url: V1_MESSAGES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: { ...MESSAGE_BODY, subject: ' ' },
      status: 400,
      verify: ({ body }) => expect(errorOf(body)).toEqual(INVALID_PARAMETERS),
    },
    {
      name: 'answers a CSRF token identity refuses as invalidTokens and sends nothing',
      method: 'POST',
      url: V1_MESSAGES,
      as: SENDER,
      headers: CSRF_HEADERS,
      payload: MESSAGE_BODY,
      setup: (ctx) => ctx.client.csrfValid(false),
      status: 400,
      verify: ({ body }, ctx, seeded) => {
        expect(errorOf(body)).toEqual({ code: 'invalid_request', message: 'Invalid CSRF tokens' });
        expect(mailsSent(ctx, seeded)).toEqual([]);
        expect(ctx.db.rows('message')).toEqual([]);
      },
    },
  ],
  getMessage: [
    {
      name: 'reads the seeded message with its delivery history',
      method: 'GET',
      url: ({ messageId }) => `/v1/messages/${messageId}?siteid=${SITE_A}`,
      as: SENDER,
      seed: ['message'],
      status: 200,
      verify: ({ body }, _ctx, { messageId }) => {
        expect(dataOf(body)).toMatchObject({ message_id: messageId, state: 'delivered' });
        expect(historyOf(body)).toEqual(['queued', 'sent', 'delivered']);
      },
    },
    {
      name: 'answers a message the tenant lacks with the legacy 404',
      method: 'GET',
      url: `/v1/messages/${UNKNOWN_ID}?siteid=${SITE_A}`,
      as: SENDER,
      status: 404,
    },
  ],
  listScheduledTasks: [
    {
      name: "lists the seeded survey's launch and reminder tasks for surveys forwarding the user token",
      method: 'GET',
      url: SCHEDULED_TASKS,
      headers: () => surveysForwarding(),
      seed: ['schedule'],
      status: 200,
      verify: ({ body }) => {
        expect(record(body)).toMatchObject({ sourceType: 'survey', sourceId: SURVEY_ID, scheduleVersion: 1 });
        expect((record(body).items as Json[]).map(({ kind, n, queue }) => ({ kind, n, queue }))).toEqual([
          { kind: 'survey-launch', n: null, queue: LAUNCH_QUEUE },
          { kind: 'survey-reminder', n: 1, queue: REMINDER_QUEUE },
        ]);
      },
    },
    {
      name: 'answers a source never scheduled with no items and a null version',
      method: 'GET',
      url: SCHEDULED_TASKS,
      headers: () => surveysForwarding(),
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ sourceType: 'survey', sourceId: SURVEY_ID, scheduleVersion: null, items: [] }),
    },
    {
      name: 'answers a sourceId that is not a CF UUID as invalidParameters',
      method: 'GET',
      url: `${SCHEDULED_TASKS_PATH}?sourceType=survey&sourceId=nope`,
      headers: () => surveysForwarding(),
      status: 400,
    },
    {
      name: 'answers surveys without a forwarded user token with the legacy 401',
      method: 'GET',
      url: SCHEDULED_TASKS,
      as: 'service:surveys',
      status: 401,
    },
    {
      name: 'refuses another workload with the legacy 403',
      method: 'GET',
      url: SCHEDULED_TASKS,
      as: 'service:people',
      status: 403,
    },
  ],
  runSurveyReminderTask: [
    {
      name: 'runs the stored reminder and reports it sent to surveys',
      method: 'POST',
      url: reminderUrl,
      as: 'service:tasks-invoker',
      seed: ['schedule'],
      payload: (seeded) => reminderBody(seeded),
      status: 200,
      writes: true,
      verify: ({ body }, ctx) => {
        expect(record(body)).toEqual({ status: 'sent' });
        expect(ctx.client.requestsTo('surveys').map(({ method }) => method)).toEqual(['POST']);
      },
    },
    {
      name: 'refuses a body naming a tenant the stored task is not visible under as badRequest',
      method: 'POST',
      url: reminderUrl,
      as: 'service:tasks-invoker',
      seed: ['schedule'],
      payload: (seeded) => reminderBody(seeded, TENANT_B.tenantId),
      status: 400,
      verify: (_answer, ctx) => expect(ctx.client.requestsTo('surveys')).toEqual([]),
    },
  ],
  migrationApply: [
    {
      name: 'applies a zero-row synthetic.message_template batch for the migration service',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 'service:migration',
      payload: { batchId: 'contract-1', origin: 'backfill', legacyTable: TEMPLATE_LEGACY_TABLE, siteId: SITE_A, columns: TEMPLATE_LEGACY_COLUMNS, rows: [] },
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ batchId: 'contract-1', duplicate: false, applied: 0, skipped: 0 }),
    },
    {
      name: 'answers a batch whose columns omit a mapped column as invalidParameters',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 'service:migration',
      payload: {
        batchId: 'contract-2',
        origin: 'backfill',
        legacyTable: TEMPLATE_LEGACY_TABLE,
        siteId: SITE_A,
        columns: TEMPLATE_LEGACY_COLUMNS.slice(0, 1),
        rows: [],
      },
      status: 400,
    },
  ],
  migrationExport: [
    {
      name: 'exports the tenant-a templates in canonical legacy form',
      method: 'GET',
      url: `/internal/v1/migration/export?unit=${TEMPLATE_UNIT}&siteId=${SITE_A}`,
      as: 'service:migration',
      seed: ['template'],
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ unit: TEMPLATE_UNIT, tenantId: TENANT_A.tenantId }),
    },
    {
      name: 'answers an export without a unit as invalidParameters',
      method: 'GET',
      url: `/internal/v1/migration/export?siteId=${SITE_A}`,
      as: 'service:migration',
      status: 400,
    },
  ],
  migrationChanges: [
    {
      name: 'reads the tenant-a changelog after the start cursor',
      method: 'GET',
      url: `/internal/v1/migration/changes?siteId=${SITE_A}`,
      as: 'service:migration',
      seed: ['template'],
      status: 200,
      verify: ({ body }) => expect(Array.isArray(record(body).rows)).toBe(true),
    },
    {
      name: 'refuses a service credential addressed to another service with the legacy 401',
      method: 'GET',
      url: `/internal/v1/migration/changes?siteId=${SITE_A}`,
      headers: async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'migration', audience: 'surveys' })}` }),
      status: 401,
    },
  ],
  migrationPosition: [
    {
      name: 'reports the write position and drain counts of communications',
      method: 'GET',
      url: '/internal/v1/migration/position',
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body).owner).toBe(SERVICE),
    },
  ],
  migrationWatermarkGet: [
    {
      name: 'lists the synthetic.message_template forward watermarks',
      method: 'GET',
      url: `/internal/v1/migration/watermark?legacyTable=${TEMPLATE_LEGACY_TABLE}&direction=forward`,
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(body).toEqual([]),
    },
  ],
  migrationWatermarkPost: [
    {
      name: 'records a forward synthetic.message_template watermark',
      method: 'POST',
      url: '/internal/v1/migration/watermark',
      as: 'service:migration',
      payload: { legacyTable: TEMPLATE_LEGACY_TABLE, direction: 'forward', snapshotSeq: 1, backupLsn: '42', finishedAt: '2026-06-30 12:00:00' },
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ legacyTable: TEMPLATE_LEGACY_TABLE, direction: 'forward' }),
    },
    {
      name: 'answers a watermark with an unknown direction as invalidParameters',
      method: 'POST',
      url: '/internal/v1/migration/watermark',
      as: 'service:migration',
      payload: { legacyTable: TEMPLATE_LEGACY_TABLE, direction: 'sideways', finishedAt: '2026-06-30 12:00:00' },
      status: 400,
    },
  ],
  migrationGate: [
    {
      name: 'reads the message_template unit gate',
      method: 'POST',
      url: '/internal/v1/migration/gate',
      as: 'service:migration',
      payload: { op: 'status', units: [TEMPLATE_UNIT] },
      status: 200,
      verify: ({ body }) => expect(record(body).units).toEqual([{ unit: TEMPLATE_UNIT, state: 'open', holderId: null, phase: 'quiet' }]),
    },
    {
      name: 'refuses to reopen a gate another holder closed as gate-conflict',
      method: 'POST',
      url: '/internal/v1/migration/gate',
      as: 'service:migration',
      payload: { op: 'open', units: [TEMPLATE_UNIT], holderId: 'contract-holder' },
      setup: (ctx) => ctx.db.setGate(TEMPLATE_UNIT, 'closed', 'quiet', 'other-holder'),
      status: 409,
      verify: ({ body }) => expect(record(body)).toEqual({ error: 'gate-conflict', units: [TEMPLATE_UNIT] }),
    },
  ],
  adoptScheduledTasks: [
    {
      name: 'adopts a future fixture launch task as a Cloud Task and a scheduled-task row',
      method: 'POST',
      url: ADOPT_PATH,
      as: 'service:migration',
      payload: ADOPT_BODY,
      status: 200,
      writes: true,
      verify: ({ body }, ctx) => {
        expect(record(body)).toEqual({ adopted: 1, existing: 0, scheduledImmediately: 0 });
        expect(ctx.taskPort.byQueue(LAUNCH_QUEUE)).toHaveLength(1);
        expect(ctx.db.rows('scheduled_task')).toMatchObject([{ task_name: LAUNCH_TASK_NAME, origin: 'adopted' }]);
      },
    },
    {
      name: 'answers a task name outside the fixture pattern as invalidParameters',
      method: 'POST',
      url: ADOPT_PATH,
      as: 'service:migration',
      payload: { tasks: [{ ...ADOPT_BODY.tasks[0], name: 'opt2-survey-x-launch' }] },
      status: 400,
      verify: (_answer, ctx) => expect(ctx.db.rows('scheduled_task')).toEqual([]),
    },
  ],
  cancelAdoptedScheduledTasks: [
    {
      name: 'cancels every adopted task when no names are given',
      method: 'POST',
      url: CANCEL_ADOPTED_PATH,
      as: 'service:migration',
      payload: {},
      setup: async (ctx) => {
        const res = await ctx.app.inject({
          method: 'POST',
          url: ADOPT_PATH,
          headers: await subjectHeaders('service:migration'),
          payload: ADOPT_BODY,
        });
        expect(res.statusCode, res.body).toBe(200);
      },
      status: 200,
      writes: true,
      verify: ({ body }, ctx) => {
        expect(record(body)).toEqual({ cancelled: 1 });
        expect(ctx.taskPort.byQueue(LAUNCH_QUEUE)).toEqual([]);
      },
    },
    {
      name: 'answers a property the request does not declare as invalidParameters',
      method: 'POST',
      url: CANCEL_ADOPTED_PATH,
      as: 'service:migration',
      payload: { names: [LAUNCH_TASK_NAME], all: true },
      status: 400,
    },
  ],
  pushSiteChanged: [
    {
      name: 'applies a newer site.changed delivery to the tenant registry and acks it',
      method: 'POST',
      url: `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`,
      push: { subscription: SITE_CHANGED_SUBSCRIPTION, envelope: siteChangedEnvelope },
      status: 204,
      verify: (_answer, ctx) => {
        expect(ctx.db.rows('tenant_registry').find((row) => row.site_id === SITE_A)).toMatchObject({ domains: CHANGED_DOMAINS });
        expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toEqual([]);
      },
    },
    {
      name: 'dead-letters and acks a delivery without a tenant',
      method: 'POST',
      url: `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`,
      push: { subscription: SITE_CHANGED_SUBSCRIPTION, envelope: () => withoutTenant(siteChangedEnvelope()) },
      status: 204,
      verify: (_answer, ctx) => expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toHaveLength(1),
    },
  ],
  pushLoginMailRequested: [
    {
      name: 'stores and sends the requested login mail once, and acks the delivery',
      method: 'POST',
      url: `/internal/v1/events/${LOGIN_MAIL_SUBSCRIPTION}`,
      push: { subscription: LOGIN_MAIL_SUBSCRIPTION, envelope: () => envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload()) },
      status: 204,
      verify: (_answer, ctx, seeded) => {
        expect(mailsSent(ctx, seeded).map((mail) => mail.to)).toEqual([RECIPIENT]);
        expect(ctx.db.rows('message')).toMatchObject([{ message_id: SAMPLE_IDS.messageId, source: 'login-mail' }]);
        expect(ctx.publisher.deadLetters(LOGIN_MAIL_SUBSCRIPTION)).toEqual([]);
      },
    },
    {
      name: 'dead-letters and acks a payload the producer schema rejects, sending nothing',
      method: 'POST',
      url: `/internal/v1/events/${LOGIN_MAIL_SUBSCRIPTION}`,
      push: {
        subscription: LOGIN_MAIL_SUBSCRIPTION,
        envelope: () => envelopeFor(LOGIN_MAIL_TOPIC, { ...loginMailPayload(), kind: 'unknown-kind' }),
      },
      status: 204,
      verify: (_answer, ctx, seeded) => {
        expect(ctx.publisher.deadLetters(LOGIN_MAIL_SUBSCRIPTION)).toHaveLength(1);
        expect(mailsSent(ctx, seeded)).toEqual([]);
      },
    },
  ],
  pushSurveyScheduled: [
    {
      name: 'creates the launch and reminder tasks of the schedule version and acks the delivery',
      method: 'POST',
      url: `/internal/v1/events/${SURVEY_SCHEDULED_SUBSCRIPTION}`,
      push: { subscription: SURVEY_SCHEDULED_SUBSCRIPTION, envelope: () => envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(1)) },
      status: 204,
      verify: (_answer, ctx) => {
        // Queue task names carry the schedule version, so a reschedule's tasks never collide with the ones they supersede.
        expect(ctx.taskPort.byQueue(LAUNCH_QUEUE).map(({ name }) => name)).toEqual([`${LAUNCH_TASK_NAME}-v1`]);
        expect(ctx.taskPort.byQueue(REMINDER_QUEUE)).toHaveLength(1);
        expect(ctx.db.rows('scheduled_task').map((row) => row.task_name)).toEqual([LAUNCH_TASK_NAME, `opt2-survey-${SURVEY_ID}-reminder-1`]);
      },
    },
    {
      name: 'dead-letters and acks a delivery without a tenant',
      method: 'POST',
      url: `/internal/v1/events/${SURVEY_SCHEDULED_SUBSCRIPTION}`,
      push: {
        subscription: SURVEY_SCHEDULED_SUBSCRIPTION,
        envelope: () => withoutTenant(envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(1))),
      },
      status: 204,
      verify: (_answer, ctx) => {
        expect(ctx.publisher.deadLetters(SURVEY_SCHEDULED_SUBSCRIPTION)).toHaveLength(1);
        expect(ctx.db.rows('scheduled_task')).toEqual([]);
      },
    },
  ],
  sweepOutbox: [
    {
      name: 'creates the next sweep task, then sweeps every registered tenant',
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      as: 'service:tasks-invoker',
      payload: SWEEP_TASK,
      status: 200,
      verify: ({ body }, ctx) => {
        expect(record(body)).toMatchObject({ failed: 0, tenants: registryPayloads().length });
        expect(ctx.taskPort.byQueue(SWEEP_QUEUE).length).toBeGreaterThan(1);
      },
    },
    {
      name: 'refuses a user token on the cloud-tasks sweep route before the handler',
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      as: SENDER,
      payload: SWEEP_TASK,
      status: 401,
      verify: (_answer, ctx) => expect(ctx.taskPort.byQueue(SWEEP_QUEUE)).toHaveLength(1),
    },
  ],
  pauseTaskQueue: [
    {
      name: 'pauses the outbox-sweep queue for the operator',
      method: 'POST',
      url: `/internal/v1/task-queues/${SWEEP_QUEUE}/pause`,
      as: 'service:operator',
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ queue: SWEEP_QUEUE, service: SERVICE, paused: true, running: 0 }),
    },
    {
      name: 'answers a queue communications does not create tasks on as invalidParameters',
      method: 'POST',
      url: '/internal/v1/task-queues/reporting-export-run/pause',
      as: 'service:operator',
      status: 400,
    },
  ],
  resumeTaskQueue: [
    {
      name: 'resumes the reminders queue for the migration service',
      method: 'POST',
      url: `/internal/v1/task-queues/${REMINDER_QUEUE}/resume`,
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ queue: REMINDER_QUEUE, service: SERVICE, paused: false }),
    },
  ],
  ensureTaskQueue: [
    {
      name: 'finds the live outbox-sweep chain task for the operator',
      method: 'POST',
      url: `/internal/v1/task-queues/${SWEEP_QUEUE}/ensure`,
      as: 'service:operator',
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ queue: SWEEP_QUEUE, ensured: { created: false, reason: 'live' } }),
    },
    {
      name: 'answers a queue that is not a recurring chain as invalidParameters',
      method: 'POST',
      url: `/internal/v1/task-queues/${REMINDER_QUEUE}/ensure`,
      as: 'service:operator',
      status: 400,
    },
  ],
  healthz: [
    {
      name: 'answers the liveness probe anonymously',
      method: 'GET',
      url: '/healthz',
      status: 200,
      verify: ({ body }) => expect(body).toEqual({ status: 'ok' }),
    },
  ],
};

/** Route families of communications and the declaration every route of the family carries. */
const FAMILIES: ReadonlyArray<{ family: string; prefix: string; count: number; declaration: Omit<Declaration, 'siteCheck'> }> = [
  { family: 'fixture', prefix: FIXTURE, count: 5, declaration: { transport: 'service', requires: [], public: true } },
  { family: '/v1', prefix: '/v1/', count: 5, declaration: { transport: 'service', requires: [SENDER], public: false } },
  {
    family: 'scheduled-task listing',
    prefix: SCHEDULED_TASKS_PATH,
    count: 1,
    declaration: { transport: 'service', requires: ['service:surveys'], public: false },
  },
  {
    family: 'reminder task',
    prefix: '/internal/v1/tasks/reminders/',
    count: 1,
    declaration: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'], public: false },
  },
  {
    family: 'migration-kit and scheduler hand-off',
    prefix: '/internal/v1/migration/',
    count: 9,
    declaration: { transport: 'service', requires: ['platform.migration'], public: false },
  },
  {
    family: 'outbox sweep',
    prefix: '/internal/v1/outbox/sweep',
    count: 1,
    declaration: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'], public: false },
  },
  {
    family: 'task-queue control',
    prefix: '/internal/v1/task-queues/',
    count: 3,
    declaration: { transport: 'service', requires: ['platform.migration', 'platform.operator'], public: false },
  },
  {
    family: 'push consumers',
    prefix: '/internal/v1/events/',
    count: 3,
    declaration: { transport: 'pubsub-push', requires: ['service:pubsub-invoker'], public: false },
  },
  { family: 'health', prefix: '/healthz', count: 1, declaration: { transport: 'service', requires: [], public: true } },
];

/** `METHOD path` keys of the routes each family must contain, named by the constants the routes are registered under. */
const EXPECTED_ROUTES: readonly string[] = [
  `GET ${FIXTURE}/templates`,
  `POST ${FIXTURE}/templates`,
  `GET ${FIXTURE}/messages`,
  `POST ${FIXTURE}/messages`,
  `GET ${FIXTURE}/messages/{id}`,
  'GET /v1/templates',
  'POST /v1/templates',
  'GET /v1/messages',
  'POST /v1/messages',
  'GET /v1/messages/{messageId}',
  `GET ${SCHEDULED_TASKS_PATH}`,
  `POST ${QUEUES[REMINDER_QUEUE].targetPath}`,
  'POST /internal/v1/migration/apply',
  'GET /internal/v1/migration/export',
  'GET /internal/v1/migration/changes',
  'GET /internal/v1/migration/position',
  'GET /internal/v1/migration/watermark',
  'POST /internal/v1/migration/watermark',
  'POST /internal/v1/migration/gate',
  `POST ${ADOPT_PATH}`,
  `POST ${CANCEL_ADOPTED_PATH}`,
  'POST /internal/v1/outbox/sweep',
  'POST /internal/v1/task-queues/{queue}/pause',
  'POST /internal/v1/task-queues/{queue}/resume',
  'POST /internal/v1/task-queues/{queue}/ensure',
  `POST /internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`,
  `POST /internal/v1/events/${LOGIN_MAIL_SUBSCRIPTION}`,
  `POST /internal/v1/events/${SURVEY_SCHEDULED_SUBSCRIPTION}`,
  'GET /healthz',
];

describe('contract document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect(DOC.openapi).toBe('3.1.0');
    expect(DOC.info.version).toBe('1.0.0');
    expect(DOC.info['x-source-sha']).toBe(PIN.sha);
  });

  it('gives every operation a unique operationId', () => {
    const ids = contractOperations(DOC).map(({ operationId }) => operationId);
    expect(ids.filter((id) => typeof id !== 'string' || id === '')).toEqual([]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });
});

describe('route declarations', () => {
  let ctx: TestApp;
  let routes: RouteMatrixEntry[];

  beforeAll(async () => {
    ctx = await buildTestApp();
    routes = collectRouteMatrix(ctx.app).routes;
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('registers exactly the contract operations', () => {
    const { undeclared, unregistered } = diffRouteSets(routes, contractOperations(DOC));
    expect(undeclared, 'registered but undeclared in contracts/openapi.yaml').toEqual([]);
    expect(unregistered, 'declared in contracts/openapi.yaml but unregistered').toEqual([]);
  });

  it("declares each route with its operation's roles, public flag, transport and site check", () => {
    expect(declarationMismatches(routes, contractOperations(DOC))).toEqual([]);
  });

  it.each(FAMILIES)('serves the $family family under one declaration', ({ prefix, count, declaration }) => {
    const family = routes.filter((route) => route.url.startsWith(prefix));
    expect(family).toHaveLength(count);
    for (const route of family) {
      expect(routeDeclaration(route), routeKey(route)).toMatchObject({ ...declaration, requires: [...declaration.requires].sort() });
    }
  });

  it('assigns every route to exactly one family', () => {
    expect(FAMILIES.reduce((sum, { count }) => sum + count, 0)).toBe(routes.length);
  });

  it('registers every expected route', () => {
    const registered = new Set(routes.map(routeKey));
    expect(EXPECTED_ROUTES.filter((key) => !registered.has(key))).toEqual([]);
  });

  it('serves the reminder task at the communications-reminders target path', () => {
    expect(toOpenApiPath(REMINDER_TASK_PATH)).toBe(QUEUES[REMINDER_QUEUE].targetPath);
  });

  it('names the drifting route when an operation, a route or a role differs', () => {
    const trimmed = structuredClone(DOC);
    delete (trimmed.paths['/healthz'] as Record<string, unknown>).get;
    expect(diffRouteSets(routes, contractOperations(trimmed))).toEqual({ undeclared: ['GET /healthz'], unregistered: [] });

    const withoutHealth = routes.filter((route) => route.url !== '/healthz');
    expect(diffRouteSets(withoutHealth, contractOperations(DOC))).toEqual({ undeclared: [], unregistered: ['GET /healthz'] });

    const relabelled = structuredClone(DOC);
    const templates = relabelled.paths['/v1/templates'] as Record<string, OperationObject>;
    templates.get = { ...(templates.get as OperationObject), 'x-opt2-requires': ['s2'] };
    expect(declarationMismatches(routes, contractOperations(relabelled))).toEqual([expect.stringMatching(/^GET \/v1\/templates: /)]);
  });
});

describe('responses', () => {
  it('cover every contract operation with at least one case and a 2xx answer', () => {
    const ids = contractOperations(DOC).map(({ operationId }) => operationId ?? '');
    expect(Object.keys(CASES).sort()).toEqual([...ids].sort());
    const withoutSuccess = Object.entries(CASES).filter(([, cases]) => !cases.some(({ status }) => status >= 200 && status < 300));
    expect(withoutSuccess.map(([id]) => id)).toEqual([]);
  });

  let ctx: TestApp | undefined;

  afterEach(async () => {
    await ctx?.app.close();
    ctx = undefined;
  });

  const rows = Object.entries(CASES).flatMap(([operationId, cases]) => cases.map((c) => ({ operationId, title: `${c.name} (${String(c.status)})`, c })));

  it.each(rows)('$operationId $title', async ({ c }) => {
    const built = await buildTestApp();
    ctx = built;
    const seeded = await seed(built, c.seed ?? []);
    await c.setup?.(built, seeded);
    const answer = await sendCase(built, c, seeded);
    c.verify?.(answer, built, seeded);
  });
});
