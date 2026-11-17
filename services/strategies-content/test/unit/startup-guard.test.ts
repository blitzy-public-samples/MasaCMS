/** Masa's start-up URL conversion predicate: the guard functions, every content write path and a forced violation rolled back. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_LIST, TENANT_UMBRELLA, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { approvalAction } from '../../src/domain/approvals.js';
import { publish as publishChangeset, rollback as rollbackChangeset, saveChangeset } from '../../src/domain/changesets.js';
import {
  carchUpdate,
  deleteAll,
  multiFileUpload,
  publish,
  saveContent,
  saveContentInTx,
  saveDraft,
  saveQuickEdit,
  updateObjectParams,
  type ContentDeps,
  type ContentInput,
  type ContentSaveSite,
  type SaveContentResult,
} from '../../src/domain/content.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor } from '../../src/domain/context.js';
import type { UploadedFile } from '../../src/domain/files.js';
import {
  StartupPredicateViolationError,
  applyFileBody,
  assertStartupSafe,
  violatesStartupPredicate,
  type StartupPredicateRow,
} from '../../src/domain/startup-guard.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, createMemoryStorage, createRecordingDb, withPgSchema } from '../helpers/app.js';
import { IDS, newId, seedAll } from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, subjectSessionId } from '../helpers/tokens.js';
import { uploadedFile } from '../helpers/uploads.js';

const SITE_ID = TENANT_A.siteId;
const HOME = IDS.content.root;

/** tenant-a's S2 administrator. */
const ADMIN: Actor = actorFromClaims(
  {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: SUBJECT_USER_IDS.s2,
    sid: subjectSessionId('s2'),
    tid: SUBJECT_CLAIMS.s2.tid,
    site: SUBJECT_CLAIMS.s2.site,
    roles: [...SUBJECT_CLAIMS.s2.roles],
    s2: SUBJECT_CLAIMS.s2.s2,
    epoch: 0,
    iat: 0,
    exp: 0,
  },
  'Admin User',
);

/** tenant-a's site settings: files pooled in the umbrella site, no site id in URLs. */
const SITE: ContentSaveSite = {
  siteId: SITE_ID,
  site: 'Tenant A',
  locking: 'None',
  contentApprovalScript: '',
  contentRejectionScript: '',
  contentPendingScript: '',
  contentCanceledScript: '',
  contactEmail: '',
  urls: {
    siteId: SITE_ID,
    scheme: 'http',
    domain: 'localhost',
    requestDomain: 'localhost',
    previewDomain: '',
    serverPort: '',
    context: '',
    siteIdInUrls: false,
    indexFileInUrls: false,
    hashUrls: false,
    useSSL: false,
    filePoolId: TENANT_UMBRELLA.siteId,
    configFileAssetPath: '',
    assetPath: '/sites',
    siteAssetPath: '/sites',
    fileStore: 'fileDir',
    legacyIndexFileLocation: false,
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  },
};

/** A row the predicate matches; each override can take one of its conditions away. */
const row = (overrides: Partial<StartupPredicateRow> = {}): StartupPredicateRow => ({ type: 'File', active: 1, body: null, filename: 'x', ...overrides });

/** A posted non-image file part. */
const part = (fileName: string, fieldName = 'newfile'): UploadedFile =>
  uploadedFile({ fieldName, fileName, contentType: 'application/pdf' }, Buffer.from(`bytes of ${fileName}`));

describe('violatesStartupPredicate', () => {
  it.each([
    { label: 'File', input: row() },
    { label: 'Link', input: row({ type: 'Link' }) },
    { label: 'link (case-insensitive collation)', input: row({ type: 'link' }) },
    { label: 'File with trailing spaces', input: row({ type: 'File  ' }) },
  ])('matches an active $label row with a null body and a filename', ({ input }) => {
    expect(violatesStartupPredicate(input)).toBe(true);
  });

  it.each([
    ['a Page', row({ type: 'Page' })],
    ['a Folder', row({ type: 'Folder' })],
    ['a Component', row({ type: 'Component' })],
    ['a row without a type', row({ type: null })],
    ['an inactive File', row({ active: 0 })],
    ['an empty-string body', row({ body: '' })],
    ['a set body', row({ body: 'x' })],
    ['a null filename', row({ filename: null })],
  ])('leaves out %s', (_label, input) => {
    expect(violatesStartupPredicate(input)).toBe(false);
  });
});

describe('applyFileBody', () => {
  it.each([
    { label: 'sets a File body to the uploaded filename', input: row(), upload: 'report.pdf', body: 'report.pdf', same: false },
    { label: 'keeps a File body without a new upload', input: row({ body: 'guide.pdf' }), upload: undefined, body: 'guide.pdf', same: true },
    { label: 'keeps a Link URL body', input: row({ type: 'Link', body: 'https://example.org/' }), upload: 'report.pdf', body: 'https://example.org/', same: true },
    { label: 'leaves a Page unchanged', input: row({ type: 'Page', body: '<p>x</p>' }), upload: 'report.pdf', body: '<p>x</p>', same: true },
  ])('$label', ({ input, upload, body, same }) => {
    const applied = applyFileBody({ ...input, contenthistid: 'H1' }, upload);
    expect(applied).toEqual({ ...input, contenthistid: 'H1', body });
    expect(violatesStartupPredicate(applied)).toBe(false);
    if (same) expect(applyFileBody(input, upload)).toBe(input);
  });
});

describe('assertStartupSafe', () => {
  it('returns for rows outside the predicate', () => {
    expect(assertStartupSafe([{ ...row({ body: 'a.pdf' }), contenthistid: 'H1' }, { ...row({ type: 'Link', body: 'https://example.org/' }), contenthistid: 'H2' }])).toBeUndefined();
  });

  it('throws StartupPredicateViolationError naming the first violating version', () => {
    let caught: unknown;
    try {
      assertStartupSafe([
        { ...row({ body: 'a.pdf' }), contenthistid: 'H1' },
        { ...row({ type: 'Link' }), contenthistid: 'H2' },
        { ...row(), contenthistid: 'H3' },
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StartupPredicateViolationError);
    expect(caught).toMatchObject({ name: 'StartupPredicateViolationError', contentHistId: 'H2' });
  });
});

const CONTENT_INSERT = /^INSERT INTO "content"\."content" \(/;

/** The row a single-row `INSERT INTO <table> (columns) VALUES ($1, …)` binds, by column. */
function boundRow(sql: string, params: readonly unknown[]): Record<string, unknown> {
  const columns = (/^INSERT INTO \S+ \(([^)]*)\)/.exec(sql)?.[1] ?? '').split(', ').map((column) => column.replace(/"/g, ''));
  return Object.fromEntries(columns.map((column, i) => [column, params[i]]));
}

describe('a forced violation over the recording pool', () => {
  it('raises StartupPredicateViolationError for the inserted bodyless Link version and rolls its transaction back', async () => {
    const db = createRecordingDb();
    // The pool answers the version insert with its bound row and an identity value, as PostgreSQL's RETURNING would.
    db.respond(CONTENT_INSERT, (params, sql) => [{ ...boundRow(sql, params), tcontent_id: 1 }]);
    const deps: ContentDeps = { db, repository: createContentRepository({ clock: TEST_CLOCK }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS };
    const link = new Map<string, unknown>([
      ['siteid', SITE_ID],
      ['parentid', HOME],
      ['type', 'Link'],
      ['title', 'Bodyless Link'],
      ['body', ''],
      ['approved', 1],
    ]);

    const error: unknown = await db
      .withTenant(ADMIN.tenantId, (tx) => saveContentInTx(tx, deps, ADMIN, SITE, link, { memberships: { groupIds: [] }, poolCategories: [] }))
      .then(() => undefined, (err: unknown) => err);

    expect(error).toBeInstanceOf(StartupPredicateViolationError);
    const insertAt = db.statements.findIndex((statement) => CONTENT_INSERT.test(statement.sql));
    const inserted = db.statements[insertAt];
    if (inserted === undefined) throw new Error('no content version insert was recorded');
    const bound = boundRow(inserted.sql, inserted.params);
    expect(bound).toMatchObject({ type: 'Link', active: 1, body: null });
    expect(bound.filename).toEqual(expect.any(String));
    expect(error).toMatchObject({ contentHistId: bound.contenthistid });
    expect(inserted.tenantId).toBe(ADMIN.tenantId);
    const after = db.statements.slice(insertAt + 1).map((statement) => statement.sql);
    expect(after.find((sql) => /^(COMMIT|ROLLBACK)$/i.test(sql))).toBe('ROLLBACK');
    expect(db.statements.map((statement) => statement.sql)).not.toContain('COMMIT');
  });
});

// The write paths read back the versions they write, which the recording pool cannot answer, so they run on a seeded throwaway schema.
describe.skipIf(!(await pgAvailable()))('content write paths over a seeded schema', () => {
  let handle: ThrowawaySchema;
  let deps: ContentDeps;

  /** tenant-a `content` rows matching `where`, in insertion order. */
  const rows = (where: string, params: unknown[] = []): Promise<ContentRow[]> =>
    handle.app.withTenant(TENANT_A.tenantId, async (tx) => (await tx.query<ContentRow>(`SELECT * FROM ${handle.schema}.content WHERE ${where} ORDER BY tcontent_id`, params)).rows);
  const active = async (contentId: string): Promise<ContentRow | undefined> => (await rows('contentid = $1 AND active = 1', [contentId]))[0];

  /** Rows of every fixture tenant that Masa's start-up query selects (SQL Server compares `type` case-insensitively). */
  async function startupCandidates(): Promise<ContentRow[]> {
    const found: ContentRow[] = [];
    for (const tenant of TENANT_LIST) {
      const sql = `SELECT * FROM ${handle.schema}.content WHERE lower(rtrim(type)) IN ('file', 'link') AND active = 1 AND body IS NULL AND filename IS NOT NULL`;
      found.push(...(await handle.app.withTenant(tenant.tenantId, async (tx) => (await tx.query<ContentRow>(sql)).rows)));
    }
    return found;
  }

  /** Neither the rows a write reports nor any stored row match the start-up predicate. */
  async function expectPredicateEmpty(written: readonly ContentRow[] = []): Promise<void> {
    expect(written.filter((stored) => violatesStartupPredicate(stored))).toEqual([]);
    expect(await startupCandidates()).toEqual([]);
  }

  const save = (input: ContentInput, files: UploadedFile[] = []): Promise<SaveContentResult> =>
    saveContent(deps, ADMIN, SITE, { siteid: SITE_ID, parentid: HOME, approved: 1, ...input }, { files });

  /** A published File item whose body is its upload's `fileName`. */
  const newFile = async (title: string, fileName: string) => (await save({ type: 'File', title }, [part(fileName)])).bean;

  /** A published item and its later draft: a File draft with a new upload, or a Link draft with a new URL. */
  async function itemWithDraft(type: 'File' | 'Link', slug: string, changesetid?: string) {
    const firstBody = type === 'File' ? `${slug}.pdf` : `https://example.com/${slug}`;
    const body = type === 'File' ? `${slug}-v2.pdf` : `https://example.com/${slug}/v2`;
    const first = type === 'File' ? await newFile(slug, firstBody) : (await save({ type, title: slug, body: firstBody })).bean;
    const draft = await saveDraft(
      deps,
      ADMIN,
      SITE,
      { siteid: SITE_ID, contentid: first.contentId(), parentid: HOME, type, title: `${slug} v2`, ...(type === 'Link' ? { body } : {}), ...(changesetid === undefined ? {} : { changesetid }) },
      { files: type === 'File' ? [part(body)] : [] },
    );
    expect(draft.errors).toEqual({});
    return { contentId: first.contentId(), firstHistId: first.contentHistId(), firstBody, draft, body };
  }

  beforeAll(async () => {
    handle = await withPgSchema();
    await seedAll(handle);
    deps = {
      db: handle.app,
      repository: createContentRepository({ clock: TEST_CLOCK, schema: handle.schema }),
      clock: TEST_CLOCK,
      config: CONTENT_CONFIG_DEFAULTS,
      storage: createMemoryStorage(),
    };
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('starts from a seed whose File and Link nodes carry bodies, so the predicate is empty', async () => {
    expect(await active(IDS.content.fileNode)).toMatchObject({ type: 'File', body: 'guide.pdf', filename: 'guide' });
    expect(await active(IDS.content.linkNode)).toMatchObject({ type: 'Link', body: 'https://example.org/', filename: 'example-link' });
    await expectPredicateEmpty();
  });

  it.each([
    { entry: 'saveContent', type: 'File', slug: 'added-file', link: undefined },
    { entry: 'saveContent', type: 'Link', slug: 'added-link', link: 'https://example.com/added-link' },
    { entry: 'carch.update add', type: 'File', slug: 'carch-file', link: undefined },
    { entry: 'carch.update add', type: 'Link', slug: 'carch-link', link: 'https://example.com/carch-link' },
  ])('$entry of a new $type stores the upload filename or URL as its body', async ({ entry, type, slug, link }) => {
    const files = link === undefined ? [part(`${slug}.pdf`)] : [];
    const input: ContentInput = { siteid: SITE_ID, parentid: HOME, type, title: slug, approved: 1, ...(link === undefined ? {} : { body: link }) };
    let written: ContentRow[] = [];
    if (entry === 'saveContent') {
      written = (await saveContent(deps, ADMIN, SITE, input, { files })).written;
    } else {
      const result = await carchUpdate(deps, ADMIN, SITE, {
        rc: { ...input, action: 'add', topid: HOME },
        files,
        validateCsrf: () => true,
        session: { openSectionList: '', multiFileUpload: false },
        accessControlOriginDomains: 'localhost',
      });
      expect(result.outcome.kind).toBe('redirect');
    }
    const [stored] = await rows('title = $1 AND active = 1', [slug]);
    expect(stored).toMatchObject({ type, approved: 1, body: link ?? `${slug}.pdf` });
    expect(stored?.filename).toEqual(expect.any(String));
    await expectPredicateEmpty(written);
  });

  it('saveDraft of a File with a new upload and of a Link with a new URL keeps both bodies', async () => {
    const file = await itemWithDraft('File', 'draft-file');
    const link = await itemWithDraft('Link', 'draft-link');
    expect(file.draft.written).toContainEqual(expect.objectContaining({ active: 0, approved: 0, body: file.body }));
    expect(link.draft.written).toContainEqual(expect.objectContaining({ active: 0, approved: 0, body: link.body }));
    expect(await active(file.contentId)).toMatchObject({ body: file.firstBody });
    await expectPredicateEmpty([...file.draft.written, ...link.draft.written]);
  });

  it('publish of a File, with and without a new upload, and of a Link activates a bodied version', async () => {
    const fileId = (await newFile('publish-file', 'publish-file.pdf')).contentId();
    const node = { siteid: SITE_ID, contentid: fileId, parentid: HOME, type: 'File', title: 'publish-file' };
    const kept = await publish(deps, ADMIN, SITE, node);
    expect(await active(fileId)).toMatchObject({ contenthistid: kept.bean.contentHistId(), body: 'publish-file.pdf' });
    const replaced = await publish(deps, ADMIN, SITE, node, { files: [part('publish-file-2.pdf')] });
    expect(await active(fileId)).toMatchObject({ contenthistid: replaced.bean.contentHistId(), body: 'publish-file-2.pdf' });
    const linkId = (await save({ type: 'Link', title: 'publish-link', body: 'https://example.com/publish-link' })).bean.contentId();
    const link = await publish(deps, ADMIN, SITE, { siteid: SITE_ID, contentid: linkId, parentid: HOME, type: 'Link', title: 'publish-link', body: 'https://example.com/publish-link/v2' });
    expect(await active(linkId)).toMatchObject({ contenthistid: link.bean.contentHistId(), body: 'https://example.com/publish-link/v2' });
    const written = [kept, replaced, link].flatMap((result) => result.written);
    expect(written.filter((stored) => stored.active === 0).length).toBeGreaterThan(0);
    await expectPredicateEmpty(written);
  });

  it.each(['File', 'Link'] as const)('approvalAction approve activates a %s draft through approveVersion with its body', async (type) => {
    const item = await itemWithDraft(type, `approved-${type.toLowerCase()}`);
    const requestId = newId();
    await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      deps.repository.approvals.insertRequest(tx, {
        requestid: requestId,
        contenthistid: item.draft.bean.contentHistId(),
        siteid: SITE_ID,
        chainid: newId(),
        groupid: newId(),
        status: 'Pending',
      }),
    );
    const result = await approvalAction(deps, ADMIN, SITE, { requestId, action: 'approve', comment: '' });
    expect(result.errors).toEqual({});
    expect(await active(item.contentId)).toMatchObject({ type, approved: 1, title: `approved-${type.toLowerCase()} v2`, body: item.body });
    await expectPredicateEmpty();
  });

  it('saveQuickEdit of a File leaves its body untouched and non-null', async () => {
    const file = await newFile('quick-file', 'quick-file.pdf');
    const result = await saveQuickEdit(deps, ADMIN, SITE, { rc: { siteid: SITE_ID, contentid: file.contentId(), attribute: 'isnav', isnav: 0 }, csrfValid: true });
    expect(result?.errors).toEqual({});
    expect(await active(file.contentId())).toMatchObject({ contenthistid: result?.bean.contentHistId(), isnav: 0, body: 'quick-file.pdf' });
    await expectPredicateEmpty(result?.written);
  });

  it('updateObjectParams on a File saves a new active version that keeps its body', async () => {
    const file = await newFile('objects-file', 'objects-file.pdf');
    const saved = await updateObjectParams(deps, ADMIN, SITE, {
      siteid: SITE_ID,
      contenthistid: file.contentHistId(),
      approved: 1,
      params: '{"a":1}',
      regionid: 2,
      object: 'text',
      objectid: 'obj1',
      name: 'Text',
    });
    expect(saved?.contentHistId()).not.toBe(file.contentHistId());
    expect(await active(file.contentId())).toMatchObject({ contenthistid: saved?.contentHistId(), body: 'objects-file.pdf' });
    await expectPredicateEmpty();
  });

  it('multiFileUpload of two non-image files, one request each, adds two File items with bodies', async () => {
    const names = ['brochure-a.pdf', 'brochure-b.pdf'];
    for (const name of names) {
      const item = await multiFileUpload(deps, ADMIN, SITE, {
        siteId: SITE_ID,
        parentId: HOME,
        subType: 'Default',
        approved: 1,
        files: [part(name, 'files')],
        extraParams: JSON.stringify({ body: name }),
      });
      expect(item).toMatchObject({ filename: name, body: name });
    }
    expect((await rows('title = ANY($1)', [names])).map((stored) => [stored.title, stored.type, stored.active, stored.body])).toEqual(
      names.map((name) => [name, 'File', 1, name]),
    );
    await expectPredicateEmpty();
  });

  it('deleteAll of a section holding a File and a Link trashes all three and leaves no violating row', async () => {
    const section = (await save({ type: 'Folder', title: 'doomed-section' })).bean;
    const file = (await save({ parentid: section.contentId(), type: 'File', title: 'doomed-file' }, [part('doomed-file.pdf')])).bean;
    const link = (await save({ parentid: section.contentId(), type: 'Link', title: 'doomed-link', body: 'https://example.com/doomed' })).bean;
    const ids = [section, file, link].map((bean) => bean.contentId());

    expect(await deleteAll(deps, ADMIN, SITE, { contentId: section.contentId(), siteId: SITE_ID })).toEqual({ aborted: false, topId: HOME });

    expect(await rows('contentid = ANY($1)', [ids])).toEqual([]);
    const trash = await handle.app.withTenant(TENANT_A.tenantId, async (tx) =>
      (await tx.query<{ objectid: string; objectclass: string }>(`SELECT objectid, objectclass FROM ${handle.schema}.trash WHERE objectid = ANY($1)`, [ids])).rows,
    );
    expect(trash.map((entry) => entry.objectid).sort()).toEqual([...ids].sort());
    expect(new Set(trash.map((entry) => entry.objectclass))).toEqual(new Set(['content']));
    await expectPredicateEmpty();
  });

  it('change-set publish activates the assigned File and Link versions with their bodies', async () => {
    const changesetId = IDS.changesets.scheduledFuture;
    const file = await itemWithDraft('File', 'release-file', changesetId);
    const link = await itemWithDraft('Link', 'release-link', changesetId);

    expect((await publishChangeset(deps, ADMIN, SITE, changesetId)).published).toBe(true);

    expect(await active(file.contentId)).toMatchObject({ title: 'release-file v2', approved: 1, body: file.body });
    expect(await active(link.contentId)).toMatchObject({ title: 'release-link v2', approved: 1, body: link.body });
    await expectPredicateEmpty();
  });

  it('change-set rollback re-activates the replaced File and Link versions with their bodies', async () => {
    const changesetId = newId();
    expect((await saveChangeset(deps, ADMIN, { changesetid: changesetId, siteid: SITE_ID, name: 'Rolled Back Release' })).redirect).toBe(true);
    const file = await itemWithDraft('File', 'rollback-file', changesetId);
    const link = await itemWithDraft('Link', 'rollback-link', changesetId);
    expect((await publishChangeset(deps, ADMIN, SITE, changesetId)).published).toBe(true);

    await rollbackChangeset(deps, ADMIN, SITE, changesetId);

    expect(await active(file.contentId)).toMatchObject({ body: file.firstBody });
    expect(await active(link.contentId)).toMatchObject({ body: link.firstBody });
    await expectPredicateEmpty();
  });

  it('a publish clearing a Link body fails before commit, keeping the previous active version', async () => {
    const link = (await save({ type: 'Link', title: 'cleared-link', body: 'https://example.com/cleared' })).bean;

    await expect(
      publish(deps, ADMIN, SITE, { siteid: SITE_ID, contentid: link.contentId(), parentid: HOME, type: 'Link', title: 'cleared-link', body: '' }),
    ).rejects.toBeInstanceOf(StartupPredicateViolationError);

    expect((await rows('contentid = $1', [link.contentId()])).map((stored) => [stored.contenthistid, stored.active, stored.body])).toEqual([
      [link.contentHistId(), 1, 'https://example.com/cleared'],
    ]);
    await expectPredicateEmpty();
  });
});
