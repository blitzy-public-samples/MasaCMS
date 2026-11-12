// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture row projections: target `finance` rows as finance.cfc's `envelope.rows()` renders the `Program_<id>.finance_*` rows. */
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import type { FinanceState } from '../domain/lifecycle.transitions.js';
import { formatMoney, moneyFromNumeric } from '../domain/money.js';
import type { RollupRow } from '../domain/rollup.js';
import type { FinanceAttachmentRow, FinanceRecordRow, FinanceRecordVersionRow, FinanceRollupRow } from '../repo/tables.js';

// envelope.cfc rows() renders datetime columns with this dateTimeFormat mask before serialization, not through the serializer's date hint.
const FIXTURE_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss";

/** A `finance_record` row: lower-cased column names in catalog order, NULL columns as ''. */
export type FixtureRecord = {
  record_id: string;
  siteid: string;
  title: string;
  amount: string;
  period: string;
  state: FinanceState;
  version: number;
  created: string;
  createdbyid: string;
  lastupdate: string;
  lastupdatebyid: string;
};

/** A `finance_record_version` row: lower-cased column names in catalog order. */
export type FixtureVersion = {
  version_id: string;
  record_id: string;
  version: number;
  state: FinanceState;
  title: string;
  amount: string;
  period: string;
  action: string;
  actor_user_id: string;
  created: string;
};

/** A `finance_attachment` metadata row, without its content: lower-cased column names in catalog order. */
export type FixtureAttachment = {
  attachment_id: string;
  record_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created: string;
  createdbyid: string;
};

/** A `finance_rollup` row: column names in catalog order. */
export type FixtureRollup = {
  period: string;
  state: FinanceState;
  record_count: number;
  total_amount: string;
  computed_at: string;
};

/** A record with its versions and attachment metadata, the contract's `FinanceRecordDetail`. */
export type FixtureRecordDetail = FixtureRecord & { versions: FixtureVersion[]; attachments: FixtureAttachment[] };

/** Fixture text of a stored datetime in the process (legacy server) zone, or '' for NULL. */
function timestamp(value: Date | null): string {
  return value === null ? '' : cfDateTimeFormat(value, FIXTURE_TIMESTAMP_MASK);
}

/** Four-decimal text of a numeric(19,4) amount as pg returns it. */
function amountText(numeric: string): string {
  return formatMoney(moneyFromNumeric(numeric));
}

/** Projects a `finance.record` row onto the fixture record fields. */
export function recordRow(row: FinanceRecordRow): FixtureRecord {
  return {
    record_id: row.record_id,
    siteid: row.siteid,
    title: row.title,
    amount: amountText(row.amount),
    period: row.period,
    state: row.state as FinanceState,
    version: row.version,
    created: timestamp(row.created),
    createdbyid: row.createdbyid,
    lastupdate: timestamp(row.lastupdate),
    lastupdatebyid: row.lastupdatebyid ?? '',
  };
}

/** Projects a `finance.record_version` row onto the fixture version fields. */
export function versionRow(row: FinanceRecordVersionRow): FixtureVersion {
  return {
    version_id: row.version_id,
    record_id: row.record_id,
    version: row.version,
    state: row.state as FinanceState,
    title: row.title,
    amount: amountText(row.amount),
    period: row.period,
    action: row.action,
    actor_user_id: row.actor_user_id,
    created: timestamp(row.created),
  };
}

/** Projects a `finance.attachment` row onto the fixture attachment metadata; the object key never leaves the service. */
export function attachmentRow(row: FinanceAttachmentRow): FixtureAttachment {
  return {
    attachment_id: row.attachment_id,
    record_id: row.record_id,
    file_name: row.file_name,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    created: timestamp(row.created),
    createdbyid: row.createdbyid,
  };
}

/** Projects a stored `finance.rollup` row, or a freshly computed rollup group, onto the fixture rollup fields. */
export function rollupRow(row: FinanceRollupRow | RollupRow): FixtureRollup {
  if ('recordCount' in row) {
    return {
      period: row.period,
      state: row.state as FinanceState,
      record_count: row.recordCount,
      total_amount: formatMoney(row.totalAmount),
      computed_at: timestamp(row.computedAt),
    };
  }
  return {
    period: row.period,
    state: row.state as FinanceState,
    record_count: row.record_count,
    total_amount: amountText(row.total_amount),
    computed_at: timestamp(row.computed_at),
  };
}

// The fixture's `GET records/{id}` answers the plain record row; this composite serves the `/v1` detail read, whose contract embeds both lists.
/** Projects a record with its version and attachment rows onto `FinanceRecordDetail`, each list in the order given. */
export function recordDetail(
  row: FinanceRecordRow,
  versions: readonly FinanceRecordVersionRow[],
  attachments: readonly FinanceAttachmentRow[],
): FixtureRecordDetail {
  return { ...recordRow(row), versions: versions.map(versionRow), attachments: attachments.map(attachmentRow) };
}
