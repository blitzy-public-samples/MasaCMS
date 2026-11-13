/** Variation targeting: the `variations` gate, the bean read, the in-transaction and JSON API saves, the delete and the script model. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, isCfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type DomainDeps } from '../../src/domain/context.js';
import {
  deleteVariationTargeting,
  readVariationTargeting,
  saveVariationTargeting,
  saveVariationTargetingInTx,
  variationScriptModel,
  variationsEnabled,
} from '../../src/domain/variations.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

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
  const deps = offlineDeps(false);

  it.each<[string, () => Promise<unknown>]>([
    ['saveVariationTargeting', () => saveVariationTargeting(deps, variationOnly, { contentid: cfId('C', 1), siteid: SITE, initjs: 'x' })],
    ['deleteVariationTargeting', () => deleteVariationTargeting(deps, variationOnly, cfId('T', 1))],
    ['variationScriptModel', () => variationScriptModel(deps, variationOnly, { siteId: SITE, contentType: '' })],
  ])('%s answers null without a read, a write or an access refusal', async (_label, call) => {
    await expect(call()).resolves.toBeNull();
  });
});

describe('JSON API save access', () => {
  it('refuses with authorization without the Content module role (m:000), even with the Variation module role (m:099)', async () => {
    const call = saveVariationTargeting(offlineDeps(true), variationOnly, { contentid: cfId('C', 1), siteid: SITE, initjs: 'x' });
    await expect(call).rejects.toBeInstanceOf(LegacyApiError);
    await expect(call).rejects.toMatchObject({ type: 'authorization' });
  });
});

let handle: ThrowawaySchema;
let repo: ContentRepository;
let deps: DomainDeps;

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

async function storedRow(targetingId: string): Promise<Record<string, unknown> | null> {
  return inA((tx) => repo.platform.findByKey(tx, 'variation_targeting', { targetingid: targetingId }));
}

describe.skipIf(!(await pgAvailable()))('domain/variations over a throwaway content schema', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'variations-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'variations-test', state: 'open' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    deps = { db: handle.app, repository: repo, clock: fixedClock(NOW), config: { ...CONTENT_CONFIG_DEFAULTS, variations: true } };
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('readVariationTargeting returns a new bean with empty scripts and writes nothing when no row exists', async () => {
    const bean = await readVariationTargeting(deps, contentEditor, { contentId: cfId('C', 1), siteId: SITE });
    expect(bean).toMatchObject({ contentid: cfId('C', 1), siteid: SITE, initjs: '', targetingjs: '', isNew: 1 });
    expect(isCfUuid(bean.targetingid)).toBe(true);
    expect(await storedRow(bean.targetingid)).toBeNull();
  });

  it('a Variation content save writes its initjs through saveVariationTargetingInTx, then updates the same row', async () => {
    const contentId = cfId('C', 2);
    const first = await withGatedTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      await repo.content.insertVersion(tx, {
        contentid: contentId, contenthistid: cfId('H', 2), siteid: SITE, type: 'Variation', subtype: 'Default',
        moduleid: VARIATION_MODULE, approved: 1, active: 1, display: 1, title: 'Hero', menutitle: 'Hero',
      });
      return saveVariationTargetingInTx(tx, repo, { contentid: contentId, siteid: SITE, initjs: 'init()' }, contentEditor);
    });
    expect(first).toMatchObject({ contentid: contentId, siteid: SITE, initjs: 'init()', targetingjs: '', isNew: 0 });
    expect(await storedRow(first.targetingid)).toMatchObject({ initjs: 'init()', targetingjs: null, contentid: contentId });

    const second = await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) =>
      saveVariationTargetingInTx(tx, repo, { contentid: contentId, siteid: SITE, initjs: 'again()' }, contentEditor),
    );
    expect(second).toEqual({ ...first, initjs: 'again()' });
    expect(await readVariationTargeting(deps, contentEditor, { contentId, siteId: SITE })).toEqual(second);
  });

  it('saveVariationTargeting inserts under a new id, then upserts by targetingid keeping unsupplied fields', async () => {
    const contentId = cfId('C', 3);
    const created = await saveVariationTargeting(deps, contentEditor, { contentid: contentId, siteid: SITE, targetingjs: '[".hero"]' });
    expect(created).not.toBeNull();
    expect(isCfUuid(created?.targetingid ?? '')).toBe(true);
    expect(created).toMatchObject({ contentid: contentId, siteid: SITE, initjs: '', targetingjs: '[".hero"]', isNew: 0 });

    const updated = await saveVariationTargeting(deps, superUser, { targetingid: created?.targetingid, initjs: 'go()' });
    expect(updated).toEqual({ ...created, initjs: 'go()' });
    expect(await readVariationTargeting(deps, contentEditor, { contentId, siteId: SITE })).toEqual(updated);
  });

  it('saveVariationTargeting with an unknown targetingid inserts the row under that id', async () => {
    const targetingid = cfId('T', 4);
    const saved = await saveVariationTargeting(deps, contentEditor, { targetingid, contentid: cfId('C', 4), siteid: SITE, initjs: 'a' });
    expect(saved).toEqual({ targetingid, contentid: cfId('C', 4), siteid: SITE, initjs: 'a', targetingjs: '', isNew: 0 });
    expect(await storedRow(targetingid)).toMatchObject({ targetingid, initjs: 'a' });
  });

  it('deleteVariationTargeting is a silent no-op for an absent row, refuses a stored one without access, else deletes it', async () => {
    await expect(deleteVariationTargeting(deps, variationOnly, cfId('T', 99))).resolves.toBeNull();

    const saved = await saveVariationTargeting(deps, contentEditor, { contentid: cfId('C', 5), siteid: SITE, initjs: 'b' });
    const targetingId = saved?.targetingid ?? '';
    await expect(deleteVariationTargeting(deps, variationOnly, targetingId)).rejects.toMatchObject({ type: 'authorization' });
    expect(await storedRow(targetingId)).not.toBeNull();

    await expect(deleteVariationTargeting(deps, contentEditor, targetingId)).resolves.toEqual(saved);
    expect(await storedRow(targetingId)).toBeNull();
    expect(await readVariationTargeting(deps, contentEditor, { contentId: cfId('C', 5), siteId: SITE })).toMatchObject({ isNew: 1, initjs: '' });
  });

  it('variationScriptModel lists the live Variation items by title with their targeting scripts', async () => {
    await withGatedTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      const base = { siteid: SITE, subtype: 'Default', moduleid: VARIATION_MODULE, approved: 1, active: 1, display: 1 };
      await repo.content.insertVersion(tx, { ...base, type: 'Variation', contentid: cfId('C', 6), contenthistid: cfId('H', 6), title: 'Alpha', menutitle: 'Alpha' });
      await repo.content.insertVersion(tx, { ...base, type: 'Variation', contentid: cfId('C', 7), contenthistid: cfId('H', 7), title: 'Draft', menutitle: 'Draft', active: 0 });
      await repo.content.insertVersion(tx, { ...base, type: 'Page', contentid: cfId('C', 8), contenthistid: cfId('H', 8), title: 'Page', menutitle: 'Page' });
      await saveVariationTargetingInTx(tx, repo, { contentid: cfId('C', 6), siteid: SITE, initjs: 'alpha()', targetingjs: '["#a"]' }, contentEditor);
    });
    const model = await variationScriptModel(deps, contentEditor, { siteId: SITE, contentType: 'Page' });
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
