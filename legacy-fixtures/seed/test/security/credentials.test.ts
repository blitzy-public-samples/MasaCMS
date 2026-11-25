// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { loadConfig, SITE_ORDER, type SeedConfig } from '../../src/config.js';
import { generateCredentials, readCredentials, writeCredentials, type SeedCredentials } from '../../src/credentials.js';
import { buildDataset, type Dataset } from '../../src/dataset.js';
import { printableMessage } from '../../src/errors.js';
import { indexMasa, type MasaIndex, type UserRow } from '../../src/masa.js';

const CONFIG_PATH = fileURLToPath(new URL('../../seed.config.json', import.meta.url));
const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const PASSWORD = /^[A-Za-z0-9_-]{24}a1A$/;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{43}$/;
const ROLE_SUBJECTS = ['site-admin', 'system-user'] as const;
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString'];
const SENTINEL = 'zelda.sentinel';

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

/** Every secret in `creds` by its place, `users/<site>/<username>`, `oauthClients/<clientID>` or `generated/<name>`, in generation order. */
function secretsOf(creds: SeedCredentials): Map<string, string> {
  const places = (prefix: string, record: Record<string, string>): [string, string][] =>
    Object.entries(record).map(([key, value]) => [`${prefix}/${key}`, value]);
  return new Map([
    ...Object.entries(creds.users).flatMap(([siteID, users]) => places(`users/${siteID}`, users)),
    ...places('oauthClients', creds.oauthClients),
    ...places('generated', creds.generated),
  ]);
}

/** The first `n` keys of `record`. */
function firstKeys(record: Record<string, unknown> | undefined, n: number): string[] {
  return Object.keys(record ?? {}).slice(0, n);
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

  it('keeps every secret previous holds without drawing any', () => {
    const previous = generateCredentials(dataset, config);
    const sizes: number[] = [];
    expect(generateCredentials(dataset, config, { randomBytes: counterBytes(sizes), previous })).toEqual(previous);
    expect(sizes).toEqual([]);
  });

  it.each<[string, (previous: SeedCredentials) => void]>([
    [
      'some usernames of two sites',
      (previous) => {
        for (const siteID of ['tenant-a', 'umbrella']) {
          for (const username of firstKeys(previous.users[siteID], 2)) delete previous.users[siteID]?.[username];
        }
      },
    ],
    ['every user of a site', (previous) => void delete previous.users['tenant-b']],
    [
      'a username held under another site',
      (previous) => {
        const [username = ''] = firstKeys(previous.users['tenant-a'], 1);
        previous.users['tenant-b'] = { ...previous.users['tenant-b'], [username]: previous.users['tenant-a']?.[username] ?? '' };
        delete previous.users['tenant-a']?.[username];
      },
    ],
    ['an OAuth client', (previous) => void delete previous.oauthClients[firstKeys(previous.oauthClients, 1)[0] ?? '']],
    ['a scenario password', (previous) => void delete previous.generated[firstKeys(previous.generated, 1)[0] ?? '']],
  ])('draws fresh secrets only for what previous lacks: %s', (_label, drop) => {
    const full = generateCredentials(dataset, config);
    const expected = secretsOf(full);
    const previous = structuredClone(full);
    drop(previous);
    const held = secretsOf(previous);
    const missing = [...expected.keys()].filter((place) => !held.has(place));
    expect(missing.length).toBeGreaterThan(0);
    const sizes: number[] = [];
    const creds = generateCredentials(dataset, config, { randomBytes: counterBytes(sizes), previous });
    expect(creds.roles).toEqual(full.roles);
    const issued = secretsOf(creds);
    expect([...issued.keys()]).toEqual([...expected.keys()]);
    for (const [place, value] of issued) {
      if (missing.includes(place)) {
        expect(value, place).toMatch(place.startsWith('oauthClients/') ? CLIENT_SECRET : PASSWORD);
        expect(value, place).not.toBe(expected.get(place));
      } else {
        expect(value, place).toBe(expected.get(place));
      }
    }
    expect(sizes).toEqual(missing.map((place) => (place.startsWith('oauthClients/') ? 32 : 18)));
  });

  it.each([
    ['holds none of them', [] as string[]],
    ['holds them all', PROTOTYPE_KEYS],
  ])('keys scenario passwords named like Object.prototype members by own name only when previous %s', (_label, held) => {
    const withNames = { ...config, scenarioPasswords: PROTOTYPE_KEYS };
    const previous = generateCredentials(dataset, { ...config, scenarioPasswords: held });
    const creds = generateCredentials(dataset, withNames, { randomBytes: counterBytes(), previous });
    expect(Object.keys(creds.generated)).toEqual(PROTOTYPE_KEYS);
    for (const name of PROTOTYPE_KEYS) {
      expect(creds.generated[name], name).toMatch(PASSWORD);
      expect(creds.generated[name] === previous.generated[name], name).toBe(held.includes(name));
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

  it('writes only the output copy without a state directory', async () => {
    const root = await tempDir();
    const outDir = join(root, 'out');
    const creds = generateCredentials(dataset, config, { randomBytes: counterBytes() });
    await writeCredentials(outDir, undefined, creds);
    expect([await readdir(root), await readdir(outDir)]).toEqual([['out'], ['credentials.json']]);
    expect(await readFile(join(outDir, 'credentials.json'), 'utf8')).toBe(`${JSON.stringify(creds, null, 2)}\n`);
    expect(await modeOf(join(outDir, 'credentials.json'))).toBe(0o600);
  });
});

describe('readCredentials', () => {
  it.each([
    ['a missing state directory', 'absent'],
    ['a state directory without secrets/', ''],
  ])('gives undefined for %s', async (_label, sub) => {
    const root = await tempDir();
    expect(await readCredentials(join(root, sub))).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it('rethrows a read failure other than a missing file', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'secrets', 'seed-credentials.json'), { recursive: true });
    await expect(readCredentials(root)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('reads back what writeCredentials wrote, scenario names like Object.prototype members included', async () => {
    const root = await tempDir();
    const withNames = { ...config, scenarioPasswords: PROTOTYPE_KEYS };
    const creds = generateCredentials(dataset, withNames);
    await writeCredentials(join(root, 'out'), root, creds);
    const read = await readCredentials(root);
    expect(read).toEqual(creds);
    expect(Object.keys(read?.generated ?? {})).toEqual(PROTOTYPE_KEYS);
    const sizes: number[] = [];
    expect(generateCredentials(dataset, withNames, { randomBytes: counterBytes(sizes), previous: read })).toEqual(creds);
    expect(sizes).toEqual([]);
  });

  const valid = (): SeedCredentials => generateCredentials(dataset, config, { randomBytes: counterBytes() });
  it.each<[string, () => string, string]>([
    ['text that is not JSON', () => `{"users": ${SENTINEL}`, 'is not valid JSON'],
    ['JSON broken after a value', () => `{"users": {"tenant-a": {"${SENTINEL}": "x"} x`, 'is not valid JSON at line 1 column 48'],
    ['JSON that is not an object', () => JSON.stringify([SENTINEL]), 'does not hold seed credentials'],
    ['credentials without users', () => JSON.stringify({ ...valid(), users: undefined, sourceSha: SENTINEL }), 'does not hold seed credentials'],
    ['users given as an array', () => JSON.stringify({ ...valid(), users: [{ [SENTINEL]: 'x' }] }), 'does not hold seed credentials'],
    ['a password that is not text', () => JSON.stringify({ ...valid(), users: { 'tenant-a': { [SENTINEL]: 7 } } }), 'does not hold seed credentials'],
    ['an empty client secret', () => JSON.stringify({ ...valid(), oauthClients: { [SENTINEL]: '' } }), 'does not hold seed credentials'],
    ['a scenario password named __proto__ that is not text', () => `{"sourceSha":"","digest":"","users":{},"roles":{},"oauthClients":{},"generated":{"__proto__":{"${SENTINEL}":1}}}`, 'does not hold seed credentials'],
  ])('rejects %s, naming the file and never its content', async (_label, text, message) => {
    const root = await tempDir();
    await mkdir(join(root, 'secrets'));
    const file = join(root, 'secrets', 'seed-credentials.json');
    await writeFile(file, text());
    const err = await readCredentials(root).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(printableMessage(err)).toBe(`${file} ${message}`);
  });
});
