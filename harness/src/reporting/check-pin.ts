// Confirms the source pin, and checks that every deliverable added since the pin carries the pinned SHA.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { catFileExists, commitSubject, diffNames, lsFiles, lsTree, type GitDeps } from '../lib/git.js';
import { REPO_ROOT } from '../lib/paths.js';
import { readPin, type Pin } from '../lib/pin.js';

/** Injectable inputs: `root` is the checkout read and every git call's working directory (default `REPO_ROOT`). */
export interface PinDeps {
  root?: string;
  git?: GitDeps;
  /** Pin record to read; default `<root>/opt2/source-pin.json`. */
  pinPath?: string;
}

/** How a deliverable carries the SHA. */
export type ShaForm =
  | 'exempt'
  | 'markdown'
  | 'openapi'
  | 'yaml'
  | 'pin-json'
  | 'contract-json'
  | 'json'
  | 'html'
  | 'text';

/** Why a file's content could not be read in its form. */
export type ShaProblem = { kind: 'unparseable'; error: string } | { kind: 'unsupported-binary' };

/** SHA values located in a file's form, lower-cased. */
export interface ShaExtraction {
  form: ShaForm;
  found: string[];
  problem?: ShaProblem;
}

/** One failed assertion of either mode. */
export type PinFinding =
  | { kind: 'commit-missing' }
  | { kind: 'subject-mismatch'; expected: string; found: string }
  | { kind: 'tracked-file-changed'; path: string }
  | { kind: 'forbidden-tracked'; path: string }
  | { kind: 'file-missing'; path: string; form: ShaForm }
  | { kind: 'unreadable'; path: string; form: ShaForm; error: string }
  | { kind: 'missing'; path: string; form: ShaForm }
  | { kind: 'mismatch'; path: string; form: ShaForm; found: string[] }
  | { kind: 'unparseable'; path: string; form: ShaForm; error: string }
  | { kind: 'unsupported-binary'; path: string; form: ShaForm };

/** Outcome of {@link confirmPin}. */
export interface ConfirmResult {
  mode: 'confirm';
  sha: string;
  subject: string;
  ok: boolean;
  findings: PinFinding[];
}

/**
 * Outcome of {@link checkDeliverables}; `checked` counts the deliverables read, a deliverable absent from disk or
 * unreadable is a finding, and findings are sorted by path.
 */
export interface DeliverablesResult {
  mode: 'deliverables';
  sha: string;
  checked: number;
  ok: boolean;
  findings: PinFinding[];
}

const CONTRACTS_SEGMENT = /(^|\/)contracts\//;

/** Selection rule: a path not tracked at the pin is a deliverable when any pattern matches it. */
export const DELIVERABLE_PATTERNS: readonly { readonly glob: string; readonly regex: RegExp }[] = [
  { glob: '**/*.md', regex: /\.md$/ },
  { glob: '**/contracts/**', regex: CONTRACTS_SEGMENT },
  { glob: 'opt2/**', regex: /^opt2\// },
  { glob: 'harness/golden/sets/**', regex: /^harness\/golden\/sets\// },
];

/**
 * Prefixes no tracked path may have. Their contents (Masa's downloaded theme, screenshots) are runtime artefacts
 * that are never committed, so they are also never deliverables, whether tracked or not.
 */
export const FORBIDDEN_TRACKED_PREFIXES: readonly string[] = ['themes/default/', 'blitzy/'];

/** The `sites/<siteid>/` folder a path lies under. */
const SITE_FOLDER = /^sites\/[^/]+\//;

const PIN_RELATIVE_PATH = 'opt2/source-pin.json';
const USAGE = 'check-pin [--confirm] [--root <dir>]';
const HELP = `${USAGE} [--help]

Confirms the source pin, or checks that every deliverable added since the pin carries the pinned SHA.

Options:
  --confirm     confirm the pin instead: the pinned commit exists, its subject matches the pin record, and no file
                tracked at the pin is deleted, modified, renamed or type-changed (default: check deliverables)
  --root <dir>  checkout to check, resolved against the working directory (default: the repository root)
  --help        print this help and exit 0

Deliverables: the files not tracked at the pin that match ${DELIVERABLE_PATTERNS.map(({ glob }) => glob).join(', ')}.
Each must carry the SHA recorded in <root>/${PIN_RELATIVE_PATH}.
Runtime folders are not deliverables: nothing under ${FORBIDDEN_TRACKED_PREFIXES.join(' or ')} may be tracked, and untracked
files under a sites/<siteid>/ folder absent at the pin (a site Masa creates at runtime) are skipped.

Requires: git on PATH, and a checkout at <root> that holds the pinned commit and ${PIN_RELATIVE_PATH}.

Output: one JSON summary line on stdout. Exit: 0 no findings, 1 any finding or failure, 2 usage error.

Examples (from harness/):
  npm run check:pin
  npm run check:pin -- --confirm
  npm run --silent check:pin -- --root /path/to/other-checkout`;
const BINARY_SNIFF_LENGTH = 8192;

const HEX40 = /^[0-9a-fA-F]{40}$/;
const HEX40_TOKEN = /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const MARKDOWN_SHA_LINE = /^[ \t]*(?:[-*>][ \t]*)?(?:\*\*)?Source SHA(?:\*\*)?:(?:\*\*)?[ \t]*`?([0-9a-fA-F]{40})(?![0-9a-fA-F])/gm;
const COMMENT_SHA = /source-sha:[ \t]*([0-9a-fA-F]{40})(?![0-9a-fA-F])/g;

/** Whether `relPath` (repository-relative, forward slashes) matches {@link DELIVERABLE_PATTERNS}. */
export function isDeliverable(relPath: string): boolean {
  return DELIVERABLE_PATTERNS.some(({ regex }) => regex.test(relPath));
}

function isForbidden(relPath: string): boolean {
  return FORBIDDEN_TRACKED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/** Whether `relPath` lies under a `sites/<siteid>/` folder absent from `pinnedSites`: a site Masa creates at runtime. */
export function isRuntimeSitePath(relPath: string, pinnedSites: ReadonlySet<string>): boolean {
  const folder = SITE_FOLDER.exec(relPath)?.[0];
  return folder !== undefined && !pinnedSites.has(folder);
}

/** Form implied by `relPath` alone; {@link extractSha} refines `yaml` to `openapi` when the document has an `openapi` key. */
export function shaFormFor(relPath: string): ShaForm {
  const ext = path.posix.extname(relPath).toLowerCase();
  if (path.posix.basename(relPath) === '.gitkeep') return 'exempt';
  if (ext === '.md') return 'markdown';
  if (relPath === PIN_RELATIVE_PATH) return 'pin-json';
  if (ext === '.json') return CONTRACTS_SEGMENT.test(relPath) ? 'contract-json' : 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.html') return 'html';
  return 'text';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hexValues(...values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === 'string' && HEX40.test(v)).map((v) => v.toLowerCase());
}

function captures(regex: RegExp, text: string): string[] {
  return [...text.matchAll(regex)].flatMap((m) => (m[1] === undefined ? [] : [m[1].toLowerCase()]));
}

function hexTokens(text: string, pinned: string | undefined): string[] {
  const tokens = [...text.matchAll(HEX40_TOKEN)].map((m) => m[0].toLowerCase());
  const wanted = pinned?.toLowerCase();
  return wanted === undefined ? tokens : tokens.filter((token) => token === wanted);
}

function structuredShas(form: ShaForm, doc: unknown): string[] {
  const top = isRecord(doc) ? doc : {};
  switch (form) {
    case 'openapi':
      return isRecord(top.info) ? hexValues(top.info['x-source-sha']) : [];
    case 'yaml':
      return hexValues(top.sourceSha ?? top['x-source-sha']);
    case 'pin-json':
      return hexValues(top.sha);
    case 'contract-json':
      return typeof top.$comment === 'string' ? captures(COMMENT_SHA, top.$comment) : [];
    default:
      return hexValues(top.sourceSha);
  }
}

function fromDocument(form: 'yaml' | 'pin-json' | 'contract-json' | 'json', text: string): ShaExtraction {
  let doc: unknown;
  try {
    doc = form === 'yaml' ? parseYaml(text) : JSON.parse(text);
  } catch (err) {
    return { form, found: [], problem: { kind: 'unparseable', error: err instanceof Error ? err.message : String(err) } };
  }
  const resolved: ShaForm = form === 'yaml' && isRecord(doc) && Object.hasOwn(doc, 'openapi') ? 'openapi' : form;
  return { form: resolved, found: structuredShas(resolved, doc) };
}

/**
 * Every SHA `relPath` carries in its form. `html` and `text` list standalone 40-hex tokens, only those equal to
 * `pinned` when it is given; a `text` file with a NUL byte in its first 8 KiB yields an `unsupported-binary` problem.
 */
export function extractSha(relPath: string, content: string, pinned?: string): ShaExtraction {
  const form = shaFormFor(relPath);
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  switch (form) {
    case 'exempt':
      return { form, found: [] };
    case 'markdown':
      return { form, found: captures(MARKDOWN_SHA_LINE, text) };
    case 'html':
      return { form, found: hexTokens(text, pinned) };
    case 'text':
      if (text.slice(0, BINARY_SNIFF_LENGTH).includes('\0')) {
        return { form, found: [], problem: { kind: 'unsupported-binary' } };
      }
      return { form, found: hexTokens(text, pinned) };
    case 'openapi':
    case 'yaml':
      return fromDocument('yaml', text);
    default:
      return fromDocument(form, text);
  }
}

function verdict(relPath: string, extraction: ShaExtraction, sha: string): PinFinding | null {
  const { form, found, problem } = extraction;
  if (problem !== undefined) return { ...problem, path: relPath, form };
  if (form === 'exempt') return null;
  if (found.length === 0) return { kind: 'missing', path: relPath, form };
  if (found.some((value) => value !== sha)) return { kind: 'mismatch', path: relPath, form, found: [...new Set(found)] };
  return null;
}

function resolveDeps(deps: PinDeps): { root: string; git: GitDeps; pin: Pin } {
  const root = deps.root ?? REPO_ROOT;
  return {
    root,
    git: { ...deps.git, cwd: root },
    pin: readPin({ path: deps.pinPath ?? path.join(root, PIN_RELATIVE_PATH) }),
  };
}

/** Content of the deliverable at `relPath` under `root`, or the finding that it is absent or cannot be read. */
async function readDeliverable(root: string, relPath: string): Promise<{ content: string } | { finding: PinFinding }> {
  try {
    return { content: await fs.readFile(path.join(root, relPath), 'utf8') };
  } catch (err) {
    const at = { path: relPath, form: shaFormFor(relPath) };
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { finding: { kind: 'file-missing', ...at } };
    return { finding: { kind: 'unreadable', ...at, error: err instanceof Error ? err.message : String(err) } };
  }
}

/** Confirms the pinned commit exists, has the recorded subject, and that no file tracked at it is changed or gone. */
export async function confirmPin(deps: PinDeps = {}): Promise<ConfirmResult> {
  const { git, pin } = resolveDeps(deps);
  const findings: PinFinding[] = [];

  // The subject and the diff both need the commit object.
  if (!(await catFileExists(pin.sha, git))) {
    findings.push({ kind: 'commit-missing' });
  } else {
    const subject = await commitSubject(pin.sha, git);
    if (subject !== pin.subject) findings.push({ kind: 'subject-mismatch', expected: pin.subject, found: subject });
    for (const changed of await diffNames(pin.sha, 'DMRT', git)) {
      findings.push({ kind: 'tracked-file-changed', path: changed });
    }
  }

  return { mode: 'confirm', sha: pin.sha, subject: pin.subject, ok: findings.length === 0, findings };
}

/** Checks every deliverable for the pinned SHA, skipping untracked files of Masa runtime sites, and that no forbidden path is tracked. */
export async function checkDeliverables(deps: PinDeps = {}): Promise<DeliverablesResult> {
  const { root, git, pin } = resolveDeps(deps);
  const [listed, atPin, tracked] = await Promise.all([
    lsFiles({ cached: true, others: true, excludeStandard: true }, git),
    lsTree(pin.sha, git),
    lsFiles({ cached: true }, git),
  ]);

  const findings: PinFinding[] = [...new Set(tracked)]
    .filter(isForbidden)
    .map((forbidden): PinFinding => ({ kind: 'forbidden-tracked', path: forbidden }));

  const pinned = new Set(atPin);
  const pinnedSites = new Set(atPin.flatMap((relPath) => SITE_FOLDER.exec(relPath)?.[0] ?? []));
  const trackedNow = new Set(tracked);
  const deliverables = [...new Set(listed)]
    .filter(
      (relPath) =>
        !pinned.has(relPath) &&
        !isForbidden(relPath) &&
        (trackedNow.has(relPath) || !isRuntimeSitePath(relPath, pinnedSites)) &&
        isDeliverable(relPath),
    )
    .sort();

  let checked = 0;
  for (const relPath of deliverables) {
    const read = await readDeliverable(root, relPath);
    if ('finding' in read) {
      findings.push(read.finding);
      continue;
    }
    checked += 1;
    const finding = verdict(relPath, extractSha(relPath, read.content, pin.sha), pin.sha);
    if (finding !== null) findings.push(finding);
  }

  const pathOf = (finding: PinFinding): string => ('path' in finding ? finding.path : '');
  findings.sort((a, b) => (pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : 0));
  return { mode: 'deliverables', sha: pin.sha, checked, ok: findings.length === 0, findings };
}

/** CLI entry: `--confirm` confirms the pin, otherwise deliverables are checked; `--root <dir>` checks another checkout. Exit 1 on any finding. */
export async function main(argv: string[], deps: PinDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: { confirm: { type: 'boolean' }, root: { type: 'string' } },
    usage: USAGE,
    help: HELP,
  });
  if (values.root === '') throw new UsageError('--root needs a directory', USAGE);
  const root = values.root === undefined ? (deps.root ?? REPO_ROOT) : path.resolve(values.root);
  const options: PinDeps = { ...deps, root };
  const result = values.confirm === true ? await confirmPin(options) : await checkDeliverables(options);
  return { code: result.ok ? 0 : 1, summary: { root, ...result } };
}

if (isMainModule(import.meta.url)) void runCli(main);
