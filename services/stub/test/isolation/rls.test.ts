/** Row-level-security isolation of the stub schema, its repository writes, its event consumers and its note routes against PostgreSQL. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSUMER_AGGREGATE_VERSION_TABLE, INBOX_TABLE, type EventEnvelope } from '@opt2/platform/events';
import { CHANGELOG_TABLE } from '@opt2/platform/migration-kit';
import { createPool, writeGrant, type SiteChangedPayload, type TenantTx } from '@opt2/platform/tenancy';
import {
  PLATFORM_TABLE_GROUPS,
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  checkCatalog,
  createCapturingPublisher,
  createThrowawaySchema,
  defineIsolationSuite,
  expectPlatformTables,
  fixtureForTenant,
  pgAvailable,
  pushTo,
  registryPayloads,
  seedRegistry,
  testEnvelope,
  testPgConfig,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  NOTE_COMMENT_GRANT,
  commentToRow,
  newComment,
  noteCommentedPayload,
  type NoteActivityRow,
  type NoteCommentRow,
  type NoteCommentedPayload,
} from '../../src/domain/comment.js';
import { newNote, noteCreatedPayload, noteToRow, type Note, type NoteProjectionRow, type NoteRow } from '../../src/domain/note.js';
import { noteProjectionConsumer } from '../../src/events/consumers.js';
import {
  NOTE_COMMENTED_SUBSCRIPTION,
  NOTE_COMMENTED_TOPIC,
  NOTE_CREATED_SUBSCRIPTION,
  NOTE_CREATED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
} from '../../src/events/topics.js';
import { createStubRepository, type StubRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, buildDbApp, headersFor } from '../helpers/app.js';

type AppContext = Awaited<ReturnType<typeof buildDbApp>>;
type Method = 'GET' | 'POST' | 'DELETE';
type Row = Record<string, unknown>;
type NoteCreatedPayload = ReturnType<typeof noteCreatedPayload>;

/** The legacy envelope fields the routes answer with. */
interface Envelope {
  apiversion?: string;
  method?: string;
  params?: unknown;
  data?: unknown;
  error?: { message?: string; code?: string };
}

interface Reply {
  status: number;
  body: Envelope;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const TABLES = ['note', 'note_projection', 'note_comment', 'note_activity'] as const;
// Platform tables the consumers write besides the note tables: receipts, state versions and the projection changelog.
const CONSUMER_PLATFORM_TABLES: readonly string[] = [CHANGELOG_TABLE, INBOX_TABLE, CONSUMER_AGGREGATE_VERSION_TABLE];
const SUITE_TABLES = [...TABLES, ...CONSUMER_PLATFORM_TABLES];
const ALL_PLATFORM_GROUPS = Object.keys(PLATFORM_TABLE_GROUPS) as PlatformTableGroup[];
const NOTES_URL = '/opt2/stub/notes';
const WHOLE_LIST = `${NOTES_URL}?limit=1000`;
const FOREIGN_TENANTS: readonly TenantFixture[] = [TENANT_B, TENANT_UMBRELLA];
/** Tenant A note the grant case stores and grants `note-comment` on. */
const GRANT_NOTE = newNote({ title: 'rls grant', body: '' }, TEST_CLOCK);

const RLS_FLAGS_SQL = `
SELECT c.relname::text AS relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
 ORDER BY c.relname`;

const available = await pgAvailable();

const publisher = createCapturingPublisher();
/** The note writeAs stored for each tenant, by tenant id. */
const storedNotes = new Map<string, Note>();
let schema: ThrowawaySchema | undefined;
let repository: StubRepository | undefined;
let ctx: AppContext | undefined;

/** What the outer beforeAll built; throws when building it failed. */
function built(): { schema: ThrowawaySchema; repository: StubRepository; ctx: AppContext } {
  if (schema === undefined || repository === undefined || ctx === undefined) {
    throw new Error('The throwaway stub schema or app was not built; see the beforeAll failure');
  }
  return { schema, repository, ctx };
}

/** The suite repository reached at call time, since the fan-out case's consumer exists before the throwaway schema does. */
const suiteRepository = new Proxy({} as StubRepository, {
  get: (_target, name) => Reflect.get(built().repository, name) as unknown,
});

/** A fresh note of `tenant`, as the create route builds it. */
function noteFor(tenant: TenantFixture): Note {
  return newNote({ title: `rls ${tenant.key}`, body: '' }, TEST_CLOCK);
}

/** A fresh `note` row of `tenant`, as the create route builds it. */
function noteRowFor(tenant: TenantFixture): NoteRow {
  return noteToRow(noteFor(tenant));
}

/** A projection row of `tenant` for `noteId`, a fresh note id by default. */
function projectionRowFor(tenant: TenantFixture, noteId?: string): NoteProjectionRow {
  const note = newNote({ title: `rls ${tenant.key}`, body: '' }, TEST_CLOCK);
  return {
    note_id: noteId ?? note.noteId,
    title: note.title,
    body: note.body,
    created: note.created,
    aggregate_version: 1,
    apply_count: 1,
    last_event_id: randomUUID(),
    projected_at: note.created,
  };
}

/** A comment row of `tenant` on a fresh note id, as the comment route builds it. */
function commentRowFor(tenant: TenantFixture): NoteCommentRow {
  return commentToRow(newComment(noteFor(tenant).noteId, tenant.siteId, `rls ${tenant.key}`, TEST_CLOCK));
}

/** An activity row of `tenant` for a fresh event, note and comment, as the comment consumer builds it. */
function activityRowFor(tenant: TenantFixture): NoteActivityRow {
  const comment = commentRowFor(tenant);
  return { event_id: randomUUID(), note_id: comment.note_id, comment_id: comment.comment_id, aggregate_version: 2, applied_at: comment.created };
}

function rowFor(table: string, tenant: TenantFixture): Row {
  switch (table) {
    case 'note':
      return noteRowFor(tenant);
    case 'note_projection':
      return projectionRowFor(tenant);
    case 'note_comment':
      return commentRowFor(tenant);
    case 'note_activity':
      return activityRowFor(tenant);
    case CHANGELOG_TABLE:
      return { table: 'note', op: 'insert', key: noteFor(tenant).noteId, after: 's0:', origin: 'target' };
    case INBOX_TABLE:
      return { event_id: randomUUID(), subscription: NOTE_CREATED_SUBSCRIPTION, status: 'applied' };
    case CONSUMER_AGGREGATE_VERSION_TABLE:
      return { subscription: NOTE_CREATED_SUBSCRIPTION, aggregate_type: 'note', aggregate_id: `isolation-${randomUUID()}`, last_version: 1 };
    default:
      throw new TypeError(`The stub has no tenant table ${table}`);
  }
}

/**
 * Writes one row of `table` for `tenant`: note tables through the stub repository, so the unit gate and changelog hooks run,
 * platform tables by INSERT. Records the stored note as the tenant's, for its note event.
 */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const stub = built().repository;
  if (table === 'note') {
    const note = noteFor(tenant);
    await stub.insert(tx, 'note', noteToRow(note));
    storedNotes.set(tx.tenantId, note);
  } else if (table === 'note_projection') {
    await stub.upsertProjection(tx, projectionRowFor(tenant));
  } else if (table === 'note_comment') {
    await stub.insert(tx, 'note_comment', commentRowFor(tenant));
  } else if (table === 'note_activity') {
    await stub.insertActivity(tx, activityRowFor(tenant));
  } else {
    const values: Row = { tenant_id: tx.tenantId, ...rowFor(table, tenant) };
    const columns = Object.keys(values);
    const placeholders = columns.map((_, index) => `$${String(index + 1)}`);
    await tx.query(
      `INSERT INTO "${tx.schema}"."${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
      Object.values(values),
    );
  }
}

/** A `stub.note.created.v1` envelope of the note writeAs stored for `tenantId`, keyed as the stub's outbox writes it. */
function noteCreatedEnvelope(tenantId: string): EventEnvelope<NoteCreatedPayload> {
  const note = storedNotes.get(tenantId);
  if (note === undefined) {
    throw new Error(`No note is stored for tenant ${tenantId}; the isolation suite's seed stores one per tenant`);
  }
  return testEnvelope({
    topic: NOTE_CREATED_TOPIC,
    tenantId,
    aggregateType: 'note',
    aggregateId: note.noteId,
    aggregateVersion: note.rowVersion,
    payload: noteCreatedPayload(note),
  });
}

/** A `stub.note.commented.v1` envelope of a new comment on the note writeAs stored for `tenantId`. */
function noteCommentedEnvelope(tenantId: string): EventEnvelope<NoteCommentedPayload> {
  const note = noteCreatedEnvelope(tenantId).payload;
  const site = fixtureForTenant(tenantId)?.siteId ?? TENANT_A.siteId;
  return testEnvelope({
    topic: NOTE_COMMENTED_TOPIC,
    tenantId,
    aggregateType: 'note',
    aggregateId: note.noteId,
    aggregateVersion: 2,
    payload: noteCommentedPayload(newComment(note.noteId, site, 'rls comment', TEST_CLOCK)),
  });
}

/** Comments on the grant note as a system user of `acting`, naming `grantor`'s site; allowed on 200, denied on the legacy 404. */
async function commentAsGrantee(grantor: TenantFixture, acting: TenantFixture): Promise<'allowed' | 'denied'> {
  const url = `${NOTES_URL}/${GRANT_NOTE.noteId}/comments`;
  const reply = await send('POST', url, 'system-user', acting, { grantorsiteid: grantor.siteId, body: `rls ${acting.key}` });
  if (reply.status === 200) return 'allowed';
  if (reply.status === 404) return 'denied';
  throw new Error(`a ${acting.key} comment on the ${grantor.key} grant note answered ${reply.status}`);
}

/** A contract-valid site.changed envelope re-announcing the fixture site of `tenantId` at version 2 with one more domain. */
function siteChangedEnvelope(tenantId: string): EventEnvelope<SiteChangedPayload> {
  const fixture = fixtureForTenant(tenantId);
  const payload = registryPayloads().find((entry) => entry.siteId === fixture?.siteId);
  if (fixture === undefined || payload === undefined) {
    throw new TypeError(`No fixture site has tenant ${tenantId}`);
  }
  return testEnvelope({
    topic: SITE_CHANGED_TOPIC,
    tenantId,
    aggregateId: fixture.siteId,
    aggregateVersion: 2,
    payload: { ...payload, domains: [...(payload.domains ?? []), `isolation.${fixture.siteId}.opt2.test`] },
  });
}

/** Every row of `table` visible in `tx`; RLS is the only filter. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** Injects a request as the `ROLE_SET` subject `subject` holding a token for `tenant`'s site. */
async function send(method: Method, url: string, subject: string, tenant: TenantFixture, payload?: Record<string, string>): Promise<Reply> {
  const headers = await headersFor(subject, { site: tenant.siteId });
  const res = await built().ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { status: res.statusCode, body: res.json<Envelope>() };
}

/** The status and envelope of an answer, without its id-bearing params. */
function answerOf({ status, body }: Reply): Omit<Envelope, 'params' | 'data'> & { status: number } {
  return { status, apiversion: body.apiversion, method: body.method, error: body.error };
}

function listedIds(reply: Reply): string[] {
  const items = (reply.body.data as { items?: Array<{ noteid: string }> } | undefined)?.items ?? [];
  return items.map((item) => item.noteid);
}

describe.skipIf(!available)('rls-isolation', () => {
  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'stub', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    repository = createStubRepository({ clock: TEST_CLOCK, schema: schema.schema });
    ctx = await buildDbApp(schema, { publisher });
  });

  afterAll(async () => {
    try {
      await ctx?.app.close();
    } finally {
      await schema?.drop();
    }
    if (schema === undefined) return;
    const dropped = { schema: schema.schema, roles: Object.values(schema.roles) };
    const pg = testPgConfig();
    const probe = await createPool({
      env: { OPT2_DB_AUTH: 'password', PG_HOST: pg.host, PG_PORT: pg.port, PG_DATABASE: pg.database, PG_USER: pg.user, PG_PASSWORD: pg.password },
      schema: 'public',
      max: 1,
    });
    try {
      const left = await probe.withMetadata(async (tx) => ({
        schemas: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1', [dropped.schema])).rows[0]?.n,
        roles: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1::text[])', [dropped.roles])).rows[0]?.n,
      }));
      expect(left, `objects of ${dropped.schema} left after drop`).toEqual({ schemas: 0, roles: 0 });
    } finally {
      await probe.end();
    }
  });

  describe('catalog', () => {
    it('tenant tables force RLS with USING and WITH CHECK', async () => {
      const db = built().schema;
      expect(await checkCatalog(db)).toEqual([]);
      const { rows } = await db.adminPool.query(RLS_FLAGS_SQL, [db.schema, [...TABLES]]);
      expect(rows).toEqual([...TABLES].sort().map((relname) => ({ relname, enabled: true, forced: true })));
    });

    it('platform tables present', async () => {
      await expectPlatformTables(built().schema, { groups: ALL_PLATFORM_GROUPS });
    });
  });

  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => schema,
      name: 'stub note tables',
      tables: SUITE_TABLES,
      writeAs,
      readAs,
      rowFor,
      events: [
        { app: () => ctx?.app, subscription: NOTE_CREATED_SUBSCRIPTION, envelopeFor: noteCreatedEnvelope, publisher },
        { app: () => ctx?.app, subscription: SITE_CHANGED_SUBSCRIPTION, envelopeFor: siteChangedEnvelope, publisher },
        { app: () => ctx?.app, subscription: NOTE_COMMENTED_SUBSCRIPTION, envelopeFor: noteCommentedEnvelope, publisher },
      ],
      fanout: {
        definition: noteProjectionConsumer(suiteRepository, TEST_CLOCK),
        envelopeFrom: (tenant) => noteCreatedEnvelope(tenant.tenantId),
        effectsIn: async (tx) => (await readAs(tx, 'note_projection')).length,
      },
      grant: {
        kind: NOTE_COMMENT_GRANT,
        resourceId: GRANT_NOTE.noteId,
        async grant(tx, grantee) {
          await built().repository.insert(tx, 'note', noteToRow(GRANT_NOTE));
          await writeGrant(tx, { grantee: grantee.tenantId, kind: NOTE_COMMENT_GRANT, resourceId: GRANT_NOTE.noteId });
        },
        guardedWrite: commentAsGrantee,
      },
    },
  );

  describe('routes', () => {
    const missingId = newNote({ title: 'never stored', body: '' }, TEST_CLOCK).noteId;
    let noteId = '';

    beforeAll(async () => {
      const created = await send('POST', NOTES_URL, 'system-user', TENANT_A, { title: 'rls note', body: 'a' });
      expect(created.status).toBe(200);
      noteId = (created.body.data as { noteid: string }).noteid;
      const { schema: db, repository: stub } = built();
      await db.app.withTenant(TENANT_A.tenantId, (tx) => stub.upsertProjection(tx, projectionRowFor(TENANT_A, noteId)));
    });

    it('tenant A reads its note', async () => {
      const one = await send('GET', `${NOTES_URL}/${noteId}`, 'system-user', TENANT_A);
      const projection = await send('GET', `${NOTES_URL}/${noteId}/projection`, 'system-user', TENANT_A);
      const list = await send('GET', WHOLE_LIST, 'system-user', TENANT_A);

      expect([one.status, projection.status, list.status]).toEqual([200, 200, 200]);
      expect(one.body.data).toMatchObject({ noteid: noteId });
      expect(projection.body.data).toMatchObject({ noteid: noteId });
      expect(listedIds(list)).toContain(noteId);
    });

    // Delete requires s2; any other role answers 403 before the tenant's rows are reached.
    it.each(FOREIGN_TENANTS)('tenant $key gets 404 for the note', async (tenant) => {
      const probes = [
        ['GET', '', 'system-user'],
        ['GET', '/projection', 'system-user'],
        ['DELETE', '', 's2'],
      ] as const;
      for (const [method, suffix, subject] of probes) {
        const foreign = answerOf(await send(method, `${NOTES_URL}/${noteId}${suffix}`, subject, tenant));
        const missing = answerOf(await send(method, `${NOTES_URL}/${missingId}${suffix}`, subject, tenant));
        const label = `${method} note${suffix} as tenant ${tenant.key}`;

        expect(foreign, label).toMatchObject({ status: 404, apiversion: 'v1', error: { code: 'invalid_request' } });
        expect(foreign, label).toEqual(missing);
      }
    });

    it.each(FOREIGN_TENANTS)('tenant $key does not list the note', async (tenant) => {
      const list = await send('GET', WHOLE_LIST, 'system-user', tenant);

      expect(list.status).toBe(200);
      expect(listedIds(list)).not.toContain(noteId);
    });

    it('stores only the granted tenant comment on tenant A note, lists it to tenant A alone and applies its event once', async () => {
      const commentsUrl = `${NOTES_URL}/${noteId}/comments`;
      const granted = await send('POST', `${NOTES_URL}/${noteId}/grants`, 'system-user', TENANT_A, { granteesiteid: TENANT_B.siteId });
      const fromB = await send('POST', commentsUrl, 'system-user', TENANT_B, { grantorsiteid: TENANT_A.siteId, body: 'from b' });
      const fromUmbrella = await send('POST', commentsUrl, 'member', TENANT_UMBRELLA, { grantorsiteid: TENANT_A.siteId, body: 'from umbrella' });
      const listA = await send('GET', `${commentsUrl}?limit=1000`, 'system-user', TENANT_A);
      const listB = await send('GET', commentsUrl, 'system-user', TENANT_B);

      expect([granted.status, fromB.status, fromUmbrella.status, listA.status, listB.status]).toEqual([200, 200, 404, 200, 404]);
      const comment = fromB.body.data as { commentid: string; authorsiteid: string };
      expect((listA.body.data as { items: unknown[] }).items).toEqual([
        expect.objectContaining({ commentid: comment.commentid, authorsiteid: TENANT_B.siteId, body: 'from b' }),
      ]);

      const ofComment = ({ envelope }: (typeof publisher.published)[number]): boolean =>
        (envelope.payload as { commentId?: string }).commentId === comment.commentid;
      const event = publisher.published.find(ofComment)?.envelope;
      if (event === undefined) throw new Error(`no stub.note.commented.v1 event of comment ${comment.commentid} was published`);
      expect(event).toMatchObject({ tenantId: TENANT_A.tenantId, aggregateId: noteId, aggregateVersion: 2 });
      const deliveries = [];
      for (let copy = 0; copy < 2; copy += 1) deliveries.push((await pushTo(built().ctx.app, NOTE_COMMENTED_SUBSCRIPTION, event)).statusCode);
      expect(deliveries).toEqual([204, 204]);
      const activity = await built().schema.app.withTenant(TENANT_A.tenantId, async (tx) =>
        (await tx.query(`SELECT event_id, comment_id FROM "${tx.schema}".note_activity WHERE note_id = $1`, [noteId])).rows,
      );
      expect(activity).toEqual([{ event_id: event.eventId, comment_id: comment.commentid }]);
    });

    it('cross-tenant delete leaves the note', async () => {
      for (const tenant of FOREIGN_TENANTS) {
        expect((await send('DELETE', `${NOTES_URL}/${noteId}`, 's2', tenant)).status).toBe(404);
      }
      const own = await send('GET', `${NOTES_URL}/${noteId}`, 'system-user', TENANT_A);

      expect(own.status).toBe(200);
      expect(own.body.data).toMatchObject({ noteid: noteId });
    });
  });
});
