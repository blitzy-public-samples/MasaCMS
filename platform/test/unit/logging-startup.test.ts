import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/logging/redact.js';
import { logStartupFailure } from '../../src/logging/startup.js';
import { validateLogRecord } from '../../src/logging/validate.js';
import { EnvValidationError } from '../../src/service-kit/env.js';

type LogLine = Record<string, unknown>;

const BASE = { service: 'startup-test', version: '1.2.3' } as const;
// Assembled at run time, so no literal credential appears in source.
const SECRET = ['c11', 'startup', 'secret'].join('-');
const LEAKY_TEXT = `connect postgres://svc:${SECRET}@db/x refused`;

/** A memory destination and the raw and parsed lines written to it. */
function memoryDestination(): { destination: DestinationStream; lines: LogLine[]; raw: string[] } {
  const lines: LogLine[] = [];
  const raw: string[] = [];
  const destination: DestinationStream = {
    write: (line: string) => {
      raw.push(line);
      lines.push(JSON.parse(line) as LogLine);
    },
  };
  return { destination, lines, raw };
}

/** Logs `err` with `source` to a memory destination and returns the lines written. */
async function capture(err: unknown, source: NodeJS.ProcessEnv = {}): Promise<{ lines: LogLine[]; raw: string[] }> {
  const { destination, lines, raw } = memoryDestination();
  await logStartupFailure(err, { ...BASE, source, destination });
  return { lines, raw };
}

describe('logStartupFailure', () => {
  it.each<[string, () => unknown, string, string, string | undefined]>([
    [
      'an EnvValidationError',
      () => new EnvValidationError([`PG_HOST: ${LEAKY_TEXT}`], 'startup-test'),
      'EnvValidationError',
      'startup-test: invalid environment (PG_HOST)',
      'EnvValidationError: startup-test: invalid environment (PG_HOST)\n    at ',
    ],
    ['an Error', () => new Error(LEAKY_TEXT), 'Error', REDACTED, 'Error: [REDACTED]\n    at '],
    ['a thrown string', () => LEAKY_TEXT, 'string', REDACTED, undefined],
  ])('writes %s as one valid ERROR line without its message', async (_label, make, type, message, stackStart) => {
    const { lines, raw } = await capture(make());

    expect(lines).toHaveLength(1);
    const line = lines[0] as LogLine;
    expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
    expect(line).toMatchObject({ ...BASE, env: 'local', severity: 'ERROR', message: 'start-up failed', error: { type, message } });
    const { stack } = line.error as { stack?: string };
    if (stackStart === undefined) {
      expect(stack).toBeUndefined();
    } else {
      expect(stack?.startsWith(stackStart)).toBe(true);
    }
    expect(raw.join('')).not.toContain(SECRET);
  });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    ['OPT2_ENV unset', {}, 'local'],
    ['OPT2_ENV=local', { OPT2_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'opt2-test' }, 'local'],
    ['OPT2_ENV=cloud with GOOGLE_CLOUD_PROJECT', { OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: 'opt2-test' }, 'cloud'],
    ['OPT2_ENV=cloud without GOOGLE_CLOUD_PROJECT', { OPT2_ENV: 'cloud' }, 'local'],
    ['OPT2_ENV=cloud with an unusable GOOGLE_CLOUD_PROJECT', { OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: 'org/project' }, 'local'],
  ])('writes env %s as %s', async (_label, source, env) => {
    const { lines } = await capture(new Error('boom'), source);

    expect(lines).toHaveLength(1);
    expect(validateLogRecord(lines[0])).toStrictEqual({ valid: true, errors: [] });
    expect(lines[0]).toMatchObject({ ...BASE, env, severity: 'ERROR', message: 'start-up failed' });
  });

  it.each(['fatal', 'verbose'])('ignores LOG_LEVEL=%s', async (level) => {
    const { lines } = await capture(new Error('boom'), { LOG_LEVEL: level });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ severity: 'ERROR', message: 'start-up failed' });
  });

  it('resolves only after the destination flush callback ran', async () => {
    const { destination, lines } = memoryDestination();
    let finishFlush: (() => void) | undefined;
    const flushing: DestinationStream & { flush(cb: (err?: Error) => void): void } = {
      write: (line: string) => destination.write(line),
      flush: (cb) => {
        finishFlush = () => cb();
      },
    };
    let resolved = false;

    const done = logStartupFailure(new Error('boom'), { ...BASE, source: {}, destination: flushing }).then(() => {
      resolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lines).toHaveLength(1);
    expect(resolved).toBe(false);
    expect(finishFlush).toBeTypeOf('function');
    finishFlush?.();
    await done;
    expect(resolved).toBe(true);
  });
});
