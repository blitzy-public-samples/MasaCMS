import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The `migration/` package root; `src/` and `dist/` sit at the same depth, so both resolve here. */
export const PACKAGE_ROOT = new URL('../', import.meta.url);

/** The repository root. */
export const REPO_ROOT = new URL('../../', import.meta.url);

const packageDir = fileURLToPath(PACKAGE_ROOT);
const repoDir = fileURLToPath(REPO_ROOT);
const CUTOVER_VERSION = /^v\d{4}$/;

function requireAbsolute(value: string, what: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${what} must be an absolute path, got "${value}"`);
}

// Resolved with path.resolve rather than `new URL(rel, root)`: URL parsing would drop `?`/`#` suffixes
// and percent-decode `%` in file names, while giving the same result for every ordinary path.
function resolveInRepo(baseDir: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new Error(`Expected a relative path, got absolute "${rel}"`);
  const abs = path.resolve(baseDir, rel);
  const fromRepo = path.relative(repoDir, abs);
  if (fromRepo === '..' || fromRepo.startsWith(`..${path.sep}`) || path.isAbsolute(fromRepo)) {
    throw new Error(`Path "${rel}" escapes the repository root ${repoDir}`);
  }
  return abs;
}

/** Absolute path of `rel`, relative to `migration/`; it may climb to sibling packages but never above the repository root. */
export function packagePath(rel: string): string {
  return resolveInRepo(packageDir, rel);
}

/** Absolute path of `rel`, relative to the repository root, which it may not leave. */
export function repoPath(rel: string): string {
  return resolveInRepo(repoDir, rel);
}

/** Static orchestrator configuration file. */
export const CONFIG_PATH = packagePath('config/migration.config.json');

/** SQL batch that creates the `opt2_sync` schema and its projector checkpoint table in the legacy database. */
export const OPT2_SYNC_SQL_PATH = packagePath('sql/005_opt2_sync.sql');

/** `db/migrations` directory of a repository-relative package such as `services/people`, `gateway` or `migration`. */
export function migrationsDirFor(packageRel: string): string {
  return repoPath(`${packageRel}/db/migrations`);
}

/** `<cutoverDirAbs>/versions/<version>.json`; `version` must have the form `vNNNN`. */
export function cutoverVersionFile(cutoverDirAbs: string, version: string): string {
  requireAbsolute(cutoverDirAbs, 'Cut-over directory');
  if (!CUTOVER_VERSION.test(version)) throw new Error(`Cut-over version "${version}" does not match vNNNN`);
  return path.join(cutoverDirAbs, 'versions', `${version}.json`);
}

/** Path under the runtime state directory, which must be absolute. */
export function stateDirPath(stateDir: string, ...segments: string[]): string {
  requireAbsolute(stateDir, 'State directory');
  return path.join(stateDir, ...segments);
}

/** Directory holding snapshot backup files `snap-<n>.bak`. */
export function snapshotsDir(stateDir: string): string {
  return stateDirPath(stateDir, 'snapshots');
}

/** Process record written by `harness/repro/up.sh`: pids, ports and start commands. */
export function upJsonPath(stateDir: string): string {
  return stateDirPath(stateDir, 'up.json');
}
