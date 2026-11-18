// rawActionScreens against the carch fragment, JSON and download views (admin/core/views/carch) and their raw relays.
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { carchScreens } from '@/screens/carch';
import { rawActionScreens } from '@/screens/carch/raw-actions';
import type { RawBody, ScreenContext, ScreenDefinition, ScreenRequestBody } from '@/screens/registry';
import { APPROVAL_REQUEST_IDS, statusModalPending } from '../../fixtures/strategies-content/approval-chains';
import { CONTENT_HIST_IDS, CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import {
  DOWNLOADDATA_BODY_URL,
  DOWNLOADDATA_FILENAME,
  downloaddataRelay,
  loaddiffRelay,
  loadsitemanagerDecoded,
  loadsitemanagerRelay,
} from '../../fixtures/strategies-content/raw';
import { FORWARDED_HOST_HEADERS, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

type Method = 'GET' | 'POST';
type Fields = Readonly<Record<string, string>>;

const SERVICE = 'strategies-content';
const SITE = 'tenant-a';
const HTML_TYPE = 'text/html;charset=UTF-8';
const CSRF_NAMES = ['csrf_token', 'csrf_token_expires'] as const;
const CALLER_CSRF = { csrf_token: 'C1', csrf_token_expires: '260630150000000' } as const;
const LOADDIFF = readFileSync(new URL('../../fixtures/strategies-content/loaddiff.html', import.meta.url));
const CSV = readFileSync(DOWNLOADDATA_BODY_URL);
const CANNED = { status: 200, headers: { 'content-type': HTML_TYPE }, body: '<p>x</p>' } as const;
const NAMED: readonly string[] = ['loaddiff', 'loadsitemanager', 'approvalaction', 'downloaddata'];
const OTHERS = rawActionScreens.map((def) => def.action).filter((action) => !NAMED.includes(action));

const rawPath = (action: string): ServicePath => `/v1/raw/carch/${action}`;
const svc = (method: Method, action: string): string => routeKey(method, SERVICE, rawPath(action));

/** A recorded relay answer as the fake gateway sends it. */
const replyOf = ({ status, headers, body }: { status: number; headers: Fields; body: string }): FakeReply => ({
  status,
  headers,
  body,
});

/** The relayed body as UTF-8 text. */
const text = ({ body }: RawBody): string => (Buffer.isBuffer(body) ? body.toString('utf8') : String(body));

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

function definition(action: string): ScreenDefinition {
  const def = rawActionScreens.find((candidate) => candidate.action === action);
  if (def === undefined) throw new Error(`No carch.${action} definition`);
  return def;
}

/** `fields` as the URL-encoded body web received. */
function formBody(fields: Fields): ScreenRequestBody {
  const form = new URLSearchParams(fields);
  return { contentType: 'application/x-www-form-urlencoded', body: new Blob([form.toString()]), form };
}

interface CallInput {
  readonly rc?: Fields;
  /** Carries `rc` as a posted body; otherwise the request has none. */
  readonly post?: boolean;
}

/** The tenant-a site admin on `carch.<action>` over a gateway answering `routes`. */
function screenContext(
  action: string,
  routes: FakeRouteTable,
  { rc = {}, post = false }: CallInput = {},
): ScreenContext & { gateway: FakeGatewayClient } {
  const req = siteAdminRequest(SITE, { circuit: 'carch', item: action, rc });
  return makeScreenContext({ req, gateway: fakeGatewayClient(routes), body: post ? formBody(rc) : undefined });
}

/** The definition's answer, called as its mode's admin-raw handler calls it. */
async function invoke(def: ScreenDefinition, ctx: ScreenContext): Promise<RawBody> {
  switch (def.mode) {
    case 'fragment':
      return def.render(ctx, undefined);
    case 'json':
      return def.json(ctx, undefined);
    case 'download':
      return def.download(ctx, undefined);
    default:
      throw new Error(`carch.${def.action} is a ${def.mode}-mode screen`);
  }
}

describe('carch raw actions', () => {
  it('relays loaddiff bare, byte for byte', async () => {
    const def = definition('loaddiff');
    expect(def.mode).toBe('fragment');
    const rc = { contenthistid1: CONTENT_HIST_IDS.aboutUs, contenthistid2: CONTENT_HIST_IDS.aboutUsDraft };
    const ctx = screenContext('loaddiff', { [svc('GET', 'loaddiff')]: replyOf(loaddiffRelay) }, { rc });
    await expect(invoke(def, ctx)).resolves.toEqual({ status: 200, contentType: HTML_TYPE, body: LOADDIFF });
    expect(ctx.gateway.calls).toEqual([
      {
        service: SERVICE,
        method: 'GET',
        path: rawPath('loaddiff'),
        query: expect.objectContaining({ ...rc, siteid: SITE }),
        headers: FORWARDED_HOST_HEADERS,
      },
    ]);
  });

  it('relays the loadsitemanager JSON with its rendered tree unchanged', async () => {
    const def = definition('loadsitemanager');
    expect(def.mode).toBe('json');
    const rc = { topid: '00000000000000000000000000000000001', sortby: '', sortdirection: '', startrow: '1' };
    const routes = { [svc('GET', 'loadsitemanager')]: replyOf(loadsitemanagerRelay) };
    const ctx = screenContext('loadsitemanager', routes, { rc });
    const raw = await invoke(def, ctx);
    expect(raw).toEqual({
      status: 200,
      contentType: loadsitemanagerRelay.headers['content-type'],
      body: Buffer.from(loadsitemanagerRelay.body),
    });
    const decoded: unknown = JSON.parse(text(raw));
    expect(Object.keys(decoded as object)).toEqual(['html', 'perm', 'sortby']);
    expect(decoded).toEqual(loadsitemanagerDecoded);
  });

  it.each<[string, Fields]>([
    ['Approve without a token', { comment: '', action: 'Approve' }],
    ['Reject without a token', { comment: 'Needs a new title', action: 'Reject' }],
    ['Approve with the caller token', { comment: '', action: 'Approve', ...CALLER_CSRF }],
  ])('relays approvalaction %s as posted', async (_label, values) => {
    const modal = screenContext('statusmodal', { [svc('GET', 'statusmodal')]: replyOf(statusModalPending) });
    const requestid = /applyApprovalAction\('([^']+)'/.exec(text(await invoke(definition('statusmodal'), modal)))?.[1];
    expect(requestid).toBe(APPROVAL_REQUEST_IDS.pending);

    const def = definition('approvalaction');
    expect(def.mode).toBe('json');
    const fields: Fields = { siteid: SITE, requestid: requestid ?? '', ...values };
    const json = JSON.stringify({ contenthistid: CONTENT_HIST_IDS.aboutUsDraft, previewurl: '/about-us/?previewid=x' });
    const reply = { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, body: json };
    const ctx = screenContext('approvalaction', { [svc('POST', 'approvalaction')]: reply }, { rc: fields, post: true });
    await expect(invoke(def, ctx)).resolves.toEqual({
      status: 200,
      contentType: 'application/json;charset=UTF-8',
      body: Buffer.from(json),
    });
    expect(ctx.gateway.calls).toEqual([
      {
        service: SERVICE,
        method: 'POST',
        path: rawPath('approvalaction'),
        query: { siteid: SITE },
        form: expect.objectContaining(fields),
        headers: FORWARDED_HOST_HEADERS,
      },
    ]);
    for (const name of CSRF_NAMES) expect(ctx.gateway.calls[0]?.form?.[name]).toBe(fields[name]);
  });

  it('relays downloaddata with the legacy download headers and CRLF rows', async () => {
    const def = definition('downloaddata');
    expect(def.mode).toBe('download');
    expect(CSV.includes('\r\n')).toBe(true);
    const rc = { contentid: CONTENT_IDS.contactForm };
    const ctx = screenContext('downloaddata', { [svc('GET', 'downloaddata')]: replyOf(downloaddataRelay) }, { rc });
    const raw = await invoke(def, ctx);
    expect(raw).toEqual({
      status: 200,
      contentType: 'application/msexcel',
      body: expect.any(Readable),
      headers: { 'content-disposition': `attachment;filename=${DOWNLOADDATA_FILENAME}`, expires: '0' },
    });
    expect(await buffer(raw.body as Readable)).toEqual(CSV);
  });

  it.each(OTHERS.flatMap((action): Array<[string, Method]> => [[action, 'GET'], [action, 'POST']]))(
    'relays carch.%s over %s unchanged',
    async (action, method) => {
      const rc = { contentid: CONTENT_IDS.aboutUs };
      const ctx = screenContext(action, { [svc(method, action)]: CANNED }, { rc, post: method === 'POST' });
      await expect(invoke(definition(action), ctx)).resolves.toEqual({
        status: 200,
        contentType: HTML_TYPE,
        body: Buffer.from(CANNED.body),
      });
      expect(ctx.gateway.calls).toEqual([expect.objectContaining({ service: SERVICE, method, path: rawPath(action) })]);
    },
  );

  it.each([400, 404, 500])('passes a %i through with its body', async (status) => {
    const reply = { status, headers: { 'content-type': HTML_TYPE }, body: '<h1>Not Found</h1>' };
    const ctx = screenContext('loaddiff', { [svc('GET', 'loaddiff')]: reply });
    await expect(invoke(definition('loaddiff'), ctx)).resolves.toEqual({
      status,
      contentType: HTML_TYPE,
      body: Buffer.from(reply.body),
    });
  });

  it.each(rawActionScreens.map((def): [string, ScreenDefinition] => [def.action, def]))(
    'registers carch.%s under strategies-content in carchScreens',
    (_action, def) => {
      expect(def).toEqual(expect.objectContaining({ circuit: 'carch', owner: SERVICE }));
      expect(carchScreens).toContain(def);
    },
  );

  it.each(['loaddiff', 'loadsitemanager', 'downloaddata'])(
    'fails closed on carch.%s when the gateway is unavailable',
    async (action) => {
      const refused = screenContext(action, {});
      refused.gateway.failWith();
      await expect(invoke(definition(action), refused)).rejects.toBeInstanceOf(GatewayUnavailableError);
      const down = screenContext(action, { [svc('GET', action)]: { status: 503 } });
      await expect(invoke(definition(action), down)).rejects.toBeInstanceOf(GatewayUnavailableError);
    },
  );
});
