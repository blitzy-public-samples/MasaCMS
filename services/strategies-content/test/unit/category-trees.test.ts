/** The category trees of the ccategory, carch and cchangesets screens over a throwaway `content` schema: one pool read per tree, legacy shape, HEAD's bytes streamed from the walk's cursor. */
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_UMBRELLA, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { DEFAULT_ROW_BATCH_SIZE, createContentRepository } from '../../src/repo/repository.js';
import { nestedJson } from '../../src/routes/v1/streamed-model.js';
import { buildTestApp, openContentGates, pgAvailable, userHeaders, withPgSchema, type ClientHandlers, type TestApp } from '../helpers/app.js';
import { roundTripCounter, type RoundTripCounter, type RoundTrips } from '../helpers/round-trips.js';

const SITE = TENANT_A.siteId;
const POOL = TENANT_UMBRELLA.siteId;
const UMBRELLA = TENANT_UMBRELLA.tenantId;
const USER = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const CHANGESET = 'D0000000-0001-4A5B-8C7D9E0F1A2B3C4D';
const VERSION = 'D0000000-0002-4A5B-8C7D9E0F1A2B3C4D';

/** identity's admin session store and CSRF token issue, as the carch raw panels read them. */
const IDENTITY: ClientHandlers = {
  identity: {
    'GET /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
    'POST /v1/csrf/tokens': (req) => ({
      status: 200,
      headers: {},
      body: { tokens: (req.json as { contexts: string[] }).contexts.map((context) => ({ context, csrf_token: `TOK-${context}`, csrf_token_expires: '260630235959000' })) },
    }),
  },
};

/** An umbrella category: of the pool site, top level, open and unrestricted unless given; always active and an interest group. */
interface Seeded {
  categoryid: string;
  name: string | null;
  parentid?: string | null;
  siteid?: string;
  isopen?: number;
  restrictgroups?: string | null;
}

/** A CF-format category id whose first group is `<prefix><n>`. */
const catId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(8 - prefix.length, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

/** `size` categories in five top-level trees; category `n` above five sits under category `floor(n / 3)`. */
const treeOf = (size: number): Seeded[] =>
  Array.from({ length: size }, (_, at) => {
    const n = at + 1;
    return { categoryid: catId('T', n), name: `Topic ${String(n).padStart(3, '0')}`, parentid: n <= 5 ? null : catId('T', Math.floor(n / 3)) };
  });

const RING = catId('CB', 1);
const TWIN = catId('CD', 1);
const FORM_TYPE = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const CSRF_FORM = { csrf_token: 'T', csrf_token_expires: '260630235959000' } as const;
const BATCH = DEFAULT_ROW_BATCH_SIZE;
const FETCH = /^FETCH FORWARD \d+ FROM content_rows_\d+$/;
const DECLARE = /^DECLARE content_rows_\d+ NO SCROLL CURSOR FOR WITH RECURSIVE tree AS /;
const CLOSE = /^CLOSE content_rows_\d+$/;
const JSON_TYPE = 'application/json; charset=utf-8';

/** The pools whose trees HEAD's buffered routes printed; each is a tenant's whole umbrella category table. */
const SEEDS: Readonly<Record<string, readonly Seeded[]>> = {
  empty: [],
  orphans: [{ categoryid: catId('CC', 1), name: 'Orphan', parentid: catId('CC', 2) }],
  // P's lower-case-named and Q's lower-case-only children; K's only child is another site's; a NULL name sorts first.
  parity: [
    { categoryid: catId('CA', 1), name: 'Parent' },
    { categoryid: catId('CA', 2), name: 'kid', parentid: catId('CA', 1), isopen: 0 },
    { categoryid: catId('CA', 3), name: 'Variant', parentid: catId('CA', 1).toLowerCase(), restrictgroups: 'Insiders' },
    { categoryid: catId('CA', 4), name: 'Quiet' },
    { categoryid: catId('CA', 5), name: 'Whisper', parentid: catId('CA', 4).toLowerCase() },
    { categoryid: catId('CA', 6), name: null },
    { categoryid: catId('CA', 7), name: 'Elsewhere', parentid: catId('CA', 2), siteid: 'other-site' },
  ],
  // Case twins sharing a child, a padded short id, name ties broken by id, restricted rows and a loop no top-level row reaches.
  twins: [
    { categoryid: TWIN, name: 'Twin' },
    { categoryid: TWIN.toLowerCase(), name: 'twin' },
    { categoryid: catId('CD', 3), name: 'Shared', parentid: TWIN.toLowerCase(), restrictgroups: 'Insiders,Members' },
    { categoryid: catId('CD', 4), name: 'Below shared', parentid: catId('CD', 3) },
    { categoryid: 'SHORTID', name: 'Short' },
    { categoryid: catId('CD', 6), name: 'Padded kid', parentid: 'shortid' },
    { categoryid: catId('CD', 7), name: 'Same' },
    { categoryid: catId('CD', 8), name: 'same', restrictgroups: 'Insiders' },
    { categoryid: catId('CD', 9), name: null, parentid: catId('CD', 7) },
    { categoryid: catId('CD', 10), name: 'Émile "quoted" <b>' },
    { categoryid: catId('CD', 11), name: 'emile', isopen: 0 },
    { categoryid: catId('CD', 12), name: 'Unreached', parentid: catId('CD', 13) },
    { categoryid: catId('CD', 13), name: 'Unreached loop', parentid: catId('CD', 12) },
  ],
  // 1,203 top-level rows over three batches, with NULL and tied names, and 300 children of every third row.
  wide: [
    ...Array.from({ length: 1203 }, (_, at): Seeded => {
      const n = at + 1;
      return { categoryid: catId('W', n), name: n % 7 === 0 ? null : `${n % 2 === 1 ? 'Wide' : 'wide'} ${String(n % 400).padStart(4, '0')}` };
    }),
    ...Array.from({ length: 300 }, (_, at): Seeded => ({
      categoryid: catId('K', at + 1),
      name: `Kid ${at % 50}`,
      parentid: catId('W', (at % 100) * 3 + 1),
      restrictgroups: at % 4 === 0 ? 'Insiders' : null,
      isopen: at % 3 === 0 ? 0 : 1,
    })),
  ],
  tree: treeOf(1300),
  // One chain 1,100 levels deep.
  deep: Array.from({ length: 1100 }, (_, at) => ({ categoryid: catId('D', at + 1), name: `Deep ${at + 1}`, parentid: at === 0 ? null : catId('D', at) })),
  // The ring's lower-case twin is its child with no stored child of its own: only the ccategory walk repeats it.
  'twin-child': [
    { categoryid: RING, name: 'Ring' },
    { categoryid: RING.toLowerCase(), name: 'Ring twin', parentid: RING },
  ],
  // The ring's twin is its stored child and has one of its own, so both walks list the twin under itself again.
  'case-variant': [
    { categoryid: RING, name: 'Ring' },
    { categoryid: RING.toLowerCase(), name: 'Ring twin', parentid: RING },
    { categoryid: catId('CB', 3), name: 'Yonder', parentid: RING.toLowerCase() },
  ],
  // The last root's twin repeats it past the first two batches of the walk.
  'late-cycle': [
    ...treeOf(1300),
    { categoryid: catId('T', 5).toLowerCase(), name: 'Zeta', parentid: catId('T', 5) },
    { categoryid: catId('Z', 1), name: 'Zeta kid', parentid: catId('T', 5).toLowerCase() },
  ],
};

/** The S2 administrator, or a user holding only the change-set and Site Manager module roles. */
type Who = 's2' | 'modules';

/** A streamed route: its label, method, URL, caller and the form a POST sends. */
type StreamedRoute = readonly [label: string, method: 'GET' | 'POST', url: string, who: Who, form?: Readonly<Record<string, string>>];

const STREAMED_ROUTES: readonly StreamedRoute[] = [
  ['ccategory list', 'GET', `/v1/sites/${SITE}/categories`, 's2'],
  ['ccategory edit', 'GET', `/v1/sites/${SITE}/categories/${catId('T', 1)}`, 's2'],
  ['ccategory rerender', 'POST', `/v1/sites/${SITE}/categories`, 's2', { action: 'add', categoryID: '', name: '', ...CSRF_FORM }],
  ['cchangesets list', 'GET', `/v1/sites/${SITE}/changesets`, 's2'],
  ['cchangesets edit', 'GET', `/v1/sites/${SITE}/changesets/${CHANGESET}`, 's2'],
  ['cchangesets rerender', 'POST', `/v1/sites/${SITE}/changesets`, 's2', { changesetID: CHANGESET, siteid: SITE, name: '', ...CSRF_FORM }],
  ['cchangesets list modules', 'GET', `/v1/sites/${SITE}/changesets`, 'modules'],
  ['cchangesets edit modules', 'GET', `/v1/sites/${SITE}/changesets/${CHANGESET}`, 'modules'],
];

/** Status, length and SHA-256 of the body HEAD's buffered route sent for each `seed|route`, every bean's `instanceid` and the first minted `changesetID` blanked. */
const HEAD_BODIES: Readonly<Record<string, readonly [number, number, string]>> = {
  'empty|ccategory list': [200, 24, 'a1529dd9c5df86527c7a0ba3b0db9b6c723e2eadf06f8ccb77cc897e884ba80e'],
  'empty|ccategory edit': [200, 504, 'd93bef41be201365aaaa181704cd8daec4a36866729bec8e4d354454ac28d7fb'],
  'empty|ccategory rerender': [200, 657, '673e6db229cdfab3dbf7081d15027ffd54456daebc12a939ea9b503c5d14c67d'],
  'empty|cchangesets list': [200, 165, '279516bb9f409e35b4b7727f048d284fe746f4bc15f7a5e4c52191a1997f7b40'],
  'empty|cchangesets edit': [200, 441, 'be0829fa33157cec9849e0fc96e0e6a6089fc3b72a5f7d02dad22de666fcf245'],
  'empty|cchangesets rerender': [200, 594, 'ef87746bd345b10cdb8c833c474feb8de12a2cb238c971de1c64e7d1a28d9035'],
  'empty|cchangesets list modules': [200, 165, '279516bb9f409e35b4b7727f048d284fe746f4bc15f7a5e4c52191a1997f7b40'],
  'empty|cchangesets edit modules': [200, 441, 'be0829fa33157cec9849e0fc96e0e6a6089fc3b72a5f7d02dad22de666fcf245'],
  'orphans|ccategory list': [200, 24, 'a1529dd9c5df86527c7a0ba3b0db9b6c723e2eadf06f8ccb77cc897e884ba80e'],
  'orphans|ccategory edit': [200, 504, 'd93bef41be201365aaaa181704cd8daec4a36866729bec8e4d354454ac28d7fb'],
  'orphans|ccategory rerender': [200, 657, '673e6db229cdfab3dbf7081d15027ffd54456daebc12a939ea9b503c5d14c67d'],
  'orphans|cchangesets list': [200, 165, '61be7b4690a5ca38f4bb86cb2e672fafd81e446b41345e3f3918ff4d85fd33f0'],
  'orphans|cchangesets edit': [200, 441, 'a57a87bdba533ef6e62964cade3c35f94ae69dabb40f02a9a577a8fbe0594916'],
  'orphans|cchangesets rerender': [200, 594, '8bfc81dee3c2d7134ba01a7aaad0063fd84b6a067a2060901a7e1a509144d8d7'],
  'orphans|cchangesets list modules': [200, 165, '61be7b4690a5ca38f4bb86cb2e672fafd81e446b41345e3f3918ff4d85fd33f0'],
  'orphans|cchangesets edit modules': [200, 441, 'a57a87bdba533ef6e62964cade3c35f94ae69dabb40f02a9a577a8fbe0594916'],
  'parity|ccategory list': [200, 1164, '72310ab9f16e43de59c4f4efc8140ae2822028670694d01f94c7e597e961bcfa'],
  'parity|ccategory edit': [200, 1644, 'fbfac620a5bab84c813923503d2b6f1d12d8089a7078f02285bcebd3b30ed9f5'],
  'parity|ccategory rerender': [200, 1797, '592c59f421a297f337e3d450305304ee4ff2964879185e9c3da4c9599c17cb91'],
  'parity|cchangesets list': [200, 865, '6216f3577741a361848bf0c99eab8d85292eca64a8a4e7806164a78e6c9cb254'],
  'parity|cchangesets edit': [200, 1072, 'bdb45297687c470fcea37a3f9593e1a134ab531f403c7ac76e73ae3cb4901b85'],
  'parity|cchangesets rerender': [200, 1225, '03f479d5eb054e557935a95f37d0d63ba4387508ae783177c73b5062ae076104'],
  'parity|cchangesets list modules': [200, 866, '32aeb7fc9ee239ecdfba88c15ac6ae879e7942876354873ab8987b586d8fc23b'],
  'parity|cchangesets edit modules': [200, 1073, '5c70c8770c68001a716b5ebd168a7a601d348cf80c9cb164d07c2a62654bdd92'],
  'twins|ccategory list': [200, 2531, '4582c523953896c7a5a3b37d5e34f694948d834bcb0675f210887c2bdaafee2d'],
  'twins|ccategory edit': [200, 3011, 'bbd0c30ff97b99f399e761c035f11a088a0c932b3e2cf43af4b795af1b6cc76e'],
  'twins|ccategory rerender': [200, 3164, 'dcf8c8b6974fbc7be925359b0c34db1854c506fd6592d4c971956f70b5936434'],
  'twins|cchangesets list': [200, 1553, '0cf08eb42066d08f9b7f2ae65de4ff6d0c3c68948e8c9e6839513c0c906c2674'],
  'twins|cchangesets edit': [200, 1692, '481f117a0169f306532e9a5ea7e228f6d17bbfced0c5baa0db8a3a0f82fe17b8'],
  'twins|cchangesets rerender': [200, 1845, '3dc5c0fa28a0e4e209bac9929a3a8b320183df8caa8ff43ebd07828ab829e2e3'],
  'twins|cchangesets list modules': [200, 1555, '0d3891c1525912f32ae8b54fde667a304c65eafcef824f95c990b496a2a354e3'],
  'twins|cchangesets edit modules': [200, 1694, '36cde29163b45d883fb31701b786f1e548e64c7ca8aad9967dda11f03dd0992a'],
  'wide|ccategory list': [200, 273052, '41c08a82bddc79854034079dd380f7492bd1c5deefa0652c9c1f7aa7f32747a5'],
  'wide|ccategory edit': [200, 273532, '146906b64257fab16c3b5b375141d86c1b7e5eaafe0e606be96c6e7c7485ee29'],
  'wide|ccategory rerender': [200, 273685, '58c0e610f8f5f3cd2ddd3584d2e8eb090ea9104d17474af70e87799d4724d1d5'],
  'wide|cchangesets list': [200, 205061, '7a478fd85799cb6c9d9ae266018337727ce950725a6dee4214f4274e5b32282a'],
  'wide|cchangesets edit': [200, 184395, 'd26154090e6a4ca5f76758c38c2680a897414082979c3a9a30f06a1baf350aab'],
  'wide|cchangesets rerender': [200, 184548, 'a446de0d5a4e40c0e6140dbfd3da7c07389b2654185940e17c056090bebaa994'],
  'wide|cchangesets list modules': [200, 205136, '674f45ddf5ce4b1b1846e4334ad6463948520bf2d776d56d1810acc00aed0c54'],
  'wide|cchangesets edit modules': [200, 184470, '0ce59fe7cde4659ffa3ac3db4094f5761948f6d38e48155b410a24a03c8507f5'],
  'tree|ccategory list': [200, 274017, '6c2f666cd8e1288eae82adb38c3fd961498308344fca7604a5e8026bc00eeb0f'],
  'tree|ccategory edit': [200, 274495, 'c134718ac0943683a91d06a52bd2af08814d286ad0fe079d28ca92d41bb8eb2f'],
  'tree|ccategory rerender': [200, 274650, 'bebc9f930650c598609436cb0723ff1bd8748b0579701c3b20939e48bdf1e52b'],
  'tree|cchangesets list': [200, 215661, 'ab1809c48c977d79cee678f71483ab050c1b58c15afc3d37c5f4a8dc33eccca6'],
  'tree|cchangesets edit': [200, 198169, 'd101ae59b6a016a5a83f33fdaeab0c0adbb64e26518c395b856533371f8b2b2f'],
  'tree|cchangesets rerender': [200, 198322, '5498e6b8013cab5391e83fffcb5bed0c4ae810727fa3c7896c2acaab7b23a759'],
  'tree|cchangesets list modules': [200, 215661, 'ab1809c48c977d79cee678f71483ab050c1b58c15afc3d37c5f4a8dc33eccca6'],
  'tree|cchangesets edit modules': [200, 198169, 'd101ae59b6a016a5a83f33fdaeab0c0adbb64e26518c395b856533371f8b2b2f'],
  'deep|ccategory list': [200, 229882, '7b0b77acbbeb05421a7faddaa8570c70bc07ca8cab4d8307a209f123ca104226'],
  'deep|ccategory edit': [200, 230362, '53d59e35ed805987c658fbaa0c6f2f717c24c1be0cec8d11299febedd7b2a979'],
  'deep|ccategory rerender': [200, 230515, '49d939af2ee7b6fdea310a100bfe0f24314e1015739af182baf2b334bb4a1ec4'],
  'deep|cchangesets list': [200, 180526, 'fa0b8fb928ac951874e5faaa25888990c297e1ca90e6ad85f3a8054dd0aa5111'],
  'deep|cchangesets edit': [200, 166501, 'ca03f088fa61c5bacf9484a83a72bbe745856dcde030900202be364f6e37e081'],
  'deep|cchangesets rerender': [200, 166654, '54736ce5ad25c7010bd00b5c3192f1a5a8d1b1b0597b92a811c52efeb0390350'],
  'deep|cchangesets list modules': [200, 180526, 'fa0b8fb928ac951874e5faaa25888990c297e1ca90e6ad85f3a8054dd0aa5111'],
  'deep|cchangesets edit modules': [200, 166501, 'ca03f088fa61c5bacf9484a83a72bbe745856dcde030900202be364f6e37e081'],
  'twin-child|ccategory list': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'twin-child|ccategory edit': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'twin-child|ccategory rerender': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'twin-child|cchangesets list': [200, 455, 'b793264d33f259c13e42005a9ec9f12ddfc55cc29ee811a5647fafd7c4f82293'],
  'twin-child|cchangesets edit': [200, 704, '43d3f9b3d92b68a51dd03e401aedbcdf8786d23c42ed65750d9379691716235b'],
  'twin-child|cchangesets rerender': [200, 857, '23f5b6a4a4c5153328e85a2900a8db0277e1c2f10110919f1a1624e9a02f2e4a'],
  'twin-child|cchangesets list modules': [200, 455, 'b793264d33f259c13e42005a9ec9f12ddfc55cc29ee811a5647fafd7c4f82293'],
  'twin-child|cchangesets edit modules': [200, 704, '43d3f9b3d92b68a51dd03e401aedbcdf8786d23c42ed65750d9379691716235b'],
  'case-variant|ccategory list': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'case-variant|ccategory edit': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'case-variant|ccategory rerender': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'case-variant|cchangesets list': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'case-variant|cchangesets edit': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'case-variant|cchangesets rerender': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'case-variant|cchangesets list modules': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'case-variant|cchangesets edit modules': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'late-cycle|ccategory list': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'late-cycle|ccategory edit': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'late-cycle|ccategory rerender': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'late-cycle|cchangesets list': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'late-cycle|cchangesets edit': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'late-cycle|cchangesets rerender': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'late-cycle|cchangesets list modules': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
  'late-cycle|cchangesets edit modules': [500, 102, '9d9f0f60a17db44faa10bec6147a11f66476d4d9b0abd768c9d76c3dd9efac2e'],
};

/** `body` with every per-read bean `instanceid` and the first, per-request `changesetID` of a new change set blanked. */
const blankMinted = (body: Buffer): Buffer =>
  Buffer.from(body.toString('utf8').replace(/"instanceid":"[^"]*"/g, '"instanceid":""').replace(/"changesetID":"[^"]*"/, '"changesetID":""'), 'utf8');
const digestOf = (body: Buffer): [number, string] => [body.length, createHash('sha256').update(body).digest('hex')];

describe.skipIf(!(await pgAvailable()))('category trees', () => {
  let handle: ThrowawaySchema;
  let counter: RoundTripCounter;
  let t: TestApp<RoundTripCounter['db']>;

  /** Replaces the umbrella tenant's categories with `rows`, in one transaction. */
  const seed = (rows: readonly Seeded[]): Promise<void> =>
    withTenant(handle.app, UMBRELLA, async (tx) => {
      await tx.query(`DELETE FROM ${handle.schema}.category`);
      await tx.query(
        `INSERT INTO ${handle.schema}.category (tenant_id, categoryid, siteid, parentid, name, isopen, isactive, isinterestgroup, restrictgroups)` +
          ' SELECT $1::uuid, r.id, r.site, r.parent, r.name, r.open, 1, 1, r.groups' +
          ' FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::integer[], $7::text[]) AS r(id, site, parent, name, open, groups)',
        [
          UMBRELLA,
          rows.map((row) => row.categoryid),
          rows.map((row) => row.siteid ?? POOL),
          rows.map((row) => row.parentid ?? null),
          rows.map((row) => row.name),
          rows.map((row) => row.isopen ?? 1),
          rows.map((row) => row.restrictgroups ?? null),
        ],
      );
    });

  /** GET `url` as tenant-a's S2 administrator. */
  const get = async (url: string) =>
    t.app.inject({ method: 'GET', url, headers: await userHeaders({ sub: USER, site: SITE, roles: [Roles.s2], s2: true }) });

  const ROUTES = [
    ['ccategory list', `/v1/sites/${SITE}/categories`],
    ['ccategory edit', `/v1/sites/${SITE}/categories/${catId('T', 1)}`],
    ['carch loadrelatedcontent', `/v1/raw/carch/loadrelatedcontent?siteid=${SITE}&contenthistid=${VERSION}`],
    ['carch loadsiteflat', `/v1/raw/carch/loadsiteflat?siteid=${SITE}`],
    ['cchangesets list', `/v1/sites/${SITE}/changesets`],
    ['cchangesets edit', `/v1/sites/${SITE}/changesets/${CHANGESET}`],
  ] as const;

  let log: string[] | undefined;
  let hold: { at: number; seen: number; reach: () => void; gate: Promise<void> } | undefined;

  const headersOf = (who: Who): Promise<Record<string, string>> =>
    who === 's2'
      ? userHeaders({ sub: USER, site: SITE, roles: [Roles.s2], s2: true })
      : userHeaders({ sub: USER, site: SITE, roles: [Roles.systemUser, moduleRole('00000000000000000000000000000000014'), moduleRole('00000000000000000000000000000000000')] });

  /** One streamed route through inject: its status, headers and bytes, its round trips and the SQL its pool ran. */
  const send = async ([, method, url, who, form]: StreamedRoute) => {
    const headers = { ...(await headersOf(who)), ...(form === undefined ? {} : FORM_TYPE) };
    const sql: string[] = [];
    let res: Awaited<ReturnType<typeof t.app.inject>> | undefined;
    log = sql;
    try {
      const trips = await counter.measure(async () => {
        res = await t.app.inject({ method, url, headers, ...(form === undefined ? {} : { payload: new URLSearchParams(form).toString() }) });
      });
      return { status: res?.statusCode ?? 0, headers: res?.headers ?? {}, body: res?.rawPayload ?? Buffer.alloc(0), trips, sql };
    } finally {
      log = undefined;
    }
  };

  /** A streamed GET over a socket; `onChunk` sees the count read so far, and answering true drops the connection. */
  const receive = async ([, , url, who]: StreamedRoute, onChunk: (count: number) => boolean) => {
    const headers = await headersOf(who);
    const { port } = t.app.server.address() as AddressInfo;
    return new Promise<{ status: number; headers: IncomingHttpHeaders; chunks: Buffer[]; complete: boolean }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: url, headers: { ...headers, connection: 'close' }, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        const done = (): void => resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks, complete: res.complete });
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (onChunk(chunks.length)) {
            req.destroy();
            done();
          }
        });
        res.on('end', done);
        res.on('error', done);
        res.on('close', done);
      });
      req.on('error', reject);
      req.end();
    });
  };

  /** Holds the `at`-th FETCH the pool runs from now on until `release`. */
  const holdFetch = (at: number): { reached: Promise<void>; release: () => void } => {
    let reach: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold = { at, seen: 0, reach, gate };
    return { reached, release };
  };

  /** Resolves once `ready` holds, polling every 20 ms. */
  const until = async (ready: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 300_000;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const poolIdle = (): boolean => handle.appPool.waitingCount === 0 && handle.appPool.idleCount === handle.appPool.totalCount;
  const serverConnections = (): Promise<number> =>
    new Promise((resolve, reject) => {
      t.app.server.getConnections((error, count) => (error === null ? resolve(count) : reject(error)));
    });

  beforeAll(async () => {
    handle = await withPgSchema();
    await openContentGates(handle);
    await seedRegistry(handle.app, handle.schema);
    counter = roundTripCounter(handle);
    const wrapped = new WeakSet<object>();
    handle.appPool.on('acquire', (client) => {
      if (wrapped.has(client)) return;
      wrapped.add(client);
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      Object.defineProperty(client, 'query', {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          const first = args[0];
          const sql = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
          log?.push(sql);
          const held = hold;
          if (held !== undefined && FETCH.test(sql) && (held.seen += 1) === held.at) {
            hold = undefined;
            held.reach();
            return held.gate.then(() => query(...args));
          }
          return query(...args);
        },
      });
    });
    t = await buildTestApp({ db: counter.db, env: { LOG_LEVEL: 'error' }, clientHandlers: IDENTITY });
  });

  afterAll(async () => {
    await t?.close();
    await handle?.drop();
  });

  beforeEach(() => {
    t.client.clear();
  });

  it.each(ROUTES)('%s runs as many statements for a deep 100-category tree as for one category', async (_label, url) => {
    const counts = [];
    for (const size of [1, 100]) {
      await seed(treeOf(size));
      let status = 0;
      counts.push(await counter.measure(async () => {
        status = (await get(url)).statusCode;
      }));
      expect(status).toBe(200);
    }
    expect(counts[1]).toEqual(counts[0]);
  });

  describe('legacy shape', () => {
    // P's stored child K is what haskids counts; V names P in lower case, and Q only by lower case, so Q counts none.
    // K's only stored child belongs to another site of the umbrella tenant: counted, never listed.
    const P = catId('CA', 1);
    const K = catId('CA', 2);
    const V = catId('CA', 3);
    const Q = catId('CA', 4);
    const W = catId('CA', 5);
    const N = catId('CA', 6);
    const ELSEWHERE = catId('CA', 7);
    const PARITY: Seeded[] = [
      { categoryid: P, name: 'Parent' },
      { categoryid: K, name: 'kid', parentid: P, isopen: 0 },
      { categoryid: V, name: 'Variant', parentid: P.toLowerCase(), restrictgroups: 'Insiders' },
      { categoryid: Q, name: 'Quiet' },
      { categoryid: W, name: 'Whisper', parentid: Q.toLowerCase() },
      { categoryid: N, name: null },
      { categoryid: ELSEWHERE, name: 'Elsewhere', parentid: K, siteid: 'other-site' },
    ];

    beforeEach(async () => {
      await seed(PARITY);
    });

    const ccNode = (categoryID: string, parentID: string, name: string, hasKids: number, children: unknown[] = [], extra: Record<string, unknown> = {}) => ({
      categoryID,
      parentID,
      name,
      hasKids,
      isOpen: 1,
      isInterestGroup: 1,
      isActive: 1,
      restrictGroups: '',
      children,
      ...extra,
    });

    it('ccategory nests every row by case-insensitive parent id, whatever its child count, in name order', async () => {
      const res = await get(`/v1/sites/${SITE}/categories`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        rc: {
          categories: [
            ccNode(N, '', '', 0),
            ccNode(P, '', 'Parent', 1, [
              ccNode(K, P, 'kid', 1, [], { isOpen: 0 }),
              ccNode(V, P.toLowerCase(), 'Variant', 0, [], { restrictGroups: 'Insiders' }),
            ]),
            ccNode(Q, '', 'Quiet', 0, [ccNode(W, Q.toLowerCase(), 'Whisper', 0)]),
          ],
        },
      });
    });

    it('cchangesets descends only rows with stored children, numbering every pool category', async () => {
      const res = await get(`/v1/sites/${SITE}/changesets/${CHANGESET}`);
      expect(res.statusCode).toBe(200);
      const { rc } = res.json<{ rc: Record<string, unknown> }>();
      const row = (categoryID: string, parentID: string, name: string, isOpen = true) => ({ categoryID, parentID, name, isOpen, permitted: true });
      expect(rc.categoryCount).toBe(6);
      expect(rc.categories).toEqual([
        row(N, '', ''),
        row(P, '', 'Parent'),
        row(K, P, 'kid', false),
        row(V, P.toLowerCase(), 'Variant'),
        row(Q, '', 'Quiet'),
      ]);
    });

    /** dsp_categories_nest.cfm's related-content checkbox tree of `[id, name, open, kids]` nodes. */
    const relatedNest = (nodes: ReadonlyArray<readonly [string, string, boolean, readonly unknown[]]>, top = true): string =>
      `<ul class="categories${top ? ' checkboxTree' : ''}">\n` +
      nodes
        .map(([id, name, open, kids]) => {
          const text = `${open ? `<input type="checkbox" name="rcCategoryID" class="checkbox"  value="${id}"/> ` : ''}${name}`;
          const below = kids.length > 0 ? `\n${relatedNest(kids as ReadonlyArray<readonly [string, string, boolean, readonly unknown[]]>, false)}\n` : '';
          // The template's whitespace after the name collapses into a space the checkbox already ends with.
          return `\n<li>\n${text}${text.endsWith(' ') ? '' : ' '}${below}\n</li>\n`;
        })
        .join('') +
      '\n</ul>';

    it('carch descends only rows with stored children', async () => {
      const res = await get(`/v1/raw/carch/loadrelatedcontent?siteid=${SITE}&contenthistid=${VERSION}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(
        relatedNest([
          [N, '', true, []],
          [P, 'Parent', true, [[K, 'kid', false, []], [V, 'Variant', true, []]]],
          [Q, 'Quiet', true, []],
        ]),
      );
    });

    it('prints no tree, though cchangesets still counts them, for pool categories that all sit under a missing parent', async () => {
      await seed([{ categoryid: catId('CC', 1), name: 'Orphan', parentid: catId('CC', 2) }]);
      const { rc } = (await get(`/v1/sites/${SITE}/changesets/${CHANGESET}`)).json<{ rc: Record<string, unknown> }>();
      expect([rc.categoryCount, rc.categories]).toEqual([1, []]);
      expect((await get(`/v1/sites/${SITE}/categories`)).json()).toEqual({ rc: { categories: [] } });
    });

    describe('a category listed under its own case-variant id', () => {
      // R's lower-case twin X is R's stored child, and Y is X's: each level under R or X lists both again.
      const R = catId('CB', 1);
      const X = R.toLowerCase();
      const Y = catId('CB', 3);

      beforeEach(async () => {
        await seed([
          { categoryid: R, name: 'Ring' },
          { categoryid: X, name: 'Ring twin', parentid: R },
          { categoryid: Y, name: 'Yonder', parentid: X },
        ]);
      });

      it.each([
        ['ccategory list', `/v1/sites/${SITE}/categories`],
        ['cchangesets edit', `/v1/sites/${SITE}/changesets/${CHANGESET}`],
      ])('fails the %s, as the legacy walk would never end', async (_label, url) => {
        expect((await get(url)).statusCode).toBe(500);
      });

      it('stops the carch walk at the repeated category', async () => {
        const res = await get(`/v1/raw/carch/loadrelatedcontent?siteid=${SITE}&contenthistid=${VERSION}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain(relatedNest([[R, 'Ring', true, [[X, 'Ring twin', true, []], [Y, 'Yonder', true, []]]]]));
      });
    });
  });

  describe('streamed from the walk cursor', () => {
    it.each(Object.keys(SEEDS))('prints HEAD bytes for the %s pool on every streamed route, a 200 chunked and a failure whole', async (name) => {
      await seed(SEEDS[name] ?? []);
      for (const route of STREAMED_ROUTES) {
        const res = await send(route);
        const key = `${name}|${route[0]}`;
        const [status, ...digest] = HEAD_BODIES[key] ?? [];
        expect([key, res.status, digestOf(blankMinted(res.body))]).toEqual([key, status, digest]);
        if (res.status === 200) {
          expect([key, res.headers['content-type'], res.headers['transfer-encoding'], res.headers['content-length']]).toEqual([key, JSON_TYPE, 'chunked', undefined]);
          const text = res.body.toString('utf8');
          expect(JSON.stringify(JSON.parse(text))).toBe(text);
        } else {
          // A walk reaching its own ancestor fails at its first batch, however late the repeat comes, before any byte is sent.
          expect([key, res.headers['transfer-encoding'], res.headers['content-length']]).toEqual([key, undefined, String(res.body.length)]);
          expect([key, res.sql.filter((sql) => FETCH.test(sql)).length]).toEqual([key, 1]);
        }
      }
    });

    const GETS = STREAMED_ROUTES.filter(([, method, , who]) => method === 'GET' && who === 's2').map((route) => [route[0], route] as const);

    it.each(GETS)('%s reads one more FETCH per further 500 walked categories from one cursor, and nothing more', async (_label, route) => {
      const sent = new Map<number, RoundTrips>();
      for (const size of [1, 2, 501, 1001]) {
        await seed(treeOf(size));
        const res = await send(route);
        expect(res.status).toBe(200);
        expect([size, res.sql.filter((sql) => DECLARE.test(sql)).length, res.sql.filter((sql) => FETCH.test(sql)).length]).toEqual([size, 1, Math.floor(size / BATCH) + 1]);
        sent.set(size, res.trips);
      }
      const base = sent.get(1) as RoundTrips;
      for (const [size, trips] of sent) {
        expect([size, trips]).toEqual([size, { statements: base.statements + Math.floor(size / BATCH), transactions: base.transactions }]);
      }
    });

    it.each([
      ['twin-child', 'every', RING.toLowerCase()],
      ['twin-child', 'withKids', null],
      ['case-variant', 'every', RING.toLowerCase()],
      ['case-variant', 'withKids', RING.toLowerCase()],
      ['late-cycle', 'every', catId('T', 5).toLowerCase()],
      ['late-cycle', 'withKids', catId('T', 5).toLowerCase()],
      ['twins', 'every', null],
    ] as const)('names on every row the first category of the %s pool that a walk into %s rows reaches as its own ancestor: %s', async (name, descend, cycle) => {
      await seed(SEEDS[name] ?? []);
      const repo = createContentRepository({ schema: handle.schema });
      const cycles = await withTenant(handle.app, UMBRELLA, async (tx) => {
        const seen = new Set<string | null>();
        for await (const rows of repo.categories.categoryWalkBatches(tx, { siteId: POOL, descend })) for (const row of rows) seen.add(row.cycle);
        return seen;
      });
      expect(cycles).toEqual(new Set([cycle]));
    });

    it('nests nodes as JSON.stringify prints them and refuses a depth no pre-order walk reaches', () => {
      const nest = nestedJson('children');
      const text = [nest.node(0, { a: 1 }), nest.node(1, {}), nest.node(2, { b: 'x' }), nest.node(1, { c: null }), nest.node(0, { d: [1] }), nest.end()].join('');
      expect(`[${text}]`).toBe(JSON.stringify([{ a: 1, children: [{ children: [{ b: 'x', children: [] }] }, { c: null, children: [] }] }, { d: [1], children: [] }]));
      expect(nest.end()).toBe('');
      expect(() => nest.node(1, {})).toThrow(RangeError);
    });

    describe('over a socket', () => {
      beforeAll(async () => {
        await seed(treeOf(1300));
        await t.app.listen({ host: '127.0.0.1', port: 0 });
      });

      it.each(GETS)('%s reaches the client in more than one chunk with the bytes inject reads, holding one connection between batches', async (_label, route) => {
        const whole = await send(route);
        await until(poolIdle, 'the pool to go idle');
        const held = holdFetch(2);
        let inUse = -1;
        void held.reached.then(() => {
          inUse = handle.appPool.totalCount - handle.appPool.idleCount;
        });
        const got = await receive(route, (count) => {
          if (count === 1) held.release();
          return false;
        });
        expect([got.status, got.complete, got.headers['content-type'], got.headers['transfer-encoding']]).toEqual([200, true, JSON_TYPE, 'chunked']);
        expect(got.chunks.length).toBeGreaterThan(1);
        expect(blankMinted(Buffer.concat(got.chunks)).equals(blankMinted(whole.body))).toBe(true);
        // The memberships and pools are read before the cursor opens, so its transaction is the one connection the walk holds.
        expect(inUse).toBe(1);
        await until(poolIdle, 'the pool to go idle');
      });

      it.each(GETS)('%s closes its cursor and ends its transaction when the client goes mid-stream', async (_label, route) => {
        const held = holdFetch(2);
        const sql: string[] = [];
        log = sql;
        try {
          const got = await receive(route, () => true);
          await held.reached;
          expect(got.complete).toBe(false);
          await until(async () => (await serverConnections()) === 0, 'the server to drop the connection');
          held.release();
          await until(poolIdle, 'the pool to go idle');
        } finally {
          log = undefined;
        }
        expect(sql.filter((statement) => FETCH.test(statement))).toHaveLength(2);
        expect(sql.slice(-2)).toEqual([expect.stringMatching(CLOSE), 'COMMIT']);
      });
    });
  });
});
