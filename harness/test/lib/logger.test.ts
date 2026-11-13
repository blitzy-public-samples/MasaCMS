import { readFileSync } from 'node:fs';
import { validateLogRecord } from '@opt2/platform/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarnessLogger } from '../../src/lib/logger.js';
import { repoPath, type EnvLike } from '../../src/lib/paths.js';

const VERSION = (JSON.parse(readFileSync(repoPath('harness', 'package.json'), 'utf8')) as { version: string }).version;

describe('createHarnessLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[string, EnvLike, 'local' | 'cloud']>([
    ['no OPT2_ENV', {}, 'local'],
    ['OPT2_ENV=local', { OPT2_ENV: 'local' }, 'local'],
    ['an unknown OPT2_ENV', { OPT2_ENV: 'staging' }, 'local'],
    ['OPT2_ENV=cloud with a project', { OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: 'opt2-test' }, 'cloud'],
  ])('writes one log-record.v1 line to stderr, never stdout, under %s', (_label, env, expected) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    createHarnessLogger('harness-test', env).warn('GS-CO-05: fail (1 unlisted difference)');

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    const record: unknown = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(validateLogRecord(record)).toEqual({ valid: true, errors: [] });
    expect(record).toMatchObject({
      severity: 'WARNING',
      message: 'GS-CO-05: fail (1 unlisted difference)',
      service: 'harness-test',
      version: VERSION,
      env: expected,
    });
  });

  it('requires GOOGLE_CLOUD_PROJECT when OPT2_ENV is cloud', () => {
    expect(() => createHarnessLogger('harness-test', { OPT2_ENV: 'cloud' })).toThrow(
      /googleCloudProject is required/,
    );
  });
});
