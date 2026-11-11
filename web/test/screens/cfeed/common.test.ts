// Unit tests for the cFeed helpers beyond common-helpers.test.ts: index-file settings, request host and scheme, flags.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacySettings, resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import { cfTruthy, displayErrors, feedApiEndpoint, yesNoFormat, type CfFlag } from '@/screens/cfeed/common';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
  useSettings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  restoreEnv();
});

describe('feedApiEndpoint', () => {
  // configBean.getIndexPath() is '' in Masa, so neither setting puts `/index.cfm` into the endpoint.
  it.each<[Record<string, string>, boolean]>([
    [{}, true],
    [{ MURA_INDEXFILEINURLS: 'true' }, true],
    [{ MURA_INDEXFILEINURLS: 'false' }, false],
    [{ MURA_INDEXFILEINURLS: 'false', MURA_INDEXFILEINAPI: 'true' }, true],
    [{ MURA_INDEXFILEINURLS: 'true', MURA_INDEXFILEINAPI: 'false' }, false],
  ])('adds no index file under %j', (vars, indexFileInAPI) => {
    useSettings(vars);
    expect(legacySettings().indexFileInAPI).toBe(indexFileInAPI);
    expect(feedApiEndpoint(adminS2Request())).toBe('http://localhost/_api/feed/v1/default');
    expect(feedApiEndpoint(siteAdminRequest('tenant-a'), undefined)).toBe('http://localhost/_api/feed/v1/tenant-a');
  });

  it.each<[boolean, string, string]>([
    [true, 'localhost', 'https://localhost'],
    [false, 'LOCALHOST', 'http://LOCALHOST'],
  ])('builds tenant-a with https %s for host %s', (https, serverName, origin) => {
    expect(feedApiEndpoint(siteAdminRequest('tenant-a', { https, serverName }))).toBe(
      `${origin}/_api/feed/v1/tenant-a`,
    );
  });
});

describe('displayErrors', () => {
  it('breaks after a message a siteID key follows, not after the last message', () => {
    const markup = displayErrors({ name: 'A', siteID: 'default', maxItems: 'B' });
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe('A <br> B ');
  });
});

describe('cfTruthy and yesNoFormat', () => {
  it.each<[CfFlag, boolean]>([
    ['-1', true],
    ['0.5', true],
    ['-0', false],
    ['0.00', false],
  ])('reads the numeric string %j as %s', (value, expected) => {
    expect(cfTruthy(value)).toBe(expected);
    expect(yesNoFormat(value)).toBe(expected ? 'Yes' : 'No');
  });

  it('throws for an untrimmed numeric string, which ACF isBoolean rejects', () => {
    expect(() => cfTruthy(' 1')).toThrow(TypeError);
    expect(() => yesNoFormat(' 1')).toThrow(TypeError);
  });
});
