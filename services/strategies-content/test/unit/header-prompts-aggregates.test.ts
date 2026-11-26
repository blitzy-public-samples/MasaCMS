/** `loadHeaderPrompts` over a throwaway `content` schema: its counts against the distinct ids of the listed rows, its round trips as rows grow, and its indexed count reads. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles, moduleRole, type UserClaims } from '@opt2/platform/auth';
import { cfDateAdd } from '@opt2/platform/legacy-compat';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, tenantRegistryConsumer, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { loadHeaderPrompts, type HeaderPromptDeps, type HeaderPrompts } from '../../src/domain/header-prompts.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { withPgSchema } from '../helpers/app.js';
import { roundTripCounter, type RoundTripCounter } from '../helpers/round-trips.js';

type Row = Record<string, unknown>;

/** A CF-format id whose first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const at = (stamp: string): Date => new Date(stamp);

const NOW = new Date(2026, 5, 30, 12);
const clock = fixedClock(NOW);
const SITE_MANAGER = '00000000000000000000000000000000000';
const CHANGESETS = '00000000000000000000000000000000014';
const USER = cfId('U', 1);
const OTHER = cfId('U', 2);
const [G1, G2, G3] = [1, 2, 3].map((n) => cfId('G', n)) as [string, string, string];
const content = (n: number): string => cfId('C', n);
/** The id of version `version` of item `n`. */
const hist = (n: number, version = 0): string => cfId('H', n * 10 + version);

let handle: ThrowawaySchema;
let counter: RoundTripCounter;

/** Inserts `rows` into `table` in the transaction tenant; each row names its own columns. */
async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const names = Object.keys(row);
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }
}

/** Runs `fn` in the tenant of `siteId`. */
const inSite = (siteId: string, fn: (tx: TenantTx) => Promise<unknown>): Promise<unknown> => withTenant(handle.app, tenantIdForSite(siteId), fn);

/** A live site-tree page version of `siteid`, last updated by OTHER; `fields` override any column. */
const page = (siteid: string, contentid: string | null, contenthistid: string, fields: Row = {}): Row => ({
  contentid,
  contenthistid,
  siteid,
  moduleid: SITE_MANAGER,
  type: 'Page',
  title: contentid,
  menutitle: contentid,
  active: 1,
  approved: 1,
  display: 1,
  lastupdate: at('2026-01-01T09:00'),
  lastupdatebyid: OTHER,
  ...fields,
});

const draft = { active: 0, approved: 0 };
const unpublished = { active: 1, approved: 0 };

/** An approval request of `contenthistid`. */
const request = (requestid: string, siteid: string, contenthistid: string, userid: string, groupid: string, status: string | null): Row => ({
  requestid,
  siteid,
  userid,
  groupid,
  status,
  contenthistid,
});

/** Registers `siteId` as its own private user pool, holds its Site Manager module, and makes USER a member of G1 there. */
async function registerSite(siteId: string): Promise<void> {
  const tenantId = tenantIdForSite(siteId);
  await withTenant(handle.app, tenantId, async (tx) => {
    await tenantRegistryConsumer.apply(tx, {
      tenantId,
      aggregateVersion: 1,
      payload: { siteId, publicUserPoolId: siteId, privateUserPoolId: siteId, filePoolId: siteId },
    });
    await insert(tx, 'content', [page(siteId, SITE_MANAGER, cfId('M', 1), { type: 'Module' })]);
    await insert(tx, 'membership_projection', [{ user_id: USER, site_id: siteId, group_id: G1 }]);
  });
}

/** USER's token claims of `siteId`. */
function claimsOf(siteId: string, roles: readonly string[], s2 = false): UserClaims {
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: USER,
    sid: 'header-prompts-aggregates',
    tid: tenantIdForSite(siteId),
    site: siteId,
    roles: [...roles],
    s2,
    epoch: 1,
    iat: 0,
    exp: 0,
  };
}

const groupLimited = (siteId: string): UserClaims => claimsOf(siteId, [Roles.systemUser, moduleRole(CHANGESETS), moduleRole(SITE_MANAGER)]);
const superUser = (siteId: string): UserClaims => claimsOf(siteId, [Roles.s2], true);

/** The counts as the distinct content ids of each listed row set and the per-change-set pending sum, for `groupIds` (null for admins). */
function listedCounts(deps: HeaderPromptDeps, claims: UserClaims, groupIds: readonly string[] | null): Promise<HeaderPrompts> {
  const { content: queries, changesets } = deps.repository;
  const distinct = (rows: ReadonlyArray<{ contentid: string | null }>): number => new Set(rows.map((row) => row.contentid)).size;
  const [siteId, userId] = [claims.site, claims.sub];
  return withTenant(handle.app, claims.tid, async (tx) => {
    let pendingChangesets = 0;
    for (const { changesetid } of await changesets.changesetQuery(tx, { siteId, published: 0, sortBy: 'PublishDate' })) {
      pendingChangesets += await changesets.hasPendingApprovals(tx, { changesetId: changesetid });
    }
    return {
      drafts: distinct(await queries.draftList(tx, { siteId, userId, startDate: cfDateAdd('m', -3, NOW) })),
      submissions: distinct(await queries.submissionsQuery(tx, { siteId, userId })),
      approvals: distinct(await queries.approvalsQuery(tx, { siteId, groupIds })),
      expires: distinct(await queries.expiringContent(tx, { siteId, userId, today: NOW })),
      pendingChangesets,
    };
  });
}

const PARITY_SITE = 'hp-parity';
const LIMIT_SITE = 'hp-expiring-limit';

/** Duplicate, NULL and case-variant content ids in every list, and case-variant change set ids. */
async function seedParity(tx: TenantTx): Promise<void> {
  const s = PARITY_SITE;
  const lower = (n: number): string => content(n).toLowerCase();
  await insert(tx, 'content', [
    // Drafts: two newer versions of one item, two unpublished items without an id, case variants of one id, one saved
    // under a lower-case user id, one before the window and one assigned to USER.
    page(s, content(1), hist(1, 1)),
    page(s, content(1), hist(1, 2), { ...draft, lastupdate: at('2026-05-01T09:00'), lastupdatebyid: USER }),
    page(s, content(1), hist(1, 3), { ...draft, lastupdate: at('2026-06-01T09:00'), lastupdatebyid: USER }),
    page(s, null, hist(2, 1), { ...unpublished, lastupdate: at('2026-06-01T09:00'), lastupdatebyid: USER }),
    page(s, null, hist(2, 2), { ...unpublished, lastupdate: at('2026-06-02T09:00'), lastupdatebyid: USER }),
    page(s, content(3), hist(3, 1), { ...unpublished, lastupdate: at('2026-06-03T09:00'), lastupdatebyid: USER }),
    page(s, lower(3), hist(3, 2), { ...unpublished, lastupdate: at('2026-06-04T09:00'), lastupdatebyid: USER }),
    page(s, content(4), hist(4), { ...unpublished, lastupdate: at('2026-06-05T09:00'), lastupdatebyid: USER.toLowerCase() }),
    page(s, content(5), hist(5), { ...unpublished, lastupdate: at('2026-03-29T23:00'), lastupdatebyid: USER }),
    page(s, content(6), hist(6), { ...unpublished, lastupdate: at('2026-06-06T09:00') }),
    // Requests: two versions of one item, two versions without an id, case variants of one id, an approved and a G3 request.
    page(s, content(11), hist(11, 1), draft),
    page(s, content(11), hist(11, 2), draft),
    page(s, null, hist(12, 1), draft),
    page(s, null, hist(12, 2), draft),
    page(s, content(13), hist(13, 1), draft),
    page(s, lower(13), hist(13, 2), draft),
    page(s, content(14), hist(14), draft),
    page(s, content(15), hist(15), draft),
    // Expiring: own, two without an id, case variants of one id, one USER is notified about (as is the first) and one too old.
    page(s, content(21), hist(21), { lastupdatebyid: USER, expires: at('2026-07-15T00:00') }),
    page(s, null, hist(22, 1), { lastupdatebyid: USER, expires: at('2026-07-10T00:00') }),
    page(s, null, hist(22, 2), { lastupdatebyid: USER, expires: at('2026-07-11T00:00') }),
    page(s, content(23), hist(23, 1), { lastupdatebyid: USER, expires: at('2026-07-01T00:00') }),
    page(s, lower(23), hist(23, 2), { lastupdatebyid: USER, expires: at('2026-07-02T00:00') }),
    page(s, content(24), hist(24), { expires: at('2026-07-03T00:00') }),
    page(s, content(25), hist(25), { lastupdatebyid: USER, expires: at('2025-06-01T00:00') }),
    // Change-set versions: Q1 holds a pending, a rejected (by its lower-case id), an approved, an unrequested and a
    // mixed-case-id version; Q2 a pending and a status-less one; Q3 is published; Q4 and q4 match each other's versions.
    page(s, content(31), hist(31), { changesetid: cfId('Q', 1) }),
    page(s, content(32), hist(32), { changesetid: cfId('Q', 1).toLowerCase() }),
    page(s, content(33), hist(33), { changesetid: cfId('Q', 1) }),
    page(s, content(34), hist(34), { changesetid: cfId('Q', 1) }),
    page(s, content(35), hist(35), { changesetid: `q${cfId('Q', 1).slice(1)}` }),
    page(s, content(36), hist(36), { changesetid: cfId('Q', 2) }),
    page(s, content(37), hist(37), { changesetid: cfId('Q', 2) }),
    page(s, content(38), hist(38), { changesetid: cfId('Q', 3) }),
    page(s, content(39), hist(39), { changesetid: cfId('Q', 4) }),
    page(s, content(40), hist(40), { changesetid: cfId('Q', 4).toLowerCase() }),
  ]);
  await insert(tx, 'content_assignment', [
    { contentid: content(6), contenthistid: hist(6), siteid: s, userid: USER, type: 'draft' },
    { contentid: content(21), contenthistid: hist(21), siteid: s, userid: USER, type: 'expire' },
    { contentid: content(24), contenthistid: hist(24), siteid: s, userid: USER, type: 'expire' },
  ]);
  await insert(tx, 'approval_request', [
    request(cfId('R', 1), s, hist(11, 1), USER, G1, 'Pending'),
    request(cfId('R', 2), s, hist(11, 2), USER, G2, 'Pending'),
    request(cfId('R', 3), s, hist(12, 1), USER, G1, 'Pending'),
    request(cfId('R', 4), s, hist(12, 2), OTHER, G1, 'pending '),
    request(cfId('R', 5), s, hist(13, 1), OTHER, G1, 'Pending'),
    request(cfId('R', 6), s, hist(13, 2), USER, G2, 'Pending'),
    request(cfId('R', 7), s, hist(14), USER, G1, 'Approved'),
    request(cfId('R', 8), s, hist(15), OTHER, G3, 'Pending'),
    request(cfId('R', 31), s, hist(31), OTHER, G3, 'Pending'),
    request(cfId('R', 32), s, hist(32), OTHER, G3, 'Rejected'),
    request(cfId('R', 33), s, hist(33), OTHER, G3, 'Approved '),
    request(cfId('R', 35), s, hist(35), OTHER, G3, 'Pending'),
    request(cfId('R', 36), s, hist(36), OTHER, G3, 'Pending'),
    request(cfId('R', 37), s, hist(37), OTHER, G3, null),
    request(cfId('R', 38), s, hist(38), OTHER, G3, 'Pending'),
    request(cfId('R', 39), s, hist(39), OTHER, G3, 'Pending'),
    request(cfId('R', 40), s, hist(40), OTHER, G3, 'Pending'),
  ]);
  await insert(tx, 'changeset', [
    { changesetid: cfId('Q', 1), siteid: s, name: 'Spring', published: 0, publishdate: at('2026-07-01T00:00') },
    { changesetid: cfId('Q', 2), siteid: s, name: 'Summer', published: 0, publishdate: null },
    { changesetid: cfId('Q', 3), siteid: s, name: 'Winter', published: 1, publishdate: at('2026-01-01T00:00') },
    { changesetid: cfId('Q', 4), siteid: s, name: 'Autumn', published: 0, publishdate: null },
    { changesetid: cfId('Q', 4).toLowerCase(), siteid: s, name: 'autumn', published: 0, publishdate: null },
  ]);
}

/** Seeds row `n` of one growing list in `siteId`. */
type Grow = (tx: TenantTx, siteId: string, n: number) => Promise<void>;

const GROW: Record<string, { field: keyof HeaderPrompts; seed: Grow }> = {
  'unpublished change sets': {
    field: 'pendingChangesets',
    seed: async (tx, s, n) => {
      await insert(tx, 'changeset', [{ changesetid: cfId('Q', n), siteid: s, name: `Set ${n}`, published: 0 }]);
      await insert(tx, 'content', [page(s, content(n), hist(n), { changesetid: cfId('Q', n) })]);
      await insert(tx, 'approval_request', [request(cfId('R', n), s, hist(n), OTHER, G3, 'Pending')]);
    },
  },
  drafts: {
    field: 'drafts',
    seed: (tx, s, n) => insert(tx, 'content', [page(s, content(n), hist(n), { ...unpublished, lastupdate: at('2026-06-01T09:00'), lastupdatebyid: USER })]),
  },
  submissions: {
    field: 'submissions',
    seed: async (tx, s, n) => {
      await insert(tx, 'content', [page(s, content(n), hist(n), draft)]);
      await insert(tx, 'approval_request', [request(cfId('R', n), s, hist(n), USER, G3, 'Pending')]);
    },
  },
  approvals: {
    field: 'approvals',
    seed: async (tx, s, n) => {
      await insert(tx, 'content', [page(s, content(n), hist(n), draft)]);
      await insert(tx, 'approval_request', [request(cfId('R', n), s, hist(n), OTHER, G1, 'Pending')]);
    },
  },
  'expiring items': {
    field: 'expires',
    seed: (tx, s, n) => insert(tx, 'content', [page(s, content(n), hist(n), { lastupdatebyid: USER, expires: at('2026-07-15T00:00') })]),
  },
};

describe.skipIf(!(await pgAvailable()))('loadHeaderPrompts aggregates', () => {
  let deps: HeaderPromptDeps;

  beforeAll(async () => {
    handle = await withPgSchema();
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    counter = roundTripCounter(handle);
    deps = { db: counter.db, repository: createContentRepository({ clock, schema: handle.schema }), clock };
    for (const siteId of [PARITY_SITE, LIMIT_SITE, ...Object.keys(GROW).map((_, i) => `hp-grow-${i}`)]) await registerSite(siteId);
    await inSite(PARITY_SITE, seedParity);
    await inSite(LIMIT_SITE, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.content (tenant_id, contentid, contenthistid, siteid, moduleid, type, active, approved, lastupdatebyid, expires)` +
          ` SELECT $1, 'E' || lpad(n::text, 7, '0') || '-AAAA-BBBB-CCCCDDDDEEEEFFFF', 'H' || lpad(n::text, 7, '0') || '-AAAA-BBBB-CCCCDDDDEEEEFFFF',` +
          ` $2, $3, 'Page', 1, 1, $4, $5 FROM generate_series(1, 1005) AS n`,
        [tx.tenantId, LIMIT_SITE, SITE_MANAGER, USER, at('2026-07-15T00:00')],
      ),
    );
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it.each<[string, (siteId: string) => UserClaims, readonly string[] | null, HeaderPrompts]>([
    ['a group-limited user', groupLimited, [G1], { drafts: 6, submissions: 3, approvals: 3, expires: 5, pendingChangesets: 7 }],
    ['a super user', superUser, null, { drafts: 6, submissions: 3, approvals: 5, expires: 5, pendingChangesets: 7 }],
  ])('counts for %s the distinct ids of the listed rows and the per-change-set pending sum', async (_label, claimsFor, groupIds, expected) => {
    const claims = claimsFor(PARITY_SITE);
    const counts = await loadHeaderPrompts(deps, claims);
    expect(counts).toEqual(expected);
    expect(counts).toEqual(await listedCounts(deps, claims, groupIds));
  });

  it.each<[string, string, (tx: TenantTx, claims: UserClaims) => Promise<number>]>([
    [
      'drafts',
      'content_tenant_siteid_active_lastupdate_draft_idx',
      (tx, claims) => deps.repository.content.draftCount(tx, { siteId: claims.site, userId: claims.sub, startDate: cfDateAdd('m', -3, NOW) }),
    ],
    ['expiring items', 'content_tenant_siteid_expires_idx', (tx, claims) => deps.repository.content.expiringCount(tx, { siteId: claims.site, userId: claims.sub, today: NOW })],
  ])('reads the %s count through %s, which forced RLS leaves seekable', async (_label, index, count) => {
    const claims = superUser(PARITY_SITE);
    await handle.adminPool.query(`ANALYZE ${handle.schema}.content`);
    const plan = await withTenant(handle.app, claims.tid, async (tx) => {
      const statements: Array<{ text: string; values: unknown[] | undefined }> = [];
      const recording: TenantTx = {
        ...tx,
        query: (text, values) => {
          statements.push({ text: typeof text === 'string' ? text : text.text, values });
          return tx.query(text, values);
        },
      };
      await count(recording, claims);
      const counted = statements.at(-1);
      if (counted === undefined) throw new Error('the count ran no statement');
      // Without the sequential scan the planner takes the cheapest index whose conditions RLS lets it apply.
      await tx.query('SET LOCAL enable_seqscan = off');
      return (await tx.query(`EXPLAIN (FORMAT JSON) ${counted.text}`, counted.values)).rows;
    });
    expect(JSON.stringify(plan)).toContain(`"Index Name":"${index}"`);
  });

  it('counts the expiring items of the first LEGACY_MAX_ROWS rows only', async () => {
    const claims = superUser(LIMIT_SITE);
    expect((await loadHeaderPrompts(deps, claims)).expires).toBe(1000);
    expect((await listedCounts(deps, claims, null)).expires).toBe(1000);
  });

  it.each(Object.entries(GROW).map(([label, grow], i) => [label, grow, `hp-grow-${i}`] as const))(
    'reads many %s with the round trips of one',
    async (_label, { field, seed }, siteId) => {
      const sizes = field === 'pendingChangesets' ? [1, 20] : [1, 50];
      const measured: Array<{ size: number; counts: unknown[]; roundTrips: unknown[] }> = [];
      let seeded = 0;
      for (const size of sizes) {
        await inSite(siteId, async (tx) => {
          for (let n = seeded + 1; n <= size; n += 1) await seed(tx, siteId, n);
        });
        seeded = size;
        const counts: unknown[] = [];
        const roundTrips: unknown[] = [];
        for (const claims of [groupLimited(siteId), superUser(siteId)]) {
          roundTrips.push(await counter.measure(async () => counts.push((await loadHeaderPrompts(deps, claims))[field])));
        }
        measured.push({ size, counts, roundTrips });
      }
      expect(measured.map(({ size, counts }) => ({ size, counts }))).toEqual(sizes.map((size) => ({ size, counts: [size, size] })));
      expect(measured[1]?.roundTrips).toEqual(measured[0]?.roundTrips);
    },
  );
});
