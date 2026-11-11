import { createPublicKey, generateKeyPair } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  LOCAL_SECRET_FILES,
  SERVICE_ROLE_GRANTS,
  localSecretPath,
  rolesForService,
  verifyLocalServiceToken,
  type InvocationMinter,
  type InvocationTarget,
} from '@opt2/platform/auth';
import {
  HARNESS_CALLERS,
  createHarnessInvoker,
  defaultMinterFactory,
  harnessCallerRoles,
  invocationHeaders,
  type HarnessCaller,
  type MinterFactory,
} from '../../src/lib/invocation.js';
import { REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';

const STUB_CREDENTIAL = 'Bearer stub-token';
const BEARER = 'Bearer ';
const PRIVATE_FILE = LOCAL_SECRET_FILES.tokenSigningPrivateKey;
const PUBLIC_FILE = LOCAL_SECRET_FILES.tokenSigningPublicKey;
const TARGET = { callee: 'people', url: 'http://127.0.0.1:8112/internal/v1/people' };
const OTHER_TARGET = { callee: 'identity', url: 'http://127.0.0.1:8111/internal/v1/tokens' };

let root: string;
let emptyState: string;
let keyedState: string;
let pem: { publicKey: string; privateKey: string };

/** Factory arguments and minted targets a recording factory saw. */
interface Recording {
  factoryCalls: Parameters<MinterFactory>[0][];
  targets: InvocationTarget[];
}

/** Factory recording its arguments, whose minter returns `headers` for every target. */
function recordingFactory(headers: Record<string, string> = { [INVOCATION_HEADER]: STUB_CREDENTIAL }): {
  factory: MinterFactory;
  recording: Recording;
} {
  const recording: Recording = { factoryCalls: [], targets: [] };
  const factory: MinterFactory = (args) => {
    recording.factoryCalls.push(args);
    const minter: InvocationMinter = {
      async headersFor(target) {
        recording.targets.push(target);
        return headers;
      },
    };
    return minter;
  };
  return { factory, recording };
}

/** New state directory `name` under the temp root holding `files` of the generated key pair. */
async function stateWith(name: string, files: readonly string[]): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir);
  if (files.length > 0) {
    await mkdir(path.join(dir, 'secrets'), { mode: 0o700 });
  }
  for (const file of files) {
    await writeFile(localSecretPath(dir, file), file === PRIVATE_FILE ? pem.privateKey : pem.publicKey, { mode: 0o600 });
  }
  return dir;
}

function stateEnv(dir: string): EnvLike {
  return { OPT2_STATE_DIR: dir };
}

/** Header names that would carry a user token or a forwarded conclusion. */
function forbiddenHeaderNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter((name) => {
    const lower = name.toLowerCase();
    return lower === 'authorization' || lower.startsWith('x-opt2-');
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-invocation-gate-'));
  pem = await promisify(generateKeyPair)('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  emptyState = await stateWith('empty', []);
  keyedState = await stateWith('keyed', [PRIVATE_FILE, PUBLIC_FILE]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('HARNESS_CALLERS', () => {
  it('names the operator and migration workloads', () => {
    expect([...HARNESS_CALLERS]).toEqual(['operator', 'migration']);
  });
});

describe('harnessCallerRoles', () => {
  it.each(HARNESS_CALLERS)('gives %s its service role followed by its platform grant', (caller) => {
    const grants = SERVICE_ROLE_GRANTS[caller] ?? [];
    expect(grants.length).toBeGreaterThan(0);
    expect(harnessCallerRoles(caller)).toEqual(rolesForService(caller));
    expect(harnessCallerRoles(caller)).toEqual([`service:${caller}`, ...grants]);
  });

  it.each(['gateway', 'constructor', 'toString'])('throws for %s, which the platform grants nothing', (name) => {
    expect(() => harnessCallerRoles(name as HarnessCaller)).toThrow(
      `@opt2/platform/auth SERVICE_ROLE_GRANTS has no grant for harness caller ${name}`,
    );
  });
});

describe('createHarnessInvoker with an injected minter factory', () => {
  it.each(HARNESS_CALLERS)(
    'builds one minter for %s from the state directory and its roles, and mints on every call',
    async (caller) => {
      const { factory, recording } = recordingFactory();
      const invoker = await createHarnessInvoker({ caller, env: stateEnv(emptyState), minterFactory: factory });
      await invoker.headersFor(TARGET);
      await invoker.headersFor(OTHER_TARGET);
      expect(recording.factoryCalls).toEqual([{ caller, stateDir: emptyState, roles: rolesForService(caller) }]);
      expect(recording.targets).toEqual([
        { name: TARGET.callee, url: TARGET.url },
        { name: OTHER_TARGET.callee, url: OTHER_TARGET.url },
      ]);
    },
  );

  it('returns only the invocation credential header, with no Authorization or X-OPT2-* header', async () => {
    const { factory } = recordingFactory();
    const invoker = await createHarnessInvoker({ caller: 'operator', env: stateEnv(emptyState), minterFactory: factory });
    const headers = await invoker.headersFor(TARGET);
    expect(headers).toEqual({ [INVOCATION_HEADER]: STUB_CREDENTIAL });
    expect(forbiddenHeaderNames(headers)).toEqual([]);
  });

  it('accepts a factory that resolves the minter asynchronously', async () => {
    const { factory, recording } = recordingFactory();
    const asyncFactory: MinterFactory = async (args) => factory(args);
    const invoker = await createHarnessInvoker({
      caller: 'migration',
      env: stateEnv(emptyState),
      minterFactory: asyncFactory,
    });
    expect(await invoker.headersFor(TARGET)).toEqual({ [INVOCATION_HEADER]: STUB_CREDENTIAL });
    expect(recording.factoryCalls).toHaveLength(1);
  });

  it.each([
    { label: 'lower case', name: INVOCATION_HEADER },
    { label: 'mixed case', name: 'X-Serverless-Authorization' },
  ])('passes on the invocation header the minter names in $label', async ({ name }) => {
    const { factory } = recordingFactory({ [name]: STUB_CREDENTIAL });
    const invoker = await createHarnessInvoker({ caller: 'operator', env: stateEnv(emptyState), minterFactory: factory });
    expect(await invoker.headersFor(TARGET)).toEqual({ [name]: STUB_CREDENTIAL });
  });

  it.each<{ label: string; headers: Record<string, string> }>([
    { label: 'no headers', headers: {} },
    { label: 'only Authorization', headers: { authorization: STUB_CREDENTIAL } },
    { label: 'a header merely prefixed like the invocation header', headers: { [`${INVOCATION_HEADER}-x`]: STUB_CREDENTIAL } },
  ])('rejects a minter returning $label', async ({ headers }) => {
    const { factory } = recordingFactory(headers);
    const invoker = await createHarnessInvoker({ caller: 'operator', env: stateEnv(emptyState), minterFactory: factory });
    await expect(invoker.headersFor(TARGET)).rejects.toThrow(
      `Invocation minter for operator returned no ${INVOCATION_HEADER} header for ${TARGET.callee}`,
    );
  });

  it("returns a copy, so changing one call's headers leaves the next call's intact", async () => {
    const minted = { [INVOCATION_HEADER]: STUB_CREDENTIAL };
    const { factory } = recordingFactory(minted);
    const invoker = await createHarnessInvoker({ caller: 'operator', env: stateEnv(emptyState), minterFactory: factory });
    const first = await invoker.headersFor(TARGET);
    expect(first).not.toBe(minted);
    delete first[INVOCATION_HEADER];
    first.authorization = STUB_CREDENTIAL;
    expect(await invoker.headersFor(TARGET)).toEqual({ [INVOCATION_HEADER]: STUB_CREDENTIAL });
  });

  it('rejects an unknown caller before building a minter', async () => {
    const { factory, recording } = recordingFactory();
    await expect(
      createHarnessInvoker({ caller: 'gateway' as HarnessCaller, env: stateEnv(emptyState), minterFactory: factory }),
    ).rejects.toThrow('@opt2/platform/auth SERVICE_ROLE_GRANTS has no grant for harness caller gateway');
    expect(recording.factoryCalls).toEqual([]);
  });

  it('rejects a state directory inside the checkout before building a minter', async () => {
    const { factory, recording } = recordingFactory();
    const inside = path.join(REPO_ROOT, 'opt2-state');
    await expect(
      createHarnessInvoker({ caller: 'operator', env: stateEnv(inside), minterFactory: factory }),
    ).rejects.toThrow(`OPT2_STATE_DIR must be outside the repository checkout ${REPO_ROOT}, got ${inside}`);
    expect(recording.factoryCalls).toEqual([]);
  });
});

describe('invocationHeaders', () => {
  it.each(HARNESS_CALLERS)('returns the invocation header %s presents to the callee', async (caller) => {
    const { factory, recording } = recordingFactory();
    const headers = await invocationHeaders({ caller, ...TARGET }, { env: stateEnv(emptyState), minterFactory: factory });
    expect(headers).toEqual({ [INVOCATION_HEADER]: STUB_CREDENTIAL });
    expect(forbiddenHeaderNames(headers)).toEqual([]);
    expect(recording.factoryCalls).toEqual([{ caller, stateDir: emptyState, roles: rolesForService(caller) }]);
    expect(recording.targets).toEqual([{ name: TARGET.callee, url: TARGET.url }]);
  });
});

describe('default local minter', () => {
  it.each(HARNESS_CALLERS)(
    'signs a service token for %s addressed to the callee and carrying its roles',
    async (caller) => {
      const headers = await invocationHeaders({ caller, ...TARGET }, { env: stateEnv(keyedState) });
      expect(Object.keys(headers)).toEqual([INVOCATION_HEADER]);
      const value = headers[INVOCATION_HEADER] ?? '';
      expect(value.startsWith(BEARER)).toBe(true);
      const token = value.slice(BEARER.length);
      const publicKey = createPublicKey(pem.publicKey);
      expect(await verifyLocalServiceToken(token, { publicKey, audience: TARGET.callee })).toEqual({
        name: caller,
        roles: rolesForService(caller),
      });
      await expect(verifyLocalServiceToken(token, { publicKey, audience: OTHER_TARGET.callee })).rejects.toThrow();
    },
  );

  it('signs exactly the roles it is given', async () => {
    const minter = await defaultMinterFactory({ caller: 'operator', stateDir: keyedState, roles: ['service:operator'] });
    const value = (await minter.headersFor({ name: TARGET.callee }))[INVOCATION_HEADER] ?? '';
    const identity = await verifyLocalServiceToken(value.slice(BEARER.length), {
      publicKey: createPublicKey(pem.publicKey),
      audience: TARGET.callee,
    });
    expect(identity.roles).toEqual(['service:operator']);
  });

  it.each([
    { label: 'nothing', name: 'missing-both', present: [], missing: [PRIVATE_FILE, PUBLIC_FILE] },
    { label: 'only the public key', name: 'missing-private', present: [PUBLIC_FILE], missing: [PRIVATE_FILE] },
    { label: 'only the private key', name: 'missing-public', present: [PRIVATE_FILE], missing: [PUBLIC_FILE] },
  ])('names every missing key file when the state directory holds $label', async ({ name, present, missing }) => {
    const dir = await stateWith(name, present);
    const paths = missing.map((file) => localSecretPath(dir, file)).join(', ');
    await expect(invocationHeaders({ caller: 'operator', ...TARGET }, { env: stateEnv(dir) })).rejects.toThrow(
      `Local secrets missing: ${paths}; harness/repro/up.sh step 2 generates the secrets`,
    );
  });

  it('propagates a key-file error other than a missing file', async () => {
    const dir = await stateWith('secrets-not-a-directory', []);
    await writeFile(path.join(dir, 'secrets'), '');
    await expect(createHarnessInvoker({ caller: 'migration', env: stateEnv(dir) })).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
});
