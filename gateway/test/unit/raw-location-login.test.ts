// An admin login whose redirect legacy sends with Location bytes Node refuses: halted to legacy in its write window, its head relayed byte for byte.
import { Buffer } from 'node:buffer';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommittedVersion } from '../helpers/versions.js';
import { committedIndex } from '../helpers/versions.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';

const LOGIN_URL = '/admin/index.cfm?muraAction=cLogin.login';
const LOGIN_ROUTE = 'admin:clogin.login';
const SITE_HOST = 'tenant-a.example.test';
/** handleFailure's admin redirect for a `contentid` holding U+017F and U+0100, as ACF sends their low bytes, DEL and NUL. */
const RAW_LOCATION = './?muraAction=cLogin.main&display=login&status=failed&rememberMe=0&contentid=a\u007f\u0000b&LinkServID=&returnURL=&compactDisplay=false';

let gateway: TestGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

/** Sends `form` as a login POST on its own connection, which the gateway closes after the answer; resolves the answer's head as latin1 text and its body. */
function rawLogin(gw: TestGateway, form: string, requestId: string): Promise<{ head: string; body: Buffer }> {
  const { port } = gw.app.server.address() as AddressInfo;
  const body = Buffer.from(form);
  const request = [
    `POST ${LOGIN_URL} HTTP/1.1`,
    `Host: ${SITE_HOST}`,
    'Content-Type: application/x-www-form-urlencoded',
    `Content-Length: ${String(body.length)}`,
    `X-Request-Id: ${requestId}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(Buffer.concat([Buffer.from(request, 'latin1'), body])));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const bytes = Buffer.concat(chunks);
      const at = bytes.indexOf('\r\n\r\n');
      resolve({ head: bytes.subarray(0, at + 2).toString('latin1'), body: bytes.subarray(at + 4) });
    });
  });
}

/** A copy of the gateway's in-flight rows. */
function inflightRows(gw: TestGateway): unknown[] {
  if (gw.memory === undefined) throw new Error('the test gateway has no memory store');
  return gw.memory.tables.inflight.map((row) => ({ ...row }));
}

describe('an admin login whose redirect legacy sends with bytes Node refuses', () => {
  it.each<[CommittedVersion, boolean]>([
    ['v0002', true],
    ['v0001', false],
  ])("under %s runs on legacy, inside a write window when its units are target-authoritative (%s), and relays legacy's head byte for byte", async (version, windowed) => {
    gateway = await buildTestGateway({ version, services: [] });
    const gw = gateway;
    await gw.app.listen({ host: '127.0.0.1', port: 0 });
    const index = await committedIndex(version);
    const units = (index.entryFor(LOGIN_ROUTE)?.units ?? []).filter((unit) => index.unitAuthority(unit) === 'target').sort();
    gw.legacy.setResponse({ status: 302, headers: { 'Content-Type': 'text/html;charset=UTF-8' }, rawHeaders: { Location: RAW_LOCATION }, body: '' });

    const form = 'username=admin&password=wrong&isAdminLogin=true&contentid=a%C5%BF%C4%80b';
    const res = await rawLogin(gw, form, `req-raw-${version}`);

    expect(res.head.startsWith('HTTP/1.1 302 Found\r\n')).toBe(true);
    expect(res.head).toContain(`\r\nLocation: ${RAW_LOCATION}\r\n`);
    expect(
      gw.legacy.requests.filter((req) => !req.path.startsWith('/gateway/legacy-bridge/')).map((req) => [req.method, req.url, req.body.toString('latin1')]),
    ).toEqual([['POST', LOGIN_URL, form]]);
    expect(gw.web.requests).toEqual([]);
    expect(units.length > 0).toBe(windowed);
    expect(gw.migration.windows.map(({ routeKey, units: gated, completion }) => ({ routeKey, units: [...gated].sort(), completion }))).toEqual(
      windowed ? [{ routeKey: LOGIN_ROUTE, units, completion: { forwarded: true, legacyStatus: 302 } }] : [],
    );
    expect(inflightRows(gw)).toEqual([]);
  });

  it('keeps every other login on the target, outside any window', async () => {
    gateway = await buildTestGateway({ version: 'v0002', services: [] });
    const gw = gateway;
    await gw.app.listen({ host: '127.0.0.1', port: 0 });

    const res = await rawLogin(gw, 'username=admin&password=wrong&isAdminLogin=true&contentid=a%C4%89b&returnUrl=.%2F%3Fx%3D%C3%A9', 'req-plain');

    expect(res.head.startsWith('HTTP/1.1 ')).toBe(true);
    expect(gw.web.requests.map((req) => [req.method, req.path])).toEqual([['POST', '/admin/clogin/login']]);
    expect(gw.legacy.requests.filter((req) => !req.path.startsWith('/gateway/legacy-bridge/'))).toEqual([]);
    expect(gw.migration.windows).toEqual([]);
  });
});
