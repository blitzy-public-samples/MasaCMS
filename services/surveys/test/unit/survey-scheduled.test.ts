// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Producer of `surveys.survey.scheduled.v1`: topic, payload contract and the outbox row it writes. */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@opt2/platform/logging';
import {
  OutboxPayloadError,
  createOutbox,
  localTimestamp,
  resetOutboxRuntimes,
  type OutboxOrigin,
} from '@opt2/platform/outbox';
import type { CommitCallback, QueryConfig, QueryResult, QueryResultRow, TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createCapturingPublisher, fixedClock, type CapturingPublisher } from '@opt2/platform/testing';
import type { SurveyScheduledPayload } from '../../src/generated/events/surveys.survey.scheduled.v1.js';
import {
  SURVEY_SCHEDULED_TOPIC,
  surveyScheduledSchema,
  surveyScheduledValidator,
  writeSurveyScheduled,
} from '../../src/events/survey-scheduled.js';

const contractSchema = JSON.parse(
  await readFile(new URL('../../contracts/events/surveys.survey.scheduled.v1.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const SURVEY_ID = '6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const INSERT_SQL =
  'INSERT INTO "surveys".outbox (tenant_id, event_id, topic, kind, ordering_key, envelope, operation_id, held, created_at)' +
  ' VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)';

interface Statement {
  sql: string;
  values: unknown[] | undefined;
}

function schedulePayload(): SurveyScheduledPayload {
  return {
    surveyId: SURVEY_ID,
    siteId: TENANT_A.siteId,
    scheduleVersion: 1,
    launchAt: '2026-07-01T09:00:00.000',
    launchTaskName: `opt2-survey-${SURVEY_ID}-launch`,
    reminders: [
      { n: 1, offsetMinutes: 1440, taskName: `opt2-survey-${SURVEY_ID}-reminder-1` },
      { n: 2, offsetMinutes: 2880, taskName: `opt2-survey-${SURVEY_ID}-reminder-2` },
    ],
    targets: [
      { siteId: TENANT_A.siteId, groupName: 'Survey Panel' },
      { siteId: 'tenant-b', groupName: null },
    ],
  };
}

/** A tenant-A transaction on the surveys schema that records every statement and commit callback. */
function recordingTx() {
  const statements: Statement[] = [];
  const commitCallbacks: CommitCallback[] = [];
  const tx: TenantTx = {
    kind: 'tenant',
    tenantId: TENANT_A.tenantId,
    schema: 'surveys',
    onCommit: (cb) => void commitCallbacks.push(cb),
    query<R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>> {
      statements.push({ sql: typeof text === 'string' ? text : text.text, values });
      return Promise.resolve({ command: 'INSERT', rowCount: 1, oid: 0, fields: [], rows: [] });
    },
  };
  return { tx, statements, commitCallbacks };
}

const unusedDb: TenantDb = {
  schema: 'surveys',
  withTenant: () => Promise.reject(new Error('writing an outbox row never opens its own transaction')),
  withMetadata: () => Promise.reject(new Error('writing an outbox row never opens a metadata transaction')),
  end: () => Promise.resolve(),
};

let publisher: CapturingPublisher;

beforeEach(() => {
  publisher = createCapturingPublisher();
  createOutbox({
    service: 'surveys',
    db: unusedDb,
    publisher,
    logger: createLogger({ service: 'surveys', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    clock: fixedClock(NOW),
    payloadValidators: { [SURVEY_SCHEDULED_TOPIC]: surveyScheduledValidator },
  });
});

afterEach(() => {
  resetOutboxRuntimes();
});

describe('surveys.survey.scheduled.v1 contract', () => {
  it('names the topic surveys.survey.scheduled.v1', () => {
    expect(SURVEY_SCHEDULED_TOPIC).toBe('surveys.survey.scheduled.v1');
  });

  it('reads the payload schema from the contract file', () => {
    expect(surveyScheduledSchema).toStrictEqual(contractSchema);
  });

  it('declares a superseding process topic under the contract $id', () => {
    expect(surveyScheduledValidator.meta).toStrictEqual({ kind: 'process', supersedes: true });
    expect(surveyScheduledValidator.schemaId).toBe('urn:opt2:surveys:event:surveys.survey.scheduled.v1');
  });

  it('accepts a full schedule payload', () => {
    const payload = schedulePayload();

    expect(surveyScheduledValidator.validatePayload(payload)).toStrictEqual({ ok: true, value: payload });
  });

  it.each<[string, (payload: Record<string, unknown>) => void, RegExp]>([
    ['a lower-case survey id', (p) => void (p.surveyId = SURVEY_ID.toLowerCase()), /^\/surveyId must match pattern /],
    ['a launch time with an offset', (p) => void (p.launchAt = '2026-07-01T09:00:00.000Z'), /^\/launchAt must match pattern /],
    ['a negative reminder offset', (p) => void ((p.reminders as Record<string, unknown>[])[0]!.offsetMinutes = -5), /^\/reminders\/0\/offsetMinutes must be >= 0$/],
    ['no targets', (p) => void delete p.targets, /^\/ must have required property 'targets'$/],
    ['an undeclared field', (p) => void (p.extra = true), /^\/ must NOT have additional properties \(extra\)$/],
  ])('rejects a payload with %s', (_case, mutate, expected) => {
    const payload = schedulePayload() as unknown as Record<string, unknown>;
    mutate(payload);

    const result = surveyScheduledValidator.validatePayload(payload);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContainEqual(expect.stringMatching(expected));
  });
});

describe('writeSurveyScheduled', () => {
  it.each<[OutboxOrigin | undefined]>([[undefined], ['target'], ['legacy-window']])(
    'writes one process outbox row for the survey in the caller transaction (origin %s)',
    async (origin) => {
      const { tx, statements, commitCallbacks } = recordingTx();
      const payload = schedulePayload();

      const envelope = await writeSurveyScheduled(tx, { surveyId: SURVEY_ID, rowVersion: 2, payload, origin });

      expect(envelope).toMatchObject({
        eventType: 'surveys.survey.scheduled',
        schemaVersion: '1.0.0',
        tenantId: TENANT_A.tenantId,
        occurredAt: NOW.toISOString(),
        producer: 'surveys',
        aggregateType: 'survey-schedule',
        aggregateId: SURVEY_ID,
        aggregateVersion: 2,
        payload,
      });
      expect(statements).toStrictEqual([
        {
          sql: INSERT_SQL,
          values: [
            TENANT_A.tenantId,
            envelope?.eventId,
            'surveys.survey.scheduled.v1',
            'process',
            SURVEY_ID,
            JSON.stringify(envelope),
            null,
            false,
            localTimestamp(NOW),
          ],
        },
      ]);
      expect(commitCallbacks).toHaveLength(1);
      expect(publisher.published).toStrictEqual([]);
    },
  );

  it.each<[OutboxOrigin]>([['backfill'], ['migration-feed']])(
    'returns null and writes nothing for origin %s',
    async (origin) => {
      const { tx, statements, commitCallbacks } = recordingTx();

      await expect(writeSurveyScheduled(tx, { surveyId: SURVEY_ID, rowVersion: 2, payload: schedulePayload(), origin })).resolves.toBeNull();
      expect(statements).toStrictEqual([]);
      expect(commitCallbacks).toStrictEqual([]);
    },
  );

  it('rejects a payload that breaks the contract and writes nothing', async () => {
    const { tx, statements, commitCallbacks } = recordingTx();
    const payload = { ...schedulePayload(), scheduleVersion: 0 };

    const write = writeSurveyScheduled(tx, { surveyId: SURVEY_ID, rowVersion: 1, payload });

    await expect(write).rejects.toBeInstanceOf(OutboxPayloadError);
    await expect(write).rejects.toMatchObject({ topic: 'surveys.survey.scheduled.v1', errors: ['/scheduleVersion must be >= 1'] });
    expect(statements).toStrictEqual([]);
    expect(commitCallbacks).toStrictEqual([]);
  });
});
