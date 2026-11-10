// Port of Masa password hashing and verification (userUtility.cfc:140-173, userDAO.cfc:684-699, utility.cfc:907-925).
import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { cfEq, cfHash } from '@opt2/platform/legacy-compat';

/** Masa password settings (configBean.cfc:167,191,217-218). */
export interface LegacyPasswordConfig {
  encryptPasswords: boolean;
  bcryptPasswords: boolean;
  /** Defaults to true. */
  javaEnabled?: boolean;
  /** Defaults to 10. */
  bcryptLogRounds?: number;
}

/** Outcome of a legacy credential check. */
export interface PasswordCheck {
  match: boolean;
  /** The stored value is the CFMX_COMPAT form while bcrypt is on, which legacy rewrites at login. */
  needsUpgrade: boolean;
}

// jBCrypt 0.3 accepts only revisions $2$ and $2a$ and costs 4-31 (BCrypt.java:611-612,656-661); legacy reads its throw as no match.
const JBCRYPT_HASH = /^\$2a?\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;
const DEFAULT_BCRYPT_LOG_ROUNDS = 10;

function bcryptEnabled(cfg: LegacyPasswordConfig): boolean {
  return (cfg.javaEnabled ?? true) && cfg.bcryptPasswords;
}

/** ColdFusion hash(password, 'CFMX_COMPAT'): uppercase MD5 over the low byte of each UTF-16 unit, as ACF 2023 computes it. */
export function cfmxCompatHash(password: string): string {
  return cfHash(password, 'CFMX_COMPAT');
}

/** True for a stored value jBCrypt 0.3 can check. */
export function isBcryptHash(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && JBCRYPT_HASH.test(stored);
}

/** jBCrypt checkpw: rehash with the stored value as salt and compare the whole strings (BCrypt.java:747-748). */
async function checkBcrypt(plain: string, stored: string): Promise<boolean> {
  // Not bcrypt.compare: it rejects 59-character $2$ hashes, which jBCrypt verifies.
  const computed = Buffer.from(await bcrypt.hash(plain, stored), 'utf8');
  const expected = Buffer.from(stored, 'utf8');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** Checks a password against a stored tusers.Password value as lookupByCredentials does. */
export async function verifyLegacyPassword(
  plain: string,
  stored: string | null | undefined,
  cfg: LegacyPasswordConfig,
): Promise<PasswordCheck> {
  const value = stored ?? '';
  if (!cfg.encryptPasswords) return { match: cfEq(value, plain), needsUpgrade: false };
  const bcryptOn = bcryptEnabled(cfg);
  const bcryptOk = bcryptOn && isBcryptHash(value) && (await checkBcrypt(plain, value));
  const md5Ok = cfEq(cfmxCompatHash(plain), value);
  return { match: bcryptOk || md5Ok, needsUpgrade: bcryptOn && md5Ok };
}

/** Value savePassword stores for a new password; null stands for SQL NULL. */
export async function hashNewPassword(plain: string, cfg: LegacyPasswordConfig): Promise<string | null> {
  if (plain === '') return null;
  if (!cfg.encryptPasswords) return plain;
  if (!bcryptEnabled(cfg)) return cfmxCompatHash(plain);
  // $2a$ as jBCrypt gensalt writes it: bcryptjs salts are $2b$, which jBCrypt 0.3 rejects.
  const salt = `$2a$${(await bcrypt.genSalt(cfg.bcryptLogRounds ?? DEFAULT_BCRYPT_LOG_ROUNDS)).slice(4)}`;
  const hashed = await bcrypt.hash(plain, salt);
  if (!hashed.startsWith('$2a$')) throw new Error(`bcrypt produced revision ${hashed.slice(0, 4)}, which jBCrypt 0.3 rejects`);
  return hashed;
}
