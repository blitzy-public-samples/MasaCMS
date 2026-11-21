// Reviewed admin view partials: the schema, the loader, and the committed file checked against the pinned tree.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { openSourceTree } from '../../src/inventory/closure.js';
import { VIEW_PARTIALS_REF, viewPartialChecker } from '../../src/inventory/controllers.js';
import { OverrideError, VIEW_PARTIALS_PATH, loadViewPartials, parseViewPartials } from '../../src/inventory/overrides.js';
import type { ViewPartial } from '../../src/inventory/overrides.js';
import { gitArchiveExtract } from '../../src/lib/git.js';
import { assertOutsideRepo, repoPath } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const SHA = pinnedSha();
const LABEL = 'in-memory.yaml';
const HTML = 'admin/core/views/cform/html.cfm';

/** The cform html partial in the committed file's shape, with `edits` applied. */
function record(edits: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vp:cform.html',
    view: HTML,
    includers: [
      { path: 'admin/core/views/cform/getdialog.cfm', lines: [76, 76] },
      { path: 'admin/core/views/cform/getfieldtemplate.cfm', lines: [76, 76] },
    ],
    reason: 'Writes rc.return, which only the including actions set.',
    ...edits,
  };
}

function document(...partials: Record<string, unknown>[]): string {
  return stringify({ sourceSha: SHA, partials });
}

/** The issues of the `OverrideError` that `run` throws or rejects with. */
async function issuesOf(run: () => unknown): Promise<readonly string[]> {
  const error: unknown = await (async () => run())().then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(OverrideError);
  return (error as OverrideError).issues;
}

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-view-partials-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseViewPartials', () => {
  it('returns each record as written', () => {
    expect(parseViewPartials(document(record()), LABEL)).toEqual({ sourceSha: SHA, partials: [record()] });
  });

  it.each<[string, Record<string, unknown>[], string[]]>([
    [
      'an id of another form',
      [record({ id: 'cform.html' })],
      ['partials.0.id: must be vp:<circuit>.<name>', 'partials.0.id: must equal vp:<circuit>.<name> of view'],
    ],
    ['an id naming another view', [record({ id: 'vp:cform.json' })], ['partials.0.id: must equal vp:<circuit>.<name> of view']],
    [
      'a view outside a circuit folder',
      [record({ view: 'admin/core/views/cform/inc/html.cfm' })],
      ['partials.0.view: must be admin/core/views/<circuit>/<name>.cfm', 'partials.0.id: must equal vp:<circuit>.<name> of view'],
    ],
    ['no includers', [record({ includers: [] })], ['partials.0.includers: Too small: expected array to have >=1 items']],
    [
      'an includer ending before it starts',
      [record({ includers: [{ path: 'admin/core/views/cform/getdialog.cfm', lines: [76, 75] }] })],
      ['partials.0.includers.0.lines: start line must not exceed end line'],
    ],
    ['an empty reason', [record({ reason: '' })], ['partials.0.reason: Too small: expected string to have >=1 characters']],
    ['an unknown key', [record({ reviewer: 'x' })], ['partials.0: Unrecognized key: "reviewer"']],
    ['a repeated record', [record(), record()], ['partials.1.id: duplicate id vp:cform.html', `partials.1.view: duplicate view ${HTML}`]],
    [
      'a view repeated in another case',
      [record(), record({ id: 'vp:cform.HTML', view: 'admin/core/views/cform/HTML.cfm' })],
      ['partials.1.id: duplicate id vp:cform.HTML', 'partials.1.view: duplicate view admin/core/views/cform/HTML.cfm'],
    ],
  ])('rejects %s with an OverrideError naming the source label', async (_label, partials, expected) => {
    expect(await issuesOf(() => parseViewPartials(document(...partials), LABEL))).toEqual(expected);
  });
});

describe('loadViewPartials(path)', () => {
  it('loads a document stamped with the pinned SHA', async () => {
    const file = path.join(dir, 'valid.yaml');
    await writeFile(file, document(record()), 'utf8');
    await expect(loadViewPartials(file)).resolves.toEqual({ sourceSha: SHA, partials: [record()] });
  });

  it.each<[string, string, RegExp]>([
    [
      'another SHA',
      stringify({ sourceSha: '0'.repeat(40), partials: [] }),
      /^sourceSha: 0{40} does not match the pinned source SHA [0-9a-f]{40}$/,
    ],
    ['malformed YAML', 'partials: [\n', /^is not valid YAML: /],
  ])('rejects a document with %s under the file path', async (name, text, issue) => {
    const file = path.join(dir, `${name.replace(/\W+/g, '-')}.yaml`);
    await writeFile(file, text, 'utf8');
    const error: unknown = await loadViewPartials(file).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OverrideError);
    expect((error as OverrideError).path).toBe(file);
    expect((error as OverrideError).issues).toEqual([expect.stringMatching(issue)]);
  });

  it('rejects a missing file with a cannot-be-read OverrideError', async () => {
    const file = path.join(dir, 'absent', 'view-partials.yaml');
    expect(await issuesOf(() => loadViewPartials(file))).toEqual([expect.stringMatching(/^cannot be read: ENOENT/)]);
  });
});

// Extracted at collection so it.each can enumerate the committed records against the pinned tree.
const committed = await loadViewPartials();
const root = await gitArchiveExtract(SHA);
afterAll(() => rm(root, { recursive: true, force: true }));
const check = viewPartialChecker(openSourceTree(root));

describe('committed view-partials.yaml', () => {
  it('is the reviewed file under harness/inventory that excluded views reference', () => {
    expect(VIEW_PARTIALS_PATH).toBe(repoPath(VIEW_PARTIALS_REF));
    expect(VIEW_PARTIALS_REF).toBe('harness/inventory/view-partials.yaml');
  });

  it('records the reviewed script, defaults, panel, response and template partials, not the scaffolder pane', () => {
    expect(committed.sourceSha).toBe(SHA);
    expect(committed.partials.map((p) => p.id)).toEqual([
      'vp:carch.draftpromptjs',
      'vp:carch.edit_panels',
      'vp:carch.js',
      'vp:ccategory.js',
      'vp:cchain.js',
      'vp:cdashboard.act_defaults',
      'vp:cdashboard.js',
      'vp:cemail.js',
      'vp:cextend.js',
      'vp:cfeed.js',
      'vp:cform.html',
      'vp:cform.json',
      'vp:scaffold.assembler_templates',
    ]);
    expect(committed.partials.map((p) => p.view)).not.toContain('admin/core/views/carch/scaffold.cfm');
  });

  it.each<ViewPartial>(committed.partials)('$id still matches the pinned tree', (partial) => {
    expect(check(partial)).toEqual([]);
  });

  it('reports a record the pinned tree contradicts', () => {
    const scaffold: ViewPartial = {
      id: 'vp:carch.scaffold',
      view: 'admin/core/views/carch/scaffold.cfm',
      includers: [{ path: 'admin/core/views/carch/list.cfm', lines: [761, 761] }],
      reason: 'stale',
    };
    expect(check(scaffold)).toEqual([
      'includers admin/core/views/carch/list.cfm:761-761 differ from its includes admin/core/views/carch/list.cfm:762-762',
    ]);
  });
});
