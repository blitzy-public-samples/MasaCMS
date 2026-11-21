// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { CanonicalValue, Mapping } from '@opt2/platform/migration-kit';
import { ATTACHMENT_CONTENT_FIELD, FINANCE_ATTACHMENT } from '../../repo/tables.js';

const columnsMapping: Mapping = defineMapping({
  // A folded mapping names the bare table; the handlers resolve Program_<id> names and add legacy_program_id themselves.
  legacyTable: 'finance_attachment',
  // Mapping targets are schema-qualified: FINANCE_ATTACHMENT.unit, not the repository's bare FINANCE_ATTACHMENT.table.
  targetTable: FINANCE_ATTACHMENT.unit,
  unit: FINANCE_ATTACHMENT.unit,
  // `content` is object-backed, so it stays out of the row encoding: reconciliation compares the object manifest instead.
  columns: [
    { legacy: 'attachment_id', target: 'attachment_id', type: 's' },
    { legacy: 'record_id', target: 'record_id', type: 's' },
    { legacy: 'file_name', target: 'file_name', type: 's' },
    { legacy: 'content_type', target: 'content_type', type: 's' },
    { legacy: 'size_bytes', target: 'size_bytes', type: 'i' },
    { legacy: 'sha256', target: 'sha256', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
    { legacy: 'createdByID', target: 'createdbyid', type: 's' },
  ],
  key: FINANCE_ATTACHMENT.key,
  fold: 'Program',
  // The fixture table has no siteID: synthetic.program_site maps the Program_<id> schema to its site.
  tenant: { kind: 'program' },
});

/** The decoded `content` value of a legacy row, its name matched case-insensitively as SQL Server matches it; undefined when absent. */
function legacyContent(legacyValues: Readonly<Record<string, CanonicalValue>>): CanonicalValue | undefined {
  for (const [name, value] of Object.entries(legacyValues)) {
    if (name.toLowerCase() === ATTACHMENT_CONTENT_FIELD) return value;
  }
  return undefined;
}

// Bytes pass unchecked: the repository verifies them against sha256, stores them in finance-attachments and sets object_key.
// Values are pg parameters (i and t as canonical text), so the row keeps Mapping's type rather than FinanceAttachmentApplyRow.
const toTarget: Mapping['toTarget'] = (legacyValues, opts) => {
  const row = columnsMapping.toTarget(legacyValues, opts);
  const content = legacyContent(legacyValues);
  return content === undefined ? row : { ...row, [ATTACHMENT_CONTENT_FIELD]: content };
};

/** Mapping of fixture table `Program_<id>.finance_attachment` to `finance.attachment`; `toTarget` also carries the legacy bytes under `content`. */
export const financeAttachmentMapping: Mapping = Object.freeze({ ...columnsMapping, toTarget });
