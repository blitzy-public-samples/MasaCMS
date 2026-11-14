// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Communications fixture template routes over a throwaway PostgreSQL schema: values it cannot store or look up answer the fixture envelope. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createLogger, validateLogRecord } from '@opt2/platform/logging';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { siteForTenant, tenantForRegisteredSite, withMetadata } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { DomainDeps } from '../../src/domain/delivery.js';
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX, registerFixtureRoutes } from '../../src/routes/fixture.js';

const SCHEMA = 'communications';
const USER_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const SENDER = [Roles.systemUser, Roles.communicationsSender];
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000123' };
const TEMPLATES = `${FIXTURE_PREFIX}/templates`;
const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const DENIED = { code: 'invalid_request', message: 'Insufficient Account Permissions' };

/** One injected template-route request. */
interface Call {
  method: 'GET' | 'POST';
  url: string;
  /** Token roles; null sends no token. */
  roles?: readonly string[] | null;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

// pgAvailable rejects when PG_HOST is unset; that case skips the suite instead.
const available = Boolean(process.env.PG_HOST) && (await pgAvailable());
const title = available
  ? 'communications fixture routes over PostgreSQL'
  : 'communications fixture routes over PostgreSQL (requires PostgreSQL: PG_HOST unset or unreachable)';

describe.skipIf(!available)(title, () => {
  const logLines: Array<Record<string, unknown>> = [];
  let handle: ThrowawaySchema;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SCHEMA, migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await seedRegistry(handle.app);
    const clock = fixedClock(new Date(2026, 5, 30, 9, 15, 7));
    const logger = createLogger({
      service: SCHEMA,
      version: '1.0.0',
      env: 'local',
      destination: { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) },
    });
    app = await createService({
      name: SCHEMA,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8115',
        OPT2_SERVICE_NAME: SCHEMA,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SCHEMA),
      logger,
    });
    const domain: DomainDeps = { db: handle.app, repository: createCommunicationsRepository({ clock, schema: handle.schema }), clock, logger };
    const unused = (): Promise<never> => Promise.reject(new Error('template routes send no mail'));
    await registerFixtureRoutes(app, {
      db: handle.app,
      // The route registry's lookup: the registered id of the site matching ignoring case.
      siteLookup: {
        registeredSite: (siteId) =>
          handle.app.withMetadata(async (tx) => {
            const tenantId = await tenantForRegisteredSite(tx, siteId);
            return tenantId === null ? undefined : ((await siteForTenant(tx, tenantId)) ?? undefined);
          }),
      },
      domain,
      mailDeps: { ...domain, transport: { send: unused, close: () => Promise.resolve() }, deliveryStatus: { confirm: unused }, senderAddress: { fromEmail: unused } },
    });
    await app.ready();
    vi.spyOn(app.opt2.client, 'request').mockResolvedValue({ status: 200, headers: {}, body: { valid: true } });
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  /** Templates stored for tenant-a. */
  async function storedTemplates(): Promise<number> {
    const { rows } = await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${handle.schema}.message_template`),
    );
    return rows[0]?.n ?? -1;
  }

  const NUL_TEMPLATE = { siteid: TENANT_A.siteId, name: 'nul-probe\u0000name', subject: 'Hello', bodyText: 'Hi' };

  it.each<[string, number, Call, { code: string; message: string }, string]>([
    ['a template name PostgreSQL cannot store', 400, { method: 'POST', url: TEMPLATES, body: NUL_TEMPLATE, headers: CSRF_HEADERS }, INVALID_PARAMETERS, 'request rejected: 22021'],
    ['an anonymous caller sending that name', 401, { method: 'POST', url: TEMPLATES, body: NUL_TEMPLATE, roles: null }, DENIED, 'request denied: authorization'],
    // A NUL inside the value: the Portcullis trim of a url siteid removes a trailing one.
    [
      'an anonymous caller naming a site PostgreSQL cannot look up',
      400,
      { method: 'GET', url: `${TEMPLATES}?siteid=nul-probe%00site`, roles: null },
      INVALID_PARAMETERS,
      'request rejected: 22021',
    ],
    ['a sender naming a site PostgreSQL cannot look up', 400, { method: 'GET', url: `${TEMPLATES}?siteid=nul-probe%00site` }, INVALID_PARAMETERS, 'request rejected: 22021'],
    [
      'a sender naming a site with a trailing NUL, trimmed to an unknown site',
      400,
      { method: 'GET', url: `${TEMPLATES}?siteid=nul-probe%00` },
      INVALID_PARAMETERS,
      'request rejected: invalidParameters',
    ],
    [
      'a blank template name',
      400,
      { method: 'POST', url: TEMPLATES, body: { ...NUL_TEMPLATE, name: ' ' }, headers: CSRF_HEADERS },
      INVALID_PARAMETERS,
      'request rejected: invalidParameters',
    ],
  ])('answers %s with the fixture %i envelope, storing nothing and logging its fixed reason', async (_case, status, call, error, warning) => {
    const { method, url, roles = SENDER, body, headers = {} } = call;
    const auth: Record<string, string> =
      roles === null
        ? {}
        : {
            authorization: `Bearer ${await mintUserToken({ site: TENANT_A.siteId, roles, sub: USER_ID })}`,
            [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SCHEMA })}`,
          };
    const before = logLines.length;

    const res = await app.inject({
      method,
      url,
      headers: { ...auth, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const lines = logLines.slice(before);

    expect([res.statusCode, res.json()]).toEqual([status, { apiversion: 'v1', method: 'communications.templates', error }]);
    expect(lines.filter(({ severity, message }) => severity === 'WARNING' || message === 'request completed').map(({ severity, message }) => [severity, message])).toStrictEqual([
      ['WARNING', warning],
      ['INFO', 'request completed'],
    ]);
    expect(lines.filter(({ severity }) => severity === 'ERROR')).toEqual([]);
    for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
    expect(`${JSON.stringify(lines)}${res.body}`).not.toMatch(/nul-probe|invalid byte sequence|0x00/);
    expect(await storedTemplates()).toBe(0);
  });
});
