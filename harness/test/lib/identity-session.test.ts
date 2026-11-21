import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Roles } from '@opt2/platform/auth';
import { TENANT_A } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_KEY_FILE,
  BRIDGE_KEY_VARIABLE,
  bridgeHmacKey,
  describedSession,
  legacySessionCookieHeader,
  mintedToken,
  relayPath,
  sessionModeOf,
  snapshotSession,
  targetSessionId,
  type SessionMode,
} from '../../src/lib/identity-session.js';

const USERNAME = 'fin-preparer-a';
const USER_ID = '6F1E2A3B-0C4D-5E6F-7A8B9C0D1E2F3A4B';
const SESSION_ID = 'MURA0123ABCD_3601_96479012';
// Test value assembled at run time, not a secret.
const KEY = ['opt2', 'bridge', 'unit', 'test'].join('-');

function describeBody(overrides: Record<string, unknown> = {}, user: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    isLoggedIn: true,
    user: { userID: USER_ID, username: USERNAME, siteID: TENANT_A.siteId, ...user },
    memberships: `${Roles.financePreparer};${TENANT_A.siteId};0`,
    csrfSecretKey: 'not-read',
    usedTokens: [],
    siteId: TENANT_A.siteId,
    ...overrides,
  };
}

const TARGET_SESSION_ID = '0B5C7D9E-1F2A-3B4C-5D6E7F8091A2B3C4';

function snapshotBody(overrides: Record<string, unknown> = {}, user: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: TARGET_SESSION_ID,
    epoch: 3,
    loginSnapshot: {
      user: { isLoggedIn: true, userID: USER_ID, username: USERNAME, siteID: TENANT_A.siteId, ...user },
      roles: [`${Roles.financePreparer};${TENANT_A.siteId};0`],
    },
    csrfSecretKey: 'not-read',
    usedTokens: [],
    ...overrides,
  };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: USER_ID,
    sid: SESSION_ID,
    tid: TENANT_A.tenantId,
    site: TENANT_A.siteId,
    roles: [Roles.systemUser, Roles.financePreparer],
    s2: false,
    epoch: 2,
    iat: 1_800_000_000,
    exp: 1_800_000_300,
    ...overrides,
  };
}

function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { token: 'opt2-test-user-token', expiresAt: 1_800_000_300, epoch: 2, claims: claims(), ...overrides };
}

const EXPECTED = { sessionId: SESSION_ID, site: TENANT_A.siteId };

describe('relayPath', () => {
  it('prefixes the callee path with the relay route and the service', () => {
    expect(relayPath('finance', '/v1/finance/records')).toBe('/internal/v1/relay/finance/v1/finance/records');
    expect(relayPath('e-signature', '/v1/requests')).toBe('/internal/v1/relay/e-signature/v1/requests');
  });

  it.each(['', 'Finance', 'finance/v1', '../identity', 'service:web'])('rejects the service %j', (service) => {
    expect(() => relayPath(service, '/v1/x')).toThrow(`invalid relay service ${JSON.stringify(service)}`);
  });

  it('rejects a callee path without a leading slash', () => {
    expect(() => relayPath('finance', 'v1/finance/records')).toThrow('relay callee path must start with /');
  });
});

describe('legacySessionCookieHeader', () => {
  it('keeps only the legacy session cookies with a value, upper-cased in order', () => {
    const header = 'rb=; cfid=3601; ADMINSIDEBAR=off; CFTOKEN=96479012; JSESSIONID=; mobileFormat=false';
    expect(legacySessionCookieHeader(header)).toBe('CFID=3601; CFTOKEN=96479012');
  });

  it.each(['', 'rb=; mobileFormat=false', 'CFID=; CFTOKEN='])('throws for %j, which holds no session cookie value', (header) => {
    expect(() => legacySessionCookieHeader(header)).toThrow('the session holds no legacy session cookie');
  });
});

describe('describedSession', () => {
  it('returns the session id and user of a session logged in as the user, matching the name ignoring case', () => {
    expect(describedSession(describeBody({}, { username: USERNAME.toUpperCase() }), USERNAME)).toEqual({
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
  });

  it.each<[string, unknown, string]>([
    ['a non-object body', 'html', 'answered no sessionId'],
    ['an empty sessionId', describeBody({ sessionId: '' }), 'answered no sessionId'],
    ['a logged-out session', describeBody({ isLoggedIn: false }), `is not logged in as ${USERNAME}`],
    ['another user', describeBody({}, { username: 'someone-else' }), `is not logged in as ${USERNAME}`],
    ['no user struct', describeBody({ user: null }), `is not logged in as ${USERNAME}`],
    ['an empty userID', describeBody({}, { userID: '' }), `of ${USERNAME} has no userID`],
  ])('throws for %s', (_label, body, message) => {
    expect(() => describedSession(body, USERNAME)).toThrow(message);
  });
});

describe('sessionModeOf', () => {
  it.each<SessionMode>(['legacy-primary', 'target-primary'])('returns the reported mode %s', (mode) => {
    expect(sessionModeOf({ tableVersion: 'v0002', epoch: 4, sessionMode: mode })).toBe(mode);
  });

  it.each<[string, unknown, string]>([
    ['a non-object status', null, 'got undefined'],
    ['a status without the field', { tableVersion: 'v0001' }, 'got undefined'],
    ['an unknown mode', { sessionMode: 'Target-Primary' }, 'got "Target-Primary"'],
    ['a non-string mode', { sessionMode: 1 }, 'got 1'],
  ])('throws for %s', (_label, status, detail) => {
    expect(() => sessionModeOf(status)).toThrow(`the gateway's cut-over status reports no session mode (${detail})`);
  });
});

describe('targetSessionId', () => {
  it.each<[string, string, string]>([
    ['regains the dashes of a CF-format id', `CFID=3601; CFTOKEN=0; JSESSIONID=${TARGET_SESSION_ID.replaceAll('-', '')}`, TARGET_SESSION_ID],
    ['keeps any other id unchanged', `rb=; JSESSIONID=${SESSION_ID}`, SESSION_ID],
    ['reads the cookie name in any case', `jsessionid=${SESSION_ID}; CFID=1`, SESSION_ID],
    ['reads CFTOKEN where no JSESSIONID is held', `CFID=3601; CFTOKEN=${SESSION_ID}`, SESSION_ID],
    ['prefers JSESSIONID to CFTOKEN', `CFTOKEN=0; JSESSIONID=${SESSION_ID}`, SESSION_ID],
  ])('%s', (_label, header, expected) => {
    expect(targetSessionId(header)).toBe(expected);
  });

  it.each(['', 'CFID=3601', 'JSESSIONID=; CFTOKEN='])('throws for %j, which names no identity session', (header) => {
    expect(() => targetSessionId(header)).toThrow('the session holds no identity-issued JSESSIONID or CFTOKEN cookie');
  });
});

describe('snapshotSession', () => {
  it('returns the session id and user of a snapshot logged in as the user, matching the name ignoring case', () => {
    expect(snapshotSession(snapshotBody({}, { username: USERNAME.toUpperCase() }), USERNAME)).toEqual({
      sessionId: TARGET_SESSION_ID,
      userId: USER_ID,
    });
  });

  it.each<[string, unknown, string]>([
    ['a non-object body', 'html', "identity's session snapshot answered no sessionId"],
    ['an empty sessionId', snapshotBody({ sessionId: '' }), "identity's session snapshot answered no sessionId"],
    ['an anonymous snapshot', snapshotBody({}, { isLoggedIn: false }), `the identity session is not logged in as ${USERNAME}`],
    ['another user', snapshotBody({}, { username: 'someone-else' }), `the identity session is not logged in as ${USERNAME}`],
    ['no login snapshot', snapshotBody({ loginSnapshot: null }), `the identity session is not logged in as ${USERNAME}`],
    ['an empty userID', snapshotBody({}, { userID: '' }), `the identity session of ${USERNAME} has no userID`],
  ])('throws for %s', (_label, body, message) => {
    expect(() => snapshotSession(body, USERNAME)).toThrow(message);
  });
});

describe('mintedToken', () => {
  it('returns the token, expiry and parsed claims of a token minted for the session and site', () => {
    const minted = mintedToken(tokenBody({ claims: claims({ site: 'TENANT-A', extra: 'kept out' }) }), EXPECTED);
    expect(minted.token).toBe('opt2-test-user-token');
    expect(minted.expiresAt).toBe(1_800_000_300);
    expect(minted.claims).toEqual(claims({ site: 'TENANT-A' }));
  });

  it.each<[string, unknown, string]>([
    ['a non-object body', null, 'identity answered no user token'],
    ['an empty token', tokenBody({ token: '' }), 'identity answered no user token'],
    ['a missing expiry', tokenBody({ expiresAt: undefined }), 'identity answered no user token'],
    ['claims outside the contract', tokenBody({ claims: claims({ tid: 'tenant-a' }) }), 'outside the UserClaims contract'],
    ['another session', tokenBody({ claims: claims({ sid: 'MURA0123ABCD_1_2' }) }), 'for another session'],
    ['another site', tokenBody({ claims: claims({ site: 'tenant-b' }) }), 'for site tenant-b, not tenant-a'],
  ])('throws for %s', (_label, body, message) => {
    expect(() => mintedToken(body, EXPECTED)).toThrow(message);
  });
});

describe('bridgeHmacKey', () => {
  let root: string;
  let env: Record<string, string>;
  let keyFile: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'opt2-identity-session-'));
    env = { OPT2_STATE_DIR: root };
    keyFile = path.join(root, 'secrets', BRIDGE_KEY_FILE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prefers the variable over the key file', async () => {
    await mkdir(path.dirname(keyFile), { recursive: true });
    await writeFile(keyFile, 'file-value');
    expect(bridgeHmacKey({ ...env, [BRIDGE_KEY_VARIABLE]: KEY })).toBe(KEY);
  });

  it('reads the key file trimmed when the variable is unset or empty', async () => {
    await mkdir(path.dirname(keyFile), { recursive: true });
    await writeFile(keyFile, `  ${KEY}\n`);
    expect(bridgeHmacKey(env)).toBe(KEY);
    expect(bridgeHmacKey({ ...env, [BRIDGE_KEY_VARIABLE]: '' })).toBe(KEY);
  });

  it.each<[string, string | undefined]>([
    ['missing', undefined],
    ['blank', ' \n'],
  ])('throws naming the file when it is %s', async (_label, content) => {
    if (content !== undefined) {
      await mkdir(path.dirname(keyFile), { recursive: true });
      await writeFile(keyFile, content);
    }
    expect(() => bridgeHmacKey(env)).toThrow(`no bridge key: ${BRIDGE_KEY_VARIABLE} is unset and ${keyFile} is missing or empty`);
  });

  it('rethrows a read failure other than a missing file', async () => {
    await mkdir(keyFile, { recursive: true });
    let thrown: unknown;
    try {
      bridgeHmacKey(env);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe('EISDIR');
  });
});
