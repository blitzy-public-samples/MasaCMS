import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { REDACTED, createLogger, validateLogRecord, type Logger } from '@opt2/platform/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoldenSet, GoldenStep } from '../../src/golden/capture.js';
import { FIXTURES_UNAVAILABLE, scenarioSchema, type Scenario } from '../../src/golden/catalogue.js';
import { RULES_PATH, loadRules } from '../../src/golden/normalise/rules.js';
import { replayOutputPath, replayScenario, sessionStatePath, type ReplayDeps } from '../../src/golden/replay.js';
import type { FetchLike } from '../../src/lib/http.js';
import { pinnedSha } from '../../src/lib/pin.js';

// Assembled at run time so secret scanning does not read it as a credential.
const SECRET = ['logging', 'fixture', 'value'].join('-');
const MAILPIT = 'http://127.0.0.1:18026';
const GATEWAY = 'http://127.0.0.1:18100';
const BROWSER_MESSAGE = 'GS-ID-02: browser flow admin-login, replayed by harness/e2e/ui/interactions.e2e.ts';
const BROWSER = { id: 'GS-ID-02', service: 'identity', steps: [], browser: { flow: 'admin-login', console: 'no-new-errors' } };
/** Scenario fields of a crossing whose transition precedes step `after`. */
const CROSSING = {
  steps: [
    { name: 'read', route: '/index.cfm/' },
    { name: 'after', route: '/index.cfm/' },
  ],
  acrossTransition: [{ before: 'after', from: 'v0001', to: 'v0002' }],
};

/** A logger whose log-record.v1 lines are collected in memory. */
function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { logger: createLogger({ service: 'test', version: '1', env: 'local', destination }), lines };
}

/** Parsed lines, each asserted valid against log-record.v1. */
function records(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(validateLogRecord(record)).toEqual({ valid: true, errors: [] });
    return record;
  });
}

function scenario(over: Record<string, unknown> = {}): Scenario {
  return scenarioSchema.parse({
    id: 'GS-CO-15',
    title: 'Logging fixture',
    service: 'strategies-content',
    role: 'admin',
    sessions: { default: { login: 'none', via: 'admin' } },
    steps: [{ name: 'read', route: '/index.cfm/' }],
    compare: ['status'],
    covers: [],
    ...over,
  });
}

describe('replayScenario logging', () => {
  let root: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'golden-logging-'));
    env = { OPT2_STATE_DIR: path.join(root, 'state'), PORT: '8500', MURA_ADMIN_PASSWORD: SECRET };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function deps(over: Partial<ReplayDeps> = {}): ReplayDeps {
    return {
      rules: loadRules(RULES_PATH, env),
      fixtures: { available: true, reason: null },
      sourceSha: pinnedSha(),
      tableVersion: 'v0002',
      env,
      ...over,
    };
  }

  function golden(id: string): GoldenSet {
    return {
      sourceSha: pinnedSha(),
      scenarioId: id,
      capturedAt: '2026-11-13T00:00:00.000Z',
      origin: 'legacy',
      tableVersion: null,
      fixtures: { available: true, reason: null },
      steps: [],
      sideEffects: { mail: [], rows: {}, tasks: [], files: [] },
    };
  }

  it.each<[string, Record<string, unknown>, ReplayDeps['fixtures'], string, string]>([
    [
      'a fixture-dependent scenario without fixtures',
      { fixtures: 'required' },
      { available: false, reason: 'no CREATE SCHEMA' },
      'skipped',
      `GS-CO-15: ${FIXTURES_UNAVAILABLE}`,
    ],
    ['a browser scenario', BROWSER, { available: true, reason: null }, 'browser', BROWSER_MESSAGE],
  ])('logs %s as one INFO line', async (_label, over, fixtures, status, message) => {
    const { logger, lines } = collectingLogger();
    const result = await replayScenario(scenario(over), deps({ fixtures, logger }));
    expect(result.status).toBe(status);
    expect(records(lines)).toEqual([expect.objectContaining({ severity: 'INFO', message })]);
  });

  it('logs a scenario already resumed after its transition as one INFO line', async () => {
    const crossing = scenario(CROSSING);
    const state = sessionStatePath(crossing.id, env);
    await mkdir(path.dirname(state), { recursive: true });
    const saved = {
      sourceSha: pinnedSha(),
      scenarioId: crossing.id,
      savedAt: '2026-11-13T00:00:00.000Z',
      tableVersion: 'v0001',
      nextIndex: 1,
      completed: true,
      jars: {},
      bindings: [],
      records: [],
    };
    await writeFile(state, JSON.stringify(saved), 'utf8');
    const { logger, lines } = collectingLogger();

    const result = await replayScenario(crossing, deps({ logger, readGolden: async (id) => golden(id) }));

    expect(result.status).toBe('resumed-earlier');
    const message = `GS-CO-15: already resumed after its transition; ${replayOutputPath(crossing.id, env)} stands`;
    expect(records(lines)).toEqual([expect.objectContaining({ severity: 'INFO', message })]);
  });

  interface StepCase {
    answer: 'throw' | 200;
    gap?: GoldenStep['gap'];
    over?: Record<string, unknown>;
    phase?: 'pre-transition';
  }

  it.each<[string, StepCase, Record<string, unknown>[]]>([
    [
      'a step that fails as one ERROR line',
      { answer: 'throw' },
      [{ severity: 'ERROR', message: 'GS-CO-15: failed at read, 0 exchanges, 0 halted' }],
    ],
    [
      'a halted case as a WARNING line before the INFO outcome',
      { gap: { reason: 'no candidate matched', candidatesTried: 1 }, answer: 200 },
      [
        { severity: 'WARNING', message: expect.stringMatching(/^GS-CO-15 step read: halted \(no candidate matched\); EX-HALT-/) },
        { severity: 'INFO', message: 'GS-CO-15: replayed, 1 exchanges, 1 halted' },
      ],
    ],
    [
      'a pause at a transition as one INFO line',
      { answer: 200, over: CROSSING, phase: 'pre-transition' },
      [{ severity: 'INFO', message: expect.stringMatching(/^GS-CO-15: paused before step after; sessions saved to \/.*GS-CO-15\.json$/) }],
    ],
  ])('logs %s', async (_label, { gap, answer, over, phase }, expected) => {
    const exceptionsPath = path.join(root, 'exceptions-list.json');
    await writeFile(exceptionsPath, JSON.stringify({ sourceSha: pinnedSha(), entries: [] }), 'utf8');
    const fetch: FetchLike = async (input, init) => {
      if (new URL(input).origin === MAILPIT) {
        return Response.json(init.method === 'DELETE' ? {} : { total: 0, messages: [] });
      }
      if (answer === 'throw') throw new TypeError('fetch failed');
      return new Response('', { status: answer });
    };
    const step: GoldenStep = {
      name: 'read',
      index: 0,
      routeKey: 'api:content.findone',
      request: { method: 'GET', url: '/index.cfm/', headers: {}, body: { kind: 'none' } },
      response: { status: 200, headers: {}, body: '', rawSha256: '0'.repeat(64) },
      normalised: { name: 'read', index: 0, routeKey: 'api:content.findone', status: 200, maskedPaths: {} },
      ...(gap === undefined ? {} : { gap }),
    };
    const { logger, lines } = collectingLogger();
    env = { ...env, MAILPIT_API_URL: MAILPIT, OPT2_GATEWAY_URL: GATEWAY };
    const readGolden = async (id: string): Promise<GoldenSet> => ({ ...golden(id), steps: [step] });

    await replayScenario(scenario(over), deps({ logger, fetch, exceptions: { path: exceptionsPath }, readGolden }), phase);

    expect(records(lines)).toEqual(expected.map((line) => expect.objectContaining(line)));
  });

  it('logs a replay whose golden set cannot be read as one ERROR line with secrets masked', async () => {
    const { logger, lines } = collectingLogger();
    const readGolden = async (): Promise<GoldenSet> => {
      throw new Error(`golden set unreadable with ${SECRET}`);
    };

    const result = await replayScenario(scenario(), deps({ logger, readGolden }));

    expect(result.status).toBe('error');
    expect(lines.join('')).not.toContain(SECRET);
    const message = `GS-CO-15: replay failed: Error: golden set unreadable with ${REDACTED}`;
    expect(records(lines)).toEqual([expect.objectContaining({ severity: 'ERROR', message })]);
  });

  it('defaults to the harness-golden-replay logger on stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await replayScenario(scenario(BROWSER), deps());

    const written = stderr.mock.calls.map(([chunk]) => String(chunk));
    expect(records(written)).toEqual([
      expect.objectContaining({ severity: 'INFO', message: BROWSER_MESSAGE, service: 'harness-golden-replay', env: 'local' }),
    ]);
  });
});
