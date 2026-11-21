// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The communications mapping registry: every mapping module once, per-unit tables and columns, tenant sources, and the ttrash objectClass and class-extension baseTable shares. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mappingCoverage, resolveTenant, type Mapping } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { deliveryStatusMapping } from '../../src/migration/mappings/delivery-status.js';
import { emailMapping, emailReturnStatMapping, emailStatMapping } from '../../src/migration/mappings/email.js';
import {
  extendAttributeMapping,
  extendDataMapping,
  extendRcSetMapping,
  extendSetMapping,
  extendSubtypeMapping,
} from '../../src/migration/mappings/extend.js';
import * as registry from '../../src/migration/mappings/index.js';
import { mailingListMapping, mailingListMemberMapping } from '../../src/migration/mappings/mailing-list.js';
import { messageTemplateMapping } from '../../src/migration/mappings/message-template.js';
import { messageMapping } from '../../src/migration/mappings/message.js';
import { trashMapping } from '../../src/migration/mappings/trash.js';
import { OWNED_TABLES, SCHEDULED_TASK, TARGET_ONLY_COLUMNS, TRASH, UNITS } from '../../src/repo/tables.js';

interface ClassMapEntry {
  classes: string[];
  owner?: string;
  owners?: Record<string, string>;
}

interface Ownership {
  tables: { table: string; split?: { by: string; classMap: ClassMapEntry[] } }[];
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const TRASH_CLASS_MAP = OWNERSHIP.tables.find((table) => table.table === 'ttrash')?.split?.classMap ?? [];
/** The class-map owner of trashed mailing lists, which the migration sends as the discriminator of each communications ttrash row. */
const TRASH_OWNER = TRASH_CLASS_MAP.find((entry) => entry.classes.includes('mailinglist'))?.owner;
const COMMUNICATIONS_CLASSES = TRASH_CLASS_MAP.filter((entry) => entry.owner === TRASH_OWNER).flatMap((entry) => entry.classes);
/** Base tables whose extendObject trash rows the class map assigns to communications, sorted. */
const EXTEND_OBJECT_BASE_TABLES = Object.entries(TRASH_CLASS_MAP.find((entry) => entry.classes.includes('extendObject'))?.owners ?? {})
  .flatMap(([baseTable, owner]) => (owner === TRASH_OWNER ? [baseTable] : []))
  .sort();
/** Every other owner the class map names, sorted. */
const OTHER_OWNERS = [...new Set(TRASH_CLASS_MAP.flatMap((entry) => [entry.owner, ...Object.values(entry.owners ?? {})]))]
  .filter((owner): owner is string => owner !== undefined && owner !== TRASH_OWNER)
  .sort();

const MODULE_MAPPINGS: Record<string, Mapping> = {
  messageTemplateMapping,
  messageMapping,
  deliveryStatusMapping,
  emailMapping,
  emailStatMapping,
  emailReturnStatMapping,
  mailingListMapping,
  mailingListMemberMapping,
  trashMapping,
  extendSubtypeMapping,
  extendSetMapping,
  extendAttributeMapping,
  extendRcSetMapping,
  extendDataMapping,
};

/** The base tables of the communications class-extension share, as `mappingCoverage` suffixes them. */
const BASE_TABLES = 'synthetic.delivery_status,synthetic.message,synthetic.message_template,temailreturnstats,temails,temailstats,tmailinglist,tmailinglistmembers';

const MANAGED_COLUMNS = ['tenant_id', 'legacy_row_hash', 'occurrence'];

const TRASHED_LIST = {
  objectID: 'A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D',
  parentID: '00000000000000000000000000000000001',
  siteID: TENANT_A.siteId,
  objectLabel: 'Newsletter',
  objectClass: 'mailinglist',
  objectType: 'mailinglist',
  objectSubType: 'default',
  objectstring: "<wddxPacket version='1.0'><header/><data><struct><var name='NAME'><string>Newsletter </string></var></struct></data></wddxPacket>\r\n",
  deletedDate: '2026-06-30T14:05:09.123',
  deletedBy: 'admin',
  deleteid: null,
  orderno: '3',
};

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const SITE_TENANTS = registry.MAPPINGS.flatMap((mapping) =>
  mapping.tenant?.kind === 'site' ? [[mapping.legacyTable, mapping, mapping.tenant.column] as const] : [],
);
const PARENT_TENANTS = registry.MAPPINGS.flatMap((mapping, index) =>
  mapping.tenant?.kind === 'parent' ? [[mapping.legacyTable, mapping, index, mapping.tenant] as const] : [],
);

describe('communications mapping registry', () => {
  it('lists every mapping module export once, in UNITS order, frozen', () => {
    expect(Object.isFrozen(registry.MAPPINGS)).toBe(true);
    expect(registry.MAPPINGS).toHaveLength(Object.keys(MODULE_MAPPINGS).length);
    Object.values(MODULE_MAPPINGS).forEach((mapping, i) => expect(registry.MAPPINGS[i]).toBe(mapping));
    expect(registry.MAPPINGS.map((mapping) => mapping.unit)).toStrictEqual(UNITS.filter((unit) => unit !== SCHEDULED_TASK.unit));
  });

  it('re-exports each mapping module export under its own name', () => {
    const { MAPPINGS, ...named } = registry;

    expect(MAPPINGS).toBe(registry.MAPPINGS);
    expect(Object.keys(named).sort()).toStrictEqual(Object.keys(MODULE_MAPPINGS).sort());
    for (const [name, mapping] of Object.entries(MODULE_MAPPINGS)) expect(named[name as keyof typeof named]).toBe(mapping);
  });

  it('covers each legacy table once, ttrash only as its objectClass share and the class-extension tables only as their baseTable share', () => {
    expect(Object.keys(mappingCoverage(registry.MAPPINGS))).toStrictEqual([
      'synthetic.message_template',
      'synthetic.message',
      'synthetic.delivery_status',
      'temails',
      'temailstats',
      'temailreturnstats',
      'tmailinglist',
      'tmailinglistmembers',
      'ttrash{objectClass=communications}',
      `tclassextend{baseTable=${BASE_TABLES}}`,
      `tclassextendsets{baseTable=${BASE_TABLES}}`,
      `tclassextendattributes{baseTable=${BASE_TABLES}}`,
      `tclassextendrcsets{baseTable=${BASE_TABLES}}`,
      `tclassextenddata{baseTable=${BASE_TABLES}}`,
    ]);
  });

  it.each(registry.MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'maps %s onto every legacy-fed column of its owned table',
    (_legacyTable, mapping) => {
      const definition = OWNED_TABLES.find((table) => table.unit === mapping.unit);
      const targetOnly = new Set([...MANAGED_COLUMNS, ...(TARGET_ONLY_COLUMNS[definition?.table ?? ''] ?? [])]);
      const legacyFed = definition?.columns.filter((column) => !targetOnly.has(column.name)) ?? [];
      const targetKey = mapping.key?.map((legacy) => mapping.columns.find((column) => column.legacy === legacy)?.target) ?? null;

      expect(mapping.targetTable).toBe(`communications.${definition?.table ?? ''}`);
      expect([...mapping.targetColumns].sort(byName)).toStrictEqual([...legacyFed].sort(byName));
      expect(mapping.keyless).toBe(definition?.key === null);
      expect(targetKey).toStrictEqual(definition?.key);
    },
  );

  it('takes each tenant from the row site or, for history and stats rows, from the parent row', () => {
    expect(registry.MAPPINGS.map((mapping) => [mapping.legacyTable, mapping.tenant?.kind])).toStrictEqual([
      ['synthetic.message_template', 'site'],
      ['synthetic.message', 'site'],
      ['synthetic.delivery_status', 'parent'],
      ['temails', 'site'],
      ['temailstats', 'parent'],
      ['temailreturnstats', 'parent'],
      ['tmailinglist', 'site'],
      ['tmailinglistmembers', 'site'],
      ['ttrash', 'site'],
      ['tclassextend', 'site'],
      ['tclassextendsets', 'site'],
      ['tclassextendattributes', 'site'],
      ['tclassextendrcsets', 'site'],
      ['tclassextenddata', 'site'],
    ]);
  });

  it.each(SITE_TENANTS)('reads the tenant of %s from its mapped siteid column', (_legacyTable, mapping, siteColumn) => {
    expect(mapping.columns.find((column) => column.legacy === siteColumn)?.target).toBe('siteid');
  });

  it.each(PARENT_TENANTS)(
    'reads the tenant of %s through the key of a parent mapped before it',
    (_legacyTable, mapping, index, tenant) => {
      const parentIndex = registry.MAPPINGS.findIndex((other) => other.legacyTable === tenant.parentLegacyTable);

      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(index);
      expect(Object.keys(tenant.columns).filter((child) => !mapping.columns.some((column) => column.legacy === child))).toStrictEqual([]);
      expect(Object.values(tenant.columns)).toStrictEqual(registry.MAPPINGS[parentIndex]?.key);
    },
  );
});

describe('trash mapping', () => {
  it('takes the ttrash rows of class-map owner communications: its mailinglist and email rows and the extendObject rows of its base tables', () => {
    expect(TRASH_OWNER).toBe('communications');
    expect(COMMUNICATIONS_CLASSES).toStrictEqual(['mailinglist', 'email']);
    expect(EXTEND_OBJECT_BASE_TABLES.join(',')).toBe(BASE_TABLES);
    expect(trashMapping).toMatchObject({ legacyTable: 'ttrash', targetTable: 'communications.trash', unit: TRASH.unit, key: ['objectID'] });
    expect(trashMapping.split).toStrictEqual({ by: 'objectClass', value: TRASH_OWNER });
  });

  it.each(
    [...COMMUNICATIONS_CLASSES, 'extendObject'].flatMap((objectClass) =>
      [TRASH_OWNER, ...OTHER_OWNERS, null, undefined].map((discriminator) => [discriminator === TRASH_OWNER, objectClass, discriminator] as const),
    ),
  )('answers %s for a ttrash row of objectClass %s sent under discriminator %s', (accepted, objectClass, discriminator) => {
    expect(trashMapping.acceptsRow({ ...TRASHED_LIST, objectClass }, discriminator)).toBe(accepted);
  });

  it('maps a trashed mailing list onto communications.trash with its WDDX objectstring byte-exact and back', () => {
    const target = trashMapping.toTarget(TRASHED_LIST);

    expect(target).toStrictEqual({
      objectid: TRASHED_LIST.objectID,
      parentid: TRASHED_LIST.parentID,
      siteid: TENANT_A.siteId,
      objectlabel: 'Newsletter',
      objectclass: 'mailinglist',
      objecttype: 'mailinglist',
      objectsubtype: 'default',
      objectstring: TRASHED_LIST.objectstring,
      deleteddate: '2026-06-30 14:05:09.123',
      deletedby: 'admin',
      deleteid: null,
      orderno: '3',
    });
    expect(trashMapping.toLegacy(target)).toStrictEqual({ ...TRASHED_LIST, deletedDate: '2026-06-30 14:05:09.123' });
  });

  it.each<[string, string, string, boolean]>([
    ['its own site', `${TENANT_A.siteId}   `, TENANT_A.siteId, false],
    ['the umbrella site when it names none', '', TENANT_UMBRELLA.siteId, true],
  ])('resolves a trashed row to the tenant of %s', (_label, siteID, siteId, orphan) => {
    const tenant = trashMapping.tenant ?? { kind: 'umbrella' as const };

    expect(tenant).toStrictEqual({ kind: 'site', column: 'siteID' });
    expect(resolveTenant(tenant, { ...TRASHED_LIST, siteID }, { umbrellaSiteId: TENANT_UMBRELLA.siteId })).toStrictEqual({
      tenantId: tenantIdForSite(siteId),
      siteId,
      orphan,
    });
  });
});
