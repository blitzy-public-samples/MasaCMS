/** Grant and comment routes of a stub note under `/opt2/stub/notes/:noteId`, answered in the Masa JSON API envelope. */
import { Roles } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { hasGrant, tenantForRegisteredSite, writeGrant, type TenantDb } from '@opt2/platform/tenancy';
import {
  NOTE_COMMENT_GRANT,
  commentCreateSchema,
  commentFromRow,
  commentListQuerySchema,
  commentToRow,
  formatCommentCursor,
  newComment,
  noteGrantSchema,
} from '../domain/comment.js';
import { writeNoteCommented } from '../events/note-commented.js';
import { sendResult, tenantOf, type NoteParams, type NoteRouteDeps } from './notes.js';

const GRANT_ROLES = [Roles.systemUser] as const;
const COMMENT_ROLES = [Roles.member, Roles.systemUser, Roles.siteAdmin, Roles.s2] as const;

/** The verified token's site; user roles guarantee it, so its absence is an authorization failure. */
function siteOf(request: FastifyRequest): string {
  const { site } = request.opt2;
  if (site === undefined) throw new LegacyApiError('authorization');
  return site;
}

/**
 * The tenant holding the note a caller of `callerTenant` comments on as `grantorSiteId`'s: the caller's own tenant, or a grantor
 * that granted it `note-comment` on `noteId`; null for an unregistered site or a missing grant.
 */
async function commentTenant(db: TenantDb, callerTenant: string, grantorSiteId: string, noteId: string): Promise<string | null> {
  const grantor = await tenantForRegisteredSite(db, grantorSiteId);
  if (grantor === null || grantor.toLowerCase() === callerTenant.toLowerCase()) return grantor;
  return (await hasGrant(db, { grantor, grantee: callerTenant, kind: NOTE_COMMENT_GRANT, resourceId: noteId })) ? grantor : null;
}

/** Registers the createNoteGrant, createNoteComment and listNoteComments operations. */
export async function registerCommentRoutes(app: FastifyInstance, deps: NoteRouteDeps): Promise<void> {
  app.post<{ Params: NoteParams }>(
    '/opt2/stub/notes/:noteId/grants',
    { config: { opt2: { transport: 'service', requires: GRANT_ROLES } } },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const input = noteGrantSchema.safeParse(legacyParamsOf(request));
      if (!input.success) throw new LegacyApiError('invalidParameters', { method: 'save' });
      const { noteId } = request.params;
      const { granteesiteid } = input.data;
      const granted = await withGatedTenant(deps.db, tenantId, async (tx) => {
        if ((await deps.repository.findNote(tx, noteId)) === null) return false;
        const grantee = await tenantForRegisteredSite(tx, granteesiteid);
        if (grantee === null) throw new LegacyApiError('invalidParameters', { method: 'save' });
        await writeGrant(tx, { grantee, kind: NOTE_COMMENT_GRANT, resourceId: noteId });
        return true;
      });
      return sendResult(request, reply, 'save', granted ? { noteId, granteeSiteId: granteesiteid } : null);
    },
  );

  app.post<{ Params: NoteParams }>(
    '/opt2/stub/notes/:noteId/comments',
    { config: { opt2: { transport: 'service', requires: COMMENT_ROLES } } },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const site = siteOf(request);
      const input = commentCreateSchema.safeParse(legacyParamsOf(request));
      if (!input.success) throw new LegacyApiError('invalidParameters', { method: 'save' });
      const { noteId } = request.params;
      const noteTenant = await commentTenant(deps.db, tenantId, input.data.grantorsiteid, noteId);
      // Built before the transaction, so a gate-race re-run inserts the same comment.
      const comment = newComment(noteId, site, input.data.body, deps.clock);
      const stored =
        noteTenant !== null &&
        (await withGatedTenant(deps.db, noteTenant, async (tx) => {
          const version = await deps.repository.addComment(tx, commentToRow(comment));
          if (version === null) return false;
          await writeNoteCommented(tx, comment, version);
          return true;
        }));
      return sendResult(request, reply, 'save', stored ? comment : null);
    },
  );

  app.get<{ Params: NoteParams }>(
    '/opt2/stub/notes/:noteId/comments',
    { config: { opt2: { transport: 'service', requires: COMMENT_ROLES } } },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const query = commentListQuerySchema.safeParse(legacyParamsOf(request));
      if (!query.success) throw new LegacyApiError('invalidParameters', { method: 'findMany' });
      const { noteId } = request.params;
      const page = await deps.db.withTenant(tenantId, async (tx) =>
        (await deps.repository.findNote(tx, noteId)) === null ? null : deps.repository.listComments(tx, noteId, query.data),
      );
      const data =
        page === null
          ? null
          : { items: page.rows.map(commentFromRow), next: page.next === null ? null : formatCommentCursor(page.next) };
      return sendResult(request, reply, 'findMany', data);
    },
  );
}
