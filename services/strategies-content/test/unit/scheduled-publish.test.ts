/** changesetManager.publishBySchedule through domain/changesets over a throwaway `content` schema: per tenant, earliest first, up to the cutoff. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitNotAuthoritativeError, closeGates, openGates } from '@opt2/platform/migration-kit';
import { TENANT_B, pgAvailable } from '@opt2/platform/testing';
import { publish, publishScheduledChangesets, saveChangeset, type ScheduledPublishDeps } from '../../src/domain/changesets.js';
import { saveContent, saveDraft, type ContentSaveSite } from '../../src/domain/content.js';
import type { Actor } from '../../src/domain/context.js';
import { ADMIN, END, HOME, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const NOW_MINUTE = new Date(2026, 5, 30, 10, 15, 0, 0);
const ADMIN_B: Actor = { ...ADMIN, siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId };
const A_EARLY = cfId('A', 1);
const A_LATE = cfId('A', 2);
const A_FUTURE = cfId('A', 3);
const A_PUBLISHED = cfId('A', 4);
const A_UNDATED = cfId('A', 5);
const B_DUE = cfId('B', 1);

describe.skipIf(!(await pgAvailable()))('publishScheduledChangesets', () => {
  let fx: ContentFixture;
  const sites: string[] = [];
  let pageId = '';
  const deps = (cutoff?: Date): ScheduledPublishDeps => ({
    ...fx.deps,
    siteFor: (_tenantId: string, siteId: string): ContentSaveSite => {
      sites.push(siteId);
      return { ...SITE, siteId, urls: { ...SITE.urls, siteId } };
    },
    ...(cutoff === undefined ? {} : { cutoff }),
  });
  const row = async (id: string, tenantId = ADMIN.tenantId) =>
    fx.inTenant(async (tx) => (await tx.query(`SELECT * FROM ${fx.handle.schema}.changeset WHERE changesetid = $1`, [id])).rows[0] as Record<string, unknown>, tenantId);

  beforeAll(async () => {
    fx = await createContentFixture('scheduled-publish-test');
    const saveA = (changesetid: string, name: string, publishdate: string, published = '0') =>
      saveChangeset(fx.deps, ADMIN, { changesetid, siteid: SITE_ID, name, publishdate, published });
    // Saved late-first, so id order and publish-date order differ.
    await saveA(A_LATE, 'Late', '2026-06-30 09:00:00');
    await saveA(A_EARLY, 'Early', '2026-06-30 08:00:00');
    await saveA(A_FUTURE, 'Future', '2026-07-01 08:00:00');
    await saveA(A_PUBLISHED, 'Done', '2026-06-30 07:00:00', '1');
    await saveA(A_UNDATED, 'Undated', '');
    await saveChangeset(fx.deps, ADMIN_B, { changesetid: B_DUE, siteid: TENANT_B.siteId, name: 'B Due', publishdate: '2026-06-30 10:15:00' });
    await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
    pageId = (await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, parentid: HOME, type: 'Page', title: 'Page', approved: 1 })).bean.contentId();
    await saveDraft(fx.deps, { ...ADMIN, fullName: 'Draft Author' }, SITE, { siteid: SITE_ID, contentid: pageId, parentid: HOME, type: 'Page', title: 'Page v2', changesetid: A_LATE });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('publishes only the change sets due by the cutoff', async () => {
    const result = await publishScheduledChangesets(deps(new Date(2026, 5, 30, 8, 30)));
    expect(result.changesets).toEqual([{ tenantId: ADMIN.tenantId, siteId: SITE_ID, changesetId: A_EARLY, published: true }]);
    expect(await row(A_EARLY)).toMatchObject({ published: 1, publishdate: NOW_MINUTE });
    expect(await row(A_LATE)).toMatchObject({ published: 0 });
    expect(sites).toEqual([SITE_ID]);
  });

  it('publishes the remaining due change sets per tenant in publish-date order as the site monitor, leaving the others', async () => {
    const result = await publishScheduledChangesets(deps());
    expect(result.changesets.map(({ siteId, changesetId }) => [siteId, changesetId])).toEqual([
      [SITE_ID, A_LATE],
      [TENANT_B.siteId, B_DUE],
    ]);
    // The draft save stamped the change set last; without a session user the publish keeps that stamp.
    expect(await row(A_LATE)).toMatchObject({ published: 1, publishdate: NOW_MINUTE, lastupdateby: 'Draft Author' });
    expect(await row(B_DUE, TENANT_B.tenantId)).toMatchObject({ published: 1, publishdate: NOW_MINUTE });
    expect(await row(A_FUTURE)).toMatchObject({ published: 0 });
    expect(await row(A_UNDATED)).toMatchObject({ published: 0, publishdate: null });
    expect(await row(A_PUBLISHED)).toMatchObject({ published: 1, publishdate: new Date(2026, 5, 30, 7, 0) });
    // No session user: the published version keeps its author.
    const [active] = await fx.rows('content', 'contentid = $1 AND active = 1', [pageId]);
    expect(active).toMatchObject({ title: 'Page v2', approved: 1, lastupdateby: 'Draft Author' });
    expect(await publishScheduledChangesets(deps())).toEqual({ changesets: [] });
  });

  it('publishes by the scheduler without a session user', async () => {
    const result = await publish(fx.deps, ADMIN, SITE, A_FUTURE, true);
    expect(result.published).toBe(true);
    expect(await row(A_FUTURE)).toMatchObject({ published: 1, lastupdateby: 'Admin User' });
  });

  it('propagates a unit gate that refuses target writes', async () => {
    await saveChangeset(fx.deps, ADMIN, { changesetid: cfId('A', 6), siteid: SITE_ID, name: 'Gated', publishdate: '2026-06-30 06:00:00' });
    const units = ['content.changeset'];
    await closeGates(fx.handle.app, { units, holderId: 'scheduled-legacy' });
    await openGates(fx.handle.app, { units, holderId: 'scheduled-legacy', state: 'legacy' });
    try {
      await expect(publishScheduledChangesets(deps())).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
      expect(await row(cfId('A', 6))).toMatchObject({ published: 0 });
    } finally {
      await closeGates(fx.handle.app, { units, holderId: 'scheduled-open', allowLegacy: true });
      await openGates(fx.handle.app, { units, holderId: 'scheduled-open', state: 'open' });
    }
  });
});
