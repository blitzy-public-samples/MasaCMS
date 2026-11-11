import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  OverrideError,
  SessionEffects,
  Trigger,
  loadRoleOverrides,
  loadWriterOverrides,
  roleOverridesSchema,
  writerOverridesSchema,
} from '../../src/inventory/overrides.js';
import type { RoleOverrides, WriterOverrides } from '../../src/inventory/overrides.js';
import { pinnedSha } from '../../src/lib/pin.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SHA = pinnedSha();
const ROLE_ID = /^role:[a-z0-9]+\.([a-z0-9]+|\*)$/i;
const WRITER_ID = /^wov:[a-z0-9-]+$/;

/** Absolute path of a file under `harness/test/fixtures/inventory/`. */
function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/inventory/${name}`, import.meta.url));
}

const ROLE_VALID = fixture('role-overrides.valid.yaml');
const ROLE_BAD_ID = fixture('role-overrides.bad-id.yaml');
const WRITER_VALID = fixture('writer-overrides.valid.yaml');
const WRITER_WRONG_SHA = fixture('writer-overrides.wrong-sha.yaml');

let dir: string;
let serial = 0;

/** Writes `text` to a fresh file in the temp directory; returns its absolute path. */
async function tempFile(text: string): Promise<string> {
  serial += 1;
  const file = path.join(dir, `${serial}-overrides.yaml`);
  await writeFile(file, text, 'utf8');
  return file;
}

/** The `OverrideError` that `promise` rejects with; fails when it resolves or rejects with another error. */
async function rejection(promise: Promise<unknown>): Promise<OverrideError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the loader to reject');
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(OverrideError);
  return error as OverrideError;
}

/** Ids of `items` in default string sort order. */
function sortedIds(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id).sort();
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-overrides-'));
  expect(path.relative(REPO_ROOT, dir).split(path.sep)[0]).toBe('..');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadRoleOverrides with the role fixtures', () => {
  let doc: RoleOverrides;

  beforeAll(async () => {
    doc = await loadRoleOverrides(ROLE_VALID);
  });

  it('loads the valid fixture at the pinned SHA with its three overrides in id order', () => {
    expect(SHA).toBe('696383140578f8dea3ece26f80cd7bfb370ddf0f');
    expect(doc.sourceSha).toBe(SHA);
    const ids = doc.overrides.map((o) => o.id);
    expect(ids).toEqual(['role:cfixture.special', 'role:cmessage.*', 'role:cusers.*']);
    expect(ids).toEqual(sortedIds(doc.overrides));
  });

  it.each<[string, unknown, { path: string; lines: [number, number] }]>([
    [
      'role:cfixture.special',
      { anyOf: ['site-admin', 's2'] },
      { path: 'admin/core/controllers/cfixture.cfc', lines: [11, 13] },
    ],
    ['role:cmessage.*', 'system-user', { path: 'admin/core/controllers/cmessage.cfc', lines: [78, 82] }],
    ['role:cusers.*', 'm:008', { path: 'admin/core/controllers/cusers.cfc', lines: [90, 124] }],
  ])('keeps the required role and gate source of %s', (id, requiredRole, gate) => {
    const override = doc.overrides.find((o) => o.id === id);
    expect(override).toBeDefined();
    expect(override?.requiredRole).toEqual(requiredRole);
    expect(override?.gate).toEqual(gate);
    expect(override?.gate.lines).toHaveLength(2);
  });

  it('carries the extractor patterns, application gate and denial default as the fixture declares them', async () => {
    const declared = parse(await readFile(ROLE_VALID, 'utf8')) as Pick<
      RoleOverrides,
      'extractorPatterns' | 'applicationGate' | 'denialDefault'
    >;
    expect(doc.extractorPatterns.map((p) => p.id)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5']);
    expect(doc.extractorPatterns).toEqual(declared.extractorPatterns);
    expect(doc.applicationGate.rules.map((r) => r.id)).toEqual(['no-site-not-private', 'no-site']);
    expect(doc.applicationGate).toEqual(declared.applicationGate);
    expect(doc.denialDefault.source).toEqual({ path: 'admin/core/controllers/controller.cfc', lines: [83, 92] });
    expect(doc.denialDefault).toEqual(declared.denialDefault);
  });

  it('rejects the bad-id fixture with an OverrideError naming the malformed override id', async () => {
    const error = await rejection(loadRoleOverrides(ROLE_BAD_ID));
    expect(error.path).toBe(ROLE_BAD_ID);
    expect(error.issues).toContain('overrides.2.id: must be role:<circuit>.<action> or role:<circuit>.*');
    expect(error.issues.every((issue) => issue.startsWith('overrides.2.id: '))).toBe(true);
    expect(error.message).toBe(`override file ${ROLE_BAD_ID}: ${error.issues.join('; ')}`);
  });

  it('fails the bad-id fixture on the override id form alone', async () => {
    const document = parse(await readFile(ROLE_BAD_ID, 'utf8')) as { overrides: Record<string, unknown>[] };
    const parsed = roleOverridesSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    const paths = (parsed.error?.issues ?? []).map((issue) => issue.path.map(String));
    expect(paths.length).toBeGreaterThan(0);
    for (const issuePath of paths) {
      expect(issuePath).toEqual(['overrides', '2', 'id']);
      expect(issuePath.at(-1)).toBe('id');
    }
    document.overrides = document.overrides.map((o) => (o.id === 'cusers-update' ? { ...o, id: 'role:cusers.*' } : o));
    expect(roleOverridesSchema.safeParse(document).success).toBe(true);
  });
});

describe('loadWriterOverrides with the writer fixtures', () => {
  let doc: WriterOverrides;
  let validText: string;

  /** The valid writer fixture with `field` of its first writer set to `value`. */
  function withFirstWriter(field: string, value: unknown): unknown {
    const document = parse(validText) as { writers: Record<string, unknown>[] };
    document.writers = document.writers.map((w, index) => (index === 0 ? { ...w, [field]: value } : w));
    return document;
  }

  beforeAll(async () => {
    validText = await readFile(WRITER_VALID, 'utf8');
    doc = await loadWriterOverrides(WRITER_VALID);
  });

  it('loads the valid fixture at the pinned SHA with its writers in id order', () => {
    expect(doc.sourceSha).toBe(SHA);
    const ids = doc.writers.map((w) => w.id);
    expect(ids).toEqual(['wov:fixture-relogin', 'wov:fixture-thread']);
    expect(ids).toEqual(sortedIds(doc.writers));
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'wov:fixture-relogin',
      { tables: ['tusers'], op: 'update', trigger: 'request', sessionEffects: 'relogin', routeKeys: ['api:user.save'] },
    ],
    [
      'wov:fixture-thread',
      { tables: ['tfixturestats'], op: 'insert', trigger: 'thread', keyScope: ['siteid'], sessionEffects: 'none' },
    ],
  ])('keeps the tables, operation, trigger and session effects of %s', (id, expected) => {
    expect(doc.writers.find((w) => w.id === id)).toMatchObject(expected);
  });

  it('rejects the wrong-sha fixture on the source pin alone, although its schema accepts it', async () => {
    const wrongSha = parse(await readFile(WRITER_WRONG_SHA, 'utf8')) as { sourceSha: string };
    expect(writerOverridesSchema.safeParse(wrongSha).success).toBe(true);
    expect(wrongSha.sourceSha).not.toBe(SHA);
    const error = await rejection(loadWriterOverrides(WRITER_WRONG_SHA));
    expect(error.path).toBe(WRITER_WRONG_SHA);
    expect(error.issues).toEqual([`sourceSha: ${wrongSha.sourceSha} does not match the pinned source SHA ${SHA}`]);
    expect(error.message).toContain('does not match the pinned source SHA');
  });

  // The Trigger and SessionEffects vocabularies are checked here, against the issue they raise; the full
  // enumeration listing lives in overrides-gate.test.ts.
  it.each([
    { field: 'trigger', vocabulary: Trigger, options: ['request', 'scheduler', 'thread', 'appstart'], invalid: 'cron' },
    {
      field: 'sessionEffects',
      vocabulary: SessionEffects,
      options: ['none', 'login', 'logout', 'relogin'],
      invalid: 'impersonate',
    },
  ])('rejects a writer whose $field is outside its enumeration', async ({ field, vocabulary, options, invalid }) => {
    expect(vocabulary.options).toEqual(options);
    const document = withFirstWriter(field, invalid);
    const parsed = writerOverridesSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['writers', 0, field]]);
    const file = await tempFile(stringify(document));
    const error = await rejection(loadWriterOverrides(file));
    const expected = options.map((option) => `"${option}"`).join('|');
    expect(error.issues).toEqual([`writers.0.${field}: Invalid option: expected one of ${expected}`]);
  });
});

describe.each([
  { name: 'loadRoleOverrides', load: loadRoleOverrides, source: ROLE_VALID },
  { name: 'loadWriterOverrides', load: loadWriterOverrides, source: WRITER_VALID },
])('$name on malformed YAML', ({ load, source }) => {
  it('rejects a copy of the valid fixture cut inside its first flow mapping with an OverrideError', async () => {
    const text = await readFile(source, 'utf8');
    const file = await tempFile(text.slice(0, text.indexOf('{') + 1));
    const error = await rejection(load(file));
    expect(error.path).toBe(file);
    expect(error.issues).toEqual([expect.stringMatching(/^is not valid YAML: /)]);
  });
});

describe('committed override files', () => {
  let roles: RoleOverrides;
  let writers: WriterOverrides;

  beforeAll(async () => {
    roles = await loadRoleOverrides();
    writers = await loadWriterOverrides();
  });

  it.each([
    { file: 'role-overrides.yaml', pattern: ROLE_ID, read: () => ({ doc: roles, items: roles.overrides }) },
    { file: 'writer-overrides.yaml', pattern: WRITER_ID, read: () => ({ doc: writers, items: writers.writers }) },
  ])('$file loads at the pinned SHA with unique ids of the documented form', ({ pattern, read }) => {
    const { doc, items } = read();
    expect(doc.sourceSha).toBe(SHA);
    const all = items.map((item) => item.id);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((id) => !pattern.test(id))).toEqual([]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('marks the legacy-hash upgrade of the stored password as joining no cut-over group', () => {
    const unjoined = writers.writers.filter((w) => w.noGroupJoin === true).map((w) => w.id);
    expect(unjoined).toContain('wov:legacy-hash-upgrade');
    expect(writers.writers.find((w) => w.id === 'wov:legacy-hash-upgrade')).toMatchObject({
      tables: ['tusers'],
      columns: ['Password', 'PasswordCreated'],
      trigger: 'request',
      noGroupJoin: true,
    });
  });

  it.each<[Trigger, string[]]>([
    ['scheduler', ['wov:native-sitemonitor-task', 'wov:fixture-survey-tasks']],
    ['appstart', ['wov:scheduler-registration', 'wov:startup-url-conversion']],
  ])('declares writers whose trigger is %s', (trigger, expected) => {
    const ids = writers.writers.filter((w) => w.trigger === trigger).map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining(expected));
  });
});
