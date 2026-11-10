import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository checkout root: the directory that contains `harness/`, without a trailing separator. */
export const REPO_ROOT: string = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** The `harness/` package root. */
export const HARNESS_ROOT: string = path.join(REPO_ROOT, 'harness');

/** Environment variable map; `process.env` satisfies it. */
export type EnvLike = Record<string, string | undefined>;

/** Absolute path of `segments` resolved against the repository root. */
export function repoPath(...segments: string[]): string {
  return path.resolve(REPO_ROOT, ...segments);
}

/** Absolute path under the `opt2/` deliverables folder. */
export function opt2Path(...segments: string[]): string {
  return repoPath('opt2', ...segments);
}

/** Whether `p`, resolved against the working directory, is the repository root or lies beneath it. */
export function isInsideRepo(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep);
}

/** Resolved `p`; throws an error naming `label` and the path when it lies inside the checkout. */
export function assertOutsideRepo(p: string, label: string): string {
  const resolved = path.resolve(p);
  if (isInsideRepo(resolved)) {
    throw new Error(`${label} must be outside the repository checkout ${REPO_ROOT}, got ${resolved}`);
  }
  return resolved;
}

function envValue(env: EnvLike, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function homeDir(env: EnvLike): string {
  return envValue(env, 'HOME') ?? os.homedir();
}

/** Runtime state directory: `OPT2_STATE_DIR`, else `<home>/.opt2/state`; throws when inside the checkout. */
export function stateDir(env: EnvLike = process.env): string {
  return assertOutsideRepo(
    envValue(env, 'OPT2_STATE_DIR') ?? path.join(homeDir(env), '.opt2', 'state'),
    'OPT2_STATE_DIR',
  );
}

/** Pristine legacy baseline directory: `OPT2_PRISTINE_DIR`, else `<home>/.opt2/pristine`; throws when inside the checkout. */
export function pristineDir(env: EnvLike = process.env): string {
  return assertOutsideRepo(
    envValue(env, 'OPT2_PRISTINE_DIR') ?? path.join(homeDir(env), '.opt2', 'pristine'),
    'OPT2_PRISTINE_DIR',
  );
}

/** Generated local secrets directory, `<state>/secrets`. */
export function secretsDir(env: EnvLike = process.env): string {
  return path.join(stateDir(env), 'secrets');
}

/**
 * Report output directory: `OPT2_REPORTS_DIR`, a relative value resolving against the repository root,
 * else `opt2/reports`. It may lie inside the checkout, because reports are committed deliverables.
 */
export function reportsDir(env: EnvLike = process.env): string {
  const override = envValue(env, 'OPT2_REPORTS_DIR');
  return override === undefined ? opt2Path('reports') : repoPath(override);
}
