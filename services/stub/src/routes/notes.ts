/** Note routes of the stub under `/opt2/stub/notes`, answered in the Masa JSON API envelope. */
import { Roles } from '@opt2/platform/auth';
import {
  LegacyApiError,
  buildEnvelope,
  legacyErrorResponse,
  paramsWithoutMethod,
  serializeResponse,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import {
  legacyParamsOf,
  sendLegacyResponse,
  type Clock,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  formatNoteCursor,
  newNote,
  noteCreateSchema,
  noteFromRow,
  noteListQuerySchema,
  noteToRow,
  projectionFromRow,
} from '../domain/note.js';
import { writeNoteCreated } from '../events/note-created.js';
import type { components } from '../generated/openapi.js';
import type { StubRepository } from '../repo/repository.js';

interface NoteParams {
  noteId: components['parameters']['NoteId'];
}

// Declared here, as every service's route modules declare their deps; the registry's RouteDeps has the same shape.
/** Dependencies of `registerNoteRoutes`. */
export interface NoteRouteDeps {
  db: TenantDb;
  repository: StubRepository;
  clock: Clock;
}

const READ_ROLES = [Roles.member, Roles.systemUser, Roles.siteAdmin, Roles.s2] as const;
const CREATE_ROLES = [Roles.systemUser] as const;
const DELETE_ROLES = [Roles.s2] as const;

/** The verified token's tenant; user roles guarantee it, so its absence is an authorization failure. */
function tenantOf(request: FastifyRequest): string {
  const { tenantId } = request.opt2;
  if (tenantId === undefined) throw new LegacyApiError('authorization');
  return tenantId;
}

/** Sends `data` in the legacy envelope of `method`, or the legacy 404 error envelope when `data` is null. */
function sendResult(request: FastifyRequest, reply: FastifyReply, method: string, data: unknown): FastifyReply {
  const params = { ...legacyParamsOf(request), ...(request.params as Record<string, string>) };
  // The 404 service-kit answers for an unknown route, so another tenant's note is indistinguishable from a missing one.
  const response =
    data === null
      ? legacyErrorResponse('invalidMethodCall', { method, params, mura404: true })
      : serializeResponse(buildEnvelope({ method, params: paramsWithoutMethod(params), data }));
  return sendLegacyResponse(reply, response);
}

/** Registers the createNote, listNotes, getNote, getNoteProjection and deleteNote operations. */
export async function registerNoteRoutes(app: FastifyInstance, deps: NoteRouteDeps): Promise<void> {
  app.post(
    '/opt2/stub/notes',
    { config: { opt2: { transport: 'service', requires: CREATE_ROLES } } },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const input = noteCreateSchema.safeParse(legacyParamsOf(request));
      if (!input.success) throw new LegacyApiError('invalidParameters', { method: 'save' });
      // Built before the transaction, so a gate-race re-run inserts the same note.
      const note = newNote(input.data, deps.clock);
      await withGatedTenant(deps.db, tenantId, async (tx) => {
        await deps.repository.insert(tx, 'note', noteToRow(note));
        await writeNoteCreated(tx, note);
      });
      return sendResult(request, reply, 'save', note);
    },
  );

  app.get(
    '/opt2/stub/notes',
    { config: { opt2: { transport: 'service', requires: READ_ROLES } } },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const query = noteListQuerySchema.safeParse(legacyParamsOf(request));
      if (!query.success) throw new LegacyApiError('invalidParameters', { method: 'findMany' });
      const page = await deps.db.withTenant(tenantId, (tx) => deps.repository.listNotes(tx, query.data));
      const next = page.next === null ? null : formatNoteCursor(page.next);
      return sendResult(request, reply, 'findMany', { items: page.rows.map(noteFromRow), next });
    },
  );

  app.get<{ Params: NoteParams }>(
    '/opt2/stub/notes/:noteId',
    { config: { opt2: { transport: 'service', requires: READ_ROLES } } },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const row = await deps.db.withTenant(tenantId, (tx) => deps.repository.findNote(tx, request.params.noteId));
      return sendResult(request, reply, 'findOne', row === null ? null : noteFromRow(row));
    },
  );

  app.get<{ Params: NoteParams }>(
    '/opt2/stub/notes/:noteId/projection',
    { config: { opt2: { transport: 'service', requires: READ_ROLES } } },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const row = await deps.db.withTenant(tenantId, (tx) => deps.repository.findProjection(tx, request.params.noteId));
      return sendResult(request, reply, 'findProjection', row === null ? null : projectionFromRow(row));
    },
  );

  app.delete<{ Params: NoteParams }>(
    '/opt2/stub/notes/:noteId',
    { config: { opt2: { transport: 'service', requires: DELETE_ROLES } } },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const deleted = await withGatedTenant(deps.db, tenantId, (tx) => deps.repository.deleteNote(tx, request.params.noteId));
      return sendResult(request, reply, 'delete', deleted ? { deleted: true } : null);
    },
  );
}
