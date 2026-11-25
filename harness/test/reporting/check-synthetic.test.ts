import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageError, runCli } from '../../src/lib/cli.js';
import { REPO_ROOT, isInsideRepo } from '../../src/lib/paths.js';
import {
  LABEL_PREFIXES,
  LABEL_TEXT,
  README_LABEL,
  SKIPPED_DIRS,
  SYNTHETIC_ROOTS,
  checkLabel,
  checkSynthetic,
  classifyFile,
  main,
} from '../../src/reporting/check-synthetic.js';
import type { FileClass, SyntheticCheckResult, SyntheticFindingKind } from '../../src/reporting/check-synthetic.js';

const DEFAULT_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'opt2-check-synthetic-default-'));
});

// REPO_ROOT points at a scratch tree so the default root is exercised without scanning the checkout.
vi.mock(import('../../src/lib/paths.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  REPO_ROOT: DEFAULT_ROOT,
}));

const COMMAND = 'harness/src/reporting/check-synthetic.ts';
const USAGE = 'check-synthetic [--root <dir>]';
const MODULE_TEXT = 'people - no Masa equivalent; legacy oracle in legacy-fixtures/';
const TS_HEADER = `// SYNTHETIC: ${MODULE_TEXT}`;
const SQL_HEADER = `-- SYNTHETIC: ${MODULE_TEXT}`;
const CFML_TAG_HEADER = `<!--- SYNTHETIC: ${MODULE_TEXT} --->`;
const SH_HEADER = `# SYNTHETIC: ${MODULE_TEXT}`;
const README_TEXT = '**SYNTHETIC MODULE**\n\n# Legacy fixtures\n';

const TS_EXPECTED = ['// SYNTHETIC: '];
const SQL_EXPECTED = ['-- SYNTHETIC: '];
const CFML_EXPECTED = ['<!--- SYNTHETIC: ', '// SYNTHETIC: '];
const SH_EXPECTED = ['# SYNTHETIC: '];
const README_EXPECTED = ['**SYNTHETIC MODULE**'];
const TS_ANY_EXPECTED = [`// SYNTHETIC: <module> - ${LABEL_TEXT}`];
const SQL_ANY_EXPECTED = [`-- SYNTHETIC: <module> - ${LABEL_TEXT}`];
const CFML_ANY_EXPECTED = [`<!--- SYNTHETIC: <module> - ${LABEL_TEXT} --->`, `// SYNTHETIC: <module> - ${LABEL_TEXT}`];

const ALL_ROOTS = ['legacy-fixtures'];

/** One correctly labelled file of every labelled type, a README and an exempt manifest. */
const LABELLED_TREE: Record<string, string> = {
  'legacy-fixtures/seed/src/dataset.ts': `${TS_HEADER}\nexport const rows: string[] = [];\n`,
  'legacy-fixtures/seed/src/Preview.tsx': `${TS_HEADER}\nexport function Preview() {\n  return null;\n}\n`,
  'legacy-fixtures/sql/people/010_people.sql': `${SQL_HEADER}\nCREATE SCHEMA synthetic;\n`,
  'legacy-fixtures/cfml/Application.cfc': `${CFML_TAG_HEADER}\n<cfcomponent extends="muraWRM.Application"></cfcomponent>\n`,
  'legacy-fixtures/cfml/modules/people.cfc': `// SYNTHETIC: ${MODULE_TEXT}\ncomponent {}\n`,
  'legacy-fixtures/cfml/index.cfm': `${CFML_TAG_HEADER}\n<cfoutput>ok</cfoutput>\n`,
  'legacy-fixtures/load-fixtures.sh': `#!/usr/bin/env bash\n${SH_HEADER}\nset -euo pipefail\n`,
  'legacy-fixtures/README.md': README_TEXT,
  'legacy-fixtures/seed/package.json': '{}\n',
};
const LABELLED_TREE_CHECKED: Record<FileClass, number> = { labelled: 7, readme: 1, exempt: 1 };

/** Message checkSynthetic rejects with when no synthetic root under `dir` holds a file. */
function nothingCheckedMessage(dir: string): string {
  return `no file checked under '${dir}': none of ${ALL_ROOTS.join(', ')} holds a file`;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-check-synthetic-'));
  expect(isInsideRepo(root)).toBe(false);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(DEFAULT_ROOT, { recursive: true, force: true });
});

/** Writes `content` to `rel` under `base` (default the per-test root), creating parent directories; returns the absolute path. */
async function write(rel: string, content: string, base: string = root): Promise<string> {
  const abs = path.join(base, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return abs;
}

async function writeTree(tree: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(tree)) await write(rel, content);
}

interface CliRun {
  code: number;
  exits: number[];
  output: string;
  line: Record<string, unknown>;
}

/** Runs the command's `main` through runCli with `argv`, capturing stdout and the exit code. */
async function runCheck(argv: string[]): Promise<CliRun> {
  const chunks: string[] = [];
  const exits: number[] = [];
  const code = await runCli(main, {
    argv,
    command: COMMAND,
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    exit: (exitCode) => exits.push(exitCode),
  });
  const output = chunks.join('');
  return { code, exits, output, line: JSON.parse(output) as Record<string, unknown> };
}

describe('constants', () => {
  it('SYNTHETIC_ROOTS is legacy-fixtures alone', () => {
    expect(new Set(SYNTHETIC_ROOTS)).toEqual(new Set(ALL_ROOTS));
    expect(SYNTHETIC_ROOTS).toHaveLength(ALL_ROOTS.length);
  });

  it('SKIPPED_DIRS are the dependency, build, coverage, VCS and generated-code directories', () => {
    expect(new Set(SKIPPED_DIRS)).toEqual(new Set(['node_modules', 'dist', 'coverage', '.next', '.git', 'src/generated']));
    expect(SKIPPED_DIRS).toHaveLength(6);
  });

  it('LABEL_PREFIXES gives each labelled extension the comment syntax of its language', () => {
    expect(LABEL_PREFIXES).toEqual({
      '.ts': TS_EXPECTED,
      '.tsx': TS_EXPECTED,
      '.sql': SQL_EXPECTED,
      '.cfc': CFML_EXPECTED,
      '.cfm': CFML_EXPECTED,
      '.sh': SH_EXPECTED,
    });
  });

  it('README_LABEL is the bold SYNTHETIC MODULE marker', () => {
    expect(README_LABEL).toBe('**SYNTHETIC MODULE**');
  });

  it('LABEL_TEXT is the no-Masa, legacy-oracle wording every header carries after its module', () => {
    expect(LABEL_TEXT).toBe('no Masa equivalent; legacy oracle in legacy-fixtures/');
  });
});

describe('classifyFile', () => {
  it.each<[string, FileClass]>([
    ['legacy-fixtures/seed/README.md', 'readme'],
    ['legacy-fixtures/README.md', 'readme'],
    ['legacy-fixtures/seed/src/dataset.ts', 'labelled'],
    ['legacy-fixtures/seed/src/Preview.tsx', 'labelled'],
    ['legacy-fixtures/sql/people/010_people.sql', 'labelled'],
    ['legacy-fixtures/cfml/Application.cfc', 'labelled'],
    ['legacy-fixtures/cfml/index.cfm', 'labelled'],
    ['legacy-fixtures/load-fixtures.sh', 'labelled'],
    ['legacy-fixtures/sql/people/020_PEOPLE.SQL', 'labelled'],
    ['legacy-fixtures/seed/package.json', 'exempt'],
    ['legacy-fixtures/contracts/openapi.yaml', 'exempt'],
    ['legacy-fixtures/seed/deps.lock', 'exempt'],
    ['legacy-fixtures/TRACEABILITY.md', 'exempt'],
    ['legacy-fixtures/seed/Dockerfile', 'exempt'],
  ])('classifies %s as %s', (relPath, expected) => {
    expect(classifyFile(relPath)).toBe(expected);
  });
});

describe('checkLabel', () => {
  it.each<[string, string, string]>([
    ['a TypeScript header', 'legacy-fixtures/seed/src/a.ts', `${TS_HEADER}\nexport {};\n`],
    ['a TSX header', 'legacy-fixtures/seed/src/A.tsx', `${TS_HEADER}\nexport {};\n`],
    ['an SQL header', 'legacy-fixtures/sql/people/a.sql', `${SQL_HEADER}\nSELECT 1;\n`],
    ['a CFC tag-comment header', 'legacy-fixtures/cfml/a.cfc', `${CFML_TAG_HEADER}\n<cfcomponent></cfcomponent>\n`],
    ['a CFC script-comment header', 'legacy-fixtures/cfml/a.cfc', `// SYNTHETIC: ${MODULE_TEXT}\ncomponent {}\n`],
    ['a CFM tag-comment header', 'legacy-fixtures/cfml/a.cfm', `${CFML_TAG_HEADER}\n<cfoutput>ok</cfoutput>\n`],
    ['a CFM script-comment header', 'legacy-fixtures/cfml/a.cfm', `// SYNTHETIC: ${MODULE_TEXT}\n`],
    ['a shell header on line 2 after a shebang', 'legacy-fixtures/a.sh', `#!/usr/bin/env bash\n${SH_HEADER}\n`],
    ['a shell header on line 1 without a shebang', 'legacy-fixtures/a.sh', `${SH_HEADER}\nset -e\n`],
    ['a TypeScript header after a shebang', 'legacy-fixtures/seed/src/cli.ts', `#!/usr/bin/env node\n${TS_HEADER}\n`],
    ['a header behind a byte-order mark', 'legacy-fixtures/sql/a.sql', `\uFEFF${SQL_HEADER}\n`],
    ['CRLF line endings', 'legacy-fixtures/a.sh', `#!/bin/sh\r\n${SH_HEADER}\r\nexit 0\r\n`],
    ['an upper-case extension', 'legacy-fixtures/sql/A.SQL', `${SQL_HEADER}\n`],
    ['a README opening with the label', 'legacy-fixtures/README.md', README_TEXT],
    ['a README whose first non-blank line holds the label', 'legacy-fixtures/README.md', '\n  \n**SYNTHETIC MODULE** fixtures\n'],
    ['a README label behind a byte-order mark', 'legacy-fixtures/README.md', `\uFEFF${README_TEXT}`],
    ['an exempt file with no label', 'legacy-fixtures/seed/package.json', '{}\n'],
    ['a legacy-fixtures header naming a sub-module', 'legacy-fixtures/seed/src/a.ts', `// SYNTHETIC: seed - ${LABEL_TEXT}\n`],
    ['a header with trailing whitespace', 'legacy-fixtures/seed/src/a.ts', `${TS_HEADER} \t\nexport {};\n`],
    ['a CFML tag header with trailing whitespace', 'legacy-fixtures/cfml/a.cfm', `${CFML_TAG_HEADER}  \r\n`],
    ['a closed CFML tag header', 'legacy-fixtures/cfml/a.cfc', `<!--- SYNTHETIC: legacy-fixtures - ${LABEL_TEXT} --->\n`],
  ])('accepts %s', (_label, relPath, content) => {
    expect(checkLabel(relPath, content)).toBeNull();
  });

  it.each<[string, SyntheticFindingKind, string, string, string[]]>([
    ['TypeScript with no header', 'missing-label', 'legacy-fixtures/seed/src/a.ts', 'export {};\n', TS_EXPECTED],
    ['an empty TypeScript file', 'missing-label', 'legacy-fixtures/seed/src/a.ts', '', TS_EXPECTED],
    ['TypeScript with an SQL comment marker', 'wrong-syntax', 'legacy-fixtures/seed/src/a.ts', `${SQL_HEADER}\n`, TS_EXPECTED],
    ['SQL with a TypeScript comment marker', 'wrong-syntax', 'legacy-fixtures/sql/a.sql', `${TS_HEADER}\n`, SQL_EXPECTED],
    ['CFML with an HTML comment', 'wrong-syntax', 'legacy-fixtures/cfml/a.cfm', `<!-- SYNTHETIC: ${MODULE_TEXT} -->\n`, CFML_EXPECTED],
    ['CFML with a shell comment', 'wrong-syntax', 'legacy-fixtures/cfml/a.cfc', `${SH_HEADER}\n`, CFML_EXPECTED],
    ['TSX with a bare label', 'wrong-syntax', 'legacy-fixtures/seed/src/page.tsx', `SYNTHETIC: ${MODULE_TEXT}\n`, TS_EXPECTED],
    ['an indented header', 'wrong-syntax', 'legacy-fixtures/seed/src/a.ts', `  ${TS_HEADER}\n`, TS_EXPECTED],
    ['a header with no space after the colon', 'wrong-syntax', 'legacy-fixtures/seed/src/a.ts', '// SYNTHETIC:people\n', TS_EXPECTED],
    ['a lower-case label', 'missing-label', 'legacy-fixtures/seed/src/a.ts', `// synthetic: ${MODULE_TEXT}\n`, TS_EXPECTED],
    ['a prefix with no text after it', 'missing-label', 'legacy-fixtures/seed/src/a.ts', '// SYNTHETIC:   \n', TS_EXPECTED],
    ['the label on line 3', 'missing-label', 'legacy-fixtures/seed/src/a.ts', `import fs from 'node:fs';\n\n${TS_HEADER}\n`, TS_EXPECTED],
    ['a shell label on line 2 without a shebang', 'missing-label', 'legacy-fixtures/a.sh', `set -euo pipefail\n${SH_HEADER}\n`, SH_EXPECTED],
    ['a shell label on line 3 after a shebang', 'missing-label', 'legacy-fixtures/a.sh', `#!/usr/bin/env bash\n\n${SH_HEADER}\n`, SH_EXPECTED],
    ['a shebang with no second line', 'missing-label', 'legacy-fixtures/a.sh', '#!/usr/bin/env bash', SH_EXPECTED],
    ['a README opening with a heading', 'missing-readme-label', 'legacy-fixtures/README.md', '# Fixtures\n\n**SYNTHETIC MODULE**\n', README_EXPECTED],
    ['an empty README', 'missing-readme-label', 'legacy-fixtures/README.md', '', README_EXPECTED],
    ['a README with the label mid-line', 'missing-readme-label', 'legacy-fixtures/README.md', 'Fixtures **SYNTHETIC MODULE**\n', README_EXPECTED],
    ['a README with a lower-case label', 'missing-readme-label', 'legacy-fixtures/README.md', '**synthetic module**\n', README_EXPECTED],
    ['a header with arbitrary text', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', '// SYNTHETIC: anything\n', TS_ANY_EXPECTED],
    ['an unterminated CFML tag header', 'malformed-label', 'legacy-fixtures/cfml/a.cfm', `<!--- SYNTHETIC: ${MODULE_TEXT}\n`, CFML_ANY_EXPECTED],
    ['a CFML tag header with arbitrary text', 'malformed-label', 'legacy-fixtures/cfml/a.cfm', '<!--- SYNTHETIC: x\n', CFML_ANY_EXPECTED],
    ['a CFML closer with no space', 'malformed-label', 'legacy-fixtures/cfml/a.cfc', `<!--- SYNTHETIC: ${MODULE_TEXT}--->\n`, CFML_ANY_EXPECTED],
    ['a CFML script header with a bare module', 'malformed-label', 'legacy-fixtures/a.cfc', '// SYNTHETIC: people\n', CFML_ANY_EXPECTED],
    ['a CFML script header with a closer', 'malformed-label', 'legacy-fixtures/a.cfm', `// SYNTHETIC: ${MODULE_TEXT} --->\n`, CFML_ANY_EXPECTED],
    ['truncated wording', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', '// SYNTHETIC: people - no Masa equivalent\n', TS_ANY_EXPECTED],
    ['other wording', 'malformed-label', 'legacy-fixtures/a.sql', '-- SYNTHETIC: people - mirrors Masa; legacy oracle\n', SQL_ANY_EXPECTED],
    ['text after the wording', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', `${TS_HEADER} (draft)\n`, TS_ANY_EXPECTED],
    ['text after the CFML closer', 'malformed-label', 'legacy-fixtures/cfml/a.cfc', `${CFML_TAG_HEADER} <cfcomponent>\n`, CFML_ANY_EXPECTED],
    ['an upper-case module', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', `// SYNTHETIC: Seed - ${LABEL_TEXT}\n`, TS_ANY_EXPECTED],
    ['a module with a space', 'malformed-label', 'legacy-fixtures/seed/src/page.tsx', `// SYNTHETIC: seed data - ${LABEL_TEXT}\n`, TS_ANY_EXPECTED],
    ['a module behind extra spaces', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', `// SYNTHETIC:  seed - ${LABEL_TEXT}\n`, TS_ANY_EXPECTED],
    ['a header with no module', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', `// SYNTHETIC:  - ${LABEL_TEXT}\n`, TS_ANY_EXPECTED],
  ])('reports %s as %s', (_label, kind, relPath, content, expected) => {
    expect(checkLabel(relPath, content)).toEqual({ path: relPath, kind, expected });
  });
});

describe('checkSynthetic', () => {
  it('passes a tree whose every source file and README is labelled', async () => {
    await writeTree(LABELLED_TREE);
    await expect(checkSynthetic({ root })).resolves.toEqual({
      ok: true,
      checked: LABELLED_TREE_CHECKED,
      rootsMissing: [],
      findings: [],
    } satisfies SyntheticCheckResult);
  });

  it.each<[string, string[]]>([
    ['an empty root', []],
    ['every synthetic root present and empty', ALL_ROOTS],
    ['a legacy-fixtures root holding only empty directories', ['legacy-fixtures/sql/people', 'legacy-fixtures/cfml']],
  ])('rejects, not passes, when no file is checked under %s', async (_label, dirs) => {
    for (const synthetic of dirs) await mkdir(path.join(root, synthetic), { recursive: true });
    await expect(checkSynthetic({ root })).rejects.toMatchObject({
      code: 'ENOENT',
      path: root,
      message: nothingCheckedMessage(root),
    });
  });

  it('reports each unlabelled file exactly once, sorted by path, and leaves labelled files out', async () => {
    await writeTree({
      ...LABELLED_TREE,
      'legacy-fixtures/seed/src/schedule.ts': 'export const cron = "0 * * * *";\n',
      'legacy-fixtures/seed/src/approval.ts': `${SQL_HEADER}\nexport {};\n`,
      'legacy-fixtures/sql/people/020_people.sql': `${TS_HEADER}\nSELECT 1;\n`,
      'legacy-fixtures/seed/src/export.ts': `// synthetic: ${MODULE_TEXT}\n`,
      'legacy-fixtures/seed/src/send.ts': `import fs from 'node:fs';\n\n${TS_HEADER}\n`,
      'legacy-fixtures/load-people.sh': `set -euo pipefail\n${SH_HEADER}\n`,
      'legacy-fixtures/seed/README.md': '# Seed\n',
      'legacy-fixtures/seed/src/page.tsx': 'export default function Page() {\n  return null;\n}\n',
      'legacy-fixtures/seed/src/forged.ts': '// SYNTHETIC: anything\n',
      'legacy-fixtures/cfml/open.cfm': '<!--- SYNTHETIC: x\n',
    });
    await write('legacy-fixtures/README.md', '# Fixtures\n');

    const result = await checkSynthetic({ root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { path: 'legacy-fixtures/README.md', kind: 'missing-readme-label', expected: README_EXPECTED },
      { path: 'legacy-fixtures/cfml/open.cfm', kind: 'malformed-label', expected: CFML_ANY_EXPECTED },
      { path: 'legacy-fixtures/load-people.sh', kind: 'missing-label', expected: SH_EXPECTED },
      { path: 'legacy-fixtures/seed/README.md', kind: 'missing-readme-label', expected: README_EXPECTED },
      { path: 'legacy-fixtures/seed/src/approval.ts', kind: 'wrong-syntax', expected: TS_EXPECTED },
      { path: 'legacy-fixtures/seed/src/export.ts', kind: 'missing-label', expected: TS_EXPECTED },
      { path: 'legacy-fixtures/seed/src/forged.ts', kind: 'malformed-label', expected: TS_ANY_EXPECTED },
      { path: 'legacy-fixtures/seed/src/page.tsx', kind: 'missing-label', expected: TS_EXPECTED },
      { path: 'legacy-fixtures/seed/src/schedule.ts', kind: 'missing-label', expected: TS_EXPECTED },
      { path: 'legacy-fixtures/seed/src/send.ts', kind: 'missing-label', expected: TS_EXPECTED },
      { path: 'legacy-fixtures/sql/people/020_people.sql', kind: 'wrong-syntax', expected: SQL_EXPECTED },
    ]);
    expect(result.checked).toEqual({ labelled: 16, readme: 2, exempt: 1 });
    expect(result.rootsMissing).toEqual([]);
  });

  it.each(['node_modules', 'dist', 'coverage', '.next', '.git', 'src/generated'])(
    'does not walk a %s directory inside a synthetic root',
    async (dir) => {
      await write(`legacy-fixtures/seed/${dir}/nested/unlabelled.ts`, 'export {};\n');
      await write(`legacy-fixtures/cfml/${dir}/README.md`, '# Generated\n');
      await expect(checkSynthetic({ root })).rejects.toThrow(nothingCheckedMessage(root));
    },
  );

  it('walks a generated directory outside src and directories whose names only contain a skipped name', async () => {
    await write('legacy-fixtures/seed/test/generated/fixture.ts', 'export {};\n');
    await write('legacy-fixtures/seed/src/node_modules-shim/index.ts', 'export {};\n');
    await write('legacy-fixtures/seed/distribution/build.sh', 'echo build\n');
    const result = await checkSynthetic({ root });
    expect(result.findings.map((finding) => finding.path)).toEqual([
      'legacy-fixtures/seed/distribution/build.sh',
      'legacy-fixtures/seed/src/node_modules-shim/index.ts',
      'legacy-fixtures/seed/test/generated/fixture.ts',
    ]);
  });

  it('counts exempt files without reading a label from them', async () => {
    await writeTree({
      'legacy-fixtures/seed/package.json': '{}\n',
      'legacy-fixtures/contracts/openapi.yaml': 'openapi: 3.1.0\n',
      'legacy-fixtures/seed/deps.lock': 'lock\n',
      'legacy-fixtures/TRACEABILITY.md': '# Traceability\n',
      'legacy-fixtures/seed/Dockerfile': 'FROM node:22\n',
    });
    await expect(checkSynthetic({ root })).resolves.toMatchObject({
      ok: true,
      checked: { labelled: 0, readme: 0, exempt: 5 },
      findings: [],
    });
  });

  it('does not scan files outside the synthetic roots', async () => {
    await writeTree({
      'services/identity/src/login.ts': 'export {};\n',
      'services/people/README.md': '# People\n',
      'legacy-fixtures-archive/src/old.ts': 'export {};\n',
      'web/app/admin/page.tsx': 'export {};\n',
      'web/src/screens/people/List.tsx': 'export {};\n',
      'harness/src/tool.ts': 'export {};\n',
      'platform/src/index.ts': 'export {};\n',
    });
    await expect(checkSynthetic({ root })).rejects.toThrow(nothingCheckedMessage(root));
  });

  it('follows no symbolic link to a file or directory', async () => {
    const outsideFile = await write('elsewhere/unlabelled.ts', 'export {};\n');
    await write('elsewhere/nested/unlabelled.sql', 'SELECT 1;\n');
    await mkdir(path.join(root, 'legacy-fixtures/seed/src'), { recursive: true });
    await symlink(outsideFile, path.join(root, 'legacy-fixtures/seed/src/linked.ts'));
    await symlink(path.join(root, 'elsewhere/nested'), path.join(root, 'legacy-fixtures/linked-dir'));
    await expect(checkSynthetic({ root })).rejects.toThrow(nothingCheckedMessage(root));
  });

  it('rejects when the root is a file rather than a directory', async () => {
    const file = await write('not-a-directory', 'x\n');
    await expect(checkSynthetic({ root: file })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it.each<[string, string, (dir: string) => string]>([
    ['ENOENT', 'does not exist', (dir) => path.join(dir, 'typo')],
    ['ENOENT', 'sits below a missing directory', (dir) => path.join(dir, 'missing', 'typo')],
    ['ENOTDIR', 'sits below a file', (dir) => path.join(dir, 'not-a-directory', 'typo')],
  ])('rejects with %s when the root %s', async (code, _label, rootOf) => {
    await write('not-a-directory', 'x\n');
    await expect(checkSynthetic({ root: rootOf(root) })).rejects.toMatchObject({ code });
  });

  it('checks the checkout root when no root is given, as main does without --root', async () => {
    expect(REPO_ROOT).toBe(DEFAULT_ROOT);
    expect(isInsideRepo(REPO_ROOT)).toBe(false);
    await write('legacy-fixtures/seed/src/unlabelled.ts', 'export {};\n', REPO_ROOT);

    const result = await checkSynthetic();

    expect(result.findings).toEqual([
      { path: 'legacy-fixtures/seed/src/unlabelled.ts', kind: 'missing-label', expected: TS_EXPECTED },
    ]);
    await expect(main([])).resolves.toEqual({ code: 1, summary: { root: REPO_ROOT, ...result } });
  });
});

describe('main through runCli', () => {
  it.each<[string, (dir: string) => string[]]>([
    ['--root <dir>', (dir) => ['--root', dir]],
    ['--root=<dir>', (dir) => [`--root=${dir}`]],
    ['a relative --root', (dir) => ['--root', path.relative(process.cwd(), dir)]],
  ])('exits 0 with one passing summary line for a fully labelled tree given %s', async (_form, argv) => {
    await writeTree(LABELLED_TREE);
    const run = await runCheck(argv(root));
    expect(run.code).toBe(0);
    expect(run.exits).toEqual([0]);
    expect(run.output.endsWith('\n')).toBe(true);
    expect(run.output.split('\n')).toHaveLength(2);
    expect(run.line).toEqual({
      command: COMMAND,
      ok: true,
      code: 0,
      root,
      checked: LABELLED_TREE_CHECKED,
      rootsMissing: [],
      findings: [],
    });
  });

  it('exits 1 with one summary line naming the unlabelled file', async () => {
    await writeTree({ ...LABELLED_TREE, 'legacy-fixtures/seed/src/unlabelled.ts': 'export {};\n' });
    const run = await runCheck(['--root', root]);
    expect(run.code).toBe(1);
    expect(run.exits).toEqual([1]);
    expect(run.output.split('\n')).toHaveLength(2);
    expect(run.line).toMatchObject({ command: COMMAND, ok: false, code: 1, root });
    expect(run.line['findings']).toEqual([
      { path: 'legacy-fixtures/seed/src/unlabelled.ts', kind: 'missing-label', expected: TS_EXPECTED },
    ]);
  });

  it.each<[string, string[], string | undefined]>([
    ['an empty --root= value', ['--root='], '--root needs a directory'],
    ['an empty separate --root value', ['--root', ''], '--root needs a directory'],
    ['--root with no value', ['--root'], undefined],
    ['an unknown flag', ['--bogus'], undefined],
    ['a positional argument', ['legacy-fixtures'], undefined],
  ])('exits 2 with a UsageError and the usage text for %s', async (_label, argv, message) => {
    const run = await runCheck(argv);
    expect(run.code).toBe(2);
    expect(run.exits).toEqual([2]);
    expect(run.output.split('\n')).toHaveLength(2);
    expect(run.line).toEqual({
      command: COMMAND,
      ok: false,
      code: 2,
      error: { type: 'UsageError', message: message ?? expect.any(String) },
      usage: USAGE,
    });
  });

  it('--help prints the help text naming every flag and synthetic root, with no JSON line, and exits 0', async () => {
    const chunks: string[] = [];
    const exits: number[] = [];
    const code = await runCli(main, {
      argv: ['--help'],
      command: COMMAND,
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit: (exitCode) => exits.push(exitCode),
    });
    const output = chunks.join('');
    expect(code).toBe(0);
    expect(exits).toEqual([0]);
    expect(output.startsWith(`${USAGE} [--help]\n`)).toBe(true);
    expect(output.endsWith('\n') && !output.endsWith('\n\n')).toBe(true);
    for (const flag of ['--root <dir>', '--help']) expect(output).toContain(`  ${flag}`);
    for (const syntheticRoot of SYNTHETIC_ROOTS) expect(output).toContain(`  ${syntheticRoot}\n`);
    expect(output).not.toContain(`"command":`);
  });

  it('main throws a UsageError carrying the usage text for an empty --root', async () => {
    const failure = main(['--root=']);
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toMatchObject({ message: '--root needs a directory', usage: USAGE });
  });

  it('exits 1 with the error in the summary line when --root names a file', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const file = await write('not-a-directory', 'x\n');
    const run = await runCheck(['--root', file]);
    expect(run.code).toBe(1);
    expect(run.exits).toEqual([1]);
    expect(run.line).toMatchObject({ command: COMMAND, ok: false, code: 1, error: { type: 'Error' } });
    expect(String((run.line['error'] as { message: unknown }).message)).toContain('ENOTDIR');
    expect(stderr).toHaveBeenCalled();
  });

  it.each<[string, (dir: string) => string[]]>([
    ['--root <missing>', (dir) => ['--root', path.join(dir, 'typo')]],
    ['--root=<missing>', (dir) => [`--root=${path.join(dir, 'typo')}`]],
  ])('exits 1 with an ENOENT error in the summary line, not a pass, for %s', async (_form, argv) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = await runCheck(argv(root));
    expect(run.code).toBe(1);
    expect(run.exits).toEqual([1]);
    expect(run.output.split('\n')).toHaveLength(2);
    expect(run.line).toEqual({ command: COMMAND, ok: false, code: 1, error: { type: 'Error', message: expect.stringContaining('ENOENT') } });
    expect(String((run.line['error'] as { message: unknown }).message)).toContain(path.join(root, 'typo'));
    expect(stderr).toHaveBeenCalled();
  });

  it('exits 1 with the nothing-checked error in the summary line, not a pass, for an empty --root', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = await runCheck(['--root', root]);
    expect(run.code).toBe(1);
    expect(run.exits).toEqual([1]);
    expect(run.output.split('\n')).toHaveLength(2);
    expect(run.line).toEqual({ command: COMMAND, ok: false, code: 1, error: { type: 'Error', message: nothingCheckedMessage(root) } });
    expect(stderr).toHaveBeenCalled();
  });
});
