// carch inline writes against admin/core/controllers/carch.cfc saveQuickEdit, saveCopyInfo, unlockFile, unlockNode,
// copy and updateObjectParams with admin/core/views/carch/updateobjectparams.cfm.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate, secure } from '@/lib/access-gate';
import { GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { carchScreens } from '@/screens/carch';
import { inlineWriteScreens } from '@/screens/carch/inline-writes';
import { carchRawRedirect } from '@/screens/carch/service';
import {
  findScreen,
  type RawBody,
  type ScreenContext,
  type ScreenDefinition,
  type ScreenRequestBody,
} from '@/screens/registry';
import { CONTENT_HIST_IDS, CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import { anonymousRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

const SITE = 'tenant-a';
const SERVICE = 'strategies-content';
const HTML_TYPE = 'text/html;charset=UTF-8';
const CONTENT_MODULE = '00000000000000000000000000000000000';
const CONTENT_ID = CONTENT_IDS.aboutUs;
const HIST_ID = CONTENT_HIST_IDS.aboutUsDraft;
const REFERER = `http://localhost/admin/?muraAction=cArch.list&siteid=${SITE}`;
const CSRF_FIELDS = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
const ENTRY_FIELDS = { contentid: CONTENT_ID, contenthistid: HIST_ID, ...CSRF_FIELDS };
const SERVICE_ERROR = { apiversion: 'v1', method: 'carch', error: { message: 'Denied', code: 'denied' } };

/** The legacy controller method of each carried inline write. */
const LEGACY_ACTIONS = ['saveQuickEdit', 'saveCopyInfo', 'unlockFile', 'unlockNode', 'updateObjectParams'] as const;
const RELAYED_ACTIONS = LEGACY_ACTIONS.filter((action) => action !== 'updateObjectParams');

// The contract names no `/v1/sites/<site>/carch/<action>` path: the aborting writes are raw relays and
// updateObjectParams posts to its version's object-params write.
const rawPath = (action: string): ServicePath => `/v1/raw/carch/${action.toLowerCase()}`;
const OBJECT_PARAMS_PATH: ServicePath = `/v1/sites/${SITE}/content/versions/${HIST_ID}/object-params`;
const writePath = (action: string): ServicePath =>
  action === 'updateObjectParams' ? OBJECT_PARAMS_PATH : rawPath(action);

/** ACF's answer to a write that ends in `abort`, and its bytes as web relays them. */
const ABORT_REPLY: FakeReply = { status: 200, headers: { 'Content-Type': HTML_TYPE } };
const ABORT_ANSWER: RawBody = { status: 200, contentType: HTML_TYPE, body: Buffer.alloc(0) };
const ABORTED: RawBody = { status: 200, contentType: HTML_TYPE, body: '' };

/** strategies-content's `AdminWriteResult` for an object-params save, `data` included when given. */
const written = (data?: Readonly<Record<string, unknown>>): FakeReply => ({
  status: 200,
  body: { saved: true, errors: {}, redirect: null, ...(data === undefined ? {} : { data }) },
});

interface WriteCase {
  readonly fields: Readonly<Record<string, string>>;
  readonly path: ServicePath;
  /** Sent beside the form by a raw relay; the object-params write sends none. */
  readonly query?: Readonly<Record<string, string>>;
  readonly reply: FakeReply;
  readonly answer: RawBody;
}

const relayedPost = (action: string, fields: Readonly<Record<string, string>>): WriteCase => ({
  fields: { ...fields, ...CSRF_FIELDS },
  path: rawPath(action),
  query: { siteid: SITE },
  reply: ABORT_REPLY,
  answer: ABORT_ANSWER,
});

const quickEdit = (attribute: string, values: Readonly<Record<string, string>>): WriteCase =>
  relayedPost('savequickedit', { contentid: CONTENT_ID, attribute, ...values });

const WRITES = [
  ['saveQuickEdit', 'attribute isnav', quickEdit('isnav', { isnav: '1' })],
  [
    'saveQuickEdit',
    'attribute display',
    quickEdit('display', {
      display: '2',
      displayStart: '01/15/2026',
      displayStop: '02/15/2026',
      displayInterval: '{"type":"daily","every":1}',
    }),
  ],
  [
    'saveQuickEdit',
    'attribute template',
    quickEdit('template', { template: 'two_column.cfm', childTemplate: 'one_column.cfm' }),
  ],
  ['saveQuickEdit', 'attribute inheritObjects', quickEdit('inheritObjects', { inheritObjects: 'Reject' })],
  [
    'saveCopyInfo',
    'a node with its children',
    relayedPost('savecopyinfo', { contentid: CONTENT_ID, moduleid: CONTENT_MODULE, copyAll: 'true' }),
  ],
  ['unlockFile', 'a file lock', relayedPost('unlockfile', { contentid: CONTENT_ID })],
  ['unlockNode', 'a node lock', relayedPost('unlocknode', { contentid: CONTENT_ID })],
  [
    'updateObjectParams',
    'a feed object',
    {
      fields: {
        contenthistid: HIST_ID,
        regionid: '2',
        object: 'feed',
        objectid: CONTENT_IDS.news,
        name: 'Latest News',
        params: '{"displaylist":"Title,Date"}',
        approved: '0',
        ...CSRF_FIELDS,
      },
      path: OBJECT_PARAMS_PATH,
      reply: written({ contentID: CONTENT_ID, contentHistID: HIST_ID }),
      answer: { status: 200, contentType: HTML_TYPE, body: `{contentid:'${CONTENT_ID}',contenthistid:'${HIST_ID}'} ` },
    },
  ],
] as const satisfies ReadonlyArray<readonly [string, string, WriteCase]>;

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

/** The inline write the module registers for a legacy action name, matched case-insensitively. */
function definition(legacyAction: string): ScreenDefinition {
  const def = inlineWriteScreens.find((candidate) => candidate.action.toLowerCase() === legacyAction.toLowerCase());
  if (def === undefined) throw new Error(`No inline write for carch.${legacyAction}`);
  return def;
}

/** `fields` as the URL-encoded body web received. */
function formBody(fields: Readonly<Record<string, string>>): ScreenRequestBody {
  const form = new URLSearchParams(fields);
  return { contentType: 'application/x-www-form-urlencoded', body: new Blob([form.toString()]), form };
}

interface ContextInput {
  readonly routes?: FakeRouteTable;
  /** Carries the fields as a posted body; otherwise the request has none. */
  readonly post?: boolean;
  readonly headers?: Headers;
}

/** The tenant-a site admin on `cArch.<legacyAction>` with `fields`, over a fake gateway answering `routes`. */
function contextOf(
  legacyAction: string,
  fields: Readonly<Record<string, string>>,
  { routes = {}, post = true, headers }: ContextInput = {},
): ScreenContext & { gateway: FakeGatewayClient } {
  const req = siteAdminRequest(SITE, { circuit: 'cArch', item: legacyAction, rc: fields, headers });
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes), body: post ? formBody(fields) : undefined });
}

/** The definition's answer, as the raw handler calls a json-mode screen. */
async function answerOf(def: ScreenDefinition, ctx: ScreenContext): Promise<RawBody> {
  if (def.mode !== 'json') throw new TypeError(`carch.${def.action} is a ${def.mode}-mode screen`);
  return def.json(ctx, undefined);
}

describe('carch inline write registration', () => {
  it('registers each carried inline write once and leaves the withheld carch.copy to legacy', () => {
    expect(inlineWriteScreens.map((def) => def.action).toSorted()).toEqual(
      LEGACY_ACTIONS.map((action) => action.toLowerCase()).toSorted(),
    );
    // carch.copy writes identity and strategies-content rows with no named owner, so it stays withheld on legacy.
    expect(inlineWriteScreens.some((def) => def.action === 'copy')).toBe(false);
    expect(carchScreens.some((def) => def.action === 'copy')).toBe(false);
    const copy = { siteid: SITE, contentid: CONTENT_ID, parentid: CONTENT_IDS.news, copyAll: 'true' };
    expect(findScreen('cArch', 'copy', copy)).toBeUndefined();
  });

  it.each(LEGACY_ACTIONS)('serves carch.%s in json mode under strategies-content from the carch barrel', (action) => {
    const def = definition(action);
    expect(def).toMatchObject({ circuit: 'carch', action: action.toLowerCase(), mode: 'json', owner: SERVICE });
    expect(carchScreens).toContain(def);
    expect(findScreen('core:cArch', action, { siteid: SITE, approved: '0' })).toBe(def);
  });

  it('leaves an approved carch.updateObjectParams to legacy', () => {
    expect(findScreen('cArch', 'updateObjectParams', { siteid: SITE, approved: 'true' })).toBeUndefined();
  });

  it('answers an anonymous request with the controller secure() redirect and lets the site admin through', async () => {
    const def = definition('unlockNode');
    const anonymous = anonymousRequest({ circuit: 'cArch', item: 'unlockNode' });
    const decision = await def.gate?.(anonymous, { secure: () => secure(anonymous) });
    expect(decision).toEqual(secure(anonymous));
    expect(decision).toEqual({
      kind: 'redirect',
      location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/),
    });
    const admin = siteAdminRequest(SITE, { circuit: 'cArch', item: 'unlockNode' });
    await expect(runGate(admin, def.gate)).resolves.toEqual({ kind: 'allow' });
  });
});

describe('carch inline writes', () => {
  it.each(WRITES)(
    'posts carch.%s for %s as received and answers with the service response',
    async (action, _label, { fields, path, query, reply, answer }: WriteCase) => {
      const ctx = contextOf(action, fields, { routes: { [routeKey('POST', SERVICE, path)]: reply } });
      await expect(answerOf(definition(action), ctx)).resolves.toEqual(answer);
      // The form is the rc as carch before() leaves it; the request carried no csrf headers, so none are sent.
      expect(ctx.gateway.calls).toEqual([
        { service: SERVICE, method: 'POST', path, ...(query === undefined ? {} : { query }), form: { ...ctx.req.rc } },
      ]);
      expect(ctx.gateway.calls[0]?.form).toMatchObject(fields);
    },
  );

  it.each(RELAYED_ACTIONS)('relays a bodiless carch.%s over GET with the rc as url fields', async (action) => {
    const fields = { contentid: CONTENT_ID, ...CSRF_FIELDS };
    const routes = { [routeKey('GET', SERVICE, rawPath(action))]: ABORT_REPLY };
    const ctx = contextOf(action, fields, { routes, post: false });
    await expect(answerOf(definition(action), ctx)).resolves.toEqual(ABORT_ANSWER);
    expect(ctx.gateway.calls).toEqual([
      { service: SERVICE, method: 'GET', path: rawPath(action), query: { ...ctx.req.rc } },
    ]);
    expect(ctx.gateway.calls[0]?.query).toMatchObject({ ...fields, siteid: SITE });
  });

  it.each(LEGACY_ACTIONS)('answers a denied carch.%s with a 302 to the controller secure() target', async (action) => {
    const routes = { [routeKey('POST', SERVICE, writePath(action))]: { status: 403, body: SERVICE_ERROR } };
    const ctx = contextOf(action, ENTRY_FIELDS, { routes, headers: new Headers({ referer: REFERER }) });
    await expect(answerOf(definition(action), ctx)).resolves.toEqual(carchRawRedirect(REFERER));
  });

  it.each(LEGACY_ACTIONS)('fails closed on carch.%s when strategies-content is unavailable', async (action) => {
    const routes = { [routeKey('POST', SERVICE, writePath(action))]: { status: 503, body: SERVICE_ERROR } };
    await expect(answerOf(definition(action), contextOf(action, ENTRY_FIELDS, { routes }))).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
    const refused = contextOf(action, ENTRY_FIELDS);
    refused.gateway.failWith();
    await expect(answerOf(definition(action), refused)).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(refused.gateway.calls).toHaveLength(1);
  });
});

describe('carch.updateObjectParams', () => {
  const FIELDS = { contenthistid: HIST_ID, params: '{}', approved: '0', ...CSRF_FIELDS };
  const posted = (reply: FakeReply, fields: Readonly<Record<string, string>> = FIELDS) =>
    contextOf('updateObjectParams', fields, { routes: { [routeKey('POST', SERVICE, OBJECT_PARAMS_PATH)]: reply } });
  const run = (ctx: ScreenContext): Promise<RawBody> => answerOf(definition('updateObjectParams'), ctx);

  it.each<[string, FakeReply]>([
    ['an unknown version', { status: 404, body: SERVICE_ERROR }],
    ['a result without version data', written()],
    ['a result without contenthistid', written({ contentid: CONTENT_ID })],
    ['a non-string contentid', written({ contentid: 7, contenthistid: HIST_ID })],
  ])('aborts with an empty body on %s', async (_label, reply) => {
    await expect(run(posted(reply))).resolves.toEqual(ABORTED);
  });

  it('aborts on an empty contenthistid without calling strategies-content', async () => {
    const ctx = posted(written(), { ...FIELDS, contenthistid: '' });
    await expect(run(ctx)).resolves.toEqual(ABORTED);
    expect(ctx.gateway.calls).toEqual([]);
  });

  it('fails on any other rejection, which legacy answers with a ColdFusion error', async () => {
    await expect(run(posted({ status: 400, body: SERVICE_ERROR }))).rejects.toEqual(
      new Error('strategies-content rejected carch.updateobjectparams with HTTP 400'),
    );
  });
});
