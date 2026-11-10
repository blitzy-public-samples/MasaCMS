import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT, assertOutsideRepo } from './paths.js';

/** Runs `file` with `args` directly, without a shell, and resolves with its decoded output. */
export type ProcessRunner = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** `execFile` runner with UTF-8 output and a 64 MiB default output limit; rejects on a non-zero exit. */
export const defaultRunner: ProcessRunner = async (file, args, opts) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    shell: false,
  });
  return { stdout, stderr };
};

/** Injectable runner and repository directory; `cwd` defaults to `REPO_ROOT`. */
export interface GitDeps {
  run?: ProcessRunner;
  cwd?: string;
}

const DIFF_FILTER = /^[ACDMRTUXB*]+$/i;

function git(args: readonly string[], deps: GitDeps): Promise<{ stdout: string; stderr: string }> {
  return (deps.run ?? defaultRunner)('git', args, { cwd: deps.cwd ?? REPO_ROOT });
}

// A revision beginning with '-' would be parsed by git as an option.
function assertRevision(rev: string): void {
  if (rev.length === 0 || rev.startsWith('-')) {
    throw new Error(`invalid git revision ${JSON.stringify(rev)}`);
  }
}

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

/** Every file path recorded in the tree of `sha`, recursively. */
export async function lsTree(sha: string, deps: GitDeps = {}): Promise<string[]> {
  assertRevision(sha);
  return splitNul((await git(['ls-tree', '-r', '--name-only', '-z', sha], deps)).stdout);
}

/** Paths from `git ls-files`, selecting tracked (`cached`), untracked (`others`) and ignore-filtered files as requested. */
export async function lsFiles(
  opts: { cached?: boolean; others?: boolean; excludeStandard?: boolean } = {},
  deps: GitDeps = {},
): Promise<string[]> {
  const args = ['ls-files', '-z'];
  if (opts.cached) args.push('--cached');
  if (opts.others) args.push('--others');
  if (opts.excludeStandard) args.push('--exclude-standard');
  return splitNul((await git(args, deps)).stdout);
}

/** Paths that differ between `sha` and the working tree, limited to the `--diff-filter` status letters in `filter`. */
export async function diffNames(sha: string, filter: string, deps: GitDeps = {}): Promise<string[]> {
  assertRevision(sha);
  if (!DIFF_FILTER.test(filter)) {
    throw new Error(`invalid git diff filter ${JSON.stringify(filter)}`);
  }
  return splitNul((await git(['diff', '--name-only', '-z', `--diff-filter=${filter}`, sha], deps)).stdout);
}

/** Subject line of commit `sha`. */
export async function commitSubject(sha: string, deps: GitDeps = {}): Promise<string> {
  assertRevision(sha);
  return (await git(['log', '-1', '--format=%s', sha], deps)).stdout.trim();
}

/**
 * Whether `sha` names a commit in the repository.
 * Resolves false only when git exits with a status code; a failure to run git at all (for example ENOENT) is rethrown.
 */
export async function catFileExists(sha: string, deps: GitDeps = {}): Promise<boolean> {
  assertRevision(sha);
  try {
    await git(['cat-file', '-e', `${sha}^{commit}`], deps);
    return true;
  } catch (error) {
    if (typeof (error as { code?: unknown } | null)?.code === 'number') return false;
    throw error;
  }
}

/**
 * Extracts the tree of `sha` into `dir`, or into a new `opt2-archive-*` directory under `tmpRoot` (default
 * `os.tmpdir()`), and returns its absolute path. The target must lie outside the checkout and be absent or empty;
 * the intermediate `<dir>.tar` is always removed, and a directory this call created is removed when extraction fails.
 */
export async function gitArchiveExtract(
  sha: string,
  dir?: string,
  deps: GitDeps & { tmpRoot?: string } = {},
): Promise<string> {
  assertRevision(sha);
  const created = dir === undefined;
  const target = created
    ? await mkdtemp(path.join(assertOutsideRepo(deps.tmpRoot ?? os.tmpdir(), 'archive tmpRoot'), 'opt2-archive-'))
    : assertOutsideRepo(dir, 'archive target');
  const tarPath = assertOutsideRepo(`${target}.tar`, 'archive tar');

  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length > 0) {
    throw new Error(`archive target ${target} must be empty`);
  }

  try {
    await git(['archive', '--format=tar', `--output=${tarPath}`, sha], deps);
    await (deps.run ?? defaultRunner)('tar', ['-xf', tarPath, '-C', target], { cwd: target });
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(tarPath, { force: true });
  }
  return target;
}
