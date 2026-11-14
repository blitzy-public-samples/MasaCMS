// The native Edit Group, Edit User and Edit Address forms, posted as browsers post them, against their owners' contracts.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { assertRequestMatchesOpenApi } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { components } from '@/generated/clients/people';
import { createCsrfRenderer } from '@/lib/csrf';
import type { ServicePath } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { receiveRequestBody, type ReceivedBody, type RequestBody } from '@/lib/request-body';
import { mergeFw1Context, type AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { loadEditAddress, renderEditAddress, type AddressEditData } from '@/screens/cusers/editaddress';
import { NO_GROUP_SUBTYPES, loadEditGroup, renderEditGroup } from '@/screens/cusers/editgroup';
import { loadEditUser, renderEditUser } from '@/screens/cusers/edituser';
import { addUserAction, updateGroupAction, updateUserAction } from '@/screens/cusers/update';
import { updateAddressAction } from '@/screens/cusers/updateaddress';
import type { RedirectScreen, ScreenContext } from '@/screens/registry';
import { GROUP_IDS, groupsById } from '../../fixtures/identity/groups';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeCall,
  type FakeGatewayClient,
  type FakeReply,
  type RecordedRequest,
} from '../../helpers/fake-gateway';

type AddressRecord = components['schemas']['AddressRecord'];
type PersonRecord = components['schemas']['PersonRecord'];
type UserEditData = components['schemas']['UserEditData'];
type Entry = readonly [name: string, value: FormDataEntryValue];

/** A producer contract as consumer contract tests load it, by relative path. */
const contract = (service: 'identity' | 'people'): object => {
  const file = new URL(`../../../../services/${service}/contracts/openapi.yaml`, import.meta.url);
  return parse(readFileSync(file, 'utf8')) as object;
};

const IDENTITY = contract('identity');
const PEOPLE = contract('people');

const USER_ID = 'EA000000-0000-0000-0000000000000001';
const NEW_USER_ID = 'EA000000-0000-0000-0000000000000009';
const ADDRESS_ID = 'EA000000-0000-0000-0000000000000002';
const NEW_ADDRESS_ID = 'EA000000-0000-0000-0000000000000003';
const ADMIN_GROUP = { UserID: '3BE10D43-C960-A7E5-0FB807B791D31787', GroupName: 'Admin' };
const EDITOR_GROUP = { UserID: '3BEA0C3E-ADEF-CA41-18EF6712DF2AA18D', GroupName: 'Editor' };
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
/** The submit buttons' `userManager.submitForm(form, action)`, which sets `form.action.value` before submitting. */
const SUBMIT_SCRIPT = /userManager\.submitForm\(document\.forms\.form1,'([^']*)'\)/;

const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const GROUP_ROUTE = routeKey('GET', 'identity', `/v1/groups/${GROUP_IDS.defaultEditor}`);
const USER_EDIT_ROUTE = routeKey('GET', 'people', '/v1/users/edit');
const ADDRESS_EDIT_ROUTE = routeKey('GET', 'people', '/v1/users/address');
const ROUTE_USER = routeKey('GET', 'people', '/v1/users/route');

const GROUP_SAVED: FakeReply = {
  status: 200,
  body: { written: true, group: groupsById[GROUP_IDS.defaultEditor], errors: {} },
};
const USER_SAVED: FakeReply = { status: 200, body: { written: true, errors: {} } };
const ADDRESS_SAVED: FakeReply = {
  status: 200,
  body: { written: true, redirect: { action: 'cUsers.edituser', params: { siteid: 'default', userid: USER_ID } } },
};
/** people's `routeUser`: the posted return URL, else `cUsers.listusers`. */
function routed(request: RecordedRequest): FakeReply {
  const { returnurl } = request.query;
  const redirect =
    typeof returnurl === 'string' && returnurl !== ''
      ? { url: returnurl }
      : { action: 'cUsers.listusers', params: { siteid: 'default', ispublic: '0' } };
  return { status: 200, body: { redirect } };
}

const PERSON: PersonRecord = {
  UserID: USER_ID,
  Type: 2,
  SiteID: 'default',
  Fname: 'Ada',
  Lname: 'Lovelace',
  Email: 'ada@example.test',
  UserName: 'ada',
  subType: 'Default',
  isPublic: 0,
  S2: 0,
  InActive: 0,
  Subscribe: 0,
};

/** people's Edit User data of `user`; a stored user is in both system groups, so `groupid` repeats. */
const userEdit = (user: PersonRecord, isNew: boolean): UserEditData => ({
  user,
  isNew,
  tempIsPublic: isNew ? 1 : 0,
  lockedSuper: false,
  blockedUntil: null,
  passwordExpired: false,
  addresses: [],
  privateGroups: [ADMIN_GROUP, EDITOR_GROUP],
  publicGroups: [],
  groupIds: isNew ? [] : [ADMIN_GROUP.UserID, EDITOR_GROUP.UserID],
  categoryIds: [],
  subTypes: [],
  extendedAttributes: {},
  sites: [{ siteID: 'default', site: 'Default' }],
  errors: {},
  retained: false,
});

const NEW_USER = userEdit({ UserID: NEW_USER_ID, Type: 2, SiteID: '', subType: 'Default', isPublic: 1, S2: 0 }, true);
const STORED_USER = userEdit(PERSON, false);

const STORED_ADDRESS: AddressRecord = {
  addressID: ADDRESS_ID,
  userID: USER_ID,
  siteID: 'default',
  addressName: 'Office',
  address1: '1 Main St',
  city: 'Springfield',
  isPrimary: 1,
  hours: 'Mon-Fri 9-5\nSat 10-2',
};
const NEW_ADDRESS: AddressRecord = { addressID: NEW_ADDRESS_ID, userID: USER_ID };

const received: ReceivedBody[] = [];
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(async () => {
  await Promise.all(received.splice(0).map((body) => body.dispose?.() ?? Promise.resolve()));
  restoreEnv();
});

/** identity issuing a fixed pair for every requested context. */
function issueTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const token = (context: string) => ({
    context,
    [CSRF_FIELD_TOKEN]: 'TESTCSRFTOKEN0000000000000000000',
    [CSRF_FIELD_EXPIRES]: '260630150000000',
  });
  return { status: 200, body: { tokens: contexts.map(token) } };
}

// Built by hand: the registry's shell hooks import every circuit, and these screens read only the members set here.
/** The handlers' ScreenContext for `req` over `gateway`, with `body` when the request carried one. */
function contextFor(req: AdminRequest, gateway: FakeGatewayClient, body?: RequestBody): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
    body,
  };
}

/** The S2 admin's `cusers.<item>` request with `rc`. */
const adminRequest = (item: string, rc: Readonly<Record<string, string>>): AdminRequest =>
  adminS2Request({ circuit: 'cusers', item, rc });

/** The production Edit Group form for `rc`. */
async function editGroupForm(rc: Readonly<Record<string, string>>): Promise<string> {
  const gateway = fakeGatewayClient({
    [CSRF_ROUTE]: issueTokens,
    [GROUP_ROUTE]: { status: 200, body: { group: groupsById[GROUP_IDS.defaultEditor], isNew: false } },
  });
  const ctx = contextFor(adminRequest('editgroup', rc), gateway);
  return toString(renderEditGroup(ctx, await loadEditGroup(ctx, NO_GROUP_SUBTYPES)).body);
}

/** The production Edit User form for `rc`, people answering `edit`. */
async function editUserForm(rc: Readonly<Record<string, string>>, edit: UserEditData): Promise<string> {
  const gateway = fakeGatewayClient({ [USER_EDIT_ROUTE]: { status: 200, body: edit }, [CSRF_ROUTE]: issueTokens });
  const ctx = contextFor(adminRequest('edituser', rc), gateway);
  return toString((await renderEditUser(ctx, await loadEditUser(ctx))).body);
}

/** The production Edit Address form for `rc`, people answering `edit` and the person's `addresses`. */
async function editAddressForm(
  rc: Readonly<Record<string, string>>,
  edit: AddressEditData,
  addresses: readonly AddressRecord[],
): Promise<string> {
  const userEditReply: Partial<UserEditData> = { user: edit.user, isNew: false, addresses: [...addresses] };
  const gateway = fakeGatewayClient({
    [ADDRESS_EDIT_ROUTE]: { status: 200, body: edit },
    [USER_EDIT_ROUTE]: { status: 200, body: userEditReply },
    [CSRF_ROUTE]: issueTokens,
  });
  const ctx = contextFor(adminRequest('editaddress', rc), gateway);
  return toString(renderEditAddress(ctx, await loadEditAddress(ctx)).body);
}

/** `form1`'s action URL and the entry list `form.submit()` builds after `userManager.submitForm` sets `action`. */
function nativeSubmission(markup: string): { url: URL; entries: Entry[] } {
  const $ = cheerio.load(markup, null, false);
  const form = $('form[name="form1"]');
  expect(form).toHaveLength(1);
  const submits = form
    .find('[onclick]')
    .toArray()
    .flatMap((el) => SUBMIT_SCRIPT.exec($(el).attr('onclick') ?? '')?.[1] ?? []);
  expect(submits).toHaveLength(1);
  const entries: Entry[] = [];
  form.find('input, select, textarea').each((_, el) => {
    const control = $(el);
    const name = control.attr('name') ?? '';
    if (name === '' || control.is('[disabled]') || control.closest('fieldset[disabled]').length > 0) return;
    if (el.tagName === 'select') {
      const options = control.find('option');
      const selected = options.filter('[selected]');
      const single = selected.length > 0 ? selected.last() : options.not('[disabled]').first();
      const chosen = control.is('[multiple]') ? selected : single;
      chosen.each((_i, option) => {
        entries.push([name, $(option).attr('value') ?? $(option).text().replace(/\s+/g, ' ').trim()]);
      });
      return;
    }
    if (el.tagName === 'textarea') {
      entries.push([name, control.text()]);
      return;
    }
    const type = (control.attr('type') ?? 'text').toLowerCase();
    if (['submit', 'image', 'reset', 'button'].includes(type)) return;
    if (type === 'checkbox' || type === 'radio') {
      if (control.is('[checked]')) entries.push([name, control.attr('value') ?? 'on']);
      return;
    }
    // An empty file input posts an empty part without a file name.
    const value = type === 'file' ? new File([], '', { type: 'application/octet-stream' }) : (control.attr('value') ?? '');
    entries.push([name, value]);
  });
  const action = entries.findIndex(([name]) => name === 'action');
  expect(action).toBeGreaterThanOrEqual(0);
  entries[action] = ['action', submits[0] ?? ''];
  return { url: new URL(form.attr('action') ?? '', 'http://web.test/admin/'), entries };
}

/** A multipart post as received by web, with the bytes and content type the browser sent. */
interface Upload {
  readonly body: RequestBody;
  readonly bytes: Buffer;
  readonly contentType: string;
}

/** `entries` posted multipart to `url` as the browser sends them. */
async function post(url: URL, entries: readonly Entry[]): Promise<Upload> {
  const form = new FormData();
  for (const [name, value] of entries) form.append(name, value);
  const request = new Request(url, { method: 'POST', body: form });
  const bytes = Buffer.from(await request.clone().arrayBuffer());
  const contentType = request.headers.get('content-type') ?? '';
  const upload = await receiveRequestBody(request);
  received.push(upload);
  expect(upload.body).toBeDefined();
  return { body: upload.body as RequestBody, bytes, contentType };
}

/** `entries` as a CFML scope holds them: a file as its file name, repeated names joined with commas. */
const scopeOf = (entries: Iterable<Entry>): Record<string, string> => {
  const fields = [...entries].map(([name, value]) => [name, typeof value === 'string' ? value : value.name] as const);
  return { ...mergeFw1Context([], [], fields) };
};

/** The fields of `url`'s query that reach rc; FW/1 replaces `muraAction` with the qualified action. */
const actionUrlFields = (url: URL): Record<string, string> =>
  Object.fromEntries([...url.searchParams].filter(([name]) => name !== 'muraAction'));

/** The posted form's rc: its action URL's fields, then its posted fields. */
const postedRc = (url: URL, entries: Iterable<Entry>): Record<string, string> => ({
  ...mergeFw1Context([], Object.entries(actionUrlFields(url)), Object.entries(scopeOf(entries))),
});

/** The CFML form scope of a relayed multipart body. */
async function relayedScope(bytes: Buffer, contentType: string): Promise<Record<string, string>> {
  const request = new Request('http://owner.test/', {
    method: 'POST',
    body: new Uint8Array(bytes),
    headers: { 'content-type': contentType },
  });
  return scopeOf(await request.formData());
}

/** One native form and the owner write its post relays. */
interface FormCase {
  readonly name: string;
  readonly render: () => Promise<string>;
  readonly screen: RedirectScreen;
  /** The rc's posting action, `cusers.<item>`. */
  readonly item: string;
  readonly service: 'identity' | 'people';
  readonly contract: object;
  readonly method: 'POST' | 'PUT';
  /** The owner path for the posted `userid`. */
  readonly path: (userid: string) => ServicePath;
  readonly saved: FakeReply;
}

const CASES: readonly FormCase[] = [
  {
    name: 'Edit Group Add',
    render: () => editGroupForm({}),
    screen: updateGroupAction,
    item: 'update',
    service: 'identity',
    contract: IDENTITY,
    method: 'POST',
    path: () => '/v1/groups',
    saved: GROUP_SAVED,
  },
  {
    name: 'Edit Group Update',
    render: () => editGroupForm({ userid: GROUP_IDS.defaultEditor }),
    screen: updateGroupAction,
    item: 'update',
    service: 'identity',
    contract: IDENTITY,
    method: 'PUT',
    path: (userid) => `/v1/groups/${userid}`,
    saved: GROUP_SAVED,
  },
  {
    name: 'Edit User Add',
    render: () => editUserForm({ userid: '', siteid: 'default' }, NEW_USER),
    screen: addUserAction,
    item: 'update',
    service: 'people',
    contract: PEOPLE,
    method: 'POST',
    path: () => '/v1/users:update',
    saved: USER_SAVED,
  },
  {
    name: 'Edit User Update',
    render: () => editUserForm({ userid: USER_ID, siteid: 'default' }, STORED_USER),
    screen: updateUserAction,
    item: 'update',
    service: 'people',
    contract: PEOPLE,
    method: 'POST',
    path: () => '/v1/users:update',
    saved: USER_SAVED,
  },
  {
    name: 'Edit Address Add',
    render: () =>
      editAddressForm(
        { userid: USER_ID, siteid: 'default', routeid: 'x y&z', addressID: '' },
        { user: PERSON, address: NEW_ADDRESS, isNew: true, extendedAttributes: {} },
        [],
      ),
    screen: updateAddressAction,
    item: 'updateaddress',
    service: 'people',
    contract: PEOPLE,
    method: 'POST',
    path: () => '/v1/users/addresses:update',
    saved: ADDRESS_SAVED,
  },
  {
    name: 'Edit Address Update',
    render: () =>
      editAddressForm(
        { userid: USER_ID, siteid: 'default', routeid: '', addressID: ADDRESS_ID },
        { user: PERSON, address: STORED_ADDRESS, isNew: false, extendedAttributes: {} },
        [STORED_ADDRESS],
      ),
    screen: updateAddressAction,
    item: 'updateaddress',
    service: 'people',
    contract: PEOPLE,
    method: 'POST',
    path: () => '/v1/users/addresses:update',
    saved: ADDRESS_SAVED,
  },
];

/** The owner write `c` relays for `rc`, with the call web made and the request the owner received. */
async function relay(
  c: FormCase,
  rc: Readonly<Record<string, string>>,
  body?: RequestBody,
): Promise<{ path: string; call: FakeCall; request: RecordedRequest }> {
  const path = c.path(rc.userid ?? '');
  const requests: RecordedRequest[] = [];
  const gateway = fakeGatewayClient({
    [routeKey(c.method, c.service, path)]: (request) => {
      requests.push(request);
      return c.saved;
    },
    [ROUTE_USER]: routed,
  });
  await expect(c.screen.submit(contextFor(adminRequest(c.item, rc), gateway, body))).resolves.toHaveProperty('kind');
  const calls = gateway.calls.filter((call) => call.path === path);
  expect(calls).toHaveLength(1);
  expect(requests).toHaveLength(1);
  return { path, call: calls[0] as FakeCall, request: requests[0] as RecordedRequest };
}

describe('native cUsers forms against their owners request contracts', () => {
  it.each(CASES)('relays the $name multipart post unchanged, userid in the declared query only', async (c) => {
    const { url, entries } = nativeSubmission(await c.render());
    const upload = await post(url, entries);
    const rc = postedRc(url, upload.body.form);
    const { path, call, request } = await relay(c, rc, upload.body);

    expect(request.bytes.equals(upload.bytes)).toBe(true);
    expect(request.headers['content-type']).toBe(upload.contentType);
    expect(call.query).toEqual(actionUrlFields(url));
    expect(call.query?.userid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/i);
    const fields = await relayedScope(request.bytes, upload.contentType);
    expect(Object.keys(fields).filter((name) => name.toLowerCase() === 'userid')).toEqual([]);
    expect(fields.action).toBe(entries.find(([name]) => name === 'action')?.[1]);
    assertRequestMatchesOpenApi(c.contract, {
      method: c.method,
      path,
      query: call.query,
      headers: { ...request.headers },
      contentType: upload.contentType,
      body: fields,
    });
  });

  it.each(CASES)('posts the $name fields URL-encoded with userid in the body', async (c) => {
    const { url, entries } = nativeSubmission(await c.render());
    const rc = postedRc(url, entries);
    const { path, call, request } = await relay(c, rc);

    expect(call.query).toBeUndefined();
    expect(request.headers['content-type']).toBe(FORM_CONTENT_TYPE);
    expect(call.form?.userid).toBe(url.searchParams.get('userid'));
    assertRequestMatchesOpenApi(c.contract, {
      method: c.method,
      path,
      headers: { ...request.headers },
      contentType: FORM_CONTENT_TYPE,
      body: call.form,
    });
  });

  it('relays only the Edit Group action URL field when rc holds another URL field', async () => {
    const c = CASES[0] as FormCase;
    const { url, entries } = nativeSubmission(await c.render());
    const upload = await post(url, entries);
    const rc = { ...postedRc(url, upload.body.form), routeid: GROUP_IDS.defaultEditor };
    const { path, call, request } = await relay(c, rc, upload.body);

    expect(call.query).toEqual({ userid: url.searchParams.get('userid') });
    assertRequestMatchesOpenApi(IDENTITY, {
      method: 'POST',
      path,
      query: call.query,
      headers: { ...request.headers },
      contentType: upload.contentType,
      body: await relayedScope(request.bytes, upload.contentType),
    });
  });
});
