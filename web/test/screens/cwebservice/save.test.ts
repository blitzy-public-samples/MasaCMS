import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/identity';
import { GatewayUnavailableError, isUnavailable } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { saveDefinition } from '@/screens/cwebservice';
import { submitSave } from '@/screens/cwebservice/save';
import type { PageControllerRedirect, PageScreen, ScreenContext, SubmitResult } from '@/screens/registry';
import { CSRF_CWEBSERVICE } from '../../fixtures/identity/csrf';
import { OAUTH_CLIENT_IDS, existingClientEdit, newClientEdit, saveErrors } from '../../fixtures/identity/oauth-clients';
import { PERSON_IDS, tenantASystemUsersPage } from '../../fixtures/people/user-list';
import { adminS2Request } from '../../helpers/admin-request';
import { domModel, fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const CLIENT_ID = OAUTH_CLIENT_IDS.clientCredentials;
const CLIENT_PATH = `/v1/oauth-clients/${CLIENT_ID}` as const;
const SAVE_ROUTE = routeKey('PUT', 'identity', CLIENT_PATH);
const CLIENT_ROUTE = routeKey('GET', 'identity', CLIENT_PATH);
const USERS_ROUTE = routeKey('GET', 'people', '/v1/users/feed');
const CSRF_PATH = '/v1/csrf/tokens';

const FORM = Object.freeze({
  clientid: CLIENT_ID,
  siteid: 'default',
  name: 'Posted REST Client',
  description: 'Posted description',
  granttype: 'client_credentials',
  redirecturl: 'https://example.com/posted',
  userid: PERSON_IDS.janeSmith,
  clientsecret: 'fixture-secret-not-real-0009',
  [CSRF_FIELD_TOKEN]: CSRF_CWEBSERVICE.csrf_token,
  [CSRF_FIELD_EXPIRES]: CSRF_CWEBSERVICE.csrf_token_expires,
});

const LIST_REDIRECT: SubmitResult = { kind: 'redirect', action: 'cwebservice.list', append: 'siteid', path: './' };

type OAuthClient = components['schemas']['OAuthClient'];

/** A 64-hex secret as `hash(encrypt(clientid, generateSecretKey('AES')))` yields one, assembled at run time. */
const GENERATED_SECRET = Array.from({ length: 64 }, (_, i) => (i % 16).toString(16).toUpperCase()).join('');

/** identity's bean after `loadBy(clientid=rc.clientid).set(rc)` of FORM over the stored client. */
const POSTED_CLIENT: OAuthClient = Object.freeze({
  ...existingClientEdit.client,
  siteid: FORM.siteid,
  name: FORM.name,
  description: FORM.description,
  granttype: FORM.granttype,
  userid: FORM.userid,
  redirecturl: FORM.redirecturl,
  clientsecret: FORM.clientsecret,
});

/** identity `saveOAuthClient` answering `errors` and the bean `client`, saved only when `written`. */
function saveAnswer(
  errors: Readonly<Record<string, string>>,
  written = Object.keys(errors).length === 0,
  client: OAuthClient = POSTED_CLIENT,
): FakeReply {
  return { status: 200, body: { written, client, errors } };
}

/** Routes of a save whose `errors` re-render the form, the stored-client read answering `clientRead`. */
function rerenderRoutes(clientRead: FakeReply): FakeRouteTable {
  return {
    [SAVE_ROUTE]: saveAnswer(saveErrors),
    [CLIENT_ROUTE]: clientRead,
    [USERS_ROUTE]: { status: 200, body: { items: tenantASystemUsersPage.items } },
  };
}

function saveRequest(rc: Readonly<Record<string, string>> = FORM, siteid = 'default'): AdminRequest {
  return adminS2Request({ circuit: 'cwebservice', item: 'save', rc, session: { siteid } });
}

function contextFor(req: AdminRequest, routes: FakeRouteTable): ScreenContext & { gateway: FakeGatewayClient } {
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes) });
}

function saveScreen(): PageScreen<unknown> {
  return saveDefinition;
}

/** The save definition's controller step, as the page handler runs it. */
async function runSave(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  return saveScreen().redirect?.(ctx);
}

/** The DOM model of `selector`'s first match in `html`. */
function modelOf(html: string, selector: string): DomModel {
  const $ = cheerio.load(html);
  return fragmentModel($.html($(selector).first()));
}

describe('cwebservice.save', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('relays the posted fields and CSRF pair to identity unchanged, then redirects to the list', async () => {
    let body = '';
    const ctx = contextFor(saveRequest(), {
      [SAVE_ROUTE]: (request) => {
        body = request.body;
        return saveAnswer({});
      },
    });

    await expect(runSave(ctx)).resolves.toEqual(LIST_REDIRECT);
    expect(ctx.gateway.calls).toEqual([
      {
        service: 'identity',
        method: 'PUT',
        path: CLIENT_PATH,
        form: {
          siteid: FORM.siteid,
          name: FORM.name,
          description: FORM.description,
          granttype: FORM.granttype,
          userid: FORM.userid,
          redirectURL: FORM.redirecturl,
          clientsecret: FORM.clientsecret,
          [CSRF_FIELD_TOKEN]: CSRF_CWEBSERVICE.csrf_token,
          [CSRF_FIELD_EXPIRES]: CSRF_CWEBSERVICE.csrf_token_expires,
        },
      },
    ]);
    expect(body.split('&').slice(-2)).toEqual([
      `${CSRF_FIELD_TOKEN}=${CSRF_CWEBSERVICE.csrf_token}`,
      `${CSRF_FIELD_EXPIRES}=${CSRF_CWEBSERVICE.csrf_token_expires}`,
    ]);
  });

  it('redirects to the list when identity skips the save on a rejected CSRF token without errors', async () => {
    const ctx = contextFor(saveRequest(), { [SAVE_ROUTE]: saveAnswer({}, false) });

    await expect(runSave(ctx)).resolves.toEqual(LIST_REDIRECT);
    expect(ctx.gateway.calls.map(({ service, method, path }) => `${service} ${method} ${path}`)).toEqual([
      `identity PUT ${CLIENT_PATH}`,
    ]);
  });

  it("redirects to the list on the session's site without saving when rc has no siteid", async () => {
    const base = saveRequest(FORM, 'tenant-a');
    const rc = Object.fromEntries(Object.entries(base.rc).filter(([name]) => name.toLowerCase() !== 'siteid'));
    const ctx = contextFor({ ...base, rc }, { [SAVE_ROUTE]: saveAnswer({}) });

    await expect(runSave(ctx)).resolves.toEqual({ ...LIST_REDIRECT, rc: { siteid: 'tenant-a' } });
    expect(ctx.gateway.calls).toEqual([]);
  });

  it.each([
    {
      client: 'a stored client',
      clientRead: { status: 200, body: existingClientEdit },
      heading: 'Edit Web Service',
      buttons: ['Delete', 'Update'],
    },
    { client: 'no stored client', clientRead: { status: 404 }, heading: 'Add Web Service', buttons: ['Add'] },
  ])('re-renders the form for $client with the errors, the posted values and fresh CSRF fields', async (row) => {
    const ctx = contextFor(saveRequest(), rerenderRoutes(row.clientRead));

    const page = await renderScreenPage(saveScreen(), ctx);

    if (page.kind !== 'document') throw new Error(`cwebservice.save redirected to ${page.location}`);
    const header = modelOf(page.html, '.mura-header');
    const form = modelOf(page.html, 'form[name="form1"]');
    const control = (name: string) => form.controls.find((candidate) => candidate.name === name);
    expect(header.headings).toEqual([row.heading]);
    expect(domModel(page.html).alerts).toContainEqual({ text: saveErrors.name, className: 'alert alert-error' });
    expect(form.buttons.map(({ text }) => text)).toEqual(row.buttons);
    expect(control('name')).toMatchObject({ tag: 'input', value: FORM.name });
    expect(control('description')).toMatchObject({ tag: 'textarea', value: FORM.description });
    expect(control('granttype')?.selected).toEqual([FORM.granttype]);
    expect(control('userid')?.selected).toEqual([FORM.userid]);
    expect(control('redirectURL')).toMatchObject({ tag: 'textarea', value: FORM.redirecturl });
    expect(form.controls.filter(({ type }) => type === 'hidden').map(({ name, value }) => [name, value])).toEqual([
      ['siteid', FORM.siteid],
      ['clientid', CLIENT_ID],
      ['clientsecret', FORM.clientsecret],
      [CSRF_FIELD_TOKEN, FIXED_CSRF.token],
      [CSRF_FIELD_EXPIRES, FIXED_CSRF.expires],
    ]);
    expect(page.html).not.toContain(CSRF_CWEBSERVICE.csrf_token);
    const issued = ctx.gateway.calls.filter(({ path }) => path === CSRF_PATH);
    expect(issued.flatMap(({ json }) => (json as { contexts: string[] }).contexts)).toContain(CLIENT_ID);
    expect(ctx.gateway.calls.filter(({ method }) => method === 'PUT')).toHaveLength(1);
  });

  // `oauthClientBean.save()` sets an empty secret before its validation refuses the save; a rejected token skips save().
  it.each([
    { token: 'a valid CSRF token', secret: GENERATED_SECRET },
    { token: 'a rejected CSRF token', secret: '' },
  ])("re-renders an unnamed new client's hidden secret as identity answers it under $token", async ({ secret }) => {
    const posted = { ...FORM, name: '', clientsecret: '' };
    const client: OAuthClient = { ...POSTED_CLIENT, name: '', clientsecret: secret };
    const ctx = contextFor(saveRequest(posted), {
      [SAVE_ROUTE]: saveAnswer(saveErrors, false, client),
      [CLIENT_ROUTE]: { status: 404 },
      [USERS_ROUTE]: { status: 200, body: { items: tenantASystemUsersPage.items } },
    });

    const page = await renderScreenPage(saveScreen(), ctx);

    if (page.kind !== 'document') throw new Error(`cwebservice.save redirected to ${page.location}`);
    const form = modelOf(page.html, 'form[name="form1"]');
    const hidden = Object.fromEntries(
      form.controls.filter(({ type }) => type === 'hidden').map(({ name, value }) => [name, value]),
    );
    expect(modelOf(page.html, '.mura-header').headings).toEqual(['Add Web Service']);
    expect(hidden).toMatchObject({ siteid: FORM.siteid, clientid: CLIENT_ID, clientsecret: secret });
    expect(form.controls.find(({ name }) => name === 'name')?.value).toBe('');
    const put = ctx.gateway.calls.find(({ method }) => method === 'PUT');
    expect(put?.form).toMatchObject({ name: '', clientsecret: '' });
  });

  it('reads a plain rc in any case and relays its fields under identity names', async () => {
    const rc = {
      SiteID: FORM.siteid,
      ClientID: CLIENT_ID,
      NAME: FORM.name,
      RedirectURL: FORM.redirecturl,
      [CSRF_FIELD_TOKEN.toUpperCase()]: CSRF_CWEBSERVICE.csrf_token,
    };
    const ctx = contextFor({ ...saveRequest(), rc }, { [SAVE_ROUTE]: saveAnswer({}) });

    await expect(submitSave(ctx)).resolves.toEqual(LIST_REDIRECT);
    expect(ctx.gateway.calls).toEqual([
      {
        service: 'identity',
        method: 'PUT',
        path: CLIENT_PATH,
        form: {
          siteid: FORM.siteid,
          name: FORM.name,
          redirectURL: FORM.redirecturl,
          [CSRF_FIELD_TOKEN]: CSRF_CWEBSERVICE.csrf_token,
        },
      },
    ]);
  });

  it("re-renders a plain rc without client fields as identity's unsaved bean with the before() defaults", async () => {
    const rc = { siteid: FORM.siteid, name: FORM.name };
    const defaulted: OAuthClient = { ...newClientEdit.client, clientid: '', siteid: FORM.siteid, name: FORM.name };
    const ctx = contextFor(
      { ...saveRequest(), rc },
      {
        [routeKey('PUT', 'identity', '/v1/oauth-clients/')]: saveAnswer(saveErrors, false, defaulted),
        [USERS_ROUTE]: { status: 200, body: { items: tenantASystemUsersPage.items } },
      },
    );

    const outcome = await submitSave(ctx);

    expect(outcome.kind).toBe('render');
    if (outcome.kind !== 'render') return;
    const view = fragmentModel(toString(outcome.view.body));
    const control = (name: string) => view.controls.find((candidate) => candidate.name === name);
    expect(ctx.gateway.calls[0]).toEqual({
      service: 'identity',
      method: 'PUT',
      path: '/v1/oauth-clients/',
      form: { siteid: FORM.siteid, name: FORM.name },
    });
    expect(view.headings).toEqual(['Add Web Service']);
    expect(view.alerts).toContainEqual({ text: saveErrors.name, className: 'alert alert-error' });
    expect(control('name')?.value).toBe(FORM.name);
    expect(control('description')?.value).toBe('');
    expect(control('granttype')?.selected).toEqual(['basic']);
    expect(control('userid')?.selected).toEqual([]);
    expect(control('redirectURL')?.value).toBe('');
    expect(view.controls.filter(({ type }) => type === 'hidden').map(({ name, value }) => [name, value])).toEqual([
      ['siteid', FORM.siteid],
      ['clientid', ''],
      ['clientsecret', ''],
      [CSRF_FIELD_TOKEN, FIXED_CSRF.token],
      [CSRF_FIELD_EXPIRES, FIXED_CSRF.expires],
    ]);
  });

  it.each([
    { outage: 'the gateway refusing the save', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    ...[502, 503, 504].map((status) => ({
      outage: `identity answering ${status} to the save`,
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(SAVE_ROUTE, { status, body: {} }),
    })),
    {
      outage: 'the stored-client read on the re-render',
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(CLIENT_ROUTE, { status: 503, body: {} }),
    },
    {
      outage: 'the Connected Account list on the re-render',
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(USERS_ROUTE, { status: 503, body: {} }),
    },
  ])('fails closed on $outage', async ({ arrange }) => {
    const ctx = contextFor(saveRequest(), rerenderRoutes({ status: 200, body: existingClientEdit }));
    arrange(ctx.gateway);

    const error = await runSave(ctx).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(isUnavailable(error)).toBe(true);
  });
});
