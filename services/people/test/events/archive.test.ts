/** People's person archive over a throwaway `people` schema: the fixture route's archive, outbox row and in-request publish, reads, refusals and rollback. */
import { describe, expect, it } from 'vitest';
import { LEGACY_ERROR_MAP, isCfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, assertEventMatches, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { PERSON_ARCHIVED_TOPIC, personArchivedSchema } from '../../src/events/topics.js';
import {
  ARCHIVED_AT_TEXT,
  EFFECTIVE_FROM_TEXT,
  METHOD,
  NOT_FOUND,
  OPENAPI,
  SADMIN_NAMES,
  actorHeaders,
  archivePath,
  callArchive,
  expectFixtureError,
} from '../helpers/archive-calls.js';
import { PG_AVAILABLE, withPgApp, type PgTestApp } from '../helpers/pg-app.js';
import {
  ARCHIVED_PERSON_B,
  ARCHIVE_EFFECTIVE_FROM,
  DEFAULT_PEOPLE_SEED,
  MEMBER_POOLED,
  OTHER_TENANT,
  SITE_ADMIN_A,
  SYSTEM_USER_A_PERSON,
  TENANT_B_ARCHIVE,
  personRow,
  seedPeople,
} from '../helpers/fixtures.js';

/** A stored `person_archive` row as the test reads it back. */
interface ArchiveRow {
  archive_id: string;
  person_id: string;
  siteid: string;
  archived_by_id: string | null;
  archived_by: string | null;
}

describe.skipIf(!PG_AVAILABLE)('the fixture archive route against PostgreSQL', () => {
  /** Runs `fn` over a seeded throwaway schema; fails rather than skips once PostgreSQL was found at import. */
  async function onPg(fn: (ctx: PgTestApp) => Promise<void>): Promise<void> {
    const outcome = await withPgApp(async (ctx) => {
      await seedPeople(ctx.db, DEFAULT_PEOPLE_SEED);
      await fn(ctx);
      return 'ran' as const;
    });
    expect(outcome).toBe('ran');
  }

  /** Rows of `sql` read in a transaction of `tenantId`. */
  async function rowsIn<R>(ctx: PgTestApp, tenantId: string, sql: string, params: unknown[] = []): Promise<R[]> {
    return ctx.db.withTenant(tenantId, async (tx) => (await tx.query(sql, params)).rows as R[]);
  }

  const archivesOf = (ctx: PgTestApp, tenantId: string, personId: string): Promise<ArchiveRow[]> =>
    rowsIn<ArchiveRow>(
      ctx,
      tenantId,
      `SELECT archive_id, person_id, siteid, archived_by_id, archived_by FROM ${ctx.schema.schema}.person_archive WHERE person_id = $1`,
      [personId],
    );

  const outboxOf = (ctx: PgTestApp, tenantId: string, personId: string): Promise<Array<{ topic: string; published: boolean }>> =>
    rowsIn(ctx, tenantId, `SELECT topic, published_at IS NOT NULL AS published FROM ${ctx.schema.schema}.outbox WHERE ordering_key = $1`, [personId]);

  /** Changelog rows the requests wrote, as opposed to the seed's backfill rows. */
  const targetChanges = (ctx: PgTestApp, tenantId: string): Promise<Array<{ table: string; op: string }>> =>
    rowsIn(ctx, tenantId, `SELECT "table", op FROM ${ctx.schema.schema}.changelog WHERE origin = 'target' ORDER BY seq`);

  it('commits the archive with its outbox row, publishes it in the request, and writes no person or identity data', async () => {
    await onPg(async (ctx) => {
      const sid = 'SESSION-ARCHIVE-PG';
      ctx.identity.seedSessions({ sessionId: sid, user: { isLoggedIn: true, userID: SITE_ADMIN_A.sub, ...SADMIN_NAMES } });
      const before = await rowsIn<{ row_version: string }>(ctx, TENANT_A.tenantId, `SELECT row_version FROM ${ctx.schema.schema}.person WHERE userid = $1`, [
        SYSTEM_USER_A_PERSON.userid,
      ]);

      const response = await callArchive(ctx.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A, { sid }) });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: { archiveid: string } }>();
      const archiveId = body.data.archiveid;
      expect(isCfUuid(archiveId)).toBe(true);
      expect(body).toStrictEqual({
        apiversion: 'v1',
        method: METHOD,
        data: { archiveid: archiveId, personid: SYSTEM_USER_A_PERSON.userid, siteid: TENANT_A.siteId, effectivefrom: EFFECTIVE_FROM_TEXT, archivedat: ARCHIVED_AT_TEXT },
      });
      expect(response.headers['x-opt2-write-position']).toMatch(/^people=\d+$/);

      expect(ctx.publisher.published).toHaveLength(1);
      const [event] = ctx.publisher.published;
      expect(event?.topic).toBe(PERSON_ARCHIVED_TOPIC);
      expect(assertEventMatches(undefined, personArchivedSchema, event?.envelope)).toMatchObject({
        tenantId: TENANT_A.tenantId,
        aggregateId: SYSTEM_USER_A_PERSON.userid,
        payload: {
          personId: SYSTEM_USER_A_PERSON.userid,
          archiveId,
          siteId: TENANT_A.siteId,
          effectiveFrom: '2026-07-01 00:00:00.000',
          archivedAt: '2026-06-30 12:00:00.000',
        },
      });

      expect(await archivesOf(ctx, TENANT_A.tenantId, SYSTEM_USER_A_PERSON.userid)).toStrictEqual([
        { archive_id: archiveId, person_id: SYSTEM_USER_A_PERSON.userid, siteid: TENANT_A.siteId, archived_by_id: SITE_ADMIN_A.sub, archived_by: 'Sasha Admin' },
      ]);
      expect(await outboxOf(ctx, TENANT_A.tenantId, SYSTEM_USER_A_PERSON.userid)).toStrictEqual([{ topic: PERSON_ARCHIVED_TOPIC, published: true }]);
      expect(await targetChanges(ctx, TENANT_A.tenantId)).toStrictEqual([{ table: 'person_archive', op: 'insert' }]);
      expect(
        await rowsIn(ctx, TENANT_A.tenantId, `SELECT row_version FROM ${ctx.schema.schema}.person WHERE userid = $1`, [SYSTEM_USER_A_PERSON.userid]),
      ).toStrictEqual(before);
      expect(ctx.identity.requests.map((request) => request.operationId)).toEqual(['consumeCsrfToken', 'getCurrentSession']);
      expect(ctx.identity.operations.size).toBe(0);
    });
  });

  it('archives a pooled member through tenant-a in the umbrella tenant, and GET reads the stored record back', async () => {
    await onPg(async (ctx) => {
      const posted = await callArchive(ctx.app, { userId: MEMBER_POOLED.sub, headers: await actorHeaders(SITE_ADMIN_A) });

      expect(posted.statusCode).toBe(200);
      const { data } = posted.json<{ data: { archiveid: string; siteid: string } }>();
      expect(data.siteid).toBe(TENANT_UMBRELLA.siteId);
      expect(ctx.publisher.published.map(({ envelope }) => [envelope.tenantId, (envelope.payload as { siteId: string }).siteId])).toStrictEqual([
        [TENANT_UMBRELLA.tenantId, TENANT_UMBRELLA.siteId],
      ]);
      expect((await archivesOf(ctx, TENANT_UMBRELLA.tenantId, MEMBER_POOLED.sub)).map((row) => row.archive_id)).toEqual([data.archiveid]);
      expect(await archivesOf(ctx, TENANT_A.tenantId, MEMBER_POOLED.sub)).toEqual([]);

      const read = await callArchive(ctx.app, { method: 'GET', userId: MEMBER_POOLED.sub, headers: await actorHeaders(SITE_ADMIN_A) });

      expect(read.statusCode).toBe(200);
      expect(read.json()).toStrictEqual(posted.json());
      assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: archivePath(MEMBER_POOLED.sub), status: 200, contentType: read.headers['content-type'], body: read.json() });
    });
  });

  it('reads a seeded archive record, answers notFound for a person never archived, and invalidParameters for a site id PostgreSQL cannot store', async () => {
    await onPg(async (ctx) => {
      const seeded = await callArchive(ctx.app, { method: 'GET', userId: ARCHIVED_PERSON_B.userid, headers: await actorHeaders(OTHER_TENANT) });
      expect(seeded.statusCode).toBe(200);
      expect(seeded.json()).toStrictEqual({
        apiversion: 'v1',
        method: METHOD,
        data: { archiveid: TENANT_B_ARCHIVE.archive_id, personid: ARCHIVED_PERSON_B.userid, siteid: TENANT_B.siteId, effectivefrom: '2026-06-01T00:00:00', archivedat: ARCHIVED_AT_TEXT },
      });

      expectFixtureError(await callArchive(ctx.app, { method: 'GET', userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A) }), NOT_FOUND);

      const nul = await callArchive(ctx.app, { method: 'GET', userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A), query: { siteid: 'tenant\u0000a' } });
      expectFixtureError(nul, LEGACY_ERROR_MAP.invalidParameters);
    });
  });

  it('refuses any second archive of a person with badRequest, keeping one archive row and one outbox row', async () => {
    await onPg(async (ctx) => {
      const first = await callArchive(ctx.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A) });
      expect(first.statusCode).toBe(200);

      for (const effectiveFrom of [ARCHIVE_EFFECTIVE_FROM, '2026-08-01']) {
        const repeat = await callArchive(ctx.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A), body: { effectiveFrom } });
        expectFixtureError(repeat, LEGACY_ERROR_MAP.badRequest);
      }

      expect(await archivesOf(ctx, TENANT_A.tenantId, SYSTEM_USER_A_PERSON.userid)).toHaveLength(1);
      expect(await outboxOf(ctx, TENANT_A.tenantId, SYSTEM_USER_A_PERSON.userid)).toHaveLength(1);
      expect(ctx.publisher.published).toHaveLength(1);
    });
  });

  it('rolls the archive back when its outbox event is rejected after the insert, answering server_error', async () => {
    await onPg(async (ctx) => {
      // Backfilled persons keep row_version 0, below the envelope's aggregateVersion minimum.
      const unbumped = personRow({ siteid: TENANT_A.siteId, row_version: '0' });
      await seedPeople(ctx.db, { [TENANT_A.tenantId]: { persons: [unbumped] } });

      const response = await callArchive(ctx.app, { userId: unbumped.userid, headers: await actorHeaders(SITE_ADMIN_A) });

      expectFixtureError(response, LEGACY_ERROR_MAP.server_error);
      expect(await archivesOf(ctx, TENANT_A.tenantId, unbumped.userid)).toEqual([]);
      expect(await outboxOf(ctx, TENANT_A.tenantId, unbumped.userid)).toEqual([]);
      expect(await targetChanges(ctx, TENANT_A.tenantId)).toEqual([]);
      expect(ctx.publisher.published).toEqual([]);
    });
  });
});
