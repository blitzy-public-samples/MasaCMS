import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/people';
import { createCsrfRenderer } from '@/lib/csrf';
import { toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { loadEditUser, renderEditUser } from '@/screens/cusers/edituser';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type RecordedRequest } from '../../helpers/fake-gateway';

type UserEditData = components['schemas']['UserEditData'];
const USER_ID = 'EA000000-0000-0000-0000000000000001';
const BLOCKED_UNTIL = '2026-06-30T12:30:00.000';
const EDIT: UserEditData = {
  user: { UserID: USER_ID, Type: 2, SiteID: 'default', UserName: 'blocked-person', Fname: 'Jo', Lname: 'Doe', isPublic: 1 },
  isNew: false,
  tempIsPublic: 1,
  lockedSuper: false,
  blockedUntil: null,
  passwordExpired: false,
  addresses: [],
  privateGroups: [],
  publicGroups: [],
  groupIds: [],
  categoryIds: [],
  subTypes: [],
  extendedAttributes: {},
  sites: [{ siteID: 'default', site: 'Default' }],
  errors: {},
  retained: false,
};

let restoreEnv: () => void;
beforeEach(() => { restoreEnv = useTestEnv(); });
afterEach(() => { restoreEnv(); });

/** Issues a deterministic CSRF pair for each form context. */
function issueTokens(request: RecordedRequest) {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  return { status: 200, body: { tokens: contexts.map((context) => ({
    context, [CSRF_FIELD_TOKEN]: 'TESTCSRFTOKEN0000000000000000000', [CSRF_FIELD_EXPIRES]: '260630150000000',
  })) } };
}

/** Loads and renders Edit User with the owner's block answer. */
async function render(rc: Record<string, string>, blockedUntil: string | null) {
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'people', '/v1/users/edit')]: { status: 200, body: { ...EDIT, blockedUntil } },
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: issueTokens,
  });
  const ctx: ScreenContext = {
    req: adminS2Request({ circuit: 'cusers', item: 'edituser', rc: { userid: USER_ID, siteid: 'default', ...rc } }),
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
  const data = await loadEditUser(ctx);
  const view = await renderEditUser(ctx, data);
  return { gateway, data, body: toString(view.body) };
}

describe('cusers.edituser login block', () => {
  it.each([
    { name: 'removeBlock', value: '' },
    { name: 'REMOVEBLOCK', value: '' },
    { name: 'removeblock', value: 'false' },
    { name: 'ReMoVeBlOcK', value: 'anything' },
  ])('forwards $name=$value and renders the cleared block without an error', async ({ name, value }) => {
    const cleared = await render({ [name]: value }, null);
    expect(cleared.gateway.calls.find((call) => call.service === 'people')?.query).toEqual({
      siteid: 'default', userid: USER_ID, routeid: '', removeBlock: value,
    });
    expect(cleared.data.blockedUntil).toBeNull();
    expect(cleared.body).not.toContain('class="alert alert-error"');
    const unblocked = await render({}, null);
    expect(cleared.body).toBe(unblocked.body);
  });

  it('omits removeBlock when absent and renders the owner expiry and unblock link', async () => {
    const blocked = await render({}, BLOCKED_UNTIL);
    expect(blocked.gateway.calls.find((call) => call.service === 'people')?.query).not.toHaveProperty('removeBlock');
    expect(blocked.data.blockedUntil).toEqual(new Date(2026, 5, 30, 12, 30));
    expect(blocked.body).toContain('class="alert alert-error"');
    expect(blocked.body).toContain('&amp;removeBlock">[');
  });
});
