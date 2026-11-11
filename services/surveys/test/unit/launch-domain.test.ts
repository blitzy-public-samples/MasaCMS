// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Launch task effect over a recording repository and transaction: lock order, first launch, repeat, supersession, notFound and forbidden. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import { launchSurvey, type LaunchOutcome } from '../../src/domain/launch.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import { findSurvey, getSchedule } from '../../src/repo/queries.js';
import type { SurveysRepository } from '../../src/repo/repository.js';
import type { SurveyRow, SurveyScheduleRow, SurveyStatus } from '../../src/repo/tables.js';

// The gated reads are replaced so the domain runs without PostgreSQL.
vi.mock(import('../../src/repo/queries.js'), async (importOriginal) => {
  const queries = await importOriginal();
  return { ...queries, findSurvey: vi.fn(queries.findSurvey), getSchedule: vi.fn(queries.getSchedule) };
});

const T0 = new Date(2026, 5, 30, 9, 0, 0);
const LAUNCH_AT = new Date(2026, 6, 1, 9, 0, 0);
const LAUNCHED_AT = new Date(2026, 6, 1, 9, 0, 4, 250);
const SURVEY_ID = 'AAAAAAAA-BBBB-CCCC-DDDDDDDDDDDDDDDD';
const USER_ID = '11111111-2222-3333-4444555566667777';
const TENANT_A = tenantIdForSite('tenant-a');

function surveyRow(status: SurveyStatus = 'SCHEDULED', launched_at: Date | null = null): SurveyRow {
  return {
    tenant_id: TENANT_A,
    survey_id: SURVEY_ID,
    siteid: 'tenant-a',
    title: 'Pulse',
    status,
    created: T0,
    createdbyid: USER_ID,
    lastupdate: null,
    lastupdatebyid: null,
    launched_at,
  };
}

function scheduleRow(schedule_version: number): SurveyScheduleRow {
  return {
    tenant_id: TENANT_A,
    schedule_id: 'EEEEEEEE-FFFF-0000-1111222233334444',
    survey_id: SURVEY_ID,
    launch_at: LAUNCH_AT,
    schedule_version,
    task_name: `opt2-survey-${SURVEY_ID}-launch`,
    task_token_hash: 'a'.repeat(64),
    created: T0,
    row_version: String(schedule_version),
  };
}

interface Store {
  survey: SurveyRow | null;
  schedule: SurveyScheduleRow | null;
  /** The status write finds no survey, as for a row gone before the update. */
  vanishes?: boolean;
}

type Step = [string, unknown];

/** A recording repository and query layer over `store`; the status write stamps LAUNCHED_AT as the repository clock would. */
function setup(store: Store) {
  const log: Step[] = [];
  const tx: TenantTx = {
    kind: 'tenant',
    tenantId: TENANT_A,
    schema: 'surveys',
    onCommit: () => undefined,
    query: () => Promise.reject(new Error('launch runs no SQL of its own')),
  };
  vi.mocked(findSurvey).mockImplementation((_tx, surveyId) => {
    log.push(['findSurvey', surveyId]);
    return Promise.resolve(store.survey);
  });
  vi.mocked(getSchedule).mockImplementation((_tx, surveyId) => {
    log.push(['getSchedule', surveyId]);
    return Promise.resolve(store.schedule);
  });
  const lockSurvey = vi.fn<SurveysRepository['lockSurvey']>((_tx, surveyId) => {
    log.push(['lockSurvey', surveyId]);
    return Promise.resolve(store.survey);
  });
  const setSurveyStatus = vi.fn<SurveysRepository['setSurveyStatus']>((_tx, surveyId, status) => {
    log.push(['setSurveyStatus', [surveyId, status]]);
    if (store.survey === null || store.vanishes === true) {
      return Promise.resolve(null);
    }
    store.survey = { ...store.survey, status, launched_at: LAUNCHED_AT };
    return Promise.resolve(store.survey);
  });
  const repository = { lockSurvey, setSurveyStatus } as unknown as SurveysRepository;
  return { tx, log, repository, lockSurvey, setSurveyStatus };
}

beforeEach(() => {
  vi.mocked(findSurvey).mockReset();
  vi.mocked(getSchedule).mockReset();
});

describe('launchSurvey', () => {
  it('locks the survey before reading it and its schedule, then sets it LAUNCHED through the repository clock', async () => {
    const store: Store = { survey: surveyRow(), schedule: scheduleRow(1) };
    const { tx, log, repository, lockSurvey, setSurveyStatus } = setup(store);

    const result = await launchSurvey(tx, { repository, surveyId: SURVEY_ID });

    expect(result).toEqual({ outcome: 'launched', survey: surveyRow('LAUNCHED', LAUNCHED_AT) });
    expect(result.survey).toBe(store.survey);
    expect(log).toEqual([
      ['lockSurvey', SURVEY_ID],
      ['findSurvey', SURVEY_ID],
      ['getSchedule', SURVEY_ID],
      ['setSurveyStatus', [SURVEY_ID, 'LAUNCHED']],
    ]);
    expect(lockSurvey.mock.calls[0]?.[0]).toBe(tx);
    expect(setSurveyStatus.mock.calls).toEqual([[tx, SURVEY_ID, 'LAUNCHED']]);
    expect(vi.mocked(findSurvey).mock.calls[0]?.[0]).toBe(tx);
    expect(vi.mocked(getSchedule).mock.calls[0]?.[0]).toBe(tx);
  });

  it('answers already-launched with the stored row and no write on a repeat', async () => {
    const { tx, repository, setSurveyStatus } = setup({ survey: surveyRow(), schedule: scheduleRow(1) });
    const first = await launchSurvey(tx, { repository, surveyId: SURVEY_ID, scheduleVersion: 1 });

    const repeat = await launchSurvey(tx, { repository, surveyId: SURVEY_ID, scheduleVersion: 1 });

    expect(first.outcome).toBe('launched');
    expect(repeat).toEqual({ outcome: 'already-launched', survey: first.survey });
    expect(setSurveyStatus).toHaveBeenCalledTimes(1);
  });

  it.each<[LaunchOutcome, number | undefined, number, SurveyStatus, Date | null]>([
    ['superseded', 1, 2, 'SCHEDULED', null],
    ['superseded', 1, 2, 'LAUNCHED', LAUNCHED_AT],
    ['launched', 2, 2, 'SCHEDULED', null],
    ['launched', 3, 2, 'SCHEDULED', null],
    ['launched', undefined, 5, 'SCHEDULED', null],
    ['launched', 1, 1, 'LAUNCHED', null],
    ['already-launched', 2, 2, 'LAUNCHED', LAUNCHED_AT],
    ['already-launched', undefined, 1, 'CLOSED', LAUNCHED_AT],
  ])('answers %s for task version %j on schedule version %i of a %s survey launched at %o', async (outcome, scheduleVersion, stored, status, launchedAt) => {
    const survey = surveyRow(status, launchedAt);
    const { tx, repository, setSurveyStatus } = setup({ survey, schedule: scheduleRow(stored) });

    const result = await launchSurvey(tx, { repository, surveyId: SURVEY_ID, scheduleVersion });

    expect(result.outcome).toBe(outcome);
    expect(result.survey).toEqual(outcome === 'launched' ? surveyRow('LAUNCHED', LAUNCHED_AT) : survey);
    expect(setSurveyStatus).toHaveBeenCalledTimes(outcome === 'launched' ? 1 : 0);
  });

  it.each<[string, string, Store, string[]]>([
    ['notFound', 'an absent survey', { survey: null, schedule: null }, ['lockSurvey', 'findSurvey']],
    ['forbidden', 'a survey never scheduled', { survey: surveyRow('DRAFT'), schedule: null }, ['lockSurvey', 'findSurvey', 'getSchedule']],
    [
      'notFound',
      'a survey the status write no longer finds',
      { survey: surveyRow(), schedule: scheduleRow(1), vanishes: true },
      ['lockSurvey', 'findSurvey', 'getSchedule', 'setSurveyStatus'],
    ],
  ])('answers the fixture %s for %s', async (type, _case, store, steps) => {
    const { tx, log, repository } = setup(store);

    const error = await launchSurvey(tx, { repository, surveyId: SURVEY_ID }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FixtureApiError);
    expect(error).toMatchObject({ type, messageOverride: undefined });
    expect(log.map(([step]) => step)).toEqual(steps);
  });
});
