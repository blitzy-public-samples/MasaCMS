// `opt2-events` CLI of @opt2/platform/events: argument handling, sequential replay, stop conditions, failures and shutdown.
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, replayDeadLetters } from '../../src/events/cli.js';
import { REDACTED, validateLogRecord } from '../../src/logging/index.js';

type WriteCallback = (err?: Error | null) => void;
type LogLine = Record<string, unknown>;

interface FakeSubscription extends EventEmitter {
  name: string;
  options: unknown;
  close: ReturnType<typeof vi.fn>;
}

interface FakeMessage {
  data: Buffer;
  attributes: Record<string, string>;
  orderingKey?: string;
  publishTime: Date;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  createPublisher: vi.fn(),
  pubsubOptions: [] as unknown[],
  subscriptions: [] as FakeSubscription[],
  closed: [] as string[],
  closeError: undefined as Error | undefined,
  nackedByClose: [] as FakeMessage[],
}));

vi.mock('@google-cloud/pubsub', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  class FakePubSub {
    constructor(options: unknown) {
      state.pubsubOptions.push(options);
    }

    subscription(name: string, options: unknown): FakeSubscription {
      const delivered: FakeMessage[] = [];
      const subscription = Object.assign(new EventEmitter(), {
        name,
        options,
        close: vi.fn(async () => {
          state.closed.push('subscription');
          // Subscriber.close() nacks every message still unsettled; recorded apart so the spies count only the CLI's settles.
          state.nackedByClose.push(...delivered.filter((message) => message.ack.mock.calls.length + message.nack.mock.calls.length === 0));
          if (state.closeError) throw state.closeError;
        }),
      });
      subscription.on('message', (message: FakeMessage) => delivered.push(message));
      state.subscriptions.push(subscription);
      return subscription;
    }

    async close(): Promise<void> {
      state.closed.push('pubsub');
    }
  }
  return { ...(await importOriginal<typeof import('@google-cloud/pubsub')>()), PubSub: FakePubSub };
});

vi.mock('../../src/events/publisher.js', () => ({ createPublisher: state.createPublisher }));

const USAGE = 'usage: opt2-events replay --subscription <name> [--max <n>] [--idle-seconds <n>] [--project <id>]';
const SUBSCRIPTION = 'identity.people.person.changed.v1';
const TOPIC = 'people.person.changed.v1';
const SOURCE = `${SUBSCRIPTION}.dlq.replay`;
const PROJECT = 'opt2-unit';
// Assembled at run time, so no literal credential appears in source.
const SECRET = ['s3cr3t', 'events', 'cli', 'value'].join('-');

let stdout: string;
let stderr: string;
let publishRaw: ReturnType<typeof vi.fn>;

/** A `write` replacement that appends each chunk to `sink` and answers the callback with `error`. */
function capture(sink: (chunk: string) => void, error: Error | null = null) {
  return (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(error);
    return error === null;
  };
}

/** A pulled dead letter with spied ack and nack, published a minute before now unless `publishTime` is given. */
function deadLetter(
  data: string,
  attributes: Record<string, string>,
  orderingKey?: string,
  publishTime = new Date(Date.now() - 60_000),
): FakeMessage {
  return { data: Buffer.from(data, 'utf8'), attributes, orderingKey, publishTime, ack: vi.fn(), nack: vi.fn() };
}

/** A dead letter published after the run started, as a replay dead-lettered again is. */
function lateLetter(eventId: string): FakeMessage {
  return deadLetter('{}', { eventId }, undefined, new Date(Date.now() + 60_000));
}

/** The only subscription the CLI opened. */
function pulled(): FakeSubscription {
  expect(state.subscriptions).toHaveLength(1);
  return state.subscriptions[0] as FakeSubscription;
}

/** Lets queued promise callbacks run without moving the fake clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function replayArgs(...extra: string[]): string[] {
  return ['replay', '--subscription', SUBSCRIPTION, '--project', PROJECT, ...extra];
}

/** The one line written to stderr, checked against log-record.v1 and the CLI's service. */
function stderrRecord(): LogLine {
  expect(stderr.endsWith('\n')).toBe(true);
  const lines = stderr.slice(0, -1).split('\n');
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0] as string) as LogLine;
  expect(validateLogRecord(record)).toStrictEqual({ valid: true, errors: [] });
  expect(record).toMatchObject({ service: 'opt2-events' });
  return record;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  stdout = '';
  stderr = '';
  state.pubsubOptions.length = 0;
  state.subscriptions.length = 0;
  state.closed.length = 0;
  state.closeError = undefined;
  state.nackedByClose.length = 0;
  publishRaw = vi.fn(async () => 'message-id');
  state.createPublisher.mockReset();
  state.createPublisher.mockImplementation(() => ({
    publish: vi.fn(),
    publishRaw,
    close: vi.fn(async () => {
      state.closed.push('publisher');
    }),
  }));
  vi.spyOn(process.stdout, 'write').mockImplementation(capture((chunk) => (stdout += chunk)));
  vi.spyOn(process.stderr, 'write').mockImplementation(capture((chunk) => (stderr += chunk)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('opt2-events arguments', () => {
  it.each([[['--help']], [['-h']], [['replay', '--help']]])('prints the help on stdout and exits 0 for %j', async (argv) => {
    expect(await main(argv)).toBe(0);
    expect(stdout.startsWith(`${USAGE}\n\n`)).toBe(true);
    for (const flag of ['--subscription', '--max', '--idle-seconds', '--project', '-h, --help']) {
      expect(stdout).toContain(`\n  ${flag} `);
    }
    const environment = stdout.slice(stdout.indexOf('\nEnvironment:\n'));
    for (const key of ['GOOGLE_CLOUD_PROJECT', 'PUBSUB_EMULATOR_HOST']) expect(environment).toContain(`\n  ${key} `);
    expect(environment).toMatch(/\nExit codes: [^\n]+\n$/);
    expect(stderr).toBe('');
    expect(state.subscriptions).toHaveLength(0);
  });

  const MAX_PROBLEM = '--max must be a positive integer up to 9007199254740991';
  const SUBSCRIPTION_PROBLEM = '--subscription is not a <consumer>.<service>.<entity>.<event>.v<major> name';

  it.each([
    [[], 'missing subcommand'],
    [['frob'], 'unknown subcommand'],
    [[`frob-${SECRET}`], 'unknown subcommand'],
    [['replay', 'extra', '--subscription', SUBSCRIPTION, '--project', PROJECT], 'unknown subcommand'],
    [['replay', '--project', PROJECT], 'missing --subscription'],
    [replayArgs('--bogus'), 'unknown option'],
    [replayArgs(`--${SECRET}=x`), 'unknown option'],
    [replayArgs('--max'), 'an option is missing its value or was given one it does not take'],
    [['replay', '--subscription', 'identity', '--project', PROJECT], SUBSCRIPTION_PROBLEM],
    [['replay', '--subscription', `identity.${SECRET}`, '--project', PROJECT], SUBSCRIPTION_PROBLEM],
    [replayArgs('--max', '0'), MAX_PROBLEM],
    [replayArgs('--max', '1.5'), MAX_PROBLEM],
    [replayArgs('--max', '9007199254740993'), MAX_PROBLEM],
    [replayArgs('--max', `abc-${SECRET}`), MAX_PROBLEM],
    [replayArgs('--idle-seconds', '2147484'), '--idle-seconds must be a positive integer up to 2147483'],
    [['replay', '--subscription', SUBSCRIPTION], 'missing --project and GOOGLE_CLOUD_PROJECT is unset'],
  ])('answers %j with a usage line quoting no argument and exit code 2 before opening any client', async (argv, problem) => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    expect(await main(argv)).toBe(2);
    const record = stderrRecord();
    expect(record).toMatchObject({ severity: 'ERROR', message: `opt2-events: ${problem}; ${USAGE}` });
    expect(record).not.toHaveProperty('error');
    expect(stderr).not.toContain(SECRET);
    expect(stderr).not.toMatch(/frob|extra|bogus|identity|"0"|1\.5|9007199254740993|2147484/);
    expect(stdout).toBe('');
    expect(state.createPublisher).not.toHaveBeenCalled();
    expect(state.pubsubOptions).toHaveLength(0);
  });

  it('takes the project from GOOGLE_CLOUD_PROJECT and defaults to 10 idle seconds', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'opt2-env');
    const run = main(['replay', '--subscription', SUBSCRIPTION]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBe(0);
    expect(state.createPublisher).toHaveBeenCalledWith({ projectId: 'opt2-env' });
    expect(state.pubsubOptions).toEqual([{ projectId: 'opt2-env' }]);
    expect(JSON.parse(stdout)).toEqual({ subscription: SUBSCRIPTION, source: SOURCE, topic: TOPIC, replayed: 0, stoppedBy: 'idle' });
  });
});

describe('opt2-events replay', () => {
  it('republishes each dead letter in turn with its original attributes and ordering key, acking it after the publish', async () => {
    const releases: Array<() => void> = [];
    publishRaw.mockImplementation(() => new Promise<string>((done) => releases.push(() => done('id'))));
    const run = main(replayArgs('--idle-seconds', '2'));
    const subscription = pulled();
    expect(subscription.name).toBe(SOURCE);
    expect(subscription.options).toEqual({ flowControl: { maxMessages: 1000, allowExcessMessages: false } });

    const keyed = deadLetter('{"aggregateId":"from-data"}', { eventId: 'e1', reason: 'missing-tenant' }, 'agg-1');
    const forwarded = deadLetter('{"aggregateId":"agg-2"}', {
      eventId: 'e2',
      CloudPubSubDeadLetterSourceSubscription: SUBSCRIPTION,
      CloudPubSubDeadLetterSourceDeliveryCount: '5',
    }, '');
    const opaque = deadLetter('not json', { eventId: 'e3', reason: 'schema-invalid' });
    const keyless = deadLetter('{"aggregateId":""}', { eventId: 'e4' });
    for (const message of [keyed, forwarded, opaque, keyless]) subscription.emit('message', message);
    await settle();
    expect(publishRaw).toHaveBeenCalledTimes(1);
    expect(keyed.ack).not.toHaveBeenCalled();

    for (let index = 0; index < 4; index += 1) {
      releases[index]?.();
      await settle();
    }
    expect(publishRaw.mock.calls).toEqual([
      [TOPIC, { data: keyed.data, attributes: { eventId: 'e1' }, orderingKey: 'agg-1' }],
      [TOPIC, { data: forwarded.data, attributes: { eventId: 'e2' }, orderingKey: 'agg-2' }],
      [TOPIC, { data: opaque.data, attributes: { eventId: 'e3' }, orderingKey: undefined }],
      [TOPIC, { data: keyless.data, attributes: { eventId: 'e4' }, orderingKey: undefined }],
    ]);
    for (const message of [keyed, forwarded, opaque, keyless]) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.nack).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await run).toBe(0);
    expect(stdout).toBe(
      `${JSON.stringify({ subscription: SUBSCRIPTION, source: SOURCE, topic: TOPIC, replayed: 4, stoppedBy: 'idle' })}\n`,
    );
    expect(stderr).toBe('');
    expect(state.closed).toEqual(['subscription', 'publisher', 'pubsub']);
  });

  it('stops after --max replayed and returns later arrivals with a nack', async () => {
    const run = main(replayArgs('--max', '2'));
    const subscription = pulled();
    const messages = ['m1', 'm2', 'm3'].map((id) => deadLetter('{}', { eventId: id }));
    for (const message of messages) subscription.emit('message', message);
    expect(await run).toBe(0);
    await settle();
    expect(JSON.parse(stdout)).toMatchObject({ replayed: 2, stoppedBy: 'max' });
    expect(messages.map((message) => message.ack.mock.calls.length)).toEqual([1, 1, 0]);
    expect(messages.map((message) => message.nack.mock.calls.length)).toEqual([0, 0, 1]);
    expect(publishRaw).toHaveBeenCalledTimes(2);
    expect(state.closed).toEqual(['subscription', 'publisher', 'pubsub']);
  });

  it('counts the idle window from the last message handled', async () => {
    const run = main(replayArgs('--idle-seconds', '2'));
    await vi.advanceTimersByTimeAsync(1_500);
    pulled().emit('message', deadLetter('{}', { eventId: 'late' }));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(state.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ replayed: 1, stoppedBy: 'idle' });
  });

  it.each([
    [['--max', '1'], 2],
    [['--max', '999'], 1000],
    [[], 1000],
    [['--max', '5000'], 1000],
  ])('pulls with %j through a flow-control window of %i messages', async (extra, maxMessages) => {
    const run = main(replayArgs(...extra, '--idle-seconds', '1'));
    expect(pulled().options).toEqual({ flowControl: { maxMessages, allowExcessMessages: false } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await run).toBe(0);
  });

  it.each([[['late', 'early', 'early']], [['early', 'late', 'early']]])(
    'holds a letter published after the run started for close to nack, uncounted toward --max, in arrival order %j',
    async (kinds) => {
      const run = main(replayArgs('--max', '2'));
      const subscription = pulled();
      const messages = kinds.map((kind, index) => (kind === 'late' ? lateLetter(`m${index}`) : deadLetter('{}', { eventId: `m${index}` })));
      for (const message of messages) subscription.emit('message', message);
      expect(await run).toBe(0);
      const late = messages[kinds.indexOf('late')] as FakeMessage;
      const early = messages.filter((message) => message !== late);
      expect(JSON.parse(stdout)).toMatchObject({ replayed: 2, stoppedBy: 'max' });
      expect(publishRaw.mock.calls.map(([, message]) => (message as { attributes: unknown }).attributes)).toEqual(
        early.map((message) => message.attributes),
      );
      expect(early.map((message) => message.ack.mock.calls.length)).toEqual([1, 1]);
      expect([late.ack.mock.calls.length, late.nack.mock.calls.length]).toEqual([0, 0]);
      expect(state.nackedByClose).toEqual([late]);
    },
  );

  it.each([
    [[[1_000, 'late']], 2_000, 0],
    [[[500, 'early'], [1_500, 'late'], [2_400, 'late']], 2_500, 1],
  ] as Array<[Array<[number, 'early' | 'late']>, number, number]>)(
    'keeps the idle window of the letters to replay when letters published after the start arrive at %j',
    async (arrivals, stopsAt, replayed) => {
      const run = main(replayArgs('--idle-seconds', '2'));
      const subscription = pulled();
      const late: FakeMessage[] = [];
      let now = 0;
      for (const [at, kind] of arrivals) {
        await vi.advanceTimersByTimeAsync(at - now);
        now = at;
        const message = kind === 'late' ? lateLetter(`at-${at}`) : deadLetter('{}', { eventId: `at-${at}` });
        if (kind === 'late') late.push(message);
        subscription.emit('message', message);
      }
      await vi.advanceTimersByTimeAsync(stopsAt - 1 - now);
      expect(state.closed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await run).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ replayed, stoppedBy: 'idle' });
      expect(late.map((message) => message.ack.mock.calls.length + message.nack.mock.calls.length)).toEqual(late.map(() => 0));
      expect(state.nackedByClose).toEqual(late);
    },
  );

  it('nacks the dead letter, stops and exits 1 when its publish fails, logging the replayed count and only the gRPC status', async () => {
    const notFound = Object.assign(new Error(`5 NOT_FOUND: Topic not found ${SECRET}`), { code: 5, details: `Topic not found ${SECRET}`, metadata: {} });
    publishRaw.mockResolvedValueOnce('id').mockRejectedValueOnce(notFound);
    const run = main(replayArgs());
    const subscription = pulled();
    const first = deadLetter('{}', { eventId: 'ok' });
    const failing = deadLetter('{}', { eventId: 'bad' });
    const next = deadLetter('{}', { eventId: 'after' });
    for (const message of [first, failing, next]) subscription.emit('message', message);
    expect(await run).toBe(1);
    await settle();
    expect(stderrRecord()).toMatchObject({
      severity: 'CRITICAL',
      message: 'opt2-events: replay failed after 1 replayed',
      error: { type: 'ReplayError', message: 'gRPC status 5 NOT_FOUND' },
    });
    expect(stderr).not.toMatch(new RegExp(`Topic not found|${SECRET}|${SUBSCRIPTION}|${TOPIC}`));
    expect(stdout).toBe('');
    expect([first.ack.mock.calls.length, failing.ack.mock.calls.length, next.ack.mock.calls.length]).toEqual([1, 0, 0]);
    expect([failing.nack.mock.calls.length, next.nack.mock.calls.length]).toEqual([1, 1]);
    expect(publishRaw).toHaveBeenCalledTimes(2);
    expect(state.closed).toEqual(['subscription', 'publisher', 'pubsub']);
  });

  it('exits 1 when the pull subscription reports an error', async () => {
    const run = main(replayArgs());
    pulled().emit('error', new Error('Subscription does not exist'));
    expect(await run).toBe(1);
    expect(stderrRecord()).toMatchObject({
      severity: 'CRITICAL',
      message: 'opt2-events: replay failed after 0 replayed',
      error: { type: 'ReplayError', message: REDACTED },
    });
    expect(stderr).not.toMatch(new RegExp(`Subscription does not exist|${SUBSCRIPTION}`));
    expect(state.closed).toEqual(['subscription', 'publisher', 'pubsub']);
  });

  it('closes the publisher and the client even when the subscription fails to close', async () => {
    state.closeError = new Error('close failed');
    const run = replayDeadLetters({ subscription: SUBSCRIPTION, projectId: PROJECT, max: 1, idleSeconds: 1 });
    const outcome = expect(run).rejects.toThrow('close failed');
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(state.closed).toEqual(['subscription', 'publisher', 'pubsub']);
  });

  it('exits 1 when stdout rejects the summary', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(capture(() => undefined, new Error('write EPIPE')));
    const run = main(replayArgs('--idle-seconds', '1'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await run).toBe(1);
    expect(stderrRecord()).toMatchObject({ severity: 'CRITICAL', message: 'opt2-events: replay failed', error: { type: 'Error', message: REDACTED } });
  });
});
