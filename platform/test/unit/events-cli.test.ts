// `opt2-events` CLI of @opt2/platform/events: argument handling, sequential replay, stop conditions, failures and shutdown.
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, replayDeadLetters } from '../../src/events/cli.js';

type WriteCallback = (err?: Error | null) => void;

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
const SUBSCRIPTION = 'timesheets.people.person.archived.v1';
const TOPIC = 'people.person.archived.v1';
const SOURCE = `${SUBSCRIPTION}.dlq.replay`;
const PROJECT = 'opt2-unit';

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

  it.each([
    [[], 'missing subcommand'],
    [['frob'], 'unknown subcommand "frob"'],
    [['replay', 'extra', '--subscription', SUBSCRIPTION, '--project', PROJECT], 'unknown subcommand "replay extra"'],
    [['replay', '--project', PROJECT], 'missing --subscription'],
    [replayArgs('--bogus'), /^Unknown option '--bogus'/],
    [['replay', '--subscription', 'timesheets', '--project', PROJECT], /^Invalid event name "timesheets"/],
    [replayArgs('--max', '0'), '--max must be a positive integer up to 9007199254740991, got "0"'],
    [replayArgs('--max', '1.5'), '--max must be a positive integer up to 9007199254740991, got "1.5"'],
    [replayArgs('--max', '9007199254740993'), /^--max must be a positive integer/],
    [replayArgs('--idle-seconds', '2147484'), '--idle-seconds must be a positive integer up to 2147483, got "2147484"'],
    [['replay', '--subscription', SUBSCRIPTION], 'missing --project and GOOGLE_CLOUD_PROJECT is unset'],
  ])('answers %j with a usage error and exit code 2 before opening any client', async (argv, message) => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    expect(await main(argv)).toBe(2);
    const prefix = 'opt2-events: ';
    const suffix = `; ${USAGE}\n`;
    expect(stderr.startsWith(prefix)).toBe(true);
    expect(stderr.endsWith(suffix)).toBe(true);
    const text = stderr.slice(prefix.length, -suffix.length);
    if (typeof message === 'string') {
      expect(text).toBe(message);
    } else {
      expect(text).toMatch(message);
    }
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

  it('nacks the dead letter, stops and exits 1 when its publish fails', async () => {
    publishRaw.mockResolvedValueOnce('id').mockRejectedValueOnce(new Error('5 NOT_FOUND: Topic not found'));
    const run = main(replayArgs());
    const subscription = pulled();
    const first = deadLetter('{}', { eventId: 'ok' });
    const failing = deadLetter('{}', { eventId: 'bad' });
    const next = deadLetter('{}', { eventId: 'after' });
    for (const message of [first, failing, next]) subscription.emit('message', message);
    expect(await run).toBe(1);
    await settle();
    expect(stderr).toBe(`opt2-events: publish to ${TOPIC} failed after 1 replayed: 5 NOT_FOUND: Topic not found\n`);
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
    expect(stderr).toBe(`opt2-events: pull from ${SOURCE} failed after 0 replayed: Subscription does not exist\n`);
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
    expect(stderr).toBe('opt2-events: write EPIPE\n');
  });
});
