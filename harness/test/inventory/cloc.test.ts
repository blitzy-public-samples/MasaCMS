import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CFML_LANGUAGES,
  CLOC_EXCLUSIONS,
  CLOC_NOT_MATCH_D,
  CLOC_NOT_MATCH_F,
  ClocUnavailable,
  PLANNING_FIGURES,
  UNFILTERED_NOT_MATCH_D,
  UNFILTERED_NOT_MATCH_F,
  buildClocReport,
  cfmlFigure,
  clocArgs,
  comparePlanning,
  generateCloc,
  main,
  reportLanguages,
  runCloc,
  type ClocLanguage,
  type ClocRunner,
} from '../../src/inventory/cloc.js';
import type { ClocResult } from '../../src/inventory/cloc.js';
import { UsageError, runCli } from '../../src/lib/cli.js';
import { REPO_ROOT } from '../../src/lib/paths.js';
import { readPin } from '../../src/lib/pin.js';

const CANNED = {
  header: { cloc_version: '1.98', n_files: 3, n_lines: 120 },
  'ColdFusion CFScript': { nFiles: 1, blank: 5, comment: 2, code: 40 },
  ColdFusion: { nFiles: 1, blank: 3, comment: 1, code: 30 },
  SQL: { nFiles: 1, blank: 4, comment: 0, code: 35 },
  SUM: { nFiles: 3, blank: 12, comment: 3, code: 105 },
};

const CANNED_BY_FILE = {
  header: { cloc_version: '1.98', n_files: 3, n_lines: 120 },
  './core/mura/user/userBean.cfc': { language: 'ColdFusion CFScript', blank: 5, comment: 2, code: 40 },
  './admin/core/views/cusers/list.cfm': { language: 'ColdFusion', blank: 3, comment: 1, code: 30 },
  './core/setup/db/mssql.sql': { language: 'SQL', blank: 4, comment: 0, code: 35 },
  SUM: { nFiles: 3, blank: 12, comment: 3, code: 105 },
};

const SCRATCH_ROOT = '/tmp/x/';
const pin = readPin();

let root: string;
let serial = 0;

/** A fresh, not yet created path under the temp root. */
function fresh(name: string): string {
  serial += 1;
  return path.join(root, `${serial}-${name}`);
}

/** Runner answering every call with `payload` as cloc JSON. */
function cannedRunner(payload: unknown, extra: { stderr?: string; code?: number } = {}) {
  return vi.fn<ClocRunner>(async () => ({ stdout: JSON.stringify(payload), stderr: extra.stderr ?? '', code: extra.code }));
}

/** Runner answering by-file calls with `byFile` and the others with `byLanguage`. */
function modeRunner(byLanguage: unknown, byFile: unknown) {
  return vi.fn<ClocRunner>(async (_file, args) => ({
    stdout: JSON.stringify(args.includes('--by-file') ? byFile : byLanguage),
    stderr: '',
  }));
}

/** Extractor returning a new empty directory under the temp root. */
function tempExtractor() {
  return vi.fn(async (_sha: string) => mkdtemp(path.join(root, 'extract-')));
}

const enoentRunner: ClocRunner = async () => {
  throw Object.assign(new Error('spawn cloc ENOENT'), { code: 'ENOENT' });
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-cloc-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('exclusions', () => {
  it('groups the vendored, generated and tooling patterns verbatim', () => {
    expect(Object.keys(CLOC_EXCLUSIONS)).toEqual(['vendored', 'generated', 'tooling']);
    expect(CLOC_EXCLUSIONS.vendored.items).toEqual([
      'core/vendor',
      'core/mura/lib',
      'admin/assets/js/{jquery,filebrowser/assets,bootstrap-slider,porthole,minigrid}',
      'oneui.js',
      'shadowbox.js',
      'DD_belatedPNG.js',
      'html5.js',
      'less.js',
      'bootstrap-tabdrop.js',
      'ios-drag-drop.js',
    ]);
    expect(CLOC_EXCLUSIONS.generated.items).toEqual([
      'admin/assets/css/{admin,admin-frontend,ie}.css',
      'core_assets/css/mura.7.x(.skin).css',
      '*.min.js',
      '*.min.css',
      '*.map',
      'cta/js/mura.displayobject.cta.js',
      'cta/js/src/templates.js',
      'core_assets/js/mura.js',
      'admin/assets/js/mura.js',
    ]);
    expect(CLOC_EXCLUSIONS.tooling.items).toEqual(['node_modules', '.git', 'package-lock.json']);
    for (const group of Object.values(CLOC_EXCLUSIONS)) expect(group.why.length).toBeGreaterThan(0);
  });

  it('equals the regexes and exclusion block of the committed cloc.json', async () => {
    const committed = JSON.parse(await readFile(path.join(REPO_ROOT, 'opt2/inventory/cloc.json'), 'utf8'));
    expect(CLOC_NOT_MATCH_D).toBe(committed.command.notMatchD);
    expect(CLOC_NOT_MATCH_F).toBe(committed.command.notMatchF);
    expect(JSON.parse(JSON.stringify(CLOC_EXCLUSIONS))).toEqual(committed.exclusions);
  });

  it.each(['core/vendor/x', 'node_modules/y', 'admin/assets/js/jquery', 'core/mura/lib/z.cfc', '.github/ISSUE_TEMPLATE'])(
    'excludes the directory of %s',
    (sample) => {
      expect(new RegExp(CLOC_NOT_MATCH_D).test(`${SCRATCH_ROOT}${sample}`)).toBe(true);
    },
  );

  it.each([
    'admin/assets/css/admin.css',
    'x.min.js',
    'y.min.css',
    'z.js.map',
    'admin/assets/js/shadowbox.js',
    'package-lock.json',
    'core/modules/v1/core_assets/css/mura.7.4.skin.css',
    'core/modules/v1/core_assets/js/mura.js',
    'core/modules/v1/cta/js/src/templates.js',
  ])('excludes the file %s', (sample) => {
    expect(new RegExp(CLOC_NOT_MATCH_F).test(`${SCRATCH_ROOT}${sample}`)).toBe(true);
  });

  it.each([
    'core/mura/user/userBean.cfc',
    'admin/core/controllers/cusers.cfc',
    'core/mura/libraryBean.cfc',
    'admin/assets/css/admin-sidebar.css',
    'core/modules/v1/core_assets/css/less/mura.7.2.less',
  ])('keeps %s', (sample) => {
    const full = `${SCRATCH_ROOT}${sample}`;
    expect(new RegExp(CLOC_NOT_MATCH_D).test(full) || new RegExp(CLOC_NOT_MATCH_F).test(full)).toBe(false);
  });

  it('excludes vendor directories at any depth and minified files from the unfiltered measurement', () => {
    const d = new RegExp(UNFILTERED_NOT_MATCH_D);
    const f = new RegExp(UNFILTERED_NOT_MATCH_F);
    expect(d.test(`${SCRATCH_ROOT}admin/assets/js/jquery/vendor/widget.js`)).toBe(true);
    expect(d.test(`${SCRATCH_ROOT}core/mura/lib/x.cfc`)).toBe(false);
    expect(f.test(`${SCRATCH_ROOT}a.min.js`)).toBe(true);
    expect(f.test(`${SCRATCH_ROOT}admin/assets/css/admin.css`)).toBe(false);
  });
});

describe('runCloc', () => {
  it('passes the flags in order with `.` as the target inside the directory', async () => {
    const runner = cannedRunner(CANNED);
    await runCloc(root, { notMatchD: CLOC_NOT_MATCH_D, notMatchF: CLOC_NOT_MATCH_F, runner });
    expect(runner).toHaveBeenCalledWith(
      'cloc',
      ['--json', '--fullpath', '--quiet', `--not-match-d=${CLOC_NOT_MATCH_D}`, `--not-match-f=${CLOC_NOT_MATCH_F}`, '.'],
      { cwd: root },
    );
  });

  it.each([
    [{}, ['--json', '--fullpath', '--quiet', '.']],
    [{ notMatchD: 'src/generated' }, ['--json', '--fullpath', '--quiet', '--not-match-d=src/generated', '.']],
    [{ byFile: true }, ['--json', '--fullpath', '--quiet', '--by-file', '.']],
    [{ listFile: 'files.txt' }, ['--json', '--fullpath', '--quiet', '--list-file=files.txt']],
  ])('builds the arguments for %j', (opts, expected) => {
    expect(clocArgs(opts)).toEqual(expected);
  });

  it('parses languages by code lines, the SUM totals and the cloc version', async () => {
    const result = await runCloc(root, { runner: cannedRunner(CANNED) });
    expect(result.version).toBe('1.98');
    expect(result.totals).toEqual({ files: 3, blank: 12, comment: 3, code: 105 });
    expect(result.languages).toEqual([
      { language: 'ColdFusion CFScript', files: 1, blank: 5, comment: 2, code: 40 },
      { language: 'SQL', files: 1, blank: 4, comment: 0, code: 35 },
      { language: 'ColdFusion', files: 1, blank: 3, comment: 1, code: 30 },
    ]);
    expect(result.byFile).toBeUndefined();
  });

  it('returns per-file rows relative to the directory and their language totals in by-file mode', async () => {
    const result = await runCloc(root, { byFile: true, runner: cannedRunner(CANNED_BY_FILE) });
    expect(result.byFile?.map((row) => row.path)).toEqual([
      'admin/core/views/cusers/list.cfm',
      'core/mura/user/userBean.cfc',
      'core/setup/db/mssql.sql',
    ]);
    expect(result.languages.map((row) => [row.language, row.files, row.code])).toEqual([
      ['ColdFusion CFScript', 1, 40],
      ['SQL', 1, 35],
      ['ColdFusion', 1, 30],
    ]);
    expect(result.totals.code).toBe(105);
  });

  it('reports an empty count when cloc finds nothing and says nothing', async () => {
    const result = await runCloc(root, { runner: cannedRunner({}) });
    expect(result).toEqual({ version: null, languages: [], totals: { files: 0, blank: 0, comment: 0, code: 0 } });
  });

  it('throws ClocUnavailable when the cloc binary is missing', async () => {
    await expect(runCloc(root, { runner: enoentRunner })).rejects.toBeInstanceOf(ClocUnavailable);
    await expect(runCloc(root, { runner: enoentRunner })).rejects.toThrow('cloc 1.98 required (apt: cloc)');
  });

  it.each([
    ['a non-zero exit code', cannedRunner(CANNED, { code: 2 }), /exited with status 2/],
    ['invalid JSON', vi.fn<ClocRunner>(async () => ({ stdout: 'not json', stderr: '' })), /not cloc JSON/],
    ['a malformed language row', cannedRunner({ SQL: { nFiles: 'one' } }), /not cloc JSON/],
    ['an unreadable input', cannedRunner({}, { stderr: 'Unable to read: x' }), /counted nothing/],
  ])('rejects %s', async (_case, runner, message) => {
    await expect(runCloc(root, { runner })).rejects.toThrow(message);
  });

  it('rethrows other runner failures unchanged', async () => {
    const failure = new Error('killed');
    await expect(runCloc(root, { runner: async () => Promise.reject(failure) })).rejects.toBe(failure);
  });

  it('rejects a directory that does not exist or is a file', async () => {
    const runner = cannedRunner(CANNED);
    await expect(runCloc(fresh('missing'), { runner })).rejects.toThrow(/ENOENT/);
    const file = fresh('file.txt');
    await writeFile(file, 'x', 'utf8');
    await expect(runCloc(file, { runner })).rejects.toThrow(/is not a directory/);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('languages and planning figures', () => {
  it('sums the CFML languages', async () => {
    expect([...CFML_LANGUAGES].sort()).toEqual(['ColdFusion', 'ColdFusion CFScript']);
    const result = await runCloc(root, { runner: cannedRunner(CANNED) });
    expect(cfmlFigure(result)).toEqual({ files: 2, code: 70 });
  });

  it('labels languages and groups the small ones into one trailing row', () => {
    const rows: ClocLanguage[] = [
      { language: 'ColdFusion', files: 2, blank: 0, comment: 0, code: 50 },
      { language: 'JSON', files: 1, blank: 0, comment: 0, code: 9 },
      { language: 'Text', files: 2, blank: 0, comment: 0, code: 4 },
    ];
    expect(reportLanguages(rows)).toEqual([
      { language: 'ColdFusion', label: 'ColdFusion (tags)', files: 2, code: 50 },
      {
        language: 'Text, JSON',
        label: 'Text, JSON',
        files: 3,
        code: 13,
        aggregate: true,
        languagesIncluded: ['Text', 'JSON'],
        breakdown: [
          { language: 'Text', files: 2, code: 4 },
          { language: 'JSON', files: 1, code: 9 },
        ],
      },
    ]);
  });

  it('matches the planning figures when every measured figure equals them', () => {
    const grouped: [string, number, number][] = [
      ['Text', 6, 483],
      ['JSON', 6, 430],
      ['YAML', 5, 219],
      ['Markdown', 8, 120],
      ['HTML', 4, 80],
      ['Handlebars', 3, 17],
    ];
    const languages: ClocLanguage[] = [
      ...Object.entries(PLANNING_FIGURES.languages)
        .filter(([name]) => !name.includes(','))
        .map(([language, f]) => ({ language, files: f.files, blank: 0, comment: 0, code: f.code })),
      ...grouped.map(([language, files, code]) => ({ language, files, blank: 0, comment: 0, code })),
    ];
    const filtered: ClocResult = { version: '1.98', languages, totals: { files: 1179, blank: 0, comment: 0, code: 228839 } };
    const unfiltered: ClocResult = { version: '1.98', languages: [], totals: { files: 1243, blank: 0, comment: 0, code: 362994 } };
    const report = buildClocReport(pin.sha, filtered, unfiltered, new Date(0));
    expect(comparePlanning(report)).toEqual({ matchesPlanning: true, versionMatches: true, differences: [] });
  });
});

describe('generateCloc', () => {
  it('writes the measured cloc.json and cloc.md from the filtered and unfiltered runs', async () => {
    const extract = tempExtractor();
    const runner = modeRunner(CANNED, CANNED_BY_FILE);
    const out = fresh('out');
    const result = await generateCloc({ out, extract, runner, clock: () => new Date('2026-06-30T12:00:00.000Z') });

    expect(extract).toHaveBeenCalledWith(pin.sha);
    const dir = await extract.mock.results[0]?.value;
    expect(existsSync(dir)).toBe(false);
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      ['--json', '--fullpath', '--quiet', `--not-match-d=${CLOC_NOT_MATCH_D}`, `--not-match-f=${CLOC_NOT_MATCH_F}`, '--by-file', '.'],
      ['--json', '--fullpath', '--quiet', `--not-match-d=${UNFILTERED_NOT_MATCH_D}`, `--not-match-f=${UNFILTERED_NOT_MATCH_F}`, '.'],
    ]);

    const json = JSON.parse(await readFile(path.join(out, 'cloc.json'), 'utf8'));
    expect(json).toMatchObject({
      sourceSha: pin.sha,
      generatedBy: 'harness/src/inventory/cloc.ts',
      extractedFrom: `git archive ${pin.sha}`,
      measuredWith: 'cloc 1.98',
      measuredAt: '2026-06-30T12:00:00.000Z',
      provenance: 'measured',
      totals: { files: 3, code: 105 },
      cfmlApplicationCode: { languages: ['ColdFusion CFScript', 'ColdFusion'], files: 2, code: 70 },
      unfiltered: { notMatchD: UNFILTERED_NOT_MATCH_D, files: 3, code: 105 },
      detail: { blank: 12, comment: 3 },
    });
    expect(json.command.args).toEqual(runner.mock.calls[0]?.[1]);
    expect(json.detail.perFile).toHaveLength(3);
    expect(result.jsonPath).toBe(path.join(out, 'cloc.json'));

    const md = await readFile(result.mdPath, 'utf8');
    expect(md).toContain(`Source SHA: ${pin.sha}`);
    for (const group of Object.values(CLOC_EXCLUSIONS)) {
      for (const item of group.items) expect(md).toContain(`\`${item}\``);
    }
    expect(md).toContain(`\`${CLOC_NOT_MATCH_D}\``);
    expect(md).toContain(`\`${CLOC_NOT_MATCH_F}\``);
  });

  it('reports and notes every figure that differs from the planning measurement', async () => {
    const out = fresh('out');
    const { planning } = await generateCloc({ out, extract: tempExtractor(), runner: modeRunner(CANNED, CANNED_BY_FILE) });
    expect(planning.matchesPlanning).toBe(false);
    expect(planning.differences).toContainEqual({ figure: 'totals', planning: { files: 1179, code: 228839 }, measured: { files: 3, code: 105 } });
    expect(planning.differences).toContainEqual({ figure: 'languages.LESS', planning: { files: 153, code: 32856 }, measured: null });
    const md = await readFile(path.join(out, 'cloc.md'), 'utf8');
    expect(md).toContain('| totals | 1,179 | 228,839 | 3 | 105 |');
    expect(md).toContain('| languages.LESS | 153 | 32,856 | — | — |');
  });

  it('records and notes a cloc version other than 1.98', async () => {
    const header = { cloc_version: '2.04' };
    const out = fresh('out');
    const runner = modeRunner({ ...CANNED, header }, { ...CANNED_BY_FILE, header });
    const { report, planning } = await generateCloc({ out, extract: tempExtractor(), runner });
    expect(report.measuredWith).toBe('cloc 2.04');
    expect(planning.versionMatches).toBe(false);
    expect(await readFile(path.join(out, 'cloc.md'), 'utf8')).toContain('this report was measured with cloc 2.04');
  });

  it('removes the extraction when cloc is unavailable', async () => {
    const extract = tempExtractor();
    await expect(generateCloc({ out: fresh('out'), extract, runner: enoentRunner })).rejects.toBeInstanceOf(ClocUnavailable);
    expect(existsSync(await extract.mock.results[0]?.value)).toBe(false);
  });

  it('refuses an extraction inside the checkout and leaves it in place', async () => {
    const runner = cannedRunner(CANNED);
    await expect(generateCloc({ out: fresh('out'), extract: async () => REPO_ROOT, runner })).rejects.toThrow(
      /outside the repository checkout/,
    );
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(path.join(REPO_ROOT, 'harness', 'package.json'))).toBe(true);
  });
});

describe('main', () => {
  it.each([[['--out', '']], [['--unknown']]])('rejects %j as usage', async (argv) => {
    await expect(main(argv)).rejects.toBeInstanceOf(UsageError);
  });

  it('--help prints the help text naming every flag, with no JSON line, exits 0 and writes no report', async () => {
    const report = path.join(REPO_ROOT, 'opt2', 'inventory', 'cloc.json');
    const before = (await stat(report)).mtimeMs;
    const chunks: string[] = [];
    const exits: number[] = [];
    const code = await runCli(main, {
      argv: ['--help'],
      command: 'harness/src/inventory/cloc.ts',
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit: (exitCode) => exits.push(exitCode),
    });
    const output = chunks.join('');
    expect(code).toBe(0);
    expect(exits).toEqual([0]);
    expect(output.startsWith('cloc [--out <dir>] [--help]\n')).toBe(true);
    expect(output.endsWith('\n') && !output.endsWith('\n\n')).toBe(true);
    for (const flag of ['--out <dir>', '--help']) expect(output).toContain(`  ${flag}`);
    expect(output).not.toContain(`"command":`);
    expect((await stat(report)).mtimeMs).toBe(before);
  });
});
