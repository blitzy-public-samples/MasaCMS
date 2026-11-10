import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_ROOT,
  REPO_ROOT,
  assertOutsideRepo,
  isInsideRepo,
  opt2Path,
  pristineDir,
  reportsDir,
  repoPath,
  secretsDir,
  stateDir,
  type EnvLike,
} from '../../src/lib/paths.js';

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Never created: the resolvers only compute paths.
const OUTSIDE = path.join(os.tmpdir(), 'opt2-paths-test');

/** Return value or error message of `run`, so two calls can be compared whichever way they end. */
function outcome(run: () => string): { value?: string; error?: string } {
  try {
    return { value: run() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function insideMessage(label: string, resolved: string): string {
  return `${label} must be outside the repository checkout ${REPO_ROOT}, got ${resolved}`;
}

describe('REPO_ROOT and HARNESS_ROOT', () => {
  it('REPO_ROOT is the absolute checkout root holding harness/ and opt2/, without a trailing separator', () => {
    expect(REPO_ROOT).toBe(CHECKOUT);
    expect(path.isAbsolute(REPO_ROOT)).toBe(true);
    expect(REPO_ROOT.endsWith(path.sep)).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'harness', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'opt2', 'source-pin.json'))).toBe(true);
  });

  it('HARNESS_ROOT is the harness package folder', () => {
    expect(HARNESS_ROOT).toBe(path.join(CHECKOUT, 'harness'));
    const manifest = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, 'package.json'), 'utf8')) as { name: string };
    expect(manifest.name).toBe('@opt2/harness');
  });
});

describe('repoPath', () => {
  it.each<[string, string[], string]>([
    ['no segments', [], CHECKOUT],
    ['one segment', ['harness'], path.join(CHECKOUT, 'harness')],
    ['several segments', ['opt2', 'reports', 'parity.json'], path.join(CHECKOUT, 'opt2', 'reports', 'parity.json')],
    ['a segment with separators', ['opt2/inventory'], path.join(CHECKOUT, 'opt2', 'inventory')],
    ['dot segments', ['harness', '..', 'opt2', '.'], path.join(CHECKOUT, 'opt2')],
    ['a segment escaping the checkout', ['..', 'sibling'], path.join(path.dirname(CHECKOUT), 'sibling')],
    ['an absolute segment', [OUTSIDE, 'x'], path.join(OUTSIDE, 'x')],
  ])('resolves %s against the repository root', (_label, segments, expected) => {
    expect(repoPath(...segments)).toBe(expected);
  });
});

describe('opt2Path', () => {
  it.each<[string[], string]>([
    [[], path.join(CHECKOUT, 'opt2')],
    [['reports'], path.join(CHECKOUT, 'opt2', 'reports')],
    [['inventory', 'cloc.json'], path.join(CHECKOUT, 'opt2', 'inventory', 'cloc.json')],
  ])('resolves %j under opt2/', (segments, expected) => {
    expect(opt2Path(...segments)).toBe(expected);
  });
});

describe('isInsideRepo', () => {
  it.each([
    { label: 'the root itself', p: CHECKOUT, inside: true },
    { label: 'the root with a trailing separator', p: `${CHECKOUT}${path.sep}`, inside: true },
    { label: 'a descendant', p: path.join(CHECKOUT, 'harness', 'src', 'lib'), inside: true },
    { label: 'a non-normalised path that stays inside', p: `${CHECKOUT}/harness/../opt2`, inside: true },
    { label: 'the root relative to the working directory', p: path.relative(process.cwd(), CHECKOUT) || '.', inside: true },
    { label: 'a descendant relative to the working directory', p: path.relative(process.cwd(), path.join(CHECKOUT, 'opt2')), inside: true },
    { label: 'the parent of the root', p: path.dirname(CHECKOUT), inside: false },
    { label: 'a sibling sharing the root as a name prefix', p: `${CHECKOUT}-sibling`, inside: false },
    { label: 'a sibling extending the root name', p: `${CHECKOUT}x`, inside: false },
    { label: 'a non-normalised path that escapes', p: `${CHECKOUT}/harness/../../outside`, inside: false },
    { label: 'the temp directory', p: os.tmpdir(), inside: false },
    { label: 'an outside path relative to the working directory', p: path.relative(process.cwd(), OUTSIDE), inside: false },
  ])('is $inside for $label', ({ p, inside }) => {
    expect(isInsideRepo(p)).toBe(inside);
  });
});

describe('assertOutsideRepo', () => {
  it.each([
    ['a non-normalised absolute path', `${OUTSIDE}/a/../b`, path.join(OUTSIDE, 'b')],
    ['a relative path', path.relative(process.cwd(), OUTSIDE), OUTSIDE],
  ])('returns the resolved path of %s outside the checkout', (_label, p, expected) => {
    expect(assertOutsideRepo(p, 'LABEL')).toBe(expected);
  });

  it.each([
    ['the root', CHECKOUT, CHECKOUT],
    ['a descendant', path.join(CHECKOUT, 'opt2', 'state'), path.join(CHECKOUT, 'opt2', 'state')],
    ['a relative descendant', path.relative(process.cwd(), path.join(CHECKOUT, 'tmp')), path.join(CHECKOUT, 'tmp')],
  ])('throws naming the label, the root and the resolved path for %s', (_label, p, resolved) => {
    expect(() => assertOutsideRepo(p, 'SOME_DIR')).toThrowError(new Error(insideMessage('SOME_DIR', resolved)));
  });
});

describe.each([
  { name: 'stateDir', resolve: stateDir, variable: 'OPT2_STATE_DIR', other: 'OPT2_PRISTINE_DIR', leaf: 'state' },
  { name: 'pristineDir', resolve: pristineDir, variable: 'OPT2_PRISTINE_DIR', other: 'OPT2_STATE_DIR', leaf: 'pristine' },
])('$name', ({ resolve, variable, other, leaf }) => {
  it.each<[string, EnvLike, string]>([
    [`${variable} when set`, { HOME: OUTSIDE, [variable]: `${OUTSIDE}/x/../override` }, path.join(OUTSIDE, 'override')],
    [
      `a relative ${variable} against the working directory`,
      { [variable]: path.relative(process.cwd(), path.join(OUTSIDE, 'rel')) },
      path.join(OUTSIDE, 'rel'),
    ],
    [`<HOME>/.opt2/${leaf} when ${variable} is unset`, { HOME: OUTSIDE, [other]: path.join(OUTSIDE, 'other') }, path.join(OUTSIDE, '.opt2', leaf)],
    [`<HOME>/.opt2/${leaf} when ${variable} is empty`, { HOME: OUTSIDE, [variable]: '', [other]: path.join(OUTSIDE, 'other') }, path.join(OUTSIDE, '.opt2', leaf)],
    [`<os.homedir()>/.opt2/${leaf} when HOME is unset`, {}, path.join(os.homedir(), '.opt2', leaf)],
    [`<os.homedir()>/.opt2/${leaf} when HOME is empty`, { HOME: '' }, path.join(os.homedir(), '.opt2', leaf)],
  ])('resolves %s', (_label, env, expected) => {
    expect(resolve(env)).toBe(expected);
  });

  it.each<[string, EnvLike, string]>([
    [`${variable} inside the checkout`, { HOME: OUTSIDE, [variable]: path.join(CHECKOUT, 'harness', leaf) }, path.join(CHECKOUT, 'harness', leaf)],
    ['a HOME-derived default inside the checkout', { HOME: CHECKOUT }, path.join(CHECKOUT, '.opt2', leaf)],
  ])(`throws naming ${variable} for %s`, (_label, env, resolved) => {
    expect(() => resolve(env)).toThrowError(new Error(insideMessage(variable, resolved)));
  });
});

describe('secretsDir', () => {
  it.each<[string, EnvLike, string]>([
    ['OPT2_STATE_DIR', { OPT2_STATE_DIR: path.join(OUTSIDE, 'state') }, path.join(OUTSIDE, 'state', 'secrets')],
    ['the HOME-derived state directory', { HOME: OUTSIDE }, path.join(OUTSIDE, '.opt2', 'state', 'secrets')],
  ])('is the secrets folder under %s', (_label, env, expected) => {
    expect(secretsDir(env)).toBe(expected);
  });

  it('throws naming OPT2_STATE_DIR when the state directory lies inside the checkout', () => {
    const inside = path.join(CHECKOUT, 'state');
    expect(() => secretsDir({ OPT2_STATE_DIR: inside })).toThrowError(new Error(insideMessage('OPT2_STATE_DIR', inside)));
  });
});

describe('reportsDir', () => {
  // HOME and OPT2_STATE_DIR point inside the checkout to show reportsDir ignores them.
  const unrelated: EnvLike = { HOME: CHECKOUT, OPT2_STATE_DIR: path.join(CHECKOUT, 'state') };

  it.each<[string, string | undefined, string]>([
    ['opt2/reports inside the checkout when OPT2_REPORTS_DIR is unset', undefined, path.join(CHECKOUT, 'opt2', 'reports')],
    ['opt2/reports inside the checkout when OPT2_REPORTS_DIR is empty', '', path.join(CHECKOUT, 'opt2', 'reports')],
    ['a relative OPT2_REPORTS_DIR resolved against the repository root', 'opt2/reports-alt', path.join(CHECKOUT, 'opt2', 'reports-alt')],
    ['an absolute OPT2_REPORTS_DIR unchanged', path.join(OUTSIDE, 'reports'), path.join(OUTSIDE, 'reports')],
  ])('is %s', (_label, value, expected) => {
    expect(reportsDir({ ...unrelated, OPT2_REPORTS_DIR: value })).toBe(expected);
  });
});

describe('default environment', () => {
  it.each([
    ['stateDir', stateDir],
    ['pristineDir', pristineDir],
    ['secretsDir', secretsDir],
    ['reportsDir', reportsDir],
  ])('%s reads process.env when no environment is passed', (_name, resolve) => {
    expect(outcome(() => resolve())).toEqual(outcome(() => resolve({ ...process.env })));
  });
});
