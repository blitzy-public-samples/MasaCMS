// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Push consumers of communications: the site registry, identity's login-mail requests and surveys' schedules (seam 2). */
import { readTopicSchema, subscriptionName, type ConsumerRegistration } from '@opt2/platform/events';
import type { Logger } from '@opt2/platform/logging';
import type { BaseEnv, Clock } from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer, type TenantDb } from '@opt2/platform/tenancy';
import type { MailDeps } from '../domain/delivery.js';
import type { DeliveryStatusSource } from '../domain/delivery-status.js';
import type { MailTransport } from '../domain/mail-transport.js';
import type { SenderAddressSource } from '../domain/sender-address.js';
import type { SurveyScheduleDeps } from '../domain/survey-schedule.js';
import type { CommunicationsRepository } from '../repo/repository.js';
import { LOGIN_MAIL_TOPIC, loginMailConsumer, loginMailSchema } from './login-mail.js';
import { SURVEY_SCHEDULED_TOPIC, surveyScheduledConsumer, surveyScheduledSchema } from './survey-scheduled.js';

/** Consuming service segment of every communications push subscription. */
const CONSUMER_SERVICE = 'communications';

/** Push subscription of communications on `programs-sites.site.changed.v1`. */
export const SITE_CHANGED_SUBSCRIPTION = subscriptionName(CONSUMER_SERVICE, SITE_CHANGED_TOPIC);

/** Push subscription of communications on `identity.login-mail.requested.v1`. */
export const LOGIN_MAIL_SUBSCRIPTION = subscriptionName(CONSUMER_SERVICE, LOGIN_MAIL_TOPIC);

/** Push subscription of communications on `surveys.survey.scheduled.v1`. */
export const SURVEY_SCHEDULED_SUBSCRIPTION = subscriptionName(CONSUMER_SERVICE, SURVEY_SCHEDULED_TOPIC);

/** Payload schema of `programs-sites.site.changed.v1`, read once from the producer's contracts. */
export const siteChangedSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** Dependencies the communications consumers are built from. */
export interface ConsumerDeps {
  db: TenantDb;
  repository: CommunicationsRepository;
  mail: MailTransport;
  deliveryStatus: DeliveryStatusSource;
  senderAddress: SenderAddressSource;
  taskPort: TaskPort;
  clock: Clock;
  env: Pick<BaseEnv, 'OPT2_SERVICE_URLS'>;
  logger: Logger;
}

/**
 * The `registerConsumers` entries of communications: site registry, login mail, survey schedule.
 * A platform entry is only consumer and schema; `registerConsumers` derives each subscription, which equals its `*_SUBSCRIPTION` constant.
 */
export function buildConsumers(deps: ConsumerDeps): ConsumerRegistration[] {
  const { db, repository, clock, logger, deliveryStatus, senderAddress, taskPort } = deps;
  const mailDeps: MailDeps = { db, repository, clock, logger, transport: deps.mail, deliveryStatus, senderAddress };
  const scheduleDeps: SurveyScheduleDeps = {
    db,
    repository,
    clock,
    logger,
    taskPort,
    serviceUrls: deps.env.OPT2_SERVICE_URLS,
  };
  return [
    { consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema },
    { consumer: loginMailConsumer(mailDeps), payloadSchema: loginMailSchema },
    { consumer: surveyScheduledConsumer(scheduleDeps), payloadSchema: surveyScheduledSchema },
  ];
}
