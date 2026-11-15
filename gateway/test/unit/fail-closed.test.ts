// Fail closed end to end: a callee that refuses, times out or answers 502/503/504 yields legacy's 503 and never reaches legacy.
// The fail-closed helpers themselves are covered case by case in dispatcher-fail-closed.test.ts.
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminUnavailableResponse, apiUnavailableResponse, type LegacyUnavailableResponse } from '@opt2/platform/legacy-compat';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import { BRIDGE_SESSION_PATH } from '../helpers/legacy-origin.js';
import type { TargetMode } from '../helpers/target-double.js';
import { cutoverTable, entry } from '../helpers/versions.js';
import type { CutoverTable } from '../../src/cutover/types.js';
import type { SessionMode } from '../../src/session/mode.js';

// Neither buildApp nor buildTestGateway takes a service-call timeout, and fake timers cannot drive undici's process-wide
// fast-timer clock once a real request has started it, so the platform's 10 s bound is shortened for this file.
vi.mock('@opt2/platform/service-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opt2/platform/service-kit')>()),
  SERVICE_CALL_TIMEOUT_MS: 1_000,
}));

/** Per-case budget below the platform's 10 s bound, so a hung callee fails the case if the shortened bound stops applying. */
const CASE_TIMEOUT_MS = 8_000;

/** Node's default 503 reason phrase, which the JSON API envelope keeps. */
const SERVICE_UNAVAILABLE_TEXT = 'Service Unavailable';

/** Callees the fixture version routes to. */
const OWNERS = ['strategies-content', 'web', 'stub'] as const;
type Owner = (typeof OWNERS)[number];

const FAILURE_MODES = ['refuse', 'timeout', '502', '503', '504'] as const satisfies readonly TargetMode[];
const SESSION_MODES = ['legacy-primary', 'target-primary'] as const satisfies readonly SessionMode[];

/** One target-bound request, its callee and the legacy 503 it must answer. */
interface FailCase {
  name: string;
  request: InjectOptions;
  owner: Owner;
  expected: LegacyUnavailableResponse;
}

const CASES: readonly FailCase[] = [
  {
    name: 'API read',
    request: { method: 'GET', url: '/_api/json/v1/default/content/abc' },
    owner: 'strategies-content',
    expected: apiUnavailableResponse({ method: 'findOne' }),
  },
  {
    name: 'API write',
    request: {
      method: 'POST',
      url: '/_api/json/v1/default/content/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'title=About&siteid=default',
    },
    owner: 'strategies-content',
    expected: apiUnavailableResponse({ method: 'save' }),
  },
  {
    name: 'admin page',
    request: { method: 'GET', url: '/admin/?muraAction=cPerm.main' },
    owner: 'web',
    expected: adminUnavailableResponse(),
  },
  {
    name: 'stub write',
    request: {
      method: 'POST',
      url: '/opt2/stub/notes',
      headers: { 'content-type': 'application/json' },
      payload: '{"body":"hello"}',
    },
    owner: 'stub',
    expected: apiUnavailableResponse(),
  },
];

/** The fixture version: every case's entry `target`; the login group's authority selects the session mode. */
function fixtureTable(sessionMode: SessionMode): CutoverTable {
  return cutoverTable({
    tableVersion: 'v0901',
    entries: [
      entry({ route: 'api:content.findone', owningService: 'strategies-content', state: 'target', kind: 'read' }),
      entry({
        route: 'api:content.save',
        owningService: 'strategies-content',
        state: 'target',
        kind: 'write',
        units: ['content.content'],
      }),
      entry({ route: 'admin:cperm.main', owningService: 'identity', state: 'target', kind: 'read' }),
      entry({ route: 'opt2:/opt2/stub/**', owningService: 'stub', state: 'target', kind: 'write' }),
      entry({
        route: 'admin:clogin.login',
        owningService: 'identity',
        state: sessionMode === 'target-primary' ? 'target' : 'legacy',
        kind: 'write',
        units: ['identity.login_state'],
      }),
    ],
  });
}

/** Headers of a legacy 503 keyed as light-my-request reports them. */
function lowerCased(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

describe('target-bound requests fail closed', () => {
  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  /** A gateway on the fixture version whose content owner, web and stub all fail as `mode`. */
  async function failingGateway(sessionMode: SessionMode, mode: TargetMode): Promise<TestGateway> {
    gateway = await buildTestGateway({ version: fixtureTable(sessionMode), services: ['strategies-content', 'stub'] });
    // Switched once every double listens, so a refusing callee's freed port cannot go to a double started beside it.
    await Promise.all(OWNERS.map((owner) => gateway?.targets[owner]?.setMode(mode)));
    return gateway;
  }

  describe.each(SESSION_MODES)('in %s mode', (sessionMode) => {
    it.each(FAILURE_MODES)(
      'answers every surface with the legacy 503 when its callee is in %s mode, never reaching legacy',
      { timeout: CASE_TIMEOUT_MS },
      async (mode) => {
        const { app, legacy, targets } = await failingGateway(sessionMode, mode);
        const results = await Promise.all(CASES.map(async (item) => ({ item, res: await app.inject(item.request) })));

        for (const { item, res } of results) {
          expect(res.statusCode, item.name).toBe(503);
          expect(res.statusMessage, item.name).toBe(item.expected.statusText ?? SERVICE_UNAVAILABLE_TEXT);
          expect(res.body, item.name).toBe(item.expected.body);
          expect(res.headers, item.name).toMatchObject(lowerCased(item.expected.headers));
        }
        // A status or a hung exchange reached its callee exactly once, so nothing was retried; a refusal reached none.
        const received = mode === 'refuse' ? 0 : 1;
        for (const owner of OWNERS) {
          const expected = CASES.filter((item) => item.owner === owner).length * received;
          expect(targets[owner]?.requests, owner).toHaveLength(expected);
        }
        // Both session modes describe the browser's legacy session through the bridge; the request itself never reaches legacy.
        expect(legacy.requests.filter((req) => req.path !== BRIDGE_SESSION_PATH)).toEqual([]);
      },
    );
  });
});
