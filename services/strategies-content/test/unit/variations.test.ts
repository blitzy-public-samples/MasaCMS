/** Variation targeting: the `variations` gate of the domain, the resource route and the JSON API entity; the bean read, saves, delete and script model. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LegacyApiError, isCfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type QueryConfig, type QueryResult, type QueryResultRow, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  loadOpenApiDocument,
  pgAvailable,
  type InjectResponse,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type DomainDeps } from '../../src/domain/context.js';
import {
  deleteVariationTargeting,
  readVariationTargeting,
  saveVariationTargeting,
  saveVariationTargetingInTx,
  variationScriptModel,
  variationsEnabled,
  type VariationTargetingValues,
} from '../../src/domain/variations.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS, type VariationTargetingRow } from '../../src/repo/tables.js';
import { VARIATION_PATH } from '../../src/routes/variation.js';
import { buildTestApp, createRecordingDb, type RecordedStatement, type RecordingDb, type TestApp } from '../helpers/app.js';
import { seedRecordingDb } from '../helpers/seed.js';
import { contentHeaders } from '../helpers/tokens.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const SITE = TENANT_A.siteId;
const VARIATION_MODULE = '00000000000000000000000000000000099';

function actor(roles: string[], s2 = false): Actor {
  return actorFromClaims(
    { iss: 'i', aud: 'a', sub: cfId('U', 1), sid: 's', tid: TENANT_A.tenantId, site: SITE, roles, s2, epoch: 0, iat: 0, exp: 0 },
    'Editor Name',
  );
}

const contentEditor = actor(['system-user', 'm:000']);
const variationOnly = actor(['system-user', 'm:099']);
const siteAdmin = actor(['system-user', 'site-admin']);
const superUser = actor(['s2'], true);

/** A db or repository whose every use fails the test: the gated paths must not reach it. */
function untouchable<T>(label: string): T {
  return new Proxy({}, {
    get(): never {
      throw new Error(`${label} was used`);
    },
  }) as T;
}

const offlineDeps = (variations: boolean): DomainDeps => ({
  db: untouchable<TenantDb>('db'),
  repository: untouchable<ContentRepository>('repository'),
  clock: fixedClock(NOW),
  config: { ...CONTENT_CONFIG_DEFAULTS, variations },
});

describe('variationsEnabled', () => {
  it.each<[string, boolean, boolean]>([
    ['the configBean default', CONTENT_CONFIG_DEFAULTS.variations, false],
    ['variations=true', true, true],
  ])('with %s answers %s', (_label, variations, expected) => {
    expect(variationsEnabled({ variations })).toBe(expected);
  });
});

describe('with the variations setting off', () => {
  it('variationScriptModel answers null without a read', async () => {
    await expect(variationScriptModel(offlineDeps(false), variationOnly, { siteId: SITE, contentType: '' })).resolves.toBeNull();
  });
});

describe('JSON API save access', () => {
  it.each([true, false])(
    'refuses with authorization without the Content module role (m:000), even with the Variation module role (m:099) (variations=%s)',
    async (variations) => {
      const call = saveVariationTargeting(offlineDeps(variations), variationOnly, { contentid: cfId('C', 1), siteid: SITE, initjs: 'x' });
      await expect(call).rejects.toBeInstanceOf(LegacyApiError);
      await expect(call).rejects.toMatchObject({ type: 'authorization' });
    },
  );
});

const TARGETING_TABLE = '"content"."variation_targeting"';
const TARGETING_BY_CONTENT = /^SELECT \* FROM "content"\."variation_targeting" WHERE tenant_id = \$1 AND contentid = ANY/;
const TARGETING_BY_ID = /^SELECT \* FROM "content"\."variation_targeting" WHERE "tenant_id" = \$1 AND "targetingid" = \$2/;
const TARGETING_BATCH = /INNER JOIN "content"\."variation_targeting" t ON/;
const TARGETING_UPDATE = /^UPDATE "content"\."variation_targeting" /;
const TARGETING_DELETE = /^DELETE FROM "content"\."variation_targeting" /;
const VARIATION_ITEMS = /FROM "content"\."content" tcontent WHERE .*lower\(rtrim\(tcontent\.type\)\) = lower\(rtrim\(\$2::text\)\)/;

const STORED_CONTENT = 'A0B1C2D3-0001-4A5B-8C7D9E0F1A2B3C4D';
const STORED: VariationTargetingRow = {
  tenant_id: TENANT_A.tenantId,
  targetingid: 'A0B1C2D3-0002-4A5B-8C7D9E0F1A2B3C4D',
  contentid: STORED_CONTENT,
  siteid: SITE,
  initjs: 'stored()',
  targetingjs: '[".stored"]',
};

describe('domain/variations over the recording database', () => {
  let db: RecordingDb;
  let repository: ContentRepository;
  let recorded: DomainDeps;

  /** Statements that wrote `content.variation_targeting`. */
  const targetingWrites = (): RecordedStatement[] => db.writes().filter((statement) => statement.sql.includes(TARGETING_TABLE));

  beforeEach(() => {
    db = createRecordingDb();
    seedRecordingDb(db);
    repository = createContentRepository({ clock: fixedClock(NOW), schema: db.schema });
    recorded = { db, repository, clock: fixedClock(NOW), config: { ...CONTENT_CONFIG_DEFAULTS, variations: true } };
  });

  it('readVariationTargeting of content without a row returns a new bean under a new CF UUID with empty scripts, writing nothing', async () => {
    const bean = await readVariationTargeting(recorded, contentEditor, { contentId: cfId('C', 1), siteId: SITE });
    expect(bean).toMatchObject({ contentid: cfId('C', 1), siteid: SITE, initjs: '', targetingjs: '', isNew: 1 });
    expect(isCfUuid(bean.targetingid)).toBe(true);
    expect(db.statements.filter((statement) => TARGETING_BY_CONTENT.test(statement.sql)).map((statement) => statement.params)).toEqual([
      [TENANT_A.tenantId, [cfId('C', 1), cfId('C', 1).toLowerCase()], SITE],
    ]);
    expect(db.writes()).toEqual([]);
  });

  it.each<[string, VariationTargetingRow | null, RegExp]>([
    ['inserts a row when the content has none', null, /^INSERT INTO "content"\."variation_targeting" /],
    ['updates the row the content already has', STORED, TARGETING_UPDATE],
  ])('saveVariationTargetingInTx, loading by contentid and siteid, %s', async (_label, stored, write) => {
    if (stored !== null) {
      db.respond(TARGETING_BY_CONTENT, [stored]);
      db.respond(TARGETING_BY_ID, [stored]);
      db.respond(TARGETING_UPDATE, [{ ...stored, initjs: 'next()' }]);
    }
    const { saved, errors } = await withGatedTenant(db, TENANT_A.tenantId, (tx) =>
      saveVariationTargetingInTx(tx, repository, { contentid: STORED_CONTENT, siteid: SITE, initjs: 'next()' }, contentEditor),
    );
    expect(errors).toEqual({});
    expect(saved).toMatchObject({ contentid: STORED_CONTENT, siteid: SITE, initjs: 'next()', targetingjs: stored?.targetingjs ?? '', isNew: 0 });
    expect(isCfUuid(saved?.targetingid ?? '')).toBe(true);
    const writes = targetingWrites();
    expect(writes.map((statement) => write.test(statement.sql))).toEqual([true]);
    expect(writes[0]?.params).toContain(stored?.targetingid ?? saved?.targetingid);
  });

  it.each([true, false])('saveVariationTargeting inserts a row whatever the setting (variations=%s)', async (variations) => {
    const { saved } = await saveVariationTargeting({ ...recorded, config: { ...recorded.config, variations } }, superUser, {
      contentid: STORED_CONTENT,
      siteid: SITE,
      initjs: 'x',
    });
    expect(saved).toMatchObject({ contentid: STORED_CONTENT, siteid: SITE, initjs: 'x', targetingjs: '', isNew: 0 });
    expect(targetingWrites().map((statement) => /^INSERT INTO "content"\."variation_targeting" /.test(statement.sql))).toEqual([true]);
  });

  it.each<[string, Actor, boolean]>([
    ['the Content module role (m:000)', contentEditor, true],
    ['site-admin', siteAdmin, true],
    ['s2', superUser, true],
    ['s2 with the setting off', superUser, false],
  ])('deleteVariationTargeting deletes a stored row for %s', async (_label, deleter, variations) => {
    db.respond(TARGETING_BY_ID, [STORED]);
    db.respond(TARGETING_DELETE, [STORED]);
    await expect(deleteVariationTargeting({ ...recorded, config: { ...recorded.config, variations } }, deleter, STORED.targetingid)).resolves.toEqual({
      targetingid: STORED.targetingid,
      contentid: STORED_CONTENT,
      siteid: SITE,
      initjs: 'stored()',
      targetingjs: '[".stored"]',
      isNew: 0,
    });
    const deletes = db.writes().filter((statement) => TARGETING_DELETE.test(statement.sql));
    expect(deletes.map((statement) => statement.params)).toEqual([[TENANT_A.tenantId, STORED.targetingid]]);
  });

  // The entity is registered under the Content module (jsonApiUtility.cfc:105), so m:099 alone grants nothing.
  it.each<[string, () => Promise<unknown>]>([
    ['save', () => saveVariationTargeting(recorded, variationOnly, { contentid: STORED_CONTENT, siteid: SITE, initjs: 'x' })],
    ['delete', () => deleteVariationTargeting(recorded, variationOnly, STORED.targetingid)],
  ])('refuses a %s by the Variation module role (m:099) without m:000, s2 or site-admin, writing nothing', async (_label, call) => {
    db.respond(TARGETING_BY_ID, [STORED]);
    const refusal: unknown = await call().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(LegacyApiError);
    expect(refusal).toMatchObject({ type: 'authorization' });
    expect(db.writes()).toEqual([]);
  });

  it('variationScriptModel answers the site’s live Variation items by title with their targeting scripts, reading only', async () => {
    const variationB = 'A0B1C2D3-0003-4A5B-8C7D9E0F1A2B3C4D';
    db.respond(VARIATION_ITEMS, [
      { contentid: STORED_CONTENT, menutitle: 'Alpha', responsechart: null },
      { contentid: variationB, menutitle: 'Beta', responsechart: null },
    ]);
    db.respond(TARGETING_BATCH, [{ requested_index: 0, ...STORED }]);
    await expect(variationScriptModel(recorded, contentEditor, { siteId: SITE, contentType: 'Page' })).resolves.toEqual({
      siteId: SITE,
      contentType: 'Page',
      variations: [
        { contentid: STORED_CONTENT, title: 'Alpha', initjs: 'stored()', targetingjs: '[".stored"]' },
        { contentid: variationB, title: 'Beta', initjs: '', targetingjs: '' },
      ],
    });
    expect(db.statements.filter((statement) => VARIATION_ITEMS.test(statement.sql)).map((statement) => statement.params)).toEqual([[SITE, 'Variation']]);
    expect(db.writes()).toEqual([]);
  });
});

const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as object;

type Setting = 'off' | 'on';

describe('the composed app with MURA_VARIATIONS off and on', () => {
  const apps: Partial<Record<Setting, TestApp>> = {};

  /** A GET as the gateway relays an editor of tenant-a, checked against the contract. */
  async function get(setting: Setting, url: string): Promise<InjectResponse> {
    const t = apps[setting];
    if (t === undefined) throw new Error(`no ${setting} app`);
    t.db.clear();
    const res = await t.app.inject({ method: 'GET', url, headers: await contentHeaders('editor') });
    // The JSON API `{path}` is a wildcard (x-opt2-wildcard), which the contract matcher reads as one segment.
    const path = (url.split('?')[0] ?? url).replace(/^(\/_api\/json\/v1\/[^/]+\/)(.+)$/, (_match, head: string, tail: string) => head + encodeURIComponent(tail));
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'GET',
      path,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  }

  beforeAll(async () => {
    apps.off = await buildTestApp();
    apps.on = await buildTestApp({ env: { MURA_VARIATIONS: 'true' } });
    for (const t of [apps.off, apps.on]) {
      seedRecordingDb(t.db);
      t.db.respond(TARGETING_BY_ID, [STORED]);
    }
  });

  afterAll(async () => {
    await apps.off?.close();
    await apps.on?.close();
  });

  const UNMATCHED = { status: 200, type: 'text/html;charset=UTF-8', body: '' };

  it.each<[string, Setting, string, { status: number; type: string; body: unknown }]>([
    ['the empty unmatched page with the setting off', 'off', `${VARIATION_PATH}?siteid=${SITE}`, UNMATCHED],
    ['the empty unmatched page with the setting on and no url siteid', 'on', VARIATION_PATH, UNMATCHED],
    [
      'the legacy 503 with the setting on and the token site, as only the CFML runtime generates the script',
      'on',
      `${VARIATION_PATH}?siteid=${SITE}`,
      { status: 503, type: 'application/json;charset=utf-8', body: expect.stringContaining('"code":"server_error"') },
    ],
  ])('GET /_api/resource/variation answers %s', async (_label, setting, url, expected) => {
    const res = await get(setting, url);
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual(expected);
  });

  // Unregistered, legacy still loads the entity's bean and refuses with `authorization` rather than an unknown-entity
  // error (oracle), so that is a read's answer with the setting off.
  it('refuses JSON API variationTargeting with the authorization error while the setting is off, reading nothing', async () => {
    const res = await get('off', `/_api/json/v1/${SITE}/variationTargeting/${STORED.targetingid}`);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      apiversion: 'v1',
      method: 'findOne',
      error: { message: 'Insufficient Account Permissions', code: 'invalid_request' },
    });
    expect(apps.off?.db.statements.some((statement) => statement.sql.includes(TARGETING_TABLE))).toBe(false);
  });

  it('serves JSON API variationTargeting findOne of a stored row while the setting is on', async () => {
    const res = await get('on', `/_api/json/v1/${SITE}/variationTargeting/${STORED.targetingid}`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      apiversion: 'v1',
      method: 'findOne',
      data: { targetingid: STORED.targetingid, contentid: STORED_CONTENT, siteid: SITE, initjs: 'stored()', targetingjs: '[".stored"]', isnew: 0 },
    });
  });
});

/** One describe's throwaway content schema with open gates, its repository and deps, and helpers bound to them. */
interface VariationSchema {
  handle: ThrowawaySchema;
  repo: ContentRepository;
  deps: DomainDeps;
  /** Runs `fn` in a tenant-a transaction. */
  inA<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** The stored targeting row of `targetingId`, or null. */
  storedRow(targetingId: string): Promise<Record<string, unknown> | null>;
  /** `handle.app` with the text of every statement its tenant transactions issue appended to `statements`. */
  recordingDb(statements: string[]): TenantDb;
}

/** Creates a content schema, opens its content gates under `holderId` and binds the helpers to it. */
async function createVariationSchema(holderId: string): Promise<VariationSchema> {
  const handle = await createThrowawaySchema({
    service: 'strategies-content',
    schemaName: 'content',
    migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
  });
  await ensureUnitGates(handle.app, CONTENT_UNITS);
  await closeGates(handle.app, { units: CONTENT_UNITS, holderId, allowLegacy: true });
  await openGates(handle.app, { units: CONTENT_UNITS, holderId, state: 'open' });
  const repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
  const deps: DomainDeps = { db: handle.app, repository: repo, clock: fixedClock(NOW), config: { ...CONTENT_CONFIG_DEFAULTS, variations: true } };
  const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);
  return {
    handle,
    repo,
    deps,
    inA,
    storedRow: (targetingId) => inA((tx) => repo.platform.findByKey(tx, 'variation_targeting', { targetingid: targetingId })),
    recordingDb: (statements) => ({
      schema: handle.app.schema,
      withTenant: (tenantId, fn) =>
        handle.app.withTenant(tenantId, (tx) =>
          fn({
            ...tx,
            query: <R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>> => {
              statements.push(typeof text === 'string' ? text : text.text);
              return tx.query<R>(text, values);
            },
          }),
        ),
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: () => Promise.resolve(),
    }),
  };
}

/** The case-variant layout at `n`: Variation items C<n>, C<n+2>, C<n+3>, C<n+4> and `short`, titles led by `prefix`; `mixed` is C<n+2> with a lower-case `c`. */
interface CaseVariants {
  n: number;
  prefix: string;
  upper: string;
  mixed: string;
  mixedItem: string;
  otherSiteCase: string;
  unscripted: string;
  short: string;
}

const caseVariants = (n: number, short: string, prefix: string): CaseVariants => ({
  n,
  prefix,
  upper: cfId('C', n),
  mixed: `c${cfId('C', n + 2).slice(1)}`,
  mixedItem: cfId('C', n + 2),
  otherSiteCase: cfId('C', n + 3),
  unscripted: cfId('C', n + 4),
  short,
});

/** Inserts the layout's items (hist ids H<n>…H<n+5>) and targeting rows T<n+1> upper, T<n> lower-case upper, T<n+2> mixed, T<n+3> upper-case site, T<n+5> upper-case short. */
async function arrangeCaseVariants(fx: VariationSchema, v: CaseVariants): Promise<void> {
  await withGatedTenant(fx.handle.app, TENANT_A.tenantId, async (tx) => {
    const base = { siteid: SITE, subtype: 'Default', moduleid: VARIATION_MODULE, approved: 1, active: 1, display: 1, type: 'Variation' };
    const items: [string, string, number][] = [
      [v.upper, 'Upper', v.n], [v.mixedItem, 'Mixed', v.n + 2], [v.otherSiteCase, 'Site case', v.n + 3], [v.unscripted, 'Unscripted', v.n + 4], [v.short, 'Short', v.n + 5],
    ];
    for (const [contentid, label, n] of items) {
      const title = `${v.prefix}${label}`;
      await fx.repo.content.insertVersion(tx, { ...base, contentid, contenthistid: cfId('H', n), title, menutitle: title });
    }
    const rows: [number, string, string, string][] = [
      [v.n + 1, v.upper, SITE, 'upper()'],
      [v.n, v.upper.toLowerCase(), SITE, 'lower()'],
      [v.n + 2, v.mixed, SITE, 'mixed()'],
      [v.n + 3, v.otherSiteCase, SITE.toUpperCase(), 'site()'],
      [v.n + 5, v.short.toUpperCase(), SITE, 'short()'],
    ];
    for (const [n, contentid, siteid, initjs] of rows) {
      await saveVariationTargetingInTx(tx, fx.repo, { targetingid: cfId('T', n), contentid, siteid, initjs, targetingjs: `["#${String(n)}"]` }, contentEditor);
    }
  });
}

const targetingStatements = (statements: readonly string[]): string[] => statements.filter((sql) => sql.includes('variation_targeting'));

describe.skipIf(!(await pgAvailable()))('domain/variations over a throwaway content schema', () => {
  let fx: VariationSchema;

  beforeAll(async () => {
    fx = await createVariationSchema('variations-test');
  });

  afterAll(async () => {
    await fx?.handle.drop();
  });

  it('readVariationTargeting returns a new bean with empty scripts and writes nothing when no row exists', async () => {
    const bean = await readVariationTargeting(fx.deps, contentEditor, { contentId: cfId('C', 1), siteId: SITE });
    expect(bean).toMatchObject({ contentid: cfId('C', 1), siteid: SITE, initjs: '', targetingjs: '', isNew: 1 });
    expect(isCfUuid(bean.targetingid)).toBe(true);
    expect(await fx.storedRow(bean.targetingid)).toBeNull();
  });

  it('a Variation content save writes its initjs through saveVariationTargetingInTx, then updates the same row', async () => {
    const contentId = cfId('C', 2);
    const { saved: first } = await withGatedTenant(fx.handle.app, TENANT_A.tenantId, async (tx) => {
      await fx.repo.content.insertVersion(tx, {
        contentid: contentId, contenthistid: cfId('H', 2), siteid: SITE, type: 'Variation', subtype: 'Default',
        moduleid: VARIATION_MODULE, approved: 1, active: 1, display: 1, title: 'Hero', menutitle: 'Hero',
      });
      return saveVariationTargetingInTx(tx, fx.repo, { contentid: contentId, siteid: SITE, initjs: 'init()' }, contentEditor);
    });
    expect(first).toMatchObject({ contentid: contentId, siteid: SITE, initjs: 'init()', targetingjs: '', isNew: 0 });
    expect(await fx.storedRow(first?.targetingid ?? '')).toMatchObject({ initjs: 'init()', targetingjs: null, contentid: contentId });

    const { saved: second } = await withGatedTenant(fx.handle.app, TENANT_A.tenantId, (tx) =>
      saveVariationTargetingInTx(tx, fx.repo, { contentid: contentId, siteid: SITE, initjs: 'again()' }, contentEditor),
    );
    expect(second).toEqual({ ...first, initjs: 'again()' });
    expect(await readVariationTargeting(fx.deps, contentEditor, { contentId, siteId: SITE })).toEqual(second);
  });

  it('saveVariationTargeting inserts under a new id, then upserts by targetingid keeping unsupplied fields', async () => {
    const contentId = cfId('C', 3);
    const { saved: created } = await saveVariationTargeting(fx.deps, contentEditor, { contentid: contentId, siteid: SITE, targetingjs: '[".hero"]' });
    expect(created).not.toBeNull();
    expect(isCfUuid(created?.targetingid ?? '')).toBe(true);
    expect(created).toMatchObject({ contentid: contentId, siteid: SITE, initjs: '', targetingjs: '[".hero"]', isNew: 0 });

    const { saved: updated } = await saveVariationTargeting(fx.deps, superUser, { targetingid: created?.targetingid, initjs: 'go()' });
    expect(updated).toEqual({ ...created, initjs: 'go()' });
    expect(await readVariationTargeting(fx.deps, contentEditor, { contentId, siteId: SITE })).toEqual(updated);
  });

  it('saveVariationTargeting with an unknown targetingid inserts the row under that id', async () => {
    const targetingid = cfId('T', 4);
    const { saved } = await saveVariationTargeting(fx.deps, contentEditor, { targetingid, contentid: cfId('C', 4), siteid: SITE, initjs: 'a' });
    expect(saved).toEqual({ targetingid, contentid: cfId('C', 4), siteid: SITE, initjs: 'a', targetingjs: '', isNew: 0 });
    expect(await fx.storedRow(targetingid)).toMatchObject({ targetingid, initjs: 'a' });
  });

  it.each<[string, VariationTargetingValues, Record<string, string>]>([
    ['a 36-character contentid', { contentid: 'X'.repeat(36), siteid: SITE }, { contentid: "The property named 'contentid' is not valid" }],
    ['a 36-character targetingid', { targetingid: 'T'.repeat(36), contentid: cfId('C', 30), siteid: SITE }, { targetingid: "The property named 'targetingid' is not valid" }],
    ['a 26-character siteid', { contentid: cfId('C', 30), siteid: 's'.repeat(26) }, { siteid: "The property named 'siteid' is not valid" }],
    [
      'an empty targetingid',
      { targetingid: '', contentid: cfId('C', 30), siteid: SITE },
      { targetingid: "The property named 'targetingid' is not valid", primarykey: "The primary key 'targetingid' is required." },
    ],
  ])('saveVariationTargetingInTx answers the validation errors of %s and writes nothing', async (_label, input, errors) => {
    const counts = (): Promise<number[]> =>
      fx.inA(async (tx) =>
        Promise.all(
          ['variation_targeting', 'changelog'].map(
            async (table) => (await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${fx.handle.schema}.${table}`)).rows[0]?.n ?? 0,
          ),
        ),
      );
    const before = await counts();
    await expect(withGatedTenant(fx.handle.app, TENANT_A.tenantId, (tx) => saveVariationTargetingInTx(tx, fx.repo, input, contentEditor))).resolves.toEqual({
      saved: null,
      errors,
    });
    expect(await counts()).toEqual(before);
  });

  it('deleteVariationTargeting is a silent no-op for an absent row, refuses a stored one without access, else deletes it', async () => {
    await expect(deleteVariationTargeting(fx.deps, variationOnly, cfId('T', 99))).resolves.toBeNull();

    const { saved } = await saveVariationTargeting(fx.deps, contentEditor, { contentid: cfId('C', 5), siteid: SITE, initjs: 'b' });
    const targetingId = saved?.targetingid ?? '';
    await expect(deleteVariationTargeting(fx.deps, variationOnly, targetingId)).rejects.toMatchObject({ type: 'authorization' });
    expect(await fx.storedRow(targetingId)).not.toBeNull();

    await expect(deleteVariationTargeting(fx.deps, contentEditor, targetingId)).resolves.toEqual(saved);
    expect(await fx.storedRow(targetingId)).toBeNull();
    expect(await readVariationTargeting(fx.deps, contentEditor, { contentId: cfId('C', 5), siteId: SITE })).toMatchObject({ isNew: 1, initjs: '' });
  });

  it('variationScriptModel reads every item targeting in one statement and answers what the per-item read answers', async () => {
    const v = caseVariants(30, 'short-script', '');
    const { upper, otherSiteCase, unscripted } = v;
    // A listed item makes the first read issue its targeting statement too.
    await withGatedTenant(fx.handle.app, TENANT_A.tenantId, (tx) =>
      fx.repo.content.insertVersion(tx, {
        contentid: cfId('C', 36), contenthistid: cfId('H', 36), siteid: SITE, type: 'Variation', subtype: 'Default',
        moduleid: VARIATION_MODULE, approved: 1, active: 1, display: 1, title: 'Prior', menutitle: 'Prior',
      }),
    );
    const before: string[] = [];
    const first = await variationScriptModel({ ...fx.deps, db: fx.recordingDb(before) }, contentEditor, { siteId: SITE, contentType: '' });

    await arrangeCaseVariants(fx, v);
    const after: string[] = [];
    const model = await variationScriptModel({ ...fx.deps, db: fx.recordingDb(after) }, contentEditor, { siteId: SITE, contentType: '' });

    expect(model?.variations.length).toBe((first?.variations.length ?? 0) + 5);
    expect(after.length).toBe(before.length);
    expect(targetingStatements(after)).toHaveLength(1);
    const items = await fx.inA((tx) => fx.repo.content.componentType(tx, { siteId: SITE, type: 'Variation' }));
    const perItem = await Promise.all(
      items.map(async (item) => {
        const contentid = item.contentid ?? '';
        const { initjs, targetingjs } = await readVariationTargeting(fx.deps, contentEditor, { contentId: contentid, siteId: SITE });
        return { contentid, title: item.menutitle ?? '', initjs, targetingjs };
      }),
    );
    expect(model?.variations).toEqual(perItem);
    expect(model?.variations).toEqual(
      expect.arrayContaining([
        { contentid: upper, title: 'Upper', initjs: 'lower()', targetingjs: '["#30"]' },
        { contentid: cfId('C', 32), title: 'Mixed', initjs: '', targetingjs: '' },
        { contentid: otherSiteCase, title: 'Site case', initjs: '', targetingjs: '' },
        { contentid: unscripted, title: 'Unscripted', initjs: '', targetingjs: '' },
        { contentid: 'short-script'.padEnd(35), title: 'Short', initjs: 'short()', targetingjs: '["#35"]' },
      ]),
    );
  });

  it('targetingsForContents answers each requested id as targetingFor does, and issues no statement for no ids', async () => {
    const v = caseVariants(20, 'short-variation', 'Lookup ');
    const { upper, mixed, otherSiteCase, unscripted } = v;
    await arrangeCaseVariants(fx, v);
    const ids = [upper, upper.toLowerCase(), cfId('C', 22), mixed, 'short-variation', 'SHORT-VARIATION  ', otherSiteCase, unscripted, upper, ''];
    const batched = await fx.inA((tx) => fx.repo.variation.targetingsForContents(tx, { contentIds: ids, siteId: SITE }));
    const perId = await fx.inA(async (tx) => {
      const rows = [];
      for (const contentId of ids) {
        rows.push(await fx.repo.variation.targetingFor(tx, { contentId, siteId: SITE }));
      }
      return rows;
    });
    expect(batched).toEqual(perId);
    expect(batched.map((row) => row?.targetingid ?? null)).toEqual([
      cfId('T', 20), cfId('T', 20), null, cfId('T', 22), cfId('T', 25), cfId('T', 25), null, null, cfId('T', 20), null,
    ]);

    const statements: string[] = [];
    await expect(
      fx.recordingDb(statements).withTenant(TENANT_A.tenantId, (tx) => fx.repo.variation.targetingsForContents(tx, { contentIds: [], siteId: SITE })),
    ).resolves.toEqual([]);
    expect(statements).toEqual([]);
  });
});

describe.skipIf(!(await pgAvailable()))('domain/variations script model over its own throwaway content schema', () => {
  let fx: VariationSchema;

  beforeAll(async () => {
    fx = await createVariationSchema('variations-script-test');
  });

  afterAll(async () => {
    await fx?.handle.drop();
  });

  it('variationScriptModel lists the live Variation items by title with their targeting scripts', async () => {
    await withGatedTenant(fx.handle.app, TENANT_A.tenantId, async (tx) => {
      const base = { siteid: SITE, subtype: 'Default', moduleid: VARIATION_MODULE, approved: 1, active: 1, display: 1 };
      await fx.repo.content.insertVersion(tx, { ...base, type: 'Variation', contentid: cfId('C', 2), contenthistid: cfId('H', 2), title: 'Hero', menutitle: 'Hero' });
      await saveVariationTargetingInTx(tx, fx.repo, { contentid: cfId('C', 2), siteid: SITE, initjs: 'again()' }, contentEditor);
      await fx.repo.content.insertVersion(tx, { ...base, type: 'Variation', contentid: cfId('C', 6), contenthistid: cfId('H', 6), title: 'Alpha', menutitle: 'Alpha' });
      await fx.repo.content.insertVersion(tx, { ...base, type: 'Variation', contentid: cfId('C', 7), contenthistid: cfId('H', 7), title: 'Draft', menutitle: 'Draft', active: 0 });
      await fx.repo.content.insertVersion(tx, { ...base, type: 'Page', contentid: cfId('C', 8), contenthistid: cfId('H', 8), title: 'Page', menutitle: 'Page' });
      await saveVariationTargetingInTx(tx, fx.repo, { contentid: cfId('C', 6), siteid: SITE, initjs: 'alpha()', targetingjs: '["#a"]' }, contentEditor);
    });
    const model = await variationScriptModel(fx.deps, contentEditor, { siteId: SITE, contentType: 'Page' });
    expect(model).toEqual({
      siteId: SITE,
      contentType: 'Page',
      variations: [
        { contentid: cfId('C', 6), title: 'Alpha', initjs: 'alpha()', targetingjs: '["#a"]' },
        { contentid: cfId('C', 2), title: 'Hero', initjs: 'again()', targetingjs: '' },
      ],
    });
  });
});
