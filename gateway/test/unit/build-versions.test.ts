// Tests the committed cut-over versions against the generator's rules; build mechanics and the CLI are tested in ../cutover/.
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLLBACK_REPORT, buildVersions, rosterGroupSet } from '../../src/cutover/build-versions.js';
import { loadGroups } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { CutoverEntry, CutoverTable, GroupsFile } from '../../src/cutover/types.js';
import { loadValidationContext, validateVersion, type ValidationContext } from '../../src/cutover/validate.js';
import { committedTable, groupsFile, type CommittedVersion } from '../helpers/versions.js';

const paths = resolveGatewayPaths({});
const ADD = 'admin:cusers.update{type=2,action=add}';
const UPDATE = 'admin:cusers.update{type=2,action=update}';
const ARCHIVE = 'fixture:people/persons/{id}/archive@post';
const IMAGE_UPLOADS = ['admin:carch.update{upload=image}', 'admin:carch.multifileupload{upload=image}', 'api:file.save{upload=image}'];
const SYNTHETIC_V1 = /^\w+:\/v1\//;

const byRoute = (table: CutoverTable): Map<string, CutoverEntry> => new Map(table.entries.map((entry) => [entry.route, entry]));

let ctx: ValidationContext;
let groups: GroupsFile;
let versions: Record<CommittedVersion, CutoverTable>;

beforeAll(async () => {
  const [context, groupsDoc, v0001, v0002, v0003] = await Promise.all([
    loadValidationContext(paths, 'ci'),
    loadGroups(paths),
    committedTable('v0001'),
    committedTable('v0002'),
    committedTable('v0003'),
  ]);
  ctx = context;
  groups = groupsDoc;
  versions = { v0001, v0002, v0003 };
});

describe('committed versions', () => {
  it('each validates in ci mode against a context loaded with its predecessor', async () => {
    let prior: CutoverTable | undefined;
    for (const table of [versions.v0001, versions.v0002, versions.v0003]) {
      const context = await loadValidationContext(paths, 'ci', prior === undefined ? {} : { prior });
      expect(validateVersion(table, context), table.tableVersion).toEqual([]);
      prior = table;
    }
  });

  it('carry a rollback reference only in v0003, over the roster group set and the rollback-before report', () => {
    const roster = rosterGroupSet(groups);
    expect(roster.length).toBeGreaterThan(0);
    expect([versions.v0001.rollbackRefs, versions.v0002.rollbackRefs]).toEqual([[], []]);
    expect(versions.v0003.rollbackRefs).toHaveLength(1);
    expect(versions.v0003.rollbackRefs[0]).toMatchObject({ groups: roster, report: ROLLBACK_REPORT });
    expect(ROLLBACK_REPORT.endsWith('reconciliation/rollback-before.json')).toBe(true);
  });

  it.each([
    ['v0001', 'legacy', 'v0001'],
    ['v0002', 'target', 'v0002'],
    ['v0003', 'target', 'v0002'],
  ] as const)('serve sitemonitor:run in %s as a %s programs-sites job', (version, state, tableVersion) => {
    expect(byRoute(versions[version]).get('sitemonitor:run')).toMatchObject({
      kind: 'job',
      owningService: 'programs-sites',
      state,
      tableVersion,
    });
  });

  it('hold every halted and open-fix exception key, the image-upload variants included, on legacy in v0002', () => {
    const held = [
      ...new Set(
        ctx.exceptions.entries
          .filter((entry) => entry.status === 'halted' || (entry.decision === 'fix' && entry.status === 'open'))
          .flatMap((entry) => [entry.routeKey, ...(entry.appliesTo ?? [])])
          .map(normaliseRouteKey),
      ),
    ];
    expect(held).toEqual(expect.arrayContaining(IMAGE_UPLOADS));
    const entries = byRoute(versions.v0002);
    for (const key of held) {
      // A held key with no recorded write, such as the multi-file upload page, stays a read.
      const writes = (ctx.inventoryKeys.get(key)?.writeSet.length ?? 0) > 0;
      expect(entries.get(key), key).toMatchObject({ kind: writes ? 'legacy-write' : 'read', state: 'legacy' });
    }
  });

  it("return R's write entries and the reads over its units to legacy in v0003 and keep every other entry as in v0002", () => {
    const roster = new Set(rosterGroupSet(groups));
    const rosterUnits = new Set(groups.groups.filter((group) => roster.has(group.id)).flatMap((group) => group.units));
    const before = byRoute(versions.v0002);
    for (const entry of versions.v0003.entries) {
      const overRoster =
        entry.kind === 'write' ? roster.has(entry.group ?? '') : entry.kind === 'read' && entry.units.some((unit) => rosterUnits.has(unit));
      expect(entry.state, entry.route).toBe(overRoster ? 'legacy' : before.get(entry.route)?.state);
    }
    expect([before.get(ARCHIVE)?.state, byRoute(versions.v0003).get(ARCHIVE)?.state]).toEqual(['target', 'legacy']);
  });
});

describe('rosterGroupSet', () => {
  it('selects, sorted, every group holding a roster write entry or seam unit and no other', () => {
    const file = groupsFile([
      { id: 'grp:z', units: ['people.person'], writeEntries: [ADD] },
      { id: 'grp:y', units: ['identity.user_account'], writeEntries: [UPDATE] },
      { id: 'grp:x', units: ['people.user_address'], writeEntries: [ARCHIVE] },
      { id: 'grp:w', units: ['people.person_archive'] },
      { id: 'grp:v', units: ['timesheets.blackout', 'timesheets.timesheet_day'] },
      {
        id: 'grp:a',
        units: ['identity.membership'],
        writeEntries: ['admin:cusers.update{type=2,action=delete}', 'fixture:people/persons/{id}/archive@get'],
      },
    ]);
    expect(rosterGroupSet({ groups: [...file.groups].reverse() })).toEqual(['grp:v', 'grp:w', 'grp:x', 'grp:y', 'grp:z']);
  });
});

describe('a fixtures-unavailable build', () => {
  it('keeps every fixture route and moves the groups its /v1/ entries name, and the fixture reads over them, to target', () => {
    const { v0002 } = versions;
    const unavailable = buildVersions(ctx, { available: false })[1] as CutoverTable;
    const after = byRoute(unavailable);
    const fixtureRoutes = v0002.entries.map((entry) => entry.route).filter((route) => route.startsWith('fixture:'));
    expect(fixtureRoutes.length).toBeGreaterThan(0);
    for (const route of fixtureRoutes) expect(after.has(route), route).toBe(true);

    const named = [
      ...new Set(unavailable.entries.flatMap((entry) => (SYNTHETIC_V1.test(entry.route) && entry.group ? [entry.group] : []))),
    ].sort();
    expect(named.length).toBeGreaterThan(0);
    const flipped = Object.keys(v0002.groupAuthority).filter((group) => unavailable.groupAuthority[group] !== v0002.groupAuthority[group]);
    expect(flipped).toEqual(named);
    for (const group of flipped) expect(unavailable.groupAuthority[group], group).toBe('target');

    const namedUnits = new Set(groups.groups.filter((group) => named.includes(group.id)).flatMap((group) => group.units));
    const changed = v0002.entries.filter((entry) => after.get(entry.route)?.state !== entry.state);
    expect(changed.some((entry) => entry.route.startsWith('fixture:') && entry.kind === 'read')).toBe(true);
    for (const entry of changed) {
      expect(entry.state, entry.route).toBe('legacy');
      if (entry.kind === 'read') expect(entry.units.some((unit) => namedUnits.has(unit)), entry.route).toBe(true);
    }
  });
});
