// Exceptions entries whose scenario was retired keep their routing fields without scenario or evidence pointers.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendExceptionEntry } from '../../src/golden/capture.js';
import { exceptionEntries, loadExceptionsList, renderExceptionsMarkdown, type ParityResult } from '../../src/golden/compare.js';
import { haltEvidence, type ExceptionEntry } from '../../src/golden/errors.js';
import { pinnedSha } from '../../src/lib/pin.js';

const SHA = pinnedSha();
const RETIRED: ExceptionEntry = {
  id: 'EX-RETIRED',
  routeKey: 'admin:carch.update{upload=image}',
  appliesTo: ['render:file'],
  difference: 'renditions',
  decision: 'preserve',
  reason: 'halted whole',
  status: 'halted',
  sourceSha: SHA,
};
const KEPT: ExceptionEntry = {
  ...RETIRED,
  id: 'EX-KEPT',
  scenario: 'GS-ID-09',
  routeKey: 'admin:cusers.listusers',
  appliesTo: [],
  status: 'accepted',
  evidence: { golden: 'harness/golden/sets/GS-ID-09.json', replay: 'opt2/reports/parity.json#GS-ID-09' },
};

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'compare-retired-'));
  file = path.join(dir, 'exceptions-list.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeList(entries: unknown[]): Promise<void> {
  await writeFile(file, `${JSON.stringify({ sourceSha: SHA, entries })}\n`, 'utf8');
}

describe('exceptions readers', () => {
  it('loads an entry without scenario and evidence beside one that has both', async () => {
    await writeList([RETIRED, KEPT]);
    expect(exceptionEntries(await loadExceptionsList(file))).toStrictEqual([RETIRED, KEPT]);
  });

  it.each(['id', 'routeKey', 'difference', 'decision', 'reason', 'status', 'sourceSha'] as const)(
    'still rejects an entry without %s',
    async (field) => {
      const { [field]: _dropped, ...rest } = RETIRED;
      await writeList([rest]);
      await expect(loadExceptionsList(file)).rejects.toThrow(/does not match its schema/);
    },
  );

  it('upserts a capture entry into a list holding a retired entry, which stays unchanged', async () => {
    await writeList([RETIRED]);
    const gap: ExceptionEntry = {
      ...RETIRED,
      id: 'EX-GAP-GS-ID-09-STEP',
      scenario: 'GS-ID-09',
      evidence: haltEvidence('GS-ID-09'),
    };
    await expect(appendExceptionEntry(gap, { path: file })).resolves.toStrictEqual(gap);
    const written = JSON.parse(await readFile(file, 'utf8')) as { entries: ExceptionEntry[] };
    expect(written.entries).toStrictEqual([RETIRED, gap]);
  });
});

describe('renderExceptionsMarkdown with retired pointers', () => {
  const run = { results: new Map<string, ParityResult>([['GS-ID-09', 'withheld']]), captured: new Set(['GS-ID-09']) };

  it.each([
    ['before a run', undefined, 'pending-run'],
    ['after a run', run, 'captured'],
  ])('shows a dash for the absent scenario and evidence %s', (_title, state, golden) => {
    const lines = renderExceptionsMarkdown({ entries: [RETIRED, KEPT] }, state);
    const rows = lines.filter((line) => line.startsWith('| EX-'));
    expect(rows[0]).toBe(
      '| EX-RETIRED | — | `admin:carch.update{upload=image}`, `render:file` | renditions | `preserve` | `halted` | — |',
    );
    expect(rows[1]).toContain(`| EX-KEPT | GS-ID-09 | \`admin:cusers.listusers\` |`);
    expect(rows[1]).toContain(`golden \`harness/golden/sets/GS-ID-09.json\` (${golden})`);
  });
});
