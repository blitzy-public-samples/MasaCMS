/** Pub/Sub, queue and service-call topology derived from the contracts, for the local emulator or the cloud variables file. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PubSub } from '@google-cloud/pubsub';
import { LOCAL_SECRET_FILES, serviceRole } from '@opt2/platform/auth';
import {
  consumerOfSubscription,
  dlqReplaySubscriptionName,
  dlqTopicName,
  parseTopic,
  PUSH_PATH_PREFIX,
  pushPath,
  readTopicSchema,
  subscriptionName,
  topicMeta,
  topicOfSubscription,
  type EventKind,
} from '@opt2/platform/events';
import { z } from '@opt2/platform/service-kit';
import { queueTopology, type RetryPolicy } from '@opt2/platform/tasks';
import { parse as parseYaml } from 'yaml';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { REPO_ROOT, type EnvLike } from '../lib/paths.js';
import { stableStringify } from '../lib/report.js';
import { loadPorts, PACKAGE_NAMES, type PackageName } from './ports.js';
import { readSecret } from './secrets.js';

/** Which packages a topology covers: every locally started package, or the deployed Cloud Run services. */
export type TopologyTarget = 'local' | 'cloud';

/** Delivery attempts before Pub/Sub forwards a message to the subscription's dead-letter topic. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Redelivery backoff of a push subscription, in whole seconds. */
export interface PushRetryPolicy {
  minimumBackoff: { seconds: number };
  maximumBackoff: { seconds: number };
}

/** Backoff between push redeliveries, so a consumer outage spends the delivery attempts over minutes rather than seconds. */
export const PUSH_RETRY_POLICY: PushRetryPolicy = { minimumBackoff: { seconds: 10 }, maximumBackoff: { seconds: 600 } };

/** Repository-relative path of the generated cloud variables file. */
export const TFVARS_RELATIVE_PATH = 'infra/terraform/envs/plan/topology.auto.tfvars.json';

/** Repository-relative path of the plan inputs holding `cloud_run_services`. */
export const PLAN_TFVARS_RELATIVE_PATH = 'infra/terraform/envs/plan/plan.tfvars';

/** Emulator project used when `GOOGLE_CLOUD_PROJECT` is unset. */
export const DEFAULT_PROJECT_ID = 'opt2-local';

/** A topic and the service whose event schema declares it. */
export interface TopicEntry {
  producer: string;
  kind: EventKind;
}

/** An ordered push subscription, keyed by `<consumer>.<topic>`, with its dead-letter topic and DLQ replay pull subscription. */
export interface SubscriptionEntry {
  topic: string;
  consumer: string;
  push_path: string;
  ordering: true;
  dead_letter_topic: string;
  max_delivery_attempts: typeof MAX_DELIVERY_ATTEMPTS;
  dlq_replay_subscription: string;
}

/** A task queue; `retry` is the queue's retry policy with snake_case keys. */
export interface QueueEntry {
  creators: string[];
  target_service: string;
  target_path: string;
  recurring_interval_s: number | null;
  deadline_s: number;
  retry: Record<string, number>;
}

/** Everything the topology generator derives for one target; snake_case keys are the cloud variable attributes. */
export interface Topology {
  target: TopologyTarget;
  packages: PackageName[];
  topics: Record<string, TopicEntry>;
  subscriptions: Record<string, SubscriptionEntry>;
  queues: Record<string, QueueEntry>;
  /** Caller to sorted callees, the invoker bindings of each callee. */
  service_calls: Record<string, string[]>;
}

/** The four variables written to `topology.auto.tfvars.json`. */
export type TopologyTfvars = Pick<Topology, 'topics' | 'subscriptions' | 'queues' | 'service_calls'>;

/** A contract, event schema or plan input that cannot yield a consistent topology; the message names the file at fault. */
export class TopologyError extends Error {
  override name = 'TopologyError';
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const OperationSchema = z.looseObject({ 'x-opt2-requires': z.array(z.string()).optional() });

const PathItemSchema = z.looseObject({
  get: OperationSchema.optional(),
  put: OperationSchema.optional(),
  post: OperationSchema.optional(),
  delete: OperationSchema.optional(),
  options: OperationSchema.optional(),
  head: OperationSchema.optional(),
  patch: OperationSchema.optional(),
  trace: OperationSchema.optional(),
});

const ContractSchema = z.looseObject({
  paths: z.record(z.string(), PathItemSchema).optional(),
  'x-opt2-calls': z.array(z.string()).optional(),
});

type Contract = z.infer<typeof ContractSchema>;

interface PackageContract {
  name: PackageName;
  file: string;
  contract: Contract;
}

const PACKAGE_SET: ReadonlySet<string> = new Set(PACKAGE_NAMES);

// A string literal is kept whole, so `#` or `//` inside a value never starts a comment.
const HCL_STRING_OR_COMMENT = /("(?:[^"\\\n]|\\.)*")|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const HCL_STRING = /"((?:[^"\\\n]|\\.)*)"/g;
const CLOUD_RUN_SERVICES = /^[ \t]*cloud_run_services[ \t]*=[ \t]*\[([^\]]*)\]/gm;

const GRPC_ALREADY_EXISTS = 6;

function isPackageName(value: string): value is PackageName {
  return PACKAGE_SET.has(value);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => compareCodeUnits(a, b));
}

/** Runs `read`, re-raising any failure as a TopologyError that names `file`. */
function fromInput<T>(file: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof TopologyError) throw err;
    throw new TopologyError(`${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** The `cloud_run_services` list of `plan.tfvars`, in file order; throws TopologyError on a missing, empty or invalid list. */
export function deployedServices(repoRoot: string = REPO_ROOT): PackageName[] {
  const file = PLAN_TFVARS_RELATIVE_PATH;
  const text = fromInput(file, () => readFileSync(path.join(repoRoot, file), 'utf8'));
  const code = text.replace(HCL_STRING_OR_COMMENT, (_match: string, literal: string | undefined) => literal ?? ' ');
  const lists = [...code.matchAll(CLOUD_RUN_SERVICES)];
  if (lists.length !== 1) {
    throw new TopologyError(`${file}: expected one cloud_run_services list, found ${lists.length}`);
  }
  const body = lists[0]?.[1] ?? '';
  if (body.replace(HCL_STRING, '').replace(/[\s,]/g, '') !== '') {
    throw new TopologyError(`${file}: cloud_run_services must list only quoted package names`);
  }
  const names = [...body.matchAll(HCL_STRING)].map((match) => match[1] ?? '');
  if (names.length === 0) throw new TopologyError(`${file}: cloud_run_services is empty`);
  const seen = new Set<string>();
  for (const name of names) {
    if (!isPackageName(name)) {
      throw new TopologyError(`${file}: cloud_run_services names ${JSON.stringify(name)}, not one of ${PACKAGE_NAMES.join(', ')}`);
    }
    if (seen.has(name)) throw new TopologyError(`${file}: cloud_run_services lists ${name} twice`);
    seen.add(name);
  }
  return names as PackageName[];
}

/** Repository-relative OpenAPI contract of a package; `web` has none, because it reaches services only through the gateway. */
function contractFile(name: PackageName): string | undefined {
  if (name === 'web') return undefined;
  return name === 'gateway' || name === 'migration'
    ? `${name}/contracts/openapi.yaml`
    : `services/${name}/contracts/openapi.yaml`;
}

function readContract(repoRoot: string, name: PackageName, file: string): Contract {
  const absolute = path.join(repoRoot, file);
  if (!existsSync(absolute)) throw new TopologyError(`${file}: the contract of ${name} does not exist`);
  const parsed = fromInput(file, () => ContractSchema.safeParse(parseYaml(readFileSync(absolute, 'utf8'))));
  if (!parsed.success) {
    throw new TopologyError(`${file}: does not match the contract fields the topology reads:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Every topic with an event schema under `services/<producer>/contracts/events/`, in sorted order. */
function discoverTopics(repoRoot: string): Map<string, TopicEntry> {
  const topics = new Map<string, TopicEntry>();
  const servicesDir = path.join(repoRoot, 'services');
  if (!existsSync(servicesDir)) return topics;
  const producers = readdirSync(servicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnits);
  for (const producer of producers) {
    const eventsDir = `services/${producer}/contracts/events`;
    const absoluteDir = path.join(repoRoot, eventsDir);
    if (!existsSync(absoluteDir)) continue;
    const schemas = readdirSync(absoluteDir)
      .filter((name) => name.endsWith('.json'))
      .sort(compareCodeUnits);
    for (const schema of schemas) {
      const file = `${eventsDir}/${schema}`;
      const topic = schema.slice(0, -'.json'.length);
      const { service } = fromInput(file, () => parseTopic(topic));
      if (service !== producer) {
        throw new TopologyError(`${file}: topic ${topic} belongs to ${service}, not to its folder's service ${producer}`);
      }
      const { kind } = fromInput(file, () => topicMeta(readTopicSchema(path.join(absoluteDir, schema))));
      topics.set(topic, { producer, kind });
    }
  }
  return topics;
}

function retryAttributes(policy: RetryPolicy): Record<string, number> {
  return Object.fromEntries(
    Object.entries(policy).map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]),
  );
}

function deriveSubscriptions(
  contracts: readonly PackageContract[],
  discovered: ReadonlyMap<string, TopicEntry>,
  included: ReadonlySet<string>,
): Record<string, SubscriptionEntry> {
  const subscriptions: Record<string, SubscriptionEntry> = {};
  for (const { name, file, contract } of contracts) {
    const routes = Object.keys(contract.paths ?? {})
      .filter((route) => route.startsWith(PUSH_PATH_PREFIX))
      .sort(compareCodeUnits);
    for (const route of routes) {
      const declared = route.slice(PUSH_PATH_PREFIX.length);
      // Both helpers validate the whole name, so the subscription and push path rebuilt below equal the declared route.
      const { consumer, topic } = fromInput(file, () => ({
        consumer: consumerOfSubscription(declared),
        topic: topicOfSubscription(declared),
      }));
      if (consumer !== name) {
        throw new TopologyError(`${file}: push route ${route} belongs to consumer ${consumer}, not ${name}`);
      }
      const producer = discovered.get(topic)?.producer;
      if (producer === undefined) {
        throw new TopologyError(`${file}: push route ${route} names topic ${topic}, which has no event schema`);
      }
      if (!included.has(producer)) continue;
      const subscription = subscriptionName(name, topic);
      subscriptions[subscription] = {
        topic,
        consumer: name,
        push_path: pushPath(subscription),
        ordering: true,
        dead_letter_topic: dlqTopicName(subscription),
        max_delivery_attempts: MAX_DELIVERY_ATTEMPTS,
        dlq_replay_subscription: dlqReplaySubscriptionName(subscription),
      };
    }
  }
  return subscriptions;
}

function deriveQueues(target: TopologyTarget, included: ReadonlySet<string>): Record<string, QueueEntry> {
  const queues: Record<string, QueueEntry> = {};
  for (const queue of queueTopology({ target })) {
    const creators = queue.creators.filter((creator) => included.has(creator)).sort(compareCodeUnits);
    if (!included.has(queue.targetService) || creators.length === 0) continue;
    queues[queue.name] = {
      creators,
      target_service: queue.targetService,
      target_path: queue.targetPath,
      recurring_interval_s: queue.intervalS ?? null,
      deadline_s: queue.deadlineS,
      retry: retryAttributes(queue.retry),
    };
  }
  return queues;
}

/** Caller to callees from `x-opt2-calls` and each operation's `service:<caller>` requirement, within the target's packages. */
function deriveServiceCalls(contracts: readonly PackageContract[], included: ReadonlySet<string>): Record<string, string[]> {
  const calls = new Map<string, Set<string>>();
  const addCall = (caller: string, callee: string): void => {
    if (caller === callee || !included.has(caller) || !included.has(callee)) return;
    const callees = calls.get(caller) ?? new Set<string>();
    callees.add(callee);
    calls.set(caller, callees);
  };
  const callerOfRole = new Map([...included].map((name) => [serviceRole(name), name]));
  for (const { name, file, contract } of contracts) {
    for (const callee of contract['x-opt2-calls'] ?? []) {
      if (!isPackageName(callee)) {
        throw new TopologyError(`${file}: x-opt2-calls names ${JSON.stringify(callee)}, not one of ${PACKAGE_NAMES.join(', ')}`);
      }
      addCall(name, callee);
    }
    for (const item of Object.values(contract.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        for (const role of item[method]?.['x-opt2-requires'] ?? []) {
          const caller = callerOfRole.get(role);
          if (caller !== undefined) addCall(caller, name);
        }
      }
    }
  }
  const serviceCalls: Record<string, string[]> = {};
  for (const caller of [...calls.keys()].sort(compareCodeUnits)) {
    serviceCalls[caller] = [...(calls.get(caller) ?? [])].sort(compareCodeUnits);
  }
  return serviceCalls;
}

/** Derives the topology of `target` from the event schemas and API contracts under `repoRoot`; reads files only. */
export function deriveTopology(target: TopologyTarget, repoRoot: string = REPO_ROOT): Topology {
  const packages = [...(target === 'local' ? PACKAGE_NAMES : deployedServices(repoRoot))].sort(compareCodeUnits);
  const included: ReadonlySet<string> = new Set(packages);
  const discovered = discoverTopics(repoRoot);
  const contracts = packages.flatMap((name): PackageContract[] => {
    const file = contractFile(name);
    return file === undefined ? [] : [{ name, file, contract: readContract(repoRoot, name, file) }];
  });

  const topics: Record<string, TopicEntry> = {};
  for (const [topic, entry] of discovered) {
    if (included.has(entry.producer)) topics[topic] = entry;
  }

  return {
    target,
    packages,
    topics,
    subscriptions: deriveSubscriptions(contracts, discovered, included),
    queues: deriveQueues(target, included),
    service_calls: deriveServiceCalls(contracts, included),
  };
}

/** The four cloud variables of a topology. */
export function toTfvars(topology: Topology): TopologyTfvars {
  const { topics, subscriptions, queues, service_calls } = topology;
  return { topics, subscriptions, queues, service_calls };
}

/** Byte-stable JSON text of `topology.auto.tfvars.json`: sorted keys, sorted arrays, two-space indent, one trailing newline. */
export function renderTfvars(topology: Topology): string {
  return stableStringify(toTfvars(topology));
}

/** Dead-letter policy of a push subscription; the topic is fully qualified. */
export interface DeadLetterPolicy {
  deadLetterTopic: string;
  maxDeliveryAttempts: number;
}

/** Settings a push subscription is created with. */
export interface PushSubscriptionOptions {
  pushConfig: { pushEndpoint: string };
  enableMessageOrdering: boolean;
  deadLetterPolicy: DeadLetterPolicy;
  retryPolicy: PushRetryPolicy;
}

/** The subscription methods used to bring an existing push or DLQ replay subscription up to date. */
export interface SubscriptionHandleLike {
  getMetadata(): Promise<[{ topic?: string | null; enableMessageOrdering?: boolean | null }, ...unknown[]]>;
  modifyPushConfig(config: { pushEndpoint: string }): Promise<unknown>;
  setMetadata(metadata: { deadLetterPolicy: DeadLetterPolicy; retryPolicy: PushRetryPolicy }): Promise<unknown>;
  delete(): Promise<unknown>;
}

/** The emulator client surface `applyLocalTopology` uses; a `PubSub` from `@google-cloud/pubsub` satisfies it. */
export interface PubSubLike {
  createTopic(name: string): Promise<unknown>;
  topic(name: string): { createSubscription(name: string, options?: PushSubscriptionOptions): Promise<unknown> };
  subscription(name: string): SubscriptionHandleLike;
}

/** Inputs of {@link applyLocalTopology}; `emulatorHost` is required unless a client is injected. */
export interface LocalApplyOptions {
  emulatorHost?: string;
  projectId: string;
  pushKey: string;
  /** Local port of each consuming package. */
  ports: Readonly<Record<string, number>>;
  pubsub?: PubSubLike;
}

/** Resources created by {@link applyLocalTopology}; `updated` counts existing push subscriptions brought to the derived settings. */
export interface LocalApplyResult {
  topics: number;
  dlqTopics: number;
  pushSubscriptions: number;
  replaySubscriptions: number;
  updated: number;
}

/** Runs `create`; false when the resource already exists. */
async function createIfAbsent(create: () => Promise<unknown>): Promise<boolean> {
  try {
    await create();
    return true;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === GRPC_ALREADY_EXISTS) return false;
    throw err;
  }
}

async function reconcileEmulator(client: PubSubLike, topology: Topology, opts: LocalApplyOptions): Promise<LocalApplyResult> {
  const result: LocalApplyResult = { topics: 0, dlqTopics: 0, pushSubscriptions: 0, replaySubscriptions: 0, updated: 0 };
  const topicPath = (topic: string): string => `projects/${opts.projectId}/topics/${topic}`;

  for (const topic of Object.keys(topology.topics).sort(compareCodeUnits)) {
    if (await createIfAbsent(() => client.createTopic(topic))) result.topics += 1;
  }
  for (const [name, subscription] of sortedEntries(topology.subscriptions)) {
    const port = opts.ports[subscription.consumer];
    if (port === undefined) throw new TopologyError(`no local port for ${subscription.consumer}, the consumer of ${name}`);
    if (await createIfAbsent(() => client.createTopic(subscription.dead_letter_topic))) result.dlqTopics += 1;
    const replay = () => client.topic(subscription.dead_letter_topic).createSubscription(subscription.dlq_replay_subscription);
    if (await createIfAbsent(replay)) {
      result.replaySubscriptions += 1;
    } else {
      const existingReplay = client.subscription(subscription.dlq_replay_subscription);
      const [replayMetadata] = await existingReplay.getMetadata();
      if (replayMetadata.topic !== topicPath(subscription.dead_letter_topic)) {
        // Deleting a DLQ topic detaches its replay subscription for good; only a new subscription receives its dead letters.
        await existingReplay.delete();
        await replay();
        result.replaySubscriptions += 1;
      }
    }

    const options: PushSubscriptionOptions = {
      pushConfig: {
        pushEndpoint: `http://127.0.0.1:${port}${subscription.push_path}?key=${encodeURIComponent(opts.pushKey)}`,
      },
      enableMessageOrdering: subscription.ordering,
      deadLetterPolicy: {
        deadLetterTopic: topicPath(subscription.dead_letter_topic),
        maxDeliveryAttempts: subscription.max_delivery_attempts,
      },
      retryPolicy: PUSH_RETRY_POLICY,
    };
    const create = () => client.topic(subscription.topic).createSubscription(name, options);
    if (await createIfAbsent(create)) {
      result.pushSubscriptions += 1;
      continue;
    }
    const existing = client.subscription(name);
    const [metadata] = await existing.getMetadata();
    if (metadata.enableMessageOrdering !== options.enableMessageOrdering || metadata.topic !== topicPath(subscription.topic)) {
      // Ordering and the topic are fixed when a subscription is created.
      await existing.delete();
      await create();
    } else {
      // Restores push delivery after a drain switched the subscription to pull.
      await existing.modifyPushConfig(options.pushConfig);
      await existing.setMetadata({ deadLetterPolicy: options.deadLetterPolicy, retryPolicy: options.retryPolicy });
    }
    result.updated += 1;
  }
  return result;
}

/** Creates or updates the local topology's topics and subscriptions on the Pub/Sub emulator, never on Google Cloud. */
export async function applyLocalTopology(topology: Topology, opts: LocalApplyOptions): Promise<LocalApplyResult> {
  if (topology.target !== 'local') {
    throw new TopologyError(`only a local topology is applied to the emulator, got target ${topology.target}`);
  }
  if (opts.pubsub !== undefined) return reconcileEmulator(opts.pubsub, topology, opts);
  if (opts.emulatorHost === undefined || opts.emulatorHost === '') {
    throw new TopologyError('PUBSUB_EMULATOR_HOST is not set; the local topology is applied only to the Pub/Sub emulator');
  }
  const pubsubModule = await import('@google-cloud/pubsub');
  const client: PubSub = new pubsubModule.PubSub({
    projectId: opts.projectId,
    apiEndpoint: opts.emulatorHost,
    emulatorMode: true,
  });
  try {
    return await reconcileEmulator(client, topology, opts);
  } finally {
    await client.close();
  }
}

const USAGE =
  'usage: tsx src/repro/pubsub-topology.ts --target local|cloud [--out <file>] [--check] [--dry-run] [--repo-root <dir>]';
const HELP = `${USAGE}

Derives topics, push subscriptions, DLQs, queues and the service_calls map from the event and API contracts
(services/*/contracts, gateway/contracts, migration/contracts).

Options:
  --target local|cloud  required. local: create or update the topics and subscriptions, for every package up.sh
                        starts, on the Pub/Sub emulator.
                        cloud: write ${TFVARS_RELATIVE_PATH} for the deployed
                        services listed in ${PLAN_TFVARS_RELATIVE_PATH}
  --out <file>          cloud only: write <file> instead of that variables file
  --check               cloud only: compare with the file instead of writing it; exit 1 on a difference
  --dry-run             local only: report the topology without contacting the emulator
  --repo-root <dir>     tree holding the contracts, plan.tfvars and the variables file (default: this checkout)
  --help                print this help and exit 0

Environment (local):
  PUBSUB_EMULATOR_HOST  emulator host:port, required unless --dry-run (e.g. localhost:8085)
  GOOGLE_CLOUD_PROJECT  emulator project (default: ${DEFAULT_PROJECT_ID})
  OPT2_STATE_DIR        state directory (default: $HOME/.opt2/state)

Requires (local, unless --dry-run): \${OPT2_STATE_DIR}/secrets/${LOCAL_SECRET_FILES.pubsubPushKey}, generated by
npm run repro:secrets. Each push endpoint carries that key and the consumer's port from harness/repro/ports.env.

Output: one JSON summary line on stdout. Exit: 0 ok, 1 failure or --check difference, 2 usage error.

Examples (from harness/):
  PUBSUB_EMULATOR_HOST=localhost:8085 npm run topology -- --target local
  npm run topology -- --target local --dry-run
  npm run topology -- --target cloud --check`;

/** Injection points of {@link main}; each defaults to the real process. */
export interface TopologyCliOptions {
  env?: EnvLike;
  pubsub?: PubSubLike;
  ports?: Readonly<Record<string, number>>;
}

function counts(topology: Topology): Record<string, number> {
  return {
    topics: Object.keys(topology.topics).length,
    subscriptions: Object.keys(topology.subscriptions).length,
    queues: Object.keys(topology.queues).length,
    callers: Object.keys(topology.service_calls).length,
  };
}

async function writeOrCheck(topology: Topology, file: string, check: boolean): Promise<CliOutcome> {
  const text = renderTfvars(topology);
  if (check) {
    const current = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    const changed = current !== text;
    return {
      code: changed ? 1 : 0,
      summary: { target: topology.target, path: file, changed, ...(current === undefined ? { missing: true } : {}), ...counts(topology) },
    };
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return { summary: { target: topology.target, path: file, ...counts(topology) } };
}

/** CLI entry: `--target cloud` writes or `--check`s the variables file; `--target local` configures the emulator or, with `--dry-run`, reports. */
export async function main(argv: string[], opts: TopologyCliOptions = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: {
      target: { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'repo-root': { type: 'string' },
    },
    usage: USAGE,
    help: HELP,
  });
  const target = values.target;
  if (target !== 'local' && target !== 'cloud') throw new UsageError('--target must be local or cloud', USAGE);
  if (target === 'cloud' && values['dry-run'] === true) throw new UsageError('--dry-run applies to --target local only', USAGE);
  if (target === 'local' && (values.out !== undefined || values.check === true)) {
    throw new UsageError('--out and --check apply to --target cloud only', USAGE);
  }
  const repoRoot = values['repo-root'] === undefined ? REPO_ROOT : path.resolve(values['repo-root']);
  const topology = deriveTopology(target, repoRoot);

  if (target === 'cloud') {
    const file = values.out === undefined ? path.join(repoRoot, TFVARS_RELATIVE_PATH) : path.resolve(values.out);
    return writeOrCheck(topology, file, values.check === true);
  }

  const queues = Object.keys(topology.queues).sort(compareCodeUnits);
  if (values['dry-run'] === true) {
    return {
      summary: {
        target,
        dryRun: true,
        packages: topology.packages,
        topics: Object.keys(topology.topics).sort(compareCodeUnits),
        subscriptions: Object.fromEntries(sortedEntries(topology.subscriptions).map(([name, sub]) => [name, sub.push_path])),
        queues,
        serviceCalls: topology.service_calls,
      },
    };
  }
  const env = opts.env ?? process.env;
  const projectId = env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID;
  const created = await applyLocalTopology(topology, {
    emulatorHost: env.PUBSUB_EMULATOR_HOST,
    projectId,
    pushKey: readSecret(LOCAL_SECRET_FILES.pubsubPushKey, { env }),
    ports: opts.ports ?? loadPorts(),
    pubsub: opts.pubsub,
  });
  // Local queues need no emulator resource: their rows live in each creator's schema.
  return { summary: { target, projectId, emulatorHost: env.PUBSUB_EMULATOR_HOST, created, queues } };
}

if (isMainModule(import.meta.url)) {
  await runCli(main);
}
