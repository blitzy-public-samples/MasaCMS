// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Communications' consumer of `identity.login-mail.requested.v1`, the forgot-password and send-login mail identity requests. */
import { readTopicSchema, type ConsumerDefinition } from '@opt2/platform/events';
import type { MailDeps } from '../domain/delivery.js';
import { applyLoginMail } from '../domain/login-mail.js';
import type { IdentityLoginMailRequestedV1Payload as LoginMailRequestedPayload } from '../generated/events/identity.login-mail.requested.v1.js';

/** Payload of `identity.login-mail.requested.v1`, generated from identity's contract. */
export type { LoginMailRequestedPayload };

/** Topic of identity's login-mail request. */
export const LOGIN_MAIL_TOPIC = 'identity.login-mail.requested.v1' as const;

/** Payload schema of `identity.login-mail.requested.v1`, read once from the producer's contracts. */
export const loginMailSchema = readTopicSchema(
  new URL('../../../identity/contracts/events/identity.login-mail.requested.v1.json', import.meta.url),
);

/** Consumer that stores each requested login mail in the envelope tenant and sends it after commit. */
export function loginMailConsumer(deps: MailDeps): ConsumerDefinition<LoginMailRequestedPayload> {
  return {
    topic: LOGIN_MAIL_TOPIC,
    kind: 'process',
    apply: applyLoginMail(deps),
  };
}
