/** Migration apply bodies of identity's legacy tables, encoded as the migration service sends them. */
import { cfUuid } from '@opt2/platform/legacy-compat';
import { encodeRow, type ApplyRequest, type Mapping } from '@opt2/platform/migration-kit';
import { tusersGroupAccountMapping } from '../../src/migration/mappings/index.js';

/** Every tusers column in catalog order, as a window import or the feed encodes the row. */
const TUSERS_COLUMNS = tusersGroupAccountMapping.legacyColumns;

/** One batch of `mapping`'s legacy table for `siteId`; window batches name their unit and holder, as a window import does. */
export function batchOf(
  mapping: Mapping,
  siteId: string,
  origin: ApplyRequest['origin'],
  rows: ReadonlyArray<{ op: 'upsert' | 'delete'; values: Record<string, unknown>; discriminator?: number }>,
  holderId?: string,
): ApplyRequest {
  const columns = mapping.legacyTable === 'tusers' ? TUSERS_COLUMNS : mapping.legacyColumns;
  const blank = Object.fromEntries(columns.map((column) => [column.name, null]));
  return {
    batchId: `${mapping.legacyTable}-${cfUuid()}`,
    origin,
    legacyTable: mapping.legacyTable,
    siteId,
    columns: columns.map((column) => ({ ...column })),
    units: [mapping.unit],
    ...(holderId === undefined ? {} : { holderId }),
    rows: rows.map(({ op, values, discriminator }) => ({
      op,
      row: encodeRow(columns, { ...blank, ...values }),
      ...(discriminator === undefined ? {} : { discriminator }),
    })),
  };
}
