import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { YAMLParseError, stringify } from 'yaml';
import {
  OverrideError,
  PreventedBy,
  ROLE_OVERRIDES_PATH,
  RequiredRole,
  RequiredRoleTemplate,
  SessionEffects,
  SettledResolution,
  SourceRef,
  Trigger,
  WRITER_OVERRIDES_PATH,
  WriterOp,
  loadRoleOverrides,
  loadWriterOverrides,
  parseRoleOverrides,
  parseWriterOverrides,
  roleOverridesSchema,
  writerOverridesSchema,
} from '../../src/inventory/overrides.js';
import type { RoleOverrides, WriterOverrides } from '../../src/inventory/overrides.js';
import { REPO_ROOT, isInsideRepo } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const SHA = pinnedSha();
const HEX_DIGITS = '0123456789abcdef';
/** A 40-hex SHA that differs from the pinned one in every digit. */
const OTHER_SHA = [...SHA].map((digit) => HEX_DIGITS.charAt((HEX_DIGITS.indexOf(digit) + 1) % 16)).join('');
const LABEL = 'in-memory.yaml';
const ROLE_TERMS = 'public, member, system-user, site-admin, s2, deny, m:<3 digits>';
const ROLE_MESSAGE = `must be one of ${ROLE_TERMS}, or {anyOf: [...]} or {allOf: [...]} of such terms`;
const TEMPLATE_MESSAGE = `must be one of ${ROLE_TERMS}, m:X, or {anyOf: [...]} or {allOf: [...]} of such terms`;
const PATH_MESSAGE = 'must be a repository-relative path with / separators';
const ROUTE_KEYS_MESSAGE = 'a request writer needs route keys unless dynamic is true or it has an entryScope';
const NO_ITEMS = 'Too small: expected array to have >=1 items';
const NO_CHARACTERS = 'Too small: expected string to have >=1 characters';
const NO_STRING = 'Invalid input: expected string, received undefined';
const GATE_SCOPES = 'Invalid option: expected one of "request"|"session"|"siteSetting"|"config"';
const REDIRECTS = 'Invalid option: expected one of "clogin.logout"|"cMessage.noaccess"';

/** Edit value that removes the key it addresses. */
const DROP = Symbol('drop');
/** Values to set, keyed by dotted path into a document; array items are addressed by index. */
type Edits = Record<string, unknown>;

function ref(file: string, start: number, end: number): { path: string; lines: [number, number] } {
  return { path: file, lines: [start, end] };
}

/** The carch.update override of the committed file, trimmed to its required and node-permission keys. */
function carchUpdate(): Record<string, unknown> {
  return {
    id: 'role:carch.update',
    circuit: 'carch',
    action: 'update',
    requiredRole: { anyOf: ['s2', 'site-admin', 'm:000'] },
    nodePermission: {
      verdicts: ['author', 'editor'],
      precedence: ref('core/mura/permission.cfc', 220, 282),
      denial: 'the add and delete writes are skipped',
      source: ref('admin/core/controllers/carch.cfc', 346, 356),
    },
    gate: ref('admin/core/controllers/carch.cfc', 346, 414),
    reason: 'allowAction comes from the node verdict of contentid.',
  };
}

/** Minimal valid role-overrides document in the committed file's shape. */
function roleDocument(): Record<string, unknown> {
  return {
    sourceSha: SHA,
    extractorPatterns: [
      { id: 'P0', shape: 'before() calls no secure()', requiredRole: 'public' },
      {
        id: 'P2',
        shape: '!(getModulePerm(000) AND getModulePerm(X)), then secure()',
        requiredRole: { anyOf: ['s2', 'site-admin', { allOf: ['m:X', 'm:000'] }] },
        examples: ['cchain'],
      },
    ],
    applicationGate: {
      source: ref('admin/Application.cfc', 433, 453),
      siteFrom: {
        order: ['rc.siteid', 'session.siteid', 'default'],
        except: { action: 'csettings.editsite', order: ['rc.siteid', 'default'] },
        unknownSite: 'default',
        source: ref('admin/Application.cfc', 342, 412),
      },
      siteArray: {
        requiredRole: { anyOf: ['s2', 'site-admin', 'm:000'] },
        built: 'once per session, on the first logged-in admin request',
        cleared: 'at login',
        source: ref('admin/Application.cfc', 433, 441),
      },
      anonymous: 'not affected',
      rules: [
        {
          id: 'admin-disabled',
          on: 'config',
          predicate: 'configBean disableAdmin is true',
          outcome: 'renderFilename then abort, for every caller',
          source: ref('admin/Application.cfc', 428, 431),
        },
        {
          id: 'no-site',
          on: 'session',
          predicate: 'logged in and session.siteArray empty',
          redirect: 'cMessage.noaccess',
          source: ref('admin/Application.cfc', 446, 452),
        },
      ],
    },
    denialDefault: {
      source: ref('admin/core/controllers/controller.cfc', 83, 92),
      anonymous: 'redirect cLogin.main with returnURL,compactDisplay',
      authenticated: 'utility.backUp()',
    },
    overrides: [
      carchUpdate(),
      {
        id: 'role:scaffold.*',
        circuit: 'scaffold',
        action: '*',
        requiredRole: { anyOf: ['s2', 'site-admin'] },
        siteFrom: 'session.siteid',
        when: [
          {
            on: 'request',
            predicate: 'action is one of assembler, sites, updatesites',
            requiredRole: 's2',
            denial: 'secure()',
            source: ref('admin/core/controllers/scaffold.cfc', 84, 84),
          },
        ],
        denial: 'location <context>/',
        gate: ref('admin/core/controllers/scaffold.cfc', 77, 91),
        reason: 'The site-admin branch tests session.siteid rather than rc.siteid.',
      },
    ],
  };
}

/** Minimal valid writer-overrides document in the committed file's shape, one writer per kind. */
function writerDocument(): Record<string, unknown> {
  return {
    sourceSha: SHA,
    writers: [
      {
        id: 'wov:scheduler-registration',
        tablesFrom: { job: 'job:sitemonitor' },
        component: 'core/appcfc/onApplicationStart_include.cfm',
        method: null,
        op: 'schedule',
        source: ref('core/appcfc/onApplicationStart_include.cfm', 561, 575),
        routeKeys: [],
        keyScope: 'table',
        trigger: 'appstart',
        sessionEffects: 'none',
        condition: 'iniProperties.ping is true',
        preventedBy: 'scheduler-registration',
        reason: 'It registers the ACF siteMonitor task.',
      },
      {
        id: 'wov:login-lastlogin',
        tables: ['tusers'],
        columns: ['LastLogin'],
        component: 'core/mura/user/userUtility.cfc',
        method: 'loginByQuery',
        op: 'update',
        source: ref('core/mura/user/userUtility.cfc', 367, 370),
        routeKeys: ['admin:clogin.login', 'page:login'],
        keyScope: 'table',
        trigger: 'request',
        sessionEffects: 'login',
        reason: 'Login paths reach loginByQuery through handlers chosen at run time.',
      },
      {
        id: 'wov:remember-me-login',
        tables: ['tusers'],
        columns: ['LastLogin'],
        component: 'core/appcfc/onRequestStart_include.cfm',
        method: null,
        op: 'update',
        source: ref('core/appcfc/onRequestStart_include.cfm', 222, 229),
        routeKeys: [],
        entryScope: { families: ['admin', 'page'], when: 'userid and userHash cookies are set' },
        keyScope: 'table',
        trigger: 'request',
        sessionEffects: 'login',
        reason: 'Request start-up code calls rememberMe before any entry point is dispatched.',
      },
      {
        id: 'wov:ctrash-restore-object-save',
        tables: [],
        component: 'admin/core/controllers/ctrash.cfc',
        method: 'restore',
        op: 'save',
        source: ref('admin/core/controllers/ctrash.cfc', 123, 142),
        routeKeys: ['admin:ctrash.restore'],
        keyScope: ['deleteid', 'objectid'],
        trigger: 'request',
        sessionEffects: 'none',
        dynamic: true,
        reason: 'The stored ttrash objectClass decides the table at run time.',
      },
      {
        id: 'wov:fixture-survey-tasks',
        tables: ['synthetic.survey', 'synthetic.survey_reminder'],
        component: 'legacy-fixtures/cfml/modules/surveys.cfc',
        method: 'handle',
        op: 'update',
        source: ref('legacy-fixtures/cfml/modules/surveys.cfc', 37, 42),
        routeKeys: ['fixture:surveys/surveys/{id}/launch@get'],
        keyScope: ['id'],
        trigger: 'scheduler',
        sessionEffects: 'none',
        noGroupJoin: true,
        preventedBy: 'fixture-survey-tasks',
        reason: 'ACF tasks the fixture registers issue these requests.',
      },
    ],
  };
}

/** `doc` with every edit applied in order; DROP deletes the addressed key. */
function edit(doc: Record<string, unknown>, edits: Edits): Record<string, unknown> {
  for (const [at, value] of Object.entries(edits)) {
    const keys = at.split('.');
    const last = keys.pop() ?? '';
    let node = doc;
    for (const key of keys) node = node[key] as Record<string, unknown>;
    if (value === DROP) delete node[last];
    else node[last] = value;
  }
  return doc;
}

/** The OverrideError `run` throws; fails the test when it returns. */
function overrideError(run: () => unknown): OverrideError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(OverrideError);
    return err as OverrideError;
  }
  throw new Error('expected an OverrideError, but the document was accepted');
}

function roleIssues(edits: Edits): readonly string[] {
  return overrideError(() => parseRoleOverrides(stringify(edit(roleDocument(), edits)), LABEL)).issues;
}

function writerIssues(edits: Edits): readonly string[] {
  return overrideError(() => parseWriterOverrides(stringify(edit(writerDocument(), edits)), LABEL)).issues;
}

/** Lower-cased `ids` that occur more than once. */
function repeated(ids: readonly string[]): string[] {
  const lowered = ids.map((id) => id.toLowerCase());
  return lowered.filter((id, index) => lowered.indexOf(id) !== index);
}

let dir: string;
let serial = 0;

/** Writes `text` to a fresh file in the temp directory; returns its absolute path. */
async function tempFile(text: string): Promise<string> {
  serial += 1;
  const file = path.join(dir, `${serial}-overrides.yaml`);
  await writeFile(file, text, 'utf8');
  return file;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-overrides-gate-'));
  expect(isInsideRepo(dir)).toBe(false);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('committed override files', () => {
  it('ROLE_OVERRIDES_PATH and WRITER_OVERRIDES_PATH are the reviewed files under harness/inventory', () => {
    expect(ROLE_OVERRIDES_PATH).toBe(path.join(REPO_ROOT, 'harness', 'inventory', 'role-overrides.yaml'));
    expect(WRITER_OVERRIDES_PATH).toBe(path.join(REPO_ROOT, 'harness', 'inventory', 'writer-overrides.yaml'));
  });

  it('loadRoleOverrides() reads role-overrides.yaml: pinned SHA, unique ids, list-valued siteFrom', async () => {
    const doc: RoleOverrides = await loadRoleOverrides();
    expect(doc.sourceSha).toBe(SHA);
    expect(doc.extractorPatterns.length).toBeGreaterThan(0);
    expect(doc.overrides.length).toBeGreaterThan(0);
    expect(repeated(doc.extractorPatterns.map((p) => p.id))).toEqual([]);
    expect(repeated(doc.applicationGate.rules.map((r) => r.id))).toEqual([]);
    expect(repeated(doc.overrides.map((o) => o.id))).toEqual([]);
    for (const o of doc.overrides) {
      expect(o.id.toLowerCase()).toBe(`role:${o.circuit}.${o.action}`.toLowerCase());
      if (o.siteFrom !== undefined) expect(Array.isArray(o.siteFrom)).toBe(true);
    }
  });

  it('loadWriterOverrides() reads writer-overrides.yaml: pinned SHA, unique ids, one table source each', async () => {
    const doc: WriterOverrides = await loadWriterOverrides();
    expect(doc.sourceSha).toBe(SHA);
    expect(doc.writers.length).toBeGreaterThan(0);
    expect(repeated([...doc.writers, ...(doc.settledCalls ?? [])].map((w) => w.id))).toEqual([]);
    for (const w of doc.writers) {
      expect(w.tables === undefined).not.toBe(w.tablesFrom === undefined);
      if (w.preventedBy !== undefined) expect(w.trigger).not.toBe('request');
    }
  });
});

describe('enumerations', () => {
  it.each<[string, readonly string[], string[]]>([
    ['Trigger', Trigger.options, ['request', 'scheduler', 'thread', 'appstart']],
    ['SessionEffects', SessionEffects.options, ['none', 'login', 'logout', 'relogin']],
    ['WriterOp', WriterOp.options, ['insert', 'update', 'delete', 'save', 'schedule']],
    [
      'PreventedBy',
      PreventedBy.options,
      [
        'scheduler-registration',
        'native-sitemonitor-task',
        'startup-url-conversion',
        'fixture-survey-tasks',
        'fixture-export-threads',
      ],
    ],
    ['SettledResolution', SettledResolution.options, ['not-cfml', 'non-write', 'unreachable', 'counted']],
  ])('%s lists exactly its values, in order', (_name, options, expected) => {
    expect(options).toEqual(expected);
  });
});

describe('RequiredRole and RequiredRoleTemplate', () => {
  it.each<[string, unknown, boolean, boolean]>([
    ['public', 'public', true, true],
    ['member', 'member', true, true],
    ['system-user', 'system-user', true, true],
    ['site-admin', 'site-admin', true, true],
    ['s2', 's2', true, true],
    ['deny', 'deny', true, true],
    ['a three-digit module grant', 'm:015', true, true],
    ['the m:X module placeholder', 'm:X', false, true],
    ['a lower-case m:x placeholder', 'm:x', false, false],
    ['a two-digit module grant', 'm:01', false, false],
    ['a four-digit module grant', 'm:0001', false, false],
    ['an unknown role name', 'admin', false, false],
    ['an upper-case S2', 'S2', false, false],
    ['an empty string', '', false, false],
    ['a number', 15, false, false],
    ['null', null, false, false],
    ['nested anyOf and allOf terms', { anyOf: ['s2', { allOf: ['m:015', 'm:000'] }] }, true, true],
    ['an allOf with the m:X placeholder', { allOf: ['m:X', 'm:000'] }, false, true],
    ['an empty anyOf', { anyOf: [] }, false, false],
    ['an empty allOf', { allOf: [] }, false, false],
    ['anyOf and allOf in one object', { anyOf: ['s2'], allOf: ['s2'] }, false, false],
    ['an unknown combinator', { oneOf: ['s2'] }, false, false],
    ['an anyOf holding an unknown term', { anyOf: ['s2', 'nobody'] }, false, false],
  ])('%s: RequiredRole accepts it %s, RequiredRoleTemplate %s', (_label, value, role, template) => {
    expect(RequiredRole.safeParse(value).success).toBe(role);
    expect(RequiredRoleTemplate.safeParse(value).success).toBe(template);
  });

  it('names the accepted terms when rejecting a term, the template adding m:X', () => {
    expect(RequiredRole.safeParse('m:X').error?.issues.map((i) => i.message)).toEqual([ROLE_MESSAGE]);
    expect(RequiredRoleTemplate.safeParse('admin').error?.issues.map((i) => i.message)).toEqual([TEMPLATE_MESSAGE]);
  });
});

describe('SourceRef', () => {
  it.each<[string, unknown]>([
    ['a nested file and a line range', ref('admin/core/controllers/carch.cfc', 578, 590)],
    ['a single line', ref('admin/core/controllers/cfeed.cfc', 87, 87)],
    ['a dotted file name', ref('harness/inventory/role-overrides.yaml', 1, 1)],
  ])('accepts %s', (_label, value) => {
    expect(SourceRef.parse(value)).toEqual(value);
  });

  it.each<[string, unknown, string]>([
    ['a backslash separator', ref('admin\\Application.cfc', 1, 1), `path: ${PATH_MESSAGE}`],
    ['a leading slash', ref('/admin/Application.cfc', 1, 1), `path: ${PATH_MESSAGE}`],
    ['an empty segment', ref('admin//Application.cfc', 1, 1), `path: ${PATH_MESSAGE}`],
    ['a trailing slash', ref('admin/', 1, 1), `path: ${PATH_MESSAGE}`],
    ['a dot segment', ref('admin/./Application.cfc', 1, 1), `path: ${PATH_MESSAGE}`],
    ['a parent segment', ref('../admin/Application.cfc', 1, 1), `path: ${PATH_MESSAGE}`],
    ['an empty path', ref('', 1, 1), `path: ${PATH_MESSAGE}`],
    ['a zero start line', ref('admin/Application.cfc', 0, 3), 'lines.0: Too small: expected number to be >=1'],
    ['a fractional line', ref('a/b.cfc', 1.5, 2), 'lines.0: Invalid input: expected int, received number'],
    ['a start after the end', ref('admin/Application.cfc', 5, 4), 'lines: start line must not exceed end line'],
    ['one line number', { path: 'a/b.cfc', lines: [1] }, 'lines: Too small: expected array to have >=2 items'],
    ['three line numbers', { path: 'a/b.cfc', lines: [1, 2, 3] }, 'lines: Too big: expected array to have <=2 items'],
    ['an unknown key', { ...ref('admin/Application.cfc', 1, 1), url: 'x' }, 'Unrecognized key: "url"'],
  ])('rejects %s', (_label, value, expected) => {
    const issues = SourceRef.safeParse(value).error?.issues ?? [];
    const described = issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message));
    expect(described).toEqual([expected]);
  });
});

describe('parseRoleOverrides', () => {
  it('accepts the minimal document, turning a single siteFrom string into a list, an absent one unset', () => {
    const doc = parseRoleOverrides(stringify(roleDocument()), LABEL);
    expect(doc.sourceSha).toBe(SHA);
    expect(doc.overrides.map((o) => o.siteFrom)).toEqual([undefined, ['session.siteid']]);
    expect(doc.extractorPatterns[1]?.requiredRole).toEqual({
      anyOf: ['s2', 'site-admin', { allOf: ['m:X', 'm:000'] }],
    });
  });

  it('keeps a siteFrom list in its order', () => {
    const order = ['rc.siteid', 'session.siteid', 'default'];
    const text = stringify(edit(roleDocument(), { 'overrides.1.siteFrom': order }));
    expect(parseRoleOverrides(text, LABEL).overrides[1]?.siteFrom).toEqual(order);
  });

  it('keeps extra reviewer keys on an override', () => {
    const text = stringify(edit(roleDocument(), { 'overrides.0.reviewedBy': 'security review' }));
    expect(parseRoleOverrides(text, LABEL).overrides[0]).toMatchObject({ reviewedBy: 'security review' });
  });

  it.each<[string, Edits]>([
    ['no overrides', { overrides: [] }],
    ['no siteFrom exception', { 'applicationGate.siteFrom.except': DROP }],
    ['no pattern examples', { 'extractorPatterns.1.examples': DROP }],
    [
      'no node-permission or condition denial',
      { 'overrides.0.nodePermission.denial': DROP, 'overrides.1.when.0.denial': DROP },
    ],
    ['an override id cased differently from its circuit and action', { 'overrides.0.id': 'ROLE:CArch.Update' }],
    ['an override that denies every caller', { 'overrides.0.requiredRole': 'deny' }],
    ['a sourceSha other than the pinned one', { sourceSha: OTHER_SHA }],
  ])('accepts a document with %s', (_label, edits) => {
    expect(() => parseRoleOverrides(stringify(edit(roleDocument(), edits)), LABEL)).not.toThrow();
  });

  it.each<[string, Edits, string[]]>([
    ['an unknown top-level key', { reviewer: 'qa' }, ['Unrecognized key: "reviewer"']],
    [
      'an upper-case sourceSha',
      { sourceSha: SHA.toUpperCase() },
      ['sourceSha: must be a 40-character lowercase hex commit id'],
    ],
    ['no sourceSha', { sourceSha: DROP }, [`sourceSha: ${NO_STRING}`]],
    ['no extractor patterns', { extractorPatterns: [] }, [`extractorPatterns: ${NO_ITEMS}`]],
    [
      'an extractor pattern id outside P0-P5',
      { 'extractorPatterns.1.id': 'P6' },
      ['extractorPatterns.1.id: Invalid option: expected one of "P0"|"P1"|"P2"|"P3"|"P4"|"P5"'],
    ],
    [
      'an unknown key on an extractor pattern',
      { 'extractorPatterns.0.regex': '^before' },
      ['extractorPatterns.0: Unrecognized key: "regex"'],
    ],
    ['an empty pattern shape', { 'extractorPatterns.0.shape': '' }, [`extractorPatterns.0.shape: ${NO_CHARACTERS}`]],
    [
      'a pattern term outside the template terms',
      { 'extractorPatterns.0.requiredRole': 'm:Y' },
      [`extractorPatterns.0.requiredRole: ${TEMPLATE_MESSAGE}`],
    ],
    ['a duplicate pattern id', { 'extractorPatterns.1.id': 'P0' }, ['extractorPatterns.1.id: duplicate id P0']],
    [
      'an unknown key on the application gate',
      { 'applicationGate.order': ['rc.siteid'] },
      ['applicationGate: Unrecognized key: "order"'],
    ],
    ['an empty site order', { 'applicationGate.siteFrom.order': [] }, [`applicationGate.siteFrom.order: ${NO_ITEMS}`]],
    [
      'an empty site order exception',
      { 'applicationGate.siteFrom.except.order': [] },
      [`applicationGate.siteFrom.except.order: ${NO_ITEMS}`],
    ],
    [
      'the m:X placeholder in the site array role',
      { 'applicationGate.siteArray.requiredRole': 'm:X' },
      [`applicationGate.siteArray.requiredRole: ${ROLE_MESSAGE}`],
    ],
    ['no gate rules', { 'applicationGate.rules': [] }, [`applicationGate.rules: ${NO_ITEMS}`]],
    [
      'a gate rule with both outcome and redirect',
      { 'applicationGate.rules.0.redirect': 'clogin.logout' },
      ['applicationGate.rules.0: exactly one of outcome or redirect is required'],
    ],
    [
      'a gate rule with neither outcome nor redirect',
      { 'applicationGate.rules.1.redirect': DROP },
      ['applicationGate.rules.1: exactly one of outcome or redirect is required'],
    ],
    [
      'a redirect to a route other than clogin.logout and cMessage.noaccess',
      { 'applicationGate.rules.1.redirect': 'cLogin.main' },
      [`applicationGate.rules.1.redirect: ${REDIRECTS}`],
    ],
    [
      'a redirect cased differently from cMessage.noaccess',
      { 'applicationGate.rules.1.redirect': 'cmessage.noaccess' },
      [`applicationGate.rules.1.redirect: ${REDIRECTS}`],
    ],
    [
      'a gate rule id that is not a lower-case slug',
      { 'applicationGate.rules.0.id': 'Admin_Disabled' },
      ['applicationGate.rules.0.id: must be a lower-case slug'],
    ],
    [
      'a gate rule scope outside request, session, siteSetting and config',
      { 'applicationGate.rules.0.on': 'cookie' },
      [`applicationGate.rules.0.on: ${GATE_SCOPES}`],
    ],
    [
      'a duplicate gate rule id',
      { 'applicationGate.rules.1.id': 'admin-disabled' },
      ['applicationGate.rules.1.id: duplicate id admin-disabled'],
    ],
    [
      'a gate rule source whose lines run backwards',
      { 'applicationGate.rules.0.source.lines': [431, 428] },
      ['applicationGate.rules.0.source.lines: start line must not exceed end line'],
    ],
    [
      'a denial default without its authenticated outcome',
      { 'denialDefault.authenticated': DROP },
      [`denialDefault.authenticated: ${NO_STRING}`],
    ],
    [
      'an override id without an action',
      { 'overrides.0.id': 'role:carch' },
      [
        'overrides.0.id: must be role:<circuit>.<action> or role:<circuit>.*',
        'overrides.0.id: must equal role:<circuit>.<action>',
      ],
    ],
    [
      'an override id naming another action',
      { 'overrides.0.action': 'delete' },
      ['overrides.0.id: must equal role:<circuit>.<action>'],
    ],
    [
      'the m:X placeholder in an override role',
      { 'overrides.0.requiredRole': 'm:X' },
      [`overrides.0.requiredRole: ${ROLE_MESSAGE}`],
    ],
    ['an empty anyOf', { 'overrides.0.requiredRole': { anyOf: [] } }, [`overrides.0.requiredRole.anyOf: ${NO_ITEMS}`]],
    ['an empty allOf', { 'overrides.1.requiredRole': { allOf: [] } }, [`overrides.1.requiredRole.allOf: ${NO_ITEMS}`]],
    [
      'anyOf and allOf in one role',
      { 'overrides.0.requiredRole': { anyOf: ['s2'], allOf: ['s2'] } },
      [`overrides.0.requiredRole: ${ROLE_MESSAGE}`],
    ],
    ['an empty siteFrom list', { 'overrides.1.siteFrom': [] }, [`overrides.1.siteFrom: ${NO_ITEMS}`]],
    ['an empty siteFrom string', { 'overrides.1.siteFrom': '' }, ['overrides.1.siteFrom: Invalid input']],
    ['an empty condition list', { 'overrides.1.when': [] }, [`overrides.1.when: ${NO_ITEMS}`]],
    [
      'a condition scope outside the gate scopes',
      { 'overrides.1.when.0.on': 'header' },
      [`overrides.1.when.0.on: ${GATE_SCOPES}`],
    ],
    [
      'an unknown key on a condition',
      { 'overrides.1.when.0.effect': 'deny' },
      ['overrides.1.when.0: Unrecognized key: "effect"'],
    ],
    [
      'no node verdicts',
      { 'overrides.0.nodePermission.verdicts': [] },
      [`overrides.0.nodePermission.verdicts: ${NO_ITEMS}`],
    ],
    [
      'a node verdict outside editor, author, read, deny and none',
      { 'overrides.0.nodePermission.verdicts': ['owner'] },
      [
        'overrides.0.nodePermission.verdicts.0: Invalid option: expected one of "editor"|"author"|"read"|"deny"|"none"',
      ],
    ],
    [
      'an unknown key on a node permission',
      { 'overrides.0.nodePermission.inherit': true },
      ['overrides.0.nodePermission: Unrecognized key: "inherit"'],
    ],
    ['an empty denial', { 'overrides.1.denial': '' }, [`overrides.1.denial: ${NO_CHARACTERS}`]],
    ['an override without a reason', { 'overrides.0.reason': DROP }, [`overrides.0.reason: ${NO_STRING}`]],
    [
      'an override gate outside the repository',
      { 'overrides.0.gate.path': '../admin/core/controllers/carch.cfc' },
      [`overrides.0.gate.path: ${PATH_MESSAGE}`],
    ],
    [
      'an override id repeated in another case',
      { 'overrides.2': { ...carchUpdate(), id: 'ROLE:CArch.Update' } },
      ['overrides.2.id: duplicate id ROLE:CArch.Update'],
    ],
  ])('rejects a document with %s', (_label, edits, expected) => {
    expect(roleIssues(edits)).toEqual(expected);
  });
});

describe('parseWriterOverrides', () => {
  it('accepts the minimal document and returns each writer with its own table source', () => {
    const doc = parseWriterOverrides(stringify(writerDocument()), LABEL);
    expect(doc.sourceSha).toBe(SHA);
    expect(doc.writers.map((w) => [w.id, w.tables, w.tablesFrom])).toEqual([
      ['wov:scheduler-registration', undefined, { job: 'job:sitemonitor' }],
      ['wov:login-lastlogin', ['tusers'], undefined],
      ['wov:remember-me-login', ['tusers'], undefined],
      ['wov:ctrash-restore-object-save', [], undefined],
      ['wov:fixture-survey-tasks', ['synthetic.survey', 'synthetic.survey_reminder'], undefined],
    ]);
    expect(doc.writers[0]?.method).toBeNull();
  });

  it.each<[string, Edits]>([
    ['no writers', { writers: [] }],
    ['a dynamic request writer with no route keys', { 'writers.3.routeKeys': [] }],
    ['a request writer with both route keys and an entryScope', { 'writers.2.routeKeys': ['admin:clogin.login'] }],
    ['a scheduler writer with no route keys', { 'writers.4.routeKeys': [] }],
    [
      'a thread writer prevented by its validator',
      { 'writers.4.trigger': 'thread', 'writers.4.preventedBy': 'fixture-export-threads' },
    ],
    ['a dynamic writer that still names a table', { 'writers.3.tables': ['ttrash'] }],
    ['a logout session effect', { 'writers.1.sessionEffects': 'logout' }],
    ['a sourceSha other than the pinned one', { sourceSha: OTHER_SHA }],
  ])('accepts a document with %s', (_label, edits) => {
    expect(() => parseWriterOverrides(stringify(edit(writerDocument(), edits)), LABEL)).not.toThrow();
  });

  it.each<[string, Edits, string[]]>([
    ['an unknown top-level key', { owner: 'people' }, ['Unrecognized key: "owner"']],
    ['an unknown key on a writer', { 'writers.1.owner': 'people' }, ['writers.1: Unrecognized key: "owner"']],
    [
      'a writer id with an underscore',
      { 'writers.1.id': 'wov:login_lastlogin' },
      ['writers.1.id: must be wov:<lower-case slug>'],
    ],
    [
      'a writer id without the wov: prefix',
      { 'writers.1.id': 'login-lastlogin' },
      ['writers.1.id: must be wov:<lower-case slug>'],
    ],
    [
      'both tables and tablesFrom',
      { 'writers.0.tables': ['tsettings'] },
      ['writers.0.tables: exactly one of tables or tablesFrom is required'],
    ],
    [
      'neither tables nor tablesFrom',
      { 'writers.1.tables': DROP },
      ['writers.1.tables: exactly one of tables or tablesFrom is required'],
    ],
    [
      'no table on a writer that is not dynamic',
      { 'writers.1.tables': [] },
      ['writers.1.tables: must list a table unless dynamic is true'],
    ],
    [
      'no table on a writer whose dynamic flag is false',
      { 'writers.3.dynamic': false },
      ['writers.3.tables: must list a table unless dynamic is true'],
    ],
    [
      'an upper-case table name',
      { 'writers.1.tables': ['tUsers'] },
      ['writers.1.tables.0: must be a lower-cased legacy table name'],
    ],
    [
      'a doubly qualified table name',
      { 'writers.4.tables': ['dbo.synthetic.survey'] },
      ['writers.4.tables.0: must be a lower-cased legacy table name'],
    ],
    ['an empty tablesFrom job', { 'writers.0.tablesFrom.job': '' }, [`writers.0.tablesFrom.job: ${NO_CHARACTERS}`]],
    ['an empty column list', { 'writers.1.columns': [] }, [`writers.1.columns: ${NO_ITEMS}`]],
    [
      'a component path with backslashes',
      { 'writers.1.component': 'core\\mura\\user\\userUtility.cfc' },
      [`writers.1.component: ${PATH_MESSAGE}`],
    ],
    ['no method key rather than a null method', { 'writers.1.method': DROP }, [`writers.1.method: ${NO_STRING}`]],
    [
      'an op outside the writer ops',
      { 'writers.1.op': 'upsert' },
      ['writers.1.op: Invalid option: expected one of "insert"|"update"|"delete"|"save"|"schedule"'],
    ],
    [
      'a trigger outside request, scheduler, thread and appstart',
      { 'writers.0.trigger': 'cron' },
      ['writers.0.trigger: Invalid option: expected one of "request"|"scheduler"|"thread"|"appstart"'],
    ],
    [
      'a session effect outside none, login, logout and relogin',
      { 'writers.1.sessionEffects': 'logoff' },
      ['writers.1.sessionEffects: Invalid option: expected one of "none"|"login"|"logout"|"relogin"'],
    ],
    [
      'a preventedBy outside the cut-over validators',
      { 'writers.0.preventedBy': 'manual' },
      [
        'writers.0.preventedBy: Invalid option: expected one of "scheduler-registration"|"native-sitemonitor-task"|' +
          '"startup-url-conversion"|"fixture-survey-tasks"|"fixture-export-threads"',
      ],
    ],
    [
      'a preventedBy on a request writer',
      { 'writers.1.preventedBy': 'scheduler-registration' },
      ['writers.1.preventedBy: only writers whose trigger is not request'],
    ],
    [
      'a request writer with no route keys, not dynamic and no entryScope',
      { 'writers.1.routeKeys': [] },
      [`writers.1.routeKeys: ${ROUTE_KEYS_MESSAGE}`],
    ],
    [
      'a request writer without route keys that loses its entryScope',
      { 'writers.2.entryScope': DROP },
      [`writers.2.routeKeys: ${ROUTE_KEYS_MESSAGE}`],
    ],
    [
      'a request writer without route keys whose dynamic flag is false',
      { 'writers.3.routeKeys': [], 'writers.3.dynamic': false, 'writers.3.tables': ['ttrash'] },
      [`writers.3.routeKeys: ${ROUTE_KEYS_MESSAGE}`],
    ],
    ['an empty keyScope list', { 'writers.4.keyScope': [] }, [`writers.4.keyScope: ${NO_ITEMS}`]],
    ['a keyScope word other than table', { 'writers.1.keyScope': 'row' }, ['writers.1.keyScope: Invalid input']],
    [
      'an entryScope without families',
      { 'writers.2.entryScope.families': [] },
      [`writers.2.entryScope.families: ${NO_ITEMS}`],
    ],
    [
      'a non-boolean dynamic flag',
      { 'writers.3.dynamic': 'yes' },
      ['writers.3.dynamic: Invalid input: expected boolean, received string'],
    ],
    [
      'a source whose lines start at zero',
      { 'writers.1.source.lines': [0, 370] },
      ['writers.1.source.lines.0: Too small: expected number to be >=1'],
    ],
    [
      'a duplicate writer id',
      { 'writers.2.id': 'wov:login-lastlogin' },
      ['writers.2.id: duplicate id wov:login-lastlogin'],
    ],
  ])('rejects a document with %s', (_label, edits, expected) => {
    expect(writerIssues(edits)).toEqual(expected);
  });
});

describe('parseWriterOverrides settled calls', () => {
  const COUNTED_BY = 'required when resolution is counted and forbidden otherwise';

  /** The minimal writer document with one settled call of each resolution. */
  function settledDocument(): Record<string, unknown> {
    return {
      ...writerDocument(),
      settledCalls: [
        {
          id: 'wov:carch-edit-script',
          source: ref('admin/core/views/carch/edit.cfm', 659, 700),
          calls: ['document.createElement'],
          resolution: 'not-cfml',
          reason: 'The calls are JavaScript the template writes to the page.',
        },
        {
          id: 'wov:recaptcha-verify',
          source: ref('core/mura/reCAPTCHA.cfc', 124, 124),
          calls: ['httpSvc.send'],
          resolution: 'non-write',
          reason: 'The call posts the response token to the reCAPTCHA service.',
        },
        {
          id: 'wov:dbutility-nuodb-oracle',
          source: ref('core/mura/dbUtility.cfc', 523, 595),
          calls: ['update #arguments.table#'],
          resolution: 'unreachable',
          reason: 'The nuodb and oracle cases of the dbtype switch cannot run on the mssql installation.',
        },
        {
          id: 'wov:userbean-address-save',
          source: ref('core/mura/user/userBean.cfc', 574, 574),
          calls: ['address.save'],
          resolution: 'counted',
          countedBy: ['tuseraddresses'],
          reason: 'addressBean.save writes through userManager.createAddress or updateAddress.',
        },
      ],
    };
  }

  function settledIssues(edits: Edits): readonly string[] {
    return overrideError(() => parseWriterOverrides(stringify(edit(settledDocument(), edits)), LABEL)).issues;
  }

  it('keeps settledCalls optional and returns each settled call with its keys in schema order', () => {
    expect(parseWriterOverrides(stringify(writerDocument()), LABEL).settledCalls).toBeUndefined();
    const doc = parseWriterOverrides(stringify(settledDocument()), LABEL);
    expect(doc.settledCalls?.map((s) => [s.id, s.resolution, s.countedBy])).toEqual([
      ['wov:carch-edit-script', 'not-cfml', undefined],
      ['wov:recaptcha-verify', 'non-write', undefined],
      ['wov:dbutility-nuodb-oracle', 'unreachable', undefined],
      ['wov:userbean-address-save', 'counted', ['tuseraddresses']],
    ]);
    expect(Object.keys(doc.settledCalls?.[3] ?? {})).toEqual([
      'id',
      'source',
      'calls',
      'resolution',
      'countedBy',
      'reason',
    ]);
  });

  it.each<[string, Edits, string[]]>([
    [
      'a counted settlement without countedBy',
      { 'settledCalls.3.countedBy': DROP },
      [`settledCalls.3.countedBy: ${COUNTED_BY}`],
    ],
    [
      'countedBy on a non-write settlement',
      { 'settledCalls.1.countedBy': ['tusers'] },
      [`settledCalls.1.countedBy: ${COUNTED_BY}`],
    ],
    ['an empty countedBy list', { 'settledCalls.3.countedBy': [] }, [`settledCalls.3.countedBy: ${NO_ITEMS}`]],
    [
      'an unknown resolution',
      { 'settledCalls.0.resolution': 'ignored' },
      ['settledCalls.0.resolution: Invalid option: expected one of "not-cfml"|"non-write"|"unreachable"|"counted"'],
    ],
    [
      'an unknown key on a settled call',
      { 'settledCalls.2.owner': 'people' },
      ['settledCalls.2: Unrecognized key: "owner"'],
    ],
    ['an empty calls list', { 'settledCalls.0.calls': [] }, [`settledCalls.0.calls: ${NO_ITEMS}`]],
    ['an empty call text', { 'settledCalls.0.calls': [''] }, [`settledCalls.0.calls.0: ${NO_CHARACTERS}`]],
    ['no reason', { 'settledCalls.1.reason': DROP }, [`settledCalls.1.reason: ${NO_STRING}`]],
    [
      'a settled-call id without the wov: prefix',
      { 'settledCalls.1.id': 'recaptcha-verify' },
      ['settledCalls.1.id: must be wov:<lower-case slug>'],
    ],
    [
      'a settled-call id shared with a writer',
      { 'settledCalls.1.id': 'wov:login-lastlogin' },
      ['settledCalls.1.id: duplicate id wov:login-lastlogin'],
    ],
    [
      'a duplicate settled-call id',
      { 'settledCalls.2.id': 'wov:carch-edit-script' },
      ['settledCalls.2.id: duplicate id wov:carch-edit-script'],
    ],
  ])('rejects a document with %s', (_label, edits, expected) => {
    expect(settledIssues(edits)).toEqual(expected);
  });
});

describe.each([
  { name: 'parseRoleOverrides', parse: parseRoleOverrides },
  { name: 'parseWriterOverrides', parse: parseWriterOverrides },
])('$name input handling', ({ parse }) => {
  it('reports malformed YAML as an OverrideError naming the source label, with the parser error as cause', () => {
    const error = overrideError(() => parse('sourceSha: [\n', LABEL));
    expect(error.path).toBe(LABEL);
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatch(/^is not valid YAML: /);
    expect(error.message).toBe(`override file ${LABEL}: ${error.issues[0]}`);
    expect(error.cause).toBeInstanceOf(YAMLParseError);
  });

  it('reports a repeated mapping key as malformed YAML', () => {
    expect(overrideError(() => parse(`sourceSha: ${SHA}\nsourceSha: ${SHA}\n`, LABEL)).issues[0]).toMatch(
      /^is not valid YAML: Map keys must be unique/,
    );
  });

  it.each<[string, string, string]>([
    ['an empty file', '', 'Invalid input: expected object, received null'],
    ['a list', '- P0\n', 'Invalid input: expected object, received array'],
    ['a scalar', '42\n', 'Invalid input: expected object, received number'],
  ])('reports %s, which is not a mapping, without a path prefix', (_label, text, expected) => {
    const error = overrideError(() => parse(text, LABEL));
    expect(error.issues).toEqual([expected]);
    expect(error.cause).toBeInstanceOf(z.ZodError);
  });
});

describe('OverrideError', () => {
  it('joins every issue after the path and keeps path, issues and cause', () => {
    const cause = new Error('root cause');
    const error = new OverrideError('/x/role-overrides.yaml', ['a: first', 'second'], { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('OverrideError');
    expect(error.message).toBe('override file /x/role-overrides.yaml: a: first; second');
    expect(error.path).toBe('/x/role-overrides.yaml');
    expect(error.issues).toEqual(['a: first', 'second']);
    expect(error.cause).toBe(cause);
  });

  it('carries every schema issue of a document in one message', () => {
    const edits = { 'writers.1.op': 'upsert', 'writers.2.trigger': 'cron' };
    const error = overrideError(() => parseWriterOverrides(stringify(edit(writerDocument(), edits)), LABEL));
    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe(`override file ${LABEL}: ${error.issues.join('; ')}`);
  });
});

describe.each([
  { name: 'loadRoleOverrides', load: loadRoleOverrides, document: roleDocument, schema: roleOverridesSchema },
  { name: 'loadWriterOverrides', load: loadWriterOverrides, document: writerDocument, schema: writerOverridesSchema },
])('$name(path)', ({ load, document, schema }) => {
  it('loads a document stamped with the pinned SHA from the given path', async () => {
    const file = await tempFile(stringify(document()));
    await expect(load(file)).resolves.toMatchObject({ sourceSha: SHA });
  });

  it('rejects a document stamped with another SHA, naming both SHAs, although the schema accepts it', async () => {
    const other = edit(document(), { sourceSha: OTHER_SHA });
    expect(schema.safeParse(other).success).toBe(true);
    const file = await tempFile(stringify(other));
    const error: unknown = await load(file).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OverrideError);
    expect(error).toMatchObject({
      path: file,
      issues: [`sourceSha: ${OTHER_SHA} does not match the pinned source SHA ${SHA}`],
    });
  });

  it('reports schema failures under the file path before checking the pin', async () => {
    const file = await tempFile(stringify(edit(document(), { sourceSha: OTHER_SHA, stray: true })));
    await expect(load(file)).rejects.toMatchObject({ path: file, issues: ['Unrecognized key: "stray"'] });
  });

  it('reports malformed YAML under the file path', async () => {
    const file = await tempFile('writers: [\n');
    const error: unknown = await load(file).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OverrideError);
    expect((error as OverrideError).path).toBe(file);
    expect((error as OverrideError).issues[0]).toMatch(/^is not valid YAML: /);
  });

  it('rejects a missing file with a cannot-be-read OverrideError carrying the read error', async () => {
    const file = path.join(dir, 'absent', 'overrides.yaml');
    const error: unknown = await load(file).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OverrideError);
    expect((error as OverrideError).path).toBe(file);
    expect((error as OverrideError).issues).toEqual([expect.stringMatching(/^cannot be read: ENOENT/)]);
    expect((error as OverrideError).cause).toMatchObject({ code: 'ENOENT' });
  });
});
