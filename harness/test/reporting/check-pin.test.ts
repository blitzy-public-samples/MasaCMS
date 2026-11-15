// Sample-deliverable cases only: every other check-pin.ts case lives in check-pin-gate.test.ts and is not repeated here.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessRunner } from '../../src/lib/git.js';
import { isInsideRepo } from '../../src/lib/paths.js';
import { PIN_PATH, pinnedSha } from '../../src/lib/pin.js';
import { checkDeliverables, extractSha, isDeliverable } from '../../src/reporting/check-pin.js';
import type { PinFinding, ShaForm } from '../../src/reporting/check-pin.js';

const SHA = pinnedSha();
// Letters keep the value a YAML string: an unquoted all-digit SHA such as '0'.repeat(40) parses as a number.
const OTHER_SHA = 'f'.repeat(40);
const PIN_REL = 'opt2/source-pin.json';

interface Sample {
  fixture: string;
  relPath: string;
  form: ShaForm;
}

/** The committed sample deliverables, each at the service path it stands for. */
const SAMPLES: readonly Sample[] = [
  { fixture: 'readme-service.md.txt', relPath: 'services/identity/README.md', form: 'markdown' },
  { fixture: 'traceability-identity.md.txt', relPath: 'services/identity/TRACEABILITY.md', form: 'markdown' },
  { fixture: 'openapi-sample.yaml', relPath: 'services/identity/contracts/openapi.yaml', form: 'openapi' },
  {
    fixture: 'event-sample.json',
    relPath: 'services/identity/contracts/events/identity.group.changed.v1.json',
    form: 'contract-json',
  },
];

/** Text of `sample`'s fixture with the pinned SHA replaced by `sha`. */
async function sampleContent(sample: Sample, sha: string): Promise<string> {
  const file = fileURLToPath(new URL(`../fixtures/reporting/${sample.fixture}`, import.meta.url));
  return (await fs.readFile(file, 'utf8')).replaceAll(SHA, sha);
}

interface GitCall {
  cmd: string;
  args: string[];
  cwd: string;
}

/** Runner answering each `cmd args…` line from `replies`; any other call rejects, so unexpected git use fails the test. */
function fakeGit(replies: Readonly<Record<string, string>>): { run: ProcessRunner; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd });
    const line = [cmd, ...args].join(' ');
    const stdout = replies[line];
    if (stdout === undefined) throw new Error(`unconfigured call: ${line}`);
    return { stdout, stderr: '' };
  };
  return { run, calls };
}

/** `paths` as git prints them with `-z`. */
function nul(paths: readonly string[]): string {
  return paths.map((relPath) => `${relPath}\0`).join('');
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-check-pin-'));
  expect(isInsideRepo(root)).toBe(false);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe('the committed sample deliverables', () => {
  it.each(SAMPLES)('$relPath is a deliverable carrying exactly the SHA it holds, in the $form form', async (sample) => {
    expect(isDeliverable(sample.relPath)).toBe(true);
    for (const sha of [SHA, OTHER_SHA]) {
      expect(extractSha(sample.relPath, await sampleContent(sample, sha), SHA)).toEqual({
        form: sample.form,
        found: [sha],
      });
    }
  });
});

describe('checkDeliverables over a service built from the samples', () => {
  const PIN_TRACKED = ['README.md', 'core/index.cfm'];
  const NOT_SELECTED = 'services/identity/src/app.ts';

  it.each<{ label: string; stale: Sample | undefined }>([
    { label: 'nothing when every sample carries the pinned SHA', stale: undefined },
    ...SAMPLES.map((sample) => ({ label: `only ${sample.relPath} when it carries another SHA`, stale: sample })),
  ])('reports $label', async ({ stale }) => {
    await write(PIN_REL, await fs.readFile(PIN_PATH, 'utf8'));
    // Neither carries the SHA, so either would be a finding if it were selected.
    await write('README.md', '# Masa CMS\n');
    await write(NOT_SELECTED, 'export {};\n');
    for (const sample of SAMPLES) {
      await write(sample.relPath, await sampleContent(sample, sample === stale ? OTHER_SHA : SHA));
    }

    const listed = [...PIN_TRACKED, PIN_REL, NOT_SELECTED, ...SAMPLES.map(({ relPath }) => relPath)];
    const { run, calls } = fakeGit({
      'git ls-files -z --cached --others --exclude-standard': nul(listed),
      [`git ls-tree -r --name-only -z ${SHA}`]: nul(PIN_TRACKED),
      'git ls-files -z --cached': nul(PIN_TRACKED),
    });
    const findings: PinFinding[] =
      stale === undefined ? [] : [{ kind: 'mismatch', path: stale.relPath, form: stale.form, found: [OTHER_SHA] }];

    await expect(checkDeliverables({ root, git: { run } })).resolves.toEqual({
      mode: 'deliverables',
      sha: SHA,
      checked: SAMPLES.length + 1,
      ok: findings.length === 0,
      findings,
    });
    expect(calls.map(({ cwd }) => cwd)).toEqual([root, root, root]);
  });
});
