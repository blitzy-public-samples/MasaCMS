// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** recordStatus over an in-memory repository double when the message is absent from the transaction tenant. */
import { describe, expect, it, vi } from 'vitest';
import { RepositoryError } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, fixedClock } from '@opt2/platform/testing';
import { recordStatus } from '../../src/domain/delivery.js';
import type { CommunicationsRepository, NewDeliveryStatus } from '../../src/repo/repository.js';
import { MESSAGE, type DeliveryStatusRow, type MessageRow } from '../../src/repo/tables.js';

const MESSAGE_ID = '7A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const RECORDED_AT = new Date(2026, 5, 30, 9, 15, 8);

const ROW: MessageRow = {
  tenant_id: TENANT_A.tenantId,
  message_id: MESSAGE_ID,
  siteid: TENANT_A.siteId,
  template_id: null,
  to_address: 'ann@example.com',
  from_address: 'noreply@opt2.local',
  subject: 'Hello',
  body_text: 'Hi',
  body_html: '',
  state: 'queued',
  created: new Date(2026, 5, 30, 9, 15, 7),
  sent_at: null,
  source: 'send',
  event_id: null,
  row_version: '2',
};

describe('recordStatus', () => {
  it('throws RepositoryError for a message absent from the transaction tenant, after the history append and before any outbox write', async () => {
    const query = vi.fn(() => Promise.reject(new Error('no SQL expected')));
    const onCommit = vi.fn();
    const tx = { kind: 'tenant', tenantId: TENANT_A.tenantId, schema: 'communications', query, onCommit } as unknown as TenantTx;
    const appendDeliveryStatus = vi.fn(
      (_tx: TenantTx, input: NewDeliveryStatus): Promise<DeliveryStatusRow> =>
        Promise.resolve({
          tenant_id: TENANT_A.tenantId,
          status_id: 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6',
          message_id: input.messageId,
          status: input.state,
          detail: input.detail ?? null,
          mailpit_id: input.mailpitId ?? null,
          recorded_at: RECORDED_AT,
          source: input.source,
        }),
    );
    const setMessageState = vi.fn(() => Promise.resolve(null));
    const repository = { appendDeliveryStatus, setMessageState } as unknown as CommunicationsRepository;

    const error = await recordStatus(tx, { repository, clock: fixedClock(RECORDED_AT) }, ROW, 'sent').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RepositoryError);
    expect(error).toMatchObject({ table: MESSAGE.table, message: `${MESSAGE.table}: message ${MESSAGE_ID} does not exist` });
    expect(appendDeliveryStatus.mock.calls).toEqual([[tx, { messageId: MESSAGE_ID, state: 'sent', detail: null, mailpitId: null, source: 'send' }, undefined]]);
    expect(setMessageState.mock.calls).toEqual([[tx, { messageId: MESSAGE_ID, state: 'sent', at: RECORDED_AT }, undefined]]);
    expect(query).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
