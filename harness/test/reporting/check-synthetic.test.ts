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
const MODULE_TEXT = 'finance - no Masa equivalent; legacy oracle in legacy-fixtures/';
const TS_HEADER = `// SYNTHETIC: ${MODULE_TEXT}`;
const SQL_HEADER = `-- SYNTHETIC: ${MODULE_TEXT}`;
const CFML_TAG_HEADER = `<!--- SYNTHETIC: ${MODULE_TEXT} --->`;
const SH_HEADER = `# SYNTHETIC: ${MODULE_TEXT}`;
const README_TEXT = '**SYNTHETIC MODULE**\n\n# Finance\n';

const TS_EXPECTED = ['// SYNTHETIC: '];
const SQL_EXPECTED = ['-- SYNTHETIC: '];
const CFML_EXPECTED = ['<!--- SYNTHETIC: ', '// SYNTHETIC: '];
const SH_EXPECTED = ['# SYNTHETIC: '];
const README_EXPECTED = ['**SYNTHETIC MODULE**'];
const TS_FINANCE_EXPECTED = [`// SYNTHETIC: ${MODULE_TEXT}`];
const TS_ANY_EXPECTED = [`// SYNTHETIC: <module> - ${LABEL_TEXT}`];
const SQL_ANY_EXPECTED = [`-- SYNTHETIC: <module> - ${LABEL_TEXT}`];
const CFML_ANY_EXPECTED = [`<!--- SYNTHETIC: <module> - ${LABEL_TEXT} --->`, `// SYNTHETIC: <module> - ${LABEL_TEXT}`];
const SH_FINANCE_EXPECTED = [SH_HEADER];
const ESIGN_EXPECTED = [`// SYNTHETIC: e-signature - ${LABEL_TEXT}`];

const ALL_ROOTS = [
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

/** One correctly labelled file of every labelled type, a README and an exempt manifest. */
const LABELLED_TREE: Record<string, string> = {
  'services/finance/src/lifecycle.ts': `${TS_HEADER}\nexport const states: string[] = [];\n`,
  'web/src/screens/opt2/finance/FinanceList.tsx': `${TS_HEADER}\nexport function FinanceList() {\n  return null;\n}\n`,
  'legacy-fixtures/sql/finance/010_finance.sql': `${SQL_HEADER}\nCREATE SCHEMA synthetic;\n`,
  'legacy-fixtures/cfml/Application.cfc': `${CFML_TAG_HEADER}\n<cfcomponent extends="muraWRM.Application"></cfcomponent>\n`,
  'legacy-fixtures/cfml/finance.cfc': `// SYNTHETIC: ${MODULE_TEXT}\ncomponent {}\n`,
  'legacy-fixtures/cfml/index.cfm': `${CFML_TAG_HEADER}\n<cfoutput>ok</cfoutput>\n`,
  'legacy-fixtures/load-fixtures.sh': `#!/usr/bin/env bash\n${SH_HEADER}\nset -euo pipefail\n`,
  'services/finance/README.md': README_TEXT,
  'services/finance/package.json': '{}\n',
};
const LABELLED_TREE_CHECKED: Record<FileClass, number> = { labelled: 7, readme: 1, exempt: 1 };
const LABELLED_TREE_ROOTS_MISSING = [
  'services/communications',
  'services/reporting',
  'services/surveys',
  'services/timesheets',
  'services/e-signature',
  'web/app/opt2',
];
const NOTHING_CHECKED: Record<FileClass, number> = { labelled: 0, readme: 0, exempt: 0 };

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
  it('SYNTHETIC_ROOTS are the six synthetic services, legacy-fixtures and the two opt2 web trees, once each', () => {
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
    ['services/finance/README.md', 'readme'],
    ['legacy-fixtures/README.md', 'readme'],
    ['services/finance/src/lifecycle.ts', 'labelled'],
    ['web/src/screens/opt2/finance/FinanceList.tsx', 'labelled'],
    ['legacy-fixtures/sql/finance/010_finance.sql', 'labelled'],
    ['legacy-fixtures/cfml/Application.cfc', 'labelled'],
    ['legacy-fixtures/cfml/index.cfm', 'labelled'],
    ['legacy-fixtures/load-fixtures.sh', 'labelled'],
    ['legacy-fixtures/sql/finance/020_FINANCE.SQL', 'labelled'],
    ['services/finance/package.json', 'exempt'],
    ['services/finance/contracts/openapi.yaml', 'exempt'],
    ['legacy-fixtures/seed/deps.lock', 'exempt'],
    ['services/finance/TRACEABILITY.md', 'exempt'],
    ['services/finance/Dockerfile', 'exempt'],
  ])('classifies %s as %s', (relPath, expected) => {
    expect(classifyFile(relPath)).toBe(expected);
  });
});

describe('checkLabel', () => {
  it.each<[string, string, string]>([
    ['a TypeScript header', 'services/finance/src/a.ts', `${TS_HEADER}\nexport {};\n`],
    ['a TSX header', 'web/src/screens/opt2/finance/A.tsx', `${TS_HEADER}\nexport {};\n`],
    ['an SQL header', 'legacy-fixtures/sql/finance/a.sql', `${SQL_HEADER}\nSELECT 1;\n`],
    ['a CFC tag-comment header', 'legacy-fixtures/cfml/a.cfc', `${CFML_TAG_HEADER}\n<cfcomponent></cfcomponent>\n`],
    ['a CFC script-comment header', 'legacy-fixtures/cfml/a.cfc', `// SYNTHETIC: ${MODULE_TEXT}\ncomponent {}\n`],
    ['a CFM tag-comment header', 'legacy-fixtures/cfml/a.cfm', `${CFML_TAG_HEADER}\n<cfoutput>ok</cfoutput>\n`],
    ['a CFM script-comment header', 'legacy-fixtures/cfml/a.cfm', `// SYNTHETIC: ${MODULE_TEXT}\n`],
    ['a shell header on line 2 after a shebang', 'legacy-fixtures/a.sh', `#!/usr/bin/env bash\n${SH_HEADER}\n`],
    ['a shell header on line 1 without a shebang', 'legacy-fixtures/a.sh', `${SH_HEADER}\nset -e\n`],
    ['a TypeScript header after a shebang', 'services/finance/src/cli.ts', `#!/usr/bin/env node\n${TS_HEADER}\n`],
    ['a header behind a byte-order mark', 'legacy-fixtures/sql/a.sql', `\uFEFF${SQL_HEADER}\n`],
    ['CRLF line endings', 'legacy-fixtures/a.sh', `#!/bin/sh\r\n${SH_HEADER}\r\nexit 0\r\n`],
    ['an upper-case extension', 'legacy-fixtures/sql/A.SQL', `${SQL_HEADER}\n`],
    ['a README opening with the label', 'services/finance/README.md', README_TEXT],
    ['a README whose first non-blank line holds the label', 'services/finance/README.md', '\n  \n**SYNTHETIC MODULE** finance\n'],
    ['a README label behind a byte-order mark', 'services/finance/README.md', `\uFEFF${README_TEXT}`],
    ['an exempt file with no label', 'services/finance/package.json', '{}\n'],
    ['a header naming a hyphenated service', 'services/e-signature/src/a.ts', `// SYNTHETIC: e-signature - ${LABEL_TEXT}\n`],
    ['an opt2 screen header naming its module', 'web/src/screens/opt2/admin/A.tsx', `// SYNTHETIC: opt2-admin - ${LABEL_TEXT}\n`],
    ['an opt2 app header naming its module', 'web/app/opt2/modules/page.tsx', `// SYNTHETIC: opt2-modules - ${LABEL_TEXT}\n`],
    ['a legacy-fixtures header naming a sub-module', 'legacy-fixtures/seed/src/a.ts', `// SYNTHETIC: seed - ${LABEL_TEXT}\n`],
    ['a header with trailing whitespace', 'services/finance/src/a.ts', `${TS_HEADER} \t\nexport {};\n`],
    ['a CFML tag header with trailing whitespace', 'legacy-fixtures/cfml/a.cfm', `${CFML_TAG_HEADER}  \r\n`],
    ['a closed CFML tag header', 'legacy-fixtures/cfml/a.cfc', `<!--- SYNTHETIC: legacy-fixtures - ${LABEL_TEXT} --->\n`],
  ])('accepts %s', (_label, relPath, content) => {
    expect(checkLabel(relPath, content)).toBeNull();
  });

  it.each<[string, SyntheticFindingKind, string, string, string[]]>([
    ['TypeScript with no header', 'missing-label', 'services/finance/src/a.ts', 'export {};\n', TS_EXPECTED],
    ['an empty TypeScript file', 'missing-label', 'services/finance/src/a.ts', '', TS_EXPECTED],
    ['TypeScript with an SQL comment marker', 'wrong-syntax', 'services/finance/src/a.ts', `${SQL_HEADER}\n`, TS_EXPECTED],
    ['SQL with a TypeScript comment marker', 'wrong-syntax', 'legacy-fixtures/sql/a.sql', `${TS_HEADER}\n`, SQL_EXPECTED],
    ['CFML with an HTML comment', 'wrong-syntax', 'legacy-fixtures/cfml/a.cfm', `<!-- SYNTHETIC: ${MODULE_TEXT} -->\n`, CFML_EXPECTED],
    ['CFML with a shell comment', 'wrong-syntax', 'legacy-fixtures/cfml/a.cfc', `${SH_HEADER}\n`, CFML_EXPECTED],
    ['TSX with a bare label', 'wrong-syntax', 'web/app/opt2/finance/page.tsx', `SYNTHETIC: ${MODULE_TEXT}\n`, TS_EXPECTED],
    ['an indented header', 'wrong-syntax', 'services/finance/src/a.ts', `  ${TS_HEADER}\n`, TS_EXPECTED],
    ['a header with no space after the colon', 'wrong-syntax', 'services/finance/src/a.ts', '// SYNTHETIC:finance\n', TS_EXPECTED],
    ['a lower-case label', 'missing-label', 'services/finance/src/a.ts', `// synthetic: ${MODULE_TEXT}\n`, TS_EXPECTED],
    ['a prefix with no text after it', 'missing-label', 'services/finance/src/a.ts', '// SYNTHETIC:   \n', TS_EXPECTED],
    ['the label on line 3', 'missing-label', 'services/finance/src/a.ts', `import fs from 'node:fs';\n\n${TS_HEADER}\n`, TS_EXPECTED],
    ['a shell label on line 2 without a shebang', 'missing-label', 'legacy-fixtures/a.sh', `set -euo pipefail\n${SH_HEADER}\n`, SH_EXPECTED],
    ['a shell label on line 3 after a shebang', 'missing-label', 'legacy-fixtures/a.sh', `#!/usr/bin/env bash\n\n${SH_HEADER}\n`, SH_EXPECTED],
    ['a shebang with no second line', 'missing-label', 'legacy-fixtures/a.sh', '#!/usr/bin/env bash', SH_EXPECTED],
    ['a README opening with a heading', 'missing-readme-label', 'services/finance/README.md', '# Finance\n\n**SYNTHETIC MODULE**\n', README_EXPECTED],
    ['an empty README', 'missing-readme-label', 'services/finance/README.md', '', README_EXPECTED],
    ['a README with the label mid-line', 'missing-readme-label', 'services/finance/README.md', 'Finance **SYNTHETIC MODULE**\n', README_EXPECTED],
    ['a README with a lower-case label', 'missing-readme-label', 'services/finance/README.md', '**synthetic module**\n', README_EXPECTED],
    ['a header with arbitrary text', 'malformed-label', 'services/finance/src/a.ts', '// SYNTHETIC: anything\n', TS_FINANCE_EXPECTED],
    ['an unterminated CFML tag header', 'malformed-label', 'legacy-fixtures/cfml/a.cfm', `<!--- SYNTHETIC: ${MODULE_TEXT}\n`, CFML_ANY_EXPECTED],
    ['a CFML tag header with arbitrary text', 'malformed-label', 'legacy-fixtures/cfml/a.cfm', '<!--- SYNTHETIC: x\n', CFML_ANY_EXPECTED],
    ['a CFML closer with no space', 'malformed-label', 'legacy-fixtures/cfml/a.cfc', `<!--- SYNTHETIC: ${MODULE_TEXT}--->\n`, CFML_ANY_EXPECTED],
    ['a CFML script header with a bare module', 'malformed-label', 'legacy-fixtures/a.cfc', '// SYNTHETIC: finance\n', CFML_ANY_EXPECTED],
    ['a CFML script header with a closer', 'malformed-label', 'legacy-fixtures/a.cfm', `// SYNTHETIC: ${MODULE_TEXT} --->\n`, CFML_ANY_EXPECTED],
    ['truncated wording', 'malformed-label', 'services/finance/src/a.ts', '// SYNTHETIC: finance - no Masa equivalent\n', TS_FINANCE_EXPECTED],
    ['other wording', 'malformed-label', 'legacy-fixtures/a.sql', '-- SYNTHETIC: finance - mirrors Masa; legacy oracle\n', SQL_ANY_EXPECTED],
    ['another service as module', 'malformed-label', 'services/finance/src/a.ts', `// SYNTHETIC: surveys - ${LABEL_TEXT}\n`, TS_FINANCE_EXPECTED],
    ['a script with a sub-module', 'malformed-label', 'services/finance/a.sh', `#!/bin/sh\n# SYNTHETIC: seed - ${LABEL_TEXT}\n`, SH_FINANCE_EXPECTED],
    ['a service name with no hyphen', 'malformed-label', 'services/e-signature/a.ts', `// SYNTHETIC: esignature - ${LABEL_TEXT}`, ESIGN_EXPECTED],
    ['text after the wording', 'malformed-label', 'services/finance/src/a.ts', `${TS_HEADER} (draft)\n`, TS_FINANCE_EXPECTED],
    ['text after the CFML closer', 'malformed-label', 'legacy-fixtures/cfml/a.cfc', `${CFML_TAG_HEADER} <cfcomponent>\n`, CFML_ANY_EXPECTED],
    ['an upper-case module', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', `// SYNTHETIC: Seed - ${LABEL_TEXT}\n`, TS_ANY_EXPECTED],
    ['a module with a space', 'malformed-label', 'web/app/opt2/admin/page.tsx', `// SYNTHETIC: opt2 admin - ${LABEL_TEXT}\n`, TS_ANY_EXPECTED],
    ['a module behind extra spaces', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', `// SYNTHETIC:  seed - ${LABEL_TEXT}\n`, TS_ANY_EXPECTED],
    ['a header with no module', 'malformed-label', 'legacy-fixtures/seed/src/a.ts', `// SYNTHETIC:  - ${LABEL_TEXT}\n`, TS_ANY_EXPECTED],
  ])('reports %s as %s', (_label, kind, relPath, content, expected) => {
    expect(checkLabel(relPath, content)).toEqual({ path: relPath, kind, expected });
  });
});

describe('checkSynthetic', () => {
  it('passes a tree whose every source file and README is labelled, listing the absent roots', async () => {
    await writeTree(LABELLED_TREE);
    await expect(checkSynthetic({ root })).resolves.toEqual({
      ok: true,
      checked: LABELLED_TREE_CHECKED,
      rootsMissing: LABELLED_TREE_ROOTS_MISSING,
      findings: [],
    } satisfies SyntheticCheckResult);
  });

  it('passes a tree holding every root with nothing in them, listing no root as missing', async () => {
    for (const synthetic of ALL_ROOTS) await mkdir(path.join(root, synthetic), { recursive: true });
    await expect(checkSynthetic({ root })).resolves.toEqual({
      ok: true,
      checked: NOTHING_CHECKED,
      rootsMissing: [],
      findings: [],
    });
  });

  it('reports each unlabelled file exactly once, sorted by path, and leaves labelled files out', async () => {
    await writeTree({
      ...LABELLED_TREE,
      'services/surveys/src/schedule.ts': 'export const cron = "0 * * * *";\n',
      'services/timesheets/src/approval.ts': `${SQL_HEADER}\nexport {};\n`,
      'legacy-fixtures/sql/surveys/010_surveys.sql': `${TS_HEADER}\nSELECT 1;\n`,
      'services/reporting/src/export.ts': `// synthetic: ${MODULE_TEXT}\n`,
      'services/communications/src/send.ts': `import fs from 'node:fs';\n\n${TS_HEADER}\n`,
      'legacy-fixtures/load-surveys.sh': `set -euo pipefail\n${SH_HEADER}\n`,
      'services/e-signature/README.md': '# E-signature\n',
      'web/app/opt2/finance/page.tsx': 'export default function Page() {\n  return null;\n}\n',
      'services/finance/src/forged.ts': '// SYNTHETIC: anything\n',
      'legacy-fixtures/cfml/open.cfm': '<!--- SYNTHETIC: x\n',
    });
    await write('services/finance/README.md', '# Finance\n');

    const result = await checkSynthetic({ root });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { path: 'legacy-fixtures/cfml/open.cfm', kind: 'malformed-label', expected: CFML_ANY_EXPECTED },
      { path: 'legacy-fixtures/load-surveys.sh', kind: 'missing-label', expected: SH_EXPECTED },
      { path: 'legacy-fixtures/sql/surveys/010_surveys.sql', kind: 'wrong-syntax', expected: SQL_EXPECTED },
      { path: 'services/communications/src/send.ts', kind: 'missing-label', expected: TS_EXPECTED },
      { path: 'services/e-signature/README.md', kind: 'missing-readme-label', expected: README_EXPECTED },
      { path: 'services/finance/README.md', kind: 'missing-readme-label', expected: README_EXPECTED },
      { path: 'services/finance/src/forged.ts', kind: 'malformed-label', expected: TS_FINANCE_EXPECTED },
      { path: 'services/reporting/src/export.ts', kind: 'missing-label', expected: TS_EXPECTED },
      { path: 'services/surveys/src/schedule.ts', kind: 'missing-label', expected: TS_EXPECTED },
      { path: 'services/timesheets/src/approval.ts', kind: 'wrong-syntax', expected: TS_EXPECTED },
      { path: 'web/app/opt2/finance/page.tsx', kind: 'missing-label', expected: TS_EXPECTED },
    ]);
    expect(result.checked).toEqual({ labelled: 16, readme: 2, exempt: 1 });
    expect(result.rootsMissing).toEqual([]);
  });

  it.each(['node_modules', 'dist', 'coverage', '.next', '.git', 'src/generated'])(
    'does not walk a %s directory inside a synthetic root',
    async (dir) => {
      await write(`services/finance/${dir}/nested/unlabelled.ts`, 'export {};\n');
      await write(`web/app/opt2/finance/${dir}/README.md`, '# Generated\n');
      const result = await checkSynthetic({ root });
      expect(result).toMatchObject({ ok: true, checked: NOTHING_CHECKED, findings: [] });
    },
  );

  it('walks a generated directory outside src and directories whose names only contain a skipped name', async () => {
    await write('services/finance/test/generated/fixture.ts', 'export {};\n');
    await write('services/finance/src/node_modules-shim/index.ts', 'export {};\n');
    await write('services/finance/distribution/build.sh', 'echo build\n');
    const result = await checkSynthetic({ root });
    expect(result.findings.map((finding) => finding.path)).toEqual([
      'services/finance/distribution/build.sh',
      'services/finance/src/node_modules-shim/index.ts',
      'services/finance/test/generated/fixture.ts',
    ]);
  });

  it('counts exempt files without reading a label from them', async () => {
    await writeTree({
      'services/finance/package.json': '{}\n',
      'services/finance/contracts/openapi.yaml': 'openapi: 3.1.0\n',
      'legacy-fixtures/seed/deps.lock': 'lock\n',
      'services/finance/TRACEABILITY.md': '# Traceability\n',
      'services/finance/Dockerfile': 'FROM node:22\n',
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
      'services/finance-archive/src/old.ts': 'export {};\n',
      'web/app/admin/page.tsx': 'export {};\n',
      'web/src/screens/people/List.tsx': 'export {};\n',
      'harness/src/tool.ts': 'export {};\n',
      'platform/src/index.ts': 'export {};\n',
    });
    await expect(checkSynthetic({ root })).resolves.toEqual({
      ok: true,
      checked: NOTHING_CHECKED,
      rootsMissing: ALL_ROOTS,
      findings: [],
    });
  });

  it('follows no symbolic link to a file or directory', async () => {
    const outsideFile = await write('elsewhere/unlabelled.ts', 'export {};\n');
    await write('elsewhere/nested/unlabelled.sql', 'SELECT 1;\n');
    await mkdir(path.join(root, 'services/finance/src'), { recursive: true });
    await symlink(outsideFile, path.join(root, 'services/finance/src/linked.ts'));
    await symlink(path.join(root, 'elsewhere/nested'), path.join(root, 'services/finance/linked-dir'));
    await expect(checkSynthetic({ root })).resolves.toMatchObject({
      ok: true,
      checked: NOTHING_CHECKED,
      findings: [],
    });
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
    await write('services/finance/src/unlabelled.ts', 'export {};\n', REPO_ROOT);

    const result = await checkSynthetic();

    expect(result.findings).toEqual([
      { path: 'services/finance/src/unlabelled.ts', kind: 'missing-label', expected: TS_EXPECTED },
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
      rootsMissing: LABELLED_TREE_ROOTS_MISSING,
      findings: [],
    });
  });

  it('exits 1 with one summary line naming the unlabelled file', async () => {
    await writeTree({ ...LABELLED_TREE, 'services/finance/src/unlabelled.ts': 'export {};\n' });
    const run = await runCheck(['--root', root]);
    expect(run.code).toBe(1);
    expect(run.exits).toEqual([1]);
    expect(run.output.split('\n')).toHaveLength(2);
    expect(run.line).toMatchObject({ command: COMMAND, ok: false, code: 1, root });
    expect(run.line['findings']).toEqual([
      { path: 'services/finance/src/unlabelled.ts', kind: 'missing-label', expected: TS_EXPECTED },
    ]);
  });

  it.each<[string, string[], string | undefined]>([
    ['an empty --root= value', ['--root='], '--root needs a directory'],
    ['an empty separate --root value', ['--root', ''], '--root needs a directory'],
    ['--root with no value', ['--root'], undefined],
    ['an unknown flag', ['--bogus'], undefined],
    ['a positional argument', ['services/finance'], undefined],
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
});
