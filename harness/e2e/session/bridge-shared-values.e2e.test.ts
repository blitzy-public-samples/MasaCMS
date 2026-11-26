// Shared session values through the legacy bridge on real ColdFusion: session.cfm's export answers strict JSON in which
// carch's all-zero module id stays a string, also when legacy writes it into a carried struct, and a carried struct legacy
// rewrites unchanged is not exported again.
import {
  BRIDGE_ASSERTION_HEADER,
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  signBridgeAssertion,
} from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { ADMIN_LOGIN_PATH, fetchFormTokens } from '../../src/golden/session.js';
import { createHttpSession, type HttpResult, type HttpSession } from '../../src/lib/http.js';
import { bridgeHmacKey, describedSession, legacySessionCookieHeader } from '../../src/lib/identity-session.js';
import { credentialsFor, type Credentials } from '../helpers/admin-login.js';
import { legacyUrl } from '../helpers/stack.js';

const SESSION_PAGE = '/gateway/legacy-bridge/cfml/session.cfm';
const ADMIN_PATH = '/admin/';
const SITE_ID = 'default';
/** Site Manager's module id, which carch params as an unquoted numeric literal (admin/core/controllers/carch.cfc:78). */
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const MODULE_ID_LENGTH = SITE_MANAGER_MODULE_ID.length;
/** A browser agent, sent on every call: Masa cuts a bot-like agent's session to 2 s (core/appcfc/applicationSettings.cfm:240-312). */
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) opt2-harness-e2e';
/** The Site Manager flat view's filter form, as admin/assets/js/architecture.js posts it to cArch.loadSiteFlat. */
const FLAT_VIEW_ARGS = { siteid: SITE_ID, sortby: 'lastupdate', sortdirection: 'desc', page: '1', report: '', keywords: '' };

type SessionOp = 'describe' | 'carry' | 'export';

/** One `op=export` entry. */
interface ExportedValue {
  name: string;
  value: unknown;
  base?: unknown;
}

/** `session.<op>` on the legacy session `session`'s cookies attach, signed for `sid`; a `json` body makes it a POST. */
async function bridgeCall(session: HttpSession, op: SessionOp, sid: string, json?: unknown): Promise<HttpResult> {
  const headers = {
    accept: 'application/json',
    cookie: legacySessionCookieHeader(await session.cookieHeader()),
    'user-agent': USER_AGENT,
    [BRIDGE_ASSERTION_HEADER]: signBridgeAssertion({ op: `session.${op}`, sid }, bridgeHmacKey()),
  };
  // The cookie header names the session, so the call needs no jar; a followed redirect would replay the assertion.
  return createHttpSession({ baseUrl: legacyUrl() }).request({
    method: json === undefined ? 'GET' : 'POST',
    path: SESSION_PAGE,
    query: { op },
    headers,
    json,
    followRedirects: false,
  });
}

/** Admin login through form#loginForm without following legacy's 302 to ./, whose landing would set `session.moduleid` first. */
async function loginWithoutLanding(session: HttpSession, creds: Credentials): Promise<void> {
  const form = await fetchFormTokens(session, ADMIN_LOGIN_PATH, 'form#loginForm');
  const login = await session.post(form.action, {
    form: {
      ...form.fields,
      username: creds.username,
      password: creds.password,
      [CSRF_FIELD_TOKEN]: form.token,
      [CSRF_FIELD_EXPIRES]: form.expires,
    },
    followRedirects: false,
  });
  expect(login.status).toBe(302);
  expect(login.hops.at(-1)?.location).not.toMatch(/clogin/i);
  expect(legacySessionCookieHeader(await session.cookieHeader())).toMatch(/^(CFID|CFTOKEN|JSESSIONID)=/);
}

/** The Site Manager list view of the default site, which stores its defaults in `session.flatViewArgs`. */
async function openSiteManagerList(session: HttpSession): Promise<void> {
  const list = await session.get(ADMIN_PATH, { query: { muraAction: 'carch.list', siteid: SITE_ID } });
  if (list.status !== 200) throw new Error(`carch.list answered ${list.status}`);
}

/** The entries of an `op=export` answer, parsed as strictly as the gateway's bridge client parses them. */
function exportedValues(result: HttpResult): ExportedValue[] {
  expect(result.status).toBe(200);
  const body = JSON.parse(result.text) as { values?: unknown };
  expect(Array.isArray(body.values)).toBe(true);
  return body.values as ExportedValue[];
}

function entryNamed(values: readonly ExportedValue[], name: string): ExportedValue | undefined {
  return values.find((entry) => entry.name === name);
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value === 'object' && value !== null && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

/** The key of `record` that names `name` ignoring case, as ColdFusion struct keys match. */
function keyIgnoringCase(record: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
}

/** `record[name]` matched ignoring case; ColdFusion upper-cases keys its dot notation writes, such as `MODULEID`. */
function memberIgnoringCase(record: Record<string, unknown>, name: string): unknown {
  const key = keyIgnoringCase(record, name);
  return key === undefined ? undefined : record[key];
}

/** The default site's struct of a `flatViewArgs` value. */
function siteFlatViewArgs(flatViewArgs: unknown): Record<string, unknown> {
  return asRecord(memberIgnoringCase(asRecord(flatViewArgs), SITE_ID));
}

/** Carries `values` as identity's shared values under one fresh revision and checks each was installed. */
async function carry(session: HttpSession, sid: string, values: Record<string, unknown>): Promise<void> {
  const revision = `opt2-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const entries = Object.entries(values).map(([name, value]) => ({ name, value, revision }));
  const result = await bridgeCall(session, 'carry', sid, { values: entries });
  expect(result.status).toBe(200);
  expect((JSON.parse(result.text) as { applied?: unknown }).applied).toEqual(Object.keys(values));
}

describe('legacy bridge shared session values on ColdFusion', () => {
  let session: HttpSession;
  let sessionId: string;
  let first: HttpResult;

  beforeAll(async () => {
    session = createHttpSession({ baseUrl: legacyUrl(), defaultHeaders: { 'user-agent': USER_AGENT } });
    const creds = credentialsFor('${secret:admin}');
    await loginWithoutLanding(session, creds);
    // Its first carch request: carch params session.moduleid with its numeric literal, which the list view stores.
    await openSiteManagerList(session);
    const described = await bridgeCall(session, 'describe', '');
    if (described.status !== 200) throw new Error(`session.describe answered ${described.status}`);
    sessionId = describedSession(described.json(), creds.username).sessionId;
    first = await bridgeCall(session, 'export', sessionId);
  });

  it('exports strict JSON in which the module id legacy holds stays a 35-character string', () => {
    const values = exportedValues(first);
    const flat = entryNamed(values, 'flatViewArgs');
    expect(flat).toBeDefined();
    expect(memberIgnoringCase(siteFlatViewArgs(flat?.value), 'moduleid')).toBe(SITE_MANAGER_MODULE_ID);
    expect(entryNamed(values, 'moduleid')?.value).toBe(SITE_MANAGER_MODULE_ID);
    const tops = Object.values(asRecord(entryNamed(values, 'moduleTopIds')?.value));
    expect(tops.length).toBeGreaterThan(0);
    for (const top of tops) {
      expect(typeof top).toBe('string');
      expect(top).toHaveLength(MODULE_ID_LENGTH);
    }
  });

  it('exports the module id legacy writes into a carried struct as a string, with the carried struct as base', async () => {
    const flat = entryNamed(exportedValues(first), 'flatViewArgs')?.value;
    const site = { ...siteFlatViewArgs(flat) };
    delete site[keyIgnoringCase(site, 'moduleid') ?? 'moduleid'];
    const carried = { [SITE_ID]: site };
    await carry(session, sessionId, { flatViewArgs: carried });
    // The list view fills the missing module id from session.moduleid, the literal carch params.
    await openSiteManagerList(session);
    const exported = entryNamed(exportedValues(await bridgeCall(session, 'export', sessionId)), 'flatViewArgs');
    expect(exported).toBeDefined();
    expect(memberIgnoringCase(siteFlatViewArgs(exported?.value), 'moduleid')).toBe(SITE_MANAGER_MODULE_ID);
    expect(exported?.base).toEqual(carried);
  });

  it('does not export again a carried struct whose module id legacy rewrites unchanged', async () => {
    // The flat view rewrites every flatViewArgs key, the module id as the numeric literal session.moduleid holds included.
    const loadSiteFlat = (): Promise<HttpResult> =>
      session.post(ADMIN_PATH, { query: { muraAction: 'cArch.loadSiteFlat' }, form: FLAT_VIEW_ARGS });
    expect((await loadSiteFlat()).status).toBe(200);
    const written = entryNamed(exportedValues(await bridgeCall(session, 'export', sessionId)), 'flatViewArgs');
    expect(memberIgnoringCase(siteFlatViewArgs(written?.value), 'moduleid')).toBe(SITE_MANAGER_MODULE_ID);
    await carry(session, sessionId, { flatViewArgs: written?.value });
    expect((await loadSiteFlat()).status).toBe(200);
    const names = exportedValues(await bridgeCall(session, 'export', sessionId)).map((entry) => entry.name);
    expect(names).not.toContain('flatViewArgs');
  });
});
