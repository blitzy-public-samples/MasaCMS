// cUsers.editAddress against editaddress.cfm (77-220), cusers.cfc editAddress() and the people address contracts.
import { readFileSync } from 'node:fs';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/people';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import {
  UNSERVED_ADDRESS_EXTEND_SETS,
  editAddressScreen,
  loadEditAddress,
  renderEditAddress,
  type AddressEditData,
  type AddressExtendSetLoader,
} from '@/screens/cusers/editaddress';
import { cusersGate } from '@/screens/cusers/gate';
import type { ExtendAttributeDefinition, ExtendSetDefinition } from '@/screens/cusers/loadextendedattributes';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel, normaliseIds } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type RecordedRequest } from '../../helpers/fake-gateway';

type AddressRecord = components['schemas']['AddressRecord'];
type PersonRecord = components['schemas']['PersonRecord'];
type UserEditData = components['schemas']['UserEditData'];

// The view body between `<div id="mura-content">` and its close, cut from the legacy ACF 2023 server's responses for
// the seeded person below, with the CSRF pair replaced by the one this suite issues.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/people/cusers-editaddress-${name}.html`, import.meta.url), 'utf8');

const USER_ID = 'EA000000-0000-0000-0000000000000001';
const ADDRESS_ID = 'EA000000-0000-0000-0000000000000002';
const CSRF = { token: 'TESTCSRFTOKEN0000000000000000000', expires: '260630150000000' };

const ADDRESS_EDIT_ROUTE = routeKey('GET', 'people', '/v1/users/address');
const USER_EDIT_ROUTE = routeKey('GET', 'people', '/v1/users/edit');
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');

const USER_JS = '<script type="text/javascript" src="assets/js/user.js"></script>';
const TAB_VIEW_HEAD =
  '<link rel="stylesheet" href="css/tab-view.css" type="text/css" media="screen">' +
  '<script type="text/javascript" src="assets/js/tab-view.js"></script>';

const PERSON: PersonRecord = {
  UserID: USER_ID,
  Type: 2,
  SiteID: 'default',
  Fname: 'Jo<e> & "Ann"',
  Lname: "O'Brien",
  subType: 'Default',
  isPublic: 1,
};

const STORED_ADDRESS: AddressRecord = {
  addressID: ADDRESS_ID,
  userID: USER_ID,
  siteID: 'default',
  addressName: 'Head "Office" <A&B>',
  address1: '1 Main St, Apt #2',
  address2: null,
  city: 'Zürich',
  state: 'ZH',
  zip: '8001',
  country: 'CH',
  phone: '+41 (0)44 555-01',
  fax: '',
  isPrimary: 1,
  addressURL: 'https://example.test/?a=1&b=2',
  addressEmail: "o'neil@example.test",
  hours: 'Mon-Fri 9-5\nSat <10-2>',
};

/** people's new address for an empty `addressid`. */
const NEW_ADDRESS: AddressRecord = { addressID: 'EA000000-0000-0000-0000000000000003', userID: USER_ID };

/** A `tclassextendattributes` row with the columns a test does not set left empty. */
const attribute = (attr: Partial<ExtendAttributeDefinition> & Pick<ExtendAttributeDefinition, 'attributeID' | 'name' | 'type'>) => ({
  label: '',
  hint: '',
  adminOnly: 0,
  required: 'false',
  validation: '',
  regex: '',
  message: '',
  defaultValue: '',
  optionList: '',
  optionLabelList: '',
  ...attr,
});

/** The two Address sets seeded on the legacy server, as `getExtendSets(inherit=true, activeOnly=true)` loads them. */
const ADDRESS_SETS: readonly ExtendSetDefinition[] = [
  {
    extendSetID: 'EA000000-0000-0000-00000000000000B1',
    categoryID: '',
    name: 'Extra <b>Info</b>',
    attributes: [
      attribute({ attributeID: 9001, name: 'extTitle', label: 'Title <i>T</i>', hint: `Hint "q" <b> & 'x'`, type: 'TextBox', defaultValue: 'dflt' }),
      attribute({ attributeID: 9002, name: 'extSecret', label: 'Secret', hint: 'Hidden hint', type: 'Hidden' }),
      attribute({ attributeID: 9003, name: 'extHidden2', type: 'Hidden' }),
      attribute({ attributeID: 9004, name: 'extDoc', label: 'Document', type: 'File' }),
      attribute({ attributeID: 9005, name: 'extDoc2', label: 'Doc2', hint: 'File hint', type: 'File', required: 'true', message: 'Need a file' }),
    ],
  },
  {
    extendSetID: 'EA000000-0000-0000-00000000000000B2',
    categoryID: '',
    name: 'Second',
    attributes: [
      attribute({ attributeID: 9006, name: 'extColor', label: 'Color', type: 'SelectBox', optionList: 'red^green^blue', optionLabelList: 'Red^Green^Blue' }),
      attribute({ attributeID: 9007, name: 'extNotes', label: 'Notes', type: 'TextArea' }),
      attribute({ attributeID: 9008, name: 'extYes', label: 'Agree', type: 'RadioGroup', optionList: '1^0', optionLabelList: 'Yes^No' }),
    ],
  },
];

/** The seeded address's stored extended values by attribute name. */
const STORED_VALUES: Readonly<Record<string, string>> = {
  extSecret: 's3cr<e>t',
  extDoc: 'EA000000-0000-0000-0000000000000099',
  extColor: 'green',
  extNotes: 'line1\nline2 <x>',
  extYes: '0',
};

const withSets: AddressExtendSetLoader = () => Promise.resolve(ADDRESS_SETS);

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** The admin's `cusers.editaddress` request with `rc`. */
const editRequest = (rc: Readonly<Record<string, string>>): AdminRequest =>
  adminS2Request({ circuit: 'cusers', item: 'editaddress', rc });

/** identity's pair for every requested context. */
function issueTokens(request: RecordedRequest) {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({ context, [CSRF_FIELD_TOKEN]: CSRF.token, [CSRF_FIELD_EXPIRES]: CSRF.expires }));
  return { status: 200, body: { tokens } };
}

/** A gateway answering people's two reads and identity's tokens. */
function gatewayFor(edit: AddressEditData, addresses: readonly AddressRecord[]): FakeGatewayClient {
  const userEdit: Partial<UserEditData> = { user: edit.user, isNew: false, addresses: [...addresses] };
  return fakeGatewayClient({
    [ADDRESS_EDIT_ROUTE]: { status: 200, body: edit },
    [USER_EDIT_ROUTE]: { status: 200, body: userEdit },
    [CSRF_ROUTE]: issueTokens,
  });
}

// Built by hand: the registry's shell hooks import every circuit, and the view reads only req, gateway, csrf and rb.
/** The handlers' ScreenContext for `req` over `gateway`. */
function contextFor(req: AdminRequest, gateway: FakeGatewayClient, rb: RbLookup = rbFor('en_US')): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb,
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

interface Case {
  readonly name: string;
  readonly rc: Readonly<Record<string, string>>;
  readonly address: AddressRecord;
  readonly addresses: readonly AddressRecord[];
  readonly values: Readonly<Record<string, string>>;
  readonly loader?: AddressExtendSetLoader;
  readonly htmlHead: string;
}

const CASES: readonly Case[] = [
  {
    name: 'new-first',
    rc: { userid: USER_ID, siteid: 'default', routeid: 'x y&z', addressID: '' },
    address: NEW_ADDRESS,
    addresses: [],
    values: {},
    htmlHead: USER_JS,
  },
  {
    name: 'new-second',
    rc: { userid: USER_ID, siteid: 'default', routeid: 'editprofile', addressID: '' },
    address: NEW_ADDRESS,
    addresses: [STORED_ADDRESS],
    values: {},
    htmlHead: USER_JS,
  },
  {
    name: 'existing',
    rc: { userid: USER_ID, siteid: 'default', routeid: '', addressID: ADDRESS_ID },
    address: STORED_ADDRESS,
    addresses: [STORED_ADDRESS],
    values: {},
    htmlHead: USER_JS,
  },
  {
    name: 'extend',
    rc: { userid: USER_ID, siteid: 'default', routeid: '', addressID: ADDRESS_ID },
    address: STORED_ADDRESS,
    addresses: [STORED_ADDRESS],
    values: STORED_VALUES,
    loader: withSets,
    htmlHead: USER_JS + TAB_VIEW_HEAD,
  },
  {
    name: 'extend-new',
    rc: { userid: USER_ID, siteid: 'default', routeid: '', addressID: '' },
    address: NEW_ADDRESS,
    addresses: [STORED_ADDRESS],
    values: {},
    loader: withSets,
    htmlHead: USER_JS + TAB_VIEW_HEAD,
  },
];

/** The view of `c` as the page production renders it. */
async function render(c: Case, rb?: RbLookup) {
  const edit: AddressEditData = { user: PERSON, address: c.address, isNew: c.address === NEW_ADDRESS, extendedAttributes: c.values };
  const gateway = gatewayFor(edit, c.addresses);
  const ctx = contextFor(editRequest(c.rc), gateway, rb);
  const data = await loadEditAddress(ctx, c.loader);
  const view = renderEditAddress(ctx, data);
  return { gateway, body: toString(view.body), htmlHead: view.htmlHead === undefined ? '' : toString(view.htmlHead) };
}

const caseNamed = (name: string): Case => {
  const found = CASES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`No case ${name}`);
  return found;
};

describe('cusers.editaddress', () => {
  it('is the people-owned page behind the cUsers gate', () => {
    expect(editAddressScreen).toMatchObject({ circuit: 'cusers', action: 'editaddress', mode: 'page', owner: 'people' });
    expect(editAddressScreen.gate).toBe(cusersGate);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('reproduces the legacy %s capture byte for byte', async (name, c) => {
    const { body, htmlHead } = await render(c);
    expect(body).toBe(legacy(name));
    expect(normaliseIds(fragmentModel(body))).toEqual(normaliseIds(fragmentModel(legacy(name))));
    expect(htmlHead).toBe(c.htmlHead);
  });

  it("reads people's address and the person's addresses for the request, and issues the form's CSRF context", async () => {
    const { gateway, body } = await render(caseNamed('existing'));
    const people = gateway.calls.filter((call) => call.service === 'people');
    expect(people).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/v1/users/address',
        query: { siteid: 'default', userid: USER_ID, addressid: ADDRESS_ID, routeid: '' },
      }),
      expect.objectContaining({ method: 'GET', path: '/v1/users/edit', query: { siteid: 'default', userid: USER_ID } }),
    ]);
    const issued = gateway.calls.find((call) => call.service === 'identity');
    expect(issued?.json).toEqual({ contexts: [`updateaddress${USER_ID}`] });
    expect(body).toContain(`<input type="hidden" name="csrf_token" value="${CSRF.token}" />`);
  });

  it('prints labels unencoded, keeps a NULL isPublic at the bean default and links a hinted File attribute', async () => {
    const stubRb: RbLookup = { locale: 'en', rbKey: (key) => `<b>[${key}]</b>`, messageFormat: () => '' };
    const doc = attribute({ attributeID: 9009, name: 'extDoc3', label: 'Doc3', hint: 'H', type: 'File' });
    const sets: AddressExtendSetLoader = () =>
      Promise.resolve([{ extendSetID: 'S', categoryID: 'C', name: 'N', attributes: [doc] }]);
    const edit: AddressEditData = {
      user: { ...PERSON, isPublic: null },
      address: STORED_ADDRESS,
      isNew: false,
      extendedAttributes: { EXTDOC3: 'F1' },
    };
    const gateway = gatewayFor(edit, [STORED_ADDRESS]);
    const ctx = contextFor(editRequest({ userid: USER_ID, siteid: 'default', addressID: ADDRESS_ID }), gateway, stubRb);
    const body = toString(renderEditAddress(ctx, await loadEditAddress(ctx, sets)).body);
    expect(body).toContain('<h1><b>[user.memberaddressform]</b></h1>');
    expect(body).toContain('title="&lt;b&gt;&#x5b;sitemanager.back&#x5d;&lt;&#x2f;b&gt;"');
    expect(body).toContain('<label><b>[user.website]</b> (<b>[user.includehttp]</b>)</label>');
    expect(body).toContain(`submitForm(document.forms.form1,'delete','<b>[user.deleteaddressconfirm]</b>');`);
    expect(body).toContain('initTabs(Array("<b>[user.basic]</b>","<b>[user.extendedattributes]</b>"),0,0,0);');
    expect(body).toContain('<input type="hidden" name="isPublic" value="1">');
    expect(body).toContain(
      '<span class="extendset" extendsetid="S" categoryid="C" >\n\t\t\t\t\t\t\t\t<input name="extendSetID" type="hidden" value="S"/>',
    );
    expect(body).toContain(
      'Doc3  <i class="mi-question-circle"></i></span>\n\t\t\t\t\t\t\t\t\t <a href="/index.cfm/_api/render/file/?fileID=F1" ' +
        'target="_blank">[Download]</a> <input type="checkbox" value="true" name="extDelete9009"/> Delete\n\t\t\t\t\t\t\t\t\t</label>',
    );
  });

  it('fails closed by default only when the address holds extended values', async () => {
    const edit = (values: Readonly<Record<string, string>>): AddressEditData => ({
      user: PERSON,
      address: STORED_ADDRESS,
      isNew: false,
      extendedAttributes: values,
    });
    const ctx = contextFor(editRequest({}), fakeGatewayClient());
    await expect(UNSERVED_ADDRESS_EXTEND_SETS(ctx, edit({}))).resolves.toEqual([]);
    await expect(UNSERVED_ADDRESS_EXTEND_SETS(ctx, edit({ extDoc: 'F' }))).rejects.toBeInstanceOf(
      LegacyServiceUnavailableError,
    );

    const gateway = gatewayFor(edit(STORED_VALUES), [STORED_ADDRESS]);
    const req = editRequest({ userid: USER_ID, siteid: 'default', addressID: ADDRESS_ID });
    await expect(editAddressScreen.load?.(contextFor(req, gateway))).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
  });

  it('fails as ACF does when the request carries no addressID, before calling people', async () => {
    const gateway = gatewayFor({ user: PERSON, address: NEW_ADDRESS, isNew: true, extendedAttributes: {} }, []);
    const ctx = contextFor(editRequest({ userid: USER_ID, siteid: 'default' }), gateway);
    await expect(loadEditAddress(ctx)).rejects.toThrow('Element ADDRESSID is undefined in RC.');
    expect(gateway.calls).toEqual([]);
  });

  it("raises people's denial for the access gate's redirect", async () => {
    const gateway = gatewayFor({ user: PERSON, address: NEW_ADDRESS, isNew: true, extendedAttributes: {} }, []);
    gateway.setRoute(ADDRESS_EDIT_ROUTE, { status: 403, body: { error: { type: 'forbidden' } } });
    const ctx = contextFor(editRequest({ userid: USER_ID, siteid: 'default', addressID: '' }), gateway);
    await expect(loadEditAddress(ctx)).rejects.toBeInstanceOf(GatewayDenialError);
  });
});
