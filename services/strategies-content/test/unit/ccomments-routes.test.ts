/** routes/v1/ccomments over the recording pool: a manager error legacy swallows is logged serialized and legacy's redirect is kept. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { createLogger, serializeError, validateLogRecord } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { TENANT_A, testVerifier } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { registerCommentAdminRoutes } from '../../src/routes/v1/ccomments.js';
import { TEST_CLOCK, createRecordingDb, userHeaders } from '../helpers/app.js';

const SERVICE = 'strategies-content';
const SITE = TENANT_A.siteId;
const USER = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const COMMENT_ID = 'B1C2D3E4-0001-4A5B-8C7D9E0F1A2B3C4D';
const COMMENT_TABLE = /"content"\."comment"/;
const COMMENTER_EMAIL = 'jane.doe@example.com';

/** A PostgreSQL error whose text carries a comment row, as the driver reports a failing row. */
const DRIVER_ERROR = Object.assign(new Error(`new row for relation "comment" violates check constraint, Failing row contains (${COMMENTER_EMAIL}, Jane Doe)`), {
  code: '23514',
  severity: 'ERROR',
});

describe('routes/v1/ccomments swallowed errors', () => {
  const db = createRecordingDb();
  const lines: Array<Record<string, unknown>> = [];
  const warnSpies: Array<MockInstance<FastifyRequest['log']['warn']>> = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8114',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      clock: TEST_CLOCK,
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger: createLogger({
        service: SERVICE,
        version: '1.0.0',
        env: 'local',
        destination: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
      }),
    });
    app.addHook('onRequest', (request, _reply, done) => {
      warnSpies.push(vi.spyOn(request.log, 'warn'));
      done();
    });
    const ctx = {
      domain: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS },
      clock: TEST_CLOCK,
      actorFor: (request: FastifyRequest) => Promise.resolve(actorFromClaims(request.opt2Auth.user, 'Admin User')),
    } as Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'> as ContentRouteContext;
    await registerCommentAdminRoutes(app, ctx);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    db.reset();
    lines.length = 0;
    warnSpies.length = 0;
  });

  it.each([
    ['purge-deleted', 'purgeDeletedComments', false],
    [`${COMMENT_ID}/delete`, 'delete', true],
  ])('POST %s logs its swallowed %s error serialized and answers the legacy redirect', async (suffix, operation, saved) => {
    db.respond(COMMENT_TABLE, () => {
      throw DRIVER_ERROR;
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sites/${SITE}/comments/${suffix}`,
      headers: await userHeaders({ sub: USER, site: SITE, roles: [Roles.siteAdmin] }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved, errors: {}, redirect: { circuit: 'cComments', action: 'default', params: [] } });
    const message = `ccomments ${operation}: error swallowed as legacy swallows it`;
    expect(warnSpies.flatMap((spy) => spy.mock.calls)).toEqual([[{ error: serializeError(DRIVER_ERROR) }, message]]);
    const warned = lines.filter((line) => line.severity === 'WARNING');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ message, error: { type: 'Error', message: 'PostgreSQL error 23514' } });
    expect(validateLogRecord(warned[0]).errors).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(COMMENTER_EMAIL);
  });
});
