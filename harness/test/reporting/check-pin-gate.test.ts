import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/lib/cli.js';
import type { ProcessRunner } from '../../src/lib/git.js';
import { REPO_ROOT, isInsideRepo } from '../../src/lib/paths.js';
import { PIN_PATH, PinError, pinnedSha, readPin } from '../../src/lib/pin.js';
import {
  DELIVERABLE_PATTERNS,
  FORBIDDEN_TRACKED_PREFIXES,
  checkDeliverables,
  confirmPin,
  extractSha,
  isDeliverable,
  main,
  shaFormFor,
} from '../../src/reporting/check-pin.js';
import type { PinDeps, PinFinding, ShaExtraction, ShaForm, ShaProblem } from '../../src/reporting/check-pin.js';

const PIN = readPin();
const SHA = pinnedSha();
const HEX_DIGITS = '0123456789abcdef';
/** A 40-hex SHA that differs from the pinned one in every digit. */
const OTHER_SHA = [...SHA].map((digit) => HEX_DIGITS.charAt((HEX_DIGITS.indexOf(digit) + 1) % 16)).join('');

const COMMAND = 'harness/src/reporting/check-pin.ts';
const USAGE = 'check-pin [--confirm] [--root <dir>]';
const PIN_REL = 'opt2/source-pin.json';
const gitInstalled = spawnSync('git', ['--version']).status === 0;

const CAT_FILE = `git cat-file -e ${SHA}^{commit}`;
const LOG_SUBJECT = `git log -1 --format=%s ${SHA}`;
const DIFF_DMRT = `git diff --name-only -z --diff-filter=DMRT ${SHA}`;
const LS_LISTED = 'git ls-files -z --cached --others --exclude-standard';
const LS_TREE = `git ls-tree -r --name-only -z ${SHA}`;
const LS_TRACKED = 'git ls-files -z --cached';

/** A git reply: its stdout, or the exit status and stderr of a failed command. */
type Reply = string | { exitCode: number; stderr: string };

interface Call {
  file: string;
  args: string[];
  cwd: string;
}

const unconfigured: string[] = [];

/** Runner answering each `file args…` command line from `replies`; any other command is recorded and rejected. */
function fakeRunner(replies: Record<string, Reply>): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProcessRunner = async (file, args, opts) => {
    const command = [file, ...args].join(' ');
    calls.push({ file, args: [...args], cwd: opts.cwd });
    const reply = replies[command];
    if (reply === undefined) {
      unconfigured.push(command);
      throw new Error(`unconfigured call: ${command}`);
    }
    if (typeof reply === 'string') return { stdout: reply, stderr: '' };
    throw Object.assign(new Error(`Command failed: ${command}\n${reply.stderr}`), {
      code: reply.exitCode,
      stdout: '',
      stderr: reply.stderr,
    });
  };
  return { run, calls };
}

/** `paths` as git prints them with `-z`. */
function nul(...paths: string[]): string {
  return paths.map((p) => `${p}\0`).join('');
}

/** Replies of a pin that confirms; `overrides` replace single commands. */
function confirmReplies(overrides: Record<string, Reply> = {}): Record<string, Reply> {
  return { [CAT_FILE]: '', [LOG_SUBJECT]: `${PIN.subject}\n`, [DIFF_DMRT]: '', ...overrides };
}

/** Replies of the three listings `checkDeliverables` makes. */
function listingReplies(listing: { listed: string[]; atPin?: string[]; tracked?: string[] }): Record<string, Reply> {
  return {
    [LS_LISTED]: nul(...listing.listed),
    [LS_TREE]: nul(...(listing.atPin ?? [])),
    [LS_TRACKED]: nul(...(listing.tracked ?? [])),
  };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-check-pin-gate-'));
  expect(isInsideRepo(root)).toBe(false);
  await fs.mkdir(path.join(root, 'opt2'), { recursive: true });
  await fs.copyFile(PIN_PATH, path.join(root, PIN_REL));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  expect(unconfigured.splice(0)).toEqual([]);
});

/** Writes `content` to `rel` under the per-test root, creating parent directories. */
async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function writeTree(tree: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(tree)) await write(rel, content);
}

/** Spy on the reads `checkDeliverables` makes, as paths relative to the per-test root. */
function spyReads(): () => string[] {
  const spy = vi.spyOn(fs, 'readFile');
  return () => spy.mock.calls.map(([file]) => path.relative(root, String(file)).split(path.sep).join('/'));
}

describe('confirmPin', () => {
  it('passes when the commit exists, its subject matches and no tracked file changed', async () => {
    const { run, calls } = fakeRunner(confirmReplies());
    await expect(confirmPin({ root, git: { run } })).resolves.toEqual({
      mode: 'confirm',
      sha: SHA,
      subject: PIN.subject,
      ok: true,
      findings: [],
    });
    expect(calls.map((call) => [call.file, ...call.args].join(' '))).toEqual([CAT_FILE, LOG_SUBJECT, DIFF_DMRT]);
    expect(calls.every((call) => call.cwd === root)).toBe(true);
  });

  it('diffs the working tree against the pinned commit for deleted, modified, renamed and type-changed names only', async () => {
    const { run, calls } = fakeRunner(confirmReplies());
    await confirmPin({ root, git: { run } });
    const diff = calls.find((call) => call.args[0] === 'diff');
    expect(diff?.file).toBe('git');
    expect(diff?.args).toEqual(['diff', '--name-only', '-z', '--diff-filter=DMRT', SHA]);
  });

  it('reports commit-missing and asks nothing further when git cannot find the commit', async () => {
    const { run, calls } = fakeRunner(
      confirmReplies({ [CAT_FILE]: { exitCode: 128, stderr: `fatal: Not a valid object name ${SHA}^{commit}` } }),
    );
    await expect(confirmPin({ root, git: { run } })).resolves.toEqual({
      mode: 'confirm',
      sha: SHA,
      subject: PIN.subject,
      ok: false,
      findings: [{ kind: 'commit-missing' }],
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a subject mismatch with the recorded and the actual subject', async () => {
    const { run } = fakeRunner(confirmReplies({ [LOG_SUBJECT]: 'Rewrite history\n' }));
    const result = await confirmPin({ root, git: { run } });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([{ kind: 'subject-mismatch', expected: PIN.subject, found: 'Rewrite history' }]);
  });

  it('reports every tracked file the DMRT diff names, in git order', async () => {
    const { run } = fakeRunner(
      confirmReplies({ [DIFF_DMRT]: nul('core/mura/configBean.cfc', 'admin/Application.cfc', 'dir/with space.cfm') }),
    );
    const result = await confirmPin({ root, git: { run } });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { kind: 'tracked-file-changed', path: 'core/mura/configBean.cfc' },
      { kind: 'tracked-file-changed', path: 'admin/Application.cfc' },
      { kind: 'tracked-file-changed', path: 'dir/with space.cfm' },
    ]);
  });

  it('reads the pin record from pinPath instead of the root', async () => {
    const pinPath = path.join(root, 'alternate-pin.json');
    await fs.writeFile(pinPath, JSON.stringify({ ...PIN, subject: 'Alternate subject' }));
    const { run } = fakeRunner(confirmReplies({ [LOG_SUBJECT]: 'Alternate subject\n' }));
    const result = await confirmPin({ root, git: { run }, pinPath });
    expect(result).toMatchObject({ ok: true, subject: 'Alternate subject', findings: [] });
  });

  it('rejects with PinError, before any git call, when the root has no pin record', async () => {
    await fs.rm(path.join(root, PIN_REL));
    const { run, calls } = fakeRunner(confirmReplies());
    await expect(confirmPin({ root, git: { run } })).rejects.toBeInstanceOf(PinError);
    expect(calls).toEqual([]);
  });

  it('rejects, rather than reporting the commit missing, when git cannot be started', async () => {
    const run: ProcessRunner = async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    };
    await expect(confirmPin({ root, git: { run } })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('deliverable selection', () => {
  it('DELIVERABLE_PATTERNS are the markdown, contracts, opt2 and golden-set globs', () => {
    expect(DELIVERABLE_PATTERNS.map(({ glob }) => glob)).toEqual([
      '**/*.md',
      '**/contracts/**',
      'opt2/**',
      'harness/golden/sets/**',
    ]);
  });

  it('FORBIDDEN_TRACKED_PREFIXES are the downloaded theme and the screenshot folder', () => {
    expect(FORBIDDEN_TRACKED_PREFIXES).toEqual(['themes/default/', 'blitzy/']);
  });

  it.each<[string, boolean]>([
    ['README.md', true],
    ['services/people/TRACEABILITY.md', true],
    ['migration/runbooks/rollback.md', true],
    ['contracts/openapi.yaml', true],
    ['services/people/contracts/openapi.yaml', true],
    ['platform/contracts/events/envelope.v1.json', true],
    ['opt2/inventory/legacy-inventory.json', true],
    ['opt2/executive-summary/index.html', true],
    ['harness/golden/sets/GS-ID-01/response.json', true],
    ['harness/src/reporting/check-pin.ts', false],
    ['harness/golden/catalogue.yaml', false],
    ['harness/golden/setsx/GS-ID-01/response.json', false],
    ['services/people/src/contracts.ts', false],
    ['services/people/mycontracts/openapi.yaml', false],
    ['web/opt2/page.tsx', false],
    ['services/people/README.mdx', false],
  ])('isDeliverable(%s) is %s', (relPath, expected) => {
    expect(isDeliverable(relPath)).toBe(expected);
  });

  it('checks only listed deliverables not tracked at the pin, once each, without reading pin-tracked files', async () => {
    await writeTree({
      'README.md': '# Masa CMS\n',
      'core/docs/notes.md': 'Legacy notes\n',
      'opt2/inventory/legacy-inventory.md': `# Legacy inventory\n\nSource SHA: ${SHA}\n`,
      'harness/src/reporting/check-pin.ts': 'export {};\n',
    });
    const { run, calls } = fakeRunner(
      listingReplies({
        listed: [
          'README.md',
          'core/docs/notes.md',
          'opt2/inventory/legacy-inventory.md',
          'opt2/inventory/legacy-inventory.md',
          PIN_REL,
          'harness/src/reporting/check-pin.ts',
        ],
        atPin: ['README.md', 'core/docs/notes.md', 'core/mura/configBean.cfc'],
        tracked: ['README.md', 'core/docs/notes.md', 'core/mura/configBean.cfc'],
      }),
    );
    const reads = spyReads();
    const result = await checkDeliverables({ root, git: { run } });
    expect(result).toEqual({ mode: 'deliverables', sha: SHA, checked: 2, ok: true, findings: [] });
    expect(reads()).toEqual(['opt2/inventory/legacy-inventory.md', PIN_REL]);
    expect(calls.map((call) => [call.file, ...call.args].join(' ')).sort()).toEqual(
      [LS_LISTED, LS_TREE, LS_TRACKED].sort(),
    );
    expect(calls.every((call) => call.cwd === root)).toBe(true);
  });
});

describe('shaFormFor', () => {
  it.each<[string, ShaForm]>([
    ['opt2/.gitkeep', 'exempt'],
    ['harness/golden/sets/.gitkeep', 'exempt'],
    ['services/people/README.md', 'markdown'],
    ['opt2/reports/SPEED.MD', 'markdown'],
    [PIN_REL, 'pin-json'],
    ['opt2/archive/source-pin.json', 'json'],
    ['services/people/contracts/events/person.created.v1.json', 'contract-json'],
    ['contracts/events/envelope.v1.json', 'contract-json'],
    ['opt2/reports/speed.json', 'json'],
    ['harness/golden/sets/GS-ID-01/response.json', 'json'],
    ['services/people/contracts/openapi.yaml', 'yaml'],
    ['harness/golden/sets/GS-ID-01/scenario.yml', 'yaml'],
    ['opt2/executive-summary/index.html', 'html'],
    ['opt2/inventory/cloc.csv', 'text'],
    ['harness/golden/sets/GS-ID-01/body', 'text'],
  ])('%s carries its SHA in the %s form', (relPath, form) => {
    expect(shaFormFor(relPath)).toBe(form);
  });
});

describe('extractSha', () => {
  const NOT_PARSED: ShaProblem = { kind: 'unparseable', error: expect.any(String) };

  it.each<{ label: string; relPath: string; content: string; pinned?: string; expected: ShaExtraction }>([
    {
      label: 'a markdown Source SHA line',
      relPath: 'opt2/reports/speed.md',
      content: `# Speed\n\nSource SHA: ${SHA}\n`,
      expected: { form: 'markdown', found: [SHA] },
    },
    {
      label: 'a bold, backticked Source SHA list item',
      relPath: 'services/people/README.md',
      content: `# People\n\n- **Source SHA:** \`${SHA}\`\n`,
      expected: { form: 'markdown', found: [SHA] },
    },
    {
      label: 'a quoted Source SHA label with the colon outside the bold',
      relPath: 'services/people/TRACEABILITY.md',
      content: `> **Source SHA**: ${SHA}\n`,
      expected: { form: 'markdown', found: [SHA] },
    },
    {
      label: 'an upper-case markdown SHA, lower-cased',
      relPath: 'opt2/reports/speed.md',
      content: `Source SHA: ${SHA.toUpperCase()}\n`,
      expected: { form: 'markdown', found: [SHA] },
    },
    {
      label: 'every Source SHA line of a markdown file',
      relPath: 'opt2/reports/speed.md',
      content: `Source SHA: ${SHA}\n\n## Appendix\n\nSource SHA: ${OTHER_SHA}\n`,
      expected: { form: 'markdown', found: [SHA, OTHER_SHA] },
    },
    {
      label: 'a Source SHA line behind a byte-order mark',
      relPath: 'opt2/reports/speed.md',
      content: `\uFEFFSource SHA: ${SHA}\n`,
      expected: { form: 'markdown', found: [SHA] },
    },
    {
      label: 'no markdown SHA outside a Source SHA line',
      relPath: 'opt2/reports/speed.md',
      content: `Built from ${SHA}.\n`,
      expected: { form: 'markdown', found: [] },
    },
    {
      label: 'no markdown SHA when the label is mid-line',
      relPath: 'opt2/reports/speed.md',
      content: `See the Source SHA: ${SHA}\n`,
      expected: { form: 'markdown', found: [] },
    },
    {
      label: 'no markdown SHA from a 41-digit hex value',
      relPath: 'opt2/reports/speed.md',
      content: `Source SHA: ${SHA}0\n`,
      expected: { form: 'markdown', found: [] },
    },
    {
      label: 'an OpenAPI info.x-source-sha',
      relPath: 'services/people/contracts/openapi.yaml',
      content: `openapi: 3.1.0\ninfo:\n  title: people\n  version: 1.0.0\n  x-source-sha: "${SHA}"\n`,
      expected: { form: 'openapi', found: [SHA] },
    },
    {
      label: 'no OpenAPI SHA at the document top level',
      relPath: 'services/people/contracts/openapi.yaml',
      content: `openapi: 3.1.0\nx-source-sha: "${SHA}"\ninfo:\n  title: people\n`,
      expected: { form: 'openapi', found: [] },
    },
    {
      label: 'no OpenAPI SHA when info is not a mapping',
      relPath: 'services/people/contracts/openapi.yaml',
      content: `openapi: 3.1.0\ninfo: "${SHA}"\n`,
      expected: { form: 'openapi', found: [] },
    },
    {
      label: 'no OpenAPI SHA from a value that is not 40 hex digits',
      relPath: 'services/people/contracts/openapi.yaml',
      content: `openapi: 3.1.0\ninfo:\n  x-source-sha: "${SHA.slice(0, 12)}"\n`,
      expected: { form: 'openapi', found: [] },
    },
    {
      label: 'a YAML top-level sourceSha',
      relPath: 'harness/golden/sets/GS-ID-01/scenario.yaml',
      content: `id: GS-ID-01\nsourceSha: "${SHA}"\n`,
      expected: { form: 'yaml', found: [SHA] },
    },
    {
      label: 'a YAML top-level x-source-sha',
      relPath: 'harness/golden/sets/GS-ID-01/scenario.yml',
      content: `x-source-sha: "${SHA}"\n`,
      expected: { form: 'yaml', found: [SHA] },
    },
    {
      label: 'no YAML SHA nested below the top level',
      relPath: 'harness/golden/sets/GS-ID-01/scenario.yaml',
      content: `meta:\n  sourceSha: "${SHA}"\n`,
      expected: { form: 'yaml', found: [] },
    },
    {
      label: 'no YAML SHA from a sequence document',
      relPath: 'harness/golden/sets/GS-ID-01/scenario.yaml',
      content: `- "${SHA}"\n`,
      expected: { form: 'yaml', found: [] },
    },
    {
      label: 'an unparseable YAML problem',
      relPath: 'harness/golden/sets/GS-ID-01/scenario.yaml',
      content: 'steps: [unclosed\n',
      expected: { form: 'yaml', found: [], problem: NOT_PARSED },
    },
    {
      label: 'the sha of the pin record',
      relPath: PIN_REL,
      content: JSON.stringify(PIN),
      expected: { form: 'pin-json', found: [SHA] },
    },
    {
      label: 'a differing sha of the pin record',
      relPath: PIN_REL,
      content: JSON.stringify({ sha: OTHER_SHA }),
      expected: { form: 'pin-json', found: [OTHER_SHA] },
    },
    {
      label: 'no SHA from a pin record carrying only sourceSha',
      relPath: PIN_REL,
      content: JSON.stringify({ sourceSha: SHA }),
      expected: { form: 'pin-json', found: [] },
    },
    {
      label: 'no SHA from a pin record without one',
      relPath: PIN_REL,
      content: '{}',
      expected: { form: 'pin-json', found: [] },
    },
    {
      label: 'an event schema $comment source-sha',
      relPath: 'services/people/contracts/events/person.created.v1.json',
      content: JSON.stringify({ $comment: `source-sha: ${SHA}`, type: 'object' }),
      expected: { form: 'contract-json', found: [SHA] },
    },
    {
      label: 'no event schema SHA from a $comment without the source-sha label',
      relPath: 'services/people/contracts/events/person.created.v1.json',
      content: JSON.stringify({ $comment: SHA }),
      expected: { form: 'contract-json', found: [] },
    },
    {
      label: 'no event schema SHA from a sourceSha field',
      relPath: 'services/people/contracts/events/person.created.v1.json',
      content: JSON.stringify({ sourceSha: SHA }),
      expected: { form: 'contract-json', found: [] },
    },
    {
      label: 'no event schema SHA from a $comment that is not a string',
      relPath: 'services/people/contracts/events/person.created.v1.json',
      content: JSON.stringify({ $comment: [`source-sha: ${SHA}`] }),
      expected: { form: 'contract-json', found: [] },
    },
    {
      label: 'a JSON report sourceSha',
      relPath: 'opt2/reports/speed.json',
      content: JSON.stringify({ sourceSha: SHA, rows: [] }),
      expected: { form: 'json', found: [SHA] },
    },
    {
      label: 'a JSON report sourceSha behind a byte-order mark',
      relPath: 'opt2/reports/speed.json',
      content: `\uFEFF${JSON.stringify({ sourceSha: SHA })}`,
      expected: { form: 'json', found: [SHA] },
    },
    {
      label: 'no JSON SHA nested below the top level',
      relPath: 'opt2/reports/speed.json',
      content: JSON.stringify({ report: { sourceSha: SHA } }),
      expected: { form: 'json', found: [] },
    },
    {
      label: 'no JSON SHA from an array document',
      relPath: 'harness/golden/sets/GS-ID-01/response.json',
      content: JSON.stringify([{ sourceSha: SHA }]),
      expected: { form: 'json', found: [] },
    },
    {
      label: 'no JSON SHA from a sourceSha that is not hex',
      relPath: 'opt2/reports/speed.json',
      content: JSON.stringify({ sourceSha: 'unknown' }),
      expected: { form: 'json', found: [] },
    },
    {
      label: 'an unparseable JSON problem',
      relPath: 'opt2/reports/speed.json',
      content: '{"sourceSha":',
      expected: { form: 'json', found: [], problem: NOT_PARSED },
    },
    {
      label: 'only the pinned SHA among the HTML tokens',
      relPath: 'opt2/executive-summary/index.html',
      content: `<p class="eyebrow">${OTHER_SHA}</p><p>${SHA}</p>`,
      pinned: SHA,
      expected: { form: 'html', found: [SHA] },
    },
    {
      label: 'every standalone HTML token when no SHA is pinned',
      relPath: 'opt2/executive-summary/index.html',
      content: `<p>${OTHER_SHA}</p><p>${SHA.toUpperCase()}</p>`,
      expected: { form: 'html', found: [OTHER_SHA, SHA] },
    },
    {
      label: 'no HTML SHA embedded in a longer hex run',
      relPath: 'opt2/executive-summary/index.html',
      content: `<p>${SHA}ab</p>`,
      pinned: SHA,
      expected: { form: 'html', found: [] },
    },
    {
      label: 'the pinned SHA in a text file',
      relPath: 'harness/golden/sets/GS-ID-01/body.csv',
      content: `sha,${SHA}\n`,
      pinned: SHA,
      expected: { form: 'text', found: [SHA] },
    },
    {
      label: 'an unsupported-binary problem for a NUL byte in the first 8 KiB',
      relPath: 'harness/golden/sets/GS-ID-01/body',
      content: `\0${SHA}`,
      pinned: SHA,
      expected: { form: 'text', found: [], problem: { kind: 'unsupported-binary' } },
    },
    {
      label: 'text scanning past a NUL byte beyond the first 8 KiB',
      relPath: 'harness/golden/sets/GS-ID-01/body',
      content: `${'x'.repeat(8192)}\0${SHA}`,
      pinned: SHA,
      expected: { form: 'text', found: [SHA] },
    },
    {
      label: 'nothing from an exempt placeholder',
      relPath: 'opt2/inventory/.gitkeep',
      content: OTHER_SHA,
      pinned: SHA,
      expected: { form: 'exempt', found: [] },
    },
  ])('yields $label', ({ relPath, content, pinned, expected }) => {
    expect(extractSha(relPath, content, pinned)).toEqual(expected);
  });
});

describe('checkDeliverables', () => {
  const CORRECT: Record<string, string> = {
    'opt2/inventory/legacy-inventory.md': `# Legacy inventory\n\nSource SHA: ${SHA}\n`,
    'opt2/inventory/.gitkeep': '',
    'opt2/reports/speed.json': JSON.stringify({ sourceSha: SHA, rows: [] }),
    'opt2/executive-summary/index.html': `<p class="eyebrow">${SHA}</p>`,
    'services/people/contracts/openapi.yaml': `openapi: 3.1.0\ninfo:\n  title: people\n  x-source-sha: "${SHA}"\n`,
    'services/people/contracts/events/person.created.v1.json': JSON.stringify({ $comment: `source-sha: ${SHA}` }),
    'harness/golden/sets/GS-ID-01/scenario.yaml': `sourceSha: "${SHA}"\n`,
    'harness/golden/sets/GS-ID-01/body.csv': `sha,${SHA}\n`,
  };

  it('finds nothing when every deliverable carries the pinned SHA in its form', async () => {
    await writeTree(CORRECT);
    const listed = [...Object.keys(CORRECT), PIN_REL];
    const { run } = fakeRunner(listingReplies({ listed, tracked: listed }));
    const reads = spyReads();
    await expect(checkDeliverables({ root, git: { run } })).resolves.toEqual({
      mode: 'deliverables',
      sha: SHA,
      checked: listed.length,
      ok: true,
      findings: [],
    });
    expect(reads()).toEqual([...listed].sort());
  });

  it('reports missing, wrong, unparseable and binary deliverables, sorted by path', async () => {
    const tree: Record<string, string> = {
      'services/people/README.md': '# People\n',
      'services/people/TRACEABILITY.md': `Source SHA: ${OTHER_SHA}\n`,
      'services/people/contracts/openapi.yaml': `openapi: 3.1.0\nx-source-sha: "${SHA}"\ninfo:\n  title: people\n`,
      'opt2/reports/speed.json': JSON.stringify({ sourceSha: OTHER_SHA }),
      'opt2/reports/broken.json': '{"sourceSha":',
      'opt2/reports/twice.md': `Source SHA: ${SHA}\nSource SHA: ${OTHER_SHA}\nSource SHA: ${OTHER_SHA}\n`,
      'opt2/executive-summary/index.html': `<p>${OTHER_SHA}</p>`,
      'harness/golden/sets/GS-ID-01/body': `\0${SHA}`,
    };
    await writeTree(tree);
    const { run } = fakeRunner(listingReplies({ listed: Object.keys(tree) }));
    const result = await checkDeliverables({ root, git: { run } });
    expect(result).toMatchObject({ mode: 'deliverables', sha: SHA, checked: 8, ok: false });
    expect(result.findings).toEqual<PinFinding[]>([
      { kind: 'unsupported-binary', path: 'harness/golden/sets/GS-ID-01/body', form: 'text' },
      { kind: 'missing', path: 'opt2/executive-summary/index.html', form: 'html' },
      { kind: 'unparseable', path: 'opt2/reports/broken.json', form: 'json', error: expect.any(String) },
      { kind: 'mismatch', path: 'opt2/reports/speed.json', form: 'json', found: [OTHER_SHA] },
      { kind: 'mismatch', path: 'opt2/reports/twice.md', form: 'markdown', found: [SHA, OTHER_SHA] },
      { kind: 'missing', path: 'services/people/README.md', form: 'markdown' },
      { kind: 'mismatch', path: 'services/people/TRACEABILITY.md', form: 'markdown', found: [OTHER_SHA] },
      { kind: 'missing', path: 'services/people/contracts/openapi.yaml', form: 'openapi' },
    ]);
  });

  it('reports each tracked path under themes/default/ or blitzy/ once, and never reads those folders', async () => {
    await writeTree({
      'themes/default/index.cfm': '<cfoutput>theme</cfoutput>\n',
      'themes/default/README.md': '# Theme\n',
      'blitzy/notes.md': '# Notes\n',
      'blitzy/run/summary.md': '# Untracked summary\n',
      'themes/other/README.md': `Source SHA: ${SHA}\n`,
    });
    const tracked = [
      'themes/default/index.cfm',
      'themes/default/README.md',
      'blitzy/notes.md',
      'blitzy/notes.md',
      'blitzy/screens/login.png',
      'themes/other/README.md',
    ];
    const { run } = fakeRunner(listingReplies({ listed: [...tracked, 'blitzy/run/summary.md'], tracked }));
    const reads = spyReads();
    const result = await checkDeliverables({ root, git: { run } });
    expect(result).toMatchObject({ checked: 1, ok: false });
    expect(result.findings).toEqual<PinFinding[]>([
      { kind: 'forbidden-tracked', path: 'blitzy/notes.md' },
      { kind: 'forbidden-tracked', path: 'blitzy/screens/login.png' },
      { kind: 'forbidden-tracked', path: 'themes/default/README.md' },
      { kind: 'forbidden-tracked', path: 'themes/default/index.cfm' },
    ]);
    expect(reads()).toEqual(['themes/other/README.md']);
  });

  it.each<{ state: string; directory: boolean; relPath: string; finding: PinFinding }>([
    {
      state: 'no longer on disk',
      directory: false,
      relPath: 'opt2/reports/deleted.json',
      finding: { kind: 'file-missing', path: 'opt2/reports/deleted.json', form: 'json' },
    },
    {
      state: 'a directory',
      directory: true,
      relPath: 'services/people/contracts/vendored',
      finding: {
        kind: 'unreadable',
        path: 'services/people/contracts/vendored',
        form: 'text',
        error: expect.stringContaining('EISDIR'),
      },
    },
  ])('reports, without counting, a tracked deliverable that is $state', async ({ directory, relPath, finding }) => {
    if (directory) await fs.mkdir(path.join(root, relPath), { recursive: true });
    const { run } = fakeRunner(listingReplies({ listed: [relPath], tracked: [relPath] }));
    await expect(checkDeliverables({ root, git: { run } })).resolves.toEqual({
      mode: 'deliverables',
      sha: SHA,
      checked: 0,
      ok: false,
      findings: [finding],
    });
  });

  it('still checks and reports the deliverables after one that is absent or unreadable', async () => {
    await fs.mkdir(path.join(root, 'opt2/reports/a-directory.json'), { recursive: true });
    await writeTree({
      'opt2/reports/speed.json': JSON.stringify({ sourceSha: SHA }),
      'opt2/reports/windows.json': JSON.stringify({ sourceSha: OTHER_SHA }),
    });
    const listed = [
      'opt2/reports/a-directory.json',
      'opt2/reports/deleted.md',
      'opt2/reports/speed.json',
      'opt2/reports/windows.json',
    ];
    const { run } = fakeRunner(listingReplies({ listed, tracked: listed }));
    const reads = spyReads();
    const result = await checkDeliverables({ root, git: { run } });
    expect(result).toMatchObject({ checked: 2, ok: false });
    expect(result.findings).toEqual<PinFinding[]>([
      {
        kind: 'unreadable',
        path: 'opt2/reports/a-directory.json',
        form: 'json',
        error: expect.stringContaining('EISDIR'),
      },
      { kind: 'file-missing', path: 'opt2/reports/deleted.md', form: 'markdown' },
      { kind: 'mismatch', path: 'opt2/reports/windows.json', form: 'json', found: [OTHER_SHA] },
    ]);
    expect(reads()).toEqual(listed);
  });
});

describe('main through runCli', () => {
  interface CliRun {
    code: number;
    exits: number[];
    lines: string[];
    line: Record<string, unknown>;
  }

  /** Runs `main(argv, deps)` through runCli, capturing stdout and the exit code. */
  async function runCheck(argv: string[], deps: PinDeps): Promise<CliRun> {
    const chunks: string[] = [];
    const exits: number[] = [];
    const code = await runCli((args) => main(args, deps), {
      argv,
      command: COMMAND,
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit: (exitCode) => exits.push(exitCode),
    });
    const output = chunks.join('');
    const lines = output.split('\n').filter((entry) => entry.length > 0);
    return { code, exits, lines, line: JSON.parse(output) as Record<string, unknown> };
  }

  it('--confirm on a confirmed pin exits 0 with one JSON summary line', async () => {
    const { run } = fakeRunner(confirmReplies());
    const outcome = await runCheck(['--confirm'], { root, git: { run } });
    expect(outcome.code).toBe(0);
    expect(outcome.exits).toEqual([0]);
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.line).toEqual({
      command: COMMAND,
      ok: true,
      code: 0,
      root,
      mode: 'confirm',
      sha: SHA,
      subject: PIN.subject,
      findings: [],
    });
  });

  it('--confirm exits 1 when a tracked file changed', async () => {
    const { run } = fakeRunner(confirmReplies({ [DIFF_DMRT]: nul('core/mura/configBean.cfc') }));
    const outcome = await runCheck(['--confirm'], { root, git: { run } });
    expect(outcome.code).toBe(1);
    expect(outcome.line).toMatchObject({
      ok: false,
      mode: 'confirm',
      findings: [{ kind: 'tracked-file-changed', path: 'core/mura/configBean.cfc' }],
    });
  });

  it.each<{ label: string; content?: string; checked: number; kind: 'missing' | 'file-missing' }>([
    { label: 'a deliverable without the SHA', content: '# People\n', checked: 1, kind: 'missing' },
    { label: 'a tracked deliverable deleted from disk', checked: 0, kind: 'file-missing' },
  ])('checks deliverables without --confirm and exits 1 on $label', async ({ content, checked, kind }) => {
    const readme = 'services/people/README.md';
    if (content !== undefined) await write(readme, content);
    const { run } = fakeRunner(listingReplies({ listed: [readme], tracked: [readme] }));
    const outcome = await runCheck([], { root, git: { run } });
    expect(outcome.code).toBe(1);
    expect(outcome.exits).toEqual([1]);
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.line).toEqual({
      command: COMMAND,
      ok: false,
      code: 1,
      root,
      mode: 'deliverables',
      sha: SHA,
      checked,
      findings: [{ kind, path: readme, form: 'markdown' }],
    });
  });

  it('--root resolves a relative directory against the working directory and runs git there', async () => {
    const { run, calls } = fakeRunner(confirmReplies());
    const outcome = await runCheck(['--confirm', '--root', path.relative(process.cwd(), root)], {
      root: REPO_ROOT,
      git: { run },
    });
    expect(outcome.code).toBe(0);
    expect(outcome.line.root).toBe(root);
    expect(calls.map((call) => call.cwd)).toEqual([root, root, root]);
  });

  it.each<[string, string[], string]>([
    ['an empty --root', ['--root', ''], '--root needs a directory'],
    ['an unknown flag', ['--verbose'], "Unknown option '--verbose'"],
  ])('rejects %s with exit 2 and the usage text', async (_label, argv, message) => {
    const { run, calls } = fakeRunner({});
    const outcome = await runCheck(argv, { root, git: { run } });
    expect(outcome.code).toBe(2);
    expect(outcome.line).toMatchObject({
      command: COMMAND,
      ok: false,
      code: 2,
      error: { type: 'UsageError', message: expect.stringContaining(message) },
      usage: USAGE,
    });
    expect(calls).toEqual([]);
  });

  it('exits 1 with a PinError when the root has no pin record', async () => {
    await fs.rm(path.join(root, PIN_REL));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { run, calls } = fakeRunner({});
    const outcome = await runCheck(['--confirm'], { root, git: { run } });
    expect(outcome.code).toBe(1);
    expect(outcome.line).toMatchObject({ ok: false, code: 1, error: { type: 'PinError' } });
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!gitInstalled)('this checkout, through the default runner', () => {
  it('--confirm reports the pin of REPO_ROOT as a well-formed confirm result', async () => {
    const outcome = await main(['--confirm']);
    const summary = outcome.summary ?? {};
    expect(summary).toMatchObject({ root: REPO_ROOT, mode: 'confirm', sha: SHA, subject: PIN.subject });
    expect(typeof summary.ok).toBe('boolean');
    expect(outcome.code).toBe(summary.ok === true ? 0 : 1);
    const findings = summary.findings as PinFinding[];
    expect(Array.isArray(findings)).toBe(true);
    expect(summary.ok).toBe(findings.length === 0);
    for (const finding of findings) {
      expect(['commit-missing', 'subject-mismatch', 'tracked-file-changed']).toContain(finding.kind);
    }
  });
});
