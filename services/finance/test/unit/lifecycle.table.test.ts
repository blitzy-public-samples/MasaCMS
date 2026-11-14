// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The generated finance transition table: its agreement with the lifecycle and the fixture-oracle export, and every row driven through both route families. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { CHANGELOG_TABLE } from '@opt2/platform/migration-kit';
import { SAME_NEW_VERSION, generateTable, serializeTable, type TransitionTableRow } from '@opt2/platform/state-machine';
import { assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import { FINANCE_ACTIONS, FINANCE_ROLES, FINANCE_STATES, financeLifecycle, type FinanceState } from '../../src/domain/lifecycle.transitions.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/envelope.js';
import { FINANCE_RECORD, FINANCE_RECORD_VERSION, SCHEMA, type FinanceRecordRow } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { programBindingRow, recordRow, versionRow } from '../helpers/records.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const TABLE_TEXT = readFileSync(new URL('../generated/transition-table.json', import.meta.url), 'utf8');
const ROWS = JSON.parse(TABLE_TEXT) as TransitionTableRow[];

/** One row of the fixture-oracle export that `legacy-fixtures/load-fixtures.sh` loads into `synthetic.finance_transition`. */
interface ExportRow {
  from: string;
  action: string;
  role: string;
  outcome: 'legal' | 'illegal-state' | 'wrong-role';
  status: '2xx' | '409' | '403';
  to: string | null;
  newVersion?: true;
  error?: string;
}

const EXPORT = JSON.parse(readFileSync(new URL('../../../../opt2/reports/state-machines/finance.json', import.meta.url), 'utf8')) as {
  rows: ExportRow[];
};

const SITE = 'tenant-a';
/** Masa `UserID` of the acting user and the seeded record's creator: a CF UUID, as the contract requires of both user columns. */
const ACTOR = 'F1A2B3C4-1111-4000-8000000000000008';
const RECORD_TABLE = `${SCHEMA}.${FINANCE_RECORD.table}`;
const VERSION_TABLE = `${SCHEMA}.${FINANCE_RECORD_VERSION.table}`;
const CHANGELOG = `${SCHEMA}.${CHANGELOG_TABLE}`;
const OUTCOME_OF_STATUS = { 200: 'legal', 409: 'illegal-state', 403: 'wrong-role' } as const;

/** A valid `edit` body under finance.cfc recordFields: non-blank title, four-decimal amount, `yyyy-mm` period. */
const EDIT_BODY = Object.freeze({ title: 'Edited by lifecycle table', amount: '99.5000', period: '2026-07' });

type Family = readonly [name: string, url: (id: string, action: string) => string];

const FAMILIES: readonly Family[] = [
  ['fixture', (id, action) => `${FIXTURE_PREFIX}/records/${id}/${action}`],
  ['v1', (id, action) => `/v1/finance/records/${id}/transitions/${action}`],
];

type Step = { action: string; state: FinanceState };

/** The shortest legal history reaching `state`, from the `create` that leaves a record IN-PROGRESS. */
function historyTo(state: FinanceState): Step[] {
  const histories = new Map<FinanceState, Step[]>([['IN-PROGRESS', [{ action: 'create', state: 'IN-PROGRESS' }]]]);
  for (const [at, steps] of histories) {
    for (const row of financeLifecycle.rows) {
      if (row.to !== SAME_NEW_VERSION && row.from.includes(at) && !histories.has(row.to)) {
        histories.set(row.to, [...steps, { action: row.action, state: row.to }]);
      }
    }
  }
  const history = histories.get(state);
  if (history === undefined) throw new Error(`no legal history reaches ${state}`);
  return history;
}

const opened: TestApp[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.app.close()));
});

/** An app whose tenant-a program holds one record in `state` with its version rows, its write log cleared. */
async function seeded(state: FinanceState): Promise<{ t: TestApp; record: FinanceRecordRow }> {
  const history = historyTo(state);
  const fixture = recordRow({ state, version: history.length, siteid: SITE });
  const record = { ...fixture, createdbyid: ACTOR, lastupdatebyid: fixture.lastupdatebyid === null ? null : ACTOR };
  const t = await buildTestApp({
    seed: {
      program_binding: [programBindingRow(SITE)],
      record: [record],
      record_version: history.map((step, i) => versionRow({ ...record, state: step.state }, { action: step.action, version: i + 1 })),
    },
  });
  opened.push(t);
  t.db.clear();
  return { t, record };
}

/** POSTs `action` to `url` as a tenant-a user holding `role` and no other role, with an `edit` body for `edit`. */
async function send(t: TestApp, url: string, action: string, role: string): Promise<InjectResponse> {
  return t.app.inject({
    method: 'POST',
    url,
    headers: await headersFor({ roles: [role] }, { site: SITE, sub: ACTOR }),
    payload: action === 'edit' ? EDIT_BODY : {},
  });
}

/** Validates `res` against the operation `url` names in the finance contract and returns its parsed body. */
function contractBody(url: string, res: InjectResponse): Record<string, unknown> {
  return assertResponseMatchesOpenApi(OPENAPI, {
    method: 'POST',
    path: url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  }) as Record<string, unknown>;
}

/** The stored record `id`, state and version only. */
function stored(t: TestApp, id: string): Pick<FinanceRecordRow, 'state' | 'version'> | undefined {
  const row = t.db.rows('record').find((candidate) => candidate.record_id === id);
  return row === undefined ? undefined : { state: row.state, version: row.version };
}

describe('the committed transition table', () => {
  it('is the serialized expansion of the finance lifecycle, byte for byte', () => {
    expect(TABLE_TEXT).toBe(serializeTable(generateTable(financeLifecycle)));
  });

  it('holds 50 combinations, 8 of them legal', () => {
    expect(ROWS).toHaveLength(50);
    expect(ROWS.filter((row) => row.expectedStatus === 200)).toHaveLength(8);
  });

  it('covers every state, action and role combination exactly once', () => {
    const keys = ROWS.map((row) => JSON.stringify([row.from, row.action, row.role]));
    const expected = FINANCE_STATES.flatMap((from) =>
      FINANCE_ACTIONS.flatMap((action) => FINANCE_ROLES.map((role) => JSON.stringify([from, action, role]))),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toStrictEqual([...expected].sort());
  });

  it('agrees row for row with the fixture-oracle export', () => {
    expect(EXPORT.rows).toHaveLength(ROWS.length);
    ROWS.forEach((row, i) => {
      const exported = EXPORT.rows[i];
      const legal = row.expectedStatus === 200;
      expect({ index: i, ...exported }).toStrictEqual({
        index: i,
        from: row.from,
        action: row.action,
        role: row.role,
        outcome: OUTCOME_OF_STATUS[row.expectedStatus],
        status: legal ? '2xx' : String(row.expectedStatus),
        to: row.to,
        ...(row.newVersion ? { newVersion: true } : {}),
        ...(legal ? {} : { error: row.errorCode }),
      });
    });
  });
});

describe.each(FAMILIES)('the %s transition route', (family, url) => {
  it.each(ROWS)('answers $action from $from by $role with $expectedStatus', async (row) => {
    const { t, record } = await seeded(row.from as FinanceState);
    const target = url(record.record_id, row.action);

    const res = await send(t, target, row.action, row.role);

    expect(res.statusCode, res.body).toBe(row.expectedStatus);
    const body = contractBody(target, res);
    if (row.expectedStatus !== 200) {
      const spec = row.expectedStatus === 409 ? FIXTURE_ERROR_MAP.conflict : FIXTURE_ERROR_MAP.forbidden;
      expect(body.error).toStrictEqual({ code: spec.code, message: row.expectedStatus === 409 ? row.errorCode : spec.message });
      expect(body).not.toHaveProperty('data');
      expect(t.db.writes()).toStrictEqual([]);
      expect(stored(t, record.record_id)).toStrictEqual({ state: record.state, version: record.version });
      return;
    }

    const version = record.version + 1;
    if (family === 'fixture') expect(body.method).toBe(`finance.records.${row.action}`);
    expect(body.data).toMatchObject({ record_id: record.record_id, state: row.to, version });
    if (row.newVersion) expect(body.data).toMatchObject({ title: EDIT_BODY.title, amount: EDIT_BODY.amount, period: EDIT_BODY.period });
    expect(stored(t, record.record_id)).toStrictEqual({ state: row.to, version });

    const writes = t.db.writes();
    const data = writes.filter((write) => write.table !== CHANGELOG);
    const records = data.filter((write) => write.table === RECORD_TABLE);
    const versions = data.filter((write) => write.table === VERSION_TABLE);
    expect(records.map(({ op, row: written }) => ({ op, state: written.state, version: written.version }))).toStrictEqual([
      { op: 'update', state: row.to, version },
    ]);
    expect(versions.map(({ op, row: written }) => ({ op, record_id: written.record_id, version: written.version, action: written.action, state: written.state }))).toStrictEqual([
      { op: 'insert', record_id: record.record_id, version, action: row.action, state: row.to },
    ]);
    expect(versions[0]?.row).toMatchObject({ actor_user_id: ACTOR, created: TEST_CLOCK.now() });
    expect(records[0]?.row).toMatchObject({ lastupdatebyid: ACTOR, lastupdate: TEST_CLOCK.now() });
    const logged = writes
      .filter((write) => write.table === CHANGELOG)
      .map(({ row: entry }) => `${SCHEMA}.${String(entry.table)} ${String(entry.op)}`)
      .sort();
    expect(logged).toStrictEqual(data.map((write) => `${write.table} ${write.op}`).sort());
  });
});

describe('a terminal record', () => {
  it.each(financeLifecycle.terminal)('stays %s at its version under every action and role on both route families', async (state) => {
    const { t, record } = await seeded(state);
    for (const [family, url] of FAMILIES) {
      for (const action of FINANCE_ACTIONS) {
        for (const role of FINANCE_ROLES) {
          const res = await send(t, url(record.record_id, action), action, role);
          expect(res.statusCode, `${family} ${action} by ${role}: ${res.body}`).toBe(409);
        }
      }
    }
    expect(t.db.writes()).toStrictEqual([]);
    expect(stored(t, record.record_id)).toStrictEqual({ state, version: record.version });
  });
});
