// cusers/loadextendedattributes.cfm 106/184: admin-only attributes stay editable for isSuperUser() or isAdminUser(),
// which read the session user's own site rather than rc.siteid.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminRequest } from '@/lib/request-context';
import {
  loadExtendedAttributesScreen,
  type ExtendSetDefinition,
  type ExtendSubject,
} from '@/screens/cusers/loadextendedattributes';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { makeScreenContext } from '../../helpers/screen-context';

const ACTION = { circuit: 'cusers', item: 'loadExtendedAttributes' } as const;

/** One Default set holding one admin-only TextBox, whose name only its editable input prints. */
const ADMIN_ONLY_SETS: readonly ExtendSetDefinition[] = [
  {
    extendSetID: 'EA000000-0000-0000-00000000000000C1',
    categoryID: '',
    name: 'Admin',
    attributes: [
      {
        attributeID: 9101,
        name: 'extAdminOnly',
        label: 'Restricted',
        hint: '',
        type: 'TextBox',
        adminOnly: 1,
        required: 'false',
        validation: '',
        regex: '',
        message: '',
        defaultValue: '',
        optionList: '',
        optionLabelList: '',
      },
    ],
  },
];

const SUBJECT: ExtendSubject = {
  userID: 'EA000000-0000-0000-0000000000000001',
  siteID: 'tenant-a',
  valueOf: () => 'stored',
  fileMetaData: () => undefined,
};

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('loadExtendedAttributesScreen admin-only attributes', () => {
  it.each<[string, () => AdminRequest, boolean]>([
    ['the S2 admin', () => adminS2Request(ACTION), true],
    ['the tenant-a site admin on tenant-a', () => siteAdminRequest('tenant-a', ACTION), true],
    ['the tenant-a site admin on tenant-b, a site its token does not serve', () => siteAdminRequest('tenant-b', ACTION), true],
    ['the editor', () => editorRequest(ACTION), false],
  ])('leaves them editable for %s: %s', async (_who, request, editable) => {
    const ctx = makeScreenContext({ req: request() });
    const data = { subject: SUBJECT, defaultSets: ADMIN_ONLY_SETS, basicSets: [] };

    const body = String((await loadExtendedAttributesScreen.render(ctx, data)).body);

    expect(body.includes('extAdminOnly')).toBe(editable);
    expect(body.includes('stored')).toBe(true);
  });
});
