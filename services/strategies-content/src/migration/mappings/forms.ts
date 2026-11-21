/** Masa form responses `tformresponsepackets` and `tformresponsequestions` ↔ `content.form_response_packet` and `content.form_response_question`. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { FORM_RESPONSE_PACKET, FORM_RESPONSE_QUESTION } from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

/** Mapped columns for legacy spellings, each taking the name and canonical type of its lower-cased target column. */
function columnsOf(legacyTable: string, definition: ContentUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

/** `tformresponsepackets` ↔ `content.form_response_packet` [mssql.sql:287-294,737-741]; `Data` is WDDX carried as byte-exact text; tenant from `SiteID`. */
export const tformresponsepacketsMapping: Mapping = defineMapping({
  legacyTable: 'tformresponsepackets',
  targetTable: FORM_RESPONSE_PACKET.unit,
  unit: FORM_RESPONSE_PACKET.unit,
  columns: columnsOf('tformresponsepackets', FORM_RESPONSE_PACKET, ['ResponseID', 'FormID', 'SiteID', 'FieldList', 'Data', 'Entered']),
  key: ['ResponseID'],
  tenant: { kind: 'site', column: 'SiteID' },
});

/** `tformresponsequestions` ↔ `content.form_response_question` [mssql.sql:297-303, 7.0.cfm:38-39, 7.1.cfm:17]; tenant from the parent packet's `SiteID`. */
export const tformresponsequestionsMapping: Mapping = defineMapping({
  legacyTable: 'tformresponsequestions',
  targetTable: FORM_RESPONSE_QUESTION.unit,
  unit: FORM_RESPONSE_QUESTION.unit,
  columns: columnsOf('tformresponsequestions', FORM_RESPONSE_QUESTION, ['responseID', 'formID', 'formField', 'formValue', 'pollValue']),
  key: ['responseID', 'formID', 'formField'],
  // dataCollectionManager.save inserts questions before their packet and skips an empty packet, so a question can lack a parent and load as an umbrella orphan.
  tenant: { kind: 'parent', parentLegacyTable: 'tformresponsepackets', columns: { responseID: 'ResponseID' } },
});
