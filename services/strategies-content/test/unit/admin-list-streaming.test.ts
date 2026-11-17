/** The cchain, cfeed, carch drafts and cchangesets assignments lists over a throwaway `content` schema: HEAD's bytes, streamed from cursors and read per batch. */
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { DEFAULT_ROW_BATCH_SIZE } from '../../src/repo/repository.js';
import { buildTestApp, openContentGates, pgAvailable, userHeaders, withPgSchema, type ClientHandlers, type TestApp } from '../helpers/app.js';
import { roundTripCounter, type RoundTripCounter, type RoundTrips } from '../helpers/round-trips.js';

const SITE = TENANT_A.siteId;
const TENANT = TENANT_A.tenantId;
const SITE_TREE = '00000000000000000000000000000000000';
const COMPONENTS = '00000000000000000000000000000000003';
const FORMS = '00000000000000000000000000000000004';
const HOME = '00000000000000000000000000000000001';
const END = '00000000000000000000000000000000END';
/** A CF-format id whose first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
/** The SQL of `cfId(prefix, n)` over a `generate_series` row `n`. */
const idSql = (prefix: string): string => `'${prefix}' || lpad(n::text, 7, '0') || '-AAAA-BBBB-CCCCDDDDEEEEFFFF'`;
const ADMIN = cfId('U', 1);
const EDITOR = cfId('U', 2);
const GROUP = cfId('G', 1);
const CHANGESET = cfId('S', 1);
const BATCH = DEFAULT_ROW_BATCH_SIZE;

const CHAINS_URL = `/v1/sites/${SITE}/approval-chains`;
const FEEDS_URL = `/v1/sites/${SITE}/feeds`;
const DRAFTS_URL = `/v1/sites/${SITE}/content/drafts`;
const ASSIGNMENTS_URL = `/v1/sites/${SITE}/changesets/${CHANGESET}/assignments`;

const FETCH = /^FETCH FORWARD \d+ FROM content_rows_\d+$/;
const DECLARE = /^DECLARE content_rows_\d+ NO SCROLL CURSOR FOR /;
const CLOSE = /^CLOSE content_rows_\d+$/;
const JSON_TYPE = 'application/json; charset=utf-8';
/** The 503 legacy body of cChangesets.assignments refusing to print preview URLs. */
const SITE_SETTINGS_503 = '{"apiversion":"v1","method":"invalid","error":{"message":"Unhandled Exception","code":"server_error"}}';

/** Length and SHA-256 of the body HEAD's buffered route sent for each seed below; a drafts body with the rc.contentHistID minted per request blanked. */
const HEAD_BODIES: Readonly<Record<string, readonly [number, string]>> = {
  'chains-0': [40, 'e8b3562b3dba8d101e068959c2af5f6419611bfa4755ac8edfc961c7abbcd315'],
  'chains-1': [308, '7a37892eb1b049a8a671166fd38c45bf2384d0c236c56c32712cf8c728127e61'],
  'chains-2': [577, '4a68d1a8f46aa60cc0d39f22fa81e019920e66667d0f1ad31ed46e55ee201e47'],
  'chains-501': [134419, 'aafd30c289d3f4ec128fce49ba6c1d437ec90664aad990165c99f48c12ebc915'],
  'chains-1001': [268709, 'a2d3c5e515297979223533240fb6c9a1b2e1a7dcd50689b6308ce23730f2ae92'],
  'feeds-0-0': [35, '93a93bb036d26a5c88e572b85e2935320146998adf054cacbebdd6d536754cdb'],
  'feeds-1-1': [1807, 'ac0f5e91e704dc768a61edc9561606832f98a8d6531fb3d893022b507c46d889'],
  'feeds-2-1': [2693, 'b1ca96af564673dbc5a0e19022d3cad650273244766c13f00d93c17e2c65def5'],
  'feeds-1001-2': [889887, 'd10795093ddba6594e676cccb21b2f143c0ef03be31b6e058bc5dd7b8ba29a82'],
  'feeds-3-501': [447967, 'c15728b6bb8289bd5fb2c49f6641b171aa1487dae38ec4ab6cf29acdca7618fc'],
  'drafts-0': [840, 'a20e12cc79dc0917f7a230fa1c2c9934c718737af008c637954a6ac34d112cb2'],
  'drafts-s2-0': [840, '022991da18229bebcfa6303350da03b0e63d216b1c7bc1a0d5247372b018d241'],
  'drafts-1': [2651, 'a28ee8bd352818fe0b04572c01bf3df16c08391cbe48473b33c8c5174776f0e9'],
  'drafts-s2-1': [2651, 'd9a461f80df64f7e81523552b0ff2616f3516f7daf55bed25b30b231355734d3'],
  'drafts-2': [4463, '62687c87da88b718ab02f6df53d5aab61887a4867ec81a4d218646508446ff0e'],
  'drafts-s2-2': [4463, 'c68efbaa91c6647ee7a9d1b3ec5a2641a7b7d9e0af976234eda3b28cc06bc467'],
  'drafts-501': [911333, '81bba6ff91b47861d481915d6b62f398b2c5281b08c9a8bca731242002e2b89e'],
  'drafts-s2-501': [911333, 'fb1365c27ed5fe080bcec256e99dfd532bf9caa7dc3e19ac8ff588e2804017ba'],
  'drafts-1001': [1820339, '124469c8f804a5aed6ba743f6cf54dd393991eef0b72b49041e92a01926d0b3d'],
  'drafts-s2-1001': [1820339, 'f4f3dde732eac8bb12162dc757a013aeb57cfb27ddc4b2d5ce8e3dd652071c53'],
  'assignments-0-0': [494, 'e3d5ec1e98421755a08143c036e0624e9ef7aefaa1c10c98dd2bb0b7d02704d4'],
  'assignments-1-1': [3541, '93145bb7fc1308183b929db1ef9ff833cfa2d25e756d43d9c927113073e4c92f'],
  'assignments-2-1': [5078, 'a4217f041c6afab8abd6330af91781769ceb6cd4ee9e848e11e5beb549d66100'],
  'assignments-1001-2': [1543949, 'ae3c961784e3906d0a3a8ceaaca0b5cf279a1be23b013b74b1485f38a14bf6b1'],
  'assignments-3-501': [763509, '4def255cba762bd709fa5def31875176249bcb3a15d8a7d56195ec3c0ad2d18a'],
  'assignments-keywords': [2030, '2fa63ba39a84d0ce7909031f15298f86b4be362a9fa860df820f7ab3f7aacaa3'],
};

/** identity's admin session store, current session and CSRF token issue. */
const IDENTITY: ClientHandlers = {
  identity: {
    'GET /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
    'GET /v1/sessions/current': () => ({ status: 200, headers: {}, body: { user: { userID: EDITOR, fname: 'Edit', lname: 'Or' } } }),
    'POST /v1/csrf/tokens': (req) => ({
      status: 200,
      headers: {},
      body: { tokens: (req.json as { contexts: string[] }).contexts.map((context) => ({ context, csrf_token: `TOK-${context}`, csrf_token_expires: '260630235959000' })) },
    }),
  },
};

/** The S2 administrator, the Site Manager editor, or the editor's user with S2. */
type Who = 'admin' | 'editor' | 's2-editor';

/** One injected request: its status, headers and bytes, its round trips and the SQL its pool ran. */
interface Sent {
  status: number;
  headers: Record<string, unknown>;
  body: Buffer;
  trips: RoundTrips;
  sql: string[];
}

/** One request over a socket: its status, headers, the chunks the client read and whether the response ended whole. */
interface Received {
  status: number;
  headers: IncomingHttpHeaders;
  chunks: Buffer[];
  complete: boolean;
}

/** A FETCH held until `release`, which fails it when given an error. */
interface HeldFetch {
  reached: Promise<void>;
  release(failure?: Error): void;
}

const fetchesOf = (sent: Pick<Sent, 'sql'>): number => sent.sql.filter((sql) => FETCH.test(sql)).length;
const digestOf = (body: Buffer): [number, string] => [body.length, createHash('sha256').update(body).digest('hex')];
/** `body` with the first `contentHistID`, carch's per-request id, blanked. */
const blankHistId = (body: Buffer): Buffer => Buffer.from(body.toString('utf8').replace(/"contentHistID":"[^"]*"/, '"contentHistID":""'), 'utf8');

describe.skipIf(!(await pgAvailable()))('streamed admin lists', () => {
  let handle: ThrowawaySchema;
  let counter: RoundTripCounter;
  let t: TestApp<RoundTripCounter['db']>;
  let log: string[] | undefined;
  let hold: { at: number; last: number; seen: number; reach: () => void; gate: Promise<Error | undefined> } | undefined;

  const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT, fn);

  const headersOf = (who: Who): Promise<Record<string, string>> =>
    who === 'editor'
      ? userHeaders({ sub: EDITOR, site: SITE, roles: [Roles.systemUser, moduleRole(SITE_TREE)] })
      : userHeaders({ sub: who === 'admin' ? ADMIN : EDITOR, site: SITE, roles: [Roles.s2], s2: true });

  /** GET `url` as `who` through inject, counting its round trips and logging its SQL. */
  const send = async (url: string, who: Who): Promise<Sent> => {
    const headers = await headersOf(who);
    const sql: string[] = [];
    let res: Awaited<ReturnType<typeof t.app.inject>> | undefined;
    log = sql;
    try {
      const trips = await counter.measure(async () => {
        res = await t.app.inject({ method: 'GET', url, headers });
      });
      return { status: res?.statusCode ?? 0, headers: res?.headers ?? {}, body: res?.rawPayload ?? Buffer.alloc(0), trips, sql };
    } finally {
      log = undefined;
    }
  };

  /** GET `url` as `who` over a socket; `onChunk` sees the count read so far, and answering true drops the connection. */
  const receive = async (url: string, who: Who, onChunk: (count: number) => boolean = () => false): Promise<Received> => {
    const headers = await headersOf(who);
    const { port } = t.app.server.address() as AddressInfo;
    return new Promise<Received>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: url, headers: { ...headers, connection: 'close' }, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        const done = (): void => resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks, complete: res.complete });
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (onChunk(chunks.length)) {
            req.destroy();
            done();
          }
        });
        res.on('end', done);
        res.on('error', done);
        res.on('close', done);
      });
      req.on('error', reject);
      req.end();
    });
  };

  /** Holds the `at`-th FETCH the pool runs from now on and the `count - 1` after it; `reached` once the last of them is. */
  const holdFetch = (at: number, count = 1): HeldFetch => {
    let reach: () => void = () => undefined;
    let open: (failure: Error | undefined) => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const gate = new Promise<Error | undefined>((resolve) => {
      open = resolve;
    });
    hold = { at, last: at + count - 1, seen: 0, reach, gate };
    return { reached, release: (failure) => open(failure) };
  };

  /** Resolves once `ready` holds, polling every 20 ms. */
  const until = async (ready: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 300_000;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const poolIdle = (): boolean => handle.appPool.waitingCount === 0 && handle.appPool.idleCount === handle.appPool.totalCount;
  const serverConnections = (): Promise<number> =>
    new Promise((resolve, reject) => {
      t.app.server.getConnections((error, count) => (error === null ? resolve(count) : reject(error)));
    });

  /** Expects `sent` to be HEAD's 200 body of `key`, streamed as Fastify sends a returned model. */
  const expectHeadBody = (key: string, sent: Pick<Sent, 'status' | 'headers' | 'body'>, blank = false): void => {
    expect(sent.status).toBe(200);
    expect(sent.headers['content-type']).toBe(JSON_TYPE);
    expect(sent.headers['transfer-encoding']).toBe('chunked');
    expect(sent.headers['content-length']).toBeUndefined();
    expect(digestOf(blank ? blankHistId(sent.body) : sent.body)).toEqual(HEAD_BODIES[key]);
    const text = sent.body.toString('utf8');
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
  };

  /** Expects the costs of `sizes` to differ from `base`'s only by `perBatch` times their extra batches. */
  const expectPerBatch = (sent: ReadonlyMap<string, Sent>, base: string, batches: Readonly<Record<string, number>>, perBatch: RoundTrips): void => {
    const first = sent.get(base) as Sent;
    for (const [size, extra] of Object.entries(batches)) {
      const trips = (sent.get(size) as Sent).trips;
      expect([size, trips]).toEqual([size, { statements: first.trips.statements + extra * perBatch.statements, transactions: first.trips.transactions + extra * perBatch.transactions }]);
    }
  };

  const seedChains = (n: number) =>
    inA(async (tx) => {
      await tx.query(`DELETE FROM ${handle.schema}.approval_chain`);
      await tx.query(
        `INSERT INTO ${handle.schema}.approval_chain (tenant_id, siteid, chainid, name, description, created, lastupdate, lastupdateby, lastupdatebyid)` +
          ` SELECT $1, $2, ${idSql('C')}, CASE WHEN n % 7 = 0 THEN NULL WHEN n % 2 = 0 THEN 'chain ' || lpad(n::text, 4, '0') ELSE 'Chain ' || lpad(n::text, 4, '0') END,` +
          ` CASE WHEN n % 3 = 0 THEN NULL ELSE 'About ' || n END, timestamp '2026-06-30 10:15:42.123' + n * interval '1 second',` +
          ` timestamp '2026-07-01 08:00:00.5' + n * interval '1 minute', 'Admin ' || n, ${idSql('U')} FROM generate_series(1, $3::integer) AS n`,
        [TENANT, SITE, n],
      );
      await tx.query(`INSERT INTO ${handle.schema}.approval_chain (tenant_id, siteid, chainid, name) VALUES ($1, 'other-site', $2, 'Elsewhere')`, [TENANT, cfId('X', 1)]);
    });

  const seedFeeds = (local: number, remote: number) =>
    inA(async (tx) => {
      await tx.query(`DELETE FROM ${handle.schema}.feed`);
      for (const [type, count, prefix] of [['Local', local, 'L'], ['remote', remote, 'R'], ['Other', 2, 'O']] as const) {
        await tx.query(
          `INSERT INTO ${handle.schema}.feed (tenant_id, feedid, siteid, name, type, isactive, ispublic, lastupdate, datecreated, maxitems, description, channellink)` +
            ` SELECT $1, ${idSql(prefix)}, $2, CASE WHEN n % 5 = 0 THEN NULL ELSE $3 || ' feed ' || lpad(n::text, 4, '0') END, $3, n % 2, 1 - n % 2,` +
            ` timestamp '2026-06-30 10:15:42.123' + n * interval '1 second', timestamp '2026-06-01 09:00:00', n, 'Feed "' || n || '"', NULL FROM generate_series(1, $4::integer) AS n`,
          [TENANT, SITE, type, count],
        );
      }
    });

  const contentInsert = (select: string) =>
    `INSERT INTO ${handle.schema}.content (tenant_id, siteid, moduleid, parentid, contentid, contenthistid, type, subtype, active, approved, title, menutitle,` +
    ` lastupdate, lastupdateby, lastupdatebyid, path, changesetid, display, isnav, inheritobjects) ${select}`;

  /** The site tree, Home, Components and Forms, with no other content or approval request. */
  const seedTree = () =>
    inA(async (tx) => {
      await tx.query(`DELETE FROM ${handle.schema}.content`);
      await tx.query(`DELETE FROM ${handle.schema}.approval_request`);
      await tx.query(
        contentInsert(
          `VALUES ($1::uuid, $2::text, $3::text, $4::text, $3::text, 'H0000000-0000-AAAA-BBBBCCCCDDDDEEEE', 'Module', 'Default', 1, 1, 'Site Manager', 'Site Manager', timestamp '2026-06-01 09:00', 'System', NULL, $3::text, NULL, 1, 1, 'Cascade'),` +
            ` ($1::uuid, $2::text, $3::text, $5::text, $6::text, 'H0000001-0000-AAAA-BBBBCCCCDDDDEEEE', 'Page', 'Default', 1, 1, 'Home', 'Home', timestamp '2026-06-01 09:00', 'System', NULL, $6::text, NULL, 1, 1, 'Cascade'),` +
            ` ($1::uuid, $2::text, $7::text, $5::text, $7::text, 'H0000003-0000-AAAA-BBBBCCCCDDDDEEEE', 'Module', 'Default', 1, 1, 'Components', 'Components', timestamp '2026-06-01 09:00', 'System', NULL, $7::text, NULL, 1, 1, 'Cascade'),` +
            ` ($1::uuid, $2::text, $8::text, $5::text, $8::text, 'H0000004-0000-AAAA-BBBBCCCCDDDDEEEE', 'Module', 'Default', 1, 1, 'Forms', 'Forms', timestamp '2026-06-01 09:00', 'System', NULL, $8::text, NULL, 1, 1, 'Cascade')`,
        ),
        [TENANT, SITE, SITE_TREE, END, END, HOME, COMPONENTS, FORMS],
      );
    });

  /** `n` drafts of the editor under Home, replacing every unapproved version. */
  const seedDrafts = (n: number) =>
    inA(async (tx) => {
      await tx.query(`DELETE FROM ${handle.schema}.content WHERE approved = 0`);
      await tx.query(
        contentInsert(
          `SELECT $1, $2, $3, $4, ${idSql('D')}, ${idSql('E')}, 'Page', CASE WHEN n % 2 = 0 THEN 'Landing' ELSE 'Default' END, 1, 0, 'Draft ' || n, 'Draft ' || n,` +
            ` timestamp '2026-06-29 15:30:00.25' + n * interval '1 minute', 'Edit Or', $5, NULL, NULL, 1, 1, 'Cascade' FROM generate_series(1, $6::integer) AS n`,
        ),
        [TENANT, SITE, SITE_TREE, HOME, EDITOR, n],
      );
    });

  /** The change set, `published` or not, with `component`, `form` and `site` assigned versions. */
  const seedAssignments = (component: number, form: number, site: number, published: number) =>
    inA(async (tx) => {
      await tx.query(`DELETE FROM ${handle.schema}.content WHERE changesetid IS NOT NULL`);
      await tx.query(`DELETE FROM ${handle.schema}.changeset`);
      await tx.query(
        `INSERT INTO ${handle.schema}.changeset (tenant_id, changesetid, siteid, name, description, created, publishdate, published, lastupdate, lastupdateby)` +
          ` VALUES ($1, $2, $3, 'Launch', 'The launch', timestamp '2026-06-01 09:00', timestamp '2026-06-02 09:00', $4, timestamp '2026-06-03 09:00:00.5', 'Admin')`,
        [TENANT, CHANGESET, SITE, published],
      );
      for (const [module, count, prefix, type] of [[COMPONENTS, component, 'K', 'Component'], [FORMS, form, 'F', 'Form'], [SITE_TREE, site, 'P', 'Page']] as const) {
        await tx.query(
          contentInsert(
            `SELECT $1::uuid, $2::text, $3::text, $3::text, ${idSql(prefix)}, ${idSql(prefix === 'K' ? 'Q' : prefix === 'F' ? 'W' : 'Y')}, $4::text, 'Default', 0, 0, $4::text || ' ' || n,` +
              ` CASE WHEN n % 4 = 0 THEN lower($4::text) ELSE $4::text END || ' ' || lpad(n::text, 4, '0'),` +
              ` timestamp '2026-06-29 15:30:00.25' + n * interval '1 minute', 'Admin', $5::text, $3::text || ',' || ${idSql(prefix)}, $6::text, 1, 1, 'Cascade' FROM generate_series(1, $7::integer) AS n`,
          ),
          [TENANT, SITE, module, type, ADMIN, CHANGESET, count],
        );
      }
    });

  beforeAll(async () => {
    handle = await withPgSchema();
    await openContentGates(handle);
    await seedRegistry(handle.app, handle.schema);
    counter = roundTripCounter(handle);
    const wrapped = new WeakSet<object>();
    handle.appPool.on('acquire', (client) => {
      if (wrapped.has(client)) return;
      wrapped.add(client);
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      Object.defineProperty(client, 'query', {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          const first = args[0];
          const sql = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
          log?.push(sql);
          const held = hold;
          if (held !== undefined && FETCH.test(sql) && (held.seen += 1) >= held.at) {
            if (held.seen === held.last) {
              hold = undefined;
              held.reach();
            }
            return held.gate.then((failure) => (failure === undefined ? query(...args) : Promise.reject(failure)));
          }
          return query(...args);
        },
      });
    });
    t = await buildTestApp({ db: counter.db, env: { LOG_LEVEL: 'fatal' }, clientHandlers: IDENTITY });
    await inA(async (tx) => {
      await tx.query(`INSERT INTO ${handle.schema}.group_projection (tenant_id, group_id, site_id, group_name, is_public, deleted) VALUES ($1, $2, $3, 'Editors', 0, false)`, [TENANT, GROUP, SITE]);
      await tx.query(`INSERT INTO ${handle.schema}.membership_projection (tenant_id, user_id, site_id, group_id) VALUES ($1, $2, $3, $4)`, [TENANT, EDITOR, SITE, GROUP]);
      await tx.query(`INSERT INTO ${handle.schema}.permission_projection (tenant_id, group_id, site_id, content_id, type) VALUES ($1, $2, $3, $4, 'Editor')`, [TENANT, GROUP, SITE, HOME]);
    });
    await seedTree();
  });

  afterAll(async () => {
    await t?.close();
    await handle?.drop();
  });

  describe('bytes and round trips', () => {
    it('cchain list prints HEAD bytes with one FETCH per 500 chains and nothing more per row', async () => {
      const sent = new Map<string, Sent>();
      for (const n of [0, 1, 2, 501, 1001]) {
        await seedChains(n);
        const res = await send(CHAINS_URL, 'admin');
        expectHeadBody(`chains-${n}`, res);
        expect(fetchesOf(res)).toBe(Math.floor(n / BATCH) + 1);
        sent.set(String(n), res);
      }
      expectPerBatch(sent, '1', { '0': 0, '2': 0, '501': 1, '1001': 2 }, { statements: 1, transactions: 0 });
    });

    it('cfeed list prints HEAD bytes from both lists in one transaction, one FETCH per 500 collections', async () => {
      const sent = new Map<string, Sent>();
      for (const [local, remote] of [[0, 0], [1, 1], [2, 1], [1001, 2], [3, 501]] as const) {
        await seedFeeds(local, remote);
        const res = await send(FEEDS_URL, 'admin');
        expectHeadBody(`feeds-${local}-${remote}`, res);
        expect(fetchesOf(res)).toBe(Math.floor(local / BATCH) + Math.floor(remote / BATCH) + 2);
        expect(res.sql.filter((sql) => DECLARE.test(sql))).toHaveLength(2);
        sent.set(`${local}-${remote}`, res);
      }
      expectPerBatch(sent, '1-1', { '0-0': 0, '2-1': 0, '1001-2': 2, '3-501': 1 }, { statements: 1, transactions: 0 });
    });

    it.each([
      ['the Site Manager editor', 'editor', DRAFTS_URL, 'drafts'],
      ['an S2 user given rc.rsList', 's2-editor', `${DRAFTS_URL}?rsList=early&siteid=${SITE}`, 'drafts-s2'],
    ] as Array<[string, Who, string, string]>)('carch drafts prints HEAD bytes for %s, its crumbs and verdicts read once per batch', async (_who, who, url, key) => {
      await inA(async (tx) => {
        await tx.query(`DELETE FROM ${handle.schema}.content WHERE changesetid IS NOT NULL`);
        await tx.query(`DELETE FROM ${handle.schema}.changeset`);
      });
      const sent = new Map<string, Sent>();
      for (const n of [0, 1, 2, 501, 1001]) {
        await seedDrafts(n);
        const res = await send(url, who);
        expectHeadBody(`${key}-${n}`, res, true);
        expect(fetchesOf(res)).toBe(Math.floor(n / BATCH) + 1);
        sent.set(String(n), res);
      }
      const at = (n: string): RoundTrips => (sent.get(n) as Sent).trips;
      const perBatch = { statements: at('501').statements - at('1').statements, transactions: at('501').transactions - at('1').transactions };
      expectPerBatch(sent, '1', { '2': 0, '501': 1, '1001': 2 }, perBatch);
      // Memberships and icons are read before the cursor; a batch opens no transaction, and only the first fences the crumb reads' units.
      expect([perBatch.transactions, at('1').transactions - at('0').transactions]).toEqual([0, 0]);
      expect(perBatch.statements).toBeLessThan(at('1').statements - at('0').statements);
      expect(perBatch.statements).toBeGreaterThan(1);
    });

    it('cchangesets assignments prints HEAD bytes, each module list read from a cursor with its crumbs and verdicts once per batch', async () => {
      await seedDrafts(0);
      const sent = new Map<string, Sent>();
      for (const [component, form] of [[0, 0], [1, 1], [2, 1], [1001, 2], [3, 501]] as const) {
        await seedAssignments(component, form, 0, 1);
        const res = await send(ASSIGNMENTS_URL, 'admin');
        expectHeadBody(`assignments-${component}-${form}`, res);
        // The site list's one-row probe, then the component and form lists.
        expect(fetchesOf(res)).toBe(1 + Math.floor(component / BATCH) + Math.floor(form / BATCH) + 2);
        sent.set(`${component}-${form}`, res);
      }
      const at = (n: string): RoundTrips => (sent.get(n) as Sent).trips;
      const perBatch = { statements: at('3-501').statements - at('1-1').statements, transactions: at('3-501').transactions - at('1-1').transactions };
      expectPerBatch(sent, '1-1', { '2-1': 0, '3-501': 1, '1001-2': 2 }, perBatch);
      // The viewer's memberships are read before the cursor, and a batch's reads run on the cursor's transaction.
      expect([perBatch.transactions, at('1-1').transactions - at('0-0').transactions]).toEqual([0, 0]);
      expect(perBatch.statements).toBeGreaterThan(1);
      await seedAssignments(2, 1, 0, 1);
      expectHeadBody('assignments-keywords', await send(`${ASSIGNMENTS_URL}?keywords=component%200001`, 'admin'));
    });

    it.each([
      ['a site architecture row', 1, 1, ASSIGNMENTS_URL],
      ['an unpublished change set', 0, 0, ASSIGNMENTS_URL],
      ['a missing change set', 0, 1, `/v1/sites/${SITE}/changesets/${cfId('S', 9)}/assignments`],
    ] as Array<[string, number, number, string]>)('cchangesets assignments answers HEAD 503 for %s before reading a module list', async (_case, site, published, url) => {
      await seedAssignments(2, 1, site, published);
      const res = await send(url, 'admin');
      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
      expect(res.headers['content-length']).toBe(String(SITE_SETTINGS_503.length));
      expect(res.body.toString('utf8')).toBe(SITE_SETTINGS_503);
      expect(res.sql.filter((sql) => DECLARE.test(sql))).toHaveLength(1);
      expect(res.sql.filter((sql) => FETCH.test(sql))).toEqual([expect.stringMatching(/^FETCH FORWARD 1 FROM /)]);
    });
  });

  describe('over a socket', () => {
    const LISTS = [
      ['cchain list', CHAINS_URL, 'admin', 2],
      ['cfeed list', FEEDS_URL, 'admin', 2],
      ['carch drafts', DRAFTS_URL, 'editor', 2],
      // The site list's probe and the first component batch come before the held FETCH.
      ['cchangesets assignments', ASSIGNMENTS_URL, 'admin', 3],
    ] as Array<[string, string, Who, number]>;

    beforeAll(async () => {
      await seedChains(1001);
      await seedFeeds(1001, 2);
      await seedDrafts(1001);
      await seedAssignments(1001, 2, 0, 1);
      await t.app.listen({ host: '127.0.0.1', port: 0 });
    });

    it.each(LISTS)('%s reaches the client in more than one chunk with the bytes inject reads', async (_list, url, who, at) => {
      const whole = await send(url, who);
      await until(poolIdle, 'the pool to go idle');
      const held = holdFetch(at);
      let inUse = -1;
      void held.reached.then(() => {
        inUse = handle.appPool.totalCount - handle.appPool.idleCount;
      });
      const got = await receive(url, who, (count) => {
        if (count === 1) held.release();
        return false;
      });
      expect(got.status).toBe(200);
      expect(got.complete).toBe(true);
      expect(got.headers['content-type']).toBe(JSON_TYPE);
      expect(got.headers['transfer-encoding']).toBe('chunked');
      expect(got.chunks.length).toBeGreaterThan(1);
      expect(blankHistId(Buffer.concat(got.chunks)).equals(blankHistId(whole.body))).toBe(true);
      // The cursor's transaction is the one connection the list holds between batches.
      expect(inUse).toBe(1);
      await until(poolIdle, 'the pool to go idle');
    });

    it.each(LISTS)('%s closes its cursor and ends its transaction when the client goes mid-stream', async (_list, url, who, at) => {
      const held = holdFetch(at);
      const sql: string[] = [];
      log = sql;
      try {
        const got = await receive(url, who, () => true);
        await held.reached;
        expect(got.complete).toBe(false);
        await until(async () => (await serverConnections()) === 0, 'the server to drop the connection');
        held.release();
        await until(poolIdle, 'the pool to go idle');
      } finally {
        log = undefined;
      }
      expect(sql.filter((statement) => FETCH.test(statement))).toHaveLength(at);
      expect(sql.slice(-2)).toEqual([expect.stringMatching(CLOSE), 'COMMIT']);
    });

    it('cchain list destroys the body when a later FETCH fails, rolling the cursor back', async () => {
      const held = holdFetch(2);
      const sql: string[] = [];
      log = sql;
      const got = await receive(CHAINS_URL, 'admin', (count) => {
        if (count === 1) held.release(new Error('the FETCH failed'));
        return false;
      }).finally(() => until(poolIdle, 'the pool to go idle').finally(() => (log = undefined)));
      expect(got.status).toBe(200);
      expect(got.chunks.length).toBeGreaterThan(0);
      expect(got.complete).toBe(false);
      expect(sql.at(-1)).toBe('ROLLBACK');
      expect(sql.filter((statement) => CLOSE.test(statement))).toHaveLength(0);
    });

    it("cchain list answers a failure before its first batch with the error handler's whole response", async () => {
      const held = holdFetch(1);
      held.release(new Error('the FETCH failed'));
      const res = await send(CHAINS_URL, 'admin');
      expect(res.status).toBe(500);
      expect(res.headers['transfer-encoding']).toBeUndefined();
      expect(res.headers['content-length']).toBe(String(res.body.length));
      expect(() => JSON.parse(res.body.toString('utf8')) as unknown).not.toThrow();
      expect(res.sql.at(-1)).toBe('ROLLBACK');
      await until(poolIdle, 'the pool to go idle');
    });
  });

  describe('as many concurrent requests as the pool has connections', () => {
    const CONCURRENT = [
      ['cchain list', CHAINS_URL, 'admin', 'chains-501', false, () => seedChains(501)],
      ['cfeed list', FEEDS_URL, 'admin', 'feeds-3-501', false, () => seedFeeds(3, 501)],
      [
        'carch drafts',
        DRAFTS_URL,
        'editor',
        'drafts-501',
        true,
        async () => {
          await inA(async (tx) => {
            await tx.query(`DELETE FROM ${handle.schema}.content WHERE changesetid IS NOT NULL`);
            await tx.query(`DELETE FROM ${handle.schema}.changeset`);
          });
          await seedDrafts(501);
        },
      ],
      [
        'cchangesets assignments',
        ASSIGNMENTS_URL,
        'admin',
        'assignments-3-501',
        false,
        async () => {
          await seedDrafts(0);
          await seedAssignments(3, 501, 0, 1);
        },
      ],
    ] as Array<[string, string, Who, string, boolean, () => Promise<void>]>;

    it.each(CONCURRENT)('%s holds every cursor at its first FETCH, then each request ends with HEAD bytes and no client waits', async (_list, url, who, key, blank, seed) => {
      await seed();
      await until(poolIdle, 'the pool to go idle');
      const pool = handle.appPool;
      const size = pool.options.max ?? 0;
      expect(size).toBeGreaterThan(1);
      // Every connection opened first, so no checkout below waits on a new socket.
      const warm = await Promise.all(Array.from({ length: size }, () => pool.connect()));
      for (const client of warm) client.release();
      const headers = await headersOf(who);
      const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
      const timeout = pool.options.connectionTimeoutMillis;
      let waited = 0;
      // A checkout behind a full pool is a request asking for a second connection; the timeout fails it instead of hanging.
      pool.options.connectionTimeoutMillis = 30_000;
      Object.defineProperty(pool, 'connect', {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          if (pool.idleCount === 0 && pool.totalCount >= size) waited += 1;
          return connect(...args);
        },
      });
      const held = holdFetch(1, size);
      let reached = false;
      void held.reached.then(() => {
        reached = true;
      });
      const replies = Array.from({ length: size }, () => t.app.inject({ method: 'GET', url, headers }));
      try {
        await until(() => reached, 'every request to hold its first FETCH');
        expect([pool.totalCount, pool.idleCount, pool.waitingCount]).toEqual([size, 0, 0]);
        held.release();
        for (const res of await Promise.all(replies)) {
          expectHeadBody(key, { status: res.statusCode, headers: res.headers, body: res.rawPayload }, blank);
        }
        expect([waited, pool.waitingCount]).toEqual([0, 0]);
      } finally {
        hold = undefined;
        held.release();
        await Promise.allSettled(replies);
        Reflect.deleteProperty(pool, 'connect');
        pool.options.connectionTimeoutMillis = timeout;
      }
      await until(poolIdle, 'the pool to go idle');
    });
  });
});
