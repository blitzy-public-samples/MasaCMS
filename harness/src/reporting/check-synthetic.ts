// Checks that every source file and README of a synthetic module carries its SYNTHETIC label.
import fs from 'node:fs/promises';
import path from 'node:path';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { REPO_ROOT } from '../lib/paths.js';

/** Synthetic module roots, repository-relative with forward slashes. */
export const SYNTHETIC_ROOTS: readonly string[] = [
  'services/communications',
  'services/reporting',
  'services/surveys',
  'services/timesheets',
  'services/finance',
  'services/e-signature',
  'legacy-fixtures',
  'web/app/opt2',
  'web/src/screens/opt2',
];

/** Directories never walked: a directory name, or a `parent/name` pair such as `src/generated`. */
export const SKIPPED_DIRS: readonly string[] = ['node_modules', 'dist', 'coverage', '.next', '.git', 'src/generated'];

/** Accepted header-line prefixes per labelled file extension. */
export const LABEL_PREFIXES: Record<string, string[]> = {
  '.ts': ['// SYNTHETIC: '],
  '.tsx': ['// SYNTHETIC: '],
  '.sql': ['-- SYNTHETIC: '],
  '.cfc': ['<!--- SYNTHETIC: ', '// SYNTHETIC: '],
  '.cfm': ['<!--- SYNTHETIC: ', '// SYNTHETIC: '],
  '.sh': ['# SYNTHETIC: '],
};

/** Opening of the first non-blank line of every synthetic README. */
export const README_LABEL = '**SYNTHETIC MODULE**';

/** How a file is checked: header line, README opening, or not at all. */
export type FileClass = 'labelled' | 'readme' | 'exempt';

/** Why a file fails the check. */
export type SyntheticFindingKind = 'missing-label' | 'wrong-syntax' | 'missing-readme-label';

/** One unlabelled file; `expected` lists the openings its type accepts. */
export interface SyntheticFinding {
  path: string;
  kind: SyntheticFindingKind;
  expected: string[];
}

/** Outcome of {@link checkSynthetic}; findings are sorted by path. */
export interface SyntheticCheckResult {
  ok: boolean;
  checked: Record<FileClass, number>;
  rootsMissing: string[];
  findings: SyntheticFinding[];
}

const USAGE = 'check-synthetic [--root <dir>]';

// A SYNTHETIC: header behind another comment marker, or behind none.
const MISPLACED_LABEL = /^\W*SYNTHETIC:/;

function extensionOf(relPath: string): string {
  return path.posix.extname(relPath).toLowerCase();
}

/** Class of `relPath`: `readme` for a `README.md`, `labelled` for an extension in {@link LABEL_PREFIXES}, else `exempt`. */
export function classifyFile(relPath: string): FileClass {
  if (path.posix.basename(relPath) === 'README.md') return 'readme';
  return LABEL_PREFIXES[extensionOf(relPath)] === undefined ? 'exempt' : 'labelled';
}

/**
 * Finding for file `relPath` holding `content`, or `null` when it is labelled or exempt.
 * The header is line 1, or line 2 when line 1 is a `#!` shebang (never required); it needs text after its prefix.
 */
export function checkLabel(relPath: string, content: string): SyntheticFinding | null {
  const fileClass = classifyFile(relPath);
  if (fileClass === 'exempt') return null;
  const lines = (content.startsWith('\uFEFF') ? content.slice(1) : content).split(/\r?\n/);

  if (fileClass === 'readme') {
    const first = lines.find((line) => line.trim() !== '');
    if (first?.startsWith(README_LABEL)) return null;
    return { path: relPath, kind: 'missing-readme-label', expected: [README_LABEL] };
  }

  const prefixes = LABEL_PREFIXES[extensionOf(relPath)] ?? [];
  const header = (lines[0]?.startsWith('#!') ? lines[1] : lines[0]) ?? '';
  const prefix = prefixes.find((candidate) => header.startsWith(candidate));
  if (prefix !== undefined && header.slice(prefix.length).trim() !== '') return null;
  const kind = prefix === undefined && MISPLACED_LABEL.test(header) ? 'wrong-syntax' : 'missing-label';
  return { path: relPath, kind, expected: [...prefixes] };
}

function isSkippedDir(relDir: string): boolean {
  const segments = relDir.split('/');
  return SKIPPED_DIRS.includes(segments.at(-1) ?? '') || SKIPPED_DIRS.includes(segments.slice(-2).join('/'));
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// Symlinks are not followed: a link cannot carry its own label, and a target inside a root is checked there.
async function collectFiles(base: string, relDir: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(path.join(base, relDir), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!isSkippedDir(relPath)) await collectFiles(base, relPath, files);
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
}

/** Checks every file under each of {@link SYNTHETIC_ROOTS} in `opts.root` (default the checkout); absent roots are listed, not failed. */
export async function checkSynthetic(opts: { root?: string } = {}): Promise<SyntheticCheckResult> {
  const base = opts.root ?? REPO_ROOT;
  const checked: Record<FileClass, number> = { labelled: 0, readme: 0, exempt: 0 };
  const rootsMissing: string[] = [];
  const findings: SyntheticFinding[] = [];

  for (const root of SYNTHETIC_ROOTS) {
    if (!(await exists(path.join(base, root)))) {
      rootsMissing.push(root);
      continue;
    }
    const files: string[] = [];
    await collectFiles(base, root, files);
    for (const relPath of files) {
      const fileClass = classifyFile(relPath);
      checked[fileClass] += 1;
      if (fileClass === 'exempt') continue;
      const finding = checkLabel(relPath, await fs.readFile(path.join(base, relPath), 'utf8'));
      if (finding !== null) findings.push(finding);
    }
  }

  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: findings.length === 0, checked, rootsMissing, findings };
}

/** CLI entry; `--root <dir>` checks another tree. Exit 1 when any file lacks its label. */
export async function main(argv: string[]): Promise<CliOutcome> {
  const { values } = parseFlags(argv, { options: { root: { type: 'string' } }, usage: USAGE });
  if (values.root === '') throw new UsageError('--root needs a directory', USAGE);
  const root = values.root === undefined ? REPO_ROOT : path.resolve(values.root);
  const result = await checkSynthetic({ root });
  return { code: result.ok ? 0 : 1, summary: { root, ...result } };
}

if (isMainModule(import.meta.url)) void runCli(main);
