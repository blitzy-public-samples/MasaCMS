// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `bulkTarget` against `usp_survey_bulk_target` and a set-union model, and the fixture bulk-target route over a RecordingDb. */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { TENANT_A } from '@opt2/platform/testing';
import { bulkTarget, type BulkTargetInputItem, type BulkTargetPair, type BulkTargetPlan } from '../../src/domain/bulk-target.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { TEST_CLOCK, buildTestApp, headersFor, type RecordedTransaction, type TestApp } from '../helpers/app.js';

/** The stored targets `bulkTarget` compares against, in its own parameter shape. */
type Existing = Parameters<typeof bulkTarget>[0];

const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000000' };
const SITE_A = `?siteid=${TENANT_A.siteId}`;
const TARGET_INSERT = 'INSERT INTO "surveys"."survey_target" ';
const WRITE_STATEMENT = /^(?:INSERT|UPDATE|DELETE)\b/;

function asExisting(pairs: readonly BulkTargetPair[]): Existing {
  return pairs.map(({ siteid, groupName }) => ({ siteid, group_name: groupName }));
}

describe('bulkTarget', () => {
  it.each<[string, Existing, BulkTargetInputItem[], BulkTargetPlan]>([
    [
      'collapses a target repeated in the input into one insert',
      [],
      [{ siteID: 'tenant-b' }, { siteID: 'tenant-b' }],
      { toInsert: [{ siteid: 'tenant-b', groupName: null }], inserted: 1, total: 1 },
    ],
    ['skips a target the survey already has', [{ siteid: 'tenant-b', group_name: null }], [{ siteID: 'tenant-b' }], { toInsert: [], inserted: 0, total: 1 }],
    [
      'matches an absent and a null groupName to a stored NULL group',
      [{ siteid: 'tenant-b', group_name: null }],
      [{ siteID: 'tenant-b' }, { siteID: 'tenant-b', groupName: null }],
      { toInsert: [], inserted: 0, total: 1 },
    ],
    [
      'adds a named group beside the stored whole-site target',
      [{ siteid: 'tenant-b', group_name: null }],
      [{ siteID: 'tenant-b', groupName: 'Editors' }],
      { toInsert: [{ siteid: 'tenant-b', groupName: 'Editors' }], inserted: 1, total: 2 },
    ],
    [
      'adds the whole-site target beside a stored named group',
      [{ siteid: 'tenant-b', group_name: 'Editors' }],
      [{ siteID: 'tenant-b', groupName: null }],
      { toInsert: [{ siteid: 'tenant-b', groupName: null }], inserted: 1, total: 2 },
    ],
    [
      'matches site and group as the default collation does, ignoring case and trailing spaces',
      [{ siteid: 'tenant-b', group_name: 'Editors' }],
      [{ siteID: 'TENANT-B ', groupName: 'editors ' }],
      { toInsert: [], inserted: 0, total: 1 },
    ],
    [
      'lists only the new pairs, in input order, and counts the stored ones in total',
      [
        { siteid: 'tenant-a', group_name: null },
        { siteid: 'umbrella', group_name: 'Members' },
      ],
      [
        { siteID: 'umbrella', groupName: 'Members' },
        { siteID: 'tenant-b', groupName: 'Editors' },
        { siteID: 'tenant-a' },
        { siteID: 'umbrella' },
        { siteID: 'tenant-b', groupName: 'Editors' },
      ],
      {
        toInsert: [
          { siteid: 'tenant-b', groupName: 'Editors' },
          { siteid: 'umbrella', groupName: null },
        ],
        inserted: 2,
        total: 4,
      },
    ],
  ])('%s, from an array or its JSON text', (_case, existing, input, expected) => {
    expect(bulkTarget(existing, input)).toEqual(expected);
    expect(bulkTarget(existing, JSON.stringify(input))).toEqual(expected);
  });

  it('agrees with a set union of the stored and input pairs, and plans nothing more once applied', () => {
    const site = fc.constantFrom('tenant-a', 'tenant-b', 'umbrella', 'default');
    const group = fc.constantFrom('Editors', 'Members');
    const item: fc.Arbitrary<BulkTargetInputItem> = fc
      .tuple(site, fc.oneof(fc.option(group, { nil: undefined }), fc.constant(null)))
      .map(([siteID, groupName]) => (groupName === undefined ? { siteID } : { siteID, groupName }));
    // The unique constraint keeps the stored pairs distinct.
    const existing: fc.Arbitrary<Existing> = fc.uniqueArray(
      fc.record({ siteid: site, group_name: fc.option(group, { nil: null }) }),
      { selector: ({ siteid, group_name }) => `${siteid}\u0000${group_name}` },
    );
    // Reference model: the procedure inserts the set union of the pairs minus the stored ones.
    const key = (siteID: string, groupName: string | null | undefined): string => `${siteID}\u0000${groupName ?? null}`;

    fc.assert(
      fc.property(existing, fc.array(item, { maxLength: 16 }), fc.boolean(), (stored, input, asText) => {
        const storedKeys = new Set(stored.map(({ siteid, group_name }) => key(siteid, group_name)));
        const union = new Set([...storedKeys, ...input.map(({ siteID, groupName }) => key(siteID, groupName))]);
        const added = [...union].filter((pair) => !storedKeys.has(pair)).sort();

        const plan = bulkTarget(stored, asText ? JSON.stringify(input) : input);

        expect(plan.inserted).toBe(union.size - storedKeys.size);
        expect(plan.total).toBe(union.size);
        expect(plan.toInsert.map(({ siteid, groupName }) => key(siteid, groupName)).sort()).toEqual(added);
        expect(bulkTarget([...stored, ...asExisting(plan.toInsert)], input)).toEqual({ toInsert: [], inserted: 0, total: plan.total });
      }),
    );
  });
});

describe('fixture bulk-target route', () => {
  let built: TestApp | undefined;

  afterEach(async () => {
    await built?.app.close();
    built = undefined;
  });

  async function asManager(app: TestApp['app'], url: string, body: unknown) {
    const headers = { ...(await headersFor('surveys.manager', { site: TENANT_A.siteId })), ...CSRF_HEADERS, 'content-type': 'application/json' };
    return app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) });
  }

  /** Transactions the request recorded that wrote a row, and the survey_target rows each inserted, as bound values. */
  function writesSince(transactions: readonly RecordedTransaction[], start: number) {
    return transactions
      .slice(start)
      .filter(({ statements }) => statements.some(({ text }) => WRITE_STATEMENT.test(text)))
      .map(({ tenantId, committed, statements }) => ({
        tenantId,
        committed,
        targets: statements.filter(({ text }) => text.startsWith(TARGET_INSERT)).map(({ values }) => values),
      }));
  }

  const targets = [{ siteID: 'tenant-b' }, { siteID: 'TENANT-B' }, { siteID: 'umbrella', groupName: 'Editors' }, { siteID: 'umbrella', groupName: null }];

  it.each<[string, (id: string) => [string, unknown]]>([
    ['a JSON body array', (id) => [`${FIXTURE_BASE}/${id}/targets/bulk${SITE_A}`, { targets }]],
    ['JSON text in the body', (id) => [`${FIXTURE_BASE}/${id}/targets/bulk${SITE_A}`, { targets: JSON.stringify(targets) }]],
    ['JSON text in the query string', (id) => [`${FIXTURE_BASE}/${id}/targets/bulk${SITE_A}&targets=${encodeURIComponent(JSON.stringify(targets))}`, {}]],
  ])('adds the missing targets from %s in one tenant transaction, then none on a repeat', async (_case, call) => {
    built = await buildTestApp();
    const { app, db } = built;
    const created = await asManager(app, `${FIXTURE_BASE}${SITE_A}`, { title: 'Pulse' });
    expect(created.statusCode).toBe(200);
    const surveyId = (created.json() as { data: { survey_id: string } }).data.survey_id;
    const [url, body] = call(surveyId);

    const start = db.transactions.length;
    const first = await asManager(app, url, body);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ apiversion: 'v1', method: 'surveys.surveys.targets.bulk', data: { inserted: 3, total: 3 } });
    const now = TEST_CLOCK.now();
    // The site check stores each target under its registered site id, so TENANT-B repeats tenant-b.
    expect(writesSince(db.transactions, start)).toEqual([
      {
        tenantId: TENANT_A.tenantId,
        committed: true,
        targets: [
          [TENANT_A.tenantId, expect.stringMatching(CF_UUID), surveyId, 'tenant-b', null, now],
          [TENANT_A.tenantId, expect.stringMatching(CF_UUID), surveyId, 'umbrella', 'Editors', now],
          [TENANT_A.tenantId, expect.stringMatching(CF_UUID), surveyId, 'umbrella', null, now],
        ],
      },
    ]);
    const stored = db.rows('survey_target');
    expect(new Set(stored.map(({ target_id }) => target_id)).size).toBe(3);

    const again = db.transactions.length;
    const repeat = await asManager(app, url, body);

    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ apiversion: 'v1', method: 'surveys.surveys.targets.bulk', data: { inserted: 0, total: 3 } });
    expect(writesSince(db.transactions, again).flatMap(({ targets: inserted }) => inserted)).toEqual([]);
    expect(db.rows('survey_target')).toEqual(stored);
  });
});
