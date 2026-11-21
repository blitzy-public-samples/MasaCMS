// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `scripts/export-transitions.ts` write mode, run from a temporary copy of its repository layout so no tracked file is written. */
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const TSX = path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
const SCRIPT = 'scripts/export-transitions.ts';
const EXPORT_REL = 'opt2/reports/state-machines/finance.json';
const TABLE_REL = 'services/finance/test/generated/transition-table.json';
const COMMITTED_EXPORT = readFileSync(path.join(REPO_ROOT, EXPORT_REL), 'utf8');
const COMMITTED_TABLE = readFileSync(path.join(REPO_ROOT, TABLE_REL), 'utf8');
const EARLIER_STAMP = '2000-01-01T00:00:00.000Z';

const execFileAsync = promisify(execFile);

/** The committed export restamped as a generated one at `EARLIER_STAMP`, rows optionally replaced. */
function generatedExport(rows?: (committed: unknown[]) => unknown[]): string {
  const doc = JSON.parse(COMMITTED_EXPORT) as { generatedAt: string | null; provenance: string; rows: unknown[] };
  doc.generatedAt = EARLIER_STAMP;
  doc.provenance = 'generated';
  if (rows !== undefined) doc.rows = rows(doc.rows);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The export document without its run-metadata keys. */
function withoutStamp(text: string): unknown {
  const entries = Object.entries(JSON.parse(text) as Record<string, unknown>);
  return Object.fromEntries(entries.filter(([key]) => key !== 'generatedAt' && key !== 'provenance'));
}

let root: string;

/** Runs the copied script with `args` and returns its stdout. */
async function run(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TSX, [SCRIPT, ...args], { cwd: path.join(root, 'services/finance'), encoding: 'utf8' });
  return stdout;
}

/** The file at `rel` under the temporary root. */
function read(rel: string): string {
  return readFileSync(path.join(root, rel), 'utf8');
}

/** Replaces the export under the temporary root, or removes it for null. */
function seedExport(text: string | null): void {
  const target = path.join(root, EXPORT_REL);
  if (text === null) rmSync(target);
  else writeFileSync(target, text, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opt2-finance-export-'));
  const pkg = path.join(root, 'services/finance');
  mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'opt2/reports/state-machines'), { recursive: true });
  copyFileSync(path.join(PACKAGE_ROOT, SCRIPT), path.join(pkg, SCRIPT));
  copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(pkg, 'package.json'));
  symlinkSync(path.join(PACKAGE_ROOT, 'src'), path.join(pkg, 'src'), 'dir');
  symlinkSync(path.join(PACKAGE_ROOT, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
  copyFileSync(path.join(REPO_ROOT, 'opt2/source-pin.json'), path.join(root, 'opt2/source-pin.json'));
  seedExport(COMMITTED_EXPORT);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('export-transitions write mode', () => {
  it('stamps the planning export once, then leaves both files byte for byte on a re-run', async () => {
    expect(await run()).toBe(`${TABLE_REL}: 50 rows\n${EXPORT_REL}: 50 rows\n`);
    const first = read(EXPORT_REL);
    expect(JSON.parse(first)).toMatchObject({ provenance: 'generated', generatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(withoutStamp(first)).toEqual(withoutStamp(COMMITTED_EXPORT));

    expect(await run()).toBe(`${TABLE_REL}: 50 rows\nunchanged: ${EXPORT_REL}\n`);
    expect(read(EXPORT_REL)).toBe(first);
    expect(read(TABLE_REL)).toBe(COMMITTED_TABLE);
    expect(await run('--check')).toBe('transition tables up to date\n');
  });

  it('keeps an earlier generated stamp when the rows are current', async () => {
    const current = generatedExport();
    seedExport(current);
    expect(await run()).toBe(`${TABLE_REL}: 50 rows\nunchanged: ${EXPORT_REL}\n`);
    expect(read(EXPORT_REL)).toBe(current);
  });

  it.each([
    ['a generated export whose rows drifted', generatedExport((rows) => rows.slice(1))],
    ['a missing export', null],
    ['an export that is not JSON', '<<<<<<< ours\n'],
  ])('rewrites %s with a fresh generated stamp', async (_case, seeded) => {
    seedExport(seeded);
    expect(await run()).toBe(`${TABLE_REL}: 50 rows\n${EXPORT_REL}: 50 rows\n`);
    const written = read(EXPORT_REL);
    const { generatedAt, provenance } = JSON.parse(written) as { generatedAt: string; provenance: string };
    expect(provenance).toBe('generated');
    expect(generatedAt).not.toBe(EARLIER_STAMP);
    expect(Number.isNaN(Date.parse(generatedAt))).toBe(false);
    expect(withoutStamp(written)).toEqual(withoutStamp(COMMITTED_EXPORT));
  });
});
