// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_ROLES } from '@opt2/platform/auth';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { loadConfig, SITE_ORDER, type SeedConfig } from '../src/config.js';
import { generateCredentials, writeCredentials, type SeedCredentials } from '../src/credentials.js';
import { buildDataset, type Dataset } from '../src/dataset.js';
import { indexMasa, type MasaIndex, type UserRow } from '../src/masa.js';

const CONFIG_PATH = fileURLToPath(new URL('../seed.config.json', import.meta.url));
const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const PASSWORD = /^[A-Za-z0-9_-]{24}a1A$/;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{43}$/;
const ROLE_SUBJECTS = [...SYNTHETIC_ROLES, 'site-admin', 'system-user'];

let config: SeedConfig;
let dataset: Dataset;
let index: MasaIndex;

/** Deterministic `randomBytes` that records each requested size; every call returns a distinct counter value. */
function counterBytes(sizes: number[] = []): (n: number) => Buffer {
  let calls = 0;
  return (n) => {
    sizes.push(n);
    calls += 1;
    const out = Buffer.alloc(n);
    out.writeUInt32BE(calls, 0);
    return out;
  };
}

function passwordOf(creds: SeedCredentials, user: UserRow): string | undefined {
  return creds.users[user.siteID]?.[user.username];
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-credentials-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

beforeAll(async () => {
  config = await loadConfig(CONFIG_PATH);
  dataset = buildDataset(config, SHA);
  index = indexMasa(dataset.masa, config);
});

describe('generateCredentials', () => {
  it('binds the credentials to the dataset', () => {
    const creds = generateCredentials(dataset, config, { randomBytes: counterBytes() });
    expect(Object.keys(creds)).toEqual(['sourceSha', 'digest', 'users', 'roles', 'oauthClients', 'generated']);
    expect([creds.sourceSha, creds.digest]).toEqual([dataset.sourceSha, dataset.digest]);
  });

  it('gives every seeded user a password under the site that stores it, in dataset order', () => {
    const sizes: number[] = [];
    const creds = generateCredentials(dataset, config, { randomBytes: counterBytes(sizes) });
    const { users } = dataset.masa;
    expect(Object.keys(creds.users)).toEqual([...new Set(users.map((row) => row.siteID))]);
    expect(Object.values(creds.users).flatMap((site) => Object.keys(site))).toEqual(users.map((row) => row.username));
    for (const user of users) expect(passwordOf(creds, user)).toMatch(PASSWORD);
    expect(new Set(Object.values(creds.users).flatMap((site) => Object.values(site))).size).toBe(users.length);
    expect(sizes).toEqual([
      ...users.map(() => 18),
      ...dataset.masa.oauthClients.map(() => 32),
      ...config.scenarioPasswords.map(() => 18),
    ]);
  });

  it.each<[string, () => readonly string[]]>([
    ['the committed scenarioPasswords', () => config.scenarioPasswords],
    ['no scenarioPasswords', () => []],
    ['names that are Object.prototype keys', () => ['__proto__', 'constructor', 'toString']],
  ])('gives each of %s its own password in the seeded-user form', (_label, names) => {
    const scenarioPasswords = names();
    const creds = generateCredentials(dataset, { ...config, scenarioPasswords }, { randomBytes: counterBytes() });
    expect(Object.keys(creds.generated)).toEqual(scenarioPasswords);
    for (const name of scenarioPasswords) {
      expect(Object.hasOwn(creds.generated, name)).toBe(true);
      expect(creds.generated[name]).toMatch(PASSWORD);
    }
    const userPasswords = new Set(Object.values(creds.users).flatMap((site) => Object.values(site)));
    expect(new Set(Object.values(creds.generated)).size).toBe(scenarioPasswords.length);
    expect(Object.values(creds.generated).filter((value) => userPasswords.has(value))).toEqual([]);
  });

  it('names each authorisation-matrix subject by a user of the right site', () => {
    const creds = generateCredentials(dataset, config, { randomBytes: counterBytes() });
    expect(Object.keys(creds.roles)).toEqual(SITE_ORDER);
    expect(Object.keys(creds.roles['tenant-a'] ?? {})).toEqual(ROLE_SUBJECTS);
    expect(Object.keys(creds.roles['tenant-b'] ?? {})).toEqual([...ROLE_SUBJECTS, 'member']);
    expect(Object.keys(creds.roles.umbrella ?? {})).toEqual(['member']);
    for (const site of ['tenant-a', 'tenant-b'] as const) {
      const pool = index.site(site).privateUserPoolID;
      for (const role of ROLE_SUBJECTS) {
        const username = creds.roles[site]?.[role];
        expect(username).toBe(index.roleUser(site, role).username);
        expect(creds.users[pool]?.[username as string]).toMatch(PASSWORD);
      }
    }
    for (const site of ['tenant-b', 'umbrella'] as const) {
      const username = creds.roles[site]?.member;
      expect(username).toBe(index.memberUser(site).username);
      expect(creds.users[site]?.[username as string]).toMatch(PASSWORD);
    }
  });

  it.each([
    ['tenant-b', ['umbrella', 'tenant-a', 'tenant-b']],
    ['umbrella', ['tenant-a', 'tenant-b']],
  ] as const)('omits the member subject when %s stores no members, and a site left without subjects', (site, sites) => {
    const users = dataset.masa.users.filter((row) => !(row.siteID === site && row.isPublic === 1));
    const creds = generateCredentials({ ...dataset, masa: { ...dataset.masa, users } }, config, { randomBytes: counterBytes() });
    expect(Object.keys(creds.roles)).toEqual(sites);
    expect(creds.roles[site]?.member).toBeUndefined();
    expect(Object.keys(creds.roles['tenant-b'] ?? {})).toEqual(site === 'tenant-b' ? ROLE_SUBJECTS : [...ROLE_SUBJECTS, 'member']);
  });

  it('gives every OAuth client a base64url secret that fits clientsecret varchar(100)', () => {
    const creds = generateCredentials(dataset, config, { randomBytes: counterBytes() });
    expect(dataset.masa.oauthClients.length).toBeGreaterThan(0);
    expect(Object.keys(creds.oauthClients)).toEqual(dataset.masa.oauthClients.map((row) => row.clientID));
    for (const secret of Object.values(creds.oauthClients)) {
      expect(secret).toMatch(CLIENT_SECRET);
      expect(secret.length).toBeLessThanOrEqual(100);
    }
  });

  it('is deterministic for a deterministic randomBytes', () => {
    const first = generateCredentials(dataset, config, { randomBytes: counterBytes() });
    expect(generateCredentials(dataset, config, { randomBytes: counterBytes() })).toEqual(first);
  });

  it('draws different secrets on each real run', () => {
    const first = generateCredentials(dataset, config);
    const second = generateCredentials(dataset, config);
    expect(second.roles).toEqual(first.roles);
    for (const user of dataset.masa.users) {
      expect(passwordOf(first, user)).toMatch(PASSWORD);
      expect(passwordOf(second, user)).not.toBe(passwordOf(first, user));
    }
    for (const [clientID, secret] of Object.entries(first.oauthClients)) expect(second.oauthClients[clientID]).not.toBe(secret);
    expect(Object.keys(first.generated)).toEqual(config.scenarioPasswords);
    for (const [name, value] of Object.entries(first.generated)) {
      expect(value).toMatch(PASSWORD);
      expect(second.generated[name]).not.toBe(value);
    }
  });

  it('rejects a username listed twice in one site', () => {
    const [user] = dataset.masa.users;
    if (user === undefined) throw new Error('dataset has no users');
    const users = [...dataset.masa.users, { ...user, userID: 'DUPLICATE' }];
    expect(() => generateCredentials({ ...dataset, masa: { ...dataset.masa, users } }, config)).toThrow(
      new RangeError(`Duplicate seeded username ${user.username} in site ${user.siteID}`),
    );
  });
});

describe('writeCredentials', () => {
  it('writes both copies owner-only', async () => {
    const root = await tempDir();
    const outDir = join(root, 'state', 'seed');
    const stateDir = join(root, 'state');
    const creds = generateCredentials(dataset, config, { randomBytes: counterBytes() });
    await writeCredentials(outDir, stateDir, creds);
    const expected = `${JSON.stringify(creds, null, 2)}\n`;
    for (const path of [join(outDir, 'credentials.json'), join(stateDir, 'secrets', 'seed-credentials.json')]) {
      expect(await readFile(path, 'utf8')).toBe(expected);
      expect(await modeOf(path)).toBe(0o600);
    }
    expect(await modeOf(join(stateDir, 'secrets'))).toBe(0o700);
    expect(JSON.parse(await readFile(join(outDir, 'credentials.json'), 'utf8'))).toEqual(creds);
  });

  it('replaces earlier files and tightens their modes', async () => {
    const root = await tempDir();
    const outDir = join(root, 'out');
    const secrets = join(root, 'secrets');
    await mkdir(outDir);
    await mkdir(secrets);
    await chmod(secrets, 0o755);
    for (const path of [join(outDir, 'credentials.json'), join(secrets, 'seed-credentials.json')]) {
      await writeFile(path, 'stale\n');
      await chmod(path, 0o644);
    }
    const creds = generateCredentials(dataset, config);
    await writeCredentials(outDir, root, creds);
    for (const path of [join(outDir, 'credentials.json'), join(secrets, 'seed-credentials.json')]) {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(creds);
      expect(await modeOf(path)).toBe(0o600);
    }
    expect(await modeOf(secrets)).toBe(0o700);
  });
});
