// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from '@opt2/platform/service-kit';
import { MASA_DEFAULT_PAGE_LIMIT, SITE_ORDER, loadConfig, parseConfig, seedConfigSchema, type SeedConfig, type SiteKey } from '../src/config.js';

const CONFIG_PATH = fileURLToPath(new URL('../seed.config.json', import.meta.url));

type JsonObject = Record<string, unknown>;

let raw: unknown;
let config: SeedConfig;

beforeAll(async () => {
  raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  config = await loadConfig(CONFIG_PATH);
});

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The object at `path` in a parsed JSON `value`, edited in place. */
function objectAt(value: unknown, ...path: string[]): JsonObject {
  const node = path.reduce<unknown>((parent, key) => (isJsonObject(parent) ? parent[key] : undefined), value);
  if (!isJsonObject(node)) throw new TypeError(`no JSON object at ${path.join('.')}`);
  return node;
}

/** The array at `path` in a parsed JSON `value`, edited in place. */
function arrayAt(value: unknown, ...path: string[]): unknown[] {
  const node = objectAt(value, ...path.slice(0, -1))[path.at(-1) ?? ''];
  if (!Array.isArray(node)) throw new TypeError(`no JSON array at ${path.join('.')}`);
  return node;
}

function mutated(edit: (value: unknown) => void): unknown {
  const copy = structuredClone(raw);
  edit(copy);
  return copy;
}

/** Count keys of `site` in the committed file that the parsed configuration does not carry. */
function retiredCounts(site: SiteKey): string[] {
  return Object.keys(objectAt(raw, 'sites', site, 'counts')).filter((key) => !Object.hasOwn(config.sites[site].counts, key));
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

  it('returns the three sites in generation order with their pools', () => {
    expect(Object.keys(config.sites)).toEqual([...SITE_ORDER]);
    expect(SITE_ORDER.map((site) => [config.sites[site].siteID, config.sites[site].site])).toEqual([
      ['umbrella', 'Umbrella'],
      ['tenant-a', 'Tenant A'],
      ['tenant-b', 'Tenant B'],
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

  it('raises the page limit of tenant-a above its content nodes and leaves the other sites at the Masa default', () => {
    expect(SITE_ORDER.map((site) => config.sites[site].pageLimit)).toEqual([null, 10000, null]);
    for (const site of SITE_ORDER) {
      expect(config.sites[site].counts.contentNodes).toBeLessThan(config.sites[site].pageLimit ?? MASA_DEFAULT_PAGE_LIMIT);
    }
  });

  it('resolves every count from the file, then the site default, then 0', () => {
    expect(config.sites.umbrella.counts).toEqual({
      members: 1000, systemUsers: 0, groups: 0, categories: 100, files: 20, contentNodes: 10, maxVersionsPerNode: 3, oauthClients: 0,
    });
    expect(config.sites['tenant-a'].counts).toEqual({
      members: 0, systemUsers: 2000, groups: 50, categories: 0, files: 0, contentNodes: 5000, maxVersionsPerNode: 3, oauthClients: 1,
    });
    expect(config.sites['tenant-b'].counts).toEqual({
      members: 20, systemUsers: 180, groups: 10, categories: 10, files: 0, contentNodes: 300, maxVersionsPerNode: 3, oauthClients: 0,
    });
  });

  it('applies the site defaults where the file omits a count', () => {
    const parsed = parseConfig(mutated((value) => {
      objectAt(value, 'sites', 'tenant-a').counts = {};
      objectAt(value, 'sites', 'tenant-b').counts = { contentNodes: 7 };
      objectAt(value, 'sites', 'umbrella').counts = {};
    }));
    expect(parsed.sites['tenant-a'].counts).toMatchObject({ systemUsers: 2000, groups: 50, contentNodes: 5000, oauthClients: 0 });
    expect(parsed.sites['tenant-b'].counts).toMatchObject({ systemUsers: 180, contentNodes: 7, members: 20, groups: 10 });
    expect(parsed.sites.umbrella.counts).toMatchObject({ members: 1000, categories: 100, files: 20 });
  });

  it('returns the 10 reserved rehearsal persons and usernames of tenant-a', () => {
    const { rehearsal } = config.reserved;
    expect(rehearsal.site).toBe('tenant-a');
    expect(rehearsal.persons).toEqual(arrayAt(raw, 'reserved', 'rehearsal', 'persons'));
    expect(rehearsal.persons).toHaveLength(10);
    expect(rehearsal.usernames).toEqual(Array.from({ length: 10 }, (_, i) => `rh-create-${String(i + 1).padStart(2, '0')}`));
  });

  it('is the output of seedConfigSchema', () => {
    expect(seedConfigSchema.parse(raw)).toEqual(config);
  });

  it.each<[string, (holder: JsonObject, key: string) => void]>([
    ['dropped', (holder, key) => { delete holder[key]; }],
    ['given other values', (holder, key) => { holder[key] = { retired: true }; }],
  ])('parses alike with the retired role groups, program ids and module counts %s', (_label, edit) => {
    expect([Array.isArray(objectAt(raw).roleGroups), objectAt(raw, 'sites', 'tenant-a').programId, SITE_ORDER.flatMap(retiredCounts).length > 0]).toEqual([true, 1, true]);
    const value = mutated((v) => {
      edit(objectAt(v), 'roleGroups');
      for (const site of SITE_ORDER) {
        edit(objectAt(v, 'sites', site), 'programId');
        for (const key of retiredCounts(site)) edit(objectAt(v, 'sites', site, 'counts'), key);
      }
    });
    expect(parseConfig(value)).toEqual(config);
  });

  it('returns the scenario password names, and none when the file omits them', () => {
    expect(config.scenarioPasswords).toEqual(['gs-id-09', 'gs-pe-01', 'gs-pe-rh-01']);
    expect(config.scenarioPasswords.every((name) => arrayAt(raw, 'scenarioPasswords').includes(name))).toBe(true);
    expect(parseConfig(mutated((v) => { delete objectAt(v).scenarioPasswords; })).scenarioPasswords).toEqual([]);
  });
});

describe('parseConfig rejections', () => {
  it.each<[string, (value: unknown) => void, string]>([
    ['a reserved person that is not a CF UUID', (v) => { arrayAt(v, 'reserved', 'rehearsal', 'persons')[0] = '9678B200EEB15DDCDEB98A399FCE1AA4'; }, 'reserved.rehearsal.persons.0'],
    ['nine reserved persons', (v) => { arrayAt(v, 'reserved', 'rehearsal', 'persons').pop(); }, 'reserved.rehearsal.persons'],
    ['a duplicated reserved person', (v) => { const persons = arrayAt(v, 'reserved', 'rehearsal', 'persons'); persons[1] = persons[0]; }, 'reserved.rehearsal.persons'],
    ['a reserve outside tenant-a', (v) => { objectAt(v, 'reserved', 'rehearsal').site = 'tenant-b'; }, 'reserved.rehearsal.site'],
    ['an upper-case reserved username', (v) => { arrayAt(v, 'reserved', 'rehearsal', 'usernames')[0] = 'RH-create-01'; }, 'reserved.rehearsal.usernames.0'],
    ['a non-ASCII reserved username', (v) => { arrayAt(v, 'reserved', 'rehearsal', 'usernames')[0] = 'rh-créate-01'; }, 'reserved.rehearsal.usernames.0'],
    ['the installed admin username', (v) => { arrayAt(v, 'reserved', 'rehearsal', 'usernames')[2] = 'admin'; }, 'reserved.rehearsal.usernames.2'],
    ['the installed qa_editor username', (v) => { arrayAt(v, 'reserved', 'rehearsal', 'usernames')[3] = 'qa_editor'; }, 'reserved.rehearsal.usernames.3'],
    ['a duplicated reserved username', (v) => { arrayAt(v, 'reserved', 'rehearsal', 'usernames')[1] = 'rh-create-01'; }, 'reserved.rehearsal.usernames'],
    ['a missing site', (v) => { delete objectAt(v, 'sites')['tenant-b']; }, 'sites.tenant-b'],
    ['an unknown site', (v) => { const sites = objectAt(v, 'sites'); sites.default = sites['tenant-b']; }, 'sites'],
    ['an empty site name', (v) => { objectAt(v, 'sites', 'umbrella').site = ''; }, 'sites.umbrella.site'],
    ['an unknown count', (v) => { objectAt(v, 'sites', 'tenant-a', 'counts').contentNode = 1; }, 'sites.tenant-a.counts'],
    ['a negative count', (v) => { objectAt(v, 'sites', 'tenant-b', 'counts').members = -1; }, 'sites.tenant-b.counts.members'],
    ['a fractional count', (v) => { objectAt(v, 'sites', 'umbrella', 'counts').members = 10.5; }, 'sites.umbrella.counts.members'],
    ['a pool naming an unknown site', (v) => { objectAt(v, 'sites', 'tenant-a', 'pools').filePoolID = 'default'; }, 'sites.tenant-a.pools.filePoolID'],
    ['an unknown pool', (v) => { objectAt(v, 'sites', 'tenant-a', 'pools').userPoolID = 'umbrella'; }, 'sites.tenant-a.pools'],
    ['a fractional page limit', (v) => { objectAt(v, 'sites', 'tenant-a').pageLimit = 10000.5; }, 'sites.tenant-a.pageLimit'],
    ['page limit 0', (v) => { objectAt(v, 'sites', 'umbrella').pageLimit = 0; }, 'sites.umbrella.pageLimit'],
    ['a page limit beyond a SQL Server int', (v) => { objectAt(v, 'sites', 'tenant-a').pageLimit = 2_147_483_648; }, 'sites.tenant-a.pageLimit'],
    ['a page limit not above the content nodes', (v) => { objectAt(v, 'sites', 'tenant-b').pageLimit = 300; }, 'sites.tenant-b.pageLimit'],
    ['no page limit where the content nodes reach the Masa default', (v) => { delete objectAt(v, 'sites', 'tenant-a').pageLimit; }, 'sites.tenant-a.pageLimit'],
    ['a fractional seed', (v) => { objectAt(v).seed = 1.5; }, 'seed'],
    ['a businessDate without padding', (v) => { objectAt(v).businessDate = '2026-6-30'; }, 'businessDate'],
    ['a businessDate that is not a calendar day', (v) => { objectAt(v).businessDate = '2026-02-30'; }, 'businessDate'],
    ['chunkRows 0', (v) => { objectAt(v).chunkRows = 0; }, 'chunkRows'],
    ['historyDays 0', (v) => { objectAt(v).historyDays = 0; }, 'historyDays'],
    ['an upper-case emailDomain', (v) => { objectAt(v).emailDomain = 'Seed.OPT2.test'; }, 'emailDomain'],
    ['an unknown top-level key', (v) => { objectAt(v).seeds = 1; }, ''],
    ['an empty scenario password name', (v) => { arrayAt(v, 'scenarioPasswords')[1] = ''; }, 'scenarioPasswords.1'],
    ['a scenario password name that is not a string', (v) => { arrayAt(v, 'scenarioPasswords')[0] = 1; }, 'scenarioPasswords.0'],
    ['a duplicated scenario password name', (v) => { const names = arrayAt(v, 'scenarioPasswords'); names.push(names[0]); }, 'scenarioPasswords'],
    ['scenarioPasswords that is not a list', (v) => { objectAt(v).scenarioPasswords = 'gs-id-09'; }, 'scenarioPasswords'],
  ])('rejects %s, naming the key', (_name, edit, path) => {
    const issues = issuesOf(mutated(edit));
    expect(issues.some((issue) => issue.startsWith(`${path}: `))).toBe(true);
  });

  it('names the offending value in the message', () => {
    const value = mutated((v) => {
      arrayAt(v, 'reserved', 'rehearsal', 'persons')[0] = 'not-a-uuid';
      arrayAt(v, 'reserved', 'rehearsal', 'usernames')[2] = 'admin';
    });
    expect(() => parseConfig(value)).toThrow(/not-a-uuid/);
    expect(issuesOf(value)).toEqual(
      expect.arrayContaining([
        'reserved.rehearsal.persons.0: not a CF UUID: "not-a-uuid"',
        'reserved.rehearsal.usernames.2: "admin" is an installed Masa account',
      ]),
    );
  });

  it('names the content nodes a page limit must exceed', () => {
    expect(issuesOf(mutated((v) => { objectAt(v, 'sites', 'tenant-a').pageLimit = 5000; }))).toEqual([
      "sites.tenant-a.pageLimit: must exceed the site's 5000 content nodes (Masa's default is 1000)",
    ]);
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
      () => JSON.stringify({ ...objectAt(raw), seed: 'abc', chunkRows: 0, seeds: 1 }),
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
