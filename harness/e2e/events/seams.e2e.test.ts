// Event seams through the gateway: person archive -> blackout fan-out (seam 1), survey schedule -> scheduled tasks
// (seam 2) and a redelivered archive fan-out; every outcome is recorded for opt2/reports/events.json.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_DRAIN,
  REPLAY_BIN_TIMEOUT_MS,
  runOutboxReplay,
  type ExecFn,
  type OutboxReplayResult,
} from '../../src/events/outbox-replay.js';
import {
  CHECK_TAG,
  main as writeEventsReport,
  recordEventResult,
  seamRecordResult,
  type SeamId,
} from '../../src/events/report.js';
import {
  readOwnerExport,
  runSeam1,
  runSeam2,
  unitFor,
  type Seam1Evidence,
  type Seam1Reason,
  type Seam2Evidence,
  type SeamDeps,
  type SeamResult,
} from '../../src/events/seams.js';
import { fixtureStatus, migrationInvoker, requireTableVersion } from '../helpers/stack.js';

const SOURCE = 'harness/e2e/events/seams.e2e.test.ts';
const TABLE_VERSION = 'v0002';
/** Owner exports plus the seam's own push-delivery poll. */
const SEAM_TIMEOUT_MS = 180_000;
/** Its own seam 1 archive, two quiescence waits at their bound, plus the replay and the export reads around it. */
const FANOUT_TIMEOUT_MS = SEAM_TIMEOUT_MS + 2 * DEFAULT_DRAIN.timeoutMs + 60_000;
const REPLAY_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Result keys this suite records. */
type SeamsKey = `seams.${SeamId}` | 'fanoutRedelivery';

/** Why a tenant is read in the redelivery check: a seam 1 destination, or a registered tenant outside the fan-out. */
type FanoutReason = Seam1Reason | 'outside-fanout';

/** The person's blackout day ids in one tenant: expected, and read before and after the replay. */
interface TenantBlackouts {
  siteId: string;
  tenantId: string;
  reason: FanoutReason;
  expected: string[];
  before: string[];
  after: string[];
}

/** Evidence of the redelivery check: row counts per tenant and the replay run. */
interface FanoutEvidence {
  personId: string;
  personTenantId: string;
  since: string;
  tenants: {
    siteId: string;
    tenantId: string;
    reason: FanoutReason;
    expectedRows: number;
    beforeRows: number;
    afterRows: number;
  }[];
  replay: Pick<OutboxReplayResult, 'since' | 'replays' | 'unchanged' | 'differences'>;
  problems: string[];
}

const execFileAsync = promisify(execFile);

let deps: SeamDeps = {};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `[events:<id>]` tag of a seam, in CHECK_TAG's form; CHECK_TAG itself takes delivery-check ids only. */
function seamTag(id: SeamId): string {
  return `[events:${id}]`;
}

/** Runs `check`; a throw is recorded under `key` as `fail` with its message, then rethrown. */
async function failOnThrow<T>(key: SeamsKey, check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    await recordEventResult(key, { result: 'fail', evidence: { error: messageOf(err) }, source: SOURCE });
    throw err;
  }
}

/** Runs one seam and records its outcome under `seams.<id>`. */
async function recordSeam<E>(id: SeamId, run: () => Promise<SeamResult<E>>): Promise<SeamResult<E>> {
  const key = `seams.${id}` as const;
  const seam = await failOnThrow(key, run);
  await recordEventResult(key, { result: seamRecordResult(seam), evidence: seam.evidence, source: SOURCE });
  return seam;
}

/** Comparison form of a CF UUID column, as seams.ts compares ids. */
function idKey(value: unknown): string {
  return typeof value === 'string' ? value.trimEnd().toUpperCase() : '';
}

/** Day ids of `personId`'s `timesheets.blackout` rows in the tenant, sorted, one entry per row. */
async function personBlackouts(tenantId: string, personId: string): Promise<string[]> {
  const { rows } = await readOwnerExport({ service: 'timesheets', unit: unitFor('timesheets', 'blackout'), tenantId }, deps);
  const person = idKey(personId);
  return rows
    .filter((row) => idKey(row.person_id) === person)
    .map((row) => idKey(row.day_id))
    .sort();
}

/** runOutboxReplay's bin run with `--tenant` appended; an exit status resolves, a spawn failure, signal or timeout rejects. */
function tenantReplay(tenantId: string): ExecFn {
  return async (file, args, { cwd, env }) => {
    try {
      const { stdout, stderr } = await execFileAsync(file, [...args, '--tenant', tenantId], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: REPLAY_BIN_TIMEOUT_MS,
        maxBuffer: REPLAY_MAX_OUTPUT_BYTES,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const { code, stdout, stderr } = err as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof code === 'number') return { code, stdout: stdout ?? '', stderr: stderr ?? '' };
      throw err;
    }
  };
}

/** `replayed` count of an `opt2-outbox replay` summary line, or null when the line carries none. */
function replayedRows(summary: unknown): number | null {
  const replayed = typeof summary === 'object' && summary !== null ? (summary as { replayed?: unknown }).replayed : undefined;
  return typeof replayed === 'number' ? replayed : null;
}

/** Why the redelivery changed state or did not run cleanly; empty when every tenant kept exactly its expected rows. */
function fanoutProblems(tenants: readonly TenantBlackouts[], replay: OutboxReplayResult): string[] {
  const problems: string[] = [];
  const run = replay.replays.find((entry) => entry.service === 'people');
  if (run?.exitCode !== 0) problems.push(`people outbox replay exited ${run?.exitCode ?? 'without running'}`);
  const replayed = replayedRows(run?.summary);
  if (replayed === null || replayed < 1) {
    problems.push(`people outbox replay republished ${replayed ?? 'no counted'} rows, expected at least 1`);
  }
  for (const { key, before, after } of replay.differences) {
    problems.push(`${key} changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  for (const tenant of tenants) {
    const label = `${tenant.siteId} (${tenant.reason})`;
    if (tenant.after.join() !== tenant.before.join()) {
      problems.push(`${label}: the person's blackout rows went from ${tenant.before.length} to ${tenant.after.length}`);
    }
    if (tenant.after.join() !== tenant.expected.join()) {
      problems.push(`${label}: ${tenant.after.length} blackout rows, expected one per open day (${tenant.expected.length})`);
    }
  }
  return problems;
}

/** One clause per destination and per other tenant holding the person's blackouts. */
function seam1Detail(evidence: Seam1Evidence): string {
  const clauses = [`archive of ${evidence.personId} answered ${evidence.archive.status}`];
  for (const { siteId, reason, expectedDayIds, blackoutDayIds } of evidence.destinations) {
    clauses.push(`${siteId} (${reason}): expected ${expectedDayIds.length} blackouts, found ${blackoutDayIds.length}`);
  }
  for (const { siteId, blackoutRows } of evidence.otherTenants.filter((tenant) => tenant.blackoutRows > 0)) {
    clauses.push(`${siteId} (outside the fan-out): ${blackoutRows} blackouts`);
  }
  if (evidence.timedOut) clauses.push(`timed out after ${evidence.elapsedMs} ms`);
  return clauses.join('; ');
}

/** The schedule's status and every task mismatch, for a failed seam 2. */
function seam2Detail(evidence: Seam2Evidence): string {
  const clauses = [`schedule of survey ${evidence.surveyId} answered ${evidence.schedule.status}`, ...evidence.mismatches];
  if (evidence.timedOut) clauses.push(`timed out after ${evidence.elapsedMs} ms`);
  return clauses.join('; ');
}

describe('event seams', () => {
  beforeAll(async () => {
    await requireTableVersion(TABLE_VERSION);
    deps = { fixtures: fixtureStatus(), invoker: await migrationInvoker() };
  });

  afterAll(async () => {
    try {
      await writeEventsReport([]);
    } catch (err) {
      throw new Error(`events report was not regenerated: ${messageOf(err)}`, { cause: err });
    }
  });

  it(
    `archive creates one blackout per open day in the person's tenant and every user-pool fan-out tenant ${seamTag('archiveToBlackout')}`,
    async ({ skip }) => {
      const seam = await recordSeam('archiveToBlackout', () => runSeam1(deps));
      if (seam.skipped !== undefined) return skip(`${seam.skipped}: ${seam.evidence.reason ?? 'no reason recorded'}`);
      expect(seam.passed, seam1Detail(seam.evidence)).toBe(true);
    },
    SEAM_TIMEOUT_MS,
  );

  it(
    `survey schedule creates one launch task on surveys-launch and one task per reminder on communications-reminders ${seamTag('surveyToCloudTasks')}`,
    async ({ skip }) => {
      const seam = await recordSeam('surveyToCloudTasks', () => runSeam2(deps));
      if (seam.skipped !== undefined) return skip(`${seam.skipped}: ${seam.evidence.reason ?? 'no reason recorded'}`);
      expect(seam.passed, seam2Detail(seam.evidence)).toBe(true);
    },
    SEAM_TIMEOUT_MS,
  );

  it(
    `a redelivered archive fan-out leaves each authorised tenant exactly one blackout per open day ${CHECK_TAG('fanoutRedelivery')}`,
    async ({ skip }) => {
      // Taken before the archive, so the replay window holds its outbox row.
      const since = new Date().toISOString();
      const seam1 = await failOnThrow('fanoutRedelivery', () => runSeam1(deps));
      if (seam1.skipped !== undefined) {
        await recordEventResult('fanoutRedelivery', { result: seam1.skipped, evidence: seam1.evidence, source: SOURCE });
        return skip(`${seam1.skipped}: ${seam1.evidence.reason ?? 'no reason recorded'}`);
      }
      const evidence = await failOnThrow('fanoutRedelivery', async (): Promise<FanoutEvidence> => {
        if (!seam1.passed) throw new Error(`seam 1 did not pass, so its archive cannot be redelivered: ${seam1Detail(seam1.evidence)}`);
        const { personId, destinations, otherTenants } = seam1.evidence;
        const personTenant = destinations.find((destination) => destination.reason === 'person-tenant');
        if (personTenant === undefined) throw new Error(`seam 1 evidence names no person-tenant destination for ${personId}`);

        const subjects: Omit<TenantBlackouts, 'before' | 'after'>[] = [
          ...destinations.map(({ siteId, tenantId, reason, expectedDayIds }) => ({ siteId, tenantId, reason, expected: expectedDayIds })),
          ...otherTenants.map(({ siteId, tenantId }) => ({ siteId, tenantId, reason: 'outside-fanout' as const, expected: [] })),
        ];
        const tenants: TenantBlackouts[] = [];
        for (const subject of subjects) {
          tenants.push({ ...subject, before: await personBlackouts(subject.tenantId, personId), after: [] });
        }

        // Waits for quiescence before and after the replay; its snapshots cover every registered tenant's blackouts.
        const replay = await runOutboxReplay({
          ...deps,
          since,
          producers: ['people'],
          consumers: ['timesheets'],
          units: { timesheets: [unitFor('timesheets', 'blackout')] },
          exec: tenantReplay(personTenant.tenantId),
        });
        for (const tenant of tenants) tenant.after = await personBlackouts(tenant.tenantId, personId);

        const problems = fanoutProblems(tenants, replay);
        return {
          personId,
          personTenantId: personTenant.tenantId,
          since,
          tenants: tenants.map(({ siteId, tenantId, reason, expected, before, after }) => ({
            siteId,
            tenantId,
            reason,
            expectedRows: expected.length,
            beforeRows: before.length,
            afterRows: after.length,
          })),
          replay: { since: replay.since, replays: replay.replays, unchanged: replay.unchanged, differences: replay.differences },
          problems,
        };
      });
      await recordEventResult('fanoutRedelivery', {
        result: evidence.problems.length === 0 ? 'pass' : 'fail',
        evidence,
        source: SOURCE,
      });
      expect(evidence.problems, `redelivery of ${evidence.personId}'s archive since ${evidence.since}`).toEqual([]);
    },
    FANOUT_TIMEOUT_MS,
  );
});
