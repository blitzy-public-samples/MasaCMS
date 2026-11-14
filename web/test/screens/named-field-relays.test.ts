// Named-field relays over the real request set-up: each owner receives the field as posted, so its one start-up scan
// leaves it as the ACF 2023 oracle's single scan does ("“ x ”" becomes '" x "', never '"x"').
import { legacyScopeParams, portcullisScan } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServicePath, WebServiceName } from '@/lib/gateway-client';
import { carchPageData } from '@/screens/carch/service';
import { loadChangesetAssignments } from '@/screens/cchangesets/assignments';
import { cfeedSiteParentsScreen } from '@/screens/cfeed/siteparents';
import { exportForm } from '@/screens/cform/export';
import { getDataset } from '@/screens/cform/getdataset';
import { getField } from '@/screens/cform/getfield';
import { getFieldTemplate } from '@/screens/cform/getfieldtemplate';
import { getFieldType } from '@/screens/cform/getfieldtype';
import { getForm } from '@/screens/cform/getform';
import { loadSearchSiteData } from '@/screens/cnav/searchsitedata';
import { cpermUpdateModule } from '@/screens/cperm/updatemodule';
import { loadCustomImagesScreen } from '@/screens/csettings/loadcustomimages';
import { addToGroupAction } from '@/screens/cusers/addtogroup';
import { advancedSearchToCsvAction } from '@/screens/cusers/advancedsearchtocsv';
import { routeAction } from '@/screens/cusers/route';
import { loadSearch } from '@/screens/cusers/search';
import { submitDelete } from '@/screens/cwebservice/delete';
import { submitSave } from '@/screens/cwebservice/save';
import type { ScreenContext } from '@/screens/registry';
import { smithSearchResults } from '../fixtures/people/search';
import { buildTestAdminRequest } from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type FakeRouteTable } from '../helpers/fake-gateway';
import { makeScreenContext } from '../helpers/screen-context';

const POSTED = '\u201C x \u201D';
/** The oracle's single scan of {@link POSTED}. */
const ONE_SCAN = '" x "';
const SITE = 'default';
const CONTENT_MODULE = '00000000000000000000000000000000000';
const JSON_REPLY: FakeReply = { status: 200, headers: { 'content-type': 'application/json' }, body: {} };
const HTML_REPLY: FakeReply = { status: 200, headers: { 'content-type': 'text/html' }, body: '<span></span>' };
const WRITTEN: FakeReply = { status: 200, body: { written: true } };
const CLIENT_SAVED: FakeReply = { status: 200, body: { written: true, client: {}, errors: {} } };
const LISTUSERS: FakeReply = { status: 200, body: { redirect: { action: 'cUsers.listusers', params: {} } } };

interface RelayRow {
  readonly site: string;
  readonly circuit: string;
  readonly action: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly form?: Readonly<Record<string, string>>;
  /** The field carrying {@link POSTED}. */
  readonly field: string;
  /** The owner call that relays it. */
  readonly call: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    readonly service: WebServiceName;
    readonly path: ServicePath;
  };
  /** The part of that call the field travels in. */
  readonly sent: 'query' | 'form';
  readonly routes: FakeRouteTable;
  readonly run: (ctx: ScreenContext) => Promise<unknown>;
}

const ROWS: readonly RelayRow[] = [
  {
    site: 'cwebservice.save',
    circuit: 'cwebservice',
    action: 'save',
    form: { clientid: 'C1', siteid: SITE, name: POSTED },
    field: 'name',
    call: { method: 'PUT', service: 'identity', path: '/v1/oauth-clients/C1' },
    sent: 'form',
    routes: { [routeKey('PUT', 'identity', '/v1/oauth-clients/C1')]: CLIENT_SAVED },
    run: submitSave,
  },
  {
    site: 'cwebservice.delete',
    circuit: 'cwebservice',
    action: 'delete',
    form: { clientid: 'C1', siteid: SITE, csrf_token: POSTED },
    field: 'csrf_token',
    call: { method: 'DELETE', service: 'identity', path: '/v1/oauth-clients/C1' },
    sent: 'form',
    routes: { [routeKey('DELETE', 'identity', '/v1/oauth-clients/C1')]: WRITTEN },
    run: submitDelete,
  },
  {
    site: 'cperm.updatemodule',
    circuit: 'cperm',
    action: 'updatemodule',
    form: { contentid: CONTENT_MODULE, siteid: SITE, router: POSTED },
    field: 'router',
    call: { method: 'PUT', service: 'identity', path: `/v1/permissions/modules/${CONTENT_MODULE}` },
    sent: 'form',
    routes: { [routeKey('PUT', 'identity', `/v1/permissions/modules/${CONTENT_MODULE}`)]: WRITTEN },
    run: (ctx) => cpermUpdateModule.submit(ctx),
  },
  {
    site: 'csettings.loadcustomimages',
    circuit: 'csettings',
    action: 'loadcustomimages',
    form: { siteid: SITE, sizeid: 'S1', imageAction: 'save', name: POSTED, height: '10', width: '20' },
    field: 'name',
    call: { method: 'PUT', service: 'programs-sites', path: `/v1/sites/${SITE}/image-sizes/S1` },
    sent: 'form',
    routes: {
      [routeKey('PUT', 'programs-sites', `/v1/sites/${SITE}/image-sizes/S1`)]: { status: 200, body: [] },
      [routeKey('GET', 'programs-sites', `/v1/sites/${SITE}/image-sizes`)]: { status: 200, body: [] },
    },
    run: (ctx) => loadCustomImagesScreen.load(ctx),
  },
  ...(
    [
      ['getfield', 'fieldType', getField],
      ['getdataset', 'datasetID', getDataset],
      ['getform', 'formID', getForm],
    ] as const
  ).map(
    ([action, field, run]): RelayRow => ({
      site: `cform.${action}`,
      circuit: 'cform',
      action,
      form: { siteid: SITE, [field]: POSTED },
      field,
      call: { method: 'POST', service: 'strategies-content', path: `/v1/raw/cform/${action}` },
      sent: 'form',
      routes: { [routeKey('POST', 'strategies-content', `/v1/raw/cform/${action}`)]: JSON_REPLY },
      run,
    }),
  ),
  {
    site: 'cform.getfieldtemplate',
    circuit: 'cform',
    action: 'getfieldtemplate',
    form: { fieldtype: 'field-nested', formid: POSTED },
    field: 'formid',
    call: { method: 'POST', service: 'strategies-content', path: '/v1/raw/cform/getfieldtemplate' },
    sent: 'form',
    routes: {
      [routeKey('POST', 'strategies-content', '/v1/raw/cform/getfieldtemplate')]: {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<span></span>',
      },
    },
    run: getFieldTemplate,
  },
  {
    site: 'cnav.searchsitedata',
    circuit: 'cnav',
    action: 'searchsitedata',
    query: { siteid: SITE, searchString: POSTED },
    field: 'searchString',
    call: { method: 'GET', service: 'strategies-content', path: '/v1/raw/cnav/searchsitedata' },
    sent: 'query',
    routes: { [routeKey('GET', 'strategies-content', '/v1/raw/cnav/searchsitedata')]: JSON_REPLY },
    run: loadSearchSiteData,
  },
  {
    site: 'cusers.route',
    circuit: 'cusers',
    action: 'route',
    query: { siteid: SITE, returnurl: POSTED },
    field: 'returnurl',
    call: { method: 'GET', service: 'people', path: '/v1/users/route' },
    sent: 'query',
    routes: { [routeKey('GET', 'people', '/v1/users/route')]: { status: 200, body: { redirect: { url: ONE_SCAN } } } },
    run: (ctx) => routeAction.submit(ctx),
  },
  {
    site: 'cusers.addtogroup',
    circuit: 'cusers',
    action: 'addtogroup',
    form: { userid: 'U1', groupid: 'G1', siteid: SITE, csrf_token: POSTED },
    field: 'csrf_token',
    call: { method: 'POST', service: 'identity', path: '/v1/groups/G1/members/U1' },
    sent: 'form',
    routes: {
      [routeKey('POST', 'identity', '/v1/groups/G1/members/U1')]: WRITTEN,
      [routeKey('GET', 'people', '/v1/users/route')]: LISTUSERS,
    },
    run: (ctx) => addToGroupAction.submit(ctx),
  },
  {
    site: 'cusers.advancedsearchtocsv',
    circuit: 'cusers',
    action: 'advancedsearchtocsv',
    query: {
      siteid: SITE,
      param: '1',
      paramField1: 'tusers.fname^varchar',
      paramRelationship1: 'Equals',
      paramCriteria1: POSTED,
      paramCondition1: 'And',
    },
    field: 'paramCriteria1',
    call: { method: 'POST', service: 'people', path: '/v2/users/advanced-search' },
    sent: 'form',
    routes: { [routeKey('POST', 'people', '/v2/users/advanced-search')]: { status: 200, body: {} } },
    run: (ctx) => advancedSearchToCsvAction.submit(ctx),
  },
  {
    site: 'cusers.search',
    circuit: 'cusers',
    action: 'search',
    query: { siteid: SITE, search: POSTED },
    field: 'search',
    call: { method: 'GET', service: 'people', path: '/v2/users/search' },
    sent: 'query',
    routes: { [routeKey('GET', 'people', '/v2/users/search')]: { status: 200, body: smithSearchResults } },
    run: loadSearch,
  },
  {
    site: 'cchangesets.assignments',
    circuit: 'cchangesets',
    action: 'assignments',
    query: { siteid: SITE, changesetid: 'CS1', keywords: POSTED },
    field: 'keywords',
    call: { method: 'GET', service: 'strategies-content', path: `/v1/sites/${SITE}/changesets/CS1/assignments` },
    sent: 'query',
    routes: {
      [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/changesets/CS1/assignments`)]: {
        status: 200,
        body: {
          rc: {
            changeset: { changesetID: 'CS1', name: 'Spring', published: 0, closeDate: '' },
            hasPendingApprovals: false,
            previewLink: '',
            siteAssignments: [],
            componentAssignments: [],
            formAssignments: [],
          },
        },
      },
    },
    run: loadChangesetAssignments,
  },
  {
    site: 'cfeed.siteparents',
    circuit: 'cfeed',
    action: 'siteparents',
    query: { siteid: SITE, keywords: POSTED },
    field: 'keywords',
    call: { method: 'GET', service: 'strategies-content', path: '/v1/raw/cfeed/siteparents' },
    sent: 'query',
    routes: { [routeKey('GET', 'strategies-content', '/v1/raw/cfeed/siteparents')]: HTML_REPLY },
    run: async (ctx) => cfeedSiteParentsScreen.render(ctx, undefined),
  },
  ...(
    [
      ['getfieldtype', 'fieldType', getFieldType],
      ['export', 'contentid', exportForm],
    ] as const
  ).map(
    ([action, field, run]): RelayRow => ({
      site: `cform.${action}`,
      circuit: 'cform',
      action,
      query: { siteid: SITE, [field]: POSTED },
      field,
      call: { method: 'GET', service: 'strategies-content', path: `/v1/raw/cform/${action}` },
      sent: 'query',
      routes: { [routeKey('GET', 'strategies-content', `/v1/raw/cform/${action}`)]: JSON_REPLY },
      run,
    }),
  ),
  {
    site: 'carch.search',
    circuit: 'carch',
    action: 'search',
    query: { siteid: SITE, keywords: POSTED },
    field: 'keywords',
    call: { method: 'GET', service: 'strategies-content', path: `/v1/sites/${SITE}/content` },
    sent: 'query',
    routes: { [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content`)]: { status: 200, body: { rc: {} } } },
    run: (ctx) => carchPageData(ctx, 'search'),
  },
];

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('named-field relays', () => {
  it.each(ROWS)('relays $site $field as posted, for the owner to scan once', async (row) => {
    const req = await buildTestAdminRequest({
      circuit: row.circuit,
      action: row.action,
      query: row.query,
      form: row.form,
      user: 'admin',
    });
    const ctx = makeScreenContext({ req, gateway: fakeGatewayClient(row.routes) });

    await row.run(ctx);
    const { method, service, path } = row.call;
    const relayed = ctx.gateway.calls.find(
      (call) => call.service === service && call.method.toUpperCase() === method && call.path === path,
    );
    const fields = (row.sent === 'form' ? relayed?.form : relayed?.query) ?? {};
    expect(req.rc[row.field]).toBe(ONE_SCAN);
    expect(fields[row.field]).toBe(POSTED);
    expect(legacyScopeParams(portcullisScan(Object.entries(fields)))[row.field]).toBe(ONE_SCAN);
  });
});
