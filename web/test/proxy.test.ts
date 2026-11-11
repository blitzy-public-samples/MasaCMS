import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetLegacySettingsForTests } from '@/lib/env';
import { config, proxy } from '../proxy';

const request = (query: string, headers: Record<string, string> = {}): NextRequest =>
  new NextRequest(`http://localhost/admin/carch/list${query}`, { headers });

beforeEach(() => {
  vi.stubEnv('MURA_LOCALE', 'Server');
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('proxy', () => {
  it('matches the admin page routes only', () => {
    expect(config.matcher).toEqual(['/admin/:circuit/:action', '/opt2/admin/:module/:screen']);
  });

  it.each<[string, boolean]>([
    ['', true],
    ['?compactDisplay=false', true],
    ['?compactDisplay=true', false],
    ['?compactDisplay=Yes', false],
    ['?COMPACTDISPLAY=1', false],
    ['?compactDisplay=true&compactDisplay=false', true],
  ])('continues %j with the full layout cache headers: %s', (query, full) => {
    const res = proxy(request(query));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('expires')).toBe(full ? '06 Nov 1994 08:37:34 GMT' : null);
    expect(res.headers.get('cache-control')).toBe(full ? 'no-cache, no-store, must-revalidate' : null);
    expect(res.headers.get('generator')).toBe('Masa CMS 7.6.1');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=1200');
    expect(res.headers.get('content-language')).toBe('en-US');
  });

  it.each<[Record<string, string>, string | null]>([
    [{ 'accept-encoding': 'identity' }, 'identity'],
    [{ 'accept-encoding': 'gzip, deflate' }, null],
    [{}, null],
  ])('answers request headers %o with Content-Encoding %j', (headers, expected) => {
    expect(proxy(request('', headers)).headers.get('content-encoding')).toBe(expected);
  });
});
