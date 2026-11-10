import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catFileExists,
  commitSubject,
  defaultRunner,
  diffNames,
  gitArchiveExtract,
  lsFiles,
  lsTree,
  type GitDeps,
  type ProcessRunner,
} from '../../src/lib/git.js';
import { REPO_ROOT, assertOutsideRepo } from '../../src/lib/paths.js';

// Pass-through spy, so tests can see each path gitArchiveExtract checks and fail one check on demand.
vi.mock(import('../../src/lib/paths.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, assertOutsideRepo: vi.fn(actual.assertOutsideRepo) };
});

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const PIN_SUBJECT = 'Increase version to 7.6.1 in package files and configuration';
const MISSING_SHA = '0'.repeat(40);
// A shallow clone lacks the pin commit; read at collection so runIf can skip the pin cases.
const pinPresent = await catFileExists(SHA);
// Never created or entered: only fake runners receive it.
const FAKE_CWD = path.join(os.tmpdir(), 'opt2-git-test-fake-cwd');
const guard = vi.mocked(assertOutsideRepo);

/** Committed contents of the scratch repository; the names exercise NUL splitting. */
const COMMITTED: Record<string, string> = {
  '.gitignore': '*.log\n',
  'plain.txt': 'plain\n',
  'dir/nested file.txt': 'nested\n',
  'line\nbreak.txt': 'newline in name\n',
  'tab\tname.txt': 'tab in name\n',
  'ünïcode.txt': 'unicode\n',
  'modified.txt': 'before\n',
  'deleted.txt': 'deleted\n',
};
const COMMITTED_NAMES = Object.keys(COMMITTED);
const INDEX_NAMES = [...COMMITTED_NAMES, 'staged.txt'];

interface Call {
  file: string;
  args: string[];
  cwd: string;
}

/** Runner recording each call; resolves with `answer`'s stdout, or rejects with what it throws. */
function recorder(answer: (call: Call) => string | Promise<string> = () => ''): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProcessRunner = async (file, args, opts) => {
    const call: Call = { file, args: [...args], cwd: opts.cwd };
    calls.push(call);
    return { stdout: await answer(call), stderr: '' };
  };
  return { run, calls };
}

/** Fake archive side effects: `git` writes its `--output` tar, `tar` writes one file into its working directory. */
async function fakeArchiveStep(call: Call): Promise<void> {
  if (call.file === 'git') {
    const output = call.args.find((arg) => arg.startsWith('--output='));
    if (output !== undefined) await writeFile(output.slice('--output='.length), 'placeholder tar');
  } else {
    await writeFile(path.join(call.cwd, 'extracted.txt'), 'placeholder file');
  }
}

/** Real git in `cwd` with a placeholder identity; resolves with stdout. */
async function realGit(cwd: string, ...args: string[]): Promise<string> {
  const config = [
    '-c', 'user.name=OPT2 Test',
    '-c', 'user.email=opt2-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main',
  ];
  return (await defaultRunner('git', [...config, ...args], { cwd })).stdout;
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

/** Relative path to contents of every file under `dir`. */
async function contentsUnder(dir: string): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    contents[path.relative(dir, file)] = await readFile(file, 'utf8');
  }
  return contents;
}

let root = '';
let repo = '';
let head = '';
let tree = '';

/** New empty directory under this file's scratch root. */
function caseDir(): Promise<string> {
  return mkdtemp(path.join(root, 'case-'));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-git-test-'));
  repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'dir'), { recursive: true });
  await realGit(repo, 'init', '-q');
  for (const [name, text] of Object.entries(COMMITTED)) await writeFile(path.join(repo, name), text);
  await realGit(repo, 'add', '-A');
  await realGit(repo, 'commit', '-q', '-m', 'Fixture commit subject');
  head = (await realGit(repo, 'rev-parse', 'HEAD')).trim();
  tree = (await realGit(repo, 'rev-parse', 'HEAD^{tree}')).trim();
  await writeFile(path.join(repo, 'modified.txt'), 'after\n');
  await rm(path.join(repo, 'deleted.txt'));
  await writeFile(path.join(repo, 'staged.txt'), 'staged\n');
  await realGit(repo, 'add', 'staged.txt');
  await writeFile(path.join(repo, 'untracked.txt'), 'untracked\n');
  await writeFile(path.join(repo, 'ignored.log'), 'ignored\n');
});

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  guard.mockReset();
});

describe('defaultRunner', () => {
  it('passes arguments to the executable without a shell and decodes stdout and stderr as UTF-8', async () => {
    await expect(defaultRunner('git', ['log', '-1', '--format=$HOME %s', head], { cwd: repo })).resolves.toEqual({
      stdout: '$HOME Fixture commit subject\n',
      stderr: '',
    });
  });

  it('runs in opts.cwd', async () => {
    const { stdout } = await defaultRunner('git', ['rev-parse', '--show-toplevel'], { cwd: repo });
    expect(stdout.trim()).toBe(await realpath(repo));
  });

  it('accepts output beyond the 1 MiB execFile default', async () => {
    const script = "process.stdout.write('x'.repeat(2 * 1024 * 1024))";
    const { stdout } = await defaultRunner(process.execPath, ['-e', script], { cwd: root });
    expect(stdout).toHaveLength(2 * 1024 * 1024);
  });

  it.each<[string, string, string[], { maxBuffer?: number }, number | string]>([
    ['a non-zero exit with its numeric status', 'git', ['cat-file', '-e', `${MISSING_SHA}^{commit}`], {}, 128],
    ['a missing executable with ENOENT', 'opt2-no-such-executable', [], {}, 'ENOENT'],
    ['output beyond opts.maxBuffer', process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], { maxBuffer: 1024 }, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'],
  ])('rejects on %s', async (_label, file, args, opts, code) => {
    await expect(defaultRunner(file, args, { cwd: REPO_ROOT, ...opts })).rejects.toMatchObject({ code });
  });
});

describe.each<[string, (deps: GitDeps) => Promise<unknown>, string[]]>([
  ['lsTree', (deps) => lsTree(SHA, deps), ['ls-tree', '-r', '--name-only', '-z', SHA]],
  ['lsFiles', (deps) => lsFiles({ cached: true }, deps), ['ls-files', '-z', '--cached']],
  ['diffNames', (deps) => diffNames(SHA, 'M', deps), ['diff', '--name-only', '-z', '--diff-filter=M', SHA]],
  ['commitSubject', (deps) => commitSubject(SHA, deps), ['log', '-1', '--format=%s', SHA]],
  ['catFileExists', (deps) => catFileExists(SHA, deps), ['cat-file', '-e', `${SHA}^{commit}`]],
])('%s command', (_name, call, args) => {
  it.each<[string, string | undefined, string]>([
    ['REPO_ROOT by default', undefined, REPO_ROOT],
    ['deps.cwd when given', FAKE_CWD, FAKE_CWD],
  ])('runs git once with its arguments in %s', async (_label, cwd, expectedCwd) => {
    const { run, calls } = recorder();
    await call({ run, cwd });
    expect(calls).toEqual([{ file: 'git', args, cwd: expectedCwd }]);
  });
});

describe.each<[string, (deps: GitDeps) => Promise<string[]>]>([
  ['lsTree', (deps) => lsTree(SHA, deps)],
  ['lsFiles', (deps) => lsFiles({}, deps)],
  ['diffNames', (deps) => diffNames(SHA, 'AM', deps)],
])('%s output', (_name, list) => {
  it.each<[string, string, string[]]>([
    ['empty output into no paths', '', []],
    ['NUL-terminated entries', 'a.txt\0dir/b c.txt\0', ['a.txt', 'dir/b c.txt']],
    ['an unterminated last entry', 'a.txt\0b.txt', ['a.txt', 'b.txt']],
    ['newlines, tabs, quotes and non-ASCII verbatim', 'line\nbreak\0tab\tname\0"quoted"\0ünïcode\0', ['line\nbreak', 'tab\tname', '"quoted"', 'ünïcode']],
    ['away empty entries', '\0a.txt\0\0b.txt\0\0', ['a.txt', 'b.txt']],
  ])('splits %s on NUL', async (_label, stdout, expected) => {
    const { run } = recorder(() => stdout);
    await expect(list({ run })).resolves.toEqual(expected);
  });
});

describe.each<[string, (deps: GitDeps) => Promise<unknown>]>([
  ['lsTree', (deps) => lsTree(SHA, deps)],
  ['lsFiles', (deps) => lsFiles({ cached: true }, deps)],
  ['diffNames', (deps) => diffNames(SHA, 'DMRT', deps)],
  ['commitSubject', (deps) => commitSubject(SHA, deps)],
])('%s failure', (_name, call) => {
  it('propagates a non-zero git exit as the same rejection', async () => {
    const failure = Object.assign(new Error('git exited 128'), { code: 128 });
    const { run, calls } = recorder(() => {
      throw failure;
    });
    await expect(call({ run })).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });
});

describe('lsFiles options', () => {
  it.each<[string, Parameters<typeof lsFiles>[0], string[]]>([
    ['no options', undefined, []],
    ['empty options', {}, []],
    ['cached', { cached: true }, ['--cached']],
    ['others', { others: true }, ['--others']],
    ['excludeStandard', { excludeStandard: true }, ['--exclude-standard']],
    ['all three', { cached: true, others: true, excludeStandard: true }, ['--cached', '--others', '--exclude-standard']],
    ['all three false', { cached: false, others: false, excludeStandard: false }, []],
  ])('maps %s to ls-files -z flags', async (_label, opts, flags) => {
    const { run, calls } = recorder();
    await lsFiles(opts, { run });
    expect(calls).toEqual([{ file: 'git', args: ['ls-files', '-z', ...flags], cwd: REPO_ROOT }]);
  });
});

describe.each<[string, (rev: string, deps: GitDeps, dir: string) => Promise<unknown>]>([
  ['lsTree', (rev, deps) => lsTree(rev, deps)],
  ['diffNames', (rev, deps) => diffNames(rev, 'M', deps)],
  ['commitSubject', (rev, deps) => commitSubject(rev, deps)],
  ['catFileExists', (rev, deps) => catFileExists(rev, deps)],
  ['gitArchiveExtract', (rev, deps, dir) => gitArchiveExtract(rev, dir, deps)],
])('%s revision', (_name, call) => {
  it.each(['', '-', '-n1', '--output=archive.tar'])('rejects %j before running anything', async (rev) => {
    const { run, calls } = recorder();
    const dir = path.join(root, 'never-created');
    await expect(call(rev, { run }, dir)).rejects.toThrowError(new Error(`invalid git revision ${JSON.stringify(rev)}`));
    expect(calls).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it.each(['HEAD', 'release-7.6', SHA])('passes %j to git', async (rev) => {
    const { run, calls } = recorder();
    await call(rev, { run }, path.join(await caseDir(), 'out'));
    expect([rev, `${rev}^{commit}`]).toContain(calls[0]?.args.at(-1));
  });
});

describe('diffNames filter', () => {
  it.each(['M', 'AM', 'ACDMRTUXB', 'acdmrtuxb', 'd', '*', 'M*'])('passes %j as --diff-filter', async (filter) => {
    const { run, calls } = recorder();
    await diffNames(SHA, filter, { run });
    expect(calls[0]?.args).toEqual(['diff', '--name-only', '-z', `--diff-filter=${filter}`, SHA]);
  });

  it.each(['', 'Z', 'M D', 'M,D', 'M;rm', '--cached', 'M\n', 'Ä'])('rejects %j before running git', async (filter) => {
    const { run, calls } = recorder();
    await expect(diffNames(SHA, filter, { run })).rejects.toThrowError(
      new Error(`invalid git diff filter ${JSON.stringify(filter)}`),
    );
    expect(calls).toEqual([]);
  });
});

describe('commitSubject', () => {
  it.each<[string, string, string]>([
    ['a trailing newline', `${PIN_SUBJECT}\n`, PIN_SUBJECT],
    ['surrounding whitespace', '  subject text \r\n', 'subject text'],
    ['empty output', '', ''],
  ])('trims %s', async (_label, stdout, expected) => {
    const { run } = recorder(() => stdout);
    await expect(commitSubject(SHA, { run })).resolves.toBe(expected);
  });
});

describe('catFileExists', () => {
  it('resolves true when git exits 0', async () => {
    const { run } = recorder();
    await expect(catFileExists(SHA, { run })).resolves.toBe(true);
  });

  it.each([1, 128])('resolves false when git exits with status %i', async (code) => {
    const { run } = recorder(() => {
      throw Object.assign(new Error(`git exited ${code}`), { code });
    });
    await expect(catFileExists(SHA, { run })).resolves.toBe(false);
  });

  it.each<[string, unknown]>([
    ['a spawn failure with code ENOENT', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })],
    ['a numeric-looking string code', Object.assign(new Error('git failed'), { code: '128' })],
    ['an error without a code', new Error('runner failed')],
    ['a thrown null', null],
  ])('rethrows %s', async (_label, failure) => {
    const { run } = recorder(() => {
      throw failure;
    });
    await expect(catFileExists(SHA, { run })).rejects.toBe(failure);
  });
});

describe('this checkout, through defaultRunner and REPO_ROOT', () => {
  const extracted: string[] = [];

  afterEach(async () => {
    for (const dir of extracted.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it.each<[string, boolean]>([
    ['HEAD', true],
    [MISSING_SHA, false],
  ])('catFileExists(%s) is %s', async (rev, expected) => {
    await expect(catFileExists(rev)).resolves.toBe(expected);
  });

  it('catFileExists rethrows ENOENT when git cannot be spawned', async () => {
    const run: ProcessRunner = (_file, args, opts) => defaultRunner('opt2-no-such-git', args, opts);
    await expect(catFileExists(SHA, { run })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gitArchiveExtract extracts HEAD into a new directory under os.tmpdir()', async () => {
    const target = await gitArchiveExtract('HEAD');
    extracted.push(target);
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(existsSync(path.join(target, 'core', 'tests', 'runner.cfm'))).toBe(true);
    expect(existsSync(`${target}.tar`)).toBe(false);
  });
});

describe.runIf(pinPresent)('this checkout at the pin (requires full history)', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'opt2-git-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('catFileExists finds the pin commit', async () => {
    await expect(catFileExists(SHA)).resolves.toBe(true);
  });

  it('commitSubject reads the pin subject', async () => {
    await expect(commitSubject(SHA)).resolves.toBe(PIN_SUBJECT);
  });

  it('lsTree lists the pinned legacy tree without the new harness folder', async () => {
    const names = await lsTree(SHA);
    expect(names).toHaveLength(3567);
    expect(names).toEqual(
      expect.arrayContaining(['Application.cfc', 'core/tests/runner.cfm', 'core/mura/content/contentServer.cfc']),
    );
    expect(names.filter((name) => name.startsWith('harness/'))).toEqual([]);
  });

  it('gitArchiveExtract extracts the pin tree without the new harness and opt2 folders', async () => {
    await expect(gitArchiveExtract(SHA, tmp)).resolves.toBe(tmp);
    expect(existsSync(path.join(tmp, 'core', 'tests', 'runner.cfm'))).toBe(true);
    expect(existsSync(path.join(tmp, 'harness'))).toBe(false);
    expect(existsSync(path.join(tmp, 'opt2'))).toBe(false);
    expect(await readdir(tmp)).toContain('core');
  });
});

describe('a scratch repository, through defaultRunner', () => {
  it.each<[string, boolean, () => string]>([
    ['the commit', true, () => head],
    ['its tree, which is not a commit', false, () => tree],
    ['an unknown object', false, () => MISSING_SHA],
  ])('catFileExists for %s is %s', async (_label, expected, rev) => {
    await expect(catFileExists(rev(), { cwd: repo })).resolves.toBe(expected);
  });

  it('commitSubject reads the commit subject', async () => {
    await expect(commitSubject(head, { cwd: repo })).resolves.toBe('Fixture commit subject');
  });

  it('lsTree lists every committed path verbatim', async () => {
    expect(sorted(await lsTree(head, { cwd: repo }))).toEqual(sorted(COMMITTED_NAMES));
  });

  it.each<[string, Parameters<typeof lsFiles>[0], string[]]>([
    ['the index by default', {}, INDEX_NAMES],
    ['the index with cached', { cached: true }, INDEX_NAMES],
    ['untracked and ignored files with others', { others: true }, ['ignored.log', 'untracked.txt']],
    ['untracked files with others and excludeStandard', { others: true, excludeStandard: true }, ['untracked.txt']],
    ['the index and untracked files with all three', { cached: true, others: true, excludeStandard: true }, [...INDEX_NAMES, 'untracked.txt']],
  ])('lsFiles lists %s', async (_label, opts, expected) => {
    expect(sorted(await lsFiles(opts, { cwd: repo }))).toEqual(sorted(expected));
  });

  it.each<[string, string[]]>([
    ['M', ['modified.txt']],
    ['D', ['deleted.txt']],
    ['A', ['staged.txt']],
    ['MD', ['deleted.txt', 'modified.txt']],
    ['d', ['modified.txt', 'staged.txt']],
  ])('diffNames with filter %s lists %j', async (filter, expected) => {
    expect(sorted(await diffNames(head, filter, { cwd: repo }))).toEqual(expected);
  });
});

describe('gitArchiveExtract with a fake runner', () => {
  it.each([
    { mode: 'a new opt2-archive-* directory under tmpRoot', explicit: false, precreate: false, cwd: FAKE_CWD },
    { mode: 'an absent explicit directory', explicit: true, precreate: false, cwd: undefined },
    { mode: 'an existing empty explicit directory', explicit: true, precreate: true, cwd: undefined },
  ])('checks its paths, archives to <target>.tar, extracts into $mode and removes the tar', async ({ explicit, precreate, cwd }) => {
    const tmpRoot = await caseDir();
    const dir = explicit ? path.join(tmpRoot, 'out', 'nested') : undefined;
    if (dir !== undefined && precreate) await mkdir(dir, { recursive: true });
    const { run, calls } = recorder(async (call) => {
      await fakeArchiveStep(call);
      return '';
    });

    const target = await gitArchiveExtract(SHA, dir, { run, cwd, tmpRoot });
    const tar = `${target}.tar`;

    if (dir === undefined) {
      expect(path.dirname(target)).toBe(tmpRoot);
      expect(path.basename(target)).toMatch(/^opt2-archive-/);
    } else {
      expect(target).toBe(dir);
    }
    expect(guard.mock.calls).toEqual([
      dir === undefined ? [tmpRoot, 'archive tmpRoot'] : [dir, 'archive target'],
      [tar, 'archive tar'],
    ]);
    expect(calls).toEqual([
      { file: 'git', args: ['archive', '--format=tar', `--output=${tar}`, SHA], cwd: cwd ?? REPO_ROOT },
      { file: 'tar', args: ['-xf', tar, '-C', target], cwd: target },
    ]);
    expect(existsSync(tar)).toBe(false);
    expect(await readdir(target)).toEqual(['extracted.txt']);
  });

  it('refuses a non-empty explicit target without running anything', async () => {
    const dir = await caseDir();
    await writeFile(path.join(dir, 'keep.txt'), 'kept');
    const { run, calls } = recorder();
    await expect(gitArchiveExtract(SHA, dir, { run })).rejects.toThrowError(new Error(`archive target ${dir} must be empty`));
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual(['keep.txt']);
  });

  it.each([
    { label: 'an explicit target inside the checkout', dir: path.join(REPO_ROOT, 'harness', 'opt2-archive-never-created'), tmpRoot: undefined, check: 'archive target' },
    {
      label: 'a relative explicit target resolving inside the checkout',
      dir: path.relative(process.cwd(), path.join(REPO_ROOT, 'opt2-archive-never-created')),
      tmpRoot: undefined,
      check: 'archive target',
    },
    { label: 'a tmpRoot inside the checkout', dir: undefined, tmpRoot: path.join(REPO_ROOT, 'harness', 'opt2-tmproot-never-created'), check: 'archive tmpRoot' },
  ])('rejects $label before creating anything', async ({ dir, tmpRoot, check }) => {
    const { run, calls } = recorder();
    const checked = path.resolve(dir ?? tmpRoot ?? '');
    await expect(gitArchiveExtract(SHA, dir, { run, tmpRoot })).rejects.toThrowError(
      new Error(`${check} must be outside the repository checkout ${REPO_ROOT}, got ${checked}`),
    );
    expect(calls).toEqual([]);
    expect(existsSync(checked)).toBe(false);
  });

  it('rejects before creating the target when the tar path check fails', async () => {
    const actual = await vi.importActual<typeof import('../../src/lib/paths.js')>('../../src/lib/paths.js');
    const refusal = new Error('archive tar refused');
    guard.mockImplementation((p, label) => {
      if (label === 'archive tar') throw refusal;
      return actual.assertOutsideRepo(p, label);
    });
    const dir = path.join(await caseDir(), 'out');
    const { run, calls } = recorder();
    await expect(gitArchiveExtract(SHA, dir, { run })).rejects.toBe(refusal);
    expect(calls).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    { step: 'git', mode: 'a new directory, removing it', explicit: false, left: {} },
    { step: 'tar', mode: 'a new directory, removing it', explicit: false, left: {} },
    { step: 'git', mode: 'an explicit directory, keeping it', explicit: true, left: { out: [] } },
    { step: 'tar', mode: 'an explicit directory, keeping it', explicit: true, left: { out: ['extracted.txt'] } },
  ])('removes the tar when $step fails extracting into $mode', async ({ step, explicit, left }) => {
    const tmpRoot = await caseDir();
    const dir = explicit ? path.join(tmpRoot, 'out') : undefined;
    const failure = Object.assign(new Error(`${step} failed`), { code: 2 });
    const { run } = recorder(async (call) => {
      await fakeArchiveStep(call);
      if (call.file === step) throw failure;
      return '';
    });

    await expect(gitArchiveExtract(SHA, dir, { run, tmpRoot })).rejects.toBe(failure);

    const remaining: Record<string, string[]> = {};
    for (const name of await readdir(tmpRoot)) remaining[name] = await readdir(path.join(tmpRoot, name));
    expect(remaining).toEqual(left);
  });
});

describe('gitArchiveExtract on a scratch repository, through defaultRunner', () => {
  it('extracts the committed tree into a new directory under tmpRoot and leaves no tar', async () => {
    const tmpRoot = await caseDir();
    const target = await gitArchiveExtract(head, undefined, { cwd: repo, tmpRoot });
    expect(await readdir(tmpRoot)).toEqual([path.basename(target)]);
    expect(await contentsUnder(target)).toEqual(COMMITTED);
  });

  it('creates an absent explicit directory and returns its resolved path', async () => {
    const parent = await caseDir();
    const target = await gitArchiveExtract(head, path.join(parent, 'a', '..', 'out'), { cwd: repo });
    expect(target).toBe(path.join(parent, 'out'));
    expect(await readdir(parent)).toEqual(['out']);
    expect(await contentsUnder(target)).toEqual(COMMITTED);
  });

  it('defaults tmpRoot to os.tmpdir()', async () => {
    const target = await gitArchiveExtract(head, undefined, { cwd: repo });
    try {
      expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(target)).toMatch(/^opt2-archive-/);
      expect(existsSync(`${target}.tar`)).toBe(false);
      expect(await contentsUnder(target)).toEqual(COMMITTED);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('removes its own directory and the tar when git cannot archive the revision', async () => {
    const tmpRoot = await caseDir();
    await expect(gitArchiveExtract(MISSING_SHA, undefined, { cwd: repo, tmpRoot })).rejects.toMatchObject({ code: 128 });
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});
