// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Message state changes in the caller's transaction, and the dependencies shared by the communications domain. */
import type { Logger } from '@opt2/platform/logging';
import { RepositoryError, type WriteContext } from '@opt2/platform/migration-kit';
import { writeOutbox } from '@opt2/platform/outbox';
import type { Clock } from '@opt2/platform/service-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import {
  DELIVERY_STATUS_AGGREGATE_TYPE,
  DELIVERY_STATUS_CHANGED_TOPIC,
  DELIVERY_STATUS_KIND,
  buildDeliveryStatusPayload,
} from '../events/delivery-status-changed.js';
import type { CommunicationsRepository } from '../repo/repository.js';
import { MESSAGE, type DeliveryStatusRow, type MessageRow, type MessageState } from '../repo/tables.js';
import type { DeliveryStatusSource } from './delivery-status.js';
import type { MailTransport } from './mail-transport.js';
import type { SenderAddressSource } from './sender-address.js';

export type { MessageState };

/** Dependencies every communications domain operation receives. */
export interface DomainDeps {
  db: TenantDb;
  repository: CommunicationsRepository;
  clock: Clock;
  logger: Logger;
}

/** Domain dependencies plus the mail ports: SMTP transport, Mailpit confirmation and sender address. */
export interface MailDeps extends DomainDeps {
  transport: MailTransport;
  deliveryStatus: DeliveryStatusSource;
  senderAddress: SenderAddressSource;
}

/** The message after a state change and the history row that recorded it. */
export interface StatusChange {
  message: MessageRow;
  status: DeliveryStatusRow;
}

/**
 * Records `state` for `message` in `tx`: appends the history row, sets the message state (and `sent_at` for `sent`)
 * at that row's recorded time, bumps `row_version` and writes the delivery-status outbox event; never opens a transaction.
 * `detail` is the history row's detail, such as the fixture's `smtp-error` or `mailpit-not-found` on `failed`.
 * Throws RepositoryError when the message is absent from the transaction tenant.
 */
export async function recordStatus(
  tx: TenantTx,
  deps: Pick<DomainDeps, 'repository' | 'clock'>,
  message: MessageRow,
  state: MessageState,
  mailpitId?: string | null,
  context?: WriteContext,
  // Last, so the six-argument call stays valid; only the fixture's failed rows carry a detail.
  detail?: string | null,
): Promise<StatusChange> {
  const status = await deps.repository.appendDeliveryStatus(
    tx,
    { messageId: message.message_id, state, detail: detail ?? null, mailpitId: mailpitId ?? null, source: message.source },
    context,
  );
  const updated = await deps.repository.setMessageState(
    tx,
    { messageId: message.message_id, state, at: status.recorded_at },
    context,
  );
  if (updated === null) {
    throw new RepositoryError(`message ${message.message_id} does not exist`, MESSAGE.table);
  }
  await writeOutbox(tx, {
    topic: DELIVERY_STATUS_CHANGED_TOPIC,
    kind: DELIVERY_STATUS_KIND,
    aggregateType: DELIVERY_STATUS_AGGREGATE_TYPE,
    aggregateId: updated.message_id,
    // int8 arrives as a decimal string.
    aggregateVersion: Number(updated.row_version),
    payload: buildDeliveryStatusPayload(updated, status),
  });
  return { message: updated, status };
}
