/** The favorites templates through `app.inject` over a throwaway `people` schema and a strategies-content double. */
import { readFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { LEGACY_ERROR_PAGE_HTML, cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, registerWritePositionHeader, withGatedTenant } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  FAVORITE_REMOVED,
  FavoriteTemplateError,
  deleteFavorite,
  deleteRssFavorites,
  favoriteSavedBody,
  saveFavorite,
  storedInteger,
  urlFieldsOf,
  windows1252Text,
  type FavoriteDeps,
} from '../../src/domain/favorites.js';
import type { PersonFence } from '../../src/domain/person-fence.js';
import { personFence } from '../../src/domain/roster-protocol.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { PEOPLE_UNITS, type FavoriteRow } from '../../src/repo/tables.js';
import {
  FAVORITES_PATH,
  containerRefuses,
  favoritesSurfaceOf,
  favoritesTargetRefused,
  favoritesTemplateMissing,
  registerFavoriteRoutes,
} from '../../src/routes/favorites.js';
import { createIdentityDouble } from '../helpers/identity-double.js';
import { silentLogger } from '../helpers/route-app.js';
import { DEFAULT_PEOPLE_SEED, POOLED_MEMBER_PERSON, SYSTEM_USER_A_PERSON, favoriteRow, seedPeople } from '../helpers/fixtures.js';

const OPENAPI = parse(readFileSync(fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)), 'utf8')) as object;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const SERVICE = 'people';
/** The methods whose answer carries the template's body; HEAD answers their headers alone. */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const;
type Method = (typeof METHODS)[number] | 'HEAD';
/** 12:00:00.001 local, which SQL Server's datetime stores as 12:00:00.000. */
const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0, 1));
const STORED_AT = new Date(2026, 5, 30, 12, 0, 0, 0);
const HTML = 'text/html;charset=UTF-8';
const HOME = '00000000000000000000000000000000001';
const SYSTEM_USER = SYSTEM_USER_A_PERSON.userid;
const POOLED_MEMBER = POOLED_MEMBER_PERSON.userid;
const GROUP_ID = String(DEFAULT_PEOPLE_SEED[TENANT_UMBRELLA.tenantId]?.groupNames?.[0]?.group_id);
const SAVED = /^\{"lid":"([0-9A-F]{32})","favoriteid":"([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16})","link":"(.*)"\}$/;
const A = TENANT_A.tenantId;
const UMBRELLA = TENANT_UMBRELLA.tenantId;
/** The id of a group's favorite, which identity holds. */
const GROUP_FAVORITE = 'AB5C0E11-0B6A-4D2C-9F0E1D2C3B4A5968';

/** A query string of `fields`, each name and value percent-encoded. */
function query(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}

/** The url fields of a save of the home page by the tenant-a system user, with `overrides` applied and `undefined` fields left out. */
function saveFields(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    userID: SYSTEM_USER,
    siteid: TENANT_A.siteId,
    favoriteName: 'Home',
    favoriteLocation: HOME,
    favoriteType: 'Page',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The JavaScript-escaped `link` of a saved favorite, as `JSStringFormat` writes it. */
function escapedLink(favoriteId: string, href: string, name: string): string {
  const lid = favoriteId.replace(/-/g, '');
  const link = `<a href="" onClick="return deleteFavorite('${favoriteId}', 'favorite${lid}');" title="remove from favorites" class="remove"></a> <a href='${href}'>${name}</a>`;
  return link.replace(/[\\"']/g, (ch) => `\\${ch}`);
}

/** Status, reason phrase, content type and body of an answer, to compare with `UNAVAILABLE_PAGE`. */
function answerOf(res: { statusCode: number; statusMessage: string; headers: Record<string, unknown>; body: string }): unknown[] {
  return [res.statusCode, res.statusMessage, res.headers['content-type'], res.body];
}

/** The legacy-shaped 503 of a template route: the ColdFusion error page with its reason phrase. */
const UNAVAILABLE_PAGE = [503, 'An Error Occurred', HTML, LEGACY_ERROR_PAGE_HTML];

describe('urlFieldsOf', () => {
  it.each([
    ['/x.cfm', {}],
    ['/x.cfm?userID=A&SITEID=b', { userid: 'A', siteid: 'b' }],
    ['/x.cfm?favoriteName=a&FAVORITENAME=b&favoriteName=c', { favoritename: 'a,b,c' }],
    ['/x.cfm?favoriteName=a+b%20c&flag&=x&&n=1%002', { favoritename: 'a b c', flag: '', n: '12' }],
    ['/x.cfm?name=%E2%9C%93&odd=%C3%A9x%E9', { name: '\u2713', odd: "\u00e9x'" }],
    ['/x.cfm?favoriteName=%20%3Cscript%3Ex%3C%2Fscript%3Ey%20&amp;userID=A%20', { favoritename: '[INVALID]y', userid: 'A' }],
  ])('reads %s as ColdFusion fills the url scope and the scriptProtect scan leaves it', (target, expected) => {
    expect(Object.fromEntries(urlFieldsOf(target))).toEqual(expected);
  });

  it('fails the template where the scan cannot read a JSON null', () => {
    expect(() => urlFieldsOf('/x.cfm?favoriteName=null')).toThrow(FavoriteTemplateError);
  });
});

describe('containerRefuses', () => {
  it.each([
    ['a control character', 'a\u0001b'],
    ['a tab', 'a\tb'],
    ['a space', 'a b'],
    ['DEL', 'a\u007fb'],
    ['a Latin-1 byte', 'a\u00e9b'],
    ['UTF-8 bytes', 'a\u00c3\u00a9b'],
    ['"', 'a"b'],
    ['#', 'a#b'],
    ['<', 'a<b'],
    ['>', 'a>b'],
    ['\\', 'a\\b'],
    ['^', 'a^b'],
    ['`', 'a`b'],
    ['{', 'a{b'],
    ['|', 'a|b'],
    ['}', 'a}b'],
    ['a lone %', 'a%b'],
  ])('counts %s in a query value as a target the container refuses', (_case, value) => {
    expect(containerRefuses(`${FAVORITES_PATH}/deleteFavorite.cfm?favoriteID=${value}`)).toBe(true);
  });

  it.each(['[', ']', "'", '?', '!$&()*+,;=:@~/', '%41', '%e9'])('counts %s in a query value as a target the container accepts', (chars) => {
    expect(containerRefuses(`${FAVORITES_PATH}/deleteFavorite.cfm?favoriteID=a${chars}b`)).toBe(false);
  });
});

describe('storedInteger', () => {
  it.each(['', 'abc', '1d', '1f', '0x10', ' ', '1,000', '$5', 'Infinity', 'NaN', '\u20037', '\u00a07', '1e309'])('stores 0 for the non-numeric %j', (raw) => {
    expect(storedInteger(raw)).toBe(0);
  });

  it.each([
    ['7', 7],
    [' 7', 7],
    ['7\t', 7],
    ['7\u0001', 7],
    ['+5', 5],
    ['5.', 5],
    ['00012', 12],
    ['1.5', 1],
    ['-1.5', -1],
    ['.5', 0],
    ['-0.5', 0],
    ['2147483647.9', 2147483647],
    ['-2147483648.9', -2147483648],
    ['1e3', 1000],
    ['1.5e1', 15],
    ['1e+3', 1000],
    ['1.e3', 1000],
    ['1e-3', 0],
    ['1e-400', 0],
    ['2.1e9', 2100000000],
    [`${'0'.repeat(40)}1`, 1],
  ])('converts %j as SQL Server converts the inlined literal to %i', (raw, stored) => {
    expect(storedInteger(raw)).toBe(stored);
  });

  it.each(['2147483648', '2147483648.0', '-2147483649', '1e10', '9999999999', '2.2e9', '1e308', '1'.repeat(39), `1.${'0'.repeat(39)}1`])(
    'fails the template for %j, beyond int or numeric precision',
    (raw) => {
      expect(() => storedInteger(raw)).toThrow(FavoriteTemplateError);
    },
  );
});

describe('windows1252Text', () => {
  it('keeps every character Windows-1252 encodes and writes ? for the five bytes it leaves undefined', () => {
    const decoded = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, byte) => byte));
    const units = Array.from({ length: 256 }, (_, byte) => decoded.charAt(byte));
    const undefinedBytes = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
    expect(windows1252Text(units.join(''))).toBe(units.map((unit, byte) => (undefinedBytes.has(byte) ? '?' : unit)).join(''));
  });
});

describe('favoriteSavedBody', () => {
  it('writes lid, favoriteid and link in order, the link JavaScript-escaped and its title XML-formatted', () => {
    const body = favoriteSavedBody('FDB7586B-DF4A-D87B-4B1C071AFB7A9FD9', '/about/', 'Feed "One"\\', `Tom & 'Jerry' <\u00e9>\r`);
    expect(body).toBe(
      '{"lid":"FDB7586BDF4AD87B4B1C071AFB7A9FD9","favoriteid":"FDB7586B-DF4A-D87B-4B1C071AFB7A9FD9","link":"<a href=\\"\\" onClick=\\"return ' +
        "deleteFavorite(\\'FDB7586B-DF4A-D87B-4B1C071AFB7A9FD9\\', \\'favoriteFDB7586BDF4AD87B4B1C071AFB7A9FD9\\');\\\" title=\\\"Tom &amp; &apos;Jerry&apos; " +
        "&lt;&#xe9;&gt;\\\" class=\\\"remove\\\"></a> <a href=\\'/about/\\'>Feed \\\"One\\\"\\\\</a>\"}",
    );
  });

  it.each([
    ['all digits', '12345678-9012-3456-7890123456789012', '12345678901234567890123456789012'],
    ['digits, E and digits', '12345678-9012-3456-789012345678E123', '1234567890123456789012345678E123'],
  ])('writes a lid of %s unquoted, as json.cfc writes a number', (_case, favoriteId, lid) => {
    expect(favoriteSavedBody(favoriteId, '/', 'Home', 'remove from favorites')).toMatch(new RegExp(`^\\{"lid":${lid},"favoriteid":"${favoriteId}",`));
  });
});

describe.skipIf(!(await pgAvailable()))('favorites templates against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let repo: PeopleRepository;
  let app: FastifyInstance;
  const linkCalls: Array<{ siteId: string; contentIds: readonly string[] }> = [];
  let contentDown = false;
  let repoFault: Error | undefined;
  // Identity as its contract declares it, holding the group favorite `GROUP_FAVORITE`.
  const identityDouble = createIdentityDouble({ clock: CLOCK });
  const identity = identityDouble.identityClient;
  /** Each identity call people made: its operation, body and forwarded user token. */
  const groupLookups = (): unknown[] => identityDouble.requests.map((call) => [call.operationId, call.body, call.userToken]);
  const content: FavoriteDeps['content'] = {
    contentLinks: (siteId, contentIds) => {
      linkCalls.push({ siteId, contentIds });
      if (contentDown) return Promise.reject(new ServiceUnavailableError('strategies-content', new Error('connect ECONNREFUSED')));
      return Promise.resolve(new Map(contentIds.map((id) => [id, id.toUpperCase() === HOME ? '/' : `/${id.toLowerCase()}/`])));
    },
  };

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE, migrationsDir: MIGRATIONS_DIR });
    db = handle.app;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'favorites-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'favorites-test', state: 'open' });
    await seedRegistry(db);
    await seedPeople(db, DEFAULT_PEOPLE_SEED, { clock: CLOCK });
    repo = createPeopleRepository({ clock: CLOCK, schema: handle.schema });
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8112',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: process.env.TZ ?? 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      clock: CLOCK,
      pool: db,
      logger: silentLogger(),
      surfaceOf: favoritesSurfaceOf,
      containerRefusesTarget: favoritesTargetRefused,
      skipsStartupScan: favoritesTemplateMissing,
    });
    registerWritePositionHeader(app);
    // The person read fails with `repoFault` when one is set, as an unexpected storage failure would.
    const routeRepo: PeopleRepository = {
      ...repo,
      findPerson: (tx, userId) => (repoFault === undefined ? repo.findPerson(tx, userId) : Promise.reject(repoFault)),
    };
    registerFavoriteRoutes(app, { db, repo: routeRepo, clock: CLOCK, fence: personFence, content, identity });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await handle.drop();
  });

  beforeEach(() => {
    linkCalls.length = 0;
    contentDown = false;
    repoFault = undefined;
    identityDouble.clear();
    identityDouble.seedGroupFavorites(GROUP_FAVORITE);
  });

  /** Sends one template request as the gateway forwards an anonymous caller and checks the answer against the contract. */
  async function send(method: Method, template: string, fields: Record<string, string> | string) {
    const url = `${FAVORITES_PATH}/${template}?${typeof fields === 'string' ? fields : query(fields)}`;
    const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` };
    const res = await app.inject({ method, url, headers });
    const contentType = res.headers['content-type'];
    const json = typeof contentType === 'string' && contentType.startsWith('application/json');
    const body: unknown = json ? JSON.parse(res.body) : res.body;
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType, body });
    return res;
  }

  /** Every stored favorite of `tenantId` named `name`. */
  function favoritesNamed(tenantId: string, name: string): Promise<FavoriteRow[]> {
    return withTenant(db, tenantId, async (tx) => (await tx.query<FavoriteRow>(`SELECT * FROM ${handle.schema}.user_favorite WHERE favoritename = $1`, [name])).rows);
  }

  /** Every stored favorite of `tenantId` with id `favoriteId`. */
  function favoritesWithId(tenantId: string, favoriteId: string): Promise<FavoriteRow[]> {
    return withTenant(db, tenantId, (tx) => repo.lockFavorites(tx, favoriteId));
  }

  /** The number of favorites people stores across the fixture tenants. */
  async function favoriteCount(): Promise<number> {
    let count = 0;
    for (const tenantId of [A, TENANT_B.tenantId, UMBRELLA]) {
      count += await withTenant(db, tenantId, async (tx) => (await tx.query(`SELECT 1 FROM ${handle.schema}.user_favorite`)).rows.length);
    }
    return count;
  }

  /** Stores `row` in its tenant as a migrated favorite. */
  async function storeFavorite(row: FavoriteRow): Promise<FavoriteRow> {
    const { tenant_id: tenantId, ...input } = row;
    await withGatedTenant(db, tenantId, (tx) => repo.insertFavorite(tx, input));
    return row;
  }

  describe('saveFavorite.cfm', () => {
    it.each(METHODS)('%s saves the favorite in the site tenant and answers its id and link as mura.json text', async (method) => {
      const name = `Home ${method}`;
      const res = await send(method, 'saveFavorite.cfm', saveFields({ favoriteName: name, columnNumber: '2', rowNumber: '3', maxRssItems: '4' }));
      expect([res.statusCode, res.headers['content-type'], res.headers['x-opt2-write-position']]).toEqual([200, HTML, expect.any(String)]);
      const [, lid, favoriteId] = SAVED.exec(res.body) ?? [];
      expect(lid).toBe(favoriteId?.replace(/-/g, ''));
      expect(res.body).toBe(favoriteSavedBody(String(favoriteId), '/', name, 'remove from favorites'));
      expect(res.body).toContain(`"link":"${escapedLink(String(favoriteId), '/', name)}"`);
      expect(linkCalls).toEqual([{ siteId: TENANT_A.siteId, contentIds: [HOME] }]);
      expect(await favoritesNamed(A, name)).toEqual([
        {
          tenant_id: A,
          favoriteid: favoriteId,
          userid: SYSTEM_USER,
          favoritename: name,
          favorite: HOME,
          type: 'Page',
          siteid: TENANT_A.siteId,
          datecreated: STORED_AT,
          columnnumber: 2,
          rownumber: 3,
          maxrssitems: 4,
        },
      ]);
    });

    it("stores a pooled member's favorite under the site's tenant, not the member's pool", async () => {
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ userID: POOLED_MEMBER, favoriteName: 'Pooled' }));
      expect(res.statusCode).toBe(200);
      expect((await favoritesNamed(A, 'Pooled')).map((row) => row.userid)).toEqual([POOLED_MEMBER]);
      expect(await favoritesNamed(UMBRELLA, 'Pooled')).toEqual([]);
    });

    it('reads field names in any case, joins a repeated field and trims every text as the scan and the bean do', async () => {
      const fields =
        `USERID=%20${SYSTEM_USER.toLowerCase()}%20&SiteID=%20TENANT-A%20&favoritename=%20Two&FAVORITENAME=Parts%20` +
        `&FavoriteLocation=%20about&FAVORITETYPE=%20Link%20&COLUMNNUMBER=1.9&rownumber=abc&MaxRssItems=1e3`;
      const res = await send('GET', 'saveFavorite.cfm', fields);
      expect(res.statusCode).toBe(200);
      const [, , favoriteId] = SAVED.exec(res.body) ?? [];
      expect(res.body).toBe(favoriteSavedBody(String(favoriteId), '/about/', 'Two,Parts', 'remove from favorites'));
      expect(linkCalls).toEqual([{ siteId: 'TENANT-A', contentIds: ['about'] }]);
      expect(await favoritesNamed(A, 'Two,Parts')).toMatchObject([
        { userid: SYSTEM_USER.toLowerCase(), favorite: 'about', type: 'Link', siteid: 'TENANT-A', columnnumber: 1, rownumber: 0, maxrssitems: 1000 },
      ]);
    });

    // Sent and stored values as the oracle's tusersfavorites held them; the answer names the scanned url value.
    it.each([
      ['U1 \u2713 \u{1F600} \u0101 \u20ac \u0141 \ufb01 x', 'Page', 'U1 \u2713 \u{1F600} \u0101 \u20ac \u0141 \ufb01 x', 'U1 ? ?? ? \u20ac ? ? x', 'Page'],
      [
        'U2 \u0081\u0085\u008d\u008f\u0090\u009d\u009f|\u00a0\u00ff|\u0152\u0178\u02dc\u2122\u0192\u2026|\u0100',
        'Page',
        'U2 \u0081\u0085\u008d\u008f\u0090\u009d\u009f|\u00a0\u00ff|\u0152\u0178\u02dc\u2122\u0192...|\u0100',
        'U2 ???????|\u00a0\u00ff|\u0152\u0178\u02dc\u2122\u0192...|?',
        'Page',
      ],
      [
        'U3 \u0080\u20ac\u00e9\u0153\u017e\u2030\u0391\u00ad|\u0161\u0178\u00a0x\u0007y',
        'Pag\u00e9\u2713',
        'U3 \u0080\u20ac\u00e9\u0153\u017e\u2030\u0391\u00ad|\u0161\u0178\u00a0x\u0007y',
        'U3 ?\u20ac\u00e9\u0153\u017e\u2030?\u00ad|\u0161\u0178\u00a0x\u0007y',
        'Pag\u00e9?',
      ],
    ])('stores %j outside Windows-1252 as ? per UTF-16 code unit, as the varchar column does, answering the name as sent', async (name, favoriteType, answered, storedName, storedType) => {
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ favoriteName: name, favoriteType }));
      expect(res.statusCode).toBe(200);
      const [, , favoriteId] = SAVED.exec(res.body) ?? [];
      expect(res.body).toBe(favoriteSavedBody(String(favoriteId), '/', answered, 'remove from favorites'));
      expect(linkCalls).toEqual([{ siteId: TENANT_A.siteId, contentIds: [HOME] }]);
      expect((await favoritesWithId(A, String(favoriteId))).map((row) => [row.favoritename, row.type])).toEqual([[storedName, storedType]]);
    });

    it('stores favoriteLocation as the varchar column does, reading the content link by the url value', async () => {
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ favoriteName: 'Located', favoriteLocation: 'about\u2713' }));
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<a href=\\'/about\u2713/\\'>Located</a>");
      expect(linkCalls).toEqual([{ siteId: TENANT_A.siteId, contentIds: ['about\u2713'] }]);
      expect((await favoritesNamed(A, 'Located')).map((row) => row.favorite)).toEqual(['about?']);
    });

    it('stores an empty name as NULL and links empty text', async () => {
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ favoriteName: '', favoriteLocation: 'nameless' }));
      expect(res.statusCode).toBe(200);
      const [, , favoriteId] = SAVED.exec(res.body) ?? [];
      expect(res.body).toBe(favoriteSavedBody(String(favoriteId), '/nameless/', '', 'remove from favorites'));
      expect((await favoritesWithId(A, String(favoriteId))).map((row) => row.favoritename)).toEqual([null]);
    });

    it.each([
      ['userID', { userID: undefined }],
      ['siteid', { siteid: undefined }],
      ['favoriteName', { favoriteName: undefined }],
      ['favoriteLocation', { favoriteLocation: undefined }],
      ['favoriteType', { favoriteType: undefined }],
      ['an empty userID', { userID: '' }],
      ['a blank userID', { userID: '  ' }],
      ['an empty favoriteLocation', { favoriteLocation: '' }],
      ['an empty favoriteType', { favoriteType: '\t' }],
      ['a 256-character favoriteName', { favoriteName: 'n'.repeat(256) }],
      ['a 36-character userID', { userID: `${SYSTEM_USER}X` }],
      ['a 1001-character favoriteLocation', { favoriteLocation: 'l'.repeat(1001) }],
      ['a 31-character favoriteType', { favoriteType: 't'.repeat(31) }],
      ['a 26-character siteid', { siteid: 's'.repeat(26) }],
      ['an int overflow in columnNumber', { columnNumber: '2147483648' }],
      ['a 39-digit rowNumber', { rowNumber: '9'.repeat(39) }],
      ['an int overflow in maxRssItems', { maxRssItems: '1e10' }],
    ])('answers the error page for %s, saving nothing', async (_case, overrides) => {
      const before = await favoriteCount();
      const res = await send('GET', 'saveFavorite.cfm', saveFields(overrides));
      expect([res.statusCode, res.statusMessage, res.headers['content-type'], res.body]).toEqual([500, 'An Error Occurred', HTML, LEGACY_ERROR_PAGE_HTML]);
      expect(await favoriteCount()).toBe(before);
      expect(linkCalls).toEqual([]);
    });

    it('stores the longest values legacy holds', async () => {
      const name = 'n'.repeat(255);
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ favoriteName: `${name}  `, favoriteLocation: 'l'.repeat(1000), favoriteType: 't'.repeat(30) }));
      expect(res.statusCode).toBe(200);
      expect(await favoritesNamed(A, name)).toHaveLength(1);
    });

    it.each([
      ['an empty', ''],
      ['a blank', '  '],
    ])('stores the favorite of %s siteid with no site under the umbrella tenant, then answers the error page', async (_case, siteid) => {
      const name = `No site ${JSON.stringify(siteid)}`;
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ siteid, favoriteName: name }));
      expect([res.statusCode, res.body]).toEqual([500, LEGACY_ERROR_PAGE_HTML]);
      expect(await favoritesNamed(UMBRELLA, name)).toMatchObject([{ userid: SYSTEM_USER, siteid: null }]);
      expect(linkCalls).toEqual([]);
    });

    it.each([
      ['a group', GROUP_ID],
      ['no stored user', cfUuid()],
    ])('answers the legacy 503 for a userID of %s, which people does not own, before any write or link read', async (_case, userID) => {
      const before = await favoriteCount();
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ userID }));
      expect(answerOf(res)).toEqual(UNAVAILABLE_PAGE);
      expect(await favoriteCount()).toBe(before);
      expect(linkCalls).toEqual([]);
    });

    it('answers the legacy 503 for a site the registry does not hold, before any write or link read', async () => {
      const before = await favoriteCount();
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ siteid: 'nosuchsite' }));
      expect(answerOf(res)).toEqual(UNAVAILABLE_PAGE);
      expect(await favoriteCount()).toBe(before);
      expect(linkCalls).toEqual([]);
    });

    it('answers the legacy 503 and saves nothing while strategies-content is unavailable', async () => {
      contentDown = true;
      const before = await favoriteCount();
      const res = await send('GET', 'saveFavorite.cfm', saveFields({ favoriteName: 'Unlinked' }));
      expect(answerOf(res)).toEqual(UNAVAILABLE_PAGE);
      expect(await favoriteCount()).toBe(before);
    });

    it('answers the legacy 503 when strategies-content links no listed id', async () => {
      const deps: FavoriteDeps = { db, repo, clock: CLOCK, fence: personFence, content: { contentLinks: () => Promise.resolve(new Map()) }, identity };
      await expect(saveFavorite(deps, urlFieldsOf(`/x.cfm?${query(saveFields({ favoriteName: 'Linkless' }))}`), {})).rejects.toMatchObject({
        reason: 'favorite-link-missing',
      });
      expect(await favoritesNamed(A, 'Linkless')).toEqual([]);
    });

    it("fences the owner in the person's tenant and again in the write when the site tenant holds the person", async () => {
      const fenced: string[][] = [];
      const fence: PersonFence = {
        fencePersons: (tx, userIds) => {
          fenced.push([tx.tenantId, ...userIds]);
          return Promise.resolve();
        },
        withPersonsOpen: (fenceDb, tenantId, fn) => withGatedTenant(fenceDb, tenantId, fn),
      };
      const deps: FavoriteDeps = { db, repo, clock: CLOCK, fence, content, identity };
      await saveFavorite(deps, urlFieldsOf(`/x.cfm?${query(saveFields({ favoriteName: 'Fenced' }))}`), {});
      await saveFavorite(deps, urlFieldsOf(`/x.cfm?${query(saveFields({ userID: POOLED_MEMBER, favoriteName: 'Fenced' }))}`), {});
      expect(fenced).toEqual([
        [UMBRELLA, SYSTEM_USER],
        [A, SYSTEM_USER],
        [A, SYSTEM_USER],
        [UMBRELLA, POOLED_MEMBER],
      ]);
    });

    it('reads the remove title from the bundle of the requested site', async () => {
      const deps: FavoriteDeps = { db, repo, clock: CLOCK, fence: personFence, content, identity, rb: (siteId, key) => `${siteId}:${key}` };
      const body = await saveFavorite(deps, urlFieldsOf(`/x.cfm?${query(saveFields({ siteid: 'Tenant-A', favoriteName: 'Titled' }))}`), {});
      expect(body).toContain('title=\\"Tenant-A:favorites.removefromfavorites\\"');
    });
  });

  describe('deleteFavorite.cfm', () => {
    it.each(METHODS)('%s deletes the favorite in whichever people tenant holds it, matching its id in any case', async (method) => {
      const [inSite, inUmbrella] = await Promise.all([
        storeFavorite(favoriteRow({ tenant_id: A, userid: SYSTEM_USER, siteid: TENANT_A.siteId })),
        storeFavorite(favoriteRow({ tenant_id: UMBRELLA, userid: POOLED_MEMBER, siteid: null })),
      ]);
      for (const stored of [inSite, inUmbrella]) {
        const res = await send(method, 'deleteFavorite.cfm', { favoriteID: ` ${stored.favoriteid.toLowerCase()} ` });
        expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, HTML, FAVORITE_REMOVED]);
        expect(res.headers['x-opt2-write-position']).toEqual(expect.any(String));
        expect(await favoritesWithId(stored.tenant_id, stored.favoriteid)).toEqual([]);
      }
      expect(identityDouble.requests).toEqual([]);
    });

    const unknownId = cfUuid();
    it.each([
      ['an unknown', ` ${unknownId}\t`, [unknownId]],
      ['a 35-character', 'X'.repeat(35), ['X'.repeat(35)]],
      ['an empty', '', []],
      ['a blank', '   ', []],
      ['a 36-character', 'X'.repeat(36), []],
      ['an over-long', 'X'.repeat(40), []],
    ])('answers the legacy text for %s id, deleting nothing', async (_case, favoriteID, asked) => {
      const before = await favoriteCount();
      const res = await send('GET', 'deleteFavorite.cfm', { favoriteID });
      expect([res.statusCode, res.body]).toEqual([200, FAVORITE_REMOVED]);
      expect(await favoriteCount()).toBe(before);
      // Identity is asked, without a user token, only for an id char(35) can hold that no people tenant holds.
      expect(groupLookups()).toEqual(asked.map((id) => ['lookupGroupFavorites', { favoriteIds: [id] }, null]));
    });

    it.each(METHODS)("%s refuses the id of a group's favorite, which identity holds, with the legacy 503 error page, deleting nothing", async (method) => {
      const before = await favoriteCount();
      const sent = ` ${GROUP_FAVORITE.toLowerCase()} `;
      const res = await send(method, 'deleteFavorite.cfm', { favoriteID: sent });
      expect(answerOf(res)).toEqual(UNAVAILABLE_PAGE);
      expect(await favoriteCount()).toBe(before);
      expect(groupLookups()).toEqual([['lookupGroupFavorites', { favoriteIds: [sent.trim()] }, null]]);
    });

    it.each<[string, (double: typeof identityDouble) => void]>([
      [
        'unreachable',
        (double) => {
          double.setUnreachable(true);
        },
      ],
      [
        'answering its 503',
        (double) => {
          double.failAt('read', 'error');
        },
      ],
    ])('answers the legacy 503 error page for an id no people tenant holds while identity is %s, deleting nothing', async (_case, fail) => {
      fail(identityDouble);
      const before = await favoriteCount();
      const res = await send('GET', 'deleteFavorite.cfm', { favoriteID: cfUuid() });
      expect(answerOf(res)).toEqual(UNAVAILABLE_PAGE);
      expect(await favoriteCount()).toBe(before);
    });

    it('answers the error page without a favoriteID url field', async () => {
      const res = await send('POST', 'deleteFavorite.cfm', { favoriteid_x: cfUuid() });
      expect([res.statusCode, res.body]).toEqual([500, LEGACY_ERROR_PAGE_HTML]);
    });
  });

  describe('deleteRSSFavorite.cfm', () => {
    it.each(METHODS)("%s deletes the person's RSS favorites of the site, in any case of type, user and site, and nothing else", async (method) => {
      const rss = await Promise.all(
        ['RSS', 'rss ', 'Rss'].map((type) => storeFavorite(favoriteRow({ tenant_id: A, userid: SYSTEM_USER, siteid: TENANT_A.siteId, type }))),
      );
      const kept = await Promise.all([
        storeFavorite(favoriteRow({ tenant_id: A, userid: SYSTEM_USER, siteid: TENANT_A.siteId, type: 'Page' })),
        storeFavorite(favoriteRow({ tenant_id: A, userid: POOLED_MEMBER, siteid: TENANT_A.siteId, type: 'RSS' })),
      ]);
      const res = await send(method, 'deleteRSSFavorite.cfm', { userID: ` ${SYSTEM_USER.toLowerCase()}\t`, siteID: 'TENANT-A ' });
      expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, HTML, '']);
      for (const row of rss) expect(await favoritesWithId(A, row.favoriteid)).toEqual([]);
      for (const row of kept) expect(await favoritesWithId(A, row.favoriteid)).toHaveLength(1);
      await withGatedTenant(db, A, (tx) => repo.deleteFavorites(tx, kept));
    });

    it.each([
      ['an empty userID', { userID: '', siteID: TENANT_A.siteId }],
      ['a blank userID', { userID: ' \t ', siteID: TENANT_A.siteId }],
      ['an empty siteID', { userID: SYSTEM_USER, siteID: '' }],
      ['a blank siteID', { userID: SYSTEM_USER, siteID: '  ' }],
    ])('answers an empty body for %s, which no stored favorite can match, reading nothing', async (_case, fields) => {
      const res = await send('GET', 'deleteRSSFavorite.cfm', fields);
      expect([res.statusCode, res.body]).toEqual([200, '']);
      expect(res.headers['x-opt2-write-position']).toBeUndefined();
    });

    it.each([
      ['userID', { siteID: TENANT_A.siteId }],
      ['siteID', { userID: SYSTEM_USER }],
    ])('answers the error page without a %s url field', async (_case, fields) => {
      const res = await send('GET', 'deleteRSSFavorite.cfm', fields);
      expect([res.statusCode, res.body]).toEqual([500, LEGACY_ERROR_PAGE_HTML]);
    });

    it.each([
      ['a site the registry does not hold', { userID: SYSTEM_USER, siteID: 'nosuchsite' }],
      ['a group userID', { userID: GROUP_ID, siteID: TENANT_A.siteId }],
      ['a userID of no stored user', { userID: cfUuid(), siteID: TENANT_A.siteId }],
    ])('answers the legacy 503 for %s, deleting nothing', async (_case, fields) => {
      const before = await favoriteCount();
      const res = await send('GET', 'deleteRSSFavorite.cfm', fields);
      expect(answerOf(res)).toEqual(UNAVAILABLE_PAGE);
      expect(await favoriteCount()).toBe(before);
    });
  });

  describe('refusals', () => {
    const stranger = cfUuid();
    it.each<[string, (deps: FavoriteDeps) => Promise<string>, string, string]>([
      [
        "a group's favorite id",
        (deps) => deleteFavorite(deps, urlFieldsOf(`/x.cfm?favoriteID=${GROUP_FAVORITE}`), {}),
        `favoriteID ${GROUP_FAVORITE}, which names a group's favorite, is refused (EX-FAVORITES)`,
        'favorite-owner-group',
      ],
      [
        'a userID naming no stored person',
        (deps) => saveFavorite(deps, urlFieldsOf(`/x.cfm?${query(saveFields({ userID: stranger }))}`), {}),
        `userID ${stranger}, which names no stored person, is refused (EX-FAVORITES)`,
        'favorite-owner-unknown',
      ],
      [
        'a site the registry does not hold',
        (deps) => deleteRssFavorites(deps, urlFieldsOf(`/x.cfm?userID=${SYSTEM_USER}&siteID=nosuchsite`), {}),
        'siteID nosuchsite, which the registry does not hold, is refused (EX-FAVORITES)',
        'tenant-unregistered',
      ],
    ])('refuses %s with the legacy 503 naming EX-FAVORITES', async (_case, run, message, reason) => {
      const deps: FavoriteDeps = { db, repo, clock: CLOCK, fence: personFence, content, identity };
      await expect(run(deps)).rejects.toMatchObject({ name: 'LegacyServiceUnavailableError', message, surface: 'auto', reason });
    });
  });

  describe('HEAD', () => {
    /** Legacy's HEAD answer: the GET answer's status and headers, with no body and no length. */
    function expectHeadersOnly(res: { statusCode: number; statusMessage: string; headers: Record<string, unknown>; body: string }, status: number, reason: string): void {
      expect([res.statusCode, res.statusMessage, res.headers['content-type'], res.headers['content-length'], res.body]).toEqual([status, reason, HTML, undefined, '']);
      expect([res.headers.generator, res.headers['strict-transport-security']]).toEqual(['Masa CMS 7.6.1', 'max-age=1200']);
    }

    it('saves the favorite as GET does and answers its status and headers with no body', async () => {
      const res = await send('HEAD', 'saveFavorite.cfm', saveFields({ favoriteName: 'Home HEAD', columnNumber: '2' }));
      expectHeadersOnly(res, 200, 'OK');
      expect(res.headers['x-opt2-write-position']).toEqual(expect.any(String));
      expect(linkCalls).toEqual([{ siteId: TENANT_A.siteId, contentIds: [HOME] }]);
      expect(await favoritesNamed(A, 'Home HEAD')).toMatchObject([{ userid: SYSTEM_USER, favorite: HOME, type: 'Page', siteid: TENANT_A.siteId, columnnumber: 2 }]);
    });

    it.each<[string, (row: FavoriteRow) => string]>([
      ['deleteFavorite.cfm', (row) => `favoriteID=${row.favoriteid}`],
      ['deleteRSSFavorite.cfm', () => `userID=${SYSTEM_USER}&siteID=${TENANT_A.siteId}`],
    ])('runs %s as GET does, deleting the favorite, and answers its status and headers with no body', async (template, fields) => {
      const stored = await storeFavorite(favoriteRow({ tenant_id: A, userid: SYSTEM_USER, siteid: TENANT_A.siteId, type: 'RSS' }));
      expectHeadersOnly(await send('HEAD', template, fields(stored)), 200, 'OK');
      expect(await favoritesWithId(A, stored.favoriteid)).toEqual([]);
    });

    it.each([
      ['a missing favoriteType', { favoriteType: undefined }, 500],
      ['a userID of no stored user', { userID: cfUuid() }, 503],
    ])("answers the error page's status and headers with no body for %s, saving nothing", async (_case, overrides, status) => {
      const before = await favoriteCount();
      expectHeadersOnly(await send('HEAD', 'saveFavorite.cfm', saveFields(overrides)), status, 'An Error Occurred');
      expect(await favoriteCount()).toBe(before);
      expect(linkCalls).toEqual([]);
    });

    it('answers 404 for a template path in another letter case, running no template', async () => {
      const before = await favoriteCount();
      const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` };
      const res = await app.inject({ method: 'HEAD', url: `${FAVORITES_PATH}/savefavorite.cfm?${query(saveFields({ favoriteName: 'Variant HEAD' }))}`, headers });
      expect([res.statusCode, res.statusMessage, res.headers['content-type']]).toEqual([404, 'Not Found', HTML]);
      expect(await favoriteCount()).toBe(before);
      expect(linkCalls).toEqual([]);
    });
  });

  describe('malformed query escapes', () => {
    /** The container's refusal: an empty 400 that closes the connection, without the headers Masa or people add. */
    function expectRefused(res: { statusCode: number; statusMessage: string; headers: Record<string, unknown>; body: string }): void {
      expect([res.statusCode, res.statusMessage, res.body, res.headers['content-length'], res.headers.connection]).toEqual([400, 'Bad Request', '', '0', 'close']);
      for (const header of ['content-type', 'date', 'generator', 'strict-transport-security', 'x-opt2-write-position']) expect(res.headers[header]).toBeUndefined();
    }

    it.each<[string, Method, string, (favoriteId: string) => string]>([
      ['a lone %', 'GET', 'deleteFavorite.cfm', (id) => `favoriteID=${id}&x=%`],
      ['%Z', 'GET', 'deleteFavorite.cfm', (id) => `favoriteID=${id}&x=%Z`],
      ['%E at the end', 'PUT', 'deleteFavorite.cfm', (id) => `favoriteID=${id}&x=abc%E`],
      ['%G1', 'DELETE', 'deleteFavorite.cfm', (id) => `favoriteID=${id}&x=%G1`],
      ['%%41', 'PATCH', 'deleteFavorite.cfm', (id) => `x=%%41&favoriteID=${id}`],
      ['a malformed field name', 'OPTIONS', 'deleteFavorite.cfm', (id) => `favoriteID=${id}&a%ZZ=1`],
      ['%u0041', 'GET', 'deleteRSSFavorite.cfm', () => `userID=${SYSTEM_USER}&siteID=${TENANT_A.siteId}&x=%u0041`],
      ['%zz beside a complete save', 'POST', 'saveFavorite.cfm', () => `${query(saveFields({ favoriteName: 'Refused' }))}&x=%zz`],
      ['%ZZ beside a complete HEAD save', 'HEAD', 'saveFavorite.cfm', () => `${query(saveFields({ favoriteName: 'Refused' }))}&x=%ZZ`],
      // Oracle: favorites/ajax/nosuch.cfm?x=null&y=% and ?x=null&y=%ZZ answer the container's empty 400 before ColdFusion runs.
      ['a lone % beside the scan-faulting x=null', 'GET', 'deleteFavorite.cfm', (id) => `favoriteID=${id}&x=null&y=%`],
      ['%ZZ beside the scan-faulting x=null', 'DELETE', 'deleteFavorite.cfm', (id) => `x=null&y=%ZZ&favoriteID=${id}`],
      ['%zz beside a complete save and the scan-faulting x=null', 'POST', 'saveFavorite.cfm', () => `${query(saveFields({ favoriteName: 'Refused' }))}&x=null&y=%zz`],
    ])('refuses %s with the empty 400 that closes the connection, before the template runs', async (_case, method, template, fields) => {
      const stored = await storeFavorite(favoriteRow({ tenant_id: A, userid: SYSTEM_USER, siteid: TENANT_A.siteId, type: 'RSS' }));
      const before = await favoriteCount();
      expectRefused(await send(method, template, fields(stored.favoriteid)));
      expect(await favoriteCount()).toBe(before);
      expect(linkCalls).toEqual([]);
      await withGatedTenant(db, A, (tx) => repo.deleteFavorites(tx, [stored]));
    });

    it.each([
      ['a malformed escape under a template path in another letter case', `${FAVORITES_PATH}/savefavorite.cfm?${query(saveFields())}&x=%`],
      ['a malformed escape beside the scan-faulting x=null under a folder path in another letter case', '/core/modules/v1/Favorites/AJAX/nosuch.cfm?x=null&y=%'],
    ])('refuses %s, as the container refuses it before any template is found', async (_case, url) => {
      const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` };
      expectRefused(await app.inject({ method: 'GET', url, headers }));
    });

    it.each(['a+b', '+', '%C3%A9x%E9', '%00', '%ff%FE'])('runs the template for favoriteID=%s, which the container decodes', async (favoriteID) => {
      const res = await send('GET', 'deleteFavorite.cfm', `favoriteID=${favoriteID}`);
      expect([res.statusCode, res.body]).toEqual([200, FAVORITE_REMOVED]);
    });
  });

  describe('raw request-target characters', () => {
    const TARGET = `${FAVORITES_PATH}/deleteFavorite.cfm`;
    let port = 0;

    beforeAll(async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      port = (app.server.address() as AddressInfo).port;
    });

    /** One GET of the raw request target `target`, sent as latin1 bytes over a socket the way a forwarder sends it unencoded. */
    async function rawGet(target: string): Promise<{ statusLine: string; headers: [string, string][]; body: string }> {
      const token = await mintServiceToken({ caller: 'gateway', audience: SERVICE });
      const request = `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n${INVOCATION_HEADER}: Bearer ${token}\r\nConnection: close\r\n\r\n`;
      return new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1');
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('error', reject);
        socket.on('close', () => {
          const text = Buffer.concat(chunks).toString('latin1');
          const end = text.indexOf('\r\n\r\n');
          const [statusLine = '', ...lines] = text.slice(0, end).split('\r\n');
          const headers = lines.map((line): [string, string] => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]);
          resolve({ statusLine, headers, body: text.slice(end + 4) });
        });
        socket.write(Buffer.from(request, 'latin1'));
      });
    }

    // The bytes Node's HTTP parser accepts; on these the container answers its empty 400 before ColdFusion runs.
    it.each([
      ['" in the query', `${TARGET}?favoriteID=a"b`],
      ['# in the query', `${TARGET}?favoriteID=a#b`],
      ['< in the query', `${TARGET}?favoriteID=a<b`],
      ['> in the query', `${TARGET}?favoriteID=a>b`],
      ['\\ in the query', `${TARGET}?favoriteID=a\\b`],
      ['^ in the query', `${TARGET}?favoriteID=a^b`],
      ['` in the query', `${TARGET}?favoriteID=a\`b`],
      ['{ in the query', `${TARGET}?favoriteID=a{b`],
      ['| in the query', `${TARGET}?favoriteID=a|b`],
      ['} in the query', `${TARGET}?favoriteID=a}b`],
      ['| in a field name', `${TARGET}?favoriteID=a&x|y=1`],
      ['| in the template name', `${FAVORITES_PATH}/dele|teFavorite.cfm?favoriteID=a`],
      ['# before the query', `${TARGET}#x?favoriteID=a`],
      // Oracle: favorites/ajax/nosuch.cfm?favoriteID=a&x=null&y=a|b answers the container's empty 400 before ColdFusion runs.
      ['| beside the scan-faulting x=null', `${TARGET}?favoriteID=a&x=null&y=a|b`],
    ])('answers a raw %s with the empty 400 that closes the connection, before the template runs', async (_case, target) => {
      const before = await favoriteCount();
      const res = await rawGet(target);
      expect(res).toEqual({ statusLine: 'HTTP/1.1 400 Bad Request', headers: [['content-length', '0'], ['connection', 'close']], body: '' });
      expect(await favoriteCount()).toBe(before);
      expect(identityDouble.requests).toEqual([]);
    });

    it.each(['a[b]', "a'b", 'a?b'])('runs the template for the raw query value %s, which the container accepts', async (value) => {
      const res = await rawGet(`${TARGET}?favoriteID=${value}`);
      expect([res.statusLine, res.body]).toEqual(['HTTP/1.1 200 OK', FAVORITE_REMOVED]);
    });

    // Node's parser refuses these before any hook with Fastify's JSON 400, where the container's 400 is empty.
    it.each([
      ['a control character', 'a\u0001b'],
      ['DEL', 'a\u007fb'],
      ['a Latin-1 byte', 'a\u00e9b'],
      ['UTF-8 bytes', 'a\u00c3\u00a9b'],
    ])('refuses %s in a raw query with a 400 before the template runs, as the HTTP parser does', async (_case, value) => {
      const before = await favoriteCount();
      const res = await rawGet(`${TARGET}?favoriteID=${value}`);
      expect(res.statusLine).toBe('HTTP/1.1 400 Bad Request');
      expect(await favoriteCount()).toBe(before);
      expect(identityDouble.requests).toEqual([]);
    });
  });


  describe('error surface', () => {
    const save = (folder: string, template: string): string => `${folder}/${template}?${query(saveFields({ favoriteName: 'Surface' }))}`;
    const remove = (template: string) => (favoriteId: string) => `${FAVORITES_PATH}/${template}?favoriteID=${favoriteId}`;
    const removeRss = (template: string) => () => `${FAVORITES_PATH}/${template}?userID=${SYSTEM_USER}&siteID=${TENANT_A.siteId}`;
    const unknownUser = query(saveFields({ userID: cfUuid(), favoriteName: 'Surface' }));

    it.each<[string, number, 'GET' | 'POST' | 'DELETE', (favoriteId: string) => string, Error?]>([
      ['GET of savefavorite.cfm, the template in another letter case', 404, 'GET', () => save(FAVORITES_PATH, 'savefavorite.cfm')],
      ['POST of DELETEFAVORITE.CFM, the template in another letter case', 404, 'POST', remove('DELETEFAVORITE.CFM')],
      ['DELETE of deleterssfavorite.cfm, the template in another letter case', 404, 'DELETE', removeRss('deleterssfavorite.cfm')],
      ['GET of saveFavorite.cfm under the folder in another letter case', 404, 'GET', () => save('/core/modules/v1/Favorites/AJAX', 'saveFavorite.cfm')],
      ['a save whose person read fails unexpectedly', 500, 'GET', () => save(FAVORITES_PATH, 'saveFavorite.cfm'), new Error('connection reset')],
      ['a save under a percent-encoded folder for no stored user', 503, 'GET', () => `/core/modules/v1/favorites/%61jax/saveFavorite.cfm?${unknownUser}`],
      // Oracle: favorites/ajax/deletefavorite.cfm, savefavorite.cfm, nosuch.cfm and DELETEFAVORITE.CFM ?x=null answer 404; nosuch.txt and nosuch.cfm/ ?x=null answer 500.
      ['GET of deletefavorite.cfm, the template in another letter case, beside the scan-faulting x=null', 404, 'GET', (id) => `${FAVORITES_PATH}/deletefavorite.cfm?favoriteID=${id}&x=null`],
      ['GET of DELETEFAVORITE.CFM, the extension in another letter case, beside the scan-faulting x=null', 404, 'GET', (id) => `${FAVORITES_PATH}/DELETEFAVORITE.CFM?favoriteID=${id}&x=null`],
      ['GET of nosuch.cfm, which names no template, beside the scan-faulting x=null', 404, 'GET', () => `${FAVORITES_PATH}/nosuch.cfm?x=null`],
      ['GET of deleteFavorite.cfm under the folder in another letter case beside the scan-faulting x=null', 404, 'GET', (id) => `/core/modules/v1/Favorites/ajax/deleteFavorite.cfm?favoriteID=${id}&x=null`],
      ['GET of deleteFavorite.cfm beside the scan-faulting x=null', 500, 'GET', (id) => `${FAVORITES_PATH}/deleteFavorite.cfm?favoriteID=${id}&x=null`],
      ['GET of saveFavorite.cfm beside the scan-faulting x=null', 500, 'GET', () => `${save(FAVORITES_PATH, 'saveFavorite.cfm')}&x=null`],
      ['DELETE of deleteRSSFavorite.cfm beside the scan-faulting x=null', 500, 'DELETE', () => `${removeRss('deleteRSSFavorite.cfm')()}&x=null`],
      ['GET of nosuch.txt, which ColdFusion does not serve, beside the scan-faulting x=null', 500, 'GET', () => `${FAVORITES_PATH}/nosuch.txt?x=null`],
      ['GET of nosuch.cfm/ beside the scan-faulting x=null', 500, 'GET', () => `${FAVORITES_PATH}/nosuch.cfm/?x=null`],
    ])('%s answers the ColdFusion error page at %i, writing nothing', async (_case, status, method, target, fault) => {
      const stored = await storeFavorite(favoriteRow({ tenant_id: A, userid: SYSTEM_USER, siteid: TENANT_A.siteId, type: 'RSS' }));
      const before = await favoriteCount();
      repoFault = fault;
      const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` };
      const res = await app.inject({ method, url: target(stored.favoriteid), headers });
      const reason = status === 404 ? 'Not Found' : 'An Error Occurred';
      expect(answerOf(res)).toEqual([status, reason, HTML, LEGACY_ERROR_PAGE_HTML]);
      expect([res.headers.generator, res.headers['strict-transport-security']]).toEqual(['Masa CMS 7.6.1', 'max-age=1200']);
      expect(await favoriteCount()).toBe(before);
      expect(await favoritesWithId(A, stored.favoriteid)).toHaveLength(1);
      expect(linkCalls).toEqual([]);
      await withGatedTenant(db, A, (tx) => repo.deleteFavorites(tx, [stored]));
    });
  });
});
