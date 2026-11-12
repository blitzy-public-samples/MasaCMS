import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  esapiUrlEncode,
  routeKeyForRequest,
  type RouteKeyOptions,
  type RouteKeyRequest,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import { routeKeyCaseOptions } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REHEARSAL_SCENARIO_IDS,
  isRehearsalScenario,
  scenarioSchema,
  type AuthMode,
  type SeedRef,
  type Step,
} from '../../src/golden/catalogue.js';
import {
  FINDING_KINDS,
  INVENTORY_PATH,
  NEUTRAL_ID,
  carriedAdminActions,
  checkCoverage,
  countByKind,
  coverageRouteKey,
  coverageRouteKeys,
  coverageRouteResults,
  defaultRouteKeyOptions,
  fromRouteKeyRequest,
  loadCoverageInputs,
  main,
  toRouteKeyRequest,
  type CoverageFinding,
  type CoverageInputs,
  type CoverageScenario,
  type CutoverEntry,
  type InventoryItem,
} from '../../src/golden/coverage.js';
import { SEED_CREDENTIALS_FILE, basicAuth, loadSecretStore, loadSeedStore } from '../../src/golden/session.js';
import type { SeedKeyStores } from '../../src/golden/workload.js';
import { runCli } from '../../src/lib/cli.js';
import { repoPath } from '../../src/lib/paths.js';

const VARIANTS = (
  JSON.parse(readFileSync(repoPath('gateway/cutover/variants.json'), 'utf8')) as { variants: VariantDeclaration[] }
).variants;
const OPTIONS: RouteKeyOptions = { ...routeKeyCaseOptions, variants: VARIANTS };
const PINNED_SHA = (JSON.parse(readFileSync(repoPath('opt2/source-pin.json'), 'utf8')) as { sha: string }).sha;

const RESERVED_PERSON = '1A2B3C4D-0000-1111-2222333344445555';
const RESERVED_USERNAME = 'rh-create-01';
/** The username the seeded dataset holds for {@link RESERVED_PERSON}. */
const RESERVED_PERSON_USERNAME = 'reserved.person';

const DATASET_FILE = path.join('seed', 'dataset.json');
const CREDENTIALS_FILE = path.join('secrets', SEED_CREDENTIALS_FILE);
const MISUSE_CATALOGUE = fileURLToPath(new URL('../fixtures/golden/catalogue.reserved-misuse.yaml', import.meta.url));
const SAMPLE_SEED_CONFIG = fileURLToPath(new URL('../fixtures/golden/seed-config.sample.json', import.meta.url));

/** Reserved person `n` of the sample seed configuration. */
function samplePerson(n: number): string {
  return `99999999-0000-0000-00000000000000${String(n).padStart(2, '0')}`;
}

/** Writes each state-relative JSON file under `dir`; returns seed stores over it reading `configPath`. */
async function seedStores(dir: string, files: Record<string, unknown>, configPath?: string): Promise<SeedKeyStores> {
  for (const [file, json] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), JSON.stringify(json), 'utf8');
  }
  const env = { OPT2_STATE_DIR: dir };
  return { seed: loadSeedStore(env, { configPath }), secrets: loadSecretStore(env), env };
}

function datasetRef(as: string, dataPath: string, where?: SeedRef['where'], index?: number): SeedRef {
  const ref: SeedRef = { as, source: 'dataset', path: dataPath };
  if (where !== undefined) ref.where = where;
  if (index !== undefined) ref.index = index;
  return ref;
}

/** Mutable form of {@link CoverageInputs}, without the options (they hold functions `structuredClone` rejects). */
interface Draft {
  scenarios: CoverageScenario[];
  entries: CutoverEntry[];
  controllers: Array<{ actions: Array<InventoryItem & { variants?: InventoryItem[] }> }>;
  reserved: { persons: string[]; usernames: string[] };
}

/** A validated-shape step with the schema defaults applied. */
function step(fields: Partial<Step> & Pick<Step, 'name' | 'route'>): Step {
  return { method: 'GET', csrf: 'none', ...fields };
}

const LIST_USERS = step({ name: 'list', route: '/admin/?muraAction=cUsers.listUsers&siteid=${seed.site.siteid}' });
const CREATE_PERSON = step({
  name: 'create',
  method: 'POST',
  route: '/admin/index.cfm?muraAction=cUsers.update&userid=${seed.user.userid}',
  csrf: 'fetch-form',
  form: { type: '2', action: 'Add', username: '${seed.user.username}', siteid: 'tenant-a' },
});
const READ_CONTENT = step({ name: 'read', route: '/_api/json/v1/tenant-a/content/${seed.page.contentid}' });
const PUBLIC_LOGIN = step({
  name: 'login',
  method: 'POST',
  route: '/tenant-a/?doaction=login',
  form: { username: '${seed.member.username}', password: '${secret:member}' },
});

const BASE: Draft = {
  scenarios: [
    {
      id: 'GS-PE-01',
      steps: [LIST_USERS, CREATE_PERSON],
      covers: ['admin:cusers.listusers', 'admin:cusers.update{type=2,action=add}'],
    },
    { id: 'GS-CO-05', steps: [READ_CONTENT], covers: ['api:content.findone'] },
    { id: 'GS-PUB-01', steps: [PUBLIC_LOGIN], covers: ['page:login'] },
  ],
  entries: [
    { route: 'admin:cusers.listusers', owningService: 'people', state: 'target', kind: 'read' },
    { route: 'admin:cusers.update{type=2,action=add}', owningService: 'people', state: 'target', kind: 'write' },
    { route: 'api:content.findone', owningService: 'strategies-content', state: 'target', kind: 'read' },
    { route: 'page:login', owningService: 'identity', state: 'legacy', kind: 'legacy-write' },
    { route: 'admin:carch.export', owningService: 'strategies-content', state: 'legacy', kind: 'read' },
    { route: 'static:/admin/assets/**', owningService: 'web', state: 'target', kind: 'static' },
    { route: 'opt2:/stub/**', owningService: 'stub', state: 'target', kind: 'read' },
  ],
  controllers: [
    {
      actions: [
        { routeKey: 'admin:cusers.listusers', disposition: 'carry' },
        {
          routeKey: 'admin:cusers.update',
          disposition: null,
          variants: [
            { routeKey: 'admin:cusers.update{type=2,action=add}', disposition: 'carry' },
            { routeKey: 'admin:cusers.update{type=2,action=delete}', disposition: 'decision' },
          ],
        },
        { variants: [{ routeKey: 'admin:carch.export', disposition: 'legacy-served' }] },
      ],
    },
  ],
  reserved: { persons: [RESERVED_PERSON], usernames: [RESERVED_USERNAME] },
};

/** A fresh copy of {@link BASE} after `edit`, with the committed route-key options. */
function inputs(edit: (draft: Draft) => void = () => undefined): CoverageInputs {
  const draft = structuredClone(BASE);
  edit(draft);
  return { ...draft, options: OPTIONS };
}

function scenario(draft: Draft, id: string): CoverageScenario {
  const found = draft.scenarios.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no scenario ${id}`);
  return found;
}

function without(draft: Draft, id: string): void {
  draft.scenarios = draft.scenarios.filter((s) => s.id !== id);
}

describe('checkCoverage', () => {
  it('reports nothing when every target, legacy-write and carried admin action is covered and exercised', () => {
    expect(checkCoverage(inputs())).toEqual([]);
  });

  it('reads the committed variants when no options are given', () => {
    expect(checkCoverage(structuredClone(BASE))).toEqual([]);
    expect(defaultRouteKeyOptions().variants).toEqual(VARIANTS);
  });

  it('reports a target entry no cover reaches, with its owning service', () => {
    const found = checkCoverage(inputs((d) => without(d, 'GS-CO-05')));
    expect(found).toEqual([
      { kind: 'uncovered-target', route: 'api:content.findone', owningService: 'strategies-content' },
    ]);
  });

  it.each([
    { owningService: 'web', kind: 'static', exempt: true },
    { owningService: 'gateway', kind: 'static', exempt: true },
    { owningService: 'stub', kind: 'write', exempt: true },
    { owningService: 'web', kind: 'read', exempt: false },
    { owningService: 'strategies-content', kind: 'static', exempt: false },
  ] as const)(
    'an uncovered $kind target entry owned by $owningService is exempt: $exempt',
    ({ owningService, kind, exempt }) => {
      const route = 'static:/opt2-assets/**';
      const found = checkCoverage(inputs((d) => d.entries.push({ route, owningService, state: 'target', kind })));
      expect(found).toEqual(exempt ? [] : [{ kind: 'uncovered-target', route, owningService }]);
    },
  );

  it('reports a legacy-write entry no cover reaches', () => {
    expect(checkCoverage(inputs((d) => without(d, 'GS-PUB-01')))).toEqual([
      { kind: 'uncovered-legacy-write', route: 'page:login' },
    ]);
  });

  it('reports a carried admin action no cover names, by its canonical key', () => {
    const found = checkCoverage(
      inputs((d) =>
        d.controllers[0]?.actions[1]?.variants?.push({
          routeKey: ' admin:cUsers.update{type=2,action=update} ',
          disposition: 'carry',
        }),
      ),
    );
    expect(found).toEqual([{ kind: 'uncovered-admin-action', routeKey: 'admin:cusers.update{type=2,action=update}' }]);
  });

  it('reports a carried admin action whose key names no route family', () => {
    const found = checkCoverage(
      inputs((d) => d.controllers.push({ actions: [{ routeKey: 'nosuch:carch.list', disposition: 'carry' }] })),
    );
    expect(found).toEqual([{ kind: 'uncovered-admin-action', routeKey: 'nosuch:carch.list' }]);
  });

  it('requires no cover for decision, legacy-served or keyless actions', () => {
    const found = checkCoverage(
      inputs((d) =>
        d.controllers.push({
          actions: [
            { routeKey: 'admin:ctrash.list', disposition: 'decision' },
            { routeKey: 'admin:cdashboard.main', disposition: 'legacy-served' },
            { routeKey: null, disposition: 'carry' },
            { routeKey: '', disposition: 'carry' },
          ],
        }),
      ),
    );
    expect(found).toEqual([]);
  });

  it('reports a cover that matches no cut-over entry', () => {
    const found = checkCoverage(
      inputs((d) => {
        const people = scenario(d, 'GS-PE-01');
        people.steps.push(step({ name: 'nosuch', route: '/admin/?muraAction=cUsers.noSuchAction' }));
        people.covers.push('admin:cusers.nosuchaction');
      }),
    );
    expect(found).toEqual([{ kind: 'unknown-cover', scenario: 'GS-PE-01', cover: 'admin:cusers.nosuchaction' }]);
  });

  it('reports a cover of an unknown route family as unknown', () => {
    const found = checkCoverage(inputs((d) => scenario(d, 'GS-CO-05').covers.push('nosuch:content.findone')));
    expect(found).toEqual([
      { kind: 'unknown-cover', scenario: 'GS-CO-05', cover: 'nosuch:content.findone' },
      { kind: 'cover-not-exercised', scenario: 'GS-CO-05', cover: 'nosuch:content.findone' },
    ]);
  });

  it('accepts an error-key cover, which legacy answers without any cut-over entry', () => {
    const found = checkCoverage(
      inputs((d) =>
        d.scenarios.push({
          id: 'GS-TS-01',
          steps: [step({ name: 'missing', route: '/legacy-fixtures/cfml/api.cfm/timesheets' })],
          covers: ['fixture:!notfound@get'],
        }),
      ),
    );
    expect(found).toEqual([]);
  });

  it('reports a cover no step of its scenario exercises', () => {
    const found = checkCoverage(inputs((d) => scenario(d, 'GS-CO-05').covers.push('admin:cusers.listusers')));
    expect(found).toEqual([{ kind: 'cover-not-exercised', scenario: 'GS-CO-05', cover: 'admin:cusers.listusers' }]);
  });

  it.each<[string, (s: CoverageScenario) => void]>([
    ['a browser scenario', (s) => (s.browser = { flow: 'site-manager-tree', console: 'no-new-errors' })],
    [
      'a capture candidate',
      (s) => {
        s.steps[0] = { ...READ_CONTENT, candidates: [{ method: 'GET', route: '/admin/?muraAction=cUsers.listUsers' }] };
      },
    ],
    [
      'a later matrix combination',
      (s) => {
        s.steps[0] = step({
          name: 'read',
          route: '${matrix.route}',
          matrix: { route: [READ_CONTENT.route, '/admin/?muraAction=cUsers.listUsers'] },
        });
      },
    ],
  ])('counts a cover as exercised through %s', (_title, edit) => {
    const found = checkCoverage(
      inputs((d) => {
        const content = scenario(d, 'GS-CO-05');
        content.covers.push('admin:cusers.listusers');
        edit(content);
      }),
    );
    expect(found).toEqual([]);
  });

  it.each<[string, (s: CoverageScenario) => void, string]>([
    ['a person id in a form value', (s) => (s.steps[1]!.form!.notes = `see ${RESERVED_PERSON}`), RESERVED_PERSON],
    [
      'a person id lower-cased without dashes in a route',
      (s) => (s.steps[0]!.route += `&q=${RESERVED_PERSON.replaceAll('-', '').toLowerCase()}`),
      RESERVED_PERSON,
    ],
    ['a username token', (s) => (s.steps[1]!.form!.username = RESERVED_USERNAME), RESERVED_USERNAME],
    [
      'an upper-cased username token',
      (s) => (s.steps[1]!.form!.username = RESERVED_USERNAME.toUpperCase()),
      RESERVED_USERNAME,
    ],
    ['a username as an object key', (s) => (s.steps[1]!.form![RESERVED_USERNAME] = 'x'), RESERVED_USERNAME],
  ])('reports %s outside a rehearsal scenario, and allows it inside one', (_title, edit, value) => {
    const outside = checkCoverage(inputs((d) => edit(scenario(d, 'GS-PE-01'))));
    expect(outside).toEqual([{ kind: 'reserved-identity', scenario: 'GS-PE-01', value }]);
    const inside = checkCoverage(
      inputs((d) => {
        const people = scenario(d, 'GS-PE-01');
        people.id = 'GS-PE-RH-01';
        edit(people);
      }),
    );
    expect(inside).toEqual([]);
  });

  it.each(['rh-create-010', 'xrh-create-01', 'rh-create-01-b', 'rh-create-0'])(
    'does not read %s as the reserved username',
    (username) => {
      expect(checkCoverage(inputs((d) => (scenario(d, 'GS-PE-01').steps[1]!.form!.username = username)))).toEqual([]);
    },
  );

  it('reports every kind together, in FINDING_KINDS order', () => {
    const found = checkCoverage(
      inputs((d) => {
        without(d, 'GS-PUB-01');
        const content = scenario(d, 'GS-CO-05');
        content.covers = ['api:content.nosuch'];
        content.steps[0]!.form = { owner: RESERVED_USERNAME };
        content.seedRefs = [datasetRef('page', 'masa.content')];
        d.controllers.push({ actions: [{ routeKey: 'admin:cusers.editaddress', disposition: 'carry' }] });
      }),
    );
    expect(found.map((f) => f.kind)).toEqual([...FINDING_KINDS]);
    expect(countByKind(found)).toEqual(Object.fromEntries(FINDING_KINDS.map((kind) => [kind, 1])));
  });
});

const REHEARSAL_CASES = [
  ['GS-PE-RH-01', true],
  ['GS-PE-RH-02', true],
  ['GS-PE-RH-03', true],
  ['GS-PE-RH-04', false],
  ['GS-FI-RH-01', false],
  ['GS-PE-01', false],
] as const;

describe('rehearsal scenarios', () => {
  it('are exactly GS-PE-RH-01, GS-PE-RH-02 and GS-PE-RH-03', () => {
    expect(REHEARSAL_SCENARIO_IDS).toEqual(['GS-PE-RH-01', 'GS-PE-RH-02', 'GS-PE-RH-03']);
  });

  it.each(REHEARSAL_CASES)('%s may use the reserved identities: %s', (id, rehearsal) => {
    expect(isRehearsalScenario(id)).toBe(rehearsal);
    const found = checkCoverage(
      inputs((d) => {
        const people = scenario(d, 'GS-PE-01');
        people.id = id;
        people.steps[1]!.form!.username = RESERVED_USERNAME;
      }),
    );
    expect(found).toEqual(rehearsal ? [] : [{ kind: 'reserved-identity', scenario: id, value: RESERVED_USERNAME }]);
  });

  it.each(REHEARSAL_CASES)('%s replays under v0003: %s', (id, rehearsal) => {
    const wanted = rehearsal ? 'v0003' : 'v0002';
    const doc = (tableVersion: string): unknown => ({
      id,
      title: id,
      service: 'people',
      role: 'site-admin',
      sessions: { admin: { login: 'admin', via: 'admin' } },
      steps: [{ name: 'list', route: '/admin/?muraAction=cUsers.listUsers' }],
      compare: ['status'],
      covers: ['admin:cusers.listusers'],
      tableVersion,
    });
    expect(scenarioSchema.safeParse(doc(wanted)).success).toBe(true);
    const other = scenarioSchema.safeParse(doc(rehearsal ? 'v0002' : 'v0003'));
    expect(other.error?.issues).toEqual([
      expect.objectContaining({ path: ['tableVersion'], message: `must be ${wanted} for ${id}` }),
    ]);
  });
});

describe('checkCoverage seed selections', () => {
  const SEED_CONFIG = {
    reserved: {
      rehearsal: { persons: [RESERVED_PERSON], usernames: [RESERVED_USERNAME] },
      performance: { site: 'tenant-a' },
    },
  };
  const DATASET = {
    businessDate: '2026-06-30',
    masa: {
      users: [
        { userID: 'FIXTURE-USER-0001', siteID: 'tenant-a', isPublic: 0, username: 'plain.person' },
        { userID: RESERVED_PERSON, siteID: 'tenant-a', isPublic: 0, username: RESERVED_PERSON_USERNAME },
      ],
      memberships: [{ userID: RESERVED_PERSON, groupname: 'timesheets.employee', groupSiteID: 'tenant-a' }],
    },
  };
  const CREDENTIALS = {
    roles: { 'tenant-a': { 'site-admin': 'plain.person', 'timesheets.employee': 'Reserved.Person' } },
  };
  const EMPLOYEE = datasetRef('member', 'masa.memberships', { groupname: 'timesheets.employee' });

  let dir: string;
  let stores: Record<'seeded' | 'empty', SeedKeyStores>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-golden-coverage-seed-'));
    const config = path.join(dir, 'seeded', 'seed.config.json');
    const files = { [DATASET_FILE]: DATASET, [CREDENTIALS_FILE]: CREDENTIALS, 'seed.config.json': SEED_CONFIG };
    stores = {
      seeded: await seedStores(path.join(dir, 'seeded'), files, config),
      empty: await seedStores(path.join(dir, 'empty'), {}, config),
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** {@link inputs} resolving seed selections against `mode`'s stores; `none` leaves them unloaded. */
  function seeded(edit: (draft: Draft) => void, mode: 'seeded' | 'empty' | 'none' = 'seeded'): CoverageInputs {
    return mode === 'none' ? inputs(edit) : { ...inputs(edit), seedStores: stores[mode] };
  }

  it.each<[string, (s: CoverageScenario) => void, string[]]>([
    [
      'a reserved seed ref',
      (s) => (s.seedRefs = [{ as: 'rh', source: 'reserved', path: 'reserved.rehearsal.persons' }]),
      ['reserved.rehearsal.persons', RESERVED_PERSON],
    ],
    [
      'a users row selected by position',
      (s) => (s.seedRefs = [datasetRef('user', 'masa.users', { siteID: 'tenant-a', isPublic: 0 }, 1)]),
      [RESERVED_PERSON],
    ],
    [
      'a users row selected from the end',
      (s) => (s.seedRefs = [datasetRef('user', 'masa.users', {}, -1)]),
      [RESERVED_PERSON],
    ],
    ['a membership row', (s) => (s.seedRefs = [EMPLOYEE]), [RESERVED_PERSON]],
    [
      'a users row whose where reads an earlier row',
      (s) => (s.seedRefs = [EMPLOYEE, datasetRef('user', 'masa.users', { userID: '${seed.member.userID}' })]),
      [RESERVED_PERSON],
    ],
    [
      'a seeded role login',
      (s) => (s.sessions = { employee: { login: 'seed:tenant-a:timesheets.employee', via: 'jsonapi' } }),
      [RESERVED_PERSON],
    ],
    [
      'a seeded role placeholder',
      (s) => (s.steps[1]!.form!.username = '${user:tenant-a:timesheets.employee}'),
      [RESERVED_PERSON],
    ],
    [
      "a reserved person's dataset username in upper case",
      (s) => (s.steps[1]!.form!.username = RESERVED_PERSON_USERNAME.toUpperCase()),
      [RESERVED_PERSON],
    ],
  ])('reports %s resolving to a reserved identity, except in a rehearsal scenario', (_title, edit, values) => {
    const outside = checkCoverage(seeded((d) => edit(scenario(d, 'GS-PE-01'))));
    expect(outside).toEqual(values.map((value) => ({ kind: 'reserved-identity', scenario: 'GS-PE-01', value })));
    for (const id of REHEARSAL_SCENARIO_IDS) {
      const inside = checkCoverage(
        seeded((d) => {
          const people = scenario(d, 'GS-PE-01');
          people.id = id;
          edit(people);
        }),
      );
      expect(inside).toEqual([]);
    }
  });

  it('passes selections of unreserved rows and role accounts, and reserved refs outside the rehearsal block', () => {
    const found = checkCoverage(
      seeded((d) => {
        const people = scenario(d, 'GS-PE-01');
        const other: SeedRef = { as: 'other', source: 'reserved', path: 'reserved.performance' };
        people.seedRefs = [datasetRef('user', 'masa.users'), other];
        people.sessions = { siteAdmin: { login: 'seed:tenant-a:site-admin', via: 'admin' } };
      }),
    );
    expect(found).toEqual([]);
  });

  it.each<[string, 'seeded' | 'empty' | 'none', (s: CoverageScenario) => void, (state: string) => string]>([
    [
      'a dataset ref without seed stores',
      'none',
      (s) => (s.seedRefs = [datasetRef('user', 'masa.users')]),
      () => 'GS-PE-01: seedRef user: no seed dataset or credentials are loaded',
    ],
    [
      'a seeded login without seed stores',
      'none',
      (s) => (s.sessions = { siteAdmin: { login: 'seed:tenant-a:site-admin', via: 'admin' } }),
      () => '${user:tenant-a:site-admin}: no seed dataset or credentials are loaded',
    ],
    [
      'a dataset ref the state directory has no dataset for',
      'empty',
      (s) => (s.seedRefs = [datasetRef('user', 'masa.users')]),
      (state) => `GS-PE-01: seed dataset ${path.join(state, 'empty', DATASET_FILE)} does not exist`,
    ],
    [
      'a ref no dataset row matches',
      'seeded',
      (s) => (s.seedRefs = [datasetRef('user', 'masa.users', { siteID: 'tenant-z' })]),
      () => 'GS-PE-01: seedRef user: no row at index 0 among the 0 rows of masa.users matching {"siteID":"tenant-z"}',
    ],
    [
      'a role the credentials lack',
      'seeded',
      (s) => (s.steps[1]!.form!.username = '${user:tenant-a:nosuch}'),
      (state) => `\${user:tenant-a:nosuch} has no username in ${path.join(state, 'seeded', CREDENTIALS_FILE)}`,
    ],
  ])('fails closed on %s, except in a rehearsal scenario', (_title, mode, edit, message) => {
    const outside = checkCoverage(seeded((d) => edit(scenario(d, 'GS-PE-01')), mode));
    expect(outside).toEqual([{ kind: 'unresolved-seed-ref', scenario: 'GS-PE-01', message: message(dir) }]);
    const inside = checkCoverage(
      seeded((d) => {
        const people = scenario(d, 'GS-PE-01');
        people.id = 'GS-PE-RH-01';
        edit(people);
      }, mode),
    );
    expect(inside).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, (state: string) => CoverageFinding[]]>([
    [
      'with its dataset',
      {
        [DATASET_FILE]: {
          businessDate: '2026-06-30',
          masa: {
            users: [
              { userID: 'FIXTURE-USER-0001', siteID: 'tenant-a', isPublic: 0, username: 'site.admin' },
              { userID: samplePerson(1), siteID: 'tenant-a', isPublic: 0, username: 'pat.rehearsal' },
            ],
            memberships: [{ userID: samplePerson(1), groupname: 'timesheets.employee', groupSiteID: 'tenant-a' }],
          },
        },
        [CREDENTIALS_FILE]: {
          roles: {
            'tenant-a': {
              'site-admin': 'site.admin',
              'finance.preparer': 'fin.preparer',
              'timesheets.primary-approver': 'ts.approver',
            },
          },
        },
      },
      () => [
        { kind: 'reserved-identity', scenario: 'GS-PE-02', value: samplePerson(2) },
        { kind: 'reserved-identity', scenario: 'GS-PE-RH-04', value: 'reserved.rehearsal.persons' },
        { kind: 'reserved-identity', scenario: 'GS-PE-RH-04', value: samplePerson(3) },
        { kind: 'reserved-identity', scenario: 'GS-FI-RH-01', value: 'rehearsal-04' },
        { kind: 'reserved-identity', scenario: 'GS-ID-05', value: 'rehearsal-05' },
        { kind: 'reserved-identity', scenario: 'GS-TS-01', value: samplePerson(1) },
      ],
    ],
    [
      'without a dataset or credentials',
      {},
      (state) => {
        const noUsername = (role: string): string =>
          `\${user:tenant-a:${role}} has no username in ${path.join(state, CREDENTIALS_FILE)}`;
        return [
          { kind: 'reserved-identity', scenario: 'GS-PE-02', value: samplePerson(2) },
          { kind: 'reserved-identity', scenario: 'GS-PE-RH-04', value: 'reserved.rehearsal.persons' },
          { kind: 'reserved-identity', scenario: 'GS-FI-RH-01', value: 'rehearsal-04' },
          { kind: 'reserved-identity', scenario: 'GS-ID-05', value: 'rehearsal-05' },
          { kind: 'unresolved-seed-ref', scenario: 'GS-PE-02', message: noUsername('site-admin') },
          { kind: 'unresolved-seed-ref', scenario: 'GS-PE-RH-04', message: noUsername('site-admin') },
          { kind: 'unresolved-seed-ref', scenario: 'GS-FI-RH-01', message: noUsername('finance.preparer') },
          {
            kind: 'unresolved-seed-ref',
            scenario: 'GS-TS-01',
            message: `GS-TS-01: seed dataset ${path.join(state, DATASET_FILE)} does not exist`,
          },
        ];
      },
    ],
  ])('reports every misuse of the reserved-misuse sample catalogue %s', async (_title, files, expected) => {
    const state = path.join(dir, 'sample');
    await seedStores(state, files);
    const loaded = await loadCoverageInputs(
      { catalogue: MISUSE_CATALOGUE, seedConfig: SAMPLE_SEED_CONFIG },
      { OPT2_STATE_DIR: state },
    );
    const kinds: ReadonlySet<string> = new Set(['reserved-identity', 'unresolved-seed-ref']);
    expect(checkCoverage(loaded).filter((f) => kinds.has(f.kind))).toEqual(expected(state));
  });
});

describe('countByKind', () => {
  it('lists every kind, zero when absent', () => {
    const findings: CoverageFinding[] = [
      { kind: 'unknown-cover', scenario: 'GS-ID-01', cover: 'admin:x.y' },
      { kind: 'unknown-cover', scenario: 'GS-ID-02', cover: 'admin:x.z' },
      { kind: 'uncovered-legacy-write', route: 'page:login' },
    ];
    expect(countByKind(findings)).toEqual({
      'unknown-cover': 2,
      'uncovered-target': 0,
      'uncovered-legacy-write': 1,
      'uncovered-admin-action': 0,
      'cover-not-exercised': 0,
      'reserved-identity': 0,
      'unresolved-seed-ref': 0,
    });
  });
});

describe('carriedAdminActions', () => {
  it('lists each carried action and variant once, canonical and in inventory order', () => {
    const controllers = [
      ...BASE.controllers,
      {
        actions: [
          { routeKey: 'admin:CUSERS.LISTUSERS', disposition: 'carry' },
          { routeKey: 'admin:cperm.main', disposition: 'carry' },
        ],
      },
    ];
    expect(carriedAdminActions(controllers)).toEqual([
      'admin:cusers.listusers',
      'admin:cusers.update{type=2,action=add}',
      'admin:cperm.main',
    ]);
  });
});

describe('coverageRouteKey', () => {
  it.each([
    ['an admin form POST', CREATE_PERSON, 'admin:cusers.update{type=2,action=add}'],
    ['a JSON API GET', READ_CONTENT, 'api:content.findone'],
  ])('keys %s as routeKeyForRequest keys its converted request', (_title, request, key) => {
    const converted = toRouteKeyRequest(request, OPTIONS);
    expect(JSON.stringify(converted)).not.toContain('${');
    expect(routeKeyForRequest(converted, OPTIONS).key).toBe(key);
    expect(coverageRouteKey(request, OPTIONS)).toBe(key);
    expect(coverageRouteKey(request)).toBe(key);
  });

  it('keys only the first matrix combination', () => {
    const matrixStep = step({
      name: 'm',
      route: '${matrix.route}',
      matrix: { route: ['/admin/?muraAction=cUsers.listUsers', READ_CONTENT.route] },
    });
    expect(coverageRouteKey(matrixStep, OPTIONS)).toBe('admin:cusers.listusers');
  });
});

describe('toRouteKeyRequest', () => {
  it('fills path placeholders with the neutral id and query values by their parameter name', () => {
    const req = toRouteKeyRequest(
      step({
        name: 'q',
        route:
          '/_api/json/v1/${seed.site.name}/content/${x.y}' +
          '?contentid=${seed.page.ref}&title=${seed.page.title}&tag=a&tag=b&flag',
      }),
    );
    expect(req).toEqual({
      method: 'GET',
      path: `/_api/json/v1/${NEUTRAL_ID}/content/${NEUTRAL_ID}`,
      query: { contentid: NEUTRAL_ID, title: 'x', tag: ['a', 'b'], flag: '' },
      headers: {},
    });
  });

  it.each([
    ['${secret:appreload}', {}, 'appreload'],
    ['${secret:appreload}', { appReloadKey: 'reloadnow' }, 'reloadnow'],
    ['${nodash:${seed.user.userid}}', {}, NEUTRAL_ID.replaceAll('-', '')],
    ['${urlencode:a b&c}', {}, esapiUrlEncode('a b&c')],
    ['${seed.user.userid}', {}, NEUTRAL_ID],
    ['${seed.user.name}', {}, 'x'],
    ['literal', {}, 'literal'],
  ])('fills form value %s with options %j as %s', (value, opts, expected) => {
    const req = toRouteKeyRequest(step({ name: 'f', method: 'POST', route: '/admin/', form: { value } }), opts);
    expect(req.form).toEqual({ value: expected });
  });

  it('treats a field whose filled name ends in id as id-valued, array values included', () => {
    const req = toRouteKeyRequest(
      step({
        name: 'f',
        method: 'POST',
        route: '/admin/',
        form: { '${seed.prefix.name}id': '${seed.any.thing}', groups: ['${a.b}', 'fixed'] },
      }),
    );
    expect(req.form).toEqual({ xid: NEUTRAL_ID, groups: ['x', 'fixed'] });
  });

  it.each<[AuthMode, string]>([
    ['basic:admin:${env.MURA_ADMIN_PASSWORD}', basicAuth('admin', 'x')],
    ['basic:svc:${a.b}:${c.d}', basicAuth('svc', 'x:x')],
    ['bearer:${token.access_token}', 'Bearer x'],
  ])('sends the Authorization header of auth mode %s', (auth, header) => {
    expect(toRouteKeyRequest(step({ name: 'a', route: '/_api/rest/v1/tenant-a/content', auth })).headers).toEqual({
      Authorization: header,
    });
  });

  it.each(['session', 'anonymous'] as const)('sends no Authorization header for auth mode %s', (auth) => {
    expect(toRouteKeyRequest(step({ name: 'a', route: '/', auth })).headers).toEqual({});
  });

  it('fills a JSON body, id-valued keys by name, and defaults its content type', () => {
    const req = toRouteKeyRequest(
      step({
        name: 'b',
        method: 'POST',
        route: '/_api/json/v1/tenant-a/',
        body: {
          method: 'save',
          contentid: '${seed.page.ref}',
          items: ['${a.b}', 3, true, null],
          nested: { '${k.v}': 'x' },
        },
      }),
    );
    expect(req.jsonBody).toEqual({
      method: 'save',
      contentid: NEUTRAL_ID,
      items: ['x', 3, true, null],
      nested: { x: 'x' },
    });
    expect(req.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('merges multipart fields into the form and lists the file names', () => {
    const req = toRouteKeyRequest(
      step({
        name: 'u',
        method: 'POST',
        route: '/admin/?muraAction=cArch.multiFileUpload',
        multipart: {
          fields: { siteid: '${seed.site.siteid}' },
          files: [
            { field: 'files', fixture: 'image-png', filename: '${seed.file.name}.png', contentType: 'image/png' },
          ],
        },
      }),
    );
    expect(req.form).toEqual({ siteid: NEUTRAL_ID });
    expect(req.multipartFileNames).toEqual([{ field: 'files', filename: 'x.png' }]);
    expect(req.headers).toEqual({ 'Content-Type': 'multipart/form-data' });
  });

  it('keeps a declared content type and fills header values', () => {
    const req = toRouteKeyRequest(
      step({
        name: 'h',
        method: 'POST',
        route: '/_api/json/v1/tenant-a/',
        headers: { 'content-type': 'text/plain', 'X-csrf_token': '${csrf.token}' },
        form: { method: 'login' },
      }),
    );
    expect(req.headers).toEqual({ 'content-type': 'text/plain', 'X-csrf_token': 'x' });
  });
});

describe('fromRouteKeyRequest', () => {
  it.each<[string, RouteKeyRequest]>([
    [
      'a GET with repeated query names',
      {
        method: 'GET',
        path: '/_api/feed/v1/tenant-a/',
        query: { tag: ['a', 'b'], q: 'x y' },
        headers: { 'X-Test': '1' },
      },
    ],
    [
      'a form POST',
      {
        method: 'POST',
        path: '/admin/index.cfm',
        query: { muraAction: 'cUsers.update' },
        form: { type: '2', action: 'Add', groupid: ['g1', 'g2'] },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    ],
    [
      'a JSON body',
      {
        method: 'PUT',
        path: '/_api/json/v1/tenant-a/',
        query: {},
        jsonBody: { method: 'save', n: 1 },
        headers: { 'Content-Type': 'application/json' },
      },
    ],
    [
      'a multipart upload',
      {
        method: 'POST',
        path: '/admin/',
        query: { muraAction: 'cArch.update' },
        form: { siteid: 'tenant-a' },
        multipartFileNames: [{ field: 'newFile', filename: 'a.png' }],
        headers: { 'Content-Type': 'multipart/form-data' },
      },
    ],
  ])('maps %s back to the same route-key request', (_title, req) => {
    const shape = fromRouteKeyRequest(req);
    expect(shape).toMatchObject({ name: 'case', csrf: 'none' });
    expect(toRouteKeyRequest(shape)).toEqual(req);
  });

  it('upper-cases the method, joins repeated header values and drops absent ones', () => {
    const shape = fromRouteKeyRequest({
      method: 'post',
      path: '/',
      query: {},
      headers: { A: undefined, B: ['1', '2'] },
    });
    expect(shape).toEqual({ name: 'case', method: 'POST', route: '/', csrf: 'none', headers: { B: '1, 2' } });
  });
});

describe('coverageRouteResults', () => {
  it('keys the step and then each candidate, for every matrix combination', () => {
    const matrixStep = {
      ...step({
        name: 'm',
        route: '/_api/json/v1/tenant-a/${matrix.entity}/${seed.row.id}',
        auth: 'basic:admin:${env.MURA_ADMIN_PASSWORD}',
        matrix: { entity: ['content', 'user'] },
      }),
      candidates: [{ method: 'GET' as const, route: '/admin/?muraAction=cUsers.listUsers' }],
    };
    expect(coverageRouteKeys(matrixStep, OPTIONS)).toEqual([
      'api:content.findone',
      'admin:cusers.listusers',
      'api:user.findone',
      'admin:cusers.listusers',
    ]);
    expect(coverageRouteKeys(matrixStep)).toEqual(coverageRouteKeys(matrixStep, OPTIONS));
    expect(coverageRouteResults(matrixStep).map((r) => r.family)).toEqual(['api', 'admin', 'api', 'admin']);
  });
});

describe('main', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-golden-coverage-'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function stderr(): string[] {
    return vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0]));
  }

  /** Runs the CLI through runCli with the temp directory as state; returns the code and the one summary line. */
  async function cli(argv: string[]): Promise<{ code: number; exits: number[]; line: Record<string, unknown> }> {
    const chunks: string[] = [];
    const exits: number[] = [];
    const code = await runCli((args) => main(args, { OPT2_STATE_DIR: path.join(dir, 'state') }), {
      argv,
      command: 'golden:coverage',
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit: (exitCode) => exits.push(exitCode),
    });
    const output = chunks.join('');
    expect(output.endsWith('\n')).toBe(true);
    expect(output.slice(0, -1)).not.toContain('\n');
    return { code, exits, line: JSON.parse(output) as Record<string, unknown> };
  }

  /** Writes a cut-over version and a catalogue whose one browser scenario covers every committed carried action. */
  async function writeInputs(
    extraEntries: CutoverEntry[] = [],
  ): Promise<{ version: string; catalogue: string; carried: string[] }> {
    const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as { controllers: Draft['controllers'] };
    const carried = carriedAdminActions(inventory.controllers);
    const entries: CutoverEntry[] = [
      ...carried.map((route) => ({ route, owningService: 'people', state: 'target' as const, kind: 'read' as const })),
      ...extraEntries,
    ];
    const catalogue = {
      sourceSha: PINNED_SHA,
      scenarios: [
        {
          id: 'GS-UI-01',
          title: 'Carried admin screens',
          service: 'strategies-content',
          role: 'admin',
          sessions: { admin: { login: 'admin', via: 'admin' } },
          steps: [],
          compare: ['dom'],
          covers: carried,
          browser: { flow: 'site-manager-tree', console: 'no-new-errors' },
        },
      ],
    };
    const files = { version: path.join(dir, 'v0002.json'), catalogue: path.join(dir, 'catalogue.yaml') };
    await writeFile(files.version, JSON.stringify({ tableVersion: 'v0002', entries }), 'utf8');
    await writeFile(files.catalogue, JSON.stringify(catalogue), 'utf8');
    return { ...files, carried };
  }

  function reportPath(): string {
    return path.join(dir, 'state', 'golden', 'coverage.json');
  }

  async function report(): Promise<{ findings: CoverageFinding[]; counts: Record<string, unknown> }> {
    return JSON.parse(await readFile(reportPath(), 'utf8')) as {
      findings: CoverageFinding[];
      counts: Record<string, unknown>;
    };
  }

  it('exits 0 and writes an empty findings report when the inputs are fully covered', async () => {
    const { version, catalogue, carried } = await writeInputs();
    expect(carried.length).toBeGreaterThan(0);
    const run = await cli(['--version', version, '--catalogue', catalogue]);
    expect(run.code).toBe(0);
    expect(run.exits).toEqual([0]);
    expect(run.line).toMatchObject({ command: 'golden:coverage', ok: true, code: 0, findings: 0 });
    expect(await report()).toEqual({
      findings: [],
      counts: {
        scenarios: 1,
        covers: carried.length,
        targetEntries: carried.length,
        legacyWriteEntries: 0,
        carriedAdminActions: carried.length,
        findings: countByKind([]),
      },
    });
    expect(stderr()).toEqual([]);
  });

  it('exits 1, reports each finding on stderr and records it in the report', async () => {
    const extra: CutoverEntry = {
      route: 'api:content.findone',
      owningService: 'strategies-content',
      state: 'target',
      kind: 'read',
    };
    const { version, catalogue } = await writeInputs([extra]);
    const run = await cli([`--version=${version}`, `--catalogue=${catalogue}`]);
    const finding = { kind: 'uncovered-target', route: extra.route, owningService: extra.owningService };
    expect(run.code).toBe(1);
    expect(run.line).toMatchObject({
      ok: false,
      code: 1,
      findings: 1,
      byKind: { ...countByKind([]), 'uncovered-target': 1 },
    });
    expect((await report()).findings).toEqual([finding]);
    expect(stderr()).toEqual(['uncovered-target api:content.findone strategies-content\n']);
  });

  it('reads the reserved identities from --seed-config', async () => {
    const { version } = await writeInputs();
    const run = await cli(['--version', version, '--catalogue', MISUSE_CATALOGUE, '--seed-config', SAMPLE_SEED_CONFIG]);
    expect(run.code).toBe(1);
    expect((await report()).findings).toContainEqual({
      kind: 'reserved-identity',
      scenario: 'GS-PE-02',
      value: samplePerson(2),
    });
    expect(stderr()).toContain(`reserved-identity GS-PE-02 ${samplePerson(2)}\n`);
  });

  it.each([
    [['--version']],
    [['--catalogue']],
    [['--seed-config']],
    [['--version=']],
    [['--catalogue=']],
    [['--seed-config=']],
    [['--inventory', 'x.json']],
  ])(
    'exits 2 with the usage text and writes no report for %j',
    async (argv) => {
      const run = await cli(argv);
      expect(run.code).toBe(2);
      expect(run.line).toMatchObject({ ok: false, code: 2, error: { type: 'UsageError' } });
      expect(String(run.line.usage)).toMatch(/^usage: tsx src\/golden\/coverage\.ts /);
      await expect(readFile(reportPath(), 'utf8')).rejects.toThrow(/ENOENT/);
    },
  );
});
