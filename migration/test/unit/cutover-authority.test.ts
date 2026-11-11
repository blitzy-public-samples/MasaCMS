// Unit tests for the current-authority answer over the committed groups and versions, with a fake gateway status.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { currentAuthority, type CurrentAuthorityDeps } from '../../src/cutover/authority.js';
import type { CutoverStatus } from '../../src/cutover/gateway-client.js';
import { CutoverDataError, loadGroups, loadVersion } from '../../src/cutover/versions.js';
import { repoPath } from '../../src/paths.js';

const CUTOVER_DIR = repoPath('gateway/cutover');
const GROUPS_FILE = path.join(CUTOVER_DIR, 'groups.json');
const groups = loadGroups(GROUPS_FILE);
const allUnits = groups.groups.flatMap((group) => group.units);

function statusBody(overrides: Partial<CutoverStatus> = {}): CutoverStatus {
  return {
    tableVersion: null,
    previous: null,
    epoch: 0,
    groupAuthority: {},
    frozen: [],
    instances: [],
    acknowledgedEpoch: null,
    inflight: [],
    sessionMode: 'legacy-primary',
    ...overrides,
  };
}

function deps(status: CutoverStatus, cutoverDir = CUTOVER_DIR): CurrentAuthorityDeps & { calls: () => number } {
  let calls = 0;
  return {
    gateway: {
      status: () => {
        calls += 1;
        return Promise.resolve(status);
      },
    },
    config: { cutoverDir, groupsFile: GROUPS_FILE },
    calls: () => calls,
  };
}

function targetUnitsOf(tableVersion: string): string[] {
  const version = loadVersion(CUTOVER_DIR, tableVersion);
  return groups.groups
    .filter((group) => version.groupAuthority[group.id] === 'target')
    .flatMap((group) => group.units)
    .sort();
}

describe('currentAuthority', () => {
  it.each([
    ['no active version', null],
    ['v0001', 'v0001'],
  ])('makes every unit legacy under %s', async (_label, tableVersion) => {
    const authority = await currentAuthority(deps(statusBody({ tableVersion })));

    expect(authority.tableVersion).toBe(tableVersion);
    expect([...authority.units.keys()]).toEqual(allUnits);
    expect([...authority.units.values()].every((value) => value === 'legacy')).toBe(true);
    expect(authority.targetUnits.size).toBe(0);
    expect(authority.anyTarget).toBe(false);
    expect(allUnits.some((unit) => authority.isTargetAuthoritative(unit))).toBe(false);
  });

  it.each(['v0002', 'v0003'])('makes exactly the units of the target groups of %s target', async (tableVersion) => {
    const expected = targetUnitsOf(tableVersion);
    const authority = await currentAuthority(deps(statusBody({ tableVersion, previous: 'v0001', epoch: 7 })));

    expect(expected.length).toBeGreaterThan(0);
    expect([...authority.targetUnits]).toEqual(expected);
    expect(authority.anyTarget).toBe(true);
    expect([...authority.units.keys()]).toEqual(allUnits);
    for (const unit of allUnits) {
      const isTarget = expected.includes(unit);
      expect(authority.isTargetAuthoritative(unit)).toBe(isTarget);
      expect(authority.units.get(unit)).toBe(isTarget ? 'target' : 'legacy');
    }
  });

  it('treats a unit the groups file does not name as not target', async () => {
    const authority = await currentAuthority(deps(statusBody({ tableVersion: 'v0002' })));

    expect(authority.isTargetAuthoritative('people.no_such_table')).toBe(false);
    expect(authority.units.has('people.no_such_table')).toBe(false);
  });

  it('takes authority from the version file, not from the status groupAuthority', async () => {
    const forged = Object.fromEntries(groups.groups.map((group) => [group.id, 'target' as const]));
    const authority = await currentAuthority(deps(statusBody({ tableVersion: 'v0001', groupAuthority: forged })));

    expect(authority.anyTarget).toBe(false);
  });

  it.each([0, 1, 42])('passes epoch %i through from the status', async (epoch) => {
    const authority = await currentAuthority(deps(statusBody({ tableVersion: 'v0002', epoch })));

    expect(authority.epoch).toBe(epoch);
  });

  it('reads the gateway status on every call', async () => {
    const fake = deps(statusBody({ tableVersion: 'v0001' }));
    await currentAuthority(fake);
    await currentAuthority(fake);

    expect(fake.calls()).toBe(2);
  });

  it('rejects when the active version file is absent', async () => {
    await expect(currentAuthority(deps(statusBody({ tableVersion: 'v9999' })))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a version file that contradicts its name', async () => {
    const cutoverDir = mkdtempSync(path.join(os.tmpdir(), 'opt2-cutover-authority-'));
    try {
      mkdirSync(path.join(cutoverDir, 'versions'));
      writeFileSync(path.join(cutoverDir, 'versions', 'v0004.json'), JSON.stringify(loadVersion(CUTOVER_DIR, 'v0002')));

      await expect(currentAuthority(deps(statusBody({ tableVersion: 'v0004' }), cutoverDir))).rejects.toBeInstanceOf(
        CutoverDataError,
      );
    } finally {
      rmSync(cutoverDir, { recursive: true, force: true });
    }
  });
});
