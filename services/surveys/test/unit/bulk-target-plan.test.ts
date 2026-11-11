// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Bulk targeting as `usp_survey_bulk_target` plans it, and its gated write with response grants over a recording transaction and repository. */
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import {
  tenantIdForSite,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import { fixedClock } from '@opt2/platform/testing';
import { SURVEY_RESPONSE_GRANT, applyBulkTarget, bulkTarget, parseBulkTargets, type BulkTargetPair } from '../../src/domain/bulk-target.js';
import type { DomainDeps } from '../../src/domain/surveys.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import { findSurvey, listTargets } from '../../src/repo/queries.js';
import type { SurveysRepository, TargetInsertResult } from '../../src/repo/repository.js';
import type { SurveyRow, SurveyTargetRow } from '../../src/repo/tables.js';

// The gated reads are replaced so the domain runs without PostgreSQL.
vi.mock(import('../../src/repo/queries.js'), async (importOriginal) => {
  const queries = await importOriginal();
  return { ...queries, findSurvey: vi.fn(queries.findSurvey), listTargets: vi.fn(queries.listTargets) };
});

const T0 = new Date(2026, 5, 30, 9, 0, 0);
const SURVEY_ID = 'AAAAAAAA-BBBB-CCCC-DDDDDDDDDDDDDDDD';
const USER_ID = '11111111-2222-3333-4444555566667777';
const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const TENANT_C = tenantIdForSite('tenant-c');

const SURVEY: SurveyRow = {
  tenant_id: TENANT_A,
  survey_id: SURVEY_ID,
  siteid: 'tenant-a',
  title: 'Pulse',
  status: 'DRAFT',
  created: T0,
  createdbyid: USER_ID,
  lastupdate: null,
  lastupdatebyid: null,
  launched_at: null,
};

type Step = [string, unknown];

function targetRow(siteid: string, group_name: string | null): SurveyTargetRow {
  return { tenant_id: TENANT_A, target_id: `${siteid}/${group_name ?? ''}`, survey_id: SURVEY_ID, siteid, group_name, created: T0 };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** A tenant-A transaction answering registry lookups from `registry` (keys lower-case), logging them and grant inserts, refusing other SQL. */
function recordingTx(registry: ReadonlyMap<string, string>, log: Step[]): TenantTx {
  return {
    kind: 'tenant',
    tenantId: TENANT_A,
    schema: 'surveys',
    onCommit: () => undefined,
    query<R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values: unknown[] = []): Promise<QueryResult<R>> {
      const sql = typeof text === 'string' ? text : text.text;
      const table = /^(?:SELECT tenant_id FROM|INSERT INTO) surveys\.(tenant_registry|tenant_grant) /.exec(sql)?.[1];
      if (table === undefined) {
        return Promise.reject(new Error(`unexpected SQL: ${sql}`));
      }
      log.push([table, values]);
      const tenant = table === 'tenant_registry' ? registry.get(String(values[0]).toLowerCase()) : undefined;
      const rows = tenant === undefined ? [] : [{ tenant_id: tenant }];
      return Promise.resolve({ command: '', rowCount: rows.length, oid: 0, fields: [], rows } as unknown as QueryResult<R>);
    },
  };
}

interface Setup {
  survey?: SurveyRow | null;
  existing?: SurveyTargetRow[];
  registry?: Record<string, string>;
  counts?: TargetInsertResult;
  insertError?: Error;
}

/** Domain deps over a recording transaction and repository; every read, insert and statement lands in `log` in call order. */
function setup({ survey = SURVEY, existing = [], registry = {}, counts, insertError }: Setup = {}) {
  const log: Step[] = [];
  const tenants: string[] = [];
  const tx = recordingTx(new Map(Object.entries(registry)), log);
  const db: TenantDb = {
    schema: 'surveys',
    withTenant<T>(tenantId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> {
      tenants.push(tenantId);
      return fn(tx);
    },
    withMetadata: () => Promise.reject(new Error('bulk targeting opens no metadata transaction')),
    end: () => Promise.resolve(),
  };
  vi.mocked(findSurvey).mockImplementation((_tx, surveyId) => {
    log.push(['findSurvey', surveyId]);
    return Promise.resolve(survey);
  });
  vi.mocked(listTargets).mockImplementation((_tx, surveyId) => {
    log.push(['listTargets', surveyId]);
    return Promise.resolve(existing);
  });
  const insertTargets = vi.fn<SurveysRepository['insertTargets']>((_tx, surveyId, pairs) => {
    log.push(['insertTargets', [surveyId, pairs]]);
    if (insertError !== undefined) {
      return Promise.reject(insertError);
    }
    return Promise.resolve(counts ?? { inserted: pairs.length, total: existing.length + pairs.length });
  });
  const deps: DomainDeps = { db, repository: { insertTargets } as unknown as SurveysRepository, clock: fixedClock(T0) };
  return { deps, tx, log, tenants, insertTargets };
}

beforeEach(() => {
  vi.mocked(findSurvey).mockReset();
  vi.mocked(listTargets).mockReset();
});

describe('parseBulkTargets', () => {
  it.each<[string, unknown]>([
    ['an absent param', undefined],
    ['a null param', null],
    ['an empty string', ''],
    ['text that is not JSON', '[{"siteID":'],
    ['JSON text of an object', '{"siteID":"tenant-b"}'],
    ['an object', { siteID: 'tenant-b' }],
    ['a number', 7],
    ['a null item', [null]],
    ['a string item', ['tenant-b']],
    ['an array item', [['tenant-b']]],
    ['an item without siteID', [{ groupName: 'Staff' }]],
    ['a lower-case siteid key', [{ siteid: 'tenant-b' }]],
    ['an inherited siteID', [Object.create({ siteID: 'tenant-b' }) as object]],
    ['an empty siteID', [{ siteID: '' }]],
    ['a null siteID', [{ siteID: null }]],
    ['an object siteID', [{ siteID: { id: 'tenant-b' } }]],
    ['an array siteID in JSON text', '[{"siteID":["tenant-b"]}]'],
    ['one bad item among good ones', [{ siteID: 'tenant-b' }, { siteID: '' }]],
  ])('raises invalidParameters for %s', (_case, input) => {
    const error = thrown(() => parseBulkTargets(input));

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({ type: 'invalidParameters' });
  });

  it('rethrows a RangeError from too deeply nested JSON text instead of invalidParameters', () => {
    const depth = 200_000;

    const error = thrown(() => parseBulkTargets(`${'['.repeat(depth)}${']'.repeat(depth)}`));

    expect(error).toBeInstanceOf(RangeError);
  });

  it.each<[string, unknown, BulkTargetPair[]]>([
    ['an empty array', [], []],
    ['empty JSON array text', '[]', []],
    [
      'JSON numbers by their source text',
      '[{"siteID":1.50,"groupName":10.0},{"siteID":12345678901234567890}]',
      [
        { siteid: '1.50', groupName: '10.0' },
        { siteid: '12345678901234567890', groupName: null },
      ],
    ],
    [
      'array numbers and booleans as text',
      [
        { siteID: 7, groupName: 2.5 },
        { siteID: true, groupName: false },
      ],
      [
        { siteid: '7', groupName: '2.5' },
        { siteid: 'true', groupName: 'false' },
      ],
    ],
    [
      'an absent, null, object or array groupName as a whole-site target',
      [{ siteID: 'a' }, { siteID: 'b', groupName: null }, { siteID: 'c', groupName: { name: 'Staff' } }, { siteID: 'd', groupName: ['Staff'] }],
      [
        { siteid: 'a', groupName: null },
        { siteid: 'b', groupName: null },
        { siteid: 'c', groupName: null },
        { siteid: 'd', groupName: null },
      ],
    ],
    ['an empty groupName as a named group', [{ siteID: 'tenant-b', groupName: '' }], [{ siteid: 'tenant-b', groupName: '' }]],
    ['a blank siteID as given', [{ siteID: '   ' }], [{ siteid: '   ', groupName: null }]],
    ['keys other than exact-case siteID and groupName as absent', [{ siteID: 'tenant-b', groupname: 'Staff', extra: 1 }], [{ siteid: 'tenant-b', groupName: null }]],
    [
      'values beyond the OPENJSON column lengths truncated',
      [{ siteID: 's'.repeat(30), groupName: 'g'.repeat(300) }],
      [{ siteid: 's'.repeat(25), groupName: 'g'.repeat(255) }],
    ],
  ])('reads %s as the procedure does', (_case, input, expected) => {
    expect(parseBulkTargets(input)).toEqual(expected);
  });

  it('collapses duplicates case-insensitively and ignoring trailing spaces, keeping the first spelling in input order', () => {
    const input = [
      { siteID: 'tenant-b', groupName: 'Staff' },
      { siteID: 'tenant-a' },
      { siteID: 'TENANT-B  ', groupName: 'staff ' },
      { siteID: 'Tenant-A', groupName: null },
      { siteID: 'tenant-a', groupName: '' },
      { siteID: 'tenant-a', groupName: '  ' },
      { siteID: ' tenant-a' },
      { siteID: 'tenant-a', groupName: 'Staff' },
      { siteID: 'tenant-a ', groupName: 'STAFF' },
    ];

    expect(parseBulkTargets(input)).toEqual([
      { siteid: 'tenant-b', groupName: 'Staff' },
      { siteid: 'tenant-a', groupName: null },
      { siteid: 'tenant-a', groupName: '' },
      { siteid: ' tenant-a', groupName: null },
      { siteid: 'tenant-a', groupName: 'Staff' },
    ]);
  });

  it('collapses values that become equal once truncated to the column length', () => {
    expect(parseBulkTargets([{ siteID: `${'x'.repeat(25)}1` }, { siteID: `${'X'.repeat(25)}2` }])).toEqual([
      { siteid: 'x'.repeat(25), groupName: null },
    ]);
  });
});

describe('bulkTarget', () => {
  it.each<[string | null, string | null | undefined, number]>([
    [null, undefined, 0],
    [null, null, 0],
    [null, 'Staff', 1],
    [null, '', 1],
    ['Staff', undefined, 1],
    ['Staff', null, 1],
    ['Staff', 'STAFF  ', 0],
    ['Staff', 'Board', 1],
    ['', null, 1],
    ['', '  ', 0],
  ])('plans existing group %j against input group %j as %i insert', (existingGroup, inputGroup, inserted) => {
    const item = inputGroup === undefined ? { siteID: 'TENANT-B ' } : { siteID: 'TENANT-B ', groupName: inputGroup };

    const plan = bulkTarget([{ siteid: 'tenant-b', group_name: existingGroup }], [item]);

    expect(plan).toEqual({
      toInsert: inserted === 1 ? [{ siteid: 'TENANT-B ', groupName: inputGroup ?? null }] : [],
      inserted,
      total: 1 + inserted,
    });
  });

  it('plans only the distinct input pairs the survey lacks, in input order, with the procedure counts', () => {
    const existing = [targetRow('tenant-a', null), targetRow('tenant-b', 'Staff'), targetRow('tenant-z', 'Board')];
    const input = JSON.stringify([
      { siteID: 'tenant-c' },
      { siteID: 'TENANT-A ' },
      { siteID: 'tenant-b', groupName: 'STAFF' },
      { siteID: 'tenant-b' },
      { siteID: 'tenant-c', groupName: null },
      { siteID: 'tenant-a', groupName: 'Staff' },
    ]);

    expect(bulkTarget(existing, input)).toEqual({
      toInsert: [
        { siteid: 'tenant-c', groupName: null },
        { siteid: 'tenant-b', groupName: null },
        { siteid: 'tenant-a', groupName: 'Staff' },
      ],
      inserted: 3,
      total: 6,
    });
  });

  it('counts the existing targets an empty input leaves in total', () => {
    expect(bulkTarget([targetRow('tenant-a', null), targetRow('tenant-b', 'Staff')], '[]')).toEqual({ toInsert: [], inserted: 0, total: 2 });
  });

  it('plans nothing more for the same input once its plan is applied', () => {
    const site = fc.constantFrom('tenant-a', 'TENANT-A', 'tenant-a  ', ' tenant-a', 'tenant-b', 'Tenant-B ');
    const group = fc.option(fc.constantFrom('Staff', 'staff ', 'STAFF', '', '  ', 'Board'), { nil: null });
    const items = fc.array(fc.record({ siteID: site, groupName: group }, { requiredKeys: ['siteID'] }), { maxLength: 12 });
    const asRows = (pairs: BulkTargetPair[]) => pairs.map(({ siteid, groupName }) => ({ siteid, group_name: groupName }));

    fc.assert(
      fc.property(items, items, (seeded, input) => {
        const existing = asRows(bulkTarget([], seeded).toInsert);
        const plan = bulkTarget(existing, input);
        const applied = [...existing, ...asRows(plan.toInsert)];

        expect(plan.inserted).toBe(plan.toInsert.length);
        expect(plan.total).toBe(applied.length);
        expect(bulkTarget(applied, input)).toEqual({ toInsert: [], inserted: 0, total: applied.length });
      }),
    );
  });
});

describe('applyBulkTarget', () => {
  it('inserts the planned targets, then grants survey-response once to each other registered tenant of the targeted sites', async () => {
    const { deps, tx, log, tenants, insertTargets } = setup({
      existing: [targetRow('tenant-b', 'Staff')],
      registry: { 'tenant-a': TENANT_A, 'tenant-b': TENANT_B, 'tenant-c': TENANT_C, 'tenant-c-alias': TENANT_C },
      counts: { inserted: 4, total: 6 },
    });
    const input = JSON.stringify([
      { siteID: 'tenant-b', groupName: 'Staff' },
      { siteID: 'TENANT-B ' },
      { siteID: 'tenant-a' },
      { siteID: 'tenant-d' },
      { siteID: 'tenant-c  ' },
      { siteID: 'tenant-c-alias', groupName: 'Board' },
    ]);

    const result = await applyBulkTarget(deps, { tenantId: TENANT_A, surveyId: SURVEY_ID, input });

    expect(result).toEqual({ inserted: 4, total: 6 });
    expect(tenants).toEqual([TENANT_A]);
    expect(SURVEY_RESPONSE_GRANT).toBe('survey-response');
    expect(log).toEqual([
      ['findSurvey', SURVEY_ID],
      ['listTargets', SURVEY_ID],
      [
        'insertTargets',
        [
          SURVEY_ID,
          [
            { siteId: 'TENANT-B ', groupName: null },
            { siteId: 'tenant-a', groupName: null },
            { siteId: 'tenant-d', groupName: null },
            { siteId: 'tenant-c  ', groupName: null },
            { siteId: 'tenant-c-alias', groupName: 'Board' },
          ],
        ],
      ],
      ['tenant_registry', ['tenant-b']],
      ['tenant_grant', [TENANT_A, TENANT_B, 'survey-response', SURVEY_ID]],
      ['tenant_registry', ['tenant-a']],
      ['tenant_registry', ['tenant-d']],
      ['tenant_registry', ['tenant-c']],
      ['tenant_grant', [TENANT_A, TENANT_C, 'survey-response', SURVEY_ID]],
      ['tenant_registry', ['tenant-c-alias']],
    ]);
    expect(insertTargets.mock.calls[0]?.[0]).toBe(tx);
    expect(insertTargets.mock.calls[0]).toHaveLength(3);
    expect(vi.mocked(findSurvey).mock.calls[0]?.[0]).toBe(tx);
    expect(vi.mocked(listTargets).mock.calls[0]?.[0]).toBe(tx);
  });

  it('still grants the targeted sites when every pair exists and nothing is inserted', async () => {
    const { deps, log } = setup({ existing: [targetRow('tenant-b', null)], registry: { 'tenant-b': TENANT_B } });

    const result = await applyBulkTarget(deps, { tenantId: TENANT_A, surveyId: SURVEY_ID, input: [{ siteID: 'Tenant-B' }] });

    expect(result).toEqual({ inserted: 0, total: 1 });
    expect(log.slice(2)).toEqual([
      ['insertTargets', [SURVEY_ID, []]],
      ['tenant_registry', ['Tenant-B']],
      ['tenant_grant', [TENANT_A, TENANT_B, 'survey-response', SURVEY_ID]],
    ]);
  });

  it.each([
    ['notFound', 'an unknown survey', null, FixtureApiError],
    ['invalidParameters', 'a known survey', SURVEY, LegacyApiError],
  ] as const)('answers %s for invalid targets of %s before reading targets or writing', async (type, _case, survey, errorClass) => {
    const { deps, log } = setup({ survey, registry: { 'tenant-b': TENANT_B } });

    const error = await applyBulkTarget(deps, { tenantId: TENANT_A, surveyId: SURVEY_ID, input: '[{"siteID":' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(errorClass);
    expect(error).toMatchObject({ type });
    expect(log).toEqual([['findSurvey', SURVEY_ID]]);
  });

  it('writes no grant when insertTargets fails', async () => {
    const failure = new Error('insert failed');
    const { deps, log } = setup({ registry: { 'tenant-b': TENANT_B }, insertError: failure });

    await expect(applyBulkTarget(deps, { tenantId: TENANT_A, surveyId: SURVEY_ID, input: [{ siteID: 'tenant-b' }] })).rejects.toBe(failure);
    expect(log.map(([step]) => step)).toEqual(['findSurvey', 'listTargets', 'insertTargets']);
  });
});
