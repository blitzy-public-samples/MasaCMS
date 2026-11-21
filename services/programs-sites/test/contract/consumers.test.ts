/** Consumer contracts of programs-sites: the strategies-content task routes and the migration operations the site-monitor dispatcher calls. */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { TASKS_INVOKER_ROLE, serviceRole } from '@opt2/platform/auth';
import type { ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { SITEMONITOR_QUEUE, queueDefinition, taskWireBody, type TaskPort } from '@opt2/platform/tasks';
import {
  ContractAssertionError,
  assertResponseMatchesOpenApi,
  findOperation,
  type OperationMatch,
} from '@opt2/platform/testing';
import {
  SiteMonitorDeadlineError,
  createMigrationJobsPort,
  createStepDispatcher,
  formatLegacyTime,
  type LegacyStepRequest,
  type MigrationJobsPort,
  type StepInvocation,
} from '../../src/jobs/dispatch.js';
import { SITE_MONITOR_STEPS, TARGET_CAPABLE_STEPS, stepNamed, type SiteMonitorStep, type SiteMonitorStepName } from '../../src/jobs/steps.js';
import {
  TEST_CLOCK,
  createClientRecorder,
  createFakeTaskPort,
  testEnv,
  type ClientRecorder,
  type RecordedServiceCall,
} from '../helpers/app.js';

interface OpenApiDoc {
  readonly info: unknown;
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components?: unknown;
}

interface ParameterObject {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly schema?: unknown;
}

interface Exchange {
  readonly req: ServiceRequest;
  readonly res: ServiceResponse;
}

const MIGRATION = 'migration';
const SITE = 'tenant-a';
const SELF_ROLE = serviceRole('programs-sites');
const SERVICE_URLS = JSON.parse(testEnv({ OPT2_STATE_DIR: undefined }).OPT2_SERVICE_URLS ?? '{}') as Record<string, string>;
const RUN_AT = TEST_CLOCK.now();
const LAST_MONITORED = new Date(RUN_AT.getTime() - 60_000);
const DEADLINE_AT = new Date(RUN_AT.getTime() + queueDefinition(SITEMONITOR_QUEUE).deadlineS * 1000);
const ALL_UNITS = [...new Set(SITE_MONITOR_STEPS.flatMap((step) => step.units))];
const noSleep = async (): Promise<void> => undefined;

/** Parses another package's OpenAPI contract. */
function loadContract(url: URL): OpenApiDoc {
  return parse(readFileSync(url, 'utf8')) as OpenApiDoc;
}

const contentDoc = loadContract(new URL('../../../strategies-content/contracts/openapi.yaml', import.meta.url));
const migrationDoc = loadContract(new URL('../../../../migration/contracts/openapi.yaml', import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
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

/** Operation serving `method` on `concretePath` (query string ignored), or undefined when the contract declares none. */
function operationFor(doc: OpenApiDoc, method: string, concretePath: string): OperationMatch | undefined {
  try {
    return findOperation(doc, method, concretePath);
  } catch (err) {
    if (err instanceof ContractAssertionError) return undefined;
    throw err;
  }
}

/** Declared parameters of an operation, path-item parameters first, references resolved. */
function parametersOf(doc: OpenApiDoc, match: OperationMatch): ParameterObject[] {
  const item = deref(doc, doc.paths[match.template]);
  const shared: unknown[] = isRecord(item) && Array.isArray(item.parameters) ? item.parameters : [];
  const own: unknown[] = Array.isArray(match.operation.parameters) ? match.operation.parameters : [];
  return [...shared, ...own].map((parameter) => deref(doc, parameter) as ParameterObject);
}

/** The operation's request body: whether it is required and its `application/json` schema; undefined when it declares none. */
function requestBodyOf(doc: OpenApiDoc, match: OperationMatch): { required: boolean; schema: unknown } | undefined {
  const body = deref(doc, match.operation.requestBody);
  if (!isRecord(body)) return undefined;
  const media = isRecord(body.content) ? body.content['application/json'] : undefined;
  return { required: body.required === true, schema: isRecord(media) ? media.schema : undefined };
}

const probes = new WeakMap<OpenApiDoc, Map<string, object>>();

/** Validates `value` against `schema`, resolved inside `doc`, as the 200 JSON body of a one-operation probe document. */
function assertSchemaMatches(
  doc: OpenApiDoc,
  match: OperationMatch,
  method: string,
  concretePath: string,
  part: string,
  schema: unknown,
  value: unknown,
): void {
  const verb = method.toLowerCase();
  const key = `${part} ${verb} ${match.template}`;
  const cache = probes.get(doc) ?? new Map<string, object>();
  probes.set(doc, cache);
  const probe = cache.get(key) ?? {
    openapi: '3.1.0',
    info: doc.info,
    paths: { [match.template]: { [verb]: { responses: { '200': { content: { 'application/json': { schema } } } } } } },
    components: doc.components,
  };
  cache.set(key, probe);
  try {
    assertResponseMatchesOpenApi(probe, { method, path: concretePath, status: 200, contentType: 'application/json', body: value });
  } catch (err) {
    if (err instanceof ContractAssertionError) throw new ContractAssertionError(`${part} of ${method.toUpperCase()} ${match.template}`, err.errors);
    throw err;
  }
}

/** Validates a request body against the operation's declared `application/json` request body. */
function assertRequestBodyMatches(doc: OpenApiDoc, match: OperationMatch, method: string, concretePath: string, body: unknown): void {
  const declared = requestBodyOf(doc, match);
  if (declared?.schema === undefined) {
    throw new ContractAssertionError(`request body of ${method.toUpperCase()} ${match.template}`, [
      { instancePath: '', message: 'the operation declares no application/json request body', keyword: 'requestBody' },
    ]);
  }
  assertSchemaMatches(doc, match, method, concretePath, 'request body', declared.schema, body);
}

/** Validates a request's query against the operation's query parameters; an undeclared parameter fails. */
function assertQueryMatches(doc: OpenApiDoc, match: OperationMatch, method: string, concretePath: string, query: Record<string, unknown>): void {
  const declared = parametersOf(doc, match).filter((parameter) => parameter.in === 'query');
  const schema = {
    type: 'object',
    properties: Object.fromEntries(declared.map((parameter) => [parameter.name, parameter.schema ?? {}])),
    required: declared.filter((parameter) => parameter.required === true).map((parameter) => parameter.name),
    additionalProperties: false,
  };
  assertSchemaMatches(doc, match, method, concretePath, 'query', schema, query);
}

/** Query parameters a recorded service call sent, unset ones dropped. */
function sentQuery(call: RecordedServiceCall): Record<string, unknown> {
  return Object.fromEntries(Object.entries(call.query ?? {}).filter(([, value]) => value !== undefined));
}

/** One dispatch of `step` in the shared run; per-site steps run for `tenant-a`. */
function invocation(step: SiteMonitorStep): StepInvocation {
  return {
    step,
    ...(step.perSite ? { siteId: SITE } : {}),
    theTime: RUN_AT,
    lastMonitored: LAST_MONITORED,
    runAt: RUN_AT,
    deadlineAt: DEADLINE_AT,
  };
}

/** Legacy-step request of `job` as the dispatcher builds it. */
function legacyRequest(job: SiteMonitorStepName): LegacyStepRequest {
  const step = stepNamed(job);
  return {
    job,
    theTime: formatLegacyTime(RUN_AT),
    lastMonitored: formatLegacyTime(LAST_MONITORED),
    ...(step.perSite ? { siteId: SITE } : {}),
    units: step.units,
  };
}

function dispatcherOver(port: TaskPort, migration: MigrationJobsPort) {
  return createStepDispatcher({ port, migration, serviceUrls: SERVICE_URLS, clock: TEST_CLOCK, sleep: noSleep, pollIntervalMs: 0 });
}

/** Client recorder whose answers are kept beside the requests they answered. */
function recordingClient(): { recorder: ClientRecorder; exchanges: Exchange[]; client: Pick<ServiceClient, 'request'> } {
  const recorder = createClientRecorder({}, { clock: TEST_CLOCK });
  const exchanges: Exchange[] = [];
  return {
    recorder,
    exchanges,
    client: {
      async request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
        const res = await recorder.request<T>(req);
        exchanges.push({ req, res });
        return res;
      },
    },
  };
}

describe('strategies-content task routes the site monitor creates', () => {
  // Both target-capable write sets hold legacy:tcontenteventreminders, a decision-list table the migration port never
  // reports target-authoritative, so this port stands for a cut-over in which every unit has moved.
  const everyUnitTarget: MigrationJobsPort = {
    unitsTargetAuthoritative: async () => true,
    runLegacyStep: () => Promise.reject(new Error('a target-authoritative step never runs on legacy')),
  };

  it('routes exactly the publish and feed-import steps to strategies-content, by path alone', () => {
    const targetPaths = SITE_MONITOR_STEPS.flatMap((step) => (step.targetPath === undefined ? [] : [step.targetPath])).sort();

    expect(targetPaths).toEqual(['/internal/v1/jobs/feed-auto-import', '/internal/v1/jobs/publish-scheduled-changesets']);
    expect(targetPaths.filter((targetPath) => targetPath.includes('?'))).toEqual([]);
    expect([...TARGET_CAPABLE_STEPS].sort()).toEqual(['feedAutoImport', 'publishScheduledChangesets']);
  });

  it.each(TARGET_CAPABLE_STEPS)('declares the %s route as a Cloud Tasks POST for the tasks invoker', (name) => {
    const targetPath = stepNamed(name).targetPath ?? '';
    const match = operationFor(contentDoc, 'POST', targetPath);

    expect(match?.template, `strategies-content declares no POST ${targetPath}`).toBe(targetPath);
    expect(match?.operation['x-opt2-transport']).toBe('cloud-tasks');
    expect(match?.operation['x-opt2-requires']).toContain(TASKS_INVOKER_ROLE);
    expect(match?.operation).not.toHaveProperty('x-opt2-public');
  });

  it('declares the site id of a feed import as the siteid query parameter', () => {
    const feedPath = stepNamed('feedAutoImport').targetPath ?? '';

    expect(parametersOf(contentDoc, findOperation(contentDoc, 'POST', feedPath))).toContainEqual(
      expect.objectContaining({ name: 'siteid', in: 'query', required: true }),
    );
  });

  it.each(TARGET_CAPABLE_STEPS)('creates the %s task against its declared operation, query and wire body', async (name) => {
    const step = stepNamed(name);
    const port = createFakeTaskPort({ autoComplete: true });
    const outcome = await dispatcherOver(port, everyUnitTarget).dispatch(invocation(step));
    const tasks = port.tasks();

    expect(tasks).toHaveLength(1);
    const input = tasks[0]?.input;
    if (input === undefined) throw new Error(`no task was created for ${name}`);
    expect(outcome).toMatchObject({ route: 'target', task: { queue: input.queue, name: input.name, created: true } });
    expect(input.tenantId).toBeUndefined();

    const url = new URL(input.url);
    expect(url.origin).toBe(new URL(SERVICE_URLS['strategies-content'] ?? '').origin);
    const match = findOperation(contentDoc, 'POST', url.pathname);
    expect(match.template).toBe(step.targetPath);
    expect(input.queue).toBe(match.operation['x-opt2-queue']);
    assertQueryMatches(contentDoc, match, 'POST', url.pathname, Object.fromEntries(url.searchParams));
    assertRequestBodyMatches(contentDoc, match, 'POST', url.pathname, taskWireBody(input));
    expect(url.searchParams.get('siteid')).toBe(step.perSite ? SITE : null);
  });
});

describe('migration operations the site monitor calls', () => {
  const { recorder, exchanges, client } = recordingClient();
  const port = createMigrationJobsPort({ client, clock: TEST_CLOCK });
  const callsByPortMethod = new Map<keyof MigrationJobsPort, RecordedServiceCall[]>();

  /** Runs `action` and files the service calls it made under the port method it exercised. */
  async function recordCalls(method: keyof MigrationJobsPort, action: () => Promise<unknown>): Promise<void> {
    const start = recorder.requests.length;
    await action();
    callsByPortMethod.set(method, [...(callsByPortMethod.get(method) ?? []), ...recorder.requests.slice(start)]);
  }

  beforeAll(async () => {
    for (const authority of ['legacy', 'target'] as const) {
      recorder.setAuthority(ALL_UNITS, authority);
      const dispatcher = dispatcherOver(createFakeTaskPort({ autoComplete: true }), port);
      for (const step of SITE_MONITOR_STEPS) await dispatcher.dispatch(invocation(step));
    }
    const publishTargetUnits = stepNamed('publishScheduledChangesets').units.filter((unit) => !unit.startsWith('legacy:'));
    await recordCalls('unitsTargetAuthoritative', () => port.unitsTargetAuthoritative(publishTargetUnits));
    await recordCalls('runLegacyStep', () => port.runLegacyStep(legacyRequest('feedAutoImport'), DEADLINE_AT));

    recorder.failStep('trackBounces', 503);
    recorder.failStep('onSiteMonitor', 504);
    await recordCalls('runLegacyStep', () => expect(port.runLegacyStep(legacyRequest('trackBounces'), DEADLINE_AT)).rejects.toThrow());
    await recordCalls('runLegacyStep', () =>
      expect(port.runLegacyStep(legacyRequest('onSiteMonitor'), DEADLINE_AT)).rejects.toBeInstanceOf(SiteMonitorDeadlineError),
    );
    recorder.failStep('trackBounces', null);
    recorder.failStep('onSiteMonitor', null);
  });

  it('calls migration through each port method and no other service', () => {
    expect(recorder.requests.filter((call) => call.service !== MIGRATION).map((call) => `${call.service} ${call.method} ${call.path}`)).toEqual([]);
    for (const method of ['unitsTargetAuthoritative', 'runLegacyStep'] as const) {
      expect(callsByPortMethod.get(method)?.filter((call) => call.service === MIGRATION).length ?? 0, method).toBeGreaterThan(0);
    }
  });

  it('declares every migration operation the step dispatcher calls', () => {
    const undeclared = recorder
      .requestsTo(MIGRATION)
      .filter((call) => operationFor(migrationDoc, call.method, call.path) === undefined)
      .map((call) => `${call.method} ${call.path}`);

    expect(undeclared, 'migration operations absent from migration/contracts/openapi.yaml').toEqual([]);
  });

  it('is authorised as programs-sites by every migration operation it calls', () => {
    for (const call of recorder.requestsTo(MIGRATION)) {
      const { operation } = findOperation(migrationDoc, call.method, call.path);
      expect(operation['x-opt2-transport'], `${call.method} ${call.path}`).toBe('service');
      expect(operation['x-opt2-requires'], `${call.method} ${call.path}`).toContain(SELF_ROLE);
    }
  });

  it('sends the query and JSON body each migration operation declares', () => {
    for (const call of recorder.requestsTo(MIGRATION)) {
      const match = findOperation(migrationDoc, call.method, call.path);
      expect(call.raw.form, `${call.method} ${call.path} form body`).toBeUndefined();
      expect(call.raw.body, `${call.method} ${call.path} raw body`).toBeUndefined();
      assertQueryMatches(migrationDoc, match, call.method, call.path, sentQuery(call));
      if (call.json === undefined) {
        expect(requestBodyOf(migrationDoc, match)?.required ?? false, `${call.method} ${call.path} requires a body`).toBe(false);
      } else {
        assertRequestBodyMatches(migrationDoc, match, call.method, call.path, call.json);
      }
    }
  });

  it("answers from the recorder's migration defaults in the shapes the contract declares", () => {
    const answers = exchanges.filter((exchange) => exchange.req.service === MIGRATION);

    expect([...new Set(answers.map((exchange) => exchange.res.status))].sort((a, b) => a - b)).toEqual([200, 503, 504]);
    for (const { req, res } of answers) {
      assertResponseMatchesOpenApi(migrationDoc, {
        method: req.method,
        path: req.path,
        status: res.status,
        contentType: 'application/json',
        body: res.body,
      });
    }
  });
});
