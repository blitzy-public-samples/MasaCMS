import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

// Pass-through spy on rm, so a test can deliver a signal while generateCloc removes its scratch directory.
vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const { rm: actualRm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

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
  return vi.fn(async (_sha: string, _scratch: string) => mkdtemp(path.join(root, 'extract-')));
}

/** Listener counts of the signals that interrupt a measurement. */
function signalListeners(): number[] {
  return (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => process.listenerCount(signal));
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
    const listeners = signalListeners();
    const result = await generateCloc({
      out,
      extract,
      runner,
      clock: () => new Date('2026-06-30T12:00:00.000Z'),
      reference: fresh('reference.json'),
    });

    expect(extract).toHaveBeenCalledWith(pin.sha, expect.stringMatching(/\/opt2-cloc-[^/]+$/));
    const scratch = extract.mock.calls[0]?.[1] ?? '';
    expect(path.dirname(scratch)).toBe(path.resolve(os.tmpdir()));
    expect(existsSync(scratch)).toBe(false);
    const dir = await extract.mock.results[0]?.value;
    expect(existsSync(dir)).toBe(false);
    expect(signalListeners()).toEqual(listeners);
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
    const { planning } = await generateCloc({
      out,
      extract: tempExtractor(),
      runner: modeRunner(CANNED, CANNED_BY_FILE),
      reference: fresh('reference.json'),
    });
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
    const { report, planning } = await generateCloc({ out, extract: tempExtractor(), runner, reference: fresh('reference.json') });
    expect(report.measuredWith).toBe('cloc 2.04');
    expect(planning.versionMatches).toBe(false);
    expect(await readFile(path.join(out, 'cloc.md'), 'utf8')).toContain('this report was measured with cloc 2.04');
  });

  const FIRST_AT = '2026-06-30T12:00:00.000Z';
  const LATER_AT = '2026-07-01T08:30:00.000Z';

  /** Writes the canned measurement, clocked at `at`, into a fresh directory and returns it. */
  async function measuredOut(at: string, reference: string = fresh('reference.json')): Promise<string> {
    const out = fresh('out');
    const runner = modeRunner(CANNED, CANNED_BY_FILE);
    await generateCloc({ out, extract: tempExtractor(), runner, clock: () => new Date(at), reference });
    return out;
  }

  it('keeps the measurement time of an unchanged reference, so a rerun reproduces both files byte for byte', async () => {
    const first = await measuredOut(FIRST_AT);
    const second = await measuredOut(LATER_AT, path.join(first, 'cloc.json'));
    for (const name of ['cloc.json', 'cloc.md']) {
      expect(await readFile(path.join(second, name), 'utf8')).toBe(await readFile(path.join(first, name), 'utf8'));
    }
    const json = JSON.parse(await readFile(path.join(second, 'cloc.json'), 'utf8'));
    expect([json.measuredAt, json.generatedAt]).toEqual([FIRST_AT, FIRST_AT]);
  });

  it.each<[string, ((text: string) => string) | undefined]>([
    ['is absent', undefined],
    ['is not JSON', () => '{'],
    ['is JSON null', () => 'null'],
    ['records other figures', (text) => text.replace('"code": 105', '"code": 106')],
    ['has a measuredAt that is not a time', (text) => text.replaceAll(FIRST_AT, 'yesterday')],
    ['has a non-canonical measuredAt', (text) => text.replaceAll(FIRST_AT, '2026-06-30T12:00:00Z')],
  ])('stamps the clock time when the reference %s', async (_case, edit) => {
    const reference = fresh('reference.json');
    if (edit !== undefined) {
      const first = await measuredOut(FIRST_AT);
      await writeFile(reference, edit(await readFile(path.join(first, 'cloc.json'), 'utf8')), 'utf8');
    }
    const second = await measuredOut(LATER_AT, reference);
    const json = JSON.parse(await readFile(path.join(second, 'cloc.json'), 'utf8'));
    expect([json.measuredAt, json.generatedAt]).toEqual([LATER_AT, LATER_AT]);
    expect(await readFile(path.join(second, 'cloc.md'), 'utf8')).toContain(`measured at: ${LATER_AT}`);
  });

  it('rethrows a reference that cannot be read for a reason other than its absence, writing nothing', async () => {
    const out = fresh('out');
    const runner = modeRunner(CANNED, CANNED_BY_FILE);
    await expect(generateCloc({ out, extract: tempExtractor(), runner, reference: root })).rejects.toThrow(/EISDIR/);
    expect(existsSync(out)).toBe(false);
  });

  it('removes the scratch directory and the extraction when cloc is unavailable', async () => {
    const extract = tempExtractor();
    await expect(generateCloc({ out: fresh('out'), extract, runner: enoentRunner })).rejects.toBeInstanceOf(ClocUnavailable);
    expect(existsSync(await extract.mock.results[0]?.value)).toBe(false);
    expect(existsSync(extract.mock.calls[0]?.[1] ?? '')).toBe(false);
  });

  it('refuses an extraction inside the checkout and leaves it in place', async () => {
    const runner = cannedRunner(CANNED);
    const extract = vi.fn(async (_sha: string, _scratch: string) => REPO_ROOT);
    await expect(generateCloc({ out: fresh('out'), extract, runner })).rejects.toThrow(/outside the repository checkout/);
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(path.join(REPO_ROOT, 'harness', 'package.json'))).toBe(true);
    expect(existsSync(extract.mock.calls[0]?.[1] ?? '')).toBe(false);
  });
});

describe('generateCloc on an interrupting signal', () => {
  const STEPS = ['extraction', 'filtered count', 'unfiltered count'] as const;

  it.each<[NodeJS.Signals, (typeof STEPS)[number], number]>([
    ['SIGTERM', 'extraction', 143],
    ['SIGTERM', 'filtered count', 143],
    ['SIGINT', 'unfiltered count', 130],
    ['SIGHUP', 'filtered count', 129],
  ])('on %s during the %s, finishes that step, removes the scratch extraction, then exits %i', async (signal, step, status) => {
    const before = signalListeners();
    let scratch = '';
    let during: number[] = [];
    let afterSignal: number[] = [];
    let atExit: { scratch: boolean; listeners: number[] } | undefined;
    const interrupt = (): void => {
      during = signalListeners();
      process.emit(signal, signal);
      afterSignal = signalListeners();
    };
    const extract = vi.fn(async (_sha: string, dir: string) => {
      scratch = dir;
      const tree = path.join(dir, 'tree');
      await mkdir(tree);
      await writeFile(path.join(tree, 'userBean.cfc'), 'component {}\n', 'utf8');
      if (step === 'extraction') interrupt();
      return tree;
    });
    const runner = vi.fn<ClocRunner>(async (_file, args) => {
      const byFile = args.includes('--by-file');
      if (step === (byFile ? 'filtered count' : 'unfiltered count')) interrupt();
      return { stdout: JSON.stringify(byFile ? CANNED_BY_FILE : CANNED), stderr: '' };
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      atExit = { scratch: existsSync(scratch), listeners: signalListeners() };
    }) as typeof process.exit);
    const out = fresh('out');
    try {
      await expect(generateCloc({ out, extract, runner, reference: fresh('reference.json') })).rejects.toThrow(
        `cloc measurement interrupted by ${signal}`,
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith(status);
    } finally {
      exit.mockRestore();
    }
    expect(during).toEqual(before.map((count) => count + 1));
    expect(afterSignal).toEqual(before);
    expect(atExit).toEqual({ scratch: false, listeners: before });
    expect(path.dirname(scratch)).toBe(path.resolve(os.tmpdir()));
    expect(runner).toHaveBeenCalledTimes(STEPS.indexOf(step));
    expect(existsSync(out)).toBe(false);
  });

  it.each<[NodeJS.Signals, number]>([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ])('on %s while the scratch extraction is removed, finishes the removal, then exits %i writing nothing', async (signal, status) => {
    const before = signalListeners();
    let tree = '';
    let removing = '';
    let during: number[] = [];
    let atExit: { scratch: boolean; tree: boolean; listeners: number[] } | undefined;
    const extract = vi.fn(async (_sha: string, scratch: string) => {
      tree = path.join(scratch, 'tree');
      await mkdir(tree);
      await writeFile(path.join(tree, 'userBean.cfc'), 'component {}\n', 'utf8');
      return tree;
    });
    vi.mocked(rm).mockImplementationOnce(async (target, options) => {
      removing = String(target);
      const removal = actualRm(target, options);
      during = signalListeners();
      process.emit(signal, signal);
      return removal;
    });
    // A real exit never returns, so the spy throws to keep the measurement from writing its reports.
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      atExit = { scratch: existsSync(removing), tree: existsSync(tree), listeners: signalListeners() };
      throw new Error(`process.exit(${code})`);
    });
    const out = fresh('out');
    const runner = modeRunner(CANNED, CANNED_BY_FILE);
    try {
      await expect(generateCloc({ out, extract, runner, reference: fresh('reference.json') })).rejects.toThrow(
        `process.exit(${status})`,
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith(status);
    } finally {
      exit.mockRestore();
      vi.mocked(rm).mockReset();
    }
    expect(runner).toHaveBeenCalledTimes(2);
    expect(removing).toBe(path.dirname(tree));
    expect(during).toEqual(before.map((count) => count + 1));
    expect(atExit).toEqual({ scratch: false, tree: false, listeners: before });
    expect(existsSync(out)).toBe(false);
  });

  it('removes its listeners and rethrows when the scratch removal fails', async () => {
    const before = signalListeners();
    const extract = tempExtractor();
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    const out = fresh('out');
    try {
      const runner = modeRunner(CANNED, CANNED_BY_FILE);
      await expect(generateCloc({ out, extract, runner, reference: fresh('reference.json') })).rejects.toThrow('EBUSY');
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      vi.mocked(rm).mockReset();
      for (const left of [extract.mock.calls[0]?.[1], await extract.mock.results[0]?.value]) {
        if (left !== undefined) await actualRm(left, { recursive: true, force: true });
      }
    }
    expect(signalListeners()).toEqual(before);
    expect(existsSync(out)).toBe(false);
  });
});

describe('main', () => {
  it.each([[['--out', '']], [['--unknown']]])('rejects %j as usage', async (argv) => {
    await expect(main(argv)).rejects.toBeInstanceOf(UsageError);
  });

  it.each([
    ['a relative --out against the working directory', false],
    ['an absolute --out as given', true],
  ])('resolves %s', async (_case, absolute) => {
    const cwd = fresh('cwd');
    await mkdir(cwd);
    const expected = absolute ? fresh('abs-out') : path.join(cwd, 'rel', 'out');
    const deps = { extract: tempExtractor(), runner: modeRunner(CANNED, CANNED_BY_FILE), reference: fresh('reference.json') };
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      const outcome = await main(['--out', absolute ? expected : path.join('rel', 'out')], deps);
      expect(outcome.summary).toMatchObject({ json: path.join(expected, 'cloc.json'), md: path.join(expected, 'cloc.md') });
    } finally {
      cwdSpy.mockRestore();
    }
    expect(existsSync(path.join(expected, 'cloc.json'))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, 'rel'))).toBe(false);
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
    expect(output).toContain('a relative path resolves against the working directory');
  });
});
