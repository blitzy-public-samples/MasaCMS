import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoPath } from '../../src/lib/paths.js';

const SCRIPT = repoPath('harness', 'repro', 'lib', 'cfconfig-tasks.mjs');
const WEBROOT = '/var/www';
const MONITOR = `${WEBROOT}/index.cfm/_api/sitemonitor/`;
const CAPTURED_AT = '2026-01-01T00:00:00.000Z';
// Test value assembled at run time, not a credential.
const TASK_PASSWORD = ['task', 'secret'].join('-');
const EXPORT = {
  scheduledTasks: {
    [`default:${MONITOR}`]: {
      task: MONITOR,
      group: 'default',
      url: 'http://localhost:8080/index.cfm/_api/sitemonitor/',
      httpPort: 8080,
      interval: '900',
      startDate: '01/01/2026',
      startTime: '00:15:00',
      requestTimeOut: 600,
      status: 'Running',
      password: TASK_PASSWORD,
    },
    'default:opt2-survey-1-launch': { task: 'opt2-survey-1-launch', url: 'http://localhost:8100/x', status: 'Paused' },
  },
  otherKey: 1,
};
const NATIVE = {
  capturedAt: CAPTURED_AT,
  originalPing: false,
  siteMonitorTask: MONITOR,
  tasks: [
    {
      task: MONITOR,
      group: 'default',
      url: 'http://localhost:8080/index.cfm/_api/sitemonitor/',
      port: '8080',
      interval: '900',
      startDate: '01/01/2026',
      startTime: '00:15:00',
      requestTimeOut: '600',
      operation: 'HTTPRequest',
      paused: false,
    },
    {
      task: 'opt2-survey-1-launch',
      group: 'default',
      url: 'http://localhost:8100/x',
      port: '',
      interval: '',
      startDate: '',
      startTime: '',
      requestTimeOut: '',
      operation: 'HTTPRequest',
      paused: true,
    },
  ],
};
// Preloaded with --import: kills the process right after its first published file, as a crash between publications would.
const KILL_AFTER_FIRST_LINK = `import fs from 'node:fs';
import process from 'node:process';
const link = fs.linkSync;
fs.linkSync = (...args) => {
  link(...args);
  process.kill(process.pid, 'SIGKILL');
};
`;

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

let root: string;
let pristine: string;
let nativeFile: string;
let copyFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-cfconfig-tasks-'));
  pristine = path.join(root, 'pristine');
  nativeFile = path.join(pristine, 'native-tasks.json');
  copyFile = path.join(pristine, 'native-tasks.cfconfig.json');
  await mkdir(pristine);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes `doc` as the export file `name` under the test root; returns its path. */
function writeExport(name: string, doc: unknown): string {
  const file = path.join(root, name);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

/** Runs `capture` of `exportFile` into the pristine directory, optionally preloading `hook`. */
function runCapture(exportFile: string, hook?: string): Promise<Run> {
  const preload = hook === undefined ? [] : ['--import', pathToFileURL(hook).href];
  const args = [
    ...['capture', '--export', exportFile, '--ping', 'false', '--webroot', WEBROOT],
    ...['--out-native', nativeFile, '--out-cfconfig', copyFile, '--captured-at', CAPTURED_AT],
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preload, SCRIPT, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

/** Runs a capture of `exportFile` killed right after its first publication, leaving the copy without native-tasks.json. */
async function interruptedCapture(exportFile: string): Promise<string> {
  const hook = path.join(root, 'kill-after-first-link.mjs');
  writeFileSync(hook, KILL_AFTER_FIRST_LINK);
  const run = await runCapture(exportFile, hook);
  expect(run.signal).toBe('SIGKILL');
  expect(existsSync(copyFile)).toBe(true);
  expect(existsSync(nativeFile)).toBe(false);
  return readFileSync(copyFile, 'utf8');
}

/** Content and mtime of each output that exists. */
function outputsOf(): Record<string, { text: string; mtimeMs: number }> {
  return Object.fromEntries(
    [nativeFile, copyFile]
      .filter((file) => existsSync(file))
      .map((file) => [file, { text: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs }]),
  );
}

/** The same JSON value with every object's keys in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)]));
}

describe('cfconfig-tasks.mjs capture', () => {
  it.each([
    { label: 'the same export', rerun: EXPORT },
    { label: 'the same tasks in another key order', rerun: reversedKeys(EXPORT) },
  ])('completes a capture interrupted after its copy on a rerun with $label, then refuses a third run', async ({ rerun }) => {
    const copy = await interruptedCapture(writeExport('export.json', EXPORT));

    const resumed = await runCapture(writeExport('rerun.json', rerun));

    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toContain('completing its capture');
    expect(readFileSync(copyFile, 'utf8')).toBe(copy);
    expect(JSON.parse(readFileSync(nativeFile, 'utf8'))).toEqual(NATIVE);
    expect(statSync(nativeFile).mode & 0o777).toBe(0o600);

    const before = outputsOf();
    const third = await runCapture(writeExport('third.json', EXPORT));

    expect(third.code).toBe(1);
    expect(third.stderr).toBe(`cfconfig-tasks: refusing to overwrite ${nativeFile}\n`);
    expect(outputsOf()).toEqual(before);
  });

  it('refuses to complete an interrupted capture from a changed export and changes nothing', async () => {
    await interruptedCapture(writeExport('export.json', EXPORT));
    const before = outputsOf();

    const run = await runCapture(writeExport('changed.json', { ...EXPORT, otherKey: 2 }));

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${copyFile} is left from an interrupted capture of a different export`);
    expect(run.stderr).toContain('remove it to capture again');
    expect(outputsOf()).toEqual(before);
  });

  it('lets exactly one of six concurrent captures complete', async () => {
    const exportFile = writeExport('export.json', EXPORT);

    const runs = await Promise.all(Array.from({ length: 6 }, () => runCapture(exportFile)));

    expect(runs.map((run) => run.code).sort()).toEqual([0, 1, 1, 1, 1, 1]);
    expect(JSON.parse(readFileSync(copyFile, 'utf8'))).toEqual(EXPORT);
    expect(JSON.parse(readFileSync(nativeFile, 'utf8'))).toEqual(NATIVE);
    expect(readdirSync(pristine).sort()).toEqual(['native-tasks.cfconfig.json', 'native-tasks.json']);
  });
});
