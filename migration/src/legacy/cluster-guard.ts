/** Start-up guard on cluster reload commands: without them, no legacy re-initialisation reaches the content units. */
import { readFile } from 'node:fs/promises';

import { z } from '@opt2/platform/service-kit';

import { stateDirPath } from '../paths.js';
import type { LegacyDb } from './legacy-db.js';

/** Counts the cluster commands Masa queued for its peers [core/mura/cluster/clusterManager.cfc:203-211]. */
export const CLUSTER_COMMANDS_COUNT_SQL = 'select count(*) as n from tclustercommands';

const RECORD_COMMAND = 'harness/src/baseline/environment.ts --phase services';

/** The cluster settings `environment.ts --phase services` records; other fields of the record are ignored. */
const environmentRecordSchema = z.object({
  settings: z.object({
    cluster: z.object({
      broadcastClusterCommands: z.boolean().nullable().optional(),
      peerCount: z.number().nullable().optional(),
      tclustercommandsCount: z.number().nullable().optional(),
      clusterSafe: z.boolean(),
    }),
  }),
});

/** Whether cluster reload commands cannot reach legacy; `reason` names the failing condition. */
export type ClusterGuardVerdict = { safe: true } | { safe: false; reason: string };

/** `<stateDir>/baseline/environment.json`, the record `environment.ts` writes. */
export function environmentRecordPath(stateDir: string): string {
  return stateDirPath(stateDir, 'baseline', 'environment.json');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Counts `tclustercommands` rows on the live legacy database. */
async function countClusterCommands(legacy: Pick<LegacyDb, 'live'>): Promise<number> {
  const pool = await legacy.live();
  const result = await pool.request().query<{ n: number }>(CLUSTER_COMMANDS_COUNT_SQL);
  const row = result.recordset[0];
  if (row === undefined) throw new Error('Cluster command count returned no row');
  return row.n;
}

/**
 * Safe only when the environment record's `settings.cluster.clusterSafe` is true and the live `tclustercommands` is
 * empty, since rows can be queued after the record was taken; a missing or unreadable record is unsafe.
 */
export async function checkClusterGuard(deps: { legacy: Pick<LegacyDb, 'live'>; stateDir: string }): Promise<ClusterGuardVerdict> {
  const file = environmentRecordPath(deps.stateDir);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    const problem = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'does not exist' : `cannot be read (${messageOf(error)})`;
    return { safe: false, reason: `the environment record ${file} ${problem}; run ${RECORD_COMMAND}` };
  }
  const parsed = environmentRecordSchema.safeParse(json);
  if (!parsed.success) {
    return { safe: false, reason: `the environment record ${file} holds no settings.cluster.clusterSafe verdict; run ${RECORD_COMMAND}` };
  }
  const cluster = parsed.data.settings.cluster;
  if (!cluster.clusterSafe) {
    const seen = `broadcastClusterCommands=${String(cluster.broadcastClusterCommands ?? null)}, peerCount=${String(cluster.peerCount ?? null)}, tclustercommands=${String(cluster.tclustercommandsCount ?? null)}`;
    return { safe: false, reason: `the environment record ${file} has clusterSafe=false (${seen})` };
  }
  const queued = await countClusterCommands(deps.legacy);
  if (queued > 0) return { safe: false, reason: `the legacy database holds ${String(queued)} tclustercommands rows` };
  return { safe: true };
}
