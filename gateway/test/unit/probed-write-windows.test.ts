// Write windows the gateway decides by asking: migration's orphan archive probe and the bridge's static-file probe.
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestGateway, type TestGateway, type TestGatewayOptions } from '../helpers/app.js';
import type { InflightRowRecord } from '../helpers/memory-store.js';

const ORPHAN_PATH = '/internal/v1/probes/orphan-archive';
const OPEN_PATH = '/internal/v1/windows';
const ORPHAN_ARCHIVE = 'content.filename_archive';
const IDENTITY_LOGIN = ['identity.group_account', 'identity.login_state'];
const REMEMBER_ME = 'userid=8B5BD4AA-AB36-4E2C-8EE1A6E1E45DB3F0; userHash=0A1B2C3D';
const MISSING_PAGE = '/missing-page/';
const MISSING_STATIC = '/core/vendor/missing.js';
const VENDOR_ROUTE = 'static:/core/vendor/**';
const FILE_ID = '8B5BD4AA-AB36-4E2C-8EE1A6E1E45DB3F1';

let gateway: TestGateway | undefined;
let sequence = 0;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function start(opts: Pick<TestGatewayOptions, 'migration' | 'version'> = {}): Promise<TestGateway> {
  gateway = await buildTestGateway({ version: 'v0002', services: [], ...opts });
  return gateway;
}

/** What one request did: its answer, its windows, the page requests legacy received and what migration held when legacy ran. */
interface Sent {
  status: number;
  body: string;
  requestId: string;
  windows: Array<{ routeKey: string; units: string[]; scope: unknown; forwarded: boolean | undefined; legacyStatus: number | undefined }>;
  pages: number;
  /** Windows open and in-flight rows of the request while legacy ran it; undefined when legacy never ran it. */
  duringLegacy: { windows: number; probes: number; rows: InflightRowRecord[] } | undefined;
}

/** Sends a GET of `url` with `cookie`, legacy answering it `status`. */
async function send(gw: TestGateway, url: string, cookie?: string, status = 404): Promise<Sent> {
  sequence += 1;
  const requestId = `req-probe-${String(sequence)}`;
  let duringLegacy: Sent['duringLegacy'];
  gw.legacy.setResponse(() => {
    duringLegacy = {
      windows: gw.migration.windows.filter((window) => window.requestId === requestId).length,
      probes: gw.migration.orphanProbes.length,
      rows: (gw.memory?.tables.inflight ?? []).filter((row) => row.request_id === requestId).map((row) => ({ ...row })),
    };
    return { status, body: 'legacy page' };
  });
  const pagesBefore = pageRequests(gw);
  const res = await gw.app.inject({
    method: 'GET',
    url,
    headers: { 'x-request-id': requestId, ...(cookie === undefined ? {} : { cookie }) },
  });
  const windows = gw.migration.windows
    .filter((window) => window.requestId === requestId)
    .map(({ routeKey, units, scope, completion }) => ({
      routeKey,
      units: [...units].sort(),
      scope,
      forwarded: completion?.forwarded,
      legacyStatus: completion?.legacyStatus,
    }));
  return { status: res.statusCode, body: res.body, requestId, windows, pages: pageRequests(gw) - pagesBefore, duringLegacy };
}

/** Requests legacy received other than bridge calls. */
function pageRequests(gw: TestGateway): number {
  return gw.legacy.requests.filter((req) => !req.path.startsWith('/gateway/legacy-bridge/')).length;
}

function migrationPaths(gw: TestGateway): string[] {
  return gw.migration.requests.map((req) => req.path);
}

describe('the orphan archive cleanup of a 404 render under v0002', () => {
  it('asks migration before legacy runs and forwards inside a window over the archive unit when an orphan row is reachable', async () => {
    const gw = await start({ migration: { orphanArchive: true } });

    const sent = await send(gw, MISSING_PAGE);

    expect(sent).toMatchObject({ status: 404, body: 'legacy page', pages: 1 });
    expect(gw.migration.orphanProbes.map((probe) => probe.filenames)).toEqual([['404', 'missing-page']]);
    expect(migrationPaths(gw)).toEqual([ORPHAN_PATH, OPEN_PATH, expect.stringMatching(/^\/internal\/v1\/windows\/.+:complete$/) as string]);
    expect(sent.windows).toEqual([{ routeKey: 'page:render', units: [ORPHAN_ARCHIVE], scope: { table: true }, forwarded: true, legacyStatus: 404 }]);
    expect(sent.duringLegacy).toMatchObject({ windows: 1, probes: 1 });
    expect(sent.duringLegacy?.rows).toEqual([expect.objectContaining({ route: 'page:render', side: 'legacy', window_id: expect.any(String) as string })]);
  });

  it('asks about the ref items custom URL vars leave and forwards inside a window when an orphan row is reachable only there', async () => {
    const gw = await start({ migration: { orphanArchive: (filenames) => filenames.includes('a/b') } });

    const sent = await send(gw, '/missing/ref/a/params/x/y/ref/b/');

    expect(sent).toMatchObject({ status: 404, body: 'legacy page', pages: 1 });
    expect(gw.migration.orphanProbes.map((probe) => probe.filenames)).toEqual([expect.arrayContaining(['a/b', 'a'])]);
    expect(migrationPaths(gw)).toEqual([ORPHAN_PATH, OPEN_PATH, expect.stringMatching(/^\/internal\/v1\/windows\/.+:complete$/) as string]);
    expect(sent.windows).toEqual([{ routeKey: 'page:render', units: [ORPHAN_ARCHIVE], scope: { table: true }, forwarded: true, legacyStatus: 404 }]);
    expect(sent.duringLegacy).toMatchObject({ windows: 1, probes: 1 });
  });

  it('forwards with no window when migration finds no orphan row', async () => {
    const gw = await start();

    const sent = await send(gw, '/about/index.cfm/team');

    expect(sent).toMatchObject({ status: 404, pages: 1, windows: [] });
    expect(gw.migration.orphanProbes.map((probe) => [...probe.filenames].sort())).toEqual([
      ['404', 'about', 'about/index.cfm', 'about/index.cfm/team', 'about/team', 'index.cfm', 'index.cfm/team', 'team'],
    ]);
    expect(migrationPaths(gw)).toEqual([ORPHAN_PATH]);
  });

  it("asks only about render404's 404 page for the home page, and forwards with no window when migration finds no orphan row", async () => {
    const gw = await start();

    const sent = await send(gw, '/', undefined, 200);

    expect(sent).toMatchObject({ status: 200, pages: 1, windows: [] });
    expect(gw.migration.orphanProbes.map((probe) => probe.filenames)).toEqual([['404']]);
    expect(migrationPaths(gw)).toEqual([ORPHAN_PATH]);
  });

  it.each<[string, string, string, string[]]>([
    ['a file render', `/index.cfm/_api/render/file/?fileid=${FILE_ID}`, 'render:file', ['content.file', ORPHAN_ARCHIVE]],
    ['a feed', '/index.cfm/_api/feed/v1/default/?feedid=F1', 'feed:v1', [ORPHAN_ARCHIVE]],
    ['an asset render', '/index.cfm/_api/asset/image/?filePath=/default/assets/Image/missing.png', 'asset:render', [ORPHAN_ARCHIVE]],
    ['a missing template', '/zz-missing.cfm', 'page:render', [ORPHAN_ARCHIVE]],
  ])("forwards %s inside a window over the archive unit when only render404's 404 page names an orphan row", async (_label, url, routeKey, units) => {
    const gw = await start({ migration: { orphanArchive: (filenames) => filenames.includes('404') } });

    const sent = await send(gw, url);

    expect(sent).toMatchObject({ status: 404, body: 'legacy page', pages: 1 });
    expect(gw.migration.orphanProbes.map((probe) => probe.filenames)).toEqual([expect.arrayContaining(['404'])]);
    expect(sent.windows.at(-1)).toEqual({ routeKey, units, scope: { table: true }, forwarded: true, legacyStatus: 404 });
    expect(sent.windows.slice(0, -1).every((window) => window.forwarded === false)).toBe(true);
    expect(migrationPaths(gw).lastIndexOf(OPEN_PATH)).toBeGreaterThan(migrationPaths(gw).indexOf(ORPHAN_PATH));
    expect(sent.duringLegacy).toMatchObject({ windows: sent.windows.length, probes: 1 });
  });

  it('closes a window already open for other units and opens one over them and the archive unit', async () => {
    const gw = await start({ migration: { orphanArchive: true } });

    const sent = await send(gw, `${MISSING_PAGE}?size=small`);

    expect(sent.status).toBe(404);
    expect(sent.windows).toEqual([
      { routeKey: 'page:render', units: ['content.file'], scope: { table: true }, forwarded: false, legacyStatus: undefined },
      { routeKey: 'page:render', units: ['content.file', ORPHAN_ARCHIVE], scope: { table: true }, forwarded: true, legacyStatus: 404 },
    ]);
    expect(sent.duringLegacy?.windows).toBe(2);
  });

  it('asks nothing when the request is already windowed over the archive unit', async () => {
    const gw = await start({ migration: { orphanArchive: true } });

    const sent = await send(gw, `${MISSING_PAGE}?appreload`);

    expect(sent.windows).toHaveLength(1);
    expect(sent.windows[0]?.units).toContain(ORPHAN_ARCHIVE);
    expect(gw.migration.orphanProbes).toEqual([]);
  });

  it('opens the window when the probe cannot be answered, since an orphan row may then be reachable', async () => {
    const gw = await start({ migration: { orphanArchive: { status: 503 } } });

    const sent = await send(gw, MISSING_PAGE);

    expect(sent).toMatchObject({ status: 404, pages: 1 });
    expect(sent.windows).toEqual([expect.objectContaining({ routeKey: 'page:render', units: [ORPHAN_ARCHIVE], forwarded: true })]);
  });

  it.each<[string, NonNullable<TestGatewayOptions['migration']>]>([
    ['refuses the probe and the window', { orphanArchive: { status: 503 }, open: { status: 503 } }],
    ['drops both connections', { orphanArchive: 'refuse', open: 'refuse' }],
    ['finds an orphan row and refuses the window', { orphanArchive: true, open: { status: 503 } }],
  ])('answers the legacy 503 before legacy executes when migration %s', async (_label, migration) => {
    const gw = await start({ migration });

    const sent = await send(gw, MISSING_PAGE);

    expect(sent.status).toBe(503);
    expect(sent.pages).toBe(0);
    expect(sent.duringLegacy).toBeUndefined();
    expect(migrationPaths(gw)).toEqual([ORPHAN_PATH, OPEN_PATH]);
    expect(gw.memory?.tables.inflight ?? []).toEqual([]);
  });
});

describe('the remember-me login of a static-family request under v0002', () => {
  it('asks the bridge and forwards a missing file legacy renders inside a window over the login units', async () => {
    const gw = await start();

    const sent = await send(gw, MISSING_STATIC, REMEMBER_ME);

    expect(sent).toMatchObject({ status: 404, pages: 1 });
    expect(gw.legacy.staticCalls.map((call) => call.path)).toEqual([MISSING_STATIC]);
    expect(sent.windows).toEqual([{ routeKey: VENDOR_ROUTE, units: IDENTITY_LOGIN, scope: { table: true }, forwarded: true, legacyStatus: 404 }]);
    expect(sent.duringLegacy?.windows).toBe(1);
  });

  it('forwards a file legacy serves without CFML with no window', async () => {
    const gw = await start();
    gw.legacy.staticFiles.add('/core/vendor/jquery/jquery.min.js');

    const sent = await send(gw, '/core/vendor/jquery/jquery.min.js', REMEMBER_ME, 200);

    expect(sent).toMatchObject({ status: 200, pages: 1, windows: [] });
    expect(gw.legacy.staticCalls.map((call) => call.path)).toEqual(['/core/vendor/jquery/jquery.min.js']);
  });

  it('asks the bridge for the decoded path', async () => {
    const gw = await start();
    gw.legacy.staticFiles.add('/core/vendor/a b.js');

    const sent = await send(gw, '/core/vendor/a%20b.js', REMEMBER_ME, 200);

    expect(sent.windows).toEqual([]);
    expect(gw.legacy.staticCalls.map((call) => call.path)).toEqual(['/core/vendor/a b.js']);
  });

  it.each<[string, string]>([
    ['an encoded separator', '/core/vendor/a%2Fb.js'],
    ['an encoded backslash', '/core/vendor/a%5Cb.js'],
  ])('opens the window without asking the bridge for a path with %s', async (_label, url) => {
    const gw = await start();
    gw.legacy.staticFiles.add('/core/vendor/a/b.js');

    const sent = await send(gw, url, REMEMBER_ME);

    expect(gw.legacy.staticCalls).toEqual([]);
    expect(sent.windows).toEqual([expect.objectContaining({ routeKey: VENDOR_ROUTE, units: IDENTITY_LOGIN, forwarded: true })]);
  });

  it('opens the window when the bridge cannot answer', async () => {
    const gw = await start();
    gw.legacy.staticFiles.add(MISSING_STATIC);
    gw.legacy.failStatic(500);

    const sent = await send(gw, MISSING_STATIC, REMEMBER_ME);

    expect(sent.windows).toEqual([expect.objectContaining({ units: IDENTITY_LOGIN, forwarded: true })]);
  });

  it('asks nothing of the bridge without the remember-me cookies', async () => {
    const gw = await start();

    const sent = await send(gw, MISSING_STATIC);

    expect(sent.windows).toEqual([]);
    expect(gw.legacy.staticCalls).toEqual([]);
  });

  it('opens one window over the login and archive units when both probes reach their writes', async () => {
    const gw = await start({ migration: { orphanArchive: true } });

    const sent = await send(gw, MISSING_STATIC, REMEMBER_ME);

    expect(gw.migration.orphanProbes.map((probe) => [...probe.filenames].sort())).toEqual([
      ['404', 'core', 'core/vendor', 'core/vendor/missing.js', 'missing.js', 'vendor', 'vendor/missing.js'],
    ]);
    expect(sent.windows).toEqual([
      { routeKey: VENDOR_ROUTE, units: [ORPHAN_ARCHIVE, ...IDENTITY_LOGIN].sort(), scope: { table: true }, forwarded: true, legacyStatus: 404 },
    ]);
  });

  it("asks only after the browser's named session's target writes reached legacy", async () => {
    const gw = await start({ migration: { orphanArchive: true, await: { delayMs: 100 } } });
    const sessionId = 'static-session-1';
    gw.memory?.tables.session_barrier.push({ session_id: sessionId, owner: 'identity', xid: '42', pending: 0, recorded_at: new Date() });

    const sent = await send(gw, MISSING_STATIC, `JSESSIONID=${sessionId}`);

    expect(sent.status).toBe(404);
    const [awaited] = gw.migration.awaits;
    const [probe] = gw.migration.orphanProbes;
    if (awaited === undefined || probe === undefined) throw new TypeError('the barrier or the probe was not sent');
    expect(awaited.body).toMatchObject({ positions: { identity: '42' } });
    expect(probe.receivedAt - awaited.receivedAt).toBeGreaterThanOrEqual(90);
    expect(migrationPaths(gw).indexOf(ORPHAN_PATH)).toBeGreaterThan(migrationPaths(gw).indexOf('/internal/v1/projection/await'));
  });
});

describe('legacy-authoritative units under v0001', () => {
  it.each<[string, string, string | undefined]>([
    ['a 404 render', MISSING_PAGE, undefined],
    ['a file render', `/index.cfm/_api/render/file/?fileid=${FILE_ID}`, undefined],
    ['a missing static file with remember-me cookies', MISSING_STATIC, REMEMBER_ME],
  ])('asks no probe for %s, whose writes no window gates', async (_label, url, cookie) => {
    const gw = await start({ version: 'v0001', migration: { orphanArchive: true } });

    const sent = await send(gw, url, cookie);

    expect(sent).toMatchObject({ status: 404, pages: 1, windows: [] });
    expect(gw.migration.requests).toEqual([]);
    expect(gw.legacy.staticCalls).toEqual([]);
  });
});
