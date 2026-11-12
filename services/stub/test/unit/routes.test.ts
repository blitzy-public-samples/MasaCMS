/** Note routes of the stub: contract declarations, role and site denials, invalid input, and the note lifecycle over a throwaway PostgreSQL schema. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix } from '@opt2/platform/auth';
import type { EventEnvelope } from '@opt2/platform/events';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { WRITE_POSITION_HEADER_LC, registerWritePositionHeader, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_B,
  assertResponseMatchesOpenApi,
  authHeadersFor,
  createCapturingPublisher,
  createThrowawaySchema,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type RoleSubject,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { formatNoteCursor } from '../../src/domain/note.js';
import { noteProjectionConsumer } from '../../src/events/consumers.js';
import { writeNoteCreated } from '../../src/events/note-created.js';
import { NOTE_CREATED_SUBSCRIPTION, NOTE_CREATED_TOPIC, noteCreatedValidator } from '../../src/events/topics.js';
import type { StubNoteCreatedV1Payload } from '../../src/generated/events/stub.note.created.v1.js';
import { createStubRepository, type StubRepository } from '../../src/repo/repository.js';
import { registerNoteRoutes } from '../../src/routes/notes.js';

vi.mock('../../src/events/note-created.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/events/note-created.js')>();
  return { ...actual, writeNoteCreated: vi.fn(actual.writeNoteCreated) };
});

type Method = 'GET' | 'POST' | 'DELETE';
type ContractOperation = Record<string, unknown>;
type Payload = string | Record<string, unknown>;

/** A note as the routes serialize it. */
interface NoteJson {
  noteid: string;
  title: string;
  body: string;
  created: string;
  rowversion: string;
}

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const NOTE_PATHS = ['/opt2/stub/notes', '/opt2/stub/notes/{noteId}', '/opt2/stub/notes/{noteId}/projection'];
const NOTES_URL = '/opt2/stub/notes';
const UNKNOWN_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const NOTE_URL = `${NOTES_URL}/${UNKNOWN_ID}`;
const CREATED = '2026-06-30 12:00:00.000';
const JSON_BODY = { 'content-type': 'application/json' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const NOTE_BODY = { title: 'First note', body: 'Body text' };
const ROUTES: ReadonlyArray<readonly [Method, string]> = [
  ['POST', NOTES_URL],
  ['GET', NOTES_URL],
  ['GET', NOTE_URL],
  ['GET', `${NOTE_URL}/projection`],
  ['DELETE', NOTE_URL],
];
const INVALID_PARAMETERS = { message: 'Invalid parameters', code: 'invalid_request' };
const NOT_FOUND = { message: 'Invalid method call', code: 'invalid_request' };

const clock = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const logger = createLogger({ service: 'stub', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
const publisher = createCapturingPublisher();
const writeNoteCreatedSpy = vi.mocked(writeNoteCreated);
const available = await pgAvailable();

// Never queried: without PostgreSQL only the declaration, denial and validation cases run, and they answer before any transaction.
const NO_DB: TenantDb = {
  schema: 'stub',
  withTenant: () => Promise.reject(new Error('no database')),
  withMetadata: () => Promise.reject(new Error('no database')),
  end: () => Promise.resolve(),
};

let stateDir: string;
let handle: ThrowawaySchema | undefined;
let db: TenantDb = NO_DB;
let app: FastifyInstance;
let repository: StubRepository;
let spies: ReturnType<typeof spiedRepository>['spies'];
let run = 0;
let site: string;
let tenant: string;

/** The stub repository with each method the note routes call wrapped in a delegating spy. */
function spiedRepository(schema: string) {
  const real = createStubRepository({ clock, schema });
  const methods = {
    insert: vi.fn(real.insert.bind(real)),
    findNote: vi.fn(real.findNote.bind(real)),
    listNotes: vi.fn(real.listNotes.bind(real)),
    deleteNote: vi.fn(real.deleteNote.bind(real)),
    findProjection: vi.fn(real.findProjection.bind(real)),
  };
  return { repository: { ...real, ...methods } as StubRepository, spies: methods };
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-stub-routes-'));
  await writeTestSecrets(stateDir);
  if (available) {
    handle = await createThrowawaySchema({
      service: 'stub',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    // The service's shutdown ends its pool; drop() ends the throwaway pools itself.
    db = { ...handle.app, end: () => Promise.resolve() };
    createOutbox({
      service: 'stub',
      db,
      publisher,
      logger,
      clock,
      payloadValidators: { [NOTE_CREATED_TOPIC]: noteCreatedValidator },
    });
  }
});

afterAll(async () => {
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  run += 1;
  site = `stub-routes-${String(run)}`;
  tenant = tenantIdForSite(site);
  publisher.clear();
  writeNoteCreatedSpy.mockClear();
  ({ repository, spies } = spiedRepository(db.schema));
  app = await createService({
    name: 'stub',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8199',
      OPT2_SERVICE_NAME: 'stub',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('stub'),
    clock,
    pool: db,
    logger,
  });
  registerWritePositionHeader(app);
  await registerNoteRoutes(app, { db, repository, clock });
  await app.ready();
});

afterEach(async () => {
  await app.opt2.shutdown();
});

function subject(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No role subject ${name}`);
  return found;
}

/** Credentials of `name` with a user token for `tokenSite`, the test's own site by default. */
function headersAs(name: string, tokenSite: string = site): Promise<Record<string, string>> {
  return authHeadersFor(subject(name), { audience: 'stub', site: tokenSite });
}

/** Injects a request and checks the answer against the contract. */
async function send(method: Method, url: string, headers: Record<string, string>, payload?: Payload) {
  const res = await app.inject({ method, url, headers, payload });
  assertResponseMatchesOpenApi(OPENAPI, {
    method,
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return res;
}

function expectNoRepositoryCall(): void {
  for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
}

describe('route declarations', () => {
  it('match the contract operations', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith(NOTES_URL));
    const expected = NOTE_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: template.replace('{noteId}', ':noteId'),
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
          siteCheck: true,
        })),
    );
    expect(expected).toHaveLength(5);
    expect(declared).toEqual(expect.arrayContaining(expected));
    expect(declared).toHaveLength(5);
  });
});

describe('auth denials', () => {
  const denials: ReadonlyArray<readonly [Method, string, string, number]> = [
    ...ROUTES.flatMap(([method, url]) => [
      [method, url, 'anonymous', 401] as const,
      [method, url, 'service:gateway', 401] as const,
    ]),
    ['POST', NOTES_URL, 'member', 403],
    ['DELETE', NOTE_URL, 'member', 403],
    ['DELETE', NOTE_URL, 'system-user', 403],
    ['DELETE', NOTE_URL, 'editor', 403],
    ['DELETE', NOTE_URL, 'site-admin', 403],
  ];

  it.each(denials)('deny %s %s to %s with %i before any repository call', async (method, url, as, status) => {
    const headers = { ...(await headersAs(as)), ...(method === 'POST' ? JSON_BODY : {}) };
    const res = await send(method, url, headers, method === 'POST' ? NOTE_BODY : undefined);

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expectNoRepositoryCall();
  });

  it.each([
    ...ROUTES.map(([method, url]) => [method, `${url}?siteid=${TENANT_B.siteId}`, method === 'POST' ? NOTE_BODY : undefined] as const),
    ['POST', NOTES_URL, { ...NOTE_BODY, siteid: TENANT_B.siteId }] as const,
  ])('deny %s %s to s2 with 403 when a supplied siteid is not the token site', async (method, url, payload) => {
    const headers = { ...(await headersAs('s2')), ...(payload === undefined ? {} : JSON_BODY) };
    const res = await send(method, url, headers, payload);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expectNoRepositoryCall();
  });
});

describe('invalid input', () => {
  it.each([
    ['an absent title', JSON_BODY, { body: 'Body text' }],
    ['a blank title', JSON_BODY, { title: '   ', body: 'Body text' }],
    ['a title of 256 characters', JSON_BODY, { title: 'a'.repeat(256) }],
    ['a body of 10001 characters', JSON_BODY, { title: 'First note', body: 'b'.repeat(10001) }],
    ['an empty form title', FORM, 'title=&body=Body+text'],
  ])('POST answers invalidParameters for %s without writing a note', async (_label, contentType, payload) => {
    const res = await send('POST', NOTES_URL, { ...(await headersAs('system-user')), ...contentType }, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'save', error: INVALID_PARAMETERS });
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
    expectNoRepositoryCall();
    expect(writeNoteCreatedSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a limit of 0', '?limit=0'],
    ['a limit of 1001', '?limit=1001'],
    ['a limit that is not digits', '?limit=ten'],
    ['an after that is not a page cursor', '?after=not-a-cursor'],
  ])('GET list answers invalidParameters for %s without reading notes', async (_label, query) => {
    const res = await send('GET', `${NOTES_URL}${query}`, await headersAs('member'));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'findMany', error: INVALID_PARAMETERS });
    expectNoRepositoryCall();
  });
});

describe.skipIf(!available)('note lifecycle against PostgreSQL', () => {
  /** The tenant's stored notes by id, and its outbox rows and changelog entries in write order. */
  async function stored(tenantId: string) {
    return withTenant(db, tenantId, async (tx) => ({
      notes: (
        await tx.query<{ note_id: string; title: string; body: string; row_version: string }>(
          `SELECT note_id, title, body, row_version::text AS row_version FROM ${tx.schema}.note ORDER BY note_id`,
        )
      ).rows,
      outbox: (
        await tx.query<{ event_id: string; topic: string; kind: string; ordering_key: string; envelope: unknown; published: boolean }>(
          `SELECT event_id::text AS event_id, topic, kind, ordering_key, envelope, published_at IS NOT NULL AS published FROM ${tx.schema}.outbox ORDER BY seq`,
        )
      ).rows,
      changelog: (
        await tx.query<{ table: string; op: string; xid: string }>(`SELECT "table", op, xid::text AS xid FROM ${tx.schema}.changelog ORDER BY seq`)
      ).rows,
    }));
  }

  async function createNote(title: string): Promise<NoteJson> {
    const res = await send('POST', NOTES_URL, { ...(await headersAs('system-user')), ...JSON_BODY }, { title, body: `${title} body` });
    expect(res.statusCode).toBe(200);
    return res.json<{ data: NoteJson }>().data;
  }

  /** Applies the last published note event through the stub's own projection consumer, as its push delivery does. */
  async function consumeLastPublished(): Promise<EventEnvelope<StubNoteCreatedV1Payload>> {
    const envelope = publisher.published.at(-1)?.envelope as EventEnvelope<StubNoteCreatedV1Payload>;
    await withGatedTenant(db, envelope.tenantId, async (tx) => {
      await noteProjectionConsumer(repository, clock).apply(tx, envelope, {
        subscription: NOTE_CREATED_SUBSCRIPTION,
        messageId: '1',
        destinationTenantId: envelope.tenantId,
        isFanout: false,
        logger,
      });
    });
    return envelope;
  }

  it.each([
    ['a JSON body', JSON_BODY, (): Payload => NOTE_BODY],
    ['a form body with mixed-case names and the token site in upper case', FORM, (): Payload => `TITLE=First+note&Body=Body+text&SiteID=${site.toUpperCase()}`],
  ])('creates a note from %s with its outbox row in the same transaction', async (_label, contentType, payload) => {
    const res = await send('POST', NOTES_URL, { ...(await headersAs('system-user')), ...contentType }, payload());

    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: NoteJson }>();
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'save',
      data: { noteid: data.noteid, title: 'First note', body: 'Body text', created: CREATED, rowversion: '1' },
    });
    expect(isCfUuid(data.noteid)).toBe(true);

    const { notes, outbox, changelog } = await stored(tenant);
    const [published] = publisher.published;
    expect(notes).toEqual([{ note_id: data.noteid, title: 'First note', body: 'Body text', row_version: '1' }]);
    expect(published?.topic).toBe(NOTE_CREATED_TOPIC);
    expect(published?.envelope).toMatchObject({
      tenantId: tenant,
      aggregateType: 'note',
      aggregateId: data.noteid,
      aggregateVersion: 1,
      payload: { noteId: data.noteid, title: 'First note', body: 'Body text', created: CREATED, rowVersion: 1 },
    });
    expect(outbox).toEqual([
      {
        event_id: published?.envelope.eventId,
        topic: NOTE_CREATED_TOPIC,
        kind: 'state',
        ordering_key: data.noteid,
        envelope: published?.envelope,
        published: true,
      },
    ]);
    const insertTx = spies.insert.mock.calls[0]?.[0];
    expect(spies.insert).toHaveBeenCalledExactlyOnceWith(insertTx, 'note', {
      note_id: data.noteid,
      title: 'First note',
      body: 'Body text',
      created: CREATED,
      row_version: 1,
    });
    expect(writeNoteCreatedSpy).toHaveBeenCalledOnce();
    expect(writeNoteCreatedSpy.mock.calls[0]?.[0]).toBe(insertTx);
    expect(changelog.map(({ table, op }) => `${table}:${op}`)).toEqual(['note:insert']);
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBe(`stub=${changelog[0]?.xid ?? ''}`);
  });

  it('lists the tenant notes to a member in pages ordered by created then note id', async () => {
    const created = [await createNote('Note A'), await createNote('Note B'), await createNote('Note C')];
    const ordered = [...created].sort((a, b) => (a.noteid < b.noteid ? -1 : 1));
    const member = await headersAs('member');

    const first = await send('GET', `${NOTES_URL}?limit=2`, member);
    const next = formatNoteCursor({ created: CREATED, noteId: ordered[1]?.noteid ?? '' });
    const second = await send('GET', `${NOTES_URL}?LIMIT=2&after=${next}`, member);
    const whole = await send('GET', NOTES_URL, member);

    expect([first.statusCode, second.statusCode, whole.statusCode]).toEqual([200, 200, 200]);
    expect(first.json()).toEqual({ apiversion: 'v1', method: 'findMany', data: { items: ordered.slice(0, 2), next } });
    expect(second.json()).toEqual({ apiversion: 'v1', method: 'findMany', data: { items: ordered.slice(2), next: null } });
    expect(whole.json()).toEqual({ apiversion: 'v1', method: 'findMany', data: { items: ordered, next: null } });
    expect(spies.listNotes.mock.calls.map(([, page]) => page)).toEqual([
      { after: null, limit: 2 },
      { after: { created: CREATED, noteId: ordered[1]?.noteid }, limit: 2 },
      { after: null, limit: 50 },
    ]);
    expect(whole.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
  });

  it.each(['member', 'system-user', 'site-admin', 's2'])('reads a note and its consumed projection as %s', async (as) => {
    const note = await createNote('Projected note');
    const envelope = await consumeLastPublished();
    const headers = await headersAs(as);

    const read = await send('GET', `${NOTES_URL}/${note.noteid}`, headers);
    const projection = await send('GET', `${NOTES_URL}/${note.noteid}/projection?siteid=${site}`, headers);

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ apiversion: 'v1', method: 'findOne', data: note });
    expect(projection.statusCode).toBe(200);
    expect(projection.json()).toEqual({
      apiversion: 'v1',
      method: 'findProjection',
      data: {
        noteid: note.noteid,
        title: 'Projected note',
        body: 'Projected note body',
        created: CREATED,
        aggregateversion: '1',
        applycount: '1',
        lasteventid: envelope.eventId,
        projectedat: CREATED,
      },
    });
    expect(read.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
  });

  it('answers the legacy 404 for the projection of a note whose event is not consumed yet', async () => {
    const note = await createNote('Unprojected note');

    const res = await send('GET', `${NOTES_URL}/${note.noteid}/projection`, await headersAs('member'));

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: NOT_FOUND });
  });

  // An error envelope reports `invalid` for a method name legacy processRequest does not define, such as findProjection.
  it.each([
    ['GET', '', 'findOne'],
    ['GET', '/projection', 'invalid'],
    ['DELETE', '', 'delete'],
  ] as const)('answers %s of note%s with the legacy 404 reporting method %s for an unknown id and for another tenant note', async (method, suffix, reported) => {
    const note = await createNote('Tenant note');
    await consumeLastPublished();

    const unknown = await send(method, `${NOTES_URL}/${UNKNOWN_ID}${suffix}`, await headersAs('s2'));
    const foreign = await send(method, `${NOTES_URL}/${note.noteid}${suffix}`, await headersAs('s2', TENANT_B.siteId));
    const own = await send('GET', `${NOTES_URL}/${note.noteid}${suffix}`, await headersAs('s2'));

    for (const res of [unknown, foreign]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ apiversion: 'v1', method: reported, error: NOT_FOUND });
      expect(res.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
    }
    expect(own.statusCode).toBe(200);
  });

  it('deletes a note for s2 with its write position, then answers 404 for it', async () => {
    const note = await createNote('Doomed note');
    const s2 = await headersAs('s2');

    const deleted = await send('DELETE', `${NOTES_URL}/${note.noteid}?siteid=${site}`, s2);
    const { notes, changelog } = await stored(tenant);
    const again = await send('DELETE', `${NOTES_URL}/${note.noteid}`, s2);
    const read = await send('GET', `${NOTES_URL}/${note.noteid}`, s2);

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ apiversion: 'v1', method: 'delete', data: { deleted: true } });
    expect(notes).toEqual([]);
    expect(changelog.map(({ table, op }) => `${table}:${op}`)).toEqual(['note:insert', 'note:delete']);
    expect(deleted.headers[WRITE_POSITION_HEADER_LC]).toBe(`stub=${changelog[1]?.xid ?? ''}`);
    expect([again.statusCode, read.statusCode]).toEqual([404, 404]);
    expect(again.json()).toEqual({ apiversion: 'v1', method: 'delete', error: NOT_FOUND });
    expect(again.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
  });
});
