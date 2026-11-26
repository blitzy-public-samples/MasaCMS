import { access } from 'node:fs/promises';
import {
  INVOCATION_HEADER,
  LOCAL_SECRET_FILES,
  SERVICE_ROLE_GRANTS,
  createLocalInvocationMinter,
  loadLocalSigningKeys,
  localSecretPath,
  rolesForService,
  type InvocationMinter,
} from '@opt2/platform/auth';
import { stateDir, type EnvLike } from './paths.js';

/** Workload identities the harness calls internal routes as. */
export const HARNESS_CALLERS = ['operator', 'migration'] as const;

/** One harness workload identity. */
export type HarnessCaller = (typeof HARNESS_CALLERS)[number];

/** Builds the invocation minter for a harness caller from the state directory and the caller's roles. */
export type MinterFactory = (args: {
  caller: HarnessCaller;
  stateDir: string;
  roles: readonly string[];
}) => InvocationMinter | Promise<InvocationMinter>;

/** Invocation-credential source bound to one harness caller. */
export interface HarnessInvoker {
  /** Headers for one call to `callee` at `url`: exactly the minter's, invocation credential included. */
  headersFor(target: { callee: string; url: string }): Promise<Record<string, string>>;
}

/** Key files under `<state>/secrets/` that the local minter reads. */
const LOCAL_MINTER_SECRET_FILES = [
  LOCAL_SECRET_FILES.tokenSigningPrivateKey,
  LOCAL_SECRET_FILES.tokenSigningPublicKey,
] as const;

/** Roles the caller's token carries (`service:<caller>` plus its platform grant); throws when the platform grants none. */
export function harnessCallerRoles(caller: HarnessCaller): readonly string[] {
  const grants = Object.hasOwn(SERVICE_ROLE_GRANTS, caller) ? SERVICE_ROLE_GRANTS[caller] : undefined;
  if (grants === undefined || grants.length === 0) {
    throw new Error(`@opt2/platform/auth SERVICE_ROLE_GRANTS has no grant for harness caller ${caller}`);
  }
  return rolesForService(caller);
}

async function missingSecretPaths(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const file of LOCAL_MINTER_SECRET_FILES) {
    const filePath = localSecretPath(dir, file);
    await access(filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      missing.push(filePath);
    });
  }
  return missing;
}

/** Local minter signing service tokens with the generated key pair; throws naming any missing key file. */
export const defaultMinterFactory: MinterFactory = async ({ caller, stateDir: dir, roles }) => {
  // The key-file check lives here because only this minter reads the files; an injected factory brings its own credentials.
  const missing = await missingSecretPaths(dir);
  if (missing.length > 0) {
    throw new Error(`Local secrets missing: ${missing.join(', ')}; harness/repro/up.sh step 2 generates the secrets`);
  }
  return createLocalInvocationMinter({
    keys: await loadLocalSigningKeys(dir, { requirePrivate: true }),
    caller,
    roles: [...roles],
  });
};

/** Invoker minting a fresh invocation credential for `caller` on every call. */
export async function createHarnessInvoker(opts: {
  caller: HarnessCaller;
  env?: EnvLike;
  minterFactory?: MinterFactory;
}): Promise<HarnessInvoker> {
  const { caller, env = process.env, minterFactory = defaultMinterFactory } = opts;
  const roles = harnessCallerRoles(caller);
  const minter = await minterFactory({ caller, stateDir: stateDir(env), roles });
  return {
    async headersFor({ callee, url }) {
      const headers = { ...(await minter.headersFor({ name: callee, url })) };
      if (!Object.keys(headers).some((name) => name.toLowerCase() === INVOCATION_HEADER)) {
        throw new Error(`Invocation minter for ${caller} returned no ${INVOCATION_HEADER} header for ${callee}`);
      }
      return headers;
    },
  };
}

/** One-shot invocation headers for `caller` calling `callee` at `url`. */
export async function invocationHeaders(
  target: { caller: HarnessCaller; callee: string; url: string },
  deps: { env?: EnvLike; minterFactory?: MinterFactory } = {},
): Promise<Record<string, string>> {
  const invoker = await createHarnessInvoker({ caller: target.caller, env: deps.env, minterFactory: deps.minterFactory });
  return invoker.headersFor({ callee: target.callee, url: target.url });
}
