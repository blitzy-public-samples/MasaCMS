// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting as a consumer: site.changed pushes against the programs-sites event schema, and export-source reads against the finance and timesheets OpenAPI contracts, each confirmed against reporting's own scope route. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pushPath } from '@opt2/platform/events';
import type { ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { QUEUES } from '@opt2/platform/tasks';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TEST_PUSH_KEY,
  assertEventMatches,
  assertProducerConsumerCompatible,
  assertResponseMatchesOpenApi,
  findOperation,
  mintTasksInvokerToken,
  pushKeyQuery,
  pushTo,
  registryPayloads,
  withoutTenant,
  type InjectResponse,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FIXTURE_PREFIX } from '../../src/legacy/index.js';
import type { ExportSource } from '../../src/repo/tables.js';
import {
  FINANCE_RECORDS,
  OPENAPI,
  PRODUCER_OPENAPI,
  SERVICE,
  SHEET_STATUS_ROWS,
  SOURCE_PATHS,
  buildTestApp,
  headersFor,
  identityOf,
  queuedRun,
  seedDefinition,
  siteChangedEnvelope,
  type ExportProducer,
  type TestApp,
} from '../helpers/app.js';

type Json = Record<string, unknown>;

const SITE_SCHEMA = JSON.parse(
  readFileSync(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as Json;

const DLQ_TOPIC = `${SITE_CHANGED_SUBSCRIPTION}.dlq`;
const RUN_QUEUE = QUEUES['reporting-export-run'];

let t: TestApp;

/** Checks a push answer against the reporting contract's push operation and returns it. */
function checkedPush(res: InjectResponse): InjectResponse {
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'POST',
    path: pushPath(SITE_CHANGED_SUBSCRIPTION),
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

function registryRow(siteId: string): Json | undefined {
  return t.db.rows('tenant_registry').find((row) => row.site_id === siteId);
}

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.client.reset();
  t.publisher.clear();
});

describe('programs-sites.site.changed.v1 consumer', () => {
  it('relies only on fields, types and the kind the producer schema declares', () => {
    expect(() =>
      assertProducerConsumerCompatible(SITE_SCHEMA, {
        required: ['siteId'],
        types: {
          siteId: 'string',
          publicUserPoolId: 'string',
          privateUserPoolId: 'string',
          categoryPoolId: 'string',
          filePoolId: 'string',
          displayPoolId: 'string',
          contentPoolIds: 'array',
          domains: 'array',
        },
        itemTypes: { contentPoolIds: 'string', domains: 'string' },
        kind: 'state',
        samples: registryPayloads(),
      }),
    ).not.toThrow();
  });

  it.each(registryPayloads().map((payload) => [payload.siteId, payload] as const))(
    'applies a contract-valid %s delivery into the registry with its pool tenants',
    async (siteId, payload) => {
      const envelope = siteChangedEnvelope(siteId, 2);
      assertEventMatches(undefined, SITE_SCHEMA, envelope);
      const res = checkedPush(await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, envelope));
      expect({ status: res.statusCode, deadLetters: t.publisher.raw.length }).toEqual({ status: 204, deadLetters: 0 });
      const row = registryRow(siteId);
      expect(row).toMatchObject({
        tenant_id: tenantIdForSite(siteId),
        public_user_pool_tenant: tenantIdForSite(payload.publicUserPoolId ?? siteId),
        private_user_pool_tenant: tenantIdForSite(payload.privateUserPoolId ?? siteId),
        content_pool_ids: payload.contentPoolIds,
      });
      expect(String(row?.aggregate_version)).toBe('2');
    },
  );

  it('acknowledges a stale delivery without changing the registry', async () => {
    const before = registryRow(TENANT_A.siteId);
    const res = checkedPush(await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(TENANT_A.siteId, 1)));
    expect({ status: res.statusCode, row: registryRow(TENANT_A.siteId) }).toEqual({ status: 204, row: before });
  });

  it.each<[string, () => object, string]>([
    ['a payload the producer schema refuses', () => ({ ...siteChangedEnvelope(TENANT_B.siteId, 9), payload: { siteId: TENANT_B.siteId } }), 'schema-invalid'],
    ['no tenant', () => withoutTenant(siteChangedEnvelope(TENANT_B.siteId, 9)), 'missing-tenant'],
    ["another site's tenant", () => ({ ...siteChangedEnvelope(TENANT_B.siteId, 9), tenantId: TENANT_A.tenantId }), 'tenant-mismatch'],
  ])('dead-letters a delivery with %s and leaves the registry unchanged', async (_label, envelope, reason) => {
    const before = registryRow(TENANT_B.siteId);
    const res = checkedPush(await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, envelope() as Parameters<typeof pushTo>[2]));
    expect({
      status: res.statusCode,
      reasons: t.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION).map((letter) => letter.reason),
      topics: t.publisher.raw.map((entry) => entry.topic),
      row: registryRow(TENANT_B.siteId),
    }).toEqual({ status: 204, reasons: [reason], topics: [DLQ_TOPIC], row: before });
  });

  it('refuses the producer schema for the dead-lettered payload', () => {
    expect(() => assertEventMatches(undefined, SITE_SCHEMA, { ...siteChangedEnvelope(TENANT_B.siteId), payload: { siteId: TENANT_B.siteId } })).toThrow();
  });

  it('answers a body that is not a push with the contract 400 and dead-letters nothing', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `${pushPath(SITE_CHANGED_SUBSCRIPTION)}?${pushKeyQuery(TEST_PUSH_KEY)}`,
      payload: { notAPush: true },
    });
    expect({ status: checkedPush(res).statusCode, raw: t.publisher.raw.length }).toEqual({ status: 400, raw: 0 });
  });
});

/** Names of the parameters an operation of `doc` declares, `$ref`s resolved. */
function declaredParameters(doc: object, operation: Json): Array<{ name: string; in: string }> {
  const lookup = (ref: string): Json =>
    ref
      .slice(2)
      .split('/')
      .reduce<unknown>((node, segment) => (node as Json)[segment], doc) as Json;
  return ((operation.parameters ?? []) as Json[]).map((parameter) => {
    const resolved = typeof parameter.$ref === 'string' ? lookup(parameter.$ref) : parameter;
    return { name: String(resolved.name), in: String(resolved.in) };
  });
}

/** The answer `call` received, validated against the operation of `doc` serving it. */
function checkedAnswer(doc: object, call: ServiceRequest): ServiceResponse {
  const answer = t.client.responseOf(call);
  if (answer === undefined) throw new Error(`no answer recorded for ${call.method} ${call.service} ${call.path}`);
  assertResponseMatchesOpenApi(doc, {
    method: call.method,
    path: call.path,
    status: answer.status,
    contentType: answer.headers['content-type'],
    body: JSON.stringify(answer.body),
  });
  return answer;
}

describe('export source producers', () => {
  const SOURCES: ReadonlyArray<readonly [ExportSource, ExportProducer, string]> = [
    ['timesheets.sheets', 'timesheets', SHEET_STATUS_ROWS[0]?.timesheetId ?? ''],
    ['finance.records', 'finance', FINANCE_RECORDS[0]?.record_id ?? ''],
  ];

  it.each(SOURCES)(
    'reads %s from %s only through its System export read, with no user token, each read confirmed against reporting\'s scope route',
    async (source, service, cell) => {
      const exporter = ROLE_SET.find((who) => who.name === 'reporting.exporter');
      if (exporter === undefined) throw new TypeError('ROLE_SET has no reporting.exporter subject');
      const definition = seedDefinition(t.db, TENANT_A.siteId, source);
      const created = await t.app.inject({
        method: 'POST',
        url: `/v1/reporting/exports?siteid=${TENANT_A.siteId}`,
        headers: { ...(await headersFor(exporter, TENANT_A.siteId)), ...t.client.issueCsrf(identityOf(exporter).sid, '') },
        payload: { definitionId: definition.definition_id, format: 'csv' },
      });
      expect(created.statusCode).toBe(200);
      const { job_id: jobId } = created.json<{ data: { job_id: string } }>().data;
      const [before, checksBefore] = [t.client.requests.length, t.client.scopeChecks.length];
      const run = await t.app.inject({
        method: 'POST',
        url: RUN_QUEUE.targetPath.replace('{exportId}', jobId),
        headers: { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` },
        payload: { ...queuedRun(t, jobId) },
      });
      expect({ status: run.statusCode, body: run.json<unknown>() }).toEqual({ status: 200, body: { jobId, state: 'done' } });

      // The run acts as System: it asks identity for nothing, and every call is a source read of the job's producer.
      const calls = t.client.requests.slice(before);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.map((call) => [call.service, call.path, call.userToken])).toEqual(calls.map(() => [service, SOURCE_PATHS[service], null]));
      expect((OPENAPI as Json)['x-opt2-calls']).toEqual(expect.arrayContaining([service]));
      const producer = PRODUCER_OPENAPI[service];
      for (const read of calls) {
        const { operation } = findOperation(producer, read.method, read.path);
        expect(operation['x-opt2-requires']).toEqual(['service:reporting']);
        const query = declaredParameters(producer, operation).filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name);
        expect(Object.keys(read.query ?? {}).filter((name) => !query.includes(name))).toEqual([]);
        expect(read.query).toMatchObject({ exportId: jobId, siteId: TENANT_A.siteId });
        expect(checkedAnswer(producer, read).status).toBe(200);
      }

      // Each read's producer confirmed its scope through the reporting contract's getExportSourceScope, as the job's producer.
      const checks = t.client.scopeChecks.slice(checksBefore);
      expect(checks).toHaveLength(calls.length);
      for (const check of checks) {
        assertResponseMatchesOpenApi(OPENAPI, {
          method: 'GET',
          path: `/internal/v1/exports/${check.exportId}/source-scope`,
          status: check.status,
          contentType: 'application/json',
          body: JSON.stringify(check.body),
        });
        expect({ service: check.service, status: check.status }).toEqual({ service, status: 200 });
        expect(check.body).toMatchObject({ exportId: jobId, tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, source, state: 'running' });
      }
      const operation = findOperation(OPENAPI, 'GET', `/internal/v1/exports/${jobId}/source-scope`).operation;
      expect(operation['x-opt2-requires']).toEqual(expect.arrayContaining([`service:${service}`]));

      const download = await t.app.inject({
        method: 'GET',
        url: `${FIXTURE_PREFIX}/exports/${jobId}/download?siteid=${TENANT_A.siteId}`,
        headers: await headersFor(exporter, TENANT_A.siteId),
      });
      expect({ status: download.statusCode, carriesProducerCell: download.body.includes(cell) }).toEqual({ status: 200, carriesProducerCell: true });
    },
  );
});
