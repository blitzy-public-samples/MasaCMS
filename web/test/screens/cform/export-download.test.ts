// cform.export relay: forwarded siteid and contentid, zip bytes and download headers passed through unchanged.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { createResourceBundles } from '@/lib/resource-bundles/rb';
import { downloadResponse } from '@/lib/responses';
import { exportForm } from '@/screens/cform/export';
import type { ScreenContext } from '@/screens/registry';
import { fixtureBundles } from '../../fixtures/resource-bundles/generated-bundles';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

const PATH = '/v1/raw/cform/export';
const ROUTE = routeKey('GET', 'strategies-content', PATH);
const CONTENT_ID = '4B1D7E20-3C5A-4F8E-9D2B6A0C1E3F5A79';
const DISPOSITION = 'attachment;filename=contact_us_form_2026_30_06_tenant-a.zip';
const LEGACY_HTML = 'text/html;charset=UTF-8';

// A zip local-file header followed by every byte value, so any text decoding would alter it.
const ZIP = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
]);

const SERVICE_HEADERS = {
  'content-type': 'application/zip',
  'content-disposition': DISPOSITION,
  generator: 'Masa CMS 7.6.1',
  'strict-transport-security': 'max-age=1200',
};

const rb = createResourceBundles(fixtureBundles).rbFor('en_US');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let restoreEnv: () => void;
let gateway: FakeGatewayClient;

beforeEach(() => {
  restoreEnv = useTestEnv();
  gateway = fakeGatewayClient({
    [ROUTE]: { status: 200, headers: SERVICE_HEADERS, body: ZIP, setCookies: ['MURA_EXPORT=1; Path=/'] },
  });
});

afterEach(() => {
  restoreEnv();
});

/** The screen context of an S2 `cform.export` request carrying `rc`. */
function contextFor(rc: Readonly<Record<string, string>>): ScreenContext {
  return {
    req: adminS2Request({ circuit: 'cform', item: 'export', rc }),
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb,
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

describe('exportForm', () => {
  it.each([
    [
      'siteid and contentid only',
      { siteid: 'tenant-a', contentid: CONTENT_ID, topid: '00000000000000000000000000000000001', moduleid: 'x' },
      { siteid: 'tenant-a', contentid: CONTENT_ID },
    ],
    ['a contentID in any case', { contentID: CONTENT_ID }, { siteid: 'default', contentid: CONTENT_ID }],
    ['no contentid when the request has none', {}, { siteid: 'default' }],
  ])('forwards %s, unchanged', async (_label, rc, forwarded) => {
    await exportForm(contextFor(rc));

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({ service: 'strategies-content', method: 'GET', path: PATH });
    expect(gateway.calls[0]?.query).toEqual(forwarded);
    expect(gateway.calls[0]?.form).toBeUndefined();
  });

  it('relays the status, zip bytes, headers and cookies as received', async () => {
    const result = await exportForm(contextFor({ siteid: 'tenant-a', contentid: CONTENT_ID }));

    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/zip');
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(sha256(result.body as Uint8Array)).toBe(sha256(ZIP));
    expect(result.headers).toEqual({
      'content-disposition': DISPOSITION,
      generator: 'Masa CMS 7.6.1',
      'strict-transport-security': 'max-age=1200',
    });
    expect(result.setCookies).toEqual(['MURA_EXPORT=1; Path=/']);
  });

  it('reaches the wire intact through the download passthrough', async () => {
    const raw = await exportForm(contextFor({ siteid: 'tenant-a', contentid: CONTENT_ID }));

    const response = downloadResponse({
      status: raw.status ?? 200,
      headers: { 'content-type': raw.contentType, ...raw.headers },
      body: raw.body as Uint8Array,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-disposition')).toBe(DISPOSITION);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(ZIP));
  });

  it.each<[string, FakeReply, string]>([
    ['a non-denial 4xx', { status: 404, headers: { 'content-type': LEGACY_HTML }, body: '' }, LEGACY_HTML],
    ['an error page', { status: 500, headers: { 'content-type': LEGACY_HTML }, body: '<h1>Error</h1>' }, LEGACY_HTML],
    ['an answer without a content type', { status: 200, body: 'PK' }, ''],
  ])('relays %s as received', async (_label, reply, contentType) => {
    gateway.setRoute(ROUTE, reply);

    const result = await exportForm(contextFor({}));

    expect(result).toEqual({ status: reply.status, contentType, body: Buffer.from(reply.body as string), headers: {} });
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i instead of relaying it', async (status) => {
    gateway.setRoute(ROUTE, { status, headers: { 'content-type': 'application/json;charset=utf-8' }, body: '{}' });

    const error = await exportForm(contextFor({ contentid: CONTENT_ID })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', status, operation: `GET ${PATH}` });
  });

  it.each([
    ['an unreachable gateway', (): void => gateway.failWith()],
    ['a 503 answer', (): void => gateway.setRoute(ROUTE, { status: 503, body: '' })],
  ])('propagates unavailability from %s', async (_label, arrange) => {
    arrange();

    await expect(exportForm(contextFor({ contentid: CONTENT_ID }))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
