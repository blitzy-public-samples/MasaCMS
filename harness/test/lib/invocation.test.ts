// Runs invocation.ts against @opt2/platform/testing's generated secrets; invocation-gate.test.ts covers the per-file key and minter-output guards.
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  LOCAL_SECRET_FILES,
  Roles,
  SERVICE_ROLE_GRANTS,
  loadLocalSigningKeys,
  localSecretPath,
  verifyLocalServiceToken,
  type InvocationMinter,
  type InvocationTarget,
} from '@opt2/platform/auth';
import { writeTestSecrets } from '@opt2/platform/testing';
import {
  HARNESS_CALLERS,
  createHarnessInvoker,
  harnessCallerRoles,
  invocationHeaders,
  type HarnessCaller,
  type MinterFactory,
} from '../../src/lib/invocation.js';
import type { EnvLike } from '../../src/lib/paths.js';

const STUB_CREDENTIAL = 'Bearer stub-token';
const BEARER_PREFIX = 'Bearer ';
/** Header names that would carry a caller-supplied conclusion instead of a credential. */
const CONCLUSION_HEADER = /role|tenant|user|site/i;
/** A service neither call below addresses. */
const OTHER_AUDIENCE = 'identity';

const PLATFORM_ROLE: Readonly<Record<HarnessCaller, string>> = {
  operator: Roles.platformOperator,
  migration: Roles.platformMigration,
};

interface HarnessCall {
  caller: HarnessCaller;
  callee: string;
  url: string;
}

/** One internal route per harness caller. */
const CALLS: readonly HarnessCall[] = [
  { caller: 'operator', callee: 'gateway', url: 'http://127.0.0.1:8100/internal/v1/cutover/status' },
  { caller: 'migration', callee: 'people', url: 'http://127.0.0.1:8112/internal/v1/migration/export' },
];

const ENTRY_POINTS = ['createHarnessInvoker', 'invocationHeaders'] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

let root: string;
let stateDirWithKeys: string;
let emptyStateDir: string;

/** Factory arguments and minted targets a recording factory saw. */
interface MinterRecording {
  factoryCalls: Parameters<MinterFactory>[0][];
  targets: InvocationTarget[];
}

/** Factory recording its arguments, whose minter records each target and returns the stub credential. */
function recordingMinterFactory(): { factory: MinterFactory; recording: MinterRecording } {
  const recording: MinterRecording = { factoryCalls: [], targets: [] };
  const factory: MinterFactory = (args) => {
    recording.factoryCalls.push(args);
    const minter: InvocationMinter = {
      async headersFor({ name, url }) {
        recording.targets.push({ name, url });
        return { [INVOCATION_HEADER]: STUB_CREDENTIAL };
      },
    };
    return minter;
  };
  return { factory, recording };
}

function stateEnv(dir: string): EnvLike {
  return { OPT2_STATE_DIR: dir };
}

/** Headers for `call` through the named entry point of invocation.ts. */
async function headersVia(
  entry: EntryPoint,
  call: HarnessCall,
  deps: { env: EnvLike; minterFactory?: MinterFactory },
): Promise<Record<string, string>> {
  if (entry === 'invocationHeaders') {
    return invocationHeaders(call, deps);
  }
  const invoker = await createHarnessInvoker({ caller: call.caller, ...deps });
  return invoker.headersFor({ callee: call.callee, url: call.url });
}

function expectOnlyInvocationHeader(headers: Record<string, string>): void {
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  expect(names).toEqual([INVOCATION_HEADER]);
  expect(names).not.toContain('authorization');
  expect(names.filter((name) => name.startsWith('x-opt2-') || CONCLUSION_HEADER.test(name))).toEqual([]);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-invocation-'));
  stateDirWithKeys = path.join(root, 'state');
  emptyStateDir = path.join(root, 'empty-state');
  await mkdir(emptyStateDir);
  await writeTestSecrets(stateDirWithKeys);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('harnessCallerRoles', () => {
  it('lists the operator and migration callers in order', () => {
    expect(HARNESS_CALLERS).toEqual(['operator', 'migration']);
  });

  it.each(HARNESS_CALLERS)('grants %s only its platform role beside its service role', (caller) => {
    const roles = harnessCallerRoles(caller);
    expect(roles).toEqual([`service:${caller}`, ...(SERVICE_ROLE_GRANTS[caller] ?? [])]);
    expect(roles.filter((role) => role.startsWith('platform.'))).toEqual([PLATFORM_ROLE[caller]]);
  });

  it('throws for a caller the platform grants nothing', () => {
    expect(() => harnessCallerRoles('gateway' as never)).toThrow('no grant for harness caller gateway');
  });
});

describe('injected minter factory', () => {
  it.each(CALLS.flatMap((call) => ENTRY_POINTS.map((entry) => ({ entry, ...call }))))(
    '$entry sends only the invocation header for $caller calling $callee',
    async ({ entry, caller, callee, url }) => {
      const { factory, recording } = recordingMinterFactory();
      const headers = await headersVia(entry, { caller, callee, url }, { env: stateEnv(emptyStateDir), minterFactory: factory });
      expectOnlyInvocationHeader(headers);
      expect(headers[INVOCATION_HEADER]).toBe(STUB_CREDENTIAL);
      expect(recording.factoryCalls).toEqual([{ caller, stateDir: emptyStateDir, roles: harnessCallerRoles(caller) }]);
      expect(recording.targets).toEqual([{ name: callee, url }]);
    },
  );
});

describe('local minter over writeTestSecrets keys', () => {
  it.each(Object.values(LOCAL_SECRET_FILES))('finds %s where the local adapters read it', async (file) => {
    await expect(access(localSecretPath(stateDirWithKeys, file))).resolves.toBeUndefined();
  });

  it.each(CALLS)('signs a token $callee verifies as $caller', async (call) => {
    const headers = await headersVia('createHarnessInvoker', call, { env: stateEnv(stateDirWithKeys) });
    expectOnlyInvocationHeader(headers);
    const value = headers[INVOCATION_HEADER] ?? '';
    expect(value.startsWith(BEARER_PREFIX)).toBe(true);
    const token = value.slice(BEARER_PREFIX.length);
    const { publicKey } = await loadLocalSigningKeys(stateDirWithKeys);

    const identity = await verifyLocalServiceToken(token, { publicKey, audience: call.callee });
    expect(identity).toEqual({ name: call.caller, roles: harnessCallerRoles(call.caller) });
    expect(identity.roles).toContain(PLATFORM_ROLE[call.caller]);
    await expect(verifyLocalServiceToken(token, { publicKey, audience: OTHER_AUDIENCE })).rejects.toThrow();
  });

  it('fails when local keys are absent', async () => {
    const missing = [LOCAL_SECRET_FILES.tokenSigningPrivateKey, LOCAL_SECRET_FILES.tokenSigningPublicKey].map((file) =>
      localSecretPath(emptyStateDir, file),
    );
    await expect(createHarnessInvoker({ caller: 'operator', env: stateEnv(emptyStateDir) })).rejects.toThrow(
      `Local secrets missing: ${missing.join(', ')}`,
    );
  });
});
