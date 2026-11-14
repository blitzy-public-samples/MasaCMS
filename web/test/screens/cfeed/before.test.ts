// cfeed before() cases before-gate.test.ts and index.test.ts leave out: the secure() decision as returned, the gate
// over the real admin request builder, and the param defaults beside present and unrelated rc keys.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGate, secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { CFEED_RC_DEFAULTS, applyCfeedDefaults, cfeedGate } from '@/screens/cfeed/before';
import {
  adminS2Request,
  anonymousRequest,
  buildTestAdminRequest,
  makeAdminRequest,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { SUBJECTS, type WebTestSubjectKey } from '../../helpers/tokens';

const LIST = { circuit: 'cfeed', item: 'list' } as const;
const FEEDS = { ...LIST, site: { hasFeedManager: true } } as const;
const FEED_ID = 'F1000000-0000-0000-0000000000000001';
const REFERER = 'http://localhost/admin/?muraAction=cArch.list&siteid=default';
const ALLOW: GateDecision = { kind: 'allow' };
const BACK_UP: GateDecision = { kind: 'redirect', location: './' };

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The real builder's `cFeed.list` request for `user` on its own site, whose row has `feedManager` as given. */
const built = (user: WebTestSubjectKey, feedManager: 0 | 1, headers?: HeadersInit): Promise<AdminRequest> =>
  buildTestAdminRequest({
    circuit: 'cFeed',
    action: 'list',
    query: { siteid: SUBJECTS[user].site },
    user,
    site: { feedManager },
    headers,
  });

describe('cfeedGate', () => {
  it.each<{ name: string; request: () => AdminRequest }>([
    { name: 'S2 on a site without the feed manager', request: () => adminS2Request(LIST) },
    {
      name: 'a system user with neither module grant on its own site',
      request: () => makeAdminRequest({ ...FEEDS, session: { siteid: SUBJECTS.systemUser.site } }, 'systemUser'),
    },
    { name: 'anonymous', request: () => anonymousRequest(FEEDS) },
  ])('returns the secure() decision itself for $name', async ({ request }) => {
    const req = request();
    const secureSpy = vi.fn(() => secure(req));

    const decision = await cfeedGate(req, { secure: secureSpy });

    expect(secureSpy).toHaveBeenCalledTimes(1);
    expect(secureSpy).toHaveBeenCalledWith();
    expect(decision).toBe(secureSpy.mock.results[0]?.value);
  });

  describe('over the admin request builder', () => {
    it.each<{ name: string; user: WebTestSubjectKey; feedManager: 0 | 1; expected: GateDecision }>([
      { name: 'the S2 admin', user: 'admin', feedManager: 1, expected: ALLOW },
      { name: 'the tenant-a site admin', user: 'siteAdmin', feedManager: 1, expected: ALLOW },
      { name: 'the editor with content access only', user: 'qaEditor', feedManager: 1, expected: BACK_UP },
      { name: 'the S2 admin without the feed manager', user: 'admin', feedManager: 0, expected: BACK_UP },
      {
        name: 'the tenant-a site admin without the feed manager',
        user: 'siteAdmin',
        feedManager: 0,
        expected: BACK_UP,
      },
    ])('answers $name per the tsettings feedManager column', async ({ user, feedManager, expected }) => {
      expect(await runGate(await built(user, feedManager), cfeedGate)).toEqual(expected);
    });

    it('backs a secured logged-in user up to the referrer', async () => {
      const req = await built('qaEditor', 1, { referer: REFERER });

      expect(await runGate(req, cfeedGate)).toEqual({ kind: 'redirect', location: REFERER });
    });

    it('sends anonymous to the login form with its return URL and compactDisplay', async () => {
      const req = await built('anonymous', 1);

      const decision = await runGate(req, cfeedGate);

      expect(decision).toEqual(secure(req));
      if (decision.kind !== 'redirect') throw new TypeError('Expected a redirect');
      expect(decision.location.startsWith('./?muraAction=cLogin.main')).toBe(true);
      const params = new URLSearchParams(decision.location.slice(decision.location.indexOf('?') + 1));
      expect(params.get('returnURL')).toBe('http://localhost/admin/?&muraAction=cFeed.list&siteid=default');
      expect(params.get('compactDisplay')).toBe('false');
    });
  });
});

describe('applyCfeedDefaults', () => {
  it('keeps present values, empty ones included, and appends only the missing params', () => {
    const rc = { siteid: 'tenant-a', feedID: FEED_ID, startrow: '21', keywords: '', action: 'update', CATEGORYID: '' };
    const present = new Set(Object.keys(rc).map((name) => name.toLowerCase()));
    const missing = Object.entries(CFEED_RC_DEFAULTS).filter(([name]) => !present.has(name.toLowerCase()));

    expect(Object.entries(applyCfeedDefaults(rc))).toEqual([...Object.entries(rc), ...missing]);
  });

  it('changes nothing once every param is present', () => {
    const once = applyCfeedDefaults({ siteid: 'tenant-a', startrow: '21' });

    expect(Object.entries(applyCfeedDefaults(once))).toEqual(Object.entries(once));
  });
});
