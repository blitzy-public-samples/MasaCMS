// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { MESSAGE_TEMPLATE } from '../../repo/tables.js';

/** Mapping of fixture table `synthetic.message_template` to `communications.message_template`, tenant from the row's own `siteID`. */
export const messageTemplateMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.message_template',
  // A mapping's target table is schema-qualified; MESSAGE_TEMPLATE.table is the repository's unqualified name, MESSAGE_TEMPLATE.unit the qualified one.
  targetTable: MESSAGE_TEMPLATE.unit,
  unit: MESSAGE_TEMPLATE.unit,
  columns: [
    { legacy: 'template_id', target: 'template_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'name', target: 'name', type: 's' },
    { legacy: 'subject', target: 'subject', type: 's' },
    { legacy: 'body_text', target: 'body_text', type: 's' },
    { legacy: 'body_html', target: 'body_html', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
    { legacy: 'lastUpdate', target: 'lastupdate', type: 't' },
  ],
  // The spec key names legacy columns; the legacy and target key column share the name template_id.
  key: MESSAGE_TEMPLATE.key,
  tenant: { kind: 'site', column: 'siteID' },
});
