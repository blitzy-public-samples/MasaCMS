/** Stored person rows at a fixed instant for the people publish suites. */
import { cfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import type { PersonRow } from '../../src/repo/tables.js';

/** Fixed instant of the publish suites. */
export const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
/** `NOW` as payloads carry local timestamps. */
export const NOW_TEXT = '2026-06-30 10:00:00.000';

/** A stored person row as pg returns it, with `overrides` applied. */
export function personRow(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    tenant_id: TENANT_A.tenantId,
    userid: cfUuid(),
    groupname: null,
    fname: 'Pat',
    lname: 'Lee',
    email: 'pat@example.com',
    company: null,
    jobtitle: null,
    mobilephone: null,
    website: null,
    subtype: 'Default',
    ext: null,
    contactform: null,
    lastupdate: NOW,
    lastupdateby: 'Ada Admin',
    lastupdatebyid: 'ACTOR',
    siteid: TENANT_A.siteId,
    subscribe: 1,
    notes: null,
    description: null,
    interests: null,
    keepprivate: 0,
    photofileid: null,
    imname: null,
    imservice: null,
    created: NOW,
    tags: null,
    row_version: '1',
    ...overrides,
  };
}
