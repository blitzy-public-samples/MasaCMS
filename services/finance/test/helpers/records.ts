// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture-shaped finance rows for seeding the recording db, building migration apply payloads and stating expected rows. */
import { createHash } from 'node:crypto';
import { LEGACY_ADMIN_SENTINEL_ID, cfUuid } from '@opt2/platform/legacy-compat';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TEST_CLOCK } from './app.js';
import {
  FINANCE_ATTACHMENT,
  FINANCE_RECORD,
  FINANCE_RECORD_VERSION,
  PROGRAM_BINDING,
  attachmentObjectKey,
  type FinanceAttachmentRow,
  type FinanceRecordRow,
  type FinanceRecordVersionRow,
  type ProgramBindingRow,
} from '../../src/repo/tables.js';

const MONEY = /^-?\d+\.\d{4}$/;
const INITIAL_ROW_VERSION = '1';

/** `Program_<id>` schema of each fixture site, as `synthetic.program_site` maps them. */
export const PROGRAM_FOR_SITE: Readonly<Record<string, number>> = Object.freeze({ 'tenant-a': 1, 'tenant-b': 2 });

/** Options of {@link recordRow}; omitted values take the fixture defaults. */
export interface RecordRowOptions {
  state?: string;
  version?: number;
  amount?: string;
  period?: string;
  siteid?: string;
  legacyProgramId?: number;
  id?: string;
  title?: string;
}

/** Options of {@link versionRow}. */
export interface VersionRowOptions {
  action: string;
  version: number;
}

/** Options of {@link attachmentRow}; a string is taken as UTF-8. */
export interface AttachmentRowOptions {
  fileName: string;
  contentType: string;
  bytes: Buffer | Uint8Array | string;
}

/** An attachment row with the bytes its object holds. */
export interface AttachmentFixture {
  row: FinanceAttachmentRow;
  bytes: Buffer;
}

function programOf(siteid: string, legacyProgramId?: number): number {
  const program = legacyProgramId ?? (Object.hasOwn(PROGRAM_FOR_SITE, siteid) ? PROGRAM_FOR_SITE[siteid] : undefined);
  if (program === undefined) throw new Error(`site ${JSON.stringify(siteid)} has no Program_<id> schema in synthetic.program_site`);
  return program;
}

function money(amount: string): string {
  if (!MONEY.test(amount)) throw new Error(`amount ${JSON.stringify(amount)} is not a four-decimal numeric(19,4) string`);
  return amount;
}

/** Time of the step that produced `record`'s current state: its last update, else its creation. */
function stampOf(record: FinanceRecordRow): Date {
  return new Date((record.lastupdate ?? record.created).getTime());
}

/** `row` with its keys in the column order of `def`. */
function inColumnOrder<T extends Record<string, unknown>>(def: { readonly columns: readonly { readonly name: string }[] }, row: T): T {
  return Object.fromEntries(def.columns.map(({ name }) => [name, row[name]])) as T;
}

/** A `finance.record` row of `siteid`'s program, as the fixture holds it after `version` lifecycle steps. */
export function recordRow({
  state = 'IN-PROGRESS',
  version = 1,
  amount = '100.0000',
  period = '2026-06',
  siteid = 'tenant-a',
  legacyProgramId,
  id,
  title = 'Test record',
}: RecordRowOptions = {}): FinanceRecordRow {
  // usp_finance_create leaves lastUpdate and lastUpdateByID NULL; only a later step sets them.
  const updated = version > 1;
  return inColumnOrder<FinanceRecordRow>(FINANCE_RECORD, {
    tenant_id: tenantIdForSite(siteid),
    record_id: id ?? cfUuid(),
    siteid,
    title,
    amount: money(amount),
    period,
    state,
    version,
    created: TEST_CLOCK.now(),
    createdbyid: LEGACY_ADMIN_SENTINEL_ID,
    lastupdate: updated ? TEST_CLOCK.now() : null,
    lastupdatebyid: updated ? LEGACY_ADMIN_SENTINEL_ID : null,
    legacy_program_id: programOf(siteid, legacyProgramId),
    row_version: INITIAL_ROW_VERSION,
  });
}

/** The `finance.record_version` row `action` wrote at `version`, snapshotting `record` as it now stands. */
export function versionRow(record: FinanceRecordRow, { action, version }: VersionRowOptions): FinanceRecordVersionRow {
  return inColumnOrder<FinanceRecordVersionRow>(FINANCE_RECORD_VERSION, {
    tenant_id: record.tenant_id,
    version_id: cfUuid(),
    record_id: record.record_id,
    version,
    state: record.state,
    title: record.title,
    amount: money(record.amount),
    period: record.period,
    action,
    actor_user_id: record.lastupdatebyid ?? record.createdbyid,
    created: stampOf(record),
    legacy_program_id: record.legacy_program_id,
    row_version: INITIAL_ROW_VERSION,
  });
}

/** A `finance.attachment` row of `record` and its bytes; the row keeps only the object key, never the content. */
export function attachmentRow(record: FinanceRecordRow, { fileName, contentType, bytes }: AttachmentRowOptions): AttachmentFixture {
  const content = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  const attachmentId = cfUuid();
  const row = inColumnOrder<FinanceAttachmentRow>(FINANCE_ATTACHMENT, {
    tenant_id: record.tenant_id,
    attachment_id: attachmentId,
    record_id: record.record_id,
    file_name: fileName,
    content_type: contentType,
    size_bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    object_key: attachmentObjectKey(record.tenant_id, attachmentId, fileName),
    created: stampOf(record),
    createdbyid: record.createdbyid,
    legacy_program_id: record.legacy_program_id,
    row_version: INITIAL_ROW_VERSION,
  });
  return { row, bytes: content };
}

/** The `finance.program_binding` row folding `siteid`'s `Program_<id>` schema into its tenant. */
export function programBindingRow(siteid: string): ProgramBindingRow {
  return inColumnOrder<ProgramBindingRow>(PROGRAM_BINDING, {
    tenant_id: tenantIdForSite(siteid),
    site_id: siteid,
    legacy_program_id: programOf(siteid),
    updated_at: TEST_CLOCK.now(),
  });
}
