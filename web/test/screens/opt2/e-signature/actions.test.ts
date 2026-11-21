// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
// The e-signature post actions: request creation, typed-name signing and supplied-copy verification, their calls and
// refusals.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/e-signature';
import { secure } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { esignatureActions } from '@/screens/opt2/e-signature';
import { CREATE_REQUEST_FIELDS } from '@/screens/opt2/e-signature/requests';
import type { Opt2ActionDefinition, ScreenContext, SubmitResult } from '@/screens/registry';
import { anonymousRequest, makeAdminRequest, opt2RoleRequest } from '../../../helpers/admin-request';
import { fragmentModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../../helpers/screen-context';
import { SUBJECTS } from '../../../helpers/tokens';
import { ESIGNATURE_IDS, auditChain, eSignatureAnswers, pendingRequest } from '../../../fixtures/opt2/e-signature';

// The registry module loads every circuit; these suites need only the shell hooks the re-rendered views use.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SIGNER = Roles.esignatureSigner;
const AUDITOR = Roles.esignatureAuditor;
const SIGNED_ID = ESIGNATURE_IDS.signedRequest;
const PENDING_ID = ESIGNATURE_IDS.pendingRequest;
const SITE = SUBJECTS[SIGNER].site;
const REQUESTS_PATH = '/v1/esignature/requests';
const POSTED_CSRF = Object.freeze({ token: 'POSTEDCSRFTOKEN00000000000000000', expires: '260630160000000' });

type Fields = Readonly<Record<string, string>>;
type AuditEntry = components['schemas']['AuditEntry'];

/** The registered e-signature action `slug`. */
function actionOf(slug: string): Opt2ActionDefinition {
  const def = esignatureActions.find((candidate) => candidate.action === slug);
  if (def === undefined) throw new TypeError(`e-signature action ${slug} is not registered`);
  return def;
}

/**
 * A post by the tenant-a holder of `role`, token user the fixture signer, carrying `fields` and the posted CSRF pair,
 * over the fixture answers.
 */
function postBy(
  role: Role,
  fields: Fields,
  routes: Readonly<Record<string, FakeReply>> = {},
): ScreenContext & { gateway: FakeGatewayClient } {
  const rc = { ...fields, [CSRF_FIELD_TOKEN]: POSTED_CSRF.token, [CSRF_FIELD_EXPIRES]: POSTED_CSRF.expires };
  return makeScreenContext({
    req: opt2RoleRequest(role, { mode: 'opt2', rc, user: { sub: ESIGNATURE_IDS.signer } }),
    gateway: fakeGatewayClient({ ...eSignatureAnswers, ...routes }),
  });
}

/** The body markup of a re-rendered or rendered outcome; throws for any other outcome. */
function renderedBody(result: SubmitResult): string {
  if (result.kind !== 'render') throw new TypeError(`Expected a render, got ${result.kind}`);
  expect(result.view.opt2Module).toBe('e-signature');
  return toString(result.view.body);
}

/** The writes and reads made to e-signature, without identity's. */
function eSignatureCalls(gateway: FakeGatewayClient) {
  return gateway.calls.filter((call) => call.service === 'e-signature');
}

/** A Masa JSON API error envelope answered with `status`. */
function refusal(status: number, message: string): FakeReply {
  return { status, body: { apiversion: 'v1', method: 'esignature.requests', error: { code: 'invalid_request', message } } };
}

const key = (method: 'GET' | 'POST', path: string): string => routeKey(method, 'e-signature', path as `/${string}`);

const RELAYED_CSRF = { 'x-csrf_token': POSTED_CSRF.token, 'x-csrf_token_expires': POSTED_CSRF.expires };

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('create-request action', () => {
  // Kept as typed, padding included: the fixture stores the posted values without trimming.
  const posted = Object.freeze({
    documentName: '  tenant-a NDA "v2" <final>.pdf ',
    documentBase64: 'JVBERi0xLjQK',
    signerUserId: ESIGNATURE_IDS.signer,
  });
  const createKey = key('POST', REQUESTS_PATH);

  it.each([200, 201])('creates the request from the posted fields as posted on %i and redirects to the list', async (status) => {
    const ctx = postBy(SIGNER, posted, { [createKey]: { status, body: pendingRequest } });
    const result = await actionOf('create-request').submit(ctx);
    expect(result).toEqual({ kind: 'location', location: `/opt2/admin/e-signature/requests?siteid=${SITE}` });
    expect(eSignatureCalls(ctx.gateway)).toEqual([
      { service: 'e-signature', method: 'POST', path: REQUESTS_PATH, json: posted, headers: RELAYED_CSRF },
    ]);
  });

  it('sends only the contract properties, never a creator id or the site, and leaves out one not posted', async () => {
    const ctx = postBy(SIGNER, { documentName: 'nda.pdf', userid: SUBJECTS[SIGNER].sub, createdbyid: 'x', siteid: SITE });
    await actionOf('create-request').submit(ctx);
    expect(eSignatureCalls(ctx.gateway)[0]?.json).toEqual({ documentName: 'nda.pdf' });
  });

  it.each<[number, string]>([
    [400, 'Invalid parameters'],
    [403, 'Insufficient Account Permissions'],
  ])('re-renders the request list on %i with the message and the posted values', async (status, message) => {
    const ctx = postBy(SIGNER, posted, { [createKey]: refusal(status, message) });
    const markup = renderedBody(await actionOf('create-request').submit(ctx));
    const $ = cheerio.load(markup, null, false);
    expect(fragmentModel(markup).alerts).toEqual([{ text: message, className: 'alert alert-error' }]);
    // The alert stands just before the form it refuses, under its heading, not above the list.
    const alert = $('form[name="form1"]').prev();
    expect(alert.is('div.alert.alert-error')).toBe(true);
    expect(alert.prev().is('h2')).toBe(true);
    expect($('div.mura-header').next().is('div.alert')).toBe(false);
    expect($('table.mura-table-grid')).toHaveLength(1);
    expect(CREATE_REQUEST_FIELDS.map((name) => $(`input[name="${name}"]`).attr('value'))).toEqual(
      CREATE_REQUEST_FIELDS.map((name) => posted[name]),
    );
    expect($('input[name="csrf_token"]').attr('value')).toBe(FIXED_CSRF.token);
    expect(eSignatureCalls(ctx.gateway).map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${REQUESTS_PATH}`,
      `GET ${REQUESTS_PATH}`,
    ]);
  });

  it.each<[string, FakeReply, typeof GatewayDenialError | typeof GatewayUnavailableError]>([
    ['a refused user token', refusal(401, 'x'), GatewayDenialError],
    ['an unavailable service', { status: 503 }, GatewayUnavailableError],
  ])('rejects on %s', async (_case, reply, type) => {
    const ctx = postBy(SIGNER, posted, { [createKey]: reply });
    await expect(actionOf('create-request').submit(ctx)).rejects.toBeInstanceOf(type);
  });

  /** The re-rendered list of a create of `fields` refused with `reply`. */
  async function refusedCreate(fields: Fields, reply: FakeReply) {
    const ctx = postBy(SIGNER, { ...posted, ...fields }, { [createKey]: reply });
    return cheerio.load(renderedBody(await actionOf('create-request').submit(ctx)), null, false);
  }

  /** The marked fields of a create refused with `reply`: name, message, aria-describedby and autofocus, in order. */
  async function markedFields(fields: Fields, reply: FakeReply) {
    const $ = await refusedCreate(fields, reply);
    expect($('[autofocus]')).toHaveLength(1);
    return $('div.mura-control-group.has-error')
      .toArray()
      .map((group) => {
        const input = $(group).find('input');
        const message = $(group).children('p.help-block');
        expect(input.attr('aria-invalid')).toBe('true');
        expect(message.attr('id')).toBe(`${input.attr('id')}-error`);
        return [input.attr('name'), message.text(), input.attr('aria-describedby'), input.attr('autofocus') !== undefined];
      });
  }

  it.each<[string, Fields, unknown[][]]>([
    ['an empty name', { documentName: '' }, [['documentName', 'Enter a document name.', 'documentName-error', true]]],
    [
      'a name over 255 characters',
      { documentName: 'n'.repeat(256) },
      [['documentName', 'Enter at most 255 characters.', 'documentName-error', true]],
    ],
    ...['not*base64', 'QQ', 'Q===', ''].map((documentBase64): [string, Fields, unknown[][]] => [
      `the document ${JSON.stringify(documentBase64)}`,
      { documentBase64 },
      [['documentBase64', 'Enter Base64 text that decodes to at least one byte.', 'documentBase64-error', true]],
    ]),
    [
      'the signer nobody',
      { signerUserId: 'nobody' },
      [
        [
          'signerUserId',
          'Enter a UserID of 35 characters: 8-4-4-16 hexadecimal digits.',
          'signerUserId-error signerUserId-hint',
          true,
        ],
      ],
    ],
    [
      'an empty signer and a bad document, the first focused',
      { documentBase64: '%%', signerUserId: '' },
      [
        ['documentBase64', 'Enter Base64 text that decodes to at least one byte.', 'documentBase64-error', true],
        ['signerUserId', "Enter the signer's UserID.", 'signerUserId-error signerUserId-hint', false],
      ],
    ],
  ])('marks %s beside its field on the invalidParameters refusal', async (_case, fields, expected) => {
    expect(await markedFields(fields, refusal(400, 'Invalid parameters'))).toEqual(expected);
  });

  const INVALID_VALUES: Fields = { documentName: '', signerUserId: 'nobody' };

  it.each<[string, Fields, FakeReply]>([
    [
      'a padded name and lowercase signer id, which e-signature may accept',
      { documentName: '  ', signerUserId: ESIGNATURE_IDS.signer.toLowerCase() },
      refusal(400, 'Invalid parameters'),
    ],
    [
      'Base64 with whitespace and padding, which e-signature may accept',
      { documentBase64: 'JVBE\r\nRi0x LjQK==' },
      refusal(400, 'Invalid parameters'),
    ],
    [
      'the installed admin signer, which e-signature may accept',
      { signerUserId: '00000000000000000000000000000000001' },
      refusal(400, 'Invalid parameters'),
    ],
    [
      'a signer id with surrounding spaces, which e-signature may accept',
      { signerUserId: ` ${ESIGNATURE_IDS.signer} ` },
      refusal(400, 'Invalid parameters'),
    ],
    ['a CSRF refusal, which says nothing of the values', INVALID_VALUES, refusal(400, 'Invalid CSRF tokens')],
    ['a role refusal, which says nothing of the values', INVALID_VALUES, refusal(403, 'Insufficient Account Permissions')],
  ])('marks no field for %s, and focuses the document name', async (_case, fields, reply) => {
    const $ = await refusedCreate(fields, reply);
    expect($('.has-error')).toHaveLength(0);
    expect($('[aria-invalid]')).toHaveLength(0);
    expect(
      $('[autofocus]')
        .toArray()
        .map((el) => $(el).attr('id')),
    ).toEqual(['documentName']);
  });

  it("explains the signer field with a standing hint of the site's user pool", async () => {
    const ctx = postBy(SIGNER, posted, { [createKey]: refusal(400, 'Invalid parameters') });
    const $ = cheerio.load(renderedBody(await actionOf('create-request').submit(ctx)), null, false);
    expect($('#signerUserId-hint').text()).toBe("The UserID of a user of this site's user pool.");
    expect($('#signerUserId-hint').is('div.help-block-inline')).toBe(true);
  });

  it.each<[string, 'allow' | 'noaccess' | 'login', () => AdminRequest]>([
    ['a signer', 'allow', () => opt2RoleRequest(SIGNER)],
    ['an auditor', 'noaccess', () => opt2RoleRequest(AUDITOR)],
    ['a system user without an e-signature role', 'noaccess', () => makeAdminRequest({}, SUBJECTS.systemUser)],
    ['an anonymous user', 'login', () => anonymousRequest()],
  ])('gate answers %s with %s', async (_who, expected, build) => {
    const req = build();
    const decision = await actionOf('create-request').gate?.(req, { secure: () => secure(req) });
    if (expected === 'allow') expect(decision).toEqual({ kind: 'allow' });
    else if (expected === 'noaccess') expect(decision).toEqual({ kind: 'redirect', location: '/admin/?muraAction=cMessage.noaccess' });
    else expect(decision).toMatchObject({ kind: 'redirect', location: expect.stringContaining('muraAction=cLogin.main') });
  });
});

describe('sign action', () => {
  it.each(['Jordan Ellis', '  Jordan  Ellis ', 'Zoë "J" <Ellis>'])(
    'signs with the typed name %j as typed and redirects to the request',
    async (typedName) => {
      const ctx = postBy(SIGNER, { id: PENDING_ID, typedName });
      const result = await actionOf('sign').submit(ctx);
      expect(result).toEqual({ kind: 'location', location: `/opt2/admin/e-signature/request?siteid=${SITE}&id=${PENDING_ID}` });
      expect(eSignatureCalls(ctx.gateway)).toEqual([
        {
          service: 'e-signature',
          method: 'POST',
          path: `${REQUESTS_PATH}/${PENDING_ID}/sign`,
          json: { typedName },
          headers: RELAYED_CSRF,
        },
      ]);
    },
  );

  it('re-renders an already signed request with the service conflict', async () => {
    const ctx = postBy(SIGNER, { id: SIGNED_ID, typedName: 'Jordan Ellis' });
    const markup = renderedBody(await actionOf('sign').submit(ctx));
    expect(fragmentModel(markup)).toMatchSnapshot();
    expect(fragmentModel(markup).alerts).toEqual([{ text: 'already-signed', className: 'alert alert-error' }]);
  });

  it.each<[number, string]>([
    [400, 'Invalid parameters'],
    [403, 'Insufficient Account Permissions'],
    [404, 'Not Found'],
  ])('re-renders the pending request on %i with the message and the posted name', async (status, message) => {
    const typedName = 'J"<x>';
    const ctx = postBy(SIGNER, { id: PENDING_ID, typedName }, { [key('POST', `${REQUESTS_PATH}/${PENDING_ID}/sign`)]: refusal(status, message) });
    const markup = renderedBody(await actionOf('sign').submit(ctx));
    const $ = cheerio.load(markup, null, false);
    expect(fragmentModel(markup).alerts).toEqual([{ text: message, className: 'alert alert-error' }]);
    expect($('input[name="typedName"]').attr('value')).toBe(typedName);
    expect($('input[name="csrf_token"]').attr('value')).toBe(FIXED_CSRF.token);
    expect(eSignatureCalls(ctx.gateway).map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${REQUESTS_PATH}/${PENDING_ID}/sign`,
      `GET ${REQUESTS_PATH}/${PENDING_ID}`,
    ]);
  });

  it('answers a refused user token with the denial the handlers redirect', async () => {
    const ctx = postBy(SIGNER, { id: PENDING_ID, typedName: 'x' }, { [key('POST', `${REQUESTS_PATH}/${PENDING_ID}/sign`)]: refusal(401, 'x') });
    await expect(actionOf('sign').submit(ctx)).rejects.toMatchObject({ name: 'GatewayDenialError', status: 401 });
  });

  it('fails closed when e-signature is unavailable', async () => {
    const ctx = postBy(SIGNER, { id: PENDING_ID, typedName: 'x' }, { [key('POST', `${REQUESTS_PATH}/${PENDING_ID}/sign`)]: { status: 503 } });
    await expect(actionOf('sign').submit(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('malformed request ids', () => {
  it.each(
    [
      { action: 'sign', role: SIGNER, fields: { typedName: 'Jordan Ellis' } as Fields },
      { action: 'verify', role: AUDITOR, fields: { entries: '[]' } as Fields },
    ].flatMap((post) => ['..', '../x', '../../x', 'abc'].map((id) => ({ ...post, id }))),
  )('re-renders $action for the id $id with the invalid-parameters alert, asking e-signature nothing', async (post) => {
    const ctx = postBy(post.role, { id: post.id, ...post.fields });
    const model = fragmentModel(renderedBody(await actionOf(post.action).submit(ctx)));
    expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
    expect(model.links.map((link) => link.text)).toEqual(['Signature Requests']);
    expect(eSignatureCalls(ctx.gateway)).toEqual([]);
  });
});

describe('verify action', () => {
  const stored: readonly AuditEntry[] = auditChain.items ?? [];
  // The signed entry's typed name is corrupted, so the service reports the chain broken at seq 2.
  const tampered = JSON.stringify(stored.map((entry) => (entry.seq === 2 ? { ...entry, detail: 'Mallory' } : entry)));

  it('renders the supplied copy verdict beside the stored one and keeps the posted copy', async () => {
    const ctx = postBy(AUDITOR, { id: SIGNED_ID, entries: tampered });
    const markup = renderedBody(await actionOf('verify').submit(ctx));
    expect(fragmentModel(markup)).toMatchSnapshot();
    expect(fragmentModel(markup).alerts).toEqual([
      { text: 'The stored audit chain is intact (2 entries).', className: 'alert alert-info' },
      { text: 'The supplied copy is broken at entry 2 (2 entries).', className: 'alert alert-error' },
    ]);
    expect(cheerio.load(markup, null, false)('textarea[name="entries"]').text()).toBe(tampered);
    expect(eSignatureCalls(ctx.gateway)[0]).toEqual({
      service: 'e-signature',
      method: 'POST',
      path: `${REQUESTS_PATH}/${SIGNED_ID}/verify`,
      json: { entries: tampered },
      headers: RELAYED_CSRF,
    });
  });

  it('re-renders a refused copy with the message, the stored verdict and the posted copy', async () => {
    const ctx = postBy(SIGNER, { id: SIGNED_ID, entries: 'not json' }, {
      [key('POST', `${REQUESTS_PATH}/${SIGNED_ID}/verify`)]: refusal(400, 'Invalid parameters'),
    });
    const markup = renderedBody(await actionOf('verify').submit(ctx));
    expect(fragmentModel(markup).alerts).toEqual([
      { text: 'Invalid parameters', className: 'alert alert-error' },
      { text: 'The stored audit chain is intact (2 entries).', className: 'alert alert-info' },
    ]);
    expect(cheerio.load(markup, null, false)('textarea[name="entries"]').text()).toBe('not json');
  });

  it.each<[string, FakeReply, typeof GatewayDenialError | typeof GatewayUnavailableError]>([
    ['a refused user token', refusal(401, 'x'), GatewayDenialError],
    ['an unavailable service', { status: 503 }, GatewayUnavailableError],
  ])('rejects on %s', async (_case, reply, type) => {
    const ctx = postBy(AUDITOR, { id: SIGNED_ID, entries: tampered }, { [key('POST', `${REQUESTS_PATH}/${SIGNED_ID}/verify`)]: reply });
    await expect(actionOf('verify').submit(ctx)).rejects.toBeInstanceOf(type);
  });
});
