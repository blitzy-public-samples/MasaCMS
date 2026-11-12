import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EquivalenceImpossible,
  GoldenConfigError,
  MissingSecretError,
  haltEvidence,
  haltedExceptionEntry,
  isEquivalenceImpossible,
  type EquivalenceImpossibleOptions,
  type ExceptionEntry,
} from '../../src/golden/errors.js';
import { SEED_CREDENTIALS_FILE, createScenarioContext, resolvePlaceholders } from '../../src/golden/session.js';
import { pinnedSha } from '../../src/lib/pin.js';

const SCENARIO = 'GS-CO-07';
const ROUTE_KEY = 'admin:carch.update{upload=image}';
const REASON = 'image renditions come from the ColdFusion image engine';
const PLACEHOLDER = '${secret:seed:FIXTURE-user}';

function caseOptions(overrides: Partial<EquivalenceImpossibleOptions> = {}): EquivalenceImpossibleOptions {
  return { scenario: SCENARIO, routeKey: ROUTE_KEY, reason: REASON, evidence: haltEvidence(SCENARIO), ...overrides };
}

/** Stand-in for EquivalenceImpossible loaded from a second copy of the module. */
class ForeignEquivalenceImpossible extends Error {
  override readonly name: string = 'EquivalenceImpossible';
}

describe('haltEvidence', () => {
  it.each(['GS-ID-01', 'GS-CO-05', 'GS-PE-RH-02'])('builds repository- and state-relative paths for %s', (id) => {
    const evidence = haltEvidence(id);
    expect(evidence).toStrictEqual({
      golden: `harness/golden/sets/${id}.json`,
      replay: `\${OPT2_STATE_DIR}/golden/replay/${id}.json`,
    });
    for (const p of [evidence.golden, evidence.replay]) {
      expect(path.isAbsolute(p)).toBe(false);
      expect(p).not.toContain(os.homedir());
    }
  });
});

describe('EquivalenceImpossible', () => {
  it.each([
    ['without an observed difference', undefined],
    ['with an observed difference', 'body sha256 differs on _small'],
  ])('is an Error carrying the case fields %s, with a message of scenario, route key and reason', (_label, difference) => {
    const err = new EquivalenceImpossible(caseOptions({ difference }));
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EquivalenceImpossible);
    expect(err.name).toBe('EquivalenceImpossible');
    expect(err.message).toBe(`${SCENARIO} ${ROUTE_KEY}: ${REASON}`);
    expect(String(err)).toBe(`EquivalenceImpossible: ${SCENARIO} ${ROUTE_KEY}: ${REASON}`);
    expect(err.scenario).toBe(SCENARIO);
    expect(err.routeKey).toBe(ROUTE_KEY);
    expect(err.reason).toBe(REASON);
    expect(err.evidence).toStrictEqual(haltEvidence(SCENARIO));
    expect(err.difference).toBe(difference);
  });
});

describe('isEquivalenceImpossible', () => {
  it.each([
    { label: 'an EquivalenceImpossible', value: new EquivalenceImpossible(caseOptions()), expected: true },
    { label: 'an Error named EquivalenceImpossible from another module copy', value: new ForeignEquivalenceImpossible('x'), expected: true },
    { label: 'a plain Error', value: new Error('x'), expected: false },
    { label: 'a TypeError', value: new TypeError('x'), expected: false },
    { label: 'a GoldenConfigError', value: new GoldenConfigError('x'), expected: false },
    { label: 'a MissingSecretError', value: new MissingSecretError(PLACEHOLDER, 'FIXTURE_ENV'), expected: false },
    { label: 'a non-Error object with the name', value: { name: 'EquivalenceImpossible', message: 'x' }, expected: false },
    { label: 'a plain copy of the case fields', value: { ...new EquivalenceImpossible(caseOptions()) }, expected: false },
    { label: 'an empty object', value: {}, expected: false },
    { label: 'the name as a string', value: 'EquivalenceImpossible', expected: false },
    { label: 'null', value: null, expected: false },
    { label: 'undefined', value: undefined, expected: false },
  ])('is $expected for $label', ({ value, expected }) => {
    expect(isEquivalenceImpossible(value)).toBe(expected);
  });

  it('narrows a caught value to its case fields', () => {
    let caught: unknown;
    try {
      throw new EquivalenceImpossible(caseOptions());
    } catch (error) {
      caught = error;
    }
    expect(isEquivalenceImpossible(caught) ? caught.scenario : undefined).toBe(SCENARIO);
  });
});

describe('haltedExceptionEntry', () => {
  it('reads a 40-character lowercase hex SHA from opt2/source-pin.json', () => {
    expect(pinnedSha()).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([
    ['the reason when no difference was observed', undefined, REASON],
    ['the observed difference', 'status 200 against 500', 'status 200 against 500'],
  ])('records a halted preserve entry whose difference is %s', (_label, difference, expected) => {
    const sha = pinnedSha();
    const err = new EquivalenceImpossible(caseOptions({ difference }));
    const entry = haltedExceptionEntry(err, { id: 'EX-TEST-01', sourceSha: sha });
    expect(entry).toStrictEqual<ExceptionEntry>({
      id: 'EX-TEST-01',
      scenario: SCENARIO,
      routeKey: ROUTE_KEY,
      difference: expected,
      decision: 'preserve',
      reason: REASON,
      status: 'halted',
      evidence: haltEvidence(SCENARIO),
      sourceSha: sha,
    });
    expect(entry).not.toHaveProperty('appliesTo');
  });

  it("copies the evidence rather than sharing the error's object", () => {
    const err = new EquivalenceImpossible(caseOptions());
    const entry = haltedExceptionEntry(err, { id: 'EX-1', sourceSha: pinnedSha() });
    expect(entry.evidence).not.toBe(err.evidence);
    entry.evidence.replay = 'changed';
    expect(err.evidence).toStrictEqual(haltEvidence(SCENARIO));
  });

  it('round-trips through JSON unchanged', () => {
    const entry = haltedExceptionEntry(new EquivalenceImpossible(caseOptions()), { id: 'EX-1', sourceSha: pinnedSha() });
    expect(JSON.parse(JSON.stringify(entry))).toStrictEqual(entry);
  });
});

describe('GoldenConfigError', () => {
  const message = 'catalogue.yaml: duplicate scenario id GS-ID-01';
  const at = 'harness/golden/catalogue.yaml#/scenarios/3';

  it.each<{ label: string; opts?: { path?: string; cause?: unknown }; path?: string; hasCause: boolean }>([
    { label: 'no options', hasCause: false },
    { label: 'empty options', opts: {}, hasCause: false },
    { label: 'an undefined cause', opts: { cause: undefined }, hasCause: false },
    { label: 'a path', opts: { path: at }, path: at, hasCause: false },
    { label: 'a path and an Error cause', opts: { path: at, cause: new RangeError('ENOENT') }, path: at, hasCause: true },
    { label: 'a string cause', opts: { cause: 'bad indentation' }, hasCause: true },
    { label: 'a null cause', opts: { cause: null }, hasCause: true },
    { label: 'a zero cause', opts: { cause: 0 }, hasCause: true },
  ])('keeps the message exactly, given $label', ({ opts, path: expectedPath, hasCause }) => {
    const err = new GoldenConfigError(message, opts);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GoldenConfigError');
    expect(err.message).toBe(message);
    expect(String(err)).toBe(`GoldenConfigError: ${message}`);
    expect(err.path).toBe(expectedPath);
    expect('cause' in err).toBe(hasCause);
    expect(err.cause).toBe(opts?.cause);
  });
});

describe('MissingSecretError', () => {
  it.each([
    ['an environment variable', 'FIXTURE_SEED_PASSWORDS'],
    ['a file', path.join(os.tmpdir(), 'FIXTURE-state', 'secrets', 'seed.json')],
  ])('names the placeholder and %s it searched', (_label, source) => {
    const err = new MissingSecretError(PLACEHOLDER, source);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MissingSecretError');
    expect(err.placeholder).toBe(PLACEHOLDER);
    expect(err.source).toBe(source);
    expect(err.message).toBe(`Secret ${PLACEHOLDER} has no unique value in ${source}`);
  });

  it('exposes only the placeholder and source, never a candidate value', () => {
    const candidates = ['FIXTURE-candidate-value-a', 'FIXTURE-candidate-value-b'];
    const err = new MissingSecretError(PLACEHOLDER, 'FIXTURE_SEED_PASSWORDS');
    const renderings = [err.message, err.stack ?? '', String(err), JSON.stringify(err), inspect(err, { showHidden: true, depth: null })];
    for (const text of renderings) {
      for (const candidate of candidates) {
        expect(text).not.toContain(candidate);
      }
    }
    expect(JSON.parse(JSON.stringify(err))).toStrictEqual({
      name: 'MissingSecretError',
      placeholder: PLACEHOLDER,
      source: 'FIXTURE_SEED_PASSWORDS',
    });
  });

  describe('raised while resolving a scenario value', () => {
    const adminPassword = 'FIXTURE-ADMIN-PASSWORD';
    const editorPassword = 'FIXTURE-EDITOR-PASSWORD';
    let stateDir: string;

    beforeEach(async () => {
      stateDir = await mkdtemp(path.join(os.tmpdir(), 'opt2-golden-errors-'));
    });

    afterEach(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    it('names the missing seed placeholder and leaks no secret already resolved', () => {
      const env = {
        MURA_ADMIN_PASSWORD: adminPassword,
        MASA_TEST_EDITOR_PASSWORD: editorPassword,
        OPT2_STATE_DIR: stateDir,
      };
      const ctx = createScenarioContext({ id: SCENARIO }, { origin: 'gateway', env });
      const value = {
        form: { username: 'admin', password: '${secret:admin}', confirm: '${secret:admin}/${secret:seed:nobody}' },
      };

      let caught: unknown;
      try {
        resolvePlaceholders(value, ctx);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(MissingSecretError);
      const err = caught as MissingSecretError;
      expect(err.placeholder).toBe('${secret:seed:nobody}');
      expect(err.source).toBe(path.join(stateDir, 'secrets', SEED_CREDENTIALS_FILE));
      expect(err.message).toContain('${secret:seed:nobody}');
      expect(ctx.secrets.values()).toContain(adminPassword);
      for (const text of [err.message, err.stack ?? '', String(err), JSON.stringify(err)]) {
        for (const password of [adminPassword, editorPassword]) {
          expect(text).not.toContain(password);
        }
      }
      expect(fs.existsSync(path.join(stateDir, 'secrets'))).toBe(false);
    });
  });
});
