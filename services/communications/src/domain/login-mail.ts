// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Login mail from `identity.login-mail.requested.v1`: stored on consume, sent by mailer.cfc sendText's rules after commit, recovered when lost. */
import type { ConsumerDefinition } from '@opt2/platform/events';
import { serializeError, type Logger } from '@opt2/platform/logging';
import {
  GateClosedError,
  GateRaceError,
  OperationBlockedError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  acquireWriteGates,
  awaitReadable,
  qualified,
  withGatedTenant,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import type { RecoveryHook } from '@opt2/platform/outbox';
import { registeredTenants, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import type { IdentityLoginMailRequestedV1Payload } from '../generated/events/identity.login-mail.requested.v1.js';
import { RECOVERY_BATCH_SIZE, findMessage, messageCursor, queuedLoginMailOlderThan, type BatchCursor } from '../repo/queries.js';
import { OWNER } from '../repo/repository.js';
import { DELIVERY_STATUS, MESSAGE, type MessageRow, type MessageSource } from '../repo/tables.js';
import { recordStatus, type MailDeps } from './delivery.js';
import { sendTextBody, type OutgoingMail } from './mail-transport.js';
import { MAILPIT_NOT_FOUND_DETAIL, SMTP_ERROR_DETAIL, confirmMessage, outgoingMailFor, sendMessage } from './messages.js';
import { filterEmails } from './sender-address.js';

/** `message.source` of every login mail. */
export const LOGIN_MAIL_SOURCE = 'login-mail' satisfies MessageSource;

/** Age after which a login mail still `queued` is taken over by the sweep's recovery hook. */
export const LOGIN_MAIL_RECOVERY_AGE_MS = 30_000;

/** Name of the outbox-sweep recovery hook. */
export const LOGIN_MAIL_RECOVERY_HOOK = 'communications-login-mail';

// The event is identity's request, so the message and its follow-up states are written on identity's behalf.
const LOGIN_MAIL_CONTEXT: WriteContext = Object.freeze({ origin: 'target', actorService: 'identity' });
const RECOVERY_CONTEXT: WriteContext = Object.freeze({ origin: 'target', actorService: OWNER });

/** mailer.cfc sendText's sender: the site's from address shown as `from`, or as itself when a site is set and `from` is empty. */
export function loginMailFrom(
  payload: Pick<IdentityLoginMailRequestedV1Payload, 'from' | 'siteId'>,
  fromEmail: string,
): { name: string; address: string } {
  const name = payload.from !== '' ? payload.from : payload.siteId !== '' ? fromEmail : '';
  return { name, address: fromEmail };
}

/** The text-only mail of a stored login mail for its filtered recipients; no Bcc, as sendLogin passes none. */
function loginMail(message: MessageRow, to: string, fromEmail: string): OutgoingMail {
  const from = loginMailFrom({ from: message.from_address, siteId: message.siteid }, fromEmail);
  return { ...outgoingMailFor(message, from), to, text: sendTextBody(message.body_text), html: '' };
}

/** Effect of the login-mail consumer: stores the mail `queued` in the destination transaction and sends it once that commits. */
export function applyLoginMail(deps: MailDeps): ConsumerDefinition<IdentityLoginMailRequestedV1Payload>['apply'] {
  return async (tx, envelope) => {
    const { payload } = envelope;
    // An outbox replay carries a new eventId for a message an earlier event already stored.
    if ((await findMessage(tx, payload.messageId)) !== null) {
      return;
    }
    const inserted = await deps.repository.insertMessage(
      tx,
      {
        messageId: payload.messageId,
        siteId: payload.siteId,
        // Stored as received; recipients are filtered and the From resolved when the mail is sent.
        toAddress: payload.to,
        fromAddress: payload.from,
        subject: payload.subject,
        bodyText: payload.text,
        bodyHtml: '',
        state: 'queued',
        source: LOGIN_MAIL_SOURCE,
        eventId: envelope.eventId,
      },
      LOGIN_MAIL_CONTEXT,
    );
    const { message } = await recordStatus(tx, deps, inserted, 'queued', null, LOGIN_MAIL_CONTEXT);
    const { tenantId } = tx;
    tx.onCommit(
      async () => {
        await deliverLoginMail(deps, tenantId, message);
      },
      (error) => {
        deps.logger.error(
          { tenantId, eventId: envelope.eventId, error: serializeError(error) },
          `login mail ${message.message_id} stays queued for recovery: delivery after commit failed`,
        );
      },
    );
  };
}

/**
 * Sends a committed login mail and confirms it through Mailpit; returns the updated message.
 * With no valid recipient it records `failed` and sends nothing, as sendText sends no mail.
 */
export async function deliverLoginMail(deps: MailDeps, tenantId: string, message: MessageRow): Promise<MessageRow> {
  const fromEmail = await deps.senderAddress.fromEmail(message.siteid);
  const to = filterEmails(message.to_address);
  if (to === '') {
    const change = await withGatedTenant(deps.db, tenantId, (tx) => recordStatus(tx, deps, message, 'failed', null, LOGIN_MAIL_CONTEXT));
    return change.message;
  }
  const sent = await sendMessage(deps, { tenantId, message, mail: loginMail(message, to, fromEmail), context: LOGIN_MAIL_CONTEXT });
  return sent.state === 'sent' ? confirmMessage(deps, { tenantId, message: sent, context: LOGIN_MAIL_CONTEXT }) : sent;
}

/** Errors of a unit gate that is closed, racing, legacy-authoritative or behind a write window. */
function isGateError(error: unknown): boolean {
  return (
    error instanceof GateClosedError ||
    error instanceof GateRaceError ||
    error instanceof UnitNotAuthoritativeError ||
    error instanceof UnitReadBlockedError ||
    error instanceof OperationBlockedError
  );
}

/** Locks the message for this transaction; null when another transaction holds it or it is no longer `queued`. */
async function claimQueued(tx: TenantTx, messageId: string): Promise<MessageRow | null> {
  await awaitReadable(tx, [MESSAGE.unit]);
  const { rows } = await tx.query<MessageRow>(
    `SELECT * FROM ${qualified(tx.schema, MESSAGE.table)} WHERE message_id = $1 FOR UPDATE SKIP LOCKED`,
    [messageId],
  );
  const row = rows[0];
  return row !== undefined && row.state === 'queued' ? row : null;
}

/** Records `sent`, then `delivered` when Mailpit holds the mail or `failed` (`mailpit-not-found`) when it does not, in `tx`. */
async function recordSentAndConfirmed(tx: TenantTx, deps: MailDeps, message: MessageRow, mailpitId: string | null): Promise<void> {
  const { message: sent } = await recordStatus(tx, deps, message, 'sent', null, RECOVERY_CONTEXT);
  if (mailpitId === null) {
    await recordStatus(tx, deps, sent, 'failed', null, RECOVERY_CONTEXT, MAILPIT_NOT_FOUND_DETAIL);
    return;
  }
  await recordStatus(tx, deps, sent, 'delivered', mailpitId, RECOVERY_CONTEXT);
}

/**
 * Finishes one queued login mail under its row lock: a mail Mailpit already holds is only recorded, any other is sent.
 * The ports are called directly because sendMessage and confirmMessage open their own transactions, which would wait on that lock.
 */
async function recoverMessage(deps: MailDeps, logger: Logger, tenantId: string, messageId: string): Promise<void> {
  await withGatedTenant(deps.db, tenantId, async (tx) => {
    const message = await claimQueued(tx, messageId);
    if (message === null) {
      return;
    }
    // Taken before any port call: a gate race after the send would re-run this transaction and send the mail again.
    await acquireWriteGates(tx, [MESSAGE.unit, DELIVERY_STATUS.unit]);
    const found = await deps.deliveryStatus.confirm(message.message_id);
    if (found !== null) {
      await recordSentAndConfirmed(tx, deps, message, found);
      return;
    }
    const fromEmail = await deps.senderAddress.fromEmail(message.siteid);
    const to = filterEmails(message.to_address);
    if (to === '') {
      await recordStatus(tx, deps, message, 'failed', null, RECOVERY_CONTEXT);
      return;
    }
    try {
      await deps.transport.send(loginMail(message, to, fromEmail));
    } catch (error) {
      logger.error({ tenantId, error: serializeError(error) }, `login mail ${message.message_id}: recovery send failed`);
      await recordStatus(tx, deps, message, 'failed', null, RECOVERY_CONTEXT, SMTP_ERROR_DETAIL);
      return;
    }
    await recordSentAndConfirmed(tx, deps, message, await deps.deliveryStatus.confirm(message.message_id));
  });
}

/** Recovers the tenant's login mail queued before `cutoff`, batch by batch; a gate error ends the tenant, any other error only its row. */
async function recoverTenant(deps: MailDeps, logger: Logger, tenantId: string, cutoff: Date): Promise<void> {
  let after: BatchCursor | undefined;
  for (;;) {
    const batchRead = after === undefined ? {} : { after };
    const batch = await withTenant(deps.db, tenantId, (tx) => queuedLoginMailOlderThan(tx, cutoff, batchRead));
    for (const candidate of batch) {
      try {
        await recoverMessage(deps, logger, tenantId, candidate.message_id);
      } catch (error) {
        if (isGateError(error)) {
          throw error;
        }
        logger.error({ tenantId, error: serializeError(error) }, `login mail ${candidate.message_id}: recovery failed`);
      }
    }
    const last = batch.at(-1);
    if (batch.length < RECOVERY_BATCH_SIZE || last === undefined) {
      return;
    }
    after = messageCursor(last);
  }
}

/** Outbox-sweep hook that sends, or records as sent, every login mail left `queued` longer than LOGIN_MAIL_RECOVERY_AGE_MS. */
export function loginMailRecovery(deps: MailDeps): RecoveryHook {
  return {
    name: LOGIN_MAIL_RECOVERY_HOOK,
    async run(ctx) {
      const cutoff = new Date(ctx.clock.now().getTime() - LOGIN_MAIL_RECOVERY_AGE_MS);
      // Case-folded as withTenant folds them, so one tenant is never recovered twice in a sweep.
      const tenantIds = new Set((await registeredTenants(deps.db)).map(({ tenantId }) => tenantId.toLowerCase()));
      for (const tenantId of tenantIds) {
        try {
          await recoverTenant(deps, ctx.logger, tenantId, cutoff);
        } catch (error) {
          if (!isGateError(error)) {
            throw error;
          }
          ctx.logger.warn({ tenantId, error: serializeError(error) }, 'login mail recovery skipped the tenant for this sweep: unit gate');
        }
      }
    },
  };
}
