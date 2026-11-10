// Expected-outcome transition table of @opt2/platform/state-machine: one row per (guard, state, action, role).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TransitionDefinition } from './definition.js';
import { evaluate, TRANSITION_ERROR_CODES, type TransitionDecision } from './runner.js';

/** Expected outcome of one (guard, state, action, role) combination. */
export interface TransitionTableRow {
  service: string;
  from: string;
  action: string;
  role: string;
  guard: string | null;
  expectedStatus: 200 | 403 | 409;
  to: string | null;
  newVersion: boolean;
  errorCode: string | null;
}

type RowOutcome = Pick<TransitionTableRow, 'expectedStatus' | 'to' | 'newVersion' | 'errorCode'>;

function outcomeOf(decision: TransitionDecision<string, string>): RowOutcome {
  switch (decision.outcome) {
    case 'ok':
      return { expectedStatus: 200, to: decision.to, newVersion: decision.newVersion, errorCode: null };
    case 'illegal':
      return { expectedStatus: 409, to: null, newVersion: false, errorCode: decision.error.code };
    case 'forbidden':
      return { expectedStatus: 403, to: null, newVersion: false, errorCode: TRANSITION_ERROR_CODES.forbidden };
  }
}

/**
 * 1. An active guard: 409 with the guard name as the code.
 * 2. A terminal state, or no row for (from, action): 409 `illegalTransition`.
 * 3. A matching row whose roles exclude the role: 403 `authorization`.
 * 4. Otherwise 200 with the new state; `same-new-version` keeps the state and sets `newVersion`.
 */
export function generateTable(def: TransitionDefinition<string, string, string, unknown>): TransitionTableRow[] {
  const guards: (string | null)[] = [null, ...(def.guards ?? []).map((guard) => guard.name)];
  const table: TransitionTableRow[] = [];
  for (const guard of guards) {
    for (const from of def.states) {
      for (const action of def.actions) {
        for (const role of def.roles) {
          const decision = evaluate(def, { state: from, action, roles: [role], activeGuard: guard });
          table.push({ service: def.service, from, action, role, guard, ...outcomeOf(decision) });
        }
      }
    }
  }
  return table;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareGuard(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return compareText(a, b);
}

/** Orders rows by service, guard (null first), from, action and role, by code unit. */
export function compareTableRows(a: TransitionTableRow, b: TransitionTableRow): number {
  return (
    compareText(a.service, b.service) ||
    compareGuard(a.guard, b.guard) ||
    compareText(a.from, b.from) ||
    compareText(a.action, b.action) ||
    compareText(a.role, b.role)
  );
}

/** Sorted, two-space-indented JSON of `rows` with a trailing newline; `rows` is not mutated. */
export function serializeTable(rows: readonly TransitionTableRow[]): string {
  return JSON.stringify([...rows].sort(compareTableRows), null, 2) + '\n';
}

/** Writes `serializeTable(rows)` to `path`, creating missing parent directories. */
export async function writeTableJson(rows: readonly TransitionTableRow[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeTable(rows), 'utf8');
}
