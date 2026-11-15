// cchain save and delete (admin/core/controllers/cchain.cfc 101-121), relayed to strategies-content.
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_HTML_CONTENT_TYPE,
  cfUuid,
} from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/strategies-content';
import { GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { mergeFw1Context, type AdminRequest, type RequestContext } from '@/lib/request-context';
import { fw1RedirectTarget } from '@/lib/urls';
import { cchainScreens, withCchainDefaults } from '@/screens/cchain';
import { submitCchainDelete } from '@/screens/cchain/delete';
import { submitCchainSave } from '@/screens/cchain/save';
import type { RedirectScreen, ScreenContext, SubmitResult } from '@/screens/registry';
import {
  APPROVAL_CHAIN_IDS,
  APPROVAL_GROUP_IDS,
  CCHAIN_PATHS,
} from '../../fixtures/strategies-content/approval-chains';
import { siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

type AdminWriteResult = components['schemas']['AdminWriteResult'];
type Item = 'save' | 'delete';
type Submit = (ctx: ScreenContext) => Promise<SubmitResult>;

const SITE = 'tenant-a';
const SERVICE = 'strategies-content';
const CHAIN = APPROVAL_CHAIN_IDS.standard;
const NAME = 'Standard Publishing';
const GROUPS = [APPROVAL_GROUP_IDS.contentEditors, APPROVAL_GROUP_IDS.contentPublishers] as const;
const CSRF = { [CSRF_FIELD_TOKEN]: 'ABC123', [CSRF_FIELD_EXPIRES]: '260630120000000' } as const;
const LIST_LOCATION = `./?muraAction=cchain.list&siteid=${SITE}`;
const FW1_LIST = { kind: 'redirect', action: 'cchain.list', append: 'siteid', path: './' } as const;
const SERVICE_LIST = { kind: 'redirect', action: 'cchain.list', path: './', queryString: `siteid=${SITE}` } as const;
const MISSING_VIEW = {
  kind: 'raw',
  response: { status: 500, contentType: LEGACY_HTML_CONTENT_TYPE, body: LEGACY_ERROR_PAGE_HTML },
} as const;

const listRedirect = (siteid: string = SITE): NonNullable<AdminWriteResult['redirect']> => ({
  circuit: 'cchain',
  action: 'list',
  params: [['siteid', siteid]],
});

const SAVED: AdminWriteResult = { saved: true, errors: {}, redirect: listRedirect() };
const BEAN_ERRORS: AdminWriteResult = { saved: false, errors: { name: 'The Name field is required.' }, redirect: null };
const DELETED: AdminWriteResult = { saved: true, errors: {}, redirect: listRedirect() };
const TOKEN_REJECTED: AdminWriteResult = { saved: false, errors: {}, redirect: listRedirect() };

const written = (result: AdminWriteResult): FakeReply => ({ status: 200, body: result });

const deletePath = (chainid: string, siteid: string = SITE): ServicePath =>
  `/v1/sites/${encodeURIComponent(siteid)}/approval-chains/${chainid}/delete`;

/** edit.cfm's form1 as FW/1 merges it: one `groupID` per member `li`, joined in `orderno` order. */
function editForm(chainID: string, groupIDs: readonly string[]): RequestContext {
  return mergeFw1Context([], {}, [
    ['name', NAME],
    ['description', ''],
    ...groupIDs.map((id): [string, string] => ['groupID', id]),
    ['siteid', SITE],
    ['chainID', chainID],
    ...Object.entries(CSRF),
  ]);
}

/** The delete link of list.cfm or edit.cfm: `chainID`, `siteid` and the URL CSRF fields. */
const deleteLink = (siteid: string = SITE): RequestContext => ({ chainID: CHAIN, siteid, ...CSRF });

/** The tenant-a site admin on `cchain.<item>` with `rc` as the admin set-up merged it. */
const requestFor = (item: Item, rc: RequestContext): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cchain', item, rc });

/** `req` after cchain `before()`, as the registry entry gives it to the action. */
const afterBefore = (req: AdminRequest): AdminRequest => ({ ...req, rc: withCchainDefaults(req.rc) });

function contextFor(req: AdminRequest, path: ServicePath, reply: FakeReply) {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [routeKey('POST', SERVICE, path)]: reply }) });
}

type Ctx = ReturnType<typeof contextFor>;

const saveContext = (rc: RequestContext, reply: FakeReply = written(SAVED)): Ctx =>
  contextFor(afterBefore(requestFor('save', rc)), CCHAIN_PATHS.save, reply);

const deleteContext = (
  reply: FakeReply,
  rc: RequestContext = deleteLink(),
  path: ServicePath = CCHAIN_PATHS.delete,
): Ctx => contextFor(afterBefore(requestFor('delete', rc)), path, reply);

/** Form fields of the one call `ctx` made, to `path`, with names lower-cased as legacy reads them. */
function relayed(ctx: Ctx, path: string): Record<string, string | string[]> {
  expect(ctx.gateway.calls.map((call) => `${call.service} ${call.method} ${call.path}`)).toEqual([
    `${SERVICE} POST ${path}`,
  ]);
  const form = ctx.gateway.calls[0]?.form ?? {};
  const fields = Object.fromEntries(Object.entries(form).map(([name, value]) => [name.toLowerCase(), value]));
  expect(Object.keys(fields)).toHaveLength(Object.keys(form).length);
  return fields;
}

/** The `Location` the admin handler sends for an FW/1 redirect outcome over `req.rc`. */
function locationOf(result: SubmitResult, req: AdminRequest): string {
  if (result.kind !== 'redirect') throw new Error(`${result.kind} is not an FW/1 redirect`);
  const keys = (result.append ?? '').split(',').filter((key) => key !== '');
  const append = keys.map((key): [string, string] => [key, req.rc[key] ?? '']);
  return fw1RedirectTarget({ action: result.action, append, queryString: result.queryString, path: result.path });
}

function entryOf(action: Item): RedirectScreen {
  const def = cchainScreens.find((candidate) => candidate.action === action);
  if (def?.mode !== 'redirect') throw new Error(`cchain.${action} is not a redirect-mode screen`);
  return def;
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('submitCchainSave', () => {
  it('save forwards defaulted rc with the merged groups', async () => {
    const ctx = saveContext(editForm(CHAIN, GROUPS));

    await submitCchainSave(ctx);

    expect(relayed(ctx, CCHAIN_PATHS.save)).toMatchObject({
      chainid: CHAIN,
      name: NAME,
      description: '',
      userid: '',
      requestid: '',
      actionid: '',
      actiontype: '',
      siteid: SITE,
      groupid: `${GROUPS[0]},${GROUPS[1]}`,
      csrf_token: 'ABC123',
      csrf_token_expires: '260630120000000',
    });
  });

  it('save redirects to cchain.list appending siteid', async () => {
    const ctx = saveContext(editForm(CHAIN, GROUPS));

    const result = await submitCchainSave(ctx);

    expect(result).toEqual(FW1_LIST);
    expect(locationOf(result, ctx.req)).toBe(LIST_LOCATION);
  });

  it('save forwards an empty groupid without members', async () => {
    const ctx = saveContext(editForm(CHAIN, []));

    await expect(submitCchainSave(ctx)).resolves.toEqual(FW1_LIST);
    expect(relayed(ctx, CCHAIN_PATHS.save)).toMatchObject({ groupid: '' });
  });

  it('save forwards a new chain id unchanged', async () => {
    const chainid = cfUuid();
    const ctx = saveContext(editForm(chainid, GROUPS.slice(0, 1)));

    await expect(submitCchainSave(ctx)).resolves.toEqual(FW1_LIST);
    expect(relayed(ctx, CCHAIN_PATHS.save)).toMatchObject({ chainid, groupid: GROUPS[0] });
  });

  it('save answers the missing-view 500 on bean errors', async () => {
    const ctx = saveContext(editForm(CHAIN, GROUPS), written(BEAN_ERRORS));

    await expect(submitCchainSave(ctx)).resolves.toEqual(MISSING_VIEW);
    relayed(ctx, CCHAIN_PATHS.save);
  });
});

describe('submitCchainDelete', () => {
  it.each<[string, string, ServicePath]>([
    ['list.cfm', SITE, CCHAIN_PATHS.delete],
    // edit.cfm puts a space between the siteid value and the CSRF fields.
    ['edit.cfm', `${SITE} `, deletePath(CHAIN, `${SITE} `)],
  ])('delete forwards the %s link rc', async (_link, siteid, path) => {
    const ctx = deleteContext(written({ ...DELETED, redirect: listRedirect(siteid) }), deleteLink(siteid), path);

    await submitCchainDelete(ctx);

    expect(relayed(ctx, path)).toMatchObject({ chainid: CHAIN, siteid, ...CSRF });
  });

  it.each<[string, AdminWriteResult]>([
    ['deleted', DELETED],
    ['token rejected', TOKEN_REJECTED],
  ])('delete redirects to cchain.list when %s', async (_outcome, answer) => {
    const ctx = deleteContext(written(answer));

    const result = await submitCchainDelete(ctx);

    expect(result).toEqual(SERVICE_LIST);
    expect(locationOf(result, ctx.req)).toBe(LIST_LOCATION);
  });
});

describe('gateway unavailable', () => {
  it.each<[Item, () => Ctx, Submit]>([
    ['save', () => saveContext(editForm(CHAIN, GROUPS)), submitCchainSave],
    ['delete', () => deleteContext(written(DELETED)), submitCchainDelete],
  ])('%s rejects with GatewayUnavailableError', async (_item, context, submit) => {
    const ctx = context();
    ctx.gateway.failWith();

    const error = await submit(ctx).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: SERVICE });
  });
});

describe('cchainScreens writes', () => {
  it('registers only save and delete in redirect mode', () => {
    expect(cchainScreens.filter((def) => def.mode === 'redirect').map((def) => def.action)).toEqual(['save', 'delete']);
    for (const action of ['save', 'delete'] as const) {
      expect(entryOf(action)).toMatchObject({ circuit: 'cchain', owner: SERVICE, mode: 'redirect' });
    }
  });

  it.each<[Item, RequestContext, ServicePath, AdminWriteResult, Submit]>([
    ['save', editForm(CHAIN, GROUPS), CCHAIN_PATHS.save, SAVED, submitCchainSave],
    ['delete', deleteLink(), CCHAIN_PATHS.delete, DELETED, submitCchainDelete],
  ])('%s entry submits its action after before()', async (item, rc, path, answer, submit) => {
    const viaEntry = contextFor(requestFor(item, rc), path, written(answer));
    const direct = contextFor(afterBefore(requestFor(item, rc)), path, written(answer));

    const result = await entryOf(item).submit(viaEntry);

    expect(result).toEqual(await submit(direct));
    expect(relayed(viaEntry, path)).toEqual(relayed(direct, path));
    expect(relayed(viaEntry, path)).toMatchObject({ userid: '', actiontype: '' });
  });
});
