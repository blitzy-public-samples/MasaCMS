// Tests that the matcher keys requests through the platform's scanned route key.
import { Buffer } from 'node:buffer';
import { scannedRouteKey, type ScannedRouteKeyRequest } from '@opt2/platform/legacy-compat';
import { fixedClock } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { createResponseModes } from '../../src/admin/response-modes.js';
import { bodyParamsFrom } from '../../src/dispatcher/body.js';
import { createMatcher, type MatchRequest, type RoutedOutcome } from '../../src/dispatcher/match.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const URLENCODED = 'application/x-www-form-urlencoded';

/** A request as sent: target, and an optional urlencoded POST body. */
interface Sent {
  url: string;
  body?: string;
}

// No version is active, so every request is keyed and answered no-active-version.
const matcher = createMatcher({
  state: { active: () => undefined },
  variants: { sourceSha: SHA, variants: [] },
  modes: createResponseModes({ get: () => undefined, routes: () => [] }),
  env: { OPT2_SERVICE_URLS: {}, OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: '/nonexistent' },
  clock: fixedClock('2026-06-30T12:00:00Z'),
});

/** The matcher's outcome for `sent`, a POST when it has a body. */
async function outcomeOf({ url, body }: Sent): Promise<RoutedOutcome> {
  const method = body === undefined ? 'GET' : 'POST';
  const bytes = body === undefined ? undefined : Buffer.from(body, 'utf8');
  const request: MatchRequest =
    bytes === undefined ? { url, method, headers: {} } : { url, method, headers: { 'content-type': URLENCODED }, body: bytes };
  const outcome = await matcher.match(request, bodyParamsFrom(bytes === undefined ? undefined : URLENCODED, bytes, method));
  if (outcome.result === undefined) throw new TypeError(`${url} was relayed, not keyed`);
  return outcome;
}

describe('matcher route key', () => {
  it.each<[string, Sent, ScannedRouteKeyRequest]>([
    [
      'a padded admin action',
      { url: '/admin/?muraAction=%20cUsers.list' },
      { method: 'GET', path: '/admin/', url: '/admin/?muraAction=%20cUsers.list', query: { muraAction: ' cUsers.list' }, headers: {} },
    ],
    [
      'an amp;-prefixed posted method',
      { url: '/_api/json/v1/tenant-a/', body: 'amp;method=generateCSRFTokens' },
      { method: 'POST', path: '/_api/json/v1/tenant-a/', query: {}, form: { 'amp;method': 'generateCSRFTokens' }, headers: { 'content-type': URLENCODED } },
    ],
    [
      'a url scan fault',
      { url: '/_api/json/v1/tenant-a/?method=%20generateCSRFTokens&x=null' },
      { method: 'GET', path: '/_api/json/v1/tenant-a/', query: { method: ' generateCSRFTokens', x: 'null' }, headers: {} },
    ],
    [
      'case-variant url names, joined in the order sent',
      { url: '/_api/json/v1/tenant-a/?q=1&Q=2&q=3' },
      { method: 'GET', path: '/_api/json/v1/tenant-a/', url: '/_api/json/v1/tenant-a/?q=1&Q=2&q=3', query: { q: ['1', '3'], Q: '2' }, headers: {} },
    ],
  ])('keys %s as scannedRouteKey does', async (_label, sent, request) => {
    const { result, urlScope, scanFailed } = await outcomeOf(sent);
    const scanned = scannedRouteKey(request);
    expect({ result, urlScope: { ...urlScope }, scanFailed }).toEqual({ result: scanned.result, urlScope: { ...scanned.urlScope }, scanFailed: scanned.scanFailed });
  });

  it('reads the url scope of case-variant names in the order sent', async () => {
    expect({ ...(await outcomeOf({ url: '/_api/json/v1/tenant-a/?q=1&Q=2&q=3' })).urlScope }).toEqual({ q: '1,2,3' });
  });

  it.each<[string, Sent, boolean]>([
    ['a url scope', { url: '/_api/rest/v1/tenant-a/content?x=null' }, true],
    ['a form scope', { url: '/_api/rest/v1/tenant-a/content', body: 'x=%5Bnull%5D' }, true],
    ['neither scope', { url: '/_api/rest/v1/tenant-a/content?x=1&X=null' }, false],
  ])('reports whether the scan fails on %s', async (_label, sent, scanFailed) => {
    expect((await outcomeOf(sent)).scanFailed).toBe(scanFailed);
  });
});
