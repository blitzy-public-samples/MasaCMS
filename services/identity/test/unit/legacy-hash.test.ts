// Masa password hashing against jBCrypt 0.3 output, ACF CFMX_COMPAT values, userUtility.cfc:140-173 and userDAO.cfc:684-699.
import { createHash } from 'node:crypto';
import { cfHash } from '@opt2/platform/legacy-compat';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { cfmxCompatHash, hashNewPassword, isBcryptHash, verifyLegacyPassword } from '../../src/legacy/hash.js';
import type { LegacyPasswordConfig } from '../../src/legacy/hash.js';

const PASSWORD = 'Tr0ub4dor&3';
const NON_ASCII_PASSWORD = 'pässwörd';

// Written by jBCrypt 0.3 hashpw (core/mura/lib/jBCrypt-0.3/BCrypt.java) with salt z0dUnoD7FmeHTP/sYtz8je.
const JBCRYPT_2A = '$2a$04$z0dUnoD7FmeHTP/sYtz8jeXnoPtq9FsBQBakNmlUub93i1T0jvAx6';
const JBCRYPT_2 = '$2$04$z0dUnoD7FmeHTP/sYtz8jeAf0ch0jyLfRsA3POvAM0W6GniJNcunK';
const JBCRYPT_2A_NON_ASCII = '$2a$04$z0dUnoD7FmeHTP/sYtz8jeiycKo1eUjIob.VyMf0M54Vega46qbbC';

const BCRYPTJS_2B = bcrypt.hashSync(PASSWORD, bcrypt.genSaltSync(4));
const MD5_STORED = cfmxCompatHash(PASSWORD);

const BCRYPT: LegacyPasswordConfig = { encryptPasswords: true, bcryptPasswords: true, javaEnabled: true, bcryptLogRounds: 4 };
const MD5_ONLY: LegacyPasswordConfig = { encryptPasswords: true, bcryptPasswords: false, bcryptLogRounds: 4 };
const NO_JAVA: LegacyPasswordConfig = { encryptPasswords: true, bcryptPasswords: true, javaEnabled: false, bcryptLogRounds: 4 };
const PLAIN_TEXT: LegacyPasswordConfig = { encryptPasswords: false, bcryptPasswords: true, javaEnabled: true };

/** Uppercase MD5 hex of `bytes`. */
function md5Hex(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex').toUpperCase();
}

describe('cfmxCompatHash', () => {
  it("equals ColdFusion hash('admin', 'CFMX_COMPAT')", () => {
    expect(cfmxCompatHash('admin')).toBe('21232F297A57A5A743894A0E4A801FC3');
  });

  it("equals hash('café ✓', 'CFMX_COMPAT') as ACF 2023.0.26 returns it", () => {
    expect(cfmxCompatHash('café ✓')).toBe('1ACC886451B173DE25EEE59089E8B75C');
  });

  // CFMX_COMPAT ignores hash()'s encoding and keeps the low byte of each UTF-16 unit, so UTF-8 MD5 differs for non-ASCII text.
  it('digests the low byte of each UTF-16 unit of a non-ASCII password, as platform cfHash CFMX_COMPAT does', () => {
    const hashed = cfmxCompatHash(NON_ASCII_PASSWORD);
    expect(hashed).toBe(md5Hex(Buffer.from(NON_ASCII_PASSWORD, 'latin1')));
    expect(hashed).toBe(cfHash(NON_ASCII_PASSWORD, 'CFMX_COMPAT'));
    expect(hashed).not.toBe(md5Hex(Buffer.from(NON_ASCII_PASSWORD, 'utf8')));
  });
});

describe('isBcryptHash (BCrypt.java:611-612,650-661)', () => {
  it.each([
    { label: 'a $2a$ hash written by jBCrypt', value: JBCRYPT_2A },
    { label: 'a 59-character $2$ hash', value: JBCRYPT_2 },
    { label: 'a $2a$ hash at cost 31', value: `$2a$31$${JBCRYPT_2A.slice(7)}` },
  ])('accepts $label', ({ value }) => {
    expect(isBcryptHash(value)).toBe(true);
  });

  it.each([
    { label: 'a $2b$ hash', value: BCRYPTJS_2B },
    { label: 'a $2y$ hash', value: `$2y$${JBCRYPT_2A.slice(4)}` },
    { label: 'a cost below 4', value: `$2a$03$${JBCRYPT_2A.slice(7)}` },
    { label: 'a cost above 31', value: `$2a$32$${JBCRYPT_2A.slice(7)}` },
    { label: 'a truncated hash', value: JBCRYPT_2A.slice(0, -1) },
    { label: 'a 32-character MD5 hex string', value: MD5_STORED },
    { label: 'plain text', value: PASSWORD },
    { label: 'the empty string', value: '' },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
  ])('rejects $label', ({ value }) => {
    expect(isBcryptHash(value)).toBe(false);
  });
});

describe('verifyLegacyPassword (userUtility.cfc:140-173)', () => {
  it.each([
    {
      label: 'plain-text storage compares case-insensitively, as CFML eq does',
      cfg: PLAIN_TEXT,
      stored: 'Secret',
      plain: 'secret',
      match: true,
      needsUpgrade: false,
    },
    {
      label: 'plain-text storage rejects a different password',
      cfg: PLAIN_TEXT,
      stored: 'Secret',
      plain: 'other',
      match: false,
      needsUpgrade: false,
    },
    {
      label: 'plain-text storage compares numeric strings as numbers, as CFML eq does',
      cfg: PLAIN_TEXT,
      stored: '0123',
      plain: '123',
      match: true,
      needsUpgrade: false,
    },
    {
      label: 'plain-text storage reads a NULL password as the empty string, as a CFML query column does',
      cfg: PLAIN_TEXT,
      stored: null,
      plain: '',
      match: true,
      needsUpgrade: false,
    },
    {
      label: 'a jBCrypt $2a$ hash matches without an upgrade',
      cfg: BCRYPT,
      stored: JBCRYPT_2A,
      plain: PASSWORD,
      match: true,
      needsUpgrade: false,
    },
    {
      label: 'a jBCrypt $2$ hash matches without an upgrade',
      cfg: BCRYPT,
      stored: JBCRYPT_2,
      plain: PASSWORD,
      match: true,
      needsUpgrade: false,
    },
    {
      label: 'a jBCrypt hash of a non-ASCII password matches its UTF-8 password',
      cfg: BCRYPT,
      stored: JBCRYPT_2A_NON_ASCII,
      plain: NON_ASCII_PASSWORD,
      match: true,
      needsUpgrade: false,
    },
    {
      label: 'a jBCrypt hash rejects a wrong password',
      cfg: BCRYPT,
      stored: JBCRYPT_2A,
      plain: 'wrong',
      match: false,
      needsUpgrade: false,
    },
    {
      label: 'a $2b$ hash of the right password fails, as jBCrypt 0.3 throws on it',
      cfg: BCRYPT,
      stored: BCRYPTJS_2B,
      plain: PASSWORD,
      match: false,
      needsUpgrade: false,
    },
    {
      label: 'a CFMX_COMPAT hash matches and needs the bcrypt upgrade (lines 167-173)',
      cfg: BCRYPT,
      stored: MD5_STORED,
      plain: PASSWORD,
      match: true,
      needsUpgrade: true,
    },
    {
      label: 'a lower-cased CFMX_COMPAT hash matches and needs the upgrade, as CFML eq ignores case',
      cfg: BCRYPT,
      stored: MD5_STORED.toLowerCase(),
      plain: PASSWORD,
      match: true,
      needsUpgrade: true,
    },
    {
      label: 'a CFMX_COMPAT hash rejects a wrong password',
      cfg: BCRYPT,
      stored: MD5_STORED,
      plain: 'wrong',
      match: false,
      needsUpgrade: false,
    },
    {
      label: 'without bcryptPasswords a CFMX_COMPAT hash matches without an upgrade',
      cfg: MD5_ONLY,
      stored: MD5_STORED,
      plain: PASSWORD,
      match: true,
      needsUpgrade: false,
    },
    {
      label: 'without bcryptPasswords a bcrypt hash fails (line 154)',
      cfg: MD5_ONLY,
      stored: JBCRYPT_2A,
      plain: PASSWORD,
      match: false,
      needsUpgrade: false,
    },
    {
      label: 'without javaEnabled a bcrypt hash fails (line 153)',
      cfg: NO_JAVA,
      stored: JBCRYPT_2A,
      plain: PASSWORD,
      match: false,
      needsUpgrade: false,
    },
    {
      label: 'without javaEnabled a CFMX_COMPAT hash matches without an upgrade (line 167)',
      cfg: NO_JAVA,
      stored: MD5_STORED,
      plain: PASSWORD,
      match: true,
      needsUpgrade: false,
    },
    {
      label: 'encrypted storage never compares plain text',
      cfg: BCRYPT,
      stored: PASSWORD,
      plain: PASSWORD,
      match: false,
      needsUpgrade: false,
    },
  ])('$label', async ({ cfg, stored, plain, match, needsUpgrade }) => {
    await expect(verifyLegacyPassword(plain, stored, cfg)).resolves.toEqual({ match, needsUpgrade });
  });

  it('defaults javaEnabled to true, as configBean.cfc:217 does', async () => {
    await expect(
      verifyLegacyPassword(PASSWORD, MD5_STORED, { encryptPasswords: true, bcryptPasswords: true }),
    ).resolves.toEqual({ match: true, needsUpgrade: true });
  });
});

describe('hashNewPassword (userDAO.cfc:314,418,684-699)', () => {
  it('stores a $2a$ hash that legacy verifies without an upgrade', async () => {
    const stored = await hashNewPassword(PASSWORD, BCRYPT);
    expect(stored).not.toBeNull();
    expect(stored?.startsWith('$2a$')).toBe(true);
    expect(isBcryptHash(stored)).toBe(true);
    await expect(verifyLegacyPassword(PASSWORD, stored, BCRYPT)).resolves.toEqual({ match: true, needsUpgrade: false });
  });

  it.each([4, 5])('writes bcryptLogRounds %i as the two-digit cost segment', async (rounds) => {
    const stored = await hashNewPassword(PASSWORD, { ...BCRYPT, bcryptLogRounds: rounds });
    expect(stored?.slice(0, 7)).toBe(`$2a$${String(rounds).padStart(2, '0')}$`);
  });

  it('defaults javaEnabled to true and the cost to 10, as configBean.cfc:191,217 do', async () => {
    const cfg: LegacyPasswordConfig = { encryptPasswords: true, bcryptPasswords: true };
    const stored = await hashNewPassword(PASSWORD, cfg);
    expect(stored?.slice(0, 7)).toBe('$2a$10$');
    await expect(verifyLegacyPassword(PASSWORD, stored, cfg)).resolves.toEqual({ match: true, needsUpgrade: false });
  });

  it.each([
    { label: 'bcryptPasswords is off', cfg: MD5_ONLY },
    { label: 'javaEnabled is off', cfg: NO_JAVA },
  ])('stores the CFMX_COMPAT hash when $label', async ({ cfg }) => {
    await expect(hashNewPassword(PASSWORD, cfg)).resolves.toBe(MD5_STORED);
  });

  it('stores the password unchanged when encryptPasswords is off', async () => {
    await expect(hashNewPassword(PASSWORD, PLAIN_TEXT)).resolves.toBe(PASSWORD);
  });

  it.each([
    { label: 'bcrypt', cfg: BCRYPT },
    { label: 'CFMX_COMPAT', cfg: MD5_ONLY },
    { label: 'plain-text', cfg: PLAIN_TEXT },
  ])('stores SQL NULL for an empty password under $label storage', async ({ cfg }) => {
    await expect(hashNewPassword('', cfg)).resolves.toBeNull();
  });
});
