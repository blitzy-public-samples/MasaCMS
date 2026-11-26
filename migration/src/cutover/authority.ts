// Which units are `target`-authoritative under the gateway's active cut-over version.
import type { ResolvedPaths } from '../config.js';

import type { GatewayClient } from './gateway-client.js';
import { loadGroups, loadVersion, unitAuthority, type Authority, type GroupsFile } from './versions.js';

/** Write authority of every unit as of one read of the gateway's cut-over status. */
export interface CurrentAuthority {
  /** Active version; `null` before `v0001` is activated, when every unit is `legacy`. */
  tableVersion: string | null;
  epoch: number;
  /** Every unit of the groups file, in groups-file order. */
  units: Map<string, Authority>;
  /** The `target`-authoritative units, sorted. */
  targetUnits: Set<string>;
  /** False for a unit the groups file does not name. */
  isTargetAuthoritative(unit: string): boolean;
  anyTarget: boolean;
}

/** Inputs of {@link currentAuthority}: the gateway's status call, the absolute cut-over paths and an optional status-call bound. */
export interface CurrentAuthorityDeps {
  gateway: Pick<GatewayClient, 'status'>;
  config: Pick<ResolvedPaths, 'cutoverDir' | 'groupsFile'>;
  timeoutMs?: number;
}

function allLegacy(groups: GroupsFile): Map<string, Authority> {
  const units = new Map<string, Authority>();
  for (const group of groups.groups) for (const unit of group.units) units.set(unit, 'legacy');
  return units;
}

/** Authority of every unit under the version the gateway reports active; no active version means all `legacy`. */
export async function currentAuthority({ gateway, config, timeoutMs }: CurrentAuthorityDeps): Promise<CurrentAuthority> {
  // Only the version and epoch are taken from the status: authority comes from the committed version file and groups.json alone.
  const { tableVersion, epoch } = await gateway.status({ timeoutMs });
  const groups = loadGroups(config.groupsFile);
  const units = tableVersion === null ? allLegacy(groups) : unitAuthority(loadVersion(config.cutoverDir, tableVersion), groups);
  const targetUnits = new Set(
    [...units]
      .filter(([, authority]) => authority === 'target')
      .map(([unit]) => unit)
      .sort(),
  );
  return {
    tableVersion,
    epoch,
    units,
    targetUnits,
    isTargetAuthoritative: (unit) => targetUnits.has(unit),
    anyTarget: targetUnits.size > 0,
  };
}
