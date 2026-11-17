// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Roles, SYNTHETIC_ROLES } from '@opt2/platform/auth';
import { z } from '@opt2/platform/service-kit';
import { SITE_ORDER, type SeedConfig } from './config.js';
import type { Dataset } from './dataset.js';
import { parseJson, printable } from './errors.js';
import { indexMasa } from './masa.js';

/** Secrets of the seeded accounts, bound to their dataset by `digest`. */
export interface SeedCredentials {
  sourceSha: string;
  digest: string;
  /** Password per username, keyed by the site that stores the user. */
  users: Record<string, Record<string, string>>;
  /** Username per authorisation-matrix role, keyed by site. */
  roles: Record<string, Record<string, string>>;
  /** Client secret per OAuth `clientID`. */
  oauthClients: Record<string, string>;
  /** Password per `scenarioPasswords` name, for accounts golden scenarios create. */
  generated: Record<string, string>;
}

const PASSWORD_BYTES = 18;
// Guarantees a digit, a lower-case and an upper-case letter whatever the random part holds.
const PASSWORD_SUFFIX = 'a1A';
// 43 base64url characters, within `toauthclients.clientsecret varchar(100)`.
const CLIENT_SECRET_BYTES = 32;
const ROLE_SUBJECTS: readonly string[] = Object.freeze([...SYNTHETIC_ROLES, Roles.siteAdmin, Roles.systemUser]);
const STATE_FILE = 'seed-credentials.json';

/** Schema of a JSON object of name to `value`, read through a Map so a name such as `__proto__`, which `z.record` drops, is kept. */
function recordOf<T extends z.ZodType>(value: T) {
  return z
    .preprocess((raw) => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? new Map(Object.entries(raw)) : raw), z.map(z.string(), value))
    .transform((map) => Object.fromEntries(map));
}

const secret = z.string().min(1);
const credentialsSchema = z.object({
  sourceSha: z.string(),
  digest: z.string(),
  users: recordOf(recordOf(secret)),
  roles: recordOf(recordOf(z.string())),
  oauthClients: recordOf(secret),
  generated: recordOf(secret),
});

/** `record[key]` when `record` holds `key` as its own property, otherwise undefined. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Credentials for every seeded user, OAuth client and scenario password, keeping each secret `deps.previous` holds under the same site and username, client ID or name and drawing the rest at random; role subjects for sites with system users, a member subject for sites that store members. */
export function generateCredentials(
  dataset: Dataset,
  config: SeedConfig,
  deps: { randomBytes?: (n: number) => Buffer; previous?: SeedCredentials } = {},
): SeedCredentials {
  const random = deps.randomBytes ?? randomBytes;
  const password = (): string => `${random(PASSWORD_BYTES).toString('base64url')}${PASSWORD_SUFFIX}`;
  const { previous } = deps;
  const { masa } = dataset;

  const users: Record<string, Record<string, string>> = {};
  for (const row of masa.users) {
    const site = (users[row.siteID] ??= {});
    if (Object.hasOwn(site, row.username)) throw new RangeError(`Duplicate seeded username ${row.username} in site ${row.siteID}`);
    site[row.username] = own(own(previous?.users, row.siteID), row.username) ?? password();
  }

  const index = indexMasa(masa, config);
  const roles: Record<string, Record<string, string>> = {};
  for (const siteID of SITE_ORDER) {
    const subjects: Record<string, string> = {};
    if (config.sites[siteID].counts.systemUsers > 0) {
      for (const role of ROLE_SUBJECTS) subjects[role] = index.roleUser(siteID, role).username;
    }
    if (index.members(siteID).length > 0) subjects[Roles.member] = index.memberUser(siteID).username;
    if (Object.keys(subjects).length > 0) roles[siteID] = subjects;
  }

  const oauthClients: Record<string, string> = {};
  for (const row of masa.oauthClients) {
    oauthClients[row.clientID] = own(previous?.oauthClients, row.clientID) ?? random(CLIENT_SECRET_BYTES).toString('base64url');
  }

  const generated: Record<string, string> = Object.fromEntries(
    config.scenarioPasswords.map((name) => [name, own(previous?.generated, name) ?? password()]),
  );

  return { sourceSha: dataset.sourceSha, digest: dataset.digest, users, roles, oauthClients, generated };
}

/** Credentials in `<stateDir>/secrets/seed-credentials.json`, or undefined when there is no such file; throws naming the file, never its content, when it does not hold seed credentials. */
export async function readCredentials(stateDir: string): Promise<SeedCredentials | undefined> {
  const file = join(stateDir, 'secrets', STATE_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = credentialsSchema.safeParse(parseJson(text, file));
  if (!parsed.success) throw printable(new TypeError(`${file} does not hold seed credentials`));
  return parsed.data;
}

/** Writes `creds` to `<outDir>/credentials.json` and, given `stateDir`, to `<stateDir>/secrets/seed-credentials.json`, owner-only (files 0600, `secrets/` 0700). */
export async function writeCredentials(outDir: string, stateDir: string | undefined, creds: SeedCredentials): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const paths = [join(outDir, 'credentials.json')];
  if (stateDir !== undefined) {
    const secrets = join(stateDir, 'secrets');
    await mkdir(secrets, { recursive: true, mode: 0o700 });
    await chmod(secrets, 0o700);
    paths.push(join(secrets, STATE_FILE));
  }
  const text = `${JSON.stringify(creds, null, 2)}\n`;
  // `mode` applies only when the file is created, so an existing file is tightened explicitly.
  for (const path of paths) {
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600);
  }
}
