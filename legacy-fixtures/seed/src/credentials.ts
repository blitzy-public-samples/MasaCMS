// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Roles, SYNTHETIC_ROLES } from '@opt2/platform/auth';
import { SITE_ORDER, type SeedConfig } from './config.js';
import type { Dataset } from './dataset.js';
import { indexMasa } from './masa.js';

/** Per-run secrets of the seeded accounts, bound to their dataset by `digest`. */
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

/** Fresh random credentials for every seeded user, OAuth client and scenario password; role subjects for sites with system users, a member subject for sites that store members. */
export function generateCredentials(
  dataset: Dataset,
  config: SeedConfig,
  deps: { randomBytes?: (n: number) => Buffer } = {},
): SeedCredentials {
  const random = deps.randomBytes ?? randomBytes;
  const password = (): string => `${random(PASSWORD_BYTES).toString('base64url')}${PASSWORD_SUFFIX}`;
  const { masa } = dataset;

  const users: Record<string, Record<string, string>> = {};
  for (const row of masa.users) {
    const site = (users[row.siteID] ??= {});
    if (Object.hasOwn(site, row.username)) throw new RangeError(`Duplicate seeded username ${row.username} in site ${row.siteID}`);
    site[row.username] = password();
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
  for (const row of masa.oauthClients) oauthClients[row.clientID] = random(CLIENT_SECRET_BYTES).toString('base64url');

  const generated: Record<string, string> = Object.fromEntries(config.scenarioPasswords.map((name) => [name, password()]));

  return { sourceSha: dataset.sourceSha, digest: dataset.digest, users, roles, oauthClients, generated };
}

/** Writes `creds` to `<outDir>/credentials.json` and `<stateDir>/secrets/seed-credentials.json`, owner-only (files 0600, `secrets/` 0700). */
export async function writeCredentials(outDir: string, stateDir: string, creds: SeedCredentials): Promise<void> {
  const secrets = join(stateDir, 'secrets');
  await mkdir(outDir, { recursive: true });
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await chmod(secrets, 0o700);
  const text = `${JSON.stringify(creds, null, 2)}\n`;
  // `mode` applies only when the file is created, so an existing file is tightened explicitly.
  for (const path of [join(outDir, 'credentials.json'), join(secrets, 'seed-credentials.json')]) {
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600);
  }
}
