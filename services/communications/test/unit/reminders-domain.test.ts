// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** performReminder over in-memory registry, repository and surveys-client doubles: outcomes, the markReminderSent call and failures. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { GateRaceError, type WriteContext } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import {
  tenantIdForSite,
  type MetadataTx,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, findOperation, fixedClock, type TenantFixture } from '@opt2/platform/testing';
import { performReminder, reminderSentPath, type ReminderDeps } from '../../src/domain/reminders.js';
import type { CommunicationsRepository } from '../../src/repo/repository.js';
import { SCHEDULED_TASK, type ScheduledTaskRow, type ScheduledTaskStatus } from '../../src/repo/tables.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };

type Schema = { $ref?: string; required?: string[]; properties?: Record<string, Schema>; pattern?: string; type?: string; minimum?: number; enum?: string[] };
type OpenApiDoc = { components: { schemas: Record<string, Schema> } };

const OWN_OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const SURVEYS_OPENAPI = load(readFileSync(new URL('../../../surveys/contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;

const SCHEMA = 'communications';
const REGISTRY_SQL = `SELECT site_id FROM ${SCHEMA}.tenant_registry WHERE tenant_id = $1`;
const SURVEY_ID = '11111111-2222-3333-4444555566667777';
const TASK_ID = '00000012-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const NOW = new Date(2026, 5, 30, 9, 15, 0, 42);
const REMINDER_CONTEXT: WriteContext = { origin: 'target', actorService: 'communications' };
const UNREGISTERED_TENANT = tenantIdForSite('ghost');

/** A `scheduled` reminder 2 of schedule version 3 in tenant-a, unless overridden. */
function reminderRow(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    tenant_id: TENANT_A.tenantId,
    scheduled_task_id: TASK_ID,
    task_name: `opt2-survey-${SURVEY_ID}-reminder-2`,
    queue: 'communications-reminders',
    queue_task_name: `opt2-survey-${SURVEY_ID}-reminder-2-v3`,
    kind: 'survey-reminder',
    source_type: 'survey',
    source_id: SURVEY_ID,
    reminder_n: 2,
    schedule_time: new Date(2026, 5, 30, 9, 15, 0),
    status: 'scheduled',
    target_route: `/internal/v1/tasks/reminders/${TASK_ID}`,
    schedule_version: 3,
    origin: 'event',
    enqueued_at: new Date(2026, 5, 29, 8, 0, 0),
    dequeued_at: null,
    created_at: new Date(2026, 5, 29, 8, 0, 0),
    updated_at: new Date(2026, 5, 29, 8, 0, 0),
    ...overrides,
  };
}

/** In-memory registry, tenant transactions, repository and surveys client; records every read, transaction, call and write. */
function createWorld(answer: (req: ServiceRequest) => Promise<ServiceResponse> = () => Promise.resolve({ status: 200, headers: {}, body: { applied: true } })) {
  const registry = new Map<string, string>([TENANT_A, TENANT_B].map((t): [string, string] => [t.tenantId, t.siteId]));
  const registryReads: string[] = [];
  const opened: TenantTx[] = [];

  const metadataTx: MetadataTx = {
    schema: SCHEMA,
    kind: 'metadata',
    onCommit: () => undefined,
    query: <R extends QueryResultRow = QueryResultRow>(text: unknown, values: unknown[] = []) => {
      if (text !== REGISTRY_SQL) return Promise.reject(new Error(`Unexpected SQL: ${String(text)}`));
      const tenantId = String(values[0]);
      registryReads.push(tenantId);
      const site = registry.get(tenantId);
      const rows = (site === undefined ? [] : [{ site_id: site }]) as unknown as R[];
      const result: QueryResult<R> = { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
      return Promise.resolve(result);
    },
  };
  const db: TenantDb = {
    schema: SCHEMA,
    withTenant: (tenantId, fn) => {
      const tx: TenantTx = Object.freeze({
        kind: 'tenant',
        tenantId,
        schema: SCHEMA,
        query: () => Promise.reject(new Error('the reminder runs no SQL of its own')),
        onCommit: () => undefined,
      });
      opened.push(tx);
      return fn(tx);
    },
    withMetadata: (fn) => fn(metadataTx),
    end: () => Promise.resolve(),
  };

  const setScheduledTaskStatus = vi.fn<CommunicationsRepository['setScheduledTaskStatus']>((tx, taskId, status) =>
    Promise.resolve(reminderRow({ tenant_id: tx.tenantId, scheduled_task_id: taskId, status })),
  );
  const request = vi.fn(answer);
  const deps: ReminderDeps = {
    db,
    repository: { setScheduledTaskStatus } as unknown as CommunicationsRepository,
    clock: fixedClock(NOW),
    logger: createLogger({ service: SCHEMA, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    client: { request: request as ReminderDeps['client']['request'] },
  };
  return { deps, registryReads, opened, setScheduledTaskStatus, request };
}

/** `schema`, or the component schema of `doc` its `$ref` names. */
function resolved(doc: OpenApiDoc, schema: Schema): Schema {
  const name = schema.$ref?.replace('#/components/schemas/', '');
  return name === undefined ? schema : (doc.components.schemas[name] ?? {});
}

describe('reminderSentPath', () => {
  it.each([1, 2, 12])("names surveys' markReminderSent for reminder %i", (n) => {
    const path = reminderSentPath(SURVEY_ID, n);
    expect(path).toBe(`/internal/v1/surveys/${SURVEY_ID}/reminders/${String(n)}/sent`);
    expect(findOperation(SURVEYS_OPENAPI, 'POST', path).operation.operationId).toBe('markReminderSent');
  });
});

describe('performReminder', () => {
  const RESULT_STATUSES = resolved(OWN_OPENAPI, { $ref: '#/components/schemas/ReminderTaskResult' }).properties?.status?.enum;

  it.each<[ScheduledTaskStatus, string]>([
    ['done', 'already-sent'],
    ['superseded', 'superseded'],
    ['cancelled', 'superseded'],
  ])('answers a %s row %s without a registry read, a surveys call or a write', async (status, outcome) => {
    const world = createWorld();

    await expect(performReminder(world.deps, reminderRow({ status }))).resolves.toStrictEqual({ status: outcome });

    expect(RESULT_STATUSES).toContain(outcome);
    expect(world.registryReads).toEqual([]);
    expect(world.request).not.toHaveBeenCalled();
    expect(world.opened).toEqual([]);
    expect(world.setScheduledTaskStatus).not.toHaveBeenCalled();
  });

  it.each<[string, TenantFixture]>([
    ['tenant-a', TENANT_A],
    ['tenant-b', TENANT_B],
  ])('calls markReminderSent for a scheduled %s row, then sets the row done under its tenant', async (_site, tenant) => {
    const world = createWorld();
    const row = reminderRow({ tenant_id: tenant.tenantId });

    await expect(performReminder(world.deps, row)).resolves.toStrictEqual({ status: 'sent' });

    expect(RESULT_STATUSES).toContain('sent');
    expect(world.registryReads).toEqual([tenant.tenantId]);
    expect(world.request.mock.calls).toEqual([
      [
        {
          service: 'surveys',
          method: 'POST',
          path: `/internal/v1/surveys/${SURVEY_ID}/reminders/2/sent`,
          json: {
            tenantId: tenant.tenantId,
            siteId: tenant.siteId,
            taskName: row.task_name,
            scheduleVersion: 3,
            sentAt: '2026-06-30T09:15:00.042',
          },
          userToken: null,
        },
      ],
    ]);
    expect(world.opened.map((tx) => tx.tenantId)).toEqual([tenant.tenantId]);
    expect(world.setScheduledTaskStatus.mock.calls).toEqual([[world.opened[0], TASK_ID, 'done', REMINDER_CONTEXT]]);
    expect(world.request.mock.invocationCallOrder[0]).toBeLessThan(world.setScheduledTaskStatus.mock.invocationCallOrder[0]!);
  });

  it("sends a body surveys' ReminderSentRequest accepts", async () => {
    const world = createWorld();
    await performReminder(world.deps, reminderRow());
    const body = world.request.mock.calls[0]?.[0].json as Record<string, unknown>;
    const schema = resolved(SURVEYS_OPENAPI, { $ref: '#/components/schemas/ReminderSentRequest' });

    expect(Object.keys(body).sort()).toEqual([...(schema.required ?? [])].sort());
    for (const [key, value] of Object.entries(body)) {
      const property = resolved(SURVEYS_OPENAPI, schema.properties?.[key] ?? {});
      if (property.pattern !== undefined) expect(String(value)).toMatch(new RegExp(property.pattern, 'u'));
      if (property.type === 'integer') expect(Number.isInteger(value) && (value as number) >= (property.minimum ?? 1)).toBe(true);
    }
  });

  it('throws the tenant-unregistered 503 for a tenant without a registry entry, before calling surveys', async () => {
    const world = createWorld();

    const error = await performReminder(world.deps, reminderRow({ tenant_id: UNREGISTERED_TENANT })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({
      message: `Tenant ${UNREGISTERED_TENANT} has no site registry entry`,
      surface: 'auto',
      reason: 'tenant-unregistered',
    });
    expect(world.registryReads).toEqual([UNREGISTERED_TENANT]);
    expect(world.request).not.toHaveBeenCalled();
    expect(world.opened).toEqual([]);
  });

  it('throws RangeError for a scheduled reminder without an ordinal, before any read or call', async () => {
    const world = createWorld();

    await expect(performReminder(world.deps, reminderRow({ reminder_n: null }))).rejects.toThrow(
      new RangeError(`Reminder task ${TASK_ID} of survey ${SURVEY_ID} has no ordinal`),
    );
    expect(world.registryReads).toEqual([]);
    expect(world.request).not.toHaveBeenCalled();
  });

  it.each([200, 202, 299])('treats a surveys HTTP %i as sent', async (status) => {
    const world = createWorld(() => Promise.resolve({ status, headers: {}, body: undefined }));

    await expect(performReminder(world.deps, reminderRow())).resolves.toStrictEqual({ status: 'sent' });
    expect(world.setScheduledTaskStatus).toHaveBeenCalledTimes(1);
  });

  it.each([199, 300, 400, 404, 409, 500, 503])('throws the service-unavailable 503 on a surveys HTTP %i and leaves the row open', async (status) => {
    const world = createWorld(() => Promise.resolve({ status, headers: {}, body: undefined }));

    const error = await performReminder(world.deps, reminderRow()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({
      message: `Service surveys markReminderSent answered HTTP ${String(status)}`,
      surface: 'auto',
      reason: 'service-unavailable',
    });
    expect(world.opened).toEqual([]);
    expect(world.setScheduledTaskStatus).not.toHaveBeenCalled();
  });

  it.each<[string, Error]>([
    ['an unreachable surveys', new ServiceUnavailableError('surveys', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))],
    ['a client failure', new TypeError('bad request options')],
  ])('propagates %s unchanged and leaves the row open', async (_case, failure) => {
    const world = createWorld(() => Promise.reject(failure));

    await expect(performReminder(world.deps, reminderRow())).rejects.toBe(failure);
    expect(world.opened).toEqual([]);
    expect(world.setScheduledTaskStatus).not.toHaveBeenCalled();
  });

  it('propagates a failed status write after the surveys callback', async () => {
    const world = createWorld();
    const failure = new Error('write failed');
    world.setScheduledTaskStatus.mockRejectedValueOnce(failure);

    await expect(performReminder(world.deps, reminderRow())).rejects.toBe(failure);
    expect(world.request).toHaveBeenCalledTimes(1);
  });

  it('re-runs only the status write after a gate race, calling surveys once', async () => {
    const world = createWorld();
    world.setScheduledTaskStatus.mockRejectedValueOnce(new GateRaceError([SCHEDULED_TASK.unit]));

    await expect(performReminder(world.deps, reminderRow())).resolves.toStrictEqual({ status: 'sent' });
    expect(world.request).toHaveBeenCalledTimes(1);
    expect(world.opened.map((tx) => tx.tenantId)).toEqual([TENANT_A.tenantId, TENANT_A.tenantId]);
    expect(world.setScheduledTaskStatus).toHaveBeenCalledTimes(2);
  });
});
