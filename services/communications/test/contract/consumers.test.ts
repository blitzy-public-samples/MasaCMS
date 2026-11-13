// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contracts of communications: the three topics it consumes against their producers' schemas, and its call of surveys' markReminderSent. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { serviceRole } from '@opt2/platform/auth';
import { taskWireBody } from '@opt2/platform/tasks';
import { SITE_CHANGED_TOPIC } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  TENANT_A,
  assertProducerConsumerCompatible,
  assertResponseMatchesOpenApi,
  findOperation,
  mintTasksInvokerToken,
  pushTo,
  registryPayloads,
  type ConsumerExpectation,
  type ContractViolation,
  type JsonType,
  type OperationMatch,
} from '@opt2/platform/testing';
import {
  LOGIN_MAIL_SUBSCRIPTION,
  SITE_CHANGED_SUBSCRIPTION,
  SURVEY_SCHEDULED_SUBSCRIPTION,
  siteChangedSchema,
} from '../../src/events/consumers.js';
import { LOGIN_MAIL_TOPIC, loginMailSchema, type LoginMailRequestedPayload } from '../../src/events/login-mail.js';
import { SURVEY_SCHEDULED_TOPIC, surveyScheduledSchema, type SurveyScheduledPayload } from '../../src/events/survey-scheduled.js';
import { REMINDER_SENT_MATCH, buildTestApp, type TestApp } from '../helpers/app.js';
import {
  PRODUCER_SCHEMA_URLS,
  SAMPLE_IDS,
  envelopeFor,
  loginMailPayload,
  producerValidator,
  siteChangedPayload,
  surveyScheduledPayload,
  type ProducerTopic,
} from '../helpers/payloads.js';

type Json = Record<string, unknown>;
type Mutation = (schema: Json) => void;

interface OpenApiDoc {
  info?: unknown;
  paths: Json;
  components?: unknown;
  'x-opt2-calls'?: unknown;
}

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };

async function loadContract(relative: string): Promise<OpenApiDoc> {
  return load(await readFile(new URL(relative, import.meta.url), 'utf8')) as OpenApiDoc;
}

const ownDoc = await loadContract('../../contracts/openapi.yaml');
const surveysDoc = await loadContract('../../../surveys/contracts/openapi.yaml');

async function producerSchemaOf(topic: ProducerTopic): Promise<Json> {
  return JSON.parse(await readFile(PRODUCER_SCHEMA_URLS[topic], 'utf8')) as Json;
}

const PRODUCERS: Readonly<Record<ProducerTopic, Json>> = {
  [LOGIN_MAIL_TOPIC]: await producerSchemaOf(LOGIN_MAIL_TOPIC),
  [SURVEY_SCHEDULED_TOPIC]: await producerSchemaOf(SURVEY_SCHEDULED_TOPIC),
  [SITE_CHANGED_TOPIC]: await producerSchemaOf(SITE_CHANGED_TOPIC),
};

const SITE = TENANT_A.siteId;
const REMINDER_QUEUE = 'communications-reminders';

/** Every login-mail field communications stores or sends, with the JSON type it relies on. */
const LOGIN_MAIL_FIELDS = {
  messageId: 'string',
  siteId: 'string',
  to: 'string',
  from: 'string',
  subject: 'string',
  text: 'string',
} as const satisfies Partial<Record<keyof LoginMailRequestedPayload, JsonType>>;

/** Every survey-schedule field the seam 2 consumer plans tasks from. */
const SURVEY_FIELDS = {
  surveyId: 'string',
  siteId: 'string',
  scheduleVersion: 'integer',
  launchAt: 'string',
  launchTaskName: 'string',
  reminders: 'array',
} as const satisfies Partial<Record<keyof SurveyScheduledPayload, JsonType>>;

/** Every reminder field a reminder task is planned from. */
const REMINDER_FIELDS = { n: 'integer', offsetMinutes: 'integer', taskName: 'string' } as const;

/** Every registry field the platform site-registry consumer stores. */
const REGISTRY_FIELDS = {
  siteId: 'string',
  publicUserPoolId: 'string',
  privateUserPoolId: 'string',
  categoryPoolId: 'string',
  filePoolId: 'string',
  displayPoolId: 'string',
  contentPoolIds: 'array',
  domains: 'array',
} as const;

/** The payloads communications is tested with, per topic; each must satisfy its producer's schema. */
const SAMPLES: Readonly<Record<ProducerTopic, unknown[]>> = {
  [LOGIN_MAIL_TOPIC]: [loginMailPayload(), loginMailPayload({ kind: 'send-login', bcc: '' })],
  [SURVEY_SCHEDULED_TOPIC]: [surveyScheduledPayload(1), surveyScheduledPayload(2)],
  [SITE_CHANGED_TOPIC]: registryPayloads(),
};

const EXPECTATIONS: Readonly<Record<ProducerTopic, ConsumerExpectation>> = {
  [LOGIN_MAIL_TOPIC]: {
    required: Object.keys(LOGIN_MAIL_FIELDS),
    types: LOGIN_MAIL_FIELDS,
    samples: SAMPLES[LOGIN_MAIL_TOPIC],
    kind: 'process',
  },
  [SURVEY_SCHEDULED_TOPIC]: {
    required: Object.keys(SURVEY_FIELDS),
    types: SURVEY_FIELDS,
    itemTypes: { reminders: 'object' },
    samples: SAMPLES[SURVEY_SCHEDULED_TOPIC],
    kind: 'process',
  },
  [SITE_CHANGED_TOPIC]: {
    required: Object.keys(REGISTRY_FIELDS),
    types: REGISTRY_FIELDS,
    itemTypes: { contentPoolIds: 'string', domains: 'string' },
    samples: SAMPLES[SITE_CHANGED_TOPIC],
    kind: 'state',
  },
};

/** The schema each consumer validates deliveries against, as communications registers it. */
const CONSUMER_SCHEMAS: Readonly<Record<ProducerTopic, object>> = {
  [LOGIN_MAIL_TOPIC]: loginMailSchema,
  [SURVEY_SCHEDULED_TOPIC]: surveyScheduledSchema,
  [SITE_CHANGED_TOPIC]: siteChangedSchema,
};

const SUBSCRIPTIONS: Readonly<Record<ProducerTopic, string>> = {
  [LOGIN_MAIL_TOPIC]: LOGIN_MAIL_SUBSCRIPTION,
  [SURVEY_SCHEDULED_TOPIC]: SURVEY_SCHEDULED_SUBSCRIPTION,
  [SITE_CHANGED_TOPIC]: SITE_CHANGED_SUBSCRIPTION,
};

const TOPICS = Object.keys(PRODUCERS) as ProducerTopic[];

/** A mutated copy of a producer schema; `$id` is dropped because the shared Ajv registry already holds the original under it. */
function mutatedProducer(topic: ProducerTopic, mutate: Mutation): Json {
  const copy = structuredClone(PRODUCERS[topic]);
  delete copy.$id;
  mutate(copy);
  return copy;
}

function withoutRequired(field: string): Mutation {
  return (schema) => {
    schema.required = (schema.required as string[]).filter((name) => name !== field);
  };
}

function retyped(field: string, type: string): Mutation {
  return (schema) => {
    const properties = schema.properties as Record<string, Json>;
    properties[field] = { type };
  };
}

/** The reminder item schema of the survey-schedule producer, standalone with the producer's `$defs`. */
function reminderItemSchema(schema: Json = PRODUCERS[SURVEY_SCHEDULED_TOPIC]): Json {
  const items = ((schema.properties as Record<string, Json>).reminders as Json).items as Json;
  const ref = typeof items.$ref === 'string' ? items.$ref.replace(/^#\/\$defs\//, '') : undefined;
  const node = ref === undefined ? items : ((schema.$defs as Record<string, Json>)[ref] as Json);
  return { ...node, $defs: schema.$defs };
}

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('topics communications consumes, against their producers', () => {
  it.each(TOPICS)("%s: the consumer validates against the producer's file", (topic) => {
    expect(CONSUMER_SCHEMAS[topic]).toStrictEqual(PRODUCERS[topic]);
  });

  it.each(TOPICS)('%s: subscribes as communications.<topic>', (topic) => {
    expect(SUBSCRIPTIONS[topic]).toBe(`communications.${topic}`);
  });

  it.each(TOPICS)('%s: the producer schema supplies every field communications reads, and accepts every sample', (topic) => {
    expect(() => assertProducerConsumerCompatible(PRODUCERS[topic], EXPECTATIONS[topic])).not.toThrow();
    for (const sample of SAMPLES[topic]) expect(producerValidator(topic).validatePayload(sample).ok).toBe(true);
  });

  it.each(TOPICS)('%s: declares no tenant fan-out, so deliveries apply in the envelope tenant only', (topic) => {
    expect(PRODUCERS[topic]).not.toHaveProperty(['x-opt2-tenant-fanout']);
  });

  it('survey.scheduled: each reminder supplies the ordinal, offset and task name a reminder task is planned from', () => {
    expect(() =>
      assertProducerConsumerCompatible(reminderItemSchema(), { required: Object.keys(REMINDER_FIELDS), types: REMINDER_FIELDS }),
    ).not.toThrow();
  });

  it('survey.scheduled: declares that a later schedule version supersedes an earlier one', () => {
    expect(PRODUCERS[SURVEY_SCHEDULED_TOPIC]['x-opt2-supersedes']).toBe(true);
  });

  it.each<[ProducerTopic, string, Mutation, ContractViolation['instancePath'], ContractViolation['keyword']]>([
    [LOGIN_MAIL_TOPIC, 'an optional recipient', withoutRequired('to'), '/to', 'required'],
    [LOGIN_MAIL_TOPIC, 'a numeric message id', retyped('messageId', 'number'), '/messageId', 'type'],
    [LOGIN_MAIL_TOPIC, 'a state kind', (schema) => void (schema['x-opt2-kind'] = 'state'), '', 'x-opt2-kind'],
    [SURVEY_SCHEDULED_TOPIC, 'an optional launch time', withoutRequired('launchAt'), '/launchAt', 'required'],
    [SURVEY_SCHEDULED_TOPIC, 'a string schedule version', retyped('scheduleVersion', 'string'), '/scheduleVersion', 'type'],
    [
      SURVEY_SCHEDULED_TOPIC,
      'a state kind',
      // A state topic cannot also declare supersedes, so the mutation drops it to stay a well-formed topic schema.
      (schema) => {
        schema['x-opt2-kind'] = 'state';
        delete schema['x-opt2-supersedes'];
      },
      '',
      'x-opt2-kind',
    ],
    [SITE_CHANGED_TOPIC, 'an optional public user pool', withoutRequired('publicUserPoolId'), '/publicUserPoolId', 'required'],
    [SITE_CHANGED_TOPIC, 'a process kind', (schema) => void (schema['x-opt2-kind'] = 'process'), '', 'x-opt2-kind'],
  ])('%s: rejects a producer schema with %s', (topic, _case, mutate, instancePath, keyword) => {
    const error = thrownBy(() => assertProducerConsumerCompatible(mutatedProducer(topic, mutate), EXPECTATIONS[topic]));
    expect(error).toBeInstanceOf(ContractAssertionError);
    expect((error as ContractAssertionError).errors).toContainEqual(expect.objectContaining({ instancePath, keyword }));
  });

  it('survey.scheduled: rejects a producer whose reminders drop the task name', () => {
    const schema = mutatedProducer(SURVEY_SCHEDULED_TOPIC, () => undefined);
    const item = reminderItemSchema(schema);
    item.required = (item.required as string[]).filter((name) => name !== 'taskName');
    const error = thrownBy(() => assertProducerConsumerCompatible(item, { required: Object.keys(REMINDER_FIELDS), types: REMINDER_FIELDS }));
    expect(error).toBeInstanceOf(ContractAssertionError);
    expect((error as ContractAssertionError).errors).toContainEqual(expect.objectContaining({ instancePath: '/taskName', keyword: 'required' }));
  });
});

describe('producer-valid deliveries through the push routes', () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.app.close();
    t = undefined;
  });

  it('stores and sends a send-login mail of the global configuration, its site empty', async () => {
    t = await buildTestApp();
    const payload = loginMailPayload({ siteId: '', kind: 'send-login', from: '' });
    expect(producerValidator(LOGIN_MAIL_TOPIC).validatePayload(payload).ok).toBe(true);
    const res = await pushTo(t.app, LOGIN_MAIL_SUBSCRIPTION, envelopeFor(LOGIN_MAIL_TOPIC, payload));
    expect(res.statusCode, res.body).toBe(204);
    expect(t.publisher.deadLetters(LOGIN_MAIL_SUBSCRIPTION)).toEqual([]);
    expect(t.db.rows('message')).toMatchObject([{ message_id: SAMPLE_IDS.messageId, siteid: '', source: 'login-mail' }]);
    expect(t.mail.sent.map((mail) => mail.to)).toEqual([payload.to]);
  });

  it('applies a reschedule once: version 2 supersedes the tasks of version 1, and a late version 1 changes nothing', async () => {
    t = await buildTestApp();
    const deliver = async (version: 1 | 2, aggregateVersion: number): Promise<void> => {
      const res = await pushTo(t!.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(version), { aggregateVersion }));
      expect(res.statusCode, res.body).toBe(204);
    };
    await deliver(1, 1);
    await deliver(2, 2);
    await deliver(1, 3);
    const rows = t.db.rows('scheduled_task');
    expect(rows.filter((row) => row.schedule_version === 1).map((row) => row.status)).toEqual(['superseded', 'superseded']);
    expect(rows.filter((row) => row.schedule_version === 2).map((row) => row.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(t.taskPort.byQueue(REMINDER_QUEUE).map(({ name }) => name)).toEqual([
      `opt2-survey-${SAMPLE_IDS.surveyId}-reminder-1-v2`,
      `opt2-survey-${SAMPLE_IDS.surveyId}-reminder-2-v2`,
    ]);
    expect(t.publisher.deadLetters(SURVEY_SCHEDULED_SUBSCRIPTION)).toEqual([]);
  });

  it('registers every fixture site the producer announces', async () => {
    t = await buildTestApp({ seedRegistry: false });
    for (const payload of registryPayloads()) {
      const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, envelopeFor(SITE_CHANGED_TOPIC, payload));
      expect(res.statusCode, res.body).toBe(204);
    }
    expect(t.db.rows('tenant_registry').map((row) => row.site_id).sort()).toEqual(registryPayloads().map(({ siteId }) => siteId).sort());
    expect(t.db.rows('tenant_registry').find((row) => row.site_id === SITE)).toMatchObject({ domains: siteChangedPayload(SITE).domains });
  });
});

/** `node` with local `#/…` references followed in `doc` until a non-reference node. */
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

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The operation's required `application/json` request-body schema. */
function requestSchemaOf(doc: OpenApiDoc, match: OperationMatch): unknown {
  const body = deref(doc, match.operation.requestBody);
  expect(isRecord(body) && body.required === true, `${match.template} declares a required request body`).toBe(true);
  const media = isRecord(body) && isRecord(body.content) ? body.content['application/json'] : undefined;
  return isRecord(media) ? media.schema : undefined;
}

/** Validates `value` against `schema`, resolved in `doc`, as the 200 JSON body of a one-operation probe document. */
function assertSchemaMatches(doc: OpenApiDoc, path: string, schema: unknown, value: unknown): void {
  const probe = {
    openapi: '3.1.0',
    info: doc.info,
    paths: { [path]: { post: { responses: { '200': { content: { 'application/json': { schema } } } } } } },
    components: doc.components,
  };
  assertResponseMatchesOpenApi(probe, { method: 'POST', path, status: 200, contentType: 'application/json', body: value });
}

describe("communications' call of surveys markReminderSent (seam 2)", () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.app.close();
    t = undefined;
  });

  /** Builds the app, delivers the sample survey's schedule and runs its first reminder task as Cloud Tasks would. */
  async function runReminder(setup?: (ctx: TestApp) => void): Promise<{ status: number; body: unknown; ctx: TestApp }> {
    const ctx = await buildTestApp();
    t = ctx;
    const scheduled = await pushTo(ctx.app, SURVEY_SCHEDULED_SUBSCRIPTION, envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(1)));
    expect(scheduled.statusCode, scheduled.body).toBe(204);
    const task = ctx.taskPort.byQueue(REMINDER_QUEUE)[0];
    if (task === undefined) throw new TypeError('the schedule created no reminder task');
    setup?.(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: new URL(task.url).pathname,
      headers: { authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'communications' })}` },
      payload: { ...taskWireBody(task) },
    });
    return { status: res.statusCode, body: res.body === '' ? undefined : (JSON.parse(res.body) as unknown), ctx };
  }

  it('names surveys among the services its contract calls', () => {
    expect(ownDoc['x-opt2-calls']).toContain('surveys');
  });

  it("sends a request surveys' contract declares, authorises for communications and accepts", async () => {
    const { status, ctx } = await runReminder();
    expect(status).toBe(200);
    const [call, ...others] = ctx.client.requestsTo('surveys');
    expect(others).toEqual([]);
    if (call === undefined) throw new TypeError('no surveys call');
    const match = findOperation(surveysDoc, call.method, call.path);
    expect(match.operation).toMatchObject({
      operationId: 'markReminderSent',
      'x-opt2-transport': 'service',
      'x-opt2-requires': [serviceRole('communications')],
      security: [{ invocationCredential: [] }],
    });
    // The operation accepts the invocation credential alone, so the system task forwards no user token.
    expect(call.userToken).toBeNull();
    expect(() => assertSchemaMatches(surveysDoc, match.template, requestSchemaOf(surveysDoc, match), call.json)).not.toThrow();
    expect(call.json).toMatchObject({
      tenantId: TENANT_A.tenantId,
      siteId: SITE,
      taskName: `opt2-survey-${SAMPLE_IDS.surveyId}-reminder-1`,
      scheduleVersion: 1,
    });
  });

  it.each([true, false])("treats surveys' contract-valid 200 answer applied=%s as the reminder sent", async (applied) => {
    const answer = { applied };
    const match = findOperation(surveysDoc, 'POST', `/internal/v1/surveys/${SAMPLE_IDS.surveyId}/reminders/1/sent`);
    expect(() => assertResponseMatchesOpenApi(surveysDoc, { method: 'POST', path: match.template, status: 200, contentType: 'application/json', body: answer })).not.toThrow();
    const { status, body, ctx } = await runReminder((built) => built.client.respond(REMINDER_SENT_MATCH, 200, answer));
    expect({ status, body }).toEqual({ status: 200, body: { status: 'sent' } });
    expect(ctx.db.rows('scheduled_task').find((row) => row.kind === 'survey-reminder')?.status).toBe('done');
  });

  it.each([400, 404, 503])(
    'answers a declared surveys %i with the legacy 503, so the queue retries, and leaves the reminder scheduled',
    async (surveysStatus) => {
      expect(Object.keys(findOperation(surveysDoc, 'POST', `/internal/v1/surveys/${SAMPLE_IDS.surveyId}/reminders/1/sent`).operation.responses ?? {})).toContain(
        String(surveysStatus),
      );
      const { status, body, ctx } = await runReminder((built) => built.client.respond(REMINDER_SENT_MATCH, surveysStatus, {}));
      expect(status).toBe(503);
      const path = `/internal/v1/tasks/reminders/${String((ctx.db.rows('scheduled_task').find((row) => row.kind === 'survey-reminder') ?? {}).scheduled_task_id)}`;
      expect(() => assertResponseMatchesOpenApi(ownDoc, { method: 'POST', path, status, contentType: 'application/json', body })).not.toThrow();
      expect(ctx.db.rows('scheduled_task').find((row) => row.kind === 'survey-reminder')?.status).toBe('scheduled');
    },
  );
});
