// Event seam through the gateway: a stub note created in the umbrella user pool -> projection in each registry-derived
// destination tenant through an interrupted first delivery, and a redelivered fan-out; every outcome is recorded for
// opt2/reports/events.json.
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
  DEFAULT_REDELIVERY_POLL,
  NOTE_PROJECTION_UNIT,
  readNoteProjections,
  runNoteSeam,
  type FanoutInterruption,
  type NoteProjection,
  type NoteSeamEvidence,
  type NoteSeamOptions,
  type SeamDeps,
  type SeamReason,
  type SeamResult,
} from '../../src/events/seams.js';
import { migrationInvoker, requireTableVersion } from '../helpers/stack.js';

const SOURCE = 'harness/e2e/events/seams.e2e.test.ts';
const TABLE_VERSION = 'v0002';
/** A tenant-a system user's note in tenant-a's public user pool, umbrella, which fans out to tenant-a; its first delivery is interrupted. */
const POOLED_INTERRUPTED: Pick<NoteSeamOptions, 'pool' | 'interrupt'> = { pool: 'public', interrupt: true };
/** The interrupted seam's three bounded waits plus the owner exports and gate calls around them. */
const SEAM_TIMEOUT_MS = 3 * DEFAULT_REDELIVERY_POLL.timeoutMs + 120_000;
/** Its own note seam, two quiescence waits at their bound, plus the replay and the export reads around it. */
const FANOUT_TIMEOUT_MS = SEAM_TIMEOUT_MS + 2 * DEFAULT_DRAIN.timeoutMs + 60_000;
const REPLAY_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Result keys this suite records. */
type SeamsKey = `seams.${SeamId}` | 'fanoutRedelivery';

/** Why a tenant is read in the redelivery check: a seam destination, or a registered tenant outside the fan-out. */
type FanoutReason = SeamReason | 'outside-fanout';

/** The note's projection rows in one tenant: how many are expected, and those read before and after the replay. */
interface TenantProjections {
  siteId: string;
  tenantId: string;
  reason: FanoutReason;
  expectedRows: number;
  before: NoteProjection[];
  after: NoteProjection[];
}

/** Evidence of the redelivery check: the interrupted first delivery, projection rows per tenant and the replay run. */
interface FanoutEvidence {
  noteId: string;
  noteTenantId: string;
  since: string;
  interruption: FanoutInterruption | null;
  tenants: {
    siteId: string;
    tenantId: string;
    reason: FanoutReason;
    expectedRows: number;
    beforeRows: number;
    afterRows: number;
    afterApplyCounts: number[];
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

/** Why the redelivery changed state or did not run cleanly; empty when every tenant kept exactly its expected projection. */
function fanoutProblems(tenants: readonly TenantProjections[], replay: OutboxReplayResult): string[] {
  const problems: string[] = [];
  if (!tenants.some((tenant) => tenant.reason === 'userPool')) problems.push('the note has no user-pool fan-out destination');
  const run = replay.replays.find((entry) => entry.service === 'stub');
  if (run?.exitCode !== 0) problems.push(`stub outbox replay exited ${run?.exitCode ?? 'without running'}`);
  const replayed = replayedRows(run?.summary);
  if (replayed === null || replayed < 1) {
    problems.push(`stub outbox replay republished ${replayed ?? 'no counted'} rows, expected at least 1`);
  }
  for (const { key, before, after } of replay.differences) {
    problems.push(`${key} changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  for (const tenant of tenants) {
    const label = `${tenant.siteId} (${tenant.reason})`;
    if (JSON.stringify(tenant.after) !== JSON.stringify(tenant.before)) {
      problems.push(`${label}: the note's projection went from ${JSON.stringify(tenant.before)} to ${JSON.stringify(tenant.after)}`);
    }
    if (tenant.after.length !== tenant.expectedRows || tenant.after.some((row) => row.applyCount !== 1)) {
      problems.push(`${label}: ${JSON.stringify(tenant.after)}, expected ${tenant.expectedRows} projection applied once`);
    }
  }
  return problems;
}

/** One clause per destination, per other tenant holding the note's projection and per interruption problem. */
function seamDetail(evidence: NoteSeamEvidence): string {
  const clauses = [`create of note ${evidence.noteId ?? '(none)'} in ${evidence.noteSiteId} answered ${evidence.create.status}`];
  for (const { siteId, reason, projections } of evidence.destinations) {
    clauses.push(`${siteId} (${reason}): expected 1 projection applied once, found ${JSON.stringify(projections)}`);
  }
  for (const { siteId, projectionRows } of evidence.otherTenants.filter((tenant) => tenant.projectionRows > 0)) {
    clauses.push(`${siteId} (outside the fan-out): ${projectionRows} projections`);
  }
  if (evidence.timedOut) clauses.push(`timed out after ${evidence.elapsedMs} ms`);
  clauses.push(...(evidence.interruption?.problems ?? []));
  return clauses.join('; ');
}

describe('event seams', () => {
  beforeAll(async () => {
    await requireTableVersion(TABLE_VERSION);
    deps = { invoker: await migrationInvoker() };
  });

  afterAll(async () => {
    try {
      await writeEventsReport([]);
    } catch (err) {
      throw new Error(`events report was not regenerated: ${messageOf(err)}`, { cause: err });
    }
  });

  it(
    `note create projects the note once in its tenant and every user-pool fan-out tenant, and nowhere else ${seamTag('noteToProjection')}`,
    async () => {
      const seam = await recordSeam('noteToProjection', () => runNoteSeam({ ...deps, ...POOLED_INTERRUPTED }));
      expect(seam.passed, seamDetail(seam.evidence)).toBe(true);
      expect(seam.evidence.destinations.map(({ reason }) => reason)).toContain('userPool');
    },
    SEAM_TIMEOUT_MS,
  );

  it(
    `a redelivered note fan-out leaves each authorised tenant exactly one projection ${CHECK_TAG('fanoutRedelivery')}`,
    async () => {
      // Taken before the note create, so the replay window holds its outbox row.
      const since = new Date().toISOString();
      const seam = await failOnThrow('fanoutRedelivery', () => runNoteSeam({ ...deps, ...POOLED_INTERRUPTED }));
      const evidence = await failOnThrow('fanoutRedelivery', async (): Promise<FanoutEvidence> => {
        if (!seam.passed) throw new Error(`the interrupted note seam did not pass, so its note cannot be redelivered: ${seamDetail(seam.evidence)}`);
        const { noteId, destinations, otherTenants } = seam.evidence;
        const noteTenant = destinations.find((destination) => destination.reason === 'origin-tenant');
        if (noteId === null || noteTenant === undefined) throw new Error('the note seam evidence names no note in its own tenant');

        const subjects: Omit<TenantProjections, 'before' | 'after'>[] = [
          ...destinations.map(({ siteId, tenantId, reason }) => ({ siteId, tenantId, reason, expectedRows: 1 })),
          ...otherTenants.map(({ siteId, tenantId }) => ({ siteId, tenantId, reason: 'outside-fanout' as const, expectedRows: 0 })),
        ];
        const tenants: TenantProjections[] = [];
        for (const subject of subjects) {
          tenants.push({ ...subject, before: await readNoteProjections(subject.tenantId, noteId, deps), after: [] });
        }

        // Waits for quiescence before and after the replay; its snapshots cover every registered tenant's projections.
        const replay = await runOutboxReplay({
          ...deps,
          since,
          producers: ['stub'],
          consumers: ['stub'],
          units: { stub: [NOTE_PROJECTION_UNIT] },
          exec: tenantReplay(noteTenant.tenantId),
        });
        for (const tenant of tenants) tenant.after = await readNoteProjections(tenant.tenantId, noteId, deps);

        const problems = fanoutProblems(tenants, replay);
        return {
          noteId,
          noteTenantId: noteTenant.tenantId,
          since,
          interruption: seam.evidence.interruption ?? null,
          tenants: tenants.map(({ siteId, tenantId, reason, expectedRows, before, after }) => ({
            siteId,
            tenantId,
            reason,
            expectedRows,
            beforeRows: before.length,
            afterRows: after.length,
            afterApplyCounts: after.map((row) => row.applyCount),
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
      expect(evidence.problems, `redelivery of note ${evidence.noteId} since ${evidence.since}`).toEqual([]);
    },
    FANOUT_TIMEOUT_MS,
  );
});
