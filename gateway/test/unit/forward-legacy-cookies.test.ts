// Tests which legacy Set-Cookie values the legacy forwarder lets reach the client, by session mode and beforeSend outcome.
import { Buffer } from 'node:buffer';
import replyFrom from '@fastify/reply-from';
import Fastify from 'fastify';
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  forwardToLegacy,
  type BufferedLegacyResponse,
  type LegacyBeforeSend,
  type LegacyForwardContext,
} from '../../src/dispatcher/forward-legacy.js';
import type { SessionMode } from '../../src/session/mode.js';
import { sendBytes, startHttpDouble, type HttpDouble } from '../helpers/http-double.js';

const LEGACY_STATUS = 201;
const UNAVAILABLE_STATUS = 503;
const LEGACY_BODY = Buffer.from([0x3c, 0x70, 0x3e, 0x00, 0xff, 0xfe, 0x0d, 0x0a]);
const MIXED_SET_COOKIES = ['CFID=1001;path=/;', 'A=1;path=/;', 'cftoken=abc;path=/;HttpOnly;', 'B=2;path=/;HttpOnly;', 'JSESSIONID=j1;path=/;'];
const NON_SESSION_SET_COOKIES = ['A=1;path=/;', 'B=2;path=/;HttpOnly;'];
const SESSION_SET_COOKIES = ['CFID=1001;path=/;', 'cftoken=abc;path=/;HttpOnly;', 'JSESSIONID=j1;path=/;'];
const MAPPED_SET_COOKIES = ['CFID=t-1;path=/;HttpOnly;', 'CFTOKEN=t-2;path=/;HttpOnly;'];

const rejects: LegacyBeforeSend = () => Promise.reject(new Error('session mapping failed'));
const resolvesVoid: LegacyBeforeSend = () => Promise.resolve();
const mapsCookies: LegacyBeforeSend = () => Promise.resolve({ setCookies: [...MAPPED_SET_COOKIES] });

interface Scenario {
  name: string;
  sessionMode: SessionMode;
  legacySetCookies: string[];
  beforeSend: LegacyBeforeSend;
  expected: string[];
  /** Status the client gets: legacy's own, or the legacy-shaped 503 once beforeSend rejected. */
  status: number;
}

/** One scenario row: session mode, legacy's Set-Cookie list, beforeSend outcome, then the list the client must get. */
function scenario(
  name: string,
  sessionMode: SessionMode,
  legacySetCookies: string[],
  beforeSend: LegacyBeforeSend,
  expected: string[],
  status = LEGACY_STATUS,
): Scenario {
  return { name, sessionMode, legacySetCookies, beforeSend, expected, status };
}

const SCENARIOS: Scenario[] = [
  scenario('target-primary, beforeSend rejects', 'target-primary', MIXED_SET_COOKIES, rejects, [], UNAVAILABLE_STATUS),
  scenario('target-primary, beforeSend resolves void', 'target-primary', MIXED_SET_COOKIES, resolvesVoid, NON_SESSION_SET_COOKIES),
  scenario('target-primary, beforeSend maps cookies', 'target-primary', MIXED_SET_COOKIES, mapsCookies, MAPPED_SET_COOKIES),
  scenario('target-primary, only session cookies, beforeSend rejects', 'target-primary', SESSION_SET_COOKIES, rejects, [], UNAVAILABLE_STATUS),
  scenario('legacy-primary, beforeSend rejects', 'legacy-primary', MIXED_SET_COOKIES, rejects, [], UNAVAILABLE_STATUS),
  scenario('legacy-primary, beforeSend resolves void', 'legacy-primary', MIXED_SET_COOKIES, resolvesVoid, MIXED_SET_COOKIES),
  scenario('legacy-primary, beforeSend maps cookies', 'legacy-primary', MIXED_SET_COOKIES, mapsCookies, MAPPED_SET_COOKIES),
];

const CASES = (['stream', 'buffer'] as const).flatMap((mode) => SCENARIOS.map((row) => ({ mode, ...row })));

interface Forwarded {
  status: number;
  hasSetCookie: boolean;
  setCookies: string[];
  body: Buffer;
}

let legacy: HttpDouble;

beforeAll(async () => {
  legacy = await startHttpDouble((_req, res) => sendBytes(res, 500, 'no handler'));
});

afterAll(async () => {
  await legacy.close();
});

/** Serves one GET through a gateway route that calls forwardToLegacy with `ctx`, and reports what the client got. */
async function forward(ctx: Pick<LegacyForwardContext, 'mode' | 'sessionMode' | 'beforeSend' | 'onBuffered'>): Promise<Forwarded> {
  const app = Fastify();
  await app.register(replyFrom);
  app.get('/*', (request, reply) => {
    void forwardToLegacy(request, reply, {
      legacyOrigin: legacy.url,
      headers: request.headers,
      failContext: { surface: 'admin' },
      ...ctx,
    });
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/admin/index.cfm?muraAction=cArch.list`);
    return {
      status: response.status,
      hasSetCookie: response.headers.has('set-cookie'),
      setCookies: response.headers.getSetCookie(),
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    await app.close();
  }
}

describe('forwardToLegacy Set-Cookie mapping', () => {
  it.each(CASES)('$mode mode, $name', async ({ mode, sessionMode, legacySetCookies, beforeSend, expected, status }) => {
    legacy.setHandler((_req, res) => {
      sendBytes(res, LEGACY_STATUS, LEGACY_BODY, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': legacySetCookies });
    });
    const sendHook = vi.fn<LegacyBeforeSend>(beforeSend);
    const onBuffered = vi.fn<(res: BufferedLegacyResponse) => Promise<void>>(() => Promise.resolve());

    const forwarded = await forward({ mode, sessionMode, beforeSend: sendHook, onBuffered });

    expect(forwarded.status).toBe(status);
    expect(forwarded.body.equals(status === LEGACY_STATUS ? LEGACY_BODY : Buffer.from(LEGACY_ERROR_PAGE_HTML))).toBe(true);
    expect(forwarded.setCookies).toEqual(expected);
    expect(forwarded.hasSetCookie).toBe(expected.length > 0);
    expect(sendHook).toHaveBeenCalledOnce();
    expect(sendHook.mock.calls[0]?.[0].headers['set-cookie']).toEqual(legacySetCookies);
    if (mode === 'stream') {
      expect(onBuffered).not.toHaveBeenCalled();
      return;
    }
    expect(onBuffered).toHaveBeenCalledOnce();
    const buffered = onBuffered.mock.calls[0]?.[0];
    expect(buffered?.statusCode).toBe(LEGACY_STATUS);
    expect(buffered?.body.equals(LEGACY_BODY)).toBe(true);
    expect(buffered?.headers['set-cookie']).toEqual(legacySetCookies);
  });
});
