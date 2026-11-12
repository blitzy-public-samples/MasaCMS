// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_ROLES } from '@opt2/platform/auth';
import { z } from '@opt2/platform/service-kit';
import {
  SITE_ORDER,
  loadConfig,
  parseConfig,
  programIdForSite,
  roleGroupName,
  seedConfigSchema,
  siteForProgram,
  type SeedConfig,
} from '../src/config.js';

const CONFIG_PATH = fileURLToPath(new URL('../seed.config.json', import.meta.url));
const ROLE_MAP_PATH = fileURLToPath(new URL('../../../services/identity/config/role-map.json', import.meta.url));

type Json = Record<string, any>;

let raw: Json;
let config: SeedConfig;

beforeAll(async () => {
  raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Json;
  config = await loadConfig(CONFIG_PATH);
});

function mutated(edit: (value: Json) => void): Json {
  const copy = structuredClone(raw);
  edit(copy);
  return copy;
}

function issuesOf(value: unknown): string[] {
  try {
    parseConfig(value);
  } catch (error) {
    expect(error).toBeInstanceOf(z.ZodError);
    return (error as z.ZodError).issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  }
  throw new Error('expected parseConfig to reject the value');
}

describe('loadConfig on the committed seed.config.json', () => {
  it('returns the top-level settings and drops $comment', () => {
    expect(config).toMatchObject({
      seed: 20260601,
      businessDate: '2026-06-30',
      chunkRows: 1000,
      historyDays: 120,
      emailDomain: 'seed.opt2.test',
    });
    expect(config).not.toHaveProperty('$comment');
  });

  it('returns the three sites in generation order with their program ids and pools', () => {
    expect(Object.keys(config.sites)).toEqual([...SITE_ORDER]);
    expect(SITE_ORDER.map((site) => [config.sites[site].siteID, config.sites[site].site, config.sites[site].programId])).toEqual([
      ['umbrella', 'Umbrella', null],
      ['tenant-a', 'Tenant A', 1],
      ['tenant-b', 'Tenant B', 2],
    ]);
    expect(config.sites['tenant-a'].pools).toEqual({
      publicUserPoolID: 'umbrella',
      categoryPoolID: 'umbrella',
      filePoolID: 'umbrella',
      displayPoolID: 'umbrella',
    });
    expect(config.sites.umbrella.pools).toEqual({});
    expect(config.sites['tenant-b'].pools).toEqual({});
  });

  it('resolves every count from the file, then the site default, then 0', () => {
    expect(config.sites.umbrella.counts).toEqual({
      members: 1000, systemUsers: 0, groups: 0, categories: 100, files: 20, contentNodes: 0, maxVersionsPerNode: 0,
      timesheetDays: 0, daysPerTimesheet: 0, timesheetEmployees: 0, financeRecords: 0, financeAttachments: 0,
      surveys: 0, surveyResponses: 0, multiSiteResponses: 0, exportDefinitions: 0, exportJobs: 0,
      messageTemplates: 0, messages: 0, signatureRequests: 0, oauthClients: 0,
    });
    expect(config.sites['tenant-a'].counts).toEqual({
      members: 0, systemUsers: 2000, groups: 50, categories: 0, files: 0, contentNodes: 5000, maxVersionsPerNode: 3,
      timesheetDays: 20000, daysPerTimesheet: 20, timesheetEmployees: 100, financeRecords: 3000, financeAttachments: 300,
      surveys: 20, surveyResponses: 500, multiSiteResponses: 50, exportDefinitions: 5, exportJobs: 200,
      messageTemplates: 10, messages: 200, signatureRequests: 50, oauthClients: 1,
    });
    expect(config.sites['tenant-b'].counts).toEqual({
      members: 20, systemUsers: 180, groups: 10, categories: 10, files: 0, contentNodes: 300, maxVersionsPerNode: 3,
      timesheetDays: 2000, daysPerTimesheet: 20, timesheetEmployees: 20, financeRecords: 300, financeAttachments: 30,
      surveys: 2, surveyResponses: 20, multiSiteResponses: 0, exportDefinitions: 2, exportJobs: 10,
      messageTemplates: 3, messages: 20, signatureRequests: 5, oauthClients: 0,
    });
  });

  it('applies the site defaults where the file omits a count', () => {
    const parsed = parseConfig(mutated((value) => {
      value.sites['tenant-a'].counts = {};
      value.sites['tenant-b'].counts = { surveys: 7 };
      value.sites.umbrella.counts = {};
    }));
    expect(parsed.sites['tenant-a'].counts).toMatchObject({ systemUsers: 2000, surveys: 40, signatureRequests: 100, oauthClients: 0 });
    expect(parsed.sites['tenant-b'].counts).toMatchObject({ systemUsers: 180, surveys: 7, surveyResponses: 0, signatureRequests: 10 });
    expect(parsed.sites.umbrella.counts).toMatchObject({ members: 1000, categories: 100, files: 20 });
  });

  it('returns the 10 reserved rehearsal persons and usernames of tenant-a', () => {
    const { rehearsal } = config.reserved;
    expect(rehearsal.site).toBe('tenant-a');
    expect(rehearsal.persons).toEqual(raw.reserved.rehearsal.persons);
    expect(rehearsal.persons).toHaveLength(10);
    expect(rehearsal.usernames).toEqual(Array.from({ length: 10 }, (_, i) => `rh-create-${String(i + 1).padStart(2, '0')}`));
  });

  it('maps each synthetic role to the group role-map.json grants it', async () => {
    const roleMap = JSON.parse(await readFile(ROLE_MAP_PATH, 'utf8')) as { groups: { groupName: string; role: string }[] };
    const expected = Object.fromEntries(
      roleMap.groups.filter((group) => SYNTHETIC_ROLES.includes(group.role)).map((group) => [group.role, group.groupName]),
    );
    expect(config.roleGroups).toEqual(expected);
    expect(Object.keys(config.roleGroups)).toEqual([...SYNTHETIC_ROLES]);
    for (const role of SYNTHETIC_ROLES) expect(roleGroupName(config, role)).toBe(expected[role]);
  });

  it('is the output of seedConfigSchema', () => {
    expect(seedConfigSchema.parse(raw)).toEqual(config);
  });

  it('returns the scenario password names, and none when the file omits them', () => {
    expect(config.scenarioPasswords.length).toBeGreaterThan(0);
    expect(config.scenarioPasswords).toEqual(raw.scenarioPasswords);
    expect(parseConfig(mutated((v) => { delete v.scenarioPasswords; })).scenarioPasswords).toEqual([]);
  });
});

describe('parseConfig rejections', () => {
  it.each<[string, (value: Json) => void, string]>([
    ['a reserved person that is not a CF UUID', (v) => { v.reserved.rehearsal.persons[0] = '9678B200EEB15DDCDEB98A399FCE1AA4'; }, 'reserved.rehearsal.persons.0'],
    ['nine reserved persons', (v) => { v.reserved.rehearsal.persons.pop(); }, 'reserved.rehearsal.persons'],
    ['a duplicated reserved person', (v) => { v.reserved.rehearsal.persons[1] = v.reserved.rehearsal.persons[0]; }, 'reserved.rehearsal.persons'],
    ['a reserve outside tenant-a', (v) => { v.reserved.rehearsal.site = 'tenant-b'; }, 'reserved.rehearsal.site'],
    ['an upper-case reserved username', (v) => { v.reserved.rehearsal.usernames[0] = 'RH-create-01'; }, 'reserved.rehearsal.usernames.0'],
    ['a non-ASCII reserved username', (v) => { v.reserved.rehearsal.usernames[0] = 'rh-créate-01'; }, 'reserved.rehearsal.usernames.0'],
    ['the installed admin username', (v) => { v.reserved.rehearsal.usernames[2] = 'admin'; }, 'reserved.rehearsal.usernames.2'],
    ['the installed qa_editor username', (v) => { v.reserved.rehearsal.usernames[3] = 'qa_editor'; }, 'reserved.rehearsal.usernames.3'],
    ['a duplicated reserved username', (v) => { v.reserved.rehearsal.usernames[1] = 'rh-create-01'; }, 'reserved.rehearsal.usernames'],
    ['an unknown role group', (v) => { v.roleGroups[3] = 'timesheets.bogus'; }, 'roleGroups.3'],
    ['a missing role group', (v) => { v.roleGroups.pop(); }, 'roleGroups'],
    ['a duplicated role group', (v) => { v.roleGroups.push('finance.approver'); }, 'roleGroups'],
    ['programId 3 for tenant-a', (v) => { v.sites['tenant-a'].programId = 3; }, 'sites.tenant-a.programId'],
    ['programId 1 for tenant-b', (v) => { v.sites['tenant-b'].programId = 1; }, 'sites.tenant-b.programId'],
    ['a programId for umbrella', (v) => { v.sites.umbrella.programId = 1; }, 'sites.umbrella.programId'],
    ['a missing site', (v) => { delete v.sites['tenant-b']; }, 'sites.tenant-b'],
    ['an unknown site', (v) => { v.sites.default = v.sites['tenant-b']; }, 'sites'],
    ['an empty site name', (v) => { v.sites.umbrella.site = ''; }, 'sites.umbrella.site'],
    ['an unknown count', (v) => { v.sites['tenant-a'].counts.timesheetDay = 1; }, 'sites.tenant-a.counts'],
    ['a negative count', (v) => { v.sites['tenant-b'].counts.messages = -1; }, 'sites.tenant-b.counts.messages'],
    ['a fractional count', (v) => { v.sites.umbrella.counts.members = 10.5; }, 'sites.umbrella.counts.members'],
    ['a pool naming an unknown site', (v) => { v.sites['tenant-a'].pools.filePoolID = 'default'; }, 'sites.tenant-a.pools.filePoolID'],
    ['an unknown pool', (v) => { v.sites['tenant-a'].pools.userPoolID = 'umbrella'; }, 'sites.tenant-a.pools'],
    ['a fractional seed', (v) => { v.seed = 1.5; }, 'seed'],
    ['a businessDate without padding', (v) => { v.businessDate = '2026-6-30'; }, 'businessDate'],
    ['a businessDate that is not a calendar day', (v) => { v.businessDate = '2026-02-30'; }, 'businessDate'],
    ['chunkRows 0', (v) => { v.chunkRows = 0; }, 'chunkRows'],
    ['historyDays 0', (v) => { v.historyDays = 0; }, 'historyDays'],
    ['an upper-case emailDomain', (v) => { v.emailDomain = 'Seed.OPT2.test'; }, 'emailDomain'],
    ['an unknown top-level key', (v) => { v.seeds = 1; }, ''],
    ['an empty scenario password name', (v) => { v.scenarioPasswords[1] = ''; }, 'scenarioPasswords.1'],
    ['a scenario password name that is not a string', (v) => { v.scenarioPasswords[0] = 1; }, 'scenarioPasswords.0'],
    ['a duplicated scenario password name', (v) => { v.scenarioPasswords.push(v.scenarioPasswords[0]); }, 'scenarioPasswords'],
    ['scenarioPasswords that is not a list', (v) => { v.scenarioPasswords = 'gs-id-05'; }, 'scenarioPasswords'],
  ])('rejects %s, naming the key', (_name, edit, path) => {
    const issues = issuesOf(mutated(edit));
    expect(issues.some((issue) => issue.startsWith(`${path}: `))).toBe(true);
  });

  it('names the offending value in the message', () => {
    const value = mutated((v) => {
      v.reserved.rehearsal.persons[0] = 'not-a-uuid';
      v.roleGroups[0] = 'timesheets.bogus';
      v.sites['tenant-a'].programId = 3;
    });
    expect(() => parseConfig(value)).toThrow(/programId/);
    expect(issuesOf(value)).toEqual(
      expect.arrayContaining([
        'roleGroups.0: unknown synthetic role group "timesheets.bogus"',
        'reserved.rehearsal.persons.0: not a CF UUID: "not-a-uuid"',
        expect.stringMatching(/^sites\.tenant-a\.programId: /),
      ]),
    );
  });

  it.each([null, [], 'config'])('rejects a non-object value %j', (value) => {
    expect(issuesOf(value).length).toBeGreaterThan(0);
  });
});

describe('loadConfig failures', () => {
  it('propagates a missing file', async () => {
    await expect(loadConfig(fileURLToPath(new URL('../no-such-seed.config.json', import.meta.url)))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each<[string, () => string, ErrorConstructor, string]>([
    ['malformed JSON', () => '{"seed": 20260601,', SyntaxError, 'is not valid JSON at line 1 column 19'],
    [
      'keys the schema rejects',
      () => JSON.stringify({ ...raw, seed: 'abc', chunkRows: 0, seeds: 1 }),
      Error,
      'is not a valid seed configuration: seed: Invalid input: expected number, received string; chunkRows: Too small: expected number to be >0; (top level): Unrecognized key: "seeds"',
    ],
  ])('reports %s naming the file and any rejected key, never the text', async (_label, text, type, message) => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-config-'));
    try {
      const path = join(dir, 'seed.config.json');
      await writeFile(path, text());
      const error = await loadConfig(path).then(() => undefined, (err: unknown) => err);
      expect(error).toBeInstanceOf(type);
      expect((error as Error).message).toBe(`${path} ${message}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('program and role lookups', () => {
  it.each([[1, 'tenant-a'], [2, 'tenant-b']] as const)('siteForProgram(%d) is %s and back', (programId, site) => {
    expect(siteForProgram(config, programId)).toBe(site);
    expect(programIdForSite(config, site)).toBe(programId);
  });

  it('throws for a program no site has', () => {
    expect(() => siteForProgram(config, 3)).toThrow(new RangeError('No seeded site has programId 3'));
  });

  it('throws for the umbrella site, which has no program', () => {
    expect(() => programIdForSite(config, 'umbrella')).toThrow(new RangeError('Site umbrella has no programId'));
  });

  it.each(['s2', 'member', 'constructor', 'toString'])('throws for the non-synthetic role %s', (role) => {
    expect(() => roleGroupName(config, role)).toThrow(new RangeError(`Not a synthetic role: ${role}`));
  });
});
