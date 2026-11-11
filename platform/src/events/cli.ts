#!/usr/bin/env node
// `opt2-events` CLI of @opt2/platform/events: `replay` republishes a subscription's dead letters to its original topic.
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PubSub, type Message } from '@google-cloud/pubsub';
import { originalAttributes } from './dlq.js';
import { decodeEnvelopeData } from './envelope.js';
import { InvalidEventNameError, dlqReplaySubscriptionName, topicOfSubscription } from './naming.js';
import { createPublisher } from './publisher.js';

const USAGE = 'usage: opt2-events replay --subscription <name> [--max <n>] [--idle-seconds <n>] [--project <id>]';

const HELP = `${USAGE}

Pulls the dead letters of a subscription from <subscription>.dlq.replay, republishes each to the subscription's
topic with its original attributes and ordering key, then acks it. Prints one JSON summary line.
  --subscription <name>  consumer subscription, <consumer>.<service>.<entity>.<event>.v<major> (required)
  --max <n>              stop after n messages are replayed (default: 1000)
  --idle-seconds <n>     stop when no message arrived for n seconds (default: 10)
  --project <id>         Pub/Sub project (default: GOOGLE_CLOUD_PROJECT)
Exit codes: 0 done, 1 failed, 2 usage error.
`;

const DEFAULT_MAX = 1000;
const DEFAULT_IDLE_SECONDS = 10;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
// setTimeout fires at once for delays above 2^31 - 1 ms, so longer idle windows are refused.
const MAX_IDLE_SECONDS = Math.floor(0x7fffffff / 1000);

/** Options of {@link replayDeadLetters}. */
export interface ReplayOptions {
  /** Consumer subscription whose dead letters are replayed. */
  subscription: string;
  projectId: string;
  /** Stop after this many messages are replayed. */
  max: number;
  /** Stop when no message arrived for this many seconds. */
  idleSeconds: number;
}

/** Outcome of a replay run, printed by the CLI as one JSON line. */
export interface ReplaySummary {
  subscription: string;
  /** Pull subscription the dead letters were read from. */
  source: string;
  /** Original topic they were republished to. */
  topic: string;
  replayed: number;
  stoppedBy: 'max' | 'idle';
}

/** Raised when pulling or republishing fails; `replayed` counts the messages republished and acked before it. */
export class ReplayError extends Error {
  override readonly name = 'ReplayError';
  readonly replayed: number;

  constructor(message: string, replayed: number, cause: unknown) {
    super(`${message} after ${replayed} replayed: ${messageOf(cause)}`, { cause });
    this.replayed = replayed;
  }
}

/** Invalid command-line usage; answered on stderr with the usage line and exit code 2. */
class UsageError extends Error {}

/** Runs `opt2-events` with the arguments after the script path; returns 0 when done, 1 on a failure, 2 on a usage error. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const command = parseCommand(argv, process.env);
    if (command === 'help') {
      await writeStdout(HELP);
      return 0;
    }
    const summary = await replayDeadLetters(command);
    await writeStdout(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (err) {
    // InvalidEventNameError comes only from the subscription name, checked before any client is created.
    if (err instanceof UsageError || err instanceof InvalidEventNameError) {
      process.stderr.write(`opt2-events: ${err.message}; ${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`opt2-events: ${messageOf(err)}\n`);
    return 1;
  }
}

/** Parses the subcommand and its options; `'help'` when `--help` is given. */
function parseCommand(argv: string[], env: NodeJS.ProcessEnv): ReplayOptions | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        subscription: { type: 'string' },
        max: { type: 'string', default: String(DEFAULT_MAX) },
        'idle-seconds': { type: 'string', default: String(DEFAULT_IDLE_SECONDS) },
        project: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    return 'help';
  }
  if (positionals.length === 0) {
    throw new UsageError('missing subcommand');
  }
  if (positionals.length !== 1 || positionals[0] !== 'replay') {
    throw new UsageError(`unknown subcommand ${JSON.stringify(positionals.join(' '))}`);
  }
  if (!values.subscription) {
    throw new UsageError('missing --subscription');
  }
  const projectId = values.project || env['GOOGLE_CLOUD_PROJECT'];
  if (!projectId) {
    throw new UsageError('missing --project and GOOGLE_CLOUD_PROJECT is unset');
  }
  return {
    subscription: values.subscription,
    projectId,
    max: positiveInteger('--max', values.max, Number.MAX_SAFE_INTEGER),
    idleSeconds: positiveInteger('--idle-seconds', values['idle-seconds'], MAX_IDLE_SECONDS),
  };
}

/** The decimal positive integer `text`, at most `limit`. */
function positiveInteger(flag: string, text: string, limit: number): number {
  const value = Number(text);
  if (!POSITIVE_INTEGER.test(text) || value > limit) {
    throw new UsageError(`${flag} must be a positive integer up to ${limit}, got ${JSON.stringify(text)}`);
  }
  return value;
}

/** Republishes dead letters one at a time, acking each after its publish; stops at `max` replayed or after `idleSeconds` without a message. */
export async function replayDeadLetters(options: ReplayOptions): Promise<ReplaySummary> {
  const { subscription, projectId, max, idleSeconds } = options;
  const topic = topicOfSubscription(subscription);
  const source = dlqReplaySubscriptionName(subscription);
  const publisher = createPublisher({ projectId });
  const pubsub = new PubSub({ projectId });
  const pull = pubsub.subscription(source, { flowControl: { maxMessages: 1, allowExcessMessages: false } });
  let replayed = 0;
  try {
    const stoppedBy = await new Promise<ReplaySummary['stoppedBy']>((resolve, reject) => {
      let stopped = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let queued = 0;
      let chain: Promise<void> = Promise.resolve();

      const finish = (reason: ReplaySummary['stoppedBy']): void => {
        if (!stopped) {
          stopped = true;
          clearTimeout(idleTimer);
          resolve(reason);
        }
      };
      const fail = (err: unknown): void => {
        if (!stopped) {
          stopped = true;
          clearTimeout(idleTimer);
          reject(err instanceof ReplayError ? err : new ReplayError(`replay from ${source} failed`, replayed, err));
        }
      };
      const armIdle = (): void => {
        idleTimer = setTimeout(() => finish('idle'), idleSeconds * 1000);
      };

      const handle = async (message: Message): Promise<void> => {
        if (stopped) {
          // Arrived after the run ended; returned to the subscription for a later run.
          message.nack();
          return;
        }
        try {
          await publisher.publishRaw(topic, {
            data: message.data,
            attributes: originalAttributes(message.attributes),
            orderingKey: orderingKeyOf(message),
          });
        } catch (err) {
          message.nack();
          throw new ReplayError(`publish to ${topic} failed`, replayed, err);
        }
        message.ack();
        replayed += 1;
        if (replayed >= max) {
          finish('max');
        }
      };

      pull.on('message', (message: Message) => {
        clearTimeout(idleTimer);
        queued += 1;
        chain = chain
          .then(() => handle(message))
          .catch(fail)
          .finally(() => {
            queued -= 1;
            if (queued === 0 && !stopped) {
              armIdle();
            }
          });
      });
      pull.on('error', (err: Error) => fail(new ReplayError(`pull from ${source} failed`, replayed, err)));
      armIdle();
    });
    return { subscription, source, topic, replayed, stoppedBy };
  } finally {
    // Closing the subscription first flushes the acks and nacks every message still held.
    try {
      await pull.close();
    } finally {
      try {
        await publisher.close();
      } finally {
        await pubsub.close();
      }
    }
  }
}

/** The message's ordering key, else the `aggregateId` of the JSON envelope in its data. */
function orderingKeyOf(message: Message): string | undefined {
  if (message.orderingKey) {
    return message.orderingKey;
  }
  let decoded: unknown;
  try {
    decoded = decodeEnvelopeData(message.data);
  } catch {
    // Not JSON: the dead letter is republished without an ordering key.
    return undefined;
  }
  const aggregateId = typeof decoded === 'object' && decoded !== null ? (decoded as Record<string, unknown>)['aggregateId'] : undefined;
  return typeof aggregateId === 'string' && aggregateId !== '' ? aggregateId : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writes to stdout and resolves once the chunk is flushed. */
function writeStdout(text: string): Promise<void> {
  return new Promise((done, fail) => {
    process.stdout.write(text, (err) => {
      if (err) {
        fail(err);
      } else {
        done();
      }
    });
  });
}

// npm `.bin` shims are symlinks and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(await realpath(entry)).href) {
  // Explicit exit: a client that failed mid-close may leave gRPC handles open.
  process.exit(await main());
}
