// Unit tests for the migration package's repository, package and state-directory path helpers.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONFIG_PATH,
  OPT2_SYNC_SQL_PATH,
  PACKAGE_ROOT,
  REPO_ROOT,
  cutoverVersionFile,
  migrationsDirFor,
  packagePath,
  repoPath,
  snapshotsDir,
  stateDirPath,
  upJsonPath,
} from '../../src/paths.js';

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const REPO_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const SIBLING = `${path.basename(REPO_DIR)}-sibling`;
const STATE_DIR = path.join(os.tmpdir(), 'opt2-paths-state');

const escapes = (rel: string): string => `Path "${rel}" escapes the repository root ${REPO_DIR}`;
const absolute = (rel: string): string => `Expected a relative path, got absolute "${rel}"`;

describe('package and repository roots', () => {
  it('are directory URLs of migration/ and the repository root', () => {
    expect(fileURLToPath(PACKAGE_ROOT)).toBe(PACKAGE_DIR);
    expect(fileURLToPath(REPO_ROOT)).toBe(REPO_DIR);
    expect(PACKAGE_ROOT.href.endsWith('/')).toBe(true);
    expect(REPO_ROOT.href.endsWith('/')).toBe(true);
    expect(existsSync(path.join(PACKAGE_DIR, 'vitest.config.ts'))).toBe(true);
    expect(existsSync(path.join(REPO_DIR, 'opt2', 'source-pin.json'))).toBe(true);
  });

  it('place the configuration and opt2_sync SQL files under migration/', () => {
    expect(CONFIG_PATH).toBe(path.join(PACKAGE_DIR, 'config', 'migration.config.json'));
    expect(OPT2_SYNC_SQL_PATH).toBe(path.join(PACKAGE_DIR, 'sql', '005_opt2_sync.sql'));
    expect(existsSync(OPT2_SYNC_SQL_PATH)).toBe(true);
  });
});

describe('packagePath', () => {
  it.each([
    ['config/migration.config.json', path.join(PACKAGE_DIR, 'config', 'migration.config.json')],
    ['../gateway/cutover', path.join(REPO_DIR, 'gateway', 'cutover')],
    ['..', path.resolve(REPO_DIR)],
    ['', path.resolve(PACKAGE_DIR)],
    ['odd?#%41.json', path.join(PACKAGE_DIR, 'odd?#%41.json')],
  ])('resolves %j relative to migration/', (rel, expected) => {
    expect(packagePath(rel)).toBe(expected);
  });

  it.each([
    ['/etc/passwd', absolute('/etc/passwd')],
    ['../..', escapes('../..')],
    ['../../etc/passwd', escapes('../../etc/passwd')],
    ['sql/../../../x', escapes('sql/../../../x')],
    [`../../${SIBLING}/x`, escapes(`../../${SIBLING}/x`)],
  ])('rejects %j', (rel, message) => {
    expect(() => packagePath(rel)).toThrow(new Error(message));
  });
});

describe('repoPath', () => {
  it.each([
    ['opt2/source-pin.json', path.join(REPO_DIR, 'opt2', 'source-pin.json')],
    ['migration/../gateway', path.join(REPO_DIR, 'gateway')],
    ['..x', path.join(REPO_DIR, '..x')],
    ['', path.resolve(REPO_DIR)],
  ])('resolves %j relative to the repository root', (rel, expected) => {
    expect(repoPath(rel)).toBe(expected);
  });

  it.each([
    ['/tmp/x', absolute('/tmp/x')],
    ['..', escapes('..')],
    ['../x', escapes('../x')],
    ['opt2/../../x', escapes('opt2/../../x')],
    [`../${SIBLING}/x`, escapes(`../${SIBLING}/x`)],
  ])('rejects %j', (rel, message) => {
    expect(() => repoPath(rel)).toThrow(new Error(message));
  });
});

describe('migrationsDirFor', () => {
  it.each(['services/people', 'gateway', 'migration'])('returns the db/migrations directory of %s', (pkg) => {
    expect(migrationsDirFor(pkg)).toBe(path.join(REPO_DIR, pkg, 'db', 'migrations'));
  });

  it.each([
    ['../outside', escapes('../outside/db/migrations')],
    ['/abs', absolute('/abs/db/migrations')],
  ])('rejects the package %j', (pkg, message) => {
    expect(() => migrationsDirFor(pkg)).toThrow(new Error(message));
  });
});

describe('cutoverVersionFile', () => {
  const cutoverDir = path.join(REPO_DIR, 'gateway', 'cutover');

  it.each(['v0001', 'v0002', 'v0003', 'v9999'])('returns versions/%s.json under the cut-over directory', (version) => {
    expect(cutoverVersionFile(cutoverDir, version)).toBe(path.join(cutoverDir, 'versions', `${version}.json`));
  });

  it('rejects a relative cut-over directory', () => {
    expect(() => cutoverVersionFile('gateway/cutover', 'v0002')).toThrow(
      new Error('Cut-over directory must be an absolute path, got "gateway/cutover"'),
    );
  });

  it.each(['', 'v2', 'v00002', 'V0002', 'v000a', 'v0002.json', 'v0002\n', '../v0002'])('rejects the version %j', (version) => {
    expect(() => cutoverVersionFile(cutoverDir, version)).toThrow(new Error(`Cut-over version "${version}" does not match vNNNN`));
  });
});

describe('state directory paths', () => {
  it.each([
    [[], STATE_DIR],
    [['otel', 'traces.jsonl'], path.join(STATE_DIR, 'otel', 'traces.jsonl')],
  ])('stateDirPath joins %j under the state directory', (segments, expected) => {
    expect(stateDirPath(STATE_DIR, ...segments)).toBe(expected);
  });

  it('places snapshots and up.json directly under the state directory', () => {
    expect(snapshotsDir(STATE_DIR)).toBe(path.join(STATE_DIR, 'snapshots'));
    expect(upJsonPath(STATE_DIR)).toBe(path.join(STATE_DIR, 'up.json'));
  });

  it.each([
    ['stateDirPath', (dir: string) => stateDirPath(dir, 'x')],
    ['snapshotsDir', snapshotsDir],
    ['upJsonPath', upJsonPath],
  ])('%s rejects a relative state directory', (_name, resolve) => {
    for (const dir of ['.opt2/state', '']) {
      expect(() => resolve(dir)).toThrow(new Error(`State directory must be an absolute path, got "${dir}"`));
    }
  });
});
