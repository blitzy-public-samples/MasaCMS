// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance lifecycle over generated action sequences: the runner and the record domain agree with the generated transition table. */
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TransitionRejectedError, decide, type TransitionTableRow } from '@opt2/platform/state-machine';
import {
  FINANCE_ACTIONS,
  FINANCE_ROLES,
  FINANCE_STATES,
  financeLifecycle,
  type FinanceAction,
  type FinanceRole,
  type FinanceState,
} from '../../src/domain/lifecycle.transitions.js';
import { transitionRecord, type FinanceActor, type FinanceDomainDeps, type RecordEdit, type RecordWrite } from '../../src/domain/records.js';
// The domain deps need a FinanceRepository, which only the service's own factory builds; the record domain suites build it the same way.
import { createFinanceRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, createRecordingDb, type RecordingDb } from '../helpers/app.js';
import { programBindingRow, recordRow, versionRow } from '../helpers/records.js';

const SEED = 20260601;
const PURE_RUNS = { seed: SEED, numRuns: 200 } as const;
const DOMAIN_RUNS = { seed: SEED, numRuns: 50 } as const;
const SITE = 'tenant-a';
const ACTOR: FinanceActor = { userId: '11111111-2222-3333-4444555566667777', siteId: SITE };
const EDIT: RecordEdit = { title: 'Revised travel claim', amount: 2_500_000n };
const STATUS_OF = { ok: 200, illegal: 409, forbidden: 403 } as const;

type Step = readonly [action: FinanceAction, role: FinanceRole];
type Folded = { state: FinanceState; version: number };

/** One step of the model: state and version before and after it, its generated status, and whether the runner allowed it. */
interface ModelStep {
  action: FinanceAction;
  role: FinanceRole;
  before: Folded;
  after: Folded;
  status: TransitionTableRow['expectedStatus'];
  legal: boolean;
}

const INITIAL: Folded = { state: 'IN-PROGRESS', version: 1 };
const TO_APPROVED: readonly Step[] = [
  ['submit', 'finance.preparer'],
  ['approve', 'finance.approver'],
];

const STEPS = fc.array(fc.tuple(fc.constantFrom(...FINANCE_ACTIONS), fc.constantFrom(...FINANCE_ROLES)), { minLength: 1, maxLength: 20 });
// Random sequences seldom approve, so half the runs start with the submit-then-approve prefix.
const SEQUENCES = fc.oneof(
  STEPS,
  STEPS.map((steps): Step[] => [...TO_APPROVED, ...steps]),
);

/** Table key of one (state, action, role) combination. */
function key(state: string, action: string, role: string): string {
  return `${state}|${action}|${role}`;
}

const TABLE: ReadonlyMap<string, TransitionTableRow> = new Map(
  (JSON.parse(readFileSync(new URL('../generated/transition-table.json', import.meta.url), 'utf8')) as TransitionTableRow[]).map((row) => [
    key(row.from, row.action, row.role),
    row,
  ]),
);

/** The generated row of `(state, action, role)`. */
function expectedRow(state: string, action: string, role: string): TransitionTableRow {
  const row = TABLE.get(key(state, action, role));
  if (row === undefined) throw new Error(`transition-table.json has no row ${key(state, action, role)}`);
  return row;
}

/** Folds `steps` from IN-PROGRESS v1 through `decide`, asserting each decision against its generated row. */
function fold(steps: readonly Step[]): ModelStep[] {
  let current = INITIAL;
  return steps.map(([action, role]) => {
    const before = current;
    const decision = decide(financeLifecycle, { state: before.state, action, roles: [role] });
    const row = expectedRow(before.state, action, role);
    const at = key(before.state, action, role);
    expect(STATUS_OF[decision.outcome], at).toBe(row.expectedStatus);
    if (decision.outcome === 'ok') {
      expect({ to: decision.to, newVersion: decision.newVersion, actingRole: decision.actingRole }, at).toEqual({
        to: row.to,
        newVersion: row.newVersion,
        actingRole: role,
      });
      current = { state: decision.to, version: before.version + 1 };
    } else {
      expect({ status: decision.status, code: decision.error.code }, at).toEqual({ status: row.expectedStatus, code: row.errorCode });
    }
    return { action, role, before, after: current, status: row.expectedStatus, legal: decision.outcome === 'ok' };
  });
}

/** Asserts that every step after the first one reaching APPROVED is rejected and leaves the state APPROVED. */
function expectApprovedAbsorbing(trace: readonly { state: FinanceState; legal: boolean }[]): void {
  const approvedAt = trace.findIndex((entry) => entry.state === 'APPROVED');
  if (approvedAt === -1) return;
  for (const entry of trace.slice(approvedAt + 1)) expect(entry).toEqual({ state: 'APPROVED', legal: false });
}

describe('finance lifecycle runner over action sequences', () => {
  it('holds one generated row per state, action and role', () => {
    expect(TABLE.size).toBe(FINANCE_STATES.length * FINANCE_ACTIONS.length * FINANCE_ROLES.length);
  });

  it('agrees with the generated table at every step of any action sequence', () => {
    fc.assert(
      fc.property(SEQUENCES, (steps) => {
        expect(fold(steps)).toHaveLength(steps.length);
      }),
      PURE_RUNS,
    );
  });

  it('raises the version by one on each legal step and keeps it on each rejected one', () => {
    fc.assert(
      fc.property(SEQUENCES, (steps) => {
        const model = fold(steps);
        for (const step of model) expect(step.after.version).toBe(step.before.version + (step.legal ? 1 : 0));
        expect(model.at(-1)?.after.version).toBe(INITIAL.version + model.filter((step) => step.legal).length);
      }),
      PURE_RUNS,
    );
  });

  it('keeps APPROVED terminal for every later action and role', () => {
    fc.assert(
      fc.property(SEQUENCES, (steps) => {
        expectApprovedAbsorbing(fold(steps).map((step) => ({ state: step.after.state, legal: step.legal })));
      }),
      PURE_RUNS,
    );
  });
});

/** Storage port the record lifecycle never reaches. */
function unreachableStorage(): FinanceDomainDeps['storage'] {
  const unreachable = (): never => {
    throw new Error('the record lifecycle does not use storage');
  };
  return { kind: 'local', put: unreachable, get: unreachable, stream: unreachable, open: unreachable, delete: unreachable, head: unreachable, signedUrl: unreachable };
}

/** A recording db holding tenant-a's program binding and one IN-PROGRESS v1 record with its create version row, and domain deps over it. */
function seededDomain(): { db: RecordingDb; deps: FinanceDomainDeps; record: ReturnType<typeof recordRow> } {
  const record = recordRow({ siteid: SITE });
  const db = createRecordingDb(
    {
      program_binding: [programBindingRow(SITE)],
      record: [record],
      record_version: [versionRow(record, { action: 'create', version: INITIAL.version })],
    },
    { clock: TEST_CLOCK },
  );
  const storage = unreachableStorage();
  const repository = createFinanceRepository({ db, stagingDb: db.handle(), storage, clock: TEST_CLOCK });
  return { db, deps: { repository, storage, clock: TEST_CLOCK }, record };
}

describe('finance record domain over action sequences', () => {
  it('stores the state and version the runner decides, with one version row per legal step and none per rejected one', async () => {
    await fc.assert(
      fc.asyncProperty(SEQUENCES, async (steps) => {
        const { db, deps, record } = seededDomain();
        const versionTable = `${db.schema}.record_version`;
        const stored: { state: FinanceState; legal: boolean }[] = [];
        for (const step of fold(steps)) {
          db.clear();
          const command = { id: record.record_id, action: step.action, roles: [step.role], ...(step.action === 'edit' ? { input: EDIT } : {}) };
          const outcome = await db
            .withTenant(record.tenant_id, (tx) => transitionRecord(tx, deps, command, ACTOR))
            .catch((err: unknown): TransitionRejectedError => {
              if (err instanceof TransitionRejectedError) return err;
              throw err;
            });
          const writes = db.writes();
          if (step.legal) {
            const { record: written, version } = outcome as RecordWrite;
            expect({ state: written.state, version: written.version }).toEqual(step.after);
            expect({ state: version.state, version: version.version, action: version.action }).toEqual({ ...step.after, action: step.action });
            expect(writes.filter((write) => write.table === versionTable && write.op === 'insert')).toHaveLength(1);
          } else {
            expect(outcome).toBeInstanceOf(TransitionRejectedError);
            expect((outcome as TransitionRejectedError).statusCode).toBe(step.status);
            expect(writes).toEqual([]);
          }
          const [current, ...others] = db.rows('record', record.tenant_id);
          expect(others).toEqual([]);
          expect({ state: current?.state, version: current?.version }).toEqual(step.after);
          expect(db.rows('record_version', record.tenant_id).map((row) => row.version).sort((a, b) => a - b)).toEqual(
            Array.from({ length: step.after.version }, (_, index) => index + 1),
          );
          stored.push({ state: current?.state as FinanceState, legal: step.legal });
        }
        expectApprovedAbsorbing(stored);
        expect(db.rows('record', record.tenant_id)[0]?.version).toBe(INITIAL.version + stored.filter((entry) => entry.legal).length);
      }),
      DOMAIN_RUNS,
    );
  });
});
