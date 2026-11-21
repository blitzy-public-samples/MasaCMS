// The custom server's process logger and the routing of console calls and process warnings through it.
import { Console } from 'node:console';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REDACTED, SEVERITY_BY_LEVEL, validateLogRecord } from '@opt2/platform/logging';
import { createProcessLogger, flushLogger, routeConsole, routeWarnings } from '@/server/logger';
import { WEB_VERSION } from '@/server/shared';
import { captureLines } from '../helpers/log-lines';

const PROJECT = 'opt2-web-test';

/** A console whose own output would land in `raw`, routed through a logger writing to the returned lines. */
function routedConsole(): { target: Console; lines: ReturnType<typeof captureLines>['lines']; raw: string[] } {
  const raw: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      raw.push(chunk.toString());
      done();
    },
  });
  const target = new Console({ stdout: sink, stderr: sink });
  const { lines, destination } = captureLines();
  routeConsole(createProcessLogger({ OPT2_ENV: 'local', LOG_LEVEL: 'debug' }, destination), target);
  return { target, lines, raw };
}

describe('createProcessLogger', () => {
  it.each<[string, Record<string, string | undefined>, string, string]>([
    ['local at the default level', { OPT2_ENV: 'local' }, 'local', 'info'],
    [
      'cloud with its project at LOG_LEVEL',
      { OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: PROJECT, LOG_LEVEL: 'debug' },
      'cloud',
      'debug',
    ],
    ['local for cloud without a project', { OPT2_ENV: 'cloud' }, 'local', 'info'],
    ['local for an unknown mode', { OPT2_ENV: 'bogus' }, 'local', 'info'],
    ['the default level for an unknown LOG_LEVEL', { OPT2_ENV: 'local', LOG_LEVEL: 'loud' }, 'local', 'info'],
  ])('writes web lines %s', (_case, source, env, level) => {
    const { lines, destination } = captureLines();
    const logger = createProcessLogger(source, destination);

    logger.info('ready');

    expect(logger.level).toBe(level);
    expect(lines).toHaveLength(1);
    expect(validateLogRecord(lines[0]).errors).toEqual([]);
    expect(lines[0]).toMatchObject({ service: 'web', version: WEB_VERSION, env, severity: 'INFO', message: 'ready' });
  });
});

describe('routeConsole', () => {
  it.each<[keyof Console, string]>([
    ['debug', SEVERITY_BY_LEVEL.debug],
    ['trace', SEVERITY_BY_LEVEL.debug],
    ['log', SEVERITY_BY_LEVEL.info],
    ['info', SEVERITY_BY_LEVEL.info],
    ['warn', SEVERITY_BY_LEVEL.warn],
    ['error', SEVERITY_BY_LEVEL.error],
  ])('writes console.%s as one %s line, formatted and without ANSI escapes', (method, severity) => {
    const { target, lines, raw } = routedConsole();

    (target[method] as (...args: unknown[]) => void)(' \u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Ready in %dms', 42);

    expect(raw).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(validateLogRecord(lines[0]).errors).toEqual([]);
    expect(lines[0]).toMatchObject({ severity, message: '✓ Ready in 42ms' });
  });

  it('logs the first Error argument as error and the others by their safe message', () => {
    const { target, lines } = routedConsole();
    const failure = new Error('secret detail');

    target.error(' ⨯', 'uncaughtException:', failure, new TypeError('other detail'));
    target.error(failure);

    expect(lines).toHaveLength(2);
    for (const line of lines) expect(validateLogRecord(line).errors).toEqual([]);
    expect(lines[0]).toMatchObject({
      severity: 'ERROR',
      message: `⨯ uncaughtException: ${REDACTED}`,
      error: { type: 'Error', message: REDACTED, stack: expect.any(String) },
    });
    expect(lines[1]).toMatchObject({ severity: 'ERROR', message: REDACTED, error: { type: 'Error' } });
    expect(JSON.stringify(lines)).not.toContain('detail');
  });

  it('writes console.dir and the methods that print through log and warn as lines', () => {
    const { target, lines, raw } = routedConsole();

    target.dir({ ready: true }, { depth: 0 });
    target.count('requests');
    target.table([{ a: 1 }]);
    target.assert(false, 'invariant');

    expect(raw).toEqual([]);
    expect(lines.map(({ severity }) => severity)).toEqual(['INFO', 'INFO', 'INFO', 'WARNING']);
    expect(lines.map(({ message }) => message)).toEqual([
      '{ ready: true }',
      'requests: 1',
      expect.stringContaining('│'),
      'Assertion failed: invariant',
    ]);
  });
});

describe('routeWarnings', () => {
  it("replaces the default printer with one WARNING line per warning", () => {
    const emitter = new EventEmitter();
    const printed: unknown[] = [];
    emitter.on('warning', (warning) => printed.push(warning));
    const { lines, destination } = captureLines();
    routeWarnings(createProcessLogger({ OPT2_ENV: 'local' }, destination), emitter);

    const warning = Object.assign(new Error('The punycode module is deprecated.'), {
      name: 'DeprecationWarning',
      code: 'DEP0040',
    });
    emitter.emit('warning', warning);
    emitter.emit('warning', Object.assign(new Error('Fetch is experimental'), { name: 'ExperimentalWarning' }));

    expect(printed).toEqual([]);
    expect(lines.map(({ severity, message }) => [severity, message])).toEqual([
      ['WARNING', 'DeprecationWarning [DEP0040]: The punycode module is deprecated.'],
      ['WARNING', 'ExperimentalWarning: Fetch is experimental'],
    ]);
  });
});

describe('flushLogger', () => {
  it('resolves once the logger has flushed', async () => {
    const { destination } = captureLines();

    await expect(flushLogger(createProcessLogger({ OPT2_ENV: 'local' }, destination))).resolves.toBeUndefined();
  });
});
