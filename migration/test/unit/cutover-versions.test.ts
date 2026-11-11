// Unit tests for the cut-over version model over the committed versions and groups, plus synthetic contradictions.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CutoverDataError,
  LOGIN_ROUTE_KEY,
  diffVersions,
  entriesTouching,
  legacyBoundEntries,
  legacyWriteEntries,
  loadGroups,
  loadVersion,
  loginGroup,
  unitAuthority,
  type CutoverEntry,
  type CutoverVersion,
  type GroupsFile,
} from '../../src/cutover/versions.js';
import { repoPath } from '../../src/paths.js';

const CUTOVER_DIR = repoPath('gateway/cutover');
const groups = loadGroups(path.join(CUTOVER_DIR, 'groups.json'));
const v1 = loadVersion(CUTOVER_DIR, 'v0001');
const v2 = loadVersion(CUTOVER_DIR, 'v0002');
const v3 = loadVersion(CUTOVER_DIR, 'v0003');

const scratch = mkdtempSync(path.join(os.tmpdir(), 'opt2-cutover-versions-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sorted = (values: Iterable<string>): string[] => [...values].sort();
const unitsOf = (ids: Iterable<string>): string[] => {
  const wanted = new Set(ids);
  return sorted(groups.groups.filter((g) => wanted.has(g.id)).flatMap((g) => g.units));
};
const groupsWith = (version: CutoverVersion, authority: 'legacy' | 'target'): string[] =>
  Object.entries(version.groupAuthority)
    .filter(([, a]) => a === authority)
    .map(([id]) => id);

function entry(route: string, state: 'legacy' | 'target', overrides: Partial<CutoverEntry> = {}): CutoverEntry {
  return {
    route,
    owningService: 'people',
    tableVersion: 'v0001',
    state,
    kind: 'read',
    group: null,
    units: [],
    disposition: 'carry',
    ...overrides,
  };
}

function version(tableVersion: string, entries: CutoverEntry[], groupAuthority: Record<string, 'legacy' | 'target'>): CutoverVersion {
  return {
    tableVersion,
    previous: null,
    sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f',
    createdAt: '2026-06-01T00:00:00.000Z',
    groupAuthority,
    rollbackRefs: [],
    entries,
  };
}

describe('loaders', () => {
  it.each([
    ['v0001', v1, null],
    ['v0002', v2, 'v0001'],
    ['v0003', v3, 'v0002'],
  ])('loads %s with its predecessor', (name, loaded, previous) => {
    expect(loaded.tableVersion).toBe(name);
    expect(loaded.previous).toBe(previous);
    expect(loaded.entries.length).toBeGreaterThan(0);
  });

  it('loads the committed groups file', () => {
    expect(groups.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(groups.groups.length).toBeGreaterThan(0);
  });

  it('rejects a version file whose tableVersion differs from its name', () => {
    mkdirSync(path.join(scratch, 'versions'), { recursive: true });
    writeFileSync(path.join(scratch, 'versions', 'v0009.json'), JSON.stringify(version('v0008', [entry('admin:x', 'legacy')], {})));
    expect(() => loadVersion(scratch, 'v0009')).toThrow(CutoverDataError);
    expect(() => loadVersion(scratch, 'v0009')).toThrow(/v0009\.json declares tableVersion "v0008", expected "v0009"/);
  });
});

describe('unitAuthority', () => {
  it('maps every unit of every group to legacy under v0001, in groups-file order', () => {
    const authority = unitAuthority(v1, groups);
    const allUnits = groups.groups.flatMap((g) => g.units);
    expect(authority.size).toBe(allUnits.length);
    expect([...authority.keys()]).toEqual(allUnits);
    expect(new Set(authority.values())).toEqual(new Set(['legacy']));
  });

  it('gives each unit its group authority under v0002', () => {
    const authority = unitAuthority(v2, groups);
    for (const group of groups.groups) {
      for (const unit of group.units) expect(authority.get(unit)).toBe(v2.groupAuthority[group.id]);
    }
  });

  const contradictions: Array<[string, GroupsFile, Record<string, 'legacy' | 'target'>, RegExp]> = [
    [
      'a unit in two groups',
      {
        sourceSha: 'x',
        groups: [
          { id: 'grp:a.one', units: ['a.one', 'a.shared'], writeEntries: [], hasCarryWrite: false },
          { id: 'grp:a.shared', units: ['a.shared'], writeEntries: [], hasCarryWrite: false },
        ],
      },
      { 'grp:a.one': 'legacy', 'grp:a.shared': 'target' },
      /Unit a\.shared is in both group grp:a\.one and group grp:a\.shared/,
    ],
    [
      'a group missing from groupAuthority',
      { sourceSha: 'x', groups: [{ id: 'grp:a.one', units: ['a.one'], writeEntries: [], hasCarryWrite: false }] },
      {},
      /Version v0042 has no groupAuthority for group grp:a\.one/,
    ],
  ];

  it.each(contradictions)('rejects %s', (_case, file, groupAuthority, message) => {
    const subject = version('v0042', [entry('admin:x', 'legacy')], groupAuthority);
    expect(() => unitAuthority(subject, file)).toThrow(CutoverDataError);
    expect(() => unitAuthority(subject, file)).toThrow(message);
  });

  it('names the error class', () => {
    expect(new CutoverDataError('m').name).toBe('CutoverDataError');
  });
});

describe('entry selections', () => {
  it('selects legacy-bound and legacy-write entries', () => {
    expect(legacyBoundEntries(v2)).toEqual(v2.entries.filter((e) => e.state === 'legacy'));
    expect(legacyWriteEntries(v2).every((e) => e.kind === 'legacy-write')).toBe(true);
    expect(legacyWriteEntries(v2).length).toBe(v2.entries.filter((e) => e.kind === 'legacy-write').length);
  });

  it('selects entries touching any of the given units', () => {
    const archive = groups.groups.find((g) => g.id === 'grp:people.person_archive');
    expect(archive).toBeDefined();
    const touching = entriesTouching(v2, archive?.units ?? []);
    expect(touching.length).toBeGreaterThan(0);
    expect(touching.every((e) => e.units.some((u) => archive?.units.includes(u)))).toBe(true);
    expect(touching.map((e) => e.route)).toContain('fixture:people/persons/{id}/archive@post');
    expect(entriesTouching(v2, [])).toEqual([]);
  });
});

describe('loginGroup', () => {
  it('returns the committed group holding the admin login action', () => {
    expect(loginGroup(groups)?.writeEntries).toContain(LOGIN_ROUTE_KEY);
  });

  it('compares route keys in their canonical form', () => {
    const file: GroupsFile = {
      sourceSha: 'x',
      groups: [
        { id: 'grp:a.one', units: ['a.one'], writeEntries: ['admin:clogin.main'], hasCarryWrite: true },
        { id: 'grp:b.one', units: ['b.one'], writeEntries: [' Admin:cLogin.Login '], hasCarryWrite: true },
      ],
    };
    expect(loginGroup(file)?.id).toBe('grp:b.one');
    expect(loginGroup({ sourceSha: 'x', groups: [file.groups[0]!] })).toBeUndefined();
  });
});

describe('diffVersions', () => {
  it('moves exactly the units of the groups v0002 makes target, v0001 to v0002', () => {
    const diff = diffVersions(v1, v2, groups);
    expect([...diff.toTarget]).toEqual(unitsOf(groupsWith(v2, 'target')));
    expect(diff.toLegacy.size).toBe(0);
    expect([...diff.changedUnits]).toEqual([...diff.toTarget]);
  });

  it('returns the rollback groups to legacy, v0002 to v0003', () => {
    const rollbackGroups = v3.rollbackRefs.flatMap((ref) => ref.groups);
    expect(rollbackGroups.length).toBeGreaterThan(0);
    for (const id of rollbackGroups) expect(v3.groupAuthority[id]).toBe('legacy');

    const diff = diffVersions(v2, v3, groups);
    // A rollback group already legacy in v0002 changes no unit, so T is the units of those v0002 made target.
    const returned = rollbackGroups.filter((id) => v2.groupAuthority[id] === 'target');
    expect([...diff.changedUnits]).toEqual(unitsOf(returned));
    expect(diff.toTarget.size).toBe(0);
    expect([...diff.toLegacy]).toEqual([...diff.changedUnits]);
  });

  it('lists entries whose state changes and the legacy-write entries meeting the changed units, v0002 to v0003', () => {
    const diff = diffVersions(v2, v3, groups);
    const before = new Map(v2.entries.map((e) => [e.route, e.state]));
    const expected = v3.entries.filter((e) => before.get(e.route) !== e.state).map((e) => e.route);
    expect(diff.changedEntries.map((c) => c.route)).toEqual(sorted(expected));
    const archive = diff.changedEntries.find((c) => c.route === 'fixture:people/persons/{id}/archive@post');
    expect(archive).toMatchObject({ from: 'target', to: 'legacy' });
    expect(archive?.entry).toBe(v3.entries.find((e) => e.route === archive?.route));

    const meeting = v3.entries
      .filter((e) => e.kind === 'legacy-write' && e.units.some((u) => diff.changedUnits.has(u)))
      .map((e) => e.route);
    expect(diff.legacyWritesMeetingT.map((e) => e.route)).toEqual(sorted(meeting));
  });

  it.each([
    ['v0001', v1],
    ['v0002', v2],
    ['v0003', v3],
  ])('finds nothing between %s and itself', (_name, subject) => {
    const diff = diffVersions(subject, subject, groups);
    expect(diff.changedUnits.size).toBe(0);
    expect(diff.changedEntries).toEqual([]);
    expect(diff.legacyWritesMeetingT).toEqual([]);
  });

  it('reports added and removed routes with null states, sorted by route', () => {
    const file: GroupsFile = {
      sourceSha: 'x',
      groups: [
        { id: 'grp:z.unit', units: ['z.unit'], writeEntries: ['admin:z.write'], hasCarryWrite: true },
        { id: 'grp:a.unit', units: ['a.unit'], writeEntries: [], hasCarryWrite: false },
      ],
    };
    const lw = entry('page:saveform', 'legacy', { kind: 'legacy-write', units: ['z.unit', 'a.unit'] });
    const untouched = entry('page:render', 'legacy', { kind: 'legacy-write', units: ['a.unit'] });
    const active = version(
      'v0001',
      [entry('admin:removed', 'legacy'), entry('admin:z.write', 'legacy', { kind: 'write', group: 'grp:z.unit', units: ['z.unit'] }), lw, untouched],
      { 'grp:z.unit': 'legacy', 'grp:a.unit': 'legacy' },
    );
    const added = entry('admin:added', 'target');
    const write = entry('admin:z.write', 'target', { kind: 'write', group: 'grp:z.unit', units: ['z.unit'], tableVersion: 'v0002' });
    const proposed = version('v0002', [write, lw, untouched, added], { 'grp:z.unit': 'target', 'grp:a.unit': 'legacy' });

    const diff = diffVersions(active, proposed, file);
    expect([...diff.changedUnits]).toEqual(['z.unit']);
    expect([...diff.toTarget]).toEqual(['z.unit']);
    expect(diff.changedEntries).toEqual([
      { route: 'admin:added', from: null, to: 'target', entry: added },
      { route: 'admin:removed', from: 'legacy', to: null, entry: active.entries[0] },
      { route: 'admin:z.write', from: 'legacy', to: 'target', entry: write },
    ]);
    expect(diff.legacyWritesMeetingT).toEqual([lw]);
  });
});
