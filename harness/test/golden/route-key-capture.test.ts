import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeKeyConflictCases } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureScenario, type CaptureDeps } from '../../src/golden/capture.js';
import { scenarioSchema, type Scenario, type Step } from '../../src/golden/catalogue.js';
import { coverageRouteKey, fromRouteKeyRequest } from '../../src/golden/coverage.js';
import { RULES_PATH, loadRules } from '../../src/golden/normalise/rules.js';
import { createScenarioContext } from '../../src/golden/session.js';
import { runScenarioSteps } from '../../src/golden/steps.js';
import type { FetchLike } from '../../src/lib/http.js';
import type { EnvLike } from '../../src/lib/paths.js';

// No listener on these ports; every request goes to the fake fetch.
const ORIGIN = 'http://127.0.0.1:8500';
const MAILPIT = 'http://127.0.0.1:8501';
const ID = 'A1B2C3D4-E5F6-7890-ABCDEF1234567890';
const IMAGE = { field: 'newfile', fixture: 'image-png-8x8', filename: 'pixel.png', contentType: 'image/png' };

interface KeyCase {
  label: string;
  step: Record<string, unknown>;
  key: string;
}

interface FakeOrigin {
  fetch: FetchLike;
  /** `<METHOD> <path?query>` of each request the origin received. */
  sent: string[];
}

let stateDir = '';

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'opt2-route-key-capture-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** Origin answering every request with a 200 HTML page, plus an empty Mailpit. */
function fakeOrigin(): FakeOrigin {
  const sent: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const { origin, pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    if (origin === MAILPIT && pathname === '/api/v1/messages') {
      return method === 'DELETE' ? new Response('ok') : Response.json({ total: 0, messages: [] });
    }
    if (origin !== ORIGIN) throw new Error(`unscripted request ${method} ${url}`);
    sent.push(`${method} ${pathname}${search}`);
    return new Response('<p>ok</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  return { fetch, sent };
}

function envFor(): EnvLike {
  return { PORT: '8500', OPT2_GATEWAY_URL: ORIGIN, MAILPIT_API_URL: MAILPIT, OPT2_STATE_DIR: stateDir };
}

function scenario(step: Record<string, unknown>): Scenario {
  return scenarioSchema.parse({
    id: 'GS-CO-15',
    title: 'Route-key fixture',
    service: 'strategies-content',
    role: 'admin',
    sessions: { default: { login: 'none', via: 'admin' } },
    steps: [step],
    compare: ['status'],
    covers: [],
  });
}

function captureDeps(fake: FakeOrigin, env: EnvLike): CaptureDeps {
  return {
    rules: loadRules(RULES_PATH, env),
    fixtures: { available: true, reason: null },
    sourceSha: 'FIXTURE-SHA',
    env,
    fetch: fake.fetch,
    log: () => undefined,
  };
}

/** `step` as one catalogue request: the runner sets the content type, and a multipart body carries the form fields. */
function sendable(step: Step): Record<string, unknown> {
  const { headers = {}, form, multipart, ...rest } = step;
  const kept = Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type');
  const out: Record<string, unknown> = { ...rest };
  if (kept.length > 0) out.headers = Object.fromEntries(kept);
  if (multipart !== undefined) {
    out.multipart = {
      fields: { ...form, ...multipart.fields },
      files: multipart.files.map((file) => ({ ...file, fixture: IMAGE.fixture })),
    };
  } else if (form !== undefined) {
    out.form = form;
  }
  return out;
}

const ROSTER_CREATE = {
  name: 'create',
  method: 'POST',
  route: `/admin/index.cfm?muraAction=cUsers.update&userid=${ID}`,
  form: { type: '2', action: 'Add', siteid: 'tenant-a', username: 'x' },
};

const VARIANT_CASES: KeyCase[] = [
  { label: 'a roster create', step: ROSTER_CREATE, key: 'admin:cusers.update{type=2,action=add}' },
  {
    label: 'a roster edit',
    step: {
      name: 'edit',
      method: 'POST',
      route: `/admin/index.cfm?muraAction=cUsers.update&userid=${ID}`,
      form: { type: '2', action: 'Update', siteid: 'tenant-a', username: 'x' },
    },
    key: 'admin:cusers.update{type=2,action=update}',
  },
  {
    label: 'a group save',
    step: {
      name: 'group',
      method: 'POST',
      route: '/admin/index.cfm?muraAction=cUsers.update',
      form: { type: '1', action: 'Update', groupname: 'x' },
    },
    key: 'admin:cusers.update{type=1}',
  },
  {
    label: 'a site add',
    step: { name: 'add', method: 'POST', route: '/admin/?muraAction=cSettings.updateSite', form: { action: 'Add' } },
    key: 'admin:csettings.updatesite{action=add}',
  },
  {
    label: 'a site delete',
    step: { name: 'del', method: 'POST', route: '/admin/?muraAction=cSettings.updateSite', form: { action: 'Delete' } },
    key: 'admin:csettings.updatesite{action=delete}',
  },
  {
    label: 'an image upload',
    step: {
      name: 'upload',
      method: 'POST',
      route: '/admin/?muraAction=cArch.update',
      multipart: { fields: { siteid: 'tenant-a' }, files: [IMAGE] },
    },
    key: 'admin:carch.update{upload=image}',
  },
  {
    label: 'a dotted JSON API method naming a remote function',
    step: { name: 'poll', method: 'POST', route: '/_api/json/v1/default/content/', body: { method: 'user.pollState' } },
    key: 'api:user.~pollstate',
  },
];

// One request carries one body, so the table's form-plus-JSON-body cases have no catalogue step.
const CONFLICT_CASES: KeyCase[] = routeKeyConflictCases
  .filter(({ request }) => request.form === undefined || request.jsonBody === undefined)
  .map(({ name, request, expectedKey }) => ({
    label: name,
    step: sendable(fromRouteKeyRequest(request)),
    key: expectedKey,
  }));

describe('recorded route keys', () => {
  it.each([...VARIANT_CASES, ...CONFLICT_CASES])(
    'records the coverage key of $label on capture and replay',
    async ({ step, key }) => {
      const s = scenario(step);
      const env = envFor();
      const fake = fakeOrigin();
      const captured = await captureScenario(s, captureDeps(fake, env));
      const ctx = createScenarioContext(s, { origin: 'gateway', env, fetch: fake.fetch });
      const replayed = await runScenarioSteps(ctx, s, { mode: 'replay', fetch: fake.fetch });

      expect(fake.sent).toHaveLength(2);
      expect(coverageRouteKey(s.steps[0] as Step)).toBe(key);
      expect(captured?.raw?.records.map((r) => r.routeKey)).toStrictEqual([key]);
      expect(captured?.set.steps.map((r) => r.routeKey)).toStrictEqual([key]);
      expect(replayed.map((r) => r.routeKey)).toStrictEqual([key]);
    },
  );

  it('records keys with the route-key options a capture is given', async () => {
    const env = envFor();
    const fake = fakeOrigin();
    const deps = { ...captureDeps(fake, env), routeKeyOptions: { appReloadKey: 'appreload' } };
    const captured = await captureScenario(scenario(ROSTER_CREATE), deps);
    expect(captured?.raw?.records.map((r) => r.routeKey)).toStrictEqual(['admin:cusers.update']);
  });
});
