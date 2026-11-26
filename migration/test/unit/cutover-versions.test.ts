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
  preloadCutover,
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

/** A fresh cut-over directory under the scratch directory holding `files`, keyed by path relative to it. */
function cutoverDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(scratch, 'memo-'));
  mkdirSync(path.join(dir, 'versions'));
  for (const [rel, text] of Object.entries(files)) writeFileSync(path.join(dir, rel), text);
  return dir;
}

/** Whether every object and array reachable from `value` is frozen. */
function deeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

function thrownBy(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the read to throw');
}

const smallGroups: GroupsFile = {
  sourceSha: 'x',
  groups: [{ id: 'grp:a', units: ['a.one'], writeEntries: ['admin:x'], hasCarryWrite: true }],
};
const smallVersion = (tableVersion: string): CutoverVersion => ({
  ...version(tableVersion, [entry('admin:x', 'target', { kind: 'write', group: 'grp:a', units: ['a.one'] })], { 'grp:a': 'target' }),
  rollbackRefs: [{ groups: ['grp:a'], rollbackSet: ['grp:a'], report: 'r.json', evidence: ['e.json'] }],
});
const groupsIn = (dir: string): string => path.join(dir, 'groups.json');

const absent = (error: unknown): void => {
  expect(error).toMatchObject({ code: 'ENOENT' });
};
const instanceOf =
  (type: typeof CutoverDataError | SyntaxErrorConstructor) =>
  (error: unknown): void => {
    expect(error).toBeInstanceOf(type);
  };

describe('memoised loads', () => {
  it.each<[string, string, unknown, (dir: string) => unknown]>([
    ['version', 'versions/v0011.json', smallVersion('v0011'), (dir) => loadVersion(dir, 'v0011')],
    ['groups file', 'groups.json', smallGroups, (dir) => loadGroups(groupsIn(dir))],
  ])('serve a %s from memory after its first load, deeply frozen', (_name, rel, content, load) => {
    const dir = cutoverDirWith({ [rel]: JSON.stringify(content) });
    const first = load(dir);
    rmSync(path.join(dir, rel));

    expect(load(dir)).toBe(first);
    expect(first).toEqual(content);
    expect(deeplyFrozen(first)).toBe(true);
  });

  it.each<[string, string, string | null, (dir: string) => unknown, (error: unknown) => void, unknown]>([
    ['an absent version', 'versions/v0012.json', null, (dir) => loadVersion(dir, 'v0012'), absent, smallVersion('v0012')],
    [
      'a version naming another version',
      'versions/v0012.json',
      JSON.stringify(smallVersion('v0013')),
      (dir) => loadVersion(dir, 'v0012'),
      instanceOf(CutoverDataError),
      smallVersion('v0012'),
    ],
    [
      'an invalid JSON version',
      'versions/v0012.json',
      '{"tableVersion": "v0012",',
      (dir) => loadVersion(dir, 'v0012'),
      instanceOf(SyntaxError),
      smallVersion('v0012'),
    ],
    ['an absent groups file', 'groups.json', null, (dir) => loadGroups(groupsIn(dir)), absent, smallGroups],
    ['an invalid JSON groups file', 'groups.json', '{"groups": [', (dir) => loadGroups(groupsIn(dir)), instanceOf(SyntaxError), smallGroups],
  ])('keep nothing of %s, so the fixed file loads', (_name, rel, broken, load, check, fixed) => {
    const dir = cutoverDirWith(broken === null ? {} : { [rel]: broken });
    check(thrownBy(() => load(dir)));
    check(thrownBy(() => load(dir)));

    writeFileSync(path.join(dir, rel), JSON.stringify(fixed));
    expect(load(dir)).toEqual(fixed);
  });

  describe('of one directory, shared by every reader,', () => {
    const dir = cutoverDirWith({ 'versions/v0014.json': JSON.stringify(smallVersion('v0014')), 'groups.json': JSON.stringify(smallGroups) });
    const first = (): { v: CutoverVersion; g: GroupsFile } => ({ v: loadVersion(dir, 'v0014'), g: loadGroups(groupsIn(dir)) });

    it.each<[string, (loaded: { v: CutoverVersion; g: GroupsFile }) => unknown]>([
      ['adding an entry', ({ v }) => v.entries.push(entry('admin:y', 'legacy'))],
      ['changing an entry state', ({ v }) => (v.entries[0]!.state = 'legacy')],
      ['adding a unit to an entry', ({ v }) => v.entries[0]!.units.push('a.two')],
      ['changing a group authority', ({ v }) => (v.groupAuthority['grp:a'] = 'legacy')],
      ['adding a group authority', ({ v }) => (v.groupAuthority['grp:b'] = 'target')],
      ['replacing the rollback refs', ({ v }) => (v.rollbackRefs = [])],
      ['adding a rollback group', ({ v }) => v.rollbackRefs[0]!.groups.push('grp:b')],
      ['adding a group', ({ g }) => g.groups.push({ id: 'grp:b', units: [], writeEntries: [], hasCarryWrite: false })],
      ['emptying the units of a group', ({ g }) => (g.groups[0]!.units.length = 0)],
      ['adding a write entry to a group', ({ g }) => g.groups[0]!.writeEntries.push('admin:y')],
    ])('reject %s with TypeError and stay unchanged', (_name, write) => {
      expect(() => write(first())).toThrow(TypeError);

      expect(first()).toEqual({ v: smallVersion('v0014'), g: smallGroups });
    });
  });
});

describe('preloadCutover', () => {
  it('loads groups.json and every vNNNN.json beside other files, so later loads need no file and earlier loads are kept', async () => {
    const dir = cutoverDirWith({
      'groups.json': JSON.stringify(smallGroups),
      'versions/v0021.json': JSON.stringify(smallVersion('v0021')),
      'versions/v0022.json': JSON.stringify({ ...smallVersion('v0022'), previous: 'v0021' }),
      'versions/v22.json': '{',
      'versions/notes.txt': 'not a version',
    });
    const earlier = loadVersion(dir, 'v0021');

    await preloadCutover({ cutoverDir: dir, groupsFile: groupsIn(dir) });
    rmSync(dir, { recursive: true, force: true });

    expect(loadVersion(dir, 'v0021')).toBe(earlier);
    expect(loadVersion(dir, 'v0022')).toEqual({ ...smallVersion('v0022'), previous: 'v0021' });
    expect(loadGroups(groupsIn(dir))).toEqual(smallGroups);
    expect(deeplyFrozen(loadVersion(dir, 'v0022'))).toBe(true);
    expect(deeplyFrozen(loadGroups(groupsIn(dir)))).toBe(true);
  });

  it.each<[string, Record<string, string>, (error: unknown) => void, (dir: string) => unknown]>([
    [
      'a version naming another version',
      { 'groups.json': JSON.stringify(smallGroups), 'versions/v0031.json': JSON.stringify(smallVersion('v0030')) },
      (error) => {
        expect(error).toBeInstanceOf(CutoverDataError);
        expect((error as Error).message).toMatch(/versions\/v0031\.json declares tableVersion "v0030", expected "v0031"/);
      },
      (dir) => loadVersion(dir, 'v0031'),
    ],
    [
      'an invalid JSON version',
      { 'groups.json': JSON.stringify(smallGroups), 'versions/v0032.json': '{"tableVersion": "v0032",' },
      instanceOf(SyntaxError),
      (dir) => loadVersion(dir, 'v0032'),
    ],
    ['an absent groups file', { 'versions/v0033.json': JSON.stringify(smallVersion('v0033')) }, absent, (dir) => loadGroups(groupsIn(dir))],
    ['an invalid JSON groups file', { 'groups.json': '{"groups": [' }, instanceOf(SyntaxError), (dir) => loadGroups(groupsIn(dir))],
  ])('rejects %s and keeps it out of memory', async (_name, files, check, load) => {
    const dir = cutoverDirWith(files);

    check(await preloadCutover({ cutoverDir: dir, groupsFile: groupsIn(dir) }).then(() => undefined, (error: unknown) => error));
    check(thrownBy(() => load(dir)));
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
