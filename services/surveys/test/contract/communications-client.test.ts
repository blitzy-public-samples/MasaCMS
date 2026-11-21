// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of surveys on communications (seam 2): the scheduled-task list, the only read of a survey's task state, and the launch-done report. */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  Roles,
  createLocalInvocationVerifier,
  createServiceTransport,
  hasAnyRole,
  serviceRole,
  type AuthResult,
} from '@opt2/platform/auth';
import { currentRequestContext, type FastifyInstance, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { CLOUD_TASKS_HEADERS, queueDefinition, targetUrl, taskWireBody } from '@opt2/platform/tasks';
import {
  ContractAssertionError,
  TENANT_A,
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  findOperation,
  mintTasksInvokerToken,
  testSigningKeys,
  testVerifier,
  type OperationMatch,
} from '@opt2/platform/testing';
import { FIXTURE_TASK_STATUS, type ScheduledTaskRecord } from '../../src/legacy/tasks-view.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { referenceFixtureTaskList } from '../helpers/fixture-tasks.js';

type Json = Record<string, unknown>;

interface OpenApiDoc {
  info?: unknown;
  paths: Json;
  components?: unknown;
}

interface ParameterObject {
  name: string;
  in: string;
  required?: boolean;
  schema?: unknown;
}

/** One service call surveys made, its answer, and the user token the service client forwards with it. */
interface Exchange {
  req: ServiceRequest;
  res: ServiceResponse;
  userToken: string | undefined;
}

/** One request injected as the surveys manager, with the communications calls it made. */
interface Injected {
  url: string;
  headers: Record<string, string>;
  response: { statusCode: number; headers: Record<string, string | string[] | number | undefined>; body: string; json(): unknown };
  calls: Exchange[];
}

/** The rows of a fixture schedule answer that give each fixture task its offset. */
interface ScheduledSurvey {
  survey_id: string;
  schedule: { task_name: string };
  reminders: { task_name: string; offset_minutes: number }[];
}

async function loadContract(relative: string): Promise<OpenApiDoc> {
  return parse(await readFile(new URL(relative, import.meta.url), 'utf8')) as OpenApiDoc;
}

const commsDoc = await loadContract('../../../communications/contracts/openapi.yaml');
const ownDoc = await loadContract('../../contracts/openapi.yaml');

const COMMUNICATIONS = 'communications';
const SELF = 'surveys';
const SITE = 'tenant-a';
const LAUNCH_QUEUE = 'surveys-launch';
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630140509000' };
/** A launch a day after TEST_CLOCK with reminders 1 h and 2 h later, the schedule the recorder's default records describe. */
const SCHEDULE = { launchAt: '2026-07-01T12:00:00', reminders: [{ offsetMinutes: 60 }, { offsetMinutes: 120 }] };
const TASK_KIND = { 'survey-launch': 'launch', 'survey-reminder': 'reminder' } as const satisfies Record<
  ScheduledTaskRecord['kind'],
  'launch' | 'reminder'
>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `node` with local `#/…` references followed until a non-reference node. */
function deref(doc: OpenApiDoc, node: unknown): unknown {
  let current = node;
  const seen = new Set<string>();
  while (isRecord(current) && typeof current.$ref === 'string' && current.$ref.startsWith('#/') && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split('/')
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((parent, segment) => (isRecord(parent) ? parent[segment] : undefined), doc);
  }
  return current;
}

/** Declared query parameters of an operation, path-item ones first, references resolved. */
function queryParametersOf(doc: OpenApiDoc, match: OperationMatch): ParameterObject[] {
  const item = deref(doc, doc.paths[match.template]);
  const shared: unknown[] = isRecord(item) && Array.isArray(item.parameters) ? item.parameters : [];
  const own: unknown[] = Array.isArray(match.operation.parameters) ? match.operation.parameters : [];
  return [...shared, ...own].map((parameter) => deref(doc, parameter) as ParameterObject).filter((parameter) => parameter.in === 'query');
}

/** The operation's 200 `application/json` schema, references resolved; the document's own object, so a mutation edits it. */
function okSchemaOf(doc: OpenApiDoc, match: OperationMatch): Json {
  const ok = deref(doc, match.operation.responses?.['200']);
  const media = isRecord(ok) && isRecord(ok.content) ? ok.content['application/json'] : undefined;
  const schema = deref(doc, isRecord(media) ? media.schema : undefined);
  if (!isRecord(schema)) throw new Error(`${match.template} declares no 200 application/json schema`);
  return schema;
}

/** The schema of one record of the 200 body's `items`, the list surveys reads. */
function taskSchemaOf(doc: OpenApiDoc, match: OperationMatch): Json {
  const { properties } = okSchemaOf(doc, match);
  const items = deref(doc, isRecord(properties) ? properties.items : undefined);
  const task = deref(doc, isRecord(items) ? items.items : undefined);
  if (!isRecord(task)) throw new Error(`${match.template} declares no 200 items schema`);
  return task;
}

/** Communications' records in an answer, read as `listSurveyTasks` reads them. */
function recordsOf(call: Exchange): ScheduledTaskRecord[] {
  return (call.res.body as { items: ScheduledTaskRecord[] }).items;
}

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Validates the sent query against the operation's query parameters, as the 200 body of a derived one-operation probe document. */
function assertQueryMatches(doc: OpenApiDoc, match: OperationMatch, req: ServiceRequest): void {
  const declared = queryParametersOf(doc, match);
  const schema = {
    type: 'object',
    properties: Object.fromEntries(declared.map((parameter) => [parameter.name, parameter.schema ?? {}])),
    required: declared.filter((parameter) => parameter.required === true).map((parameter) => parameter.name),
    additionalProperties: false,
  };
  const probe = {
    openapi: '3.1.0',
    info: doc.info,
    paths: { [match.template]: { [req.method.toLowerCase()]: { responses: { '200': { content: { 'application/json': { schema } } } } } } },
    components: doc.components,
  };
  const sent = Object.fromEntries(Object.entries(req.query ?? {}).filter(([, value]) => value !== undefined));
  try {
    assertResponseMatchesOpenApi(probe, { method: req.method, path: req.path, status: 200, contentType: 'application/json', body: sent });
  } catch (err) {
    if (err instanceof ContractAssertionError) throw new ContractAssertionError(`query of ${req.method} ${match.template}`, err.errors);
    throw err;
  }
}

/** Asserts the operation is a role-declared service route whose `x-opt2-requires` the call's verified roles satisfy. */
function assertAdmitted(match: OperationMatch, roles: readonly string[]): void {
  const { template, operation } = match;
  expect(operation['x-opt2-public'], `${template} must declare roles, not x-opt2-public`).not.toBe(true);
  expect(operation['x-opt2-transport'], `${template} transport`).toBe('service');
  const requires = Array.isArray(operation['x-opt2-requires']) ? operation['x-opt2-requires'].map(String) : [];
  expect(requires, `${template} declares no x-opt2-requires`).not.toEqual([]);
  expect(hasAnyRole(roles, requires), `${template} requires ${requires.join(' | ')}; the call carries ${roles.join(', ')}`).toBe(true);
}

/** Validates communications' answer against the operation's declared response. */
function assertReplyMatches(doc: OpenApiDoc, { req, res }: Exchange): void {
  assertResponseMatchesOpenApi(doc, { method: req.method, path: req.path, status: res.status, contentType: 'application/json', body: res.body });
}

/** What communications' service transport verifies for a call `app` made: the forwarded user token, if any, and surveys' own invocation credential. */
async function admissionOf(app: FastifyInstance, call: Exchange): Promise<AuthResult> {
  const invocation = await app.opt2.auth.invocationMinter.headersFor({
    name: call.req.service,
    url: app.opt2.env.OPT2_SERVICE_URLS[call.req.service],
  });
  const transport = createServiceTransport({
    userVerifier: testVerifier().userVerifier,
    invocationVerifier: createLocalInvocationVerifier({ publicKey: (await testSigningKeys()).publicKey, callee: call.req.service }),
  });
  const authorization = call.userToken === undefined ? {} : { authorization: `Bearer ${call.userToken}` };
  return transport.authenticate({ headers: { ...invocation, ...authorization }, path: call.req.path }, { optional: false });
}

/** Records every call `app` makes in `exchanges`, with the user token its service client would forward. */
function recordExchanges(testApp: TestApp, exchanges: Exchange[]): void {
  testApp.app.opt2.client.request = async <T>(req: ServiceRequest): Promise<ServiceResponse<T>> => {
    const res = await testApp.client.request<T>(req);
    // As the service client does: an unset userToken forwards the request context's verified token.
    const userToken = req.userToken === undefined ? currentRequestContext()?.userToken : (req.userToken ?? undefined);
    exchanges.push({ req, res, userToken });
    return res;
  };
}

/** Every check of one call against `doc`: declared literal path, query, admission and reply. */
function assertCallMatches(doc: OpenApiDoc, call: Exchange, roles: readonly string[]): void {
  const match = findOperation(doc, call.req.method, call.req.path);
  expect(match.template).toBe(call.req.path);
  assertQueryMatches(doc, match, call.req);
  assertAdmitted(match, roles);
  assertReplyMatches(doc, call);
}

type Mutation = [string, (doc: OpenApiDoc, match: OperationMatch) => void, RegExp];

/** Changes to communications' contract that each must break the call surveys makes, with the finding each produces. */
const MUTATIONS: Mutation[] = [
  [
    'the operation moved to another path',
    (doc, { template }) => {
      doc.paths[template.replace('/v1/', '/v2/')] = doc.paths[template];
      delete doc.paths[template];
    },
    /no operation for GET/,
  ],
  [
    'an extra required query parameter',
    (_doc, { operation }) => {
      const parameters: unknown[] = Array.isArray(operation.parameters) ? operation.parameters : [];
      operation.parameters = [...parameters, { name: 'siteid', in: 'query', required: true, schema: { type: 'string' } }];
    },
    /required property 'siteid'/,
  ],
  [
    'sourceId renamed',
    (doc, match) => {
      for (const parameter of queryParametersOf(doc, match)) {
        if (parameter.name === 'sourceId') parameter.name = 'sourceID';
      }
    },
    /required property 'sourceID'/,
  ],
  [
    'sourceType no longer accepting survey',
    (doc, match) => {
      for (const parameter of queryParametersOf(doc, match)) {
        if (parameter.name === 'sourceType') parameter.schema = { type: 'string', enum: ['campaign'] };
      }
    },
    /sourceType must be equal to one of the allowed values/,
  ],
  [
    'a required role surveys does not carry',
    (_doc, { operation }) => {
      operation['x-opt2-requires'] = [serviceRole('reporting')];
    },
    /requires service:reporting/,
  ],
  [
    'a public route instead of declared roles',
    (_doc, { operation }) => {
      delete operation['x-opt2-requires'];
      operation['x-opt2-public'] = true;
    },
    /must declare roles, not x-opt2-public/,
  ],
  [
    'another transport',
    (_doc, { operation }) => {
      operation['x-opt2-transport'] = 'cloud-tasks';
    },
    /transport: expected 'cloud-tasks' to be 'service'/,
  ],
  [
    'the 200 task list renamed',
    (doc, match) => {
      const list = okSchemaOf(doc, match);
      const properties = list.properties as Json;
      properties.tasks = properties.items;
      delete properties.items;
      list.required = (list.required as string[]).map((name) => (name === 'items' ? 'tasks' : name));
    },
    /required property 'tasks'/,
  ],
  [
    'a new required task field',
    (doc, match) => {
      const task = taskSchemaOf(doc, match);
      task.required = [...(task.required as string[]), 'tenantId'];
    },
    /required property 'tenantId'/,
  ],
  [
    'the page limit no longer declared',
    (doc, { operation }) => {
      const parameters: unknown[] = Array.isArray(operation.parameters) ? operation.parameters : [];
      operation.parameters = parameters.filter((parameter) => (deref(doc, parameter) as ParameterObject).name !== 'limit');
    },
    /must NOT have additional properties/,
  ],
  [
    'the task name filter no longer declared',
    (doc, { operation }) => {
      const parameters: unknown[] = Array.isArray(operation.parameters) ? operation.parameters : [];
      operation.parameters = parameters.filter((parameter) => (deref(doc, parameter) as ParameterObject).name !== 'taskName');
    },
    /must NOT have additional properties/,
  ],
  [
    'the task name filter holding fewer names than a batch',
    (doc, match) => {
      for (const parameter of queryParametersOf(doc, match)) {
        if (parameter.name === 'taskName') parameter.schema = { ...(parameter.schema as Json), maxItems: 2 };
      }
    },
    /taskName must NOT have more than 2 items/,
  ],
  [
    'the next cursor no longer declared',
    (doc, match) => {
      const list = okSchemaOf(doc, match);
      delete (list.properties as Json).next;
      list.required = (list.required as string[]).filter((name) => name !== 'next');
    },
    /must NOT have additional properties/,
  ],
];

describe('surveys as a consumer of communications scheduled tasks', () => {
  let testApp: TestApp;
  const exchanges: Exchange[] = [];
  let scheduled: ScheduledSurvey;
  let fixture: Injected;
  let v1: Injected;
  let admitted: AuthResult;
  let roles: string[];

  /** The single communications call `injected` made. */
  function onlyCall(injected: Injected): Exchange {
    expect(injected.calls, `${injected.url} calls communications once`).toHaveLength(1);
    return injected.calls[0] as Exchange;
  }

  /** Injects a request as the surveys manager; a write carries a JSON body and CSRF tokens. */
  async function inject(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<Injected> {
    const write = payload === undefined ? {} : { ...CSRF_HEADERS, 'content-type': 'application/json' };
    const headers = { ...(await headersFor(Roles.surveysManager, { site: SITE })), ...write };
    const start = exchanges.length;
    const response = await testApp.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
    return { url, headers, response, calls: exchanges.slice(start).filter((call) => call.req.service === COMMUNICATIONS) };
  }

  beforeAll(async () => {
    testApp = await buildTestApp();
    const { app } = testApp;
    recordExchanges(testApp, exchanges);

    const created = await inject('POST', `${FIXTURE_BASE}?siteid=${SITE}`, { title: 'Pulse' });
    const surveyId = (created.response.json() as { data: { survey_id: string } }).data.survey_id;
    const schedule = await inject('POST', `${FIXTURE_BASE}/${surveyId}/schedule?siteid=${SITE}`, SCHEDULE);
    scheduled = (schedule.response.json() as { data: ScheduledSurvey }).data;
    fixture = await inject('GET', `${FIXTURE_BASE}/${surveyId}/tasks?siteid=${SITE}`);
    v1 = await inject('GET', `/v1/surveys/${surveyId}/tasks?siteid=${SITE}`);
    admitted = await admissionOf(app, onlyCall(fixture));
    roles = [...new Set([...(admitted.user?.roles ?? []), ...(admitted.service?.roles ?? [])])];
  });

  afterAll(async () => {
    await testApp?.app.close();
  });

  describe('request', () => {
    it('surveys requests scheduled tasks with the declared query', () => {
      const { req } = onlyCall(fixture);
      const match = findOperation(commsDoc, req.method, req.path);

      expect(req).toMatchObject({ service: COMMUNICATIONS, method: 'GET' });
      expect(match.template).toBe(req.path);
      assertQueryMatches(commsDoc, match, req);
      expect(req.query).toEqual({
        sourceType: 'survey',
        sourceId: scheduled.survey_id,
        limit: '1000',
        taskName: [scheduled.schedule.task_name, ...scheduled.reminders.map((reminder) => reminder.task_name)],
      });
      const sourceType = queryParametersOf(commsDoc, match).find((parameter) => parameter.name === 'sourceType');
      const allowed = isRecord(sourceType?.schema) ? sourceType.schema.enum : undefined;
      expect(Array.isArray(allowed) ? allowed : ['survey']).toContain('survey');
    });

    it("both task lists send the same request, the fixture list naming the survey's own tasks", () => {
      const { taskName, ...unnamed } = onlyCall(fixture).req.query ?? {};

      expect(taskName).toHaveLength(1 + scheduled.reminders.length);
      expect(onlyCall(v1).req).toEqual({ ...onlyCall(fixture).req, query: unnamed });
      assertCallMatches(commsDoc, onlyCall(v1), roles);
    });

    it("a paged /v1 task list forwards its limit, then communications' next cursor as after, as the contract declares them", async () => {
      const first = await inject('GET', `/v1/surveys/${scheduled.survey_id}/tasks?siteid=${SITE}&limit=1`);
      const next = (first.response.json() as { next: string | null }).next;
      const second = await inject('GET', `/v1/surveys/${scheduled.survey_id}/tasks?siteid=${SITE}&limit=2&after=${next ?? ''}`);

      expect(onlyCall(first).req.query).toEqual({ sourceType: 'survey', sourceId: scheduled.survey_id, limit: '1' });
      expect(next).toBe((onlyCall(first).res.body as { next: string | null }).next);
      expect(onlyCall(second).req.query).toEqual({ sourceType: 'survey', sourceId: scheduled.survey_id, limit: '2', after: next });
      for (const injected of [first, second]) assertCallMatches(commsDoc, onlyCall(injected), roles);
      expect([...recordsOf(onlyCall(first)), ...recordsOf(onlyCall(second))]).toEqual(recordsOf(onlyCall(v1)));
    });

    it("forwards the caller's user token with surveys' invocation credential, which communications admits", () => {
      for (const injected of [fixture, v1]) {
        expect(onlyCall(injected).userToken, injected.url).toBe(injected.headers.authorization?.replace(/^Bearer /, ''));
      }
      expect(admitted.userToken).toBe(onlyCall(fixture).userToken);
      expect(admitted.service).toMatchObject({ name: SELF, roles: expect.arrayContaining([serviceRole(SELF)]) });
      assertAdmitted(findOperation(commsDoc, onlyCall(fixture).req.method, onlyCall(fixture).req.path), roles);
    });
  });

  describe('reply', () => {
    it("default reply validates against communications' 200 schema", () => {
      for (const injected of [fixture, v1]) {
        const call = onlyCall(injected);
        expect(call.res.status).toBe(200);
        expect(recordsOf(call)).not.toEqual([]);
        assertReplyMatches(commsDoc, call);
      }
    });

    it('rejects a reply whose task lacks any field the 200 schema requires', () => {
      const call = onlyCall(fixture);
      const required = taskSchemaOf(commsDoc, findOperation(commsDoc, call.req.method, call.req.path)).required as string[];
      expect(required).not.toEqual([]);

      for (const field of required) {
        const body = structuredClone(call.res.body) as { items: Json[] };
        delete (body.items[0] as Json)[field];
        const error = thrownBy(() => assertReplyMatches(commsDoc, { ...call, res: { ...call.res, body } }));

        expect(error, field).toBeInstanceOf(ContractAssertionError);
        expect((error as ContractAssertionError).errors, field).toContainEqual(
          expect.objectContaining({ instancePath: '/items/0', keyword: 'required' }),
        );
      }
    });
  });

  describe('parse', () => {
    it('fixture task list keeps one item per listed record, traced by name, kind and offset', () => {
      const records = recordsOf(onlyCall(fixture));
      const offsets = new Map<string, number>([
        [scheduled.schedule.task_name, 0],
        ...scheduled.reminders.map((reminder): [string, number] => [reminder.task_name, reminder.offset_minutes]),
      ]);
      const listed = records.filter((record) => FIXTURE_TASK_STATUS[record.status] === 'listed' && offsets.has(record.taskName));
      const items = referenceFixtureTaskList(records, { surveyId: scheduled.survey_id, schedule: scheduled.schedule, reminders: scheduled.reminders });

      expect(listed).toHaveLength(records.length);
      expect(items).toHaveLength(listed.length);
      for (const record of listed) {
        expect(items.filter((item) => item.taskname === record.taskName)).toEqual([
          expect.objectContaining({ kind: TASK_KIND[record.kind], offsetminutes: offsets.get(record.taskName) }),
        ]);
      }
      const body = assertResponseMatchesOpenApi(ownDoc, {
        method: 'GET',
        path: fixture.url,
        status: fixture.response.statusCode,
        contentType: fixture.response.headers['content-type'],
        body: fixture.response.body,
      }) as { data: { items: unknown[] } };
      expect(body.data.items).toEqual(items);
    });

    it("/v1 task views carry each record's name, kind, schedule time and status as ScheduledTaskView", () => {
      const records = recordsOf(onlyCall(v1));
      const body = assertResponseMatchesOpenApi(ownDoc, {
        method: 'GET',
        path: v1.url,
        status: v1.response.statusCode,
        contentType: v1.response.headers['content-type'],
        body: v1.response.body,
      }) as { data: unknown[] };

      expect(body.data).toEqual(
        records.map((record) => ({
          taskName: record.taskName,
          kind: TASK_KIND[record.kind],
          scheduleTime: record.scheduleTime,
          status: record.status,
        })),
      );
    });

    it('gives every status communications may return a fixture disposition, dropping only the deleted ones', () => {
      const call = onlyCall(fixture);
      const status = (taskSchemaOf(commsDoc, findOperation(commsDoc, call.req.method, call.req.path)).properties as Json).status;
      const statuses = (isRecord(status) && Array.isArray(status.enum) ? status.enum : []) as ScheduledTaskRecord['status'][];
      const [launch] = recordsOf(call);
      if (launch === undefined) throw new Error('the default reply holds no launch record');

      expect([...statuses].sort()).toEqual(Object.keys(FIXTURE_TASK_STATUS).sort());
      for (const value of statuses) {
        const record: ScheduledTaskRecord = { ...launch, status: value };
        assertReplyMatches(commsDoc, { ...call, res: { ...call.res, body: { ...(call.res.body as Json), items: [record] } } });
        const items = referenceFixtureTaskList([record], { surveyId: scheduled.survey_id, schedule: scheduled.schedule, reminders: [] });

        expect(items, value).toHaveLength(FIXTURE_TASK_STATUS[value] === 'listed' ? 1 : 0);
      }
    });
  });

  describe("communications' contract", () => {
    it('accepts the call surveys makes as the contract stands', () => {
      expect(() => assertCallMatches(commsDoc, onlyCall(fixture), roles)).not.toThrow();
    });

    it.each(MUTATIONS)('rejects a communications contract with %s', (_change, mutate, finding) => {
      const call = onlyCall(fixture);
      const doc = structuredClone(commsDoc);
      mutate(doc, findOperation(doc, call.req.method, call.req.path));

      expect(() => assertCallMatches(doc, call, roles)).toThrow(finding);
    });
  });
});

/** The operation's `application/json` request body schema, references resolved; the document's own object, so a mutation edits it. */
function requestSchemaOf(doc: OpenApiDoc, match: OperationMatch): Json {
  const body = deref(doc, match.operation.requestBody);
  const media = isRecord(body) && isRecord(body.content) ? body.content['application/json'] : undefined;
  const schema = deref(doc, isRecord(media) ? media.schema : undefined);
  if (!isRecord(schema)) throw new Error(`${match.template} declares no application/json request body schema`);
  return schema;
}

/** Every check of the launch-done report against `doc`: its operation, path and body, admission and reply. */
function assertLaunchDoneMatches(doc: OpenApiDoc, call: Exchange, roles: readonly string[]): void {
  const match = findOperation(doc, call.req.method, call.req.path);
  expect(match.operation.operationId).toBe('markSurveyLaunchTaskDone');
  assertRequestMatchesOpenApi(doc, { method: call.req.method, path: call.req.path, contentType: 'application/json', body: call.req.json });
  assertAdmitted(match, roles);
  assertReplyMatches(doc, call);
}

/** Changes to communications' contract that each must break the launch-done report surveys sends. */
const LAUNCH_DONE_MUTATIONS: Mutation[] = [
  [
    'the operation moved to another path',
    (doc, { template }) => {
      doc.paths[template.replace('/survey-launches/', '/launches/')] = doc.paths[template];
      delete doc.paths[template];
    },
    /no operation for POST/,
  ],
  [
    'queueTaskName renamed',
    (doc, match) => {
      const body = requestSchemaOf(doc, match);
      const properties = body.properties as Json;
      properties.taskName = properties.queueTaskName;
      delete properties.queueTaskName;
      body.required = (body.required as string[]).map((name) => (name === 'queueTaskName' ? 'taskName' : name));
    },
    /required property 'taskName'/,
  ],
  [
    'a new required body field',
    (doc, match) => {
      const body = requestSchemaOf(doc, match);
      body.required = [...(body.required as string[]), 'siteId'];
    },
    /required property 'siteId'/,
  ],
  [
    'a required role surveys does not carry',
    (_doc, { operation }) => {
      operation['x-opt2-requires'] = [serviceRole('reporting')];
    },
    /requires service:reporting/,
  ],
  [
    'the 200 outcome renamed',
    (doc, match) => {
      const result = okSchemaOf(doc, match);
      const properties = result.properties as Json;
      properties.recorded = properties.applied;
      delete properties.applied;
      result.required = ['recorded'];
    },
    /required property 'recorded'/,
  ],
];

describe("surveys as the caller of communications' launch-done report", () => {
  let testApp: TestApp;
  let surveyId: string;
  let call: Exchange;
  let roles: string[];

  beforeAll(async () => {
    testApp = await buildTestApp();
    const { app } = testApp;
    const exchanges: Exchange[] = [];
    recordExchanges(testApp, exchanges);
    const headers = { ...(await headersFor(Roles.surveysManager, { site: SITE })), ...CSRF_HEADERS, 'content-type': 'application/json' };
    const asManager = (url: string, body: unknown) => app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) });
    const created = await asManager(`${FIXTURE_BASE}?siteid=${SITE}`, { title: 'Pulse' });
    expect(created.statusCode, created.body).toBe(200);
    surveyId = (created.json() as { data: { survey_id: string } }).data.survey_id;
    const scheduled = await asManager(`${FIXTURE_BASE}/${surveyId}/schedule?siteid=${SITE}`, SCHEDULE);
    expect(scheduled.statusCode, scheduled.body).toBe(200);

    // The launch task as communications queues it and the local tasks adapter delivers it.
    const queue = queueDefinition(LAUNCH_QUEUE);
    const url = new URL(targetUrl(queue, app.opt2.env.OPT2_SERVICE_URLS));
    const task = taskWireBody({
      queue: LAUNCH_QUEUE,
      name: `opt2-survey-${surveyId}-launch-v1`,
      scheduleTime: testApp.clock.now(),
      url: url.href,
      deadlineS: queue.deadlineS,
      tenantId: TENANT_A.tenantId,
      body: { surveyId, siteId: SITE, scheduleVersion: 1 },
    });
    const start = exchanges.length;
    const launched = await app.inject({
      method: 'POST',
      url: url.pathname,
      headers: {
        authorization: `Bearer ${await mintTasksInvokerToken({ audience: SELF })}`,
        [CLOUD_TASKS_HEADERS.taskName]: task.name,
        [CLOUD_TASKS_HEADERS.queueName]: task.queue,
      },
      payload: { ...task },
    });
    expect(launched.statusCode, launched.body).toBe(200);
    const calls = exchanges.slice(start).filter((exchange) => exchange.req.service === COMMUNICATIONS);
    expect(calls).toHaveLength(1);
    call = calls[0] as Exchange;
    const admitted = await admissionOf(app, call);
    roles = [...new Set([...(admitted.user?.roles ?? []), ...(admitted.service?.roles ?? [])])];
  });

  afterAll(async () => {
    await testApp?.app.close();
  });

  it('reports the queue task the launch ran under, with its tenant and schedule version and no user token', () => {
    expect(call.req).toEqual({
      service: COMMUNICATIONS,
      method: 'POST',
      path: `/internal/v1/scheduled-tasks/survey-launches/${surveyId}/done`,
      json: { tenantId: TENANT_A.tenantId, queueTaskName: `opt2-survey-${surveyId}-launch-v1`, scheduleVersion: 1 },
      userToken: null,
    });
    expect(call.userToken).toBeUndefined();
  });

  it("sends a report communications' contract declares, admits under surveys' invocation credential and answers as the reply", () => {
    expect(roles).toContain(serviceRole(SELF));
    expect(() => assertLaunchDoneMatches(commsDoc, call, roles)).not.toThrow();
  });

  it.each(LAUNCH_DONE_MUTATIONS)('rejects a communications contract with %s', (_change, mutate, finding) => {
    const doc = structuredClone(commsDoc);
    mutate(doc, findOperation(doc, call.req.method, call.req.path));

    expect(() => assertLaunchDoneMatches(doc, call, roles)).toThrow(finding);
  });
});
