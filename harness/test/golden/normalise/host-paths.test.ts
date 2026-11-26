// Unit suite for the host-path rule: the checkout and the state directory become placeholders in normalised text.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { GoldenConfigError } from '../../../src/golden/errors.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import { RULES_PATH, loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import { normaliseText, normaliseUrl, normaliseValue } from '../../../src/golden/normalise/values.js';
import { REPO_ROOT } from '../../../src/lib/paths.js';

interface RulesDoc {
  hostPaths: { roots: Record<string, unknown>[] };
  [section: string]: unknown;
}

let dir = '';
/** A state directory reached through a symlink, and its real path. */
let link = '';
let real = '';
let rules: NormaliseRules;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'opt2-host-paths-')));
  real = path.join(dir, 'state-real');
  link = path.join(dir, 'state');
  mkdirSync(real);
  symlinkSync(real, link);
  rules = loadRules(RULES_PATH, { PORT: '8500', OPT2_STATE_DIR: link });
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

const text = (s: string, using: NormaliseRules = rules): string => normaliseText(s, createIdOrdinals(), using);

/** `s` as encodeForJavaScript writes it: letters, digits and `,._` kept, every other code unit as `\xHH`. */
const jsEscaped = (s: string): string =>
  s.replace(/[^\w,.]/g, (c) => `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/** `s` with every code unit but letters and digits as a lower-case `\uHHHH` escape. */
const unicodeEscaped = (s: string): string =>
  s.replace(/[^0-9A-Za-z]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

describe('loadRules hostPaths', () => {
  it('resolves the checkout and the state directory as given and as their real paths', () => {
    expect(rules.hostPaths.roots).toStrictEqual([
      { root: 'checkout', placeholder: '<webroot>', paths: [...new Set([REPO_ROOT, realpathSync(REPO_ROOT)])] },
      { root: 'state-dir', placeholder: '<state>', paths: [link, real] },
    ]);
  });

  it('keeps an absent state directory as given', () => {
    const absent = path.join(dir, 'absent');
    const loaded = loadRules(RULES_PATH, { PORT: '8500', OPT2_STATE_DIR: absent });
    expect(loaded.hostPaths.roots[1]?.paths).toStrictEqual([absent]);
  });

  it.each<[string, (doc: RulesDoc) => void, string]>([
    ['a root declared twice', (doc) => doc.hostPaths.roots.push({ root: 'checkout', placeholder: '<other>' }), 'declares root checkout more than once'],
    ['an unknown root', (doc) => doc.hostPaths.roots.push({ root: 'home', placeholder: '<home>' }), 'hostPaths.roots.2.root'],
    ['paths written in the file', (doc) => Object.assign(doc.hostPaths.roots[0] ?? {}, { paths: ['/srv'] }), 'hostPaths.roots.0'],
  ])('rejects %s', (label, mutate, message) => {
    const doc = parse(readFileSync(RULES_PATH, 'utf8')) as RulesDoc;
    mutate(doc);
    const file = path.join(dir, `${label.replaceAll(' ', '-')}.yaml`);
    writeFileSync(file, stringify(doc), 'utf8');
    let thrown: unknown;
    try {
      loadRules(file, { PORT: '8500', OPT2_STATE_DIR: link });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GoldenConfigError);
    expect((thrown as GoldenConfigError).message).toContain(message);
  });
});

describe('normaliseText host paths', () => {
  it.each<[string, () => string, string]>([
    [
      'an ACF stack frame',
      () => `\tat cfcontentRenderer2ecfc$funcINIT.runFunction(${REPO_ROOT}/core/mura/content/contentRenderer.cfc:701)`,
      '\tat cfcontentRenderer2ecfc$funcINIT.runFunction(<webroot>/core/mura/content/contentRenderer.cfc:701)',
    ],
    [
      'a rendered file-store message',
      () => `File or directory ${REPO_ROOT}/sites/umbrella/cache/file/logo_FILE.png does not exist.`,
      'File or directory <webroot>/sites/umbrella/cache/file/logo_FILE.png does not exist.',
    ],
    ['the root ending a sentence', () => `The webroot is ${REPO_ROOT}.`, 'The webroot is <webroot>.'],
    ['the state directory as given', () => `${link}/golden/raw/capture.json`, '<state>/golden/raw/capture.json'],
    ['the state directory as its real path', () => `wrote ${real}/storage`, 'wrote <state>/storage'],
    [
      'the admin webroot escaped by encodeForJavaScript',
      () => `var webroot='${jsEscaped(REPO_ROOT)}';`,
      "var webroot='<webroot>';",
    ],
    [
      'an escaped path beneath the checkout after an escaped quote',
      () => `\\x27${jsEscaped(`${REPO_ROOT}/core`)}\\x27.`,
      String.raw`\x27<webroot>\x2Fcore\x27.`,
    ],
    [
      'the state directory as \\uHHHH escapes',
      () => `${unicodeEscaped(link)}\\u002fgolden`,
      String.raw`<state>\u002fgolden`,
    ],
    [
      'the checkout with JSON-escaped solidi',
      () => `"${REPO_ROOT.replaceAll('/', '\\/')}\\/admin"`,
      String.raw`"<webroot>\/admin"`,
    ],
  ])('replaces %s', (_label, input, expected) => {
    expect(text(input())).toBe(expected);
  });

  it.each<[string, () => string]>([
    ['a longer sibling directory', () => `${REPO_ROOT}-other/core/x.cfc`],
    ['a file next to the root', () => `${REPO_ROOT}.bak`],
    ['the root nested in another path', () => `/srv${REPO_ROOT}/core/x.cfc`],
    ['a relative path', () => `.${REPO_ROOT}/core/x.cfc`],
    ['an escaped longer sibling directory', () => jsEscaped(`${REPO_ROOT}-other/core`)],
    ['the escaped root nested in another path', () => jsEscaped(`/srv${REPO_ROOT}/core`)],
    ['the escaped root after an escaped name character', () => jsEscaped(`~${REPO_ROOT}`)],
  ])('leaves %s', (_label, input) => {
    expect(text(input())).not.toContain('<webroot>');
  });

  it('normalises the same text under two state directories alike, as capture and replay of different runs', () => {
    const other = path.join(dir, 'other-state');
    const replay = loadRules(RULES_PATH, { PORT: '8500', OPT2_STATE_DIR: other });
    expect(text(`${other}/golden/raw/capture.json`, replay)).toBe(text(`${link}/golden/raw/capture.json`));
  });
});

describe('normaliseValue and normaliseUrl host paths', () => {
  it('replaces the paths of an ACF error envelope before ids take their ordinals', () => {
    const envelope = {
      error: {
        stacktrace: {
          TagContext: [
            {
              TEMPLATE: `${REPO_ROOT}/core/mura/content/contentRenderer.cfc`,
              RAW_TRACE: `\tat cf.runFunction(${REPO_ROOT}/core/mura/content/contentRenderer.cfc:701)`,
              contentid: '6f1c0e4a-2b3d-4c5e-8f9a-0b1c2d3e4f5a',
            },
          ],
        },
      },
    };
    expect(normaliseValue(envelope, createIdOrdinals(), rules)).toStrictEqual({
      error: {
        stacktrace: {
          TagContext: [
            {
              RAW_TRACE: '\tat cf.runFunction(<webroot>/core/mura/content/contentRenderer.cfc:701)',
              TEMPLATE: '<webroot>/core/mura/content/contentRenderer.cfc',
              contentid: '<uuid:1>',
            },
          ],
        },
      },
    });
  });

  it('replaces the root of a URL-like path with a query', () => {
    expect(normaliseUrl(`${REPO_ROOT}/admin/index.cfm?view=1`, createIdOrdinals(), rules)).toBe(
      '<webroot>/admin/index.cfm?view=1',
    );
  });
});
