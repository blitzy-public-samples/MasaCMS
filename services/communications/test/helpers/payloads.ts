// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Sample producer payloads, their envelopes and the producers' payload validators, shared by the communications suites. */
import { compileTopicSchema, readTopicSchema, type EventEnvelope, type TopicValidator } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantIdForSite, type SiteChangedPayload } from '@opt2/platform/tenancy';
import { TENANT_A, registryPayloads, testEnvelope } from '@opt2/platform/testing';
import { LOGIN_MAIL_TOPIC, type LoginMailRequestedPayload } from '../../src/events/login-mail.js';
import { SURVEY_SCHEDULED_TOPIC, type SurveyScheduledPayload } from '../../src/events/survey-scheduled.js';

/** Fixed CF-format ids of the sample payloads; suites override them for distinct messages or surveys. */
export const SAMPLE_IDS = Object.freeze({
  messageId: 'A1B2C3D4-0001-4000-8000000000000001',
  userId: 'B2C3D4E5-0002-4000-8000000000000002',
  returnId: 'C3D4E5F6-0003-4000-8000000000000003',
  surveyId: 'D4E5F6A7-0004-4000-8000000000000004',
} as const);

/** Payload type of each producer topic communications consumes. */
export interface ProducerPayloads {
  [LOGIN_MAIL_TOPIC]: LoginMailRequestedPayload;
  [SURVEY_SCHEDULED_TOPIC]: SurveyScheduledPayload;
  [SITE_CHANGED_TOPIC]: SiteChangedPayload;
}

/** A producer topic communications consumes. */
export type ProducerTopic = keyof ProducerPayloads;

/** Location of each producer's payload schema in its own `contracts/events/`. */
export const PRODUCER_SCHEMA_URLS: Readonly<Record<ProducerTopic, URL>> = Object.freeze({
  [LOGIN_MAIL_TOPIC]: new URL('../../../identity/contracts/events/identity.login-mail.requested.v1.json', import.meta.url),
  [SURVEY_SCHEDULED_TOPIC]: new URL('../../../surveys/contracts/events/surveys.survey.scheduled.v1.json', import.meta.url),
  [SITE_CHANGED_TOPIC]: new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
});

// Reset-link body in the shape of legacy sendLogin; the surrounding blank lines are what mailer.sendText trims before sending.
function resetText(userId: string, returnId: string): string {
  return [
    '',
    '  Dear Member One,',
    '',
    'We received a request to reset the password for username member1.',
    '',
    'Please click the link below to access your account and reset your password:',
    '',
    `http://tenant-a.opt2.test/index.cfm/${returnId}/?userID=${userId}`,
    '',
    'Thanks for using Tenant A',
    '  ',
    '',
  ].join('\n');
}

/** A forgot-password `identity.login-mail.requested.v1` payload for a tenant-a member; `text` carries the untrimmed legacy whitespace. */
export function loginMailPayload(overrides: Partial<LoginMailRequestedPayload> = {}): LoginMailRequestedPayload {
  const userId = overrides.userId ?? SAMPLE_IDS.userId;
  const returnId = overrides.returnId ?? SAMPLE_IDS.returnId;
  return {
    messageId: SAMPLE_IDS.messageId,
    userId,
    returnId,
    siteId: 'tenant-a',
    to: 'member1@tenant-a.example',
    from: 'Tenant A',
    subject: 'Tenant A Account Information',
    text: resetText(userId, returnId),
    bcc: 'audit@tenant-a.example',
    kind: 'forgot-password',
    ...overrides,
  };
}

// Version 2 moves the launch and changes the reminder offsets, so its tasks differ from version 1's in name and time.
const SURVEY_SCHEDULES = Object.freeze({
  1: { launchAt: '2026-07-01T09:00:00.000', reminderOffsets: [60] },
  2: { launchAt: '2026-07-02T09:00:00.000', reminderOffsets: [120, 1440] },
} as const);

/** Schedule `version` of one tenant-a survey as `surveys.survey.scheduled.v1`, with the fixture's `opt2-survey-<id>-…` task names. */
export function surveyScheduledPayload(version: 1 | 2, overrides: Partial<SurveyScheduledPayload> = {}): SurveyScheduledPayload {
  const surveyId = overrides.surveyId ?? SAMPLE_IDS.surveyId;
  const { launchAt, reminderOffsets } = SURVEY_SCHEDULES[version];
  const taskBase = `opt2-survey-${surveyId}-`;
  return {
    surveyId,
    siteId: 'tenant-a',
    scheduleVersion: version,
    launchAt,
    launchTaskName: `${taskBase}launch`,
    reminders: reminderOffsets.map((offsetMinutes, index) => ({
      n: index + 1,
      offsetMinutes,
      taskName: `${taskBase}reminder-${String(index + 1)}`,
    })),
    targets: [{ siteId: 'tenant-a', groupName: null }],
    ...overrides,
  };
}

/** The seeded `programs-sites.site.changed.v1` payload of `siteId` from `registryPayloads()`; throws when no fixture site has that id. */
export function siteChangedPayload(siteId: string): SiteChangedPayload {
  const payload = registryPayloads().find((candidate) => candidate.siteId === siteId);
  if (payload === undefined) {
    throw new Error(`No registry fixture for site ${JSON.stringify(siteId)}`);
  }
  return payload;
}

/** Overrides of {@link envelopeFor}; `aggregateId` is required for a topic whose payload names no aggregate. */
export interface EnvelopeOptions {
  tenantId?: string;
  aggregateVersion?: number;
  eventId?: string;
  aggregateId?: string;
  aggregateType?: string;
}

interface AggregateRule {
  idField: string;
  aggregateType?: string;
  versionField?: string;
}

// Aggregates as each producer sets them; site.changed keeps testEnvelope's default type, the topic entity `site`.
const AGGREGATE_RULES: Readonly<Record<string, AggregateRule>> = Object.freeze({
  [LOGIN_MAIL_TOPIC]: { idField: 'userId', aggregateType: 'user' },
  [SURVEY_SCHEDULED_TOPIC]: { idField: 'surveyId', aggregateType: 'survey-schedule', versionField: 'scheduleVersion' },
  [SITE_CHANGED_TOPIC]: { idField: 'siteId' },
});

function fieldOf(payload: unknown, name: string): unknown {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[name] : undefined;
}

/**
 * A contract-valid envelope of `payload` on `topic`, built with `testEnvelope`. The tenant defaults to the payload site's tenant
 * (tenant-a when the site is empty or absent) and the version to the schedule version, else 1.
 */
export function envelopeFor<P>(topic: string, payload: P, opts: EnvelopeOptions = {}): EventEnvelope<P> {
  const rule = AGGREGATE_RULES[topic];
  const derivedId = rule === undefined ? undefined : fieldOf(payload, rule.idField);
  const aggregateId = opts.aggregateId ?? (typeof derivedId === 'string' && derivedId !== '' ? derivedId : undefined);
  if (aggregateId === undefined) {
    throw new TypeError(`envelopeFor(${topic}): the payload names no aggregate; pass opts.aggregateId`);
  }
  const siteId = fieldOf(payload, 'siteId');
  const version = rule?.versionField === undefined ? undefined : fieldOf(payload, rule.versionField);
  return testEnvelope({
    topic,
    payload,
    aggregateId,
    aggregateType: opts.aggregateType ?? rule?.aggregateType,
    tenantId: opts.tenantId ?? (typeof siteId === 'string' && siteId !== '' ? tenantIdForSite(siteId) : TENANT_A.tenantId),
    aggregateVersion: opts.aggregateVersion ?? (typeof version === 'number' ? version : 1),
    eventId: opts.eventId,
  });
}

const validators = new Map<ProducerTopic, TopicValidator>();

/** The producer's compiled payload schema of `topic`, read from its contracts on first use and cached per topic. */
export function producerValidator<T extends ProducerTopic>(topic: T): TopicValidator<ProducerPayloads[T]> {
  let validator = validators.get(topic);
  if (validator === undefined) {
    validator = compileTopicSchema(readTopicSchema(PRODUCER_SCHEMA_URLS[topic]));
    validators.set(topic, validator);
  }
  return validator as TopicValidator<ProducerPayloads[T]>;
}
