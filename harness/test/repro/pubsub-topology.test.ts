import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  dlqReplaySubscriptionName,
  dlqTopicName,
  parseTopic,
  PUSH_PATH_PREFIX,
  pushPath,
  subscriptionName,
} from '@opt2/platform/events';
import { outboxSweepQueue, queueTopology, SITEMONITOR_QUEUE } from '@opt2/platform/tasks';
import { parse as parseYaml } from 'yaml';

import { runCli } from '../../src/lib/cli.js';
import { REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';
import { stableStringify } from '../../src/lib/report.js';
import { loadPorts, PACKAGE_NAMES, type PackageName } from '../../src/repro/ports.js';
import {
  applyLocalTopology,
  deployedServices,
  deriveTopology,
  main,
  PLAN_TFVARS_RELATIVE_PATH,
  renderTfvars,
  TFVARS_RELATIVE_PATH,
  toTfvars,
  TopologyError,
  type LocalApplyResult,
  type PubSubLike,
  type PushSubscriptionOptions,
  type SubscriptionHandleLike,
  type Topology,
  type TopologyCliOptions,
  type TopologyTarget,
} from '../../src/repro/pubsub-topology.js';
import { ensureLocalSecrets, readSecret } from '../../src/repro/secrets.js';

const FIXTURES = new URL('../fixtures/contract-samples/', import.meta.url);

/** Fixture file, relative to FIXTURES, and its repository-relative destination in a temporary tree. */
const FIXTURE_COPIES: readonly (readonly [string, string])[] = [
  ['openapi/people.yaml', 'services/people/contracts/openapi.yaml'],
  ['openapi/timesheets.yaml', 'services/timesheets/contracts/openapi.yaml'],
  ['openapi/stub.yaml', 'services/stub/contracts/openapi.yaml'],
  ['openapi/identity.yaml', 'services/identity/contracts/openapi.yaml'],
  ['events/people.person.archived.v1.json', 'services/people/contracts/events/people.person.archived.v1.json'],
  ['events/people.person.changed.v1.json', 'services/people/contracts/events/people.person.changed.v1.json'],
  ['events/stub.note.created.v1.json', 'services/stub/contracts/events/stub.note.created.v1.json'],
  ['plan.tfvars.sample', PLAN_TFVARS_RELATIVE_PATH],
];

/** The `cloud_run_services` list of `plan.tfvars.sample`, in file order. */
const SAMPLE_DEPLOYED = [
  'gateway',
  'web',
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
  'migration',
];

const ARCHIVED = 'people.person.archived.v1';
const CHANGED = 'people.person.changed.v1';
const NOTE_CREATED = 'stub.note.created.v1';

/** Consumer and topic of each push route the fixture contracts declare. */
const PUSH_ROUTES: readonly (readonly [PackageName, string])[] = [
  ['timesheets', ARCHIVED],
  ['identity', CHANGED],
  ['stub', NOTE_CREATED],
];

const PUSH_KEY_FILE = 'pubsub-push-key';
const PROJECT = 'opt2-topology-test';
const COMMAND = 'topology';
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

const createdDirs: string[] = [];
const pendingDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(pendingDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  expect(createdDirs.filter((dir) => existsSync(dir))).toEqual([]);
});

/** A new directory under the OS temp dir, removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  pendingDirs.push(dir);
  return dir;
}

async function writeAt(root: string, relative: string, text: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/** Repository-relative OpenAPI contract of a package, where the deriver reads it. */
function contractPath(name: PackageName): string {
  return name === 'gateway' || name === 'migration'
    ? `${name}/contracts/openapi.yaml`
    : `services/${name}/contracts/openapi.yaml`;
}

/** Minimal contract of a package without a fixture: `calls` (default none) and one push-delivery POST per route. */
function standInContract(
  name: string,
  sha: string,
  { pushRoutes = [], calls = [] }: { pushRoutes?: readonly string[]; calls?: readonly string[] } = {},
): string {
  const paths = pushRoutes.flatMap((route) => [
    `  ${route}:`,
    '    post:',
    '      responses:',
    "        '204':",
    '          description: Acknowledged',
  ]);
  return [
    'openapi: 3.1.0',
    'info:',
    `  title: ${name}`,
    '  version: 1.0.0',
    `  x-source-sha: ${sha}`,
    `x-opt2-calls: ${JSON.stringify(calls)}`,
    ...(paths.length === 0 ? ['paths: {}'] : ['paths:', ...paths]),
    '',
  ].join('\n');
}

async function fixtureText(relative: string): Promise<string> {
  return readFile(new URL(relative, FIXTURES), 'utf8');
}

async function fixtureSha(): Promise<string> {
  const people = parseYaml(await fixtureText('openapi/people.yaml')) as { info: { 'x-source-sha': string } };
  return people.info['x-source-sha'];
}

/** `plan.tfvars` text with the `cloud_run_services` entries in reverse order. */
function reverseServiceList(tfvars: string): string {
  return tfvars.replace(/cloud_run_services = \[([^\]]*)\]/, (_match, body: string) => {
    const lines = body.split('\n').filter((line) => line.trim() !== '');
    return `cloud_run_services = [\n${lines.reverse().join('\n')}\n]`;
  });
}

/** Temporary tree of the contract samples plus stand-in contracts; `reverse` inverts file and `cloud_run_services` order. */
async function makeRepo(reverse = false): Promise<string> {
  const root = await tempDir('opt2-topology-');
  const sha = await fixtureSha();
  const fixtureTargets = new Set(FIXTURE_COPIES.map(([, to]) => to));
  const files: [string, string][] = [];
  for (const [from, to] of FIXTURE_COPIES) {
    const text = await fixtureText(from);
    files.push([to, reverse && to === PLAN_TFVARS_RELATIVE_PATH ? reverseServiceList(text) : text]);
  }
  for (const name of PACKAGE_NAMES) {
    if (name !== 'web' && !fixtureTargets.has(contractPath(name))) files.push([contractPath(name), standInContract(name, sha)]);
  }
  for (const [relative, text] of reverse ? files.reverse() : files) await writeAt(root, relative, text);
  return root;
}

/** Every file under `root` with its modification time and contents, sorted by path. */
async function treeSnapshot(root: string): Promise<[string, number, string][]> {
  const entries = (await readdir(root, { recursive: true })).sort();
  const files: [string, number, string][] = [];
  for (const relative of entries) {
    const file = path.join(root, relative);
    const info = await stat(file);
    if (info.isFile()) files.push([relative, info.mtimeMs, await readFile(file, 'utf8')]);
  }
  return files;
}

/** The unit's queue entries for `target`, rebuilt from the platform registry. */
function expectedQueues(target: TopologyTarget): Topology['queues'] {
  return Object.fromEntries(
    queueTopology({ target }).map((queue) => [
      queue.name,
      {
        creators: [...queue.creators].sort(),
        target_service: queue.targetService,
        target_path: queue.targetPath,
        recurring_interval_s: queue.intervalS ?? null,
        deadline_s: queue.deadlineS,
        retry: {
          max_attempts: queue.retry.maxAttempts,
          min_backoff_s: queue.retry.minBackoffS,
          max_backoff_s: queue.retry.maxBackoffS,
          max_doublings: queue.retry.maxDoublings,
        },
      },
    ]),
  );
}

/** The subscription entry the platform naming helpers give for `consumer` on `topic`. */
function expectedSubscription(consumer: string, topic: string): [string, Topology['subscriptions'][string]] {
  const name = subscriptionName(consumer, topic);
  return [
    name,
    {
      topic,
      consumer,
      push_path: pushPath(name),
      ordering: true,
      dead_letter_topic: dlqTopicName(name),
      max_delivery_attempts: 5,
      dlq_replay_subscription: dlqReplaySubscriptionName(name),
    },
  ];
}

/** Asserts every object's keys and every string array in `value` are in code-unit order. */
function expectCanonical(value: unknown, at = '$'): void {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) expect(value, at).toEqual([...value].sort());
    value.forEach((item, index) => expectCanonical(item, `${at}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    expect(keys, at).toEqual([...keys].sort());
    for (const key of keys) expectCanonical((value as Record<string, unknown>)[key], `${at}.${key}`);
  }
}

function grpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function topicPath(topic: string): string {
  return `projects/${PROJECT}/topics/${topic}`;
}

interface FakeSubscription {
  topic: string;
  /** Absent on a pull subscription. */
  options?: PushSubscriptionOptions;
}

/** In-memory emulator: answers ALREADY_EXISTS for existing resources and counts every call. */
class FakeEmulator implements PubSubLike {
  readonly topics = new Map<string, string>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  calls = 0;

  async createTopic(name: string): Promise<void> {
    this.calls += 1;
    if (this.topics.has(name)) throw grpcError(GRPC_ALREADY_EXISTS, `topic ${name} exists`);
    this.topics.set(name, topicPath(name));
  }

  topic(topic: string): { createSubscription(name: string, options?: PushSubscriptionOptions): Promise<unknown> } {
    return {
      createSubscription: async (name: string, options?: PushSubscriptionOptions): Promise<void> => {
        this.calls += 1;
        if (!this.topics.has(topic)) throw grpcError(GRPC_NOT_FOUND, `topic ${topic} not found`);
        if (this.subscriptions.has(name)) throw grpcError(GRPC_ALREADY_EXISTS, `subscription ${name} exists`);
        this.subscriptions.set(name, { topic: topicPath(topic), ...(options === undefined ? {} : { options }) });
      },
    };
  }

  subscription(name: string): SubscriptionHandleLike {
    const current = (): FakeSubscription => {
      this.calls += 1;
      const found = this.subscriptions.get(name);
      if (found === undefined) throw grpcError(GRPC_NOT_FOUND, `subscription ${name} not found`);
      return found;
    };
    const pushOptions = (): PushSubscriptionOptions => {
      const { options } = current();
      if (options === undefined) throw new Error(`subscription ${name} is a pull subscription`);
      return options;
    };
    return {
      getMetadata: async () => {
        const { topic, options } = current();
        return [{ topic, enableMessageOrdering: options?.enableMessageOrdering ?? false }];
      },
      modifyPushConfig: async (config) => {
        const options = pushOptions();
        this.subscriptions.set(name, { topic: current().topic, options: { ...options, pushConfig: { ...config } } });
      },
      setMetadata: async (metadata) => {
        const options = pushOptions();
        this.subscriptions.set(name, { topic: current().topic, options: { ...options, ...metadata } });
      },
      delete: async () => {
        current();
        this.subscriptions.delete(name);
      },
    };
  }

  /** Deep copy of every topic and subscription held. */
  state(): { topics: [string, string][]; subscriptions: [string, FakeSubscription][] } {
    return structuredClone({ topics: [...this.topics].sort(), subscriptions: [...this.subscriptions].sort() });
  }
}

/** A temporary state directory with freshly generated local secrets, and the push key read back from it. */
async function generatedPushKey(): Promise<{ env: EnvLike; pushKey: string }> {
  const env: EnvLike = { OPT2_STATE_DIR: await tempDir('opt2-topology-state-') };
  ensureLocalSecrets({ env });
  return { env, pushKey: readSecret(PUSH_KEY_FILE, { env }) };
}

interface CliRun {
  code: number;
  exits: number[];
  line: Record<string, unknown>;
}

/** Runs the topology CLI through runCli with captured stdout and exit; asserts exactly one summary line. */
async function cli(argv: string[], opts: TopologyCliOptions = {}): Promise<CliRun> {
  const chunks: string[] = [];
  const exits: number[] = [];
  const code = await runCli((args) => main(args, opts), {
    argv,
    command: COMMAND,
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    exit: (status) => exits.push(status),
  });
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.endsWith('\n')).toBe(true);
  return { code, exits, line: JSON.parse(chunks[0] ?? '') as Record<string, unknown> };
}

describe('topology derivation from the contract samples', () => {
  it('reads the deployed services from plan.tfvars in file order, without the stub', async () => {
    const root = await makeRepo();

    const deployed = deployedServices(root);

    expect(deployed).toEqual(SAMPLE_DEPLOYED);
    expect(deployed).toHaveLength(13);
    expect(deployed).not.toContain('stub');
  });

  it('derives the local topology for every package up.sh starts, the stub included', async () => {
    const root = await makeRepo();

    const topology = deriveTopology('local', root);

    expect(topology.target).toBe('local');
    expect(topology.packages).toEqual([...PACKAGE_NAMES].sort());
    expect(topology.topics).toEqual({
      [ARCHIVED]: { producer: 'people', kind: 'process' },
      [CHANGED]: { producer: 'people', kind: 'state' },
      [NOTE_CREATED]: { producer: 'stub', kind: 'state' },
    });
    for (const [topic, entry] of Object.entries(topology.topics)) expect(entry.producer).toBe(parseTopic(topic).service);
    expect(Object.keys(topology.subscriptions).sort()).toEqual([
      'identity.people.person.changed.v1',
      'stub.stub.note.created.v1',
      'timesheets.people.person.archived.v1',
    ]);
    expect(topology.subscriptions).toEqual(
      Object.fromEntries(PUSH_ROUTES.map(([consumer, topic]) => expectedSubscription(consumer, topic))),
    );
    for (const subscription of Object.values(topology.subscriptions)) {
      expect(subscription.push_path.startsWith(PUSH_PATH_PREFIX)).toBe(true);
    }
  });

  it('keeps one people → identity edge from x-opt2-calls and service:people, and none for the invoker roles', async () => {
    const root = await makeRepo();

    const { service_calls: calls } = deriveTopology('local', root);

    expect(calls).toEqual({ people: ['identity'] });
    expect(Object.keys(calls)).not.toContain('pubsub-invoker');
    expect(Object.keys(calls)).not.toContain('tasks-invoker');
  });

  it('carries every local queue of the platform registry, the stub outbox sweep included', async () => {
    const root = await makeRepo();

    const { queues } = deriveTopology('local', root);

    expect(queues).toEqual(expectedQueues('local'));
    expect(queues[outboxSweepQueue('stub')]).toMatchObject({ creators: ['stub'], target_service: 'stub' });
  });

  it('drops every topic, subscription and queue of an undeployed package from the cloud topology', async () => {
    const root = await makeRepo();
    const deployed: ReadonlySet<string> = new Set(deployedServices(root));

    const topology = deriveTopology('cloud', root);

    expect(topology.target).toBe('cloud');
    expect(topology.packages).toEqual([...SAMPLE_DEPLOYED].sort());
    expect(Object.keys(topology.topics).sort()).toEqual([ARCHIVED, CHANGED]);
    expect(topology.subscriptions).toEqual(
      Object.fromEntries(
        PUSH_ROUTES.filter(([consumer]) => consumer !== 'stub').map(([consumer, topic]) => expectedSubscription(consumer, topic)),
      ),
    );
    for (const [name, subscription] of Object.entries(topology.subscriptions)) {
      for (const text of [name, subscription.dead_letter_topic, subscription.dlq_replay_subscription]) expect(text).not.toContain('stub');
      expect(deployed.has(subscription.consumer)).toBe(true);
    }
    for (const entry of Object.values(topology.topics)) expect(deployed.has(entry.producer)).toBe(true);
    expect(topology.queues).toEqual(expectedQueues('cloud'));
    expect(topology.queues).not.toHaveProperty(outboxSweepQueue('stub'));
    for (const queue of Object.values(topology.queues)) {
      expect(queue.creators).not.toContain('stub');
      expect(queue.target_service).not.toBe('stub');
    }
    expect(topology.service_calls).toEqual({ people: ['identity'] });
  });

  it("drops a deployed consumer's subscription to an undeployed producer's topic from the cloud topology only", async () => {
    const root = await makeRepo();
    const crossing = subscriptionName('timesheets', NOTE_CREATED);
    const pushRoutes = [pushPath(subscriptionName('timesheets', ARCHIVED)), pushPath(crossing)];
    await writeAt(root, contractPath('timesheets'), standInContract('timesheets', await fixtureSha(), { pushRoutes }));

    expect(Object.keys(deriveTopology('local', root).subscriptions)).toContain(crossing);
    expect(Object.keys(deriveTopology('cloud', root).subscriptions)).not.toContain(crossing);
  });

  it('drops cloud queues whose target is undeployed and keeps only deployed creators', async () => {
    const root = await makeRepo();
    const deployed = SAMPLE_DEPLOYED.filter((name) => name !== 'programs-sites');
    await writeAt(root, PLAN_TFVARS_RELATIVE_PATH, `cloud_run_services = ${JSON.stringify(deployed)}\n`);
    const { [SITEMONITOR_QUEUE]: _monitor, [outboxSweepQueue('programs-sites')]: _sweep, ...rest } = expectedQueues('cloud');
    const { 'content-feed-import': _feedImport, 'content-scheduled-publish': publish, ...unchanged } = rest;

    const { queues } = deriveTopology('cloud', root);

    expect(publish?.creators).toEqual(['programs-sites', 'strategies-content']);
    expect(queues).toEqual({ ...unchanged, 'content-scheduled-publish': { ...publish, creators: ['strategies-content'] } });
  });

  it.each<TopologyTarget>(['local', 'cloud'])('derives the %s topology purely: equal results and no file touched', async (target) => {
    const root = await makeRepo();
    const before = await treeSnapshot(root);

    const first = deriveTopology(target, root);
    const second = deriveTopology(target, root);

    expect(second).toEqual(first);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  const timesheetsContract = contractPath('timesheets');
  const planListing = (list: string) => (root: string) => writeAt(root, PLAN_TFVARS_RELATIVE_PATH, `cloud_run_services = [${list}]\n`);
  const timesheetsDeclaring = (opts: { pushRoutes?: string[]; calls?: string[] }) => async (root: string) =>
    writeAt(root, timesheetsContract, standInContract('timesheets', await fixtureSha(), opts));

  const malformed: { label: string; target: TopologyTarget; file: string; reason: string; mutate: (root: string) => Promise<void> }[] = [
    {
      label: 'an event schema whose file name is not a topic',
      target: 'local',
      file: 'services/people/contracts/events/person-archived.json',
      reason: 'Invalid event name',
      mutate: (root) => writeAt(root, 'services/people/contracts/events/person-archived.json', '{"x-opt2-kind":"process"}\n'),
    },
    {
      label: "an event schema in another producer's folder",
      target: 'local',
      file: `services/timesheets/contracts/events/${ARCHIVED}.json`,
      reason: "not to its folder's service timesheets",
      mutate: async (root) =>
        writeAt(root, `services/timesheets/contracts/events/${ARCHIVED}.json`, await fixtureText(`events/${ARCHIVED}.json`)),
    },
    {
      label: 'a plan.tfvars without cloud_run_services',
      target: 'cloud',
      file: PLAN_TFVARS_RELATIVE_PATH,
      reason: 'expected one cloud_run_services list, found 0',
      mutate: (root) => writeAt(root, PLAN_TFVARS_RELATIVE_PATH, 'project_id = "opt2-plan-only"\n'),
    },
    { label: 'an empty cloud_run_services', target: 'cloud', file: PLAN_TFVARS_RELATIVE_PATH, reason: 'is empty', mutate: planListing('') },
    {
      label: 'an unquoted cloud_run_services entry',
      target: 'cloud',
      file: PLAN_TFVARS_RELATIVE_PATH,
      reason: 'must list only quoted package names',
      mutate: planListing('gateway'),
    },
    {
      label: 'an unknown cloud_run_services name',
      target: 'cloud',
      file: PLAN_TFVARS_RELATIVE_PATH,
      reason: 'names "billing"',
      mutate: planListing('"gateway", "billing"'),
    },
    {
      label: 'a repeated cloud_run_services name',
      target: 'cloud',
      file: PLAN_TFVARS_RELATIVE_PATH,
      reason: 'lists gateway twice',
      mutate: planListing('"gateway", "gateway"'),
    },
    {
      label: 'a push route naming a topic without an event schema',
      target: 'local',
      file: timesheetsContract,
      reason: 'which has no event schema',
      mutate: timesheetsDeclaring({ pushRoutes: [pushPath(subscriptionName('timesheets', 'people.person.deleted.v1'))] }),
    },
    {
      label: 'a push route of another consumer',
      target: 'local',
      file: timesheetsContract,
      reason: 'belongs to consumer identity, not timesheets',
      mutate: timesheetsDeclaring({ pushRoutes: [pushPath(subscriptionName('identity', ARCHIVED))] }),
    },
    {
      label: 'an x-opt2-calls entry naming an unknown package',
      target: 'local',
      file: timesheetsContract,
      reason: 'x-opt2-calls names "billing"',
      mutate: timesheetsDeclaring({ calls: ['billing'] }),
    },
    {
      label: 'an x-opt2-calls value that is not a list',
      target: 'local',
      file: timesheetsContract,
      reason: 'does not match the contract fields the topology reads',
      mutate: (root) => writeAt(root, timesheetsContract, 'openapi: 3.1.0\nx-opt2-calls: identity\npaths: {}\n'),
    },
    {
      label: 'a package without its contract',
      target: 'cloud',
      file: contractPath('finance'),
      reason: 'the contract of finance does not exist',
      mutate: (root) => rm(path.join(root, contractPath('finance'))),
    },
  ];

  it.each(malformed)('rejects $label with a TopologyError naming the file', async ({ target, file, reason, mutate }) => {
    const root = await makeRepo();
    await mutate(root);

    expect(() => deriveTopology(target, root)).toThrow(TopologyError);
    expect(() => deriveTopology(target, root)).toThrow(`${file}: `);
    expect(() => deriveTopology(target, root)).toThrow(reason);
  });
});

describe('topology.auto.tfvars.json rendering', () => {
  it('holds exactly the four cloud variables', async () => {
    const topology = deriveTopology('cloud', await makeRepo());

    expect(Object.keys(toTfvars(topology)).sort()).toEqual(['queues', 'service_calls', 'subscriptions', 'topics']);
  });

  it.each<TopologyTarget>(['local', 'cloud'])('renders the %s topology as byte-stable JSON ending in one newline', async (target) => {
    const topology = deriveTopology(target, await makeRepo());

    const text = renderTfvars(topology);

    expect(renderTfvars(topology)).toBe(text);
    expect(text).toBe(stableStringify(toTfvars(topology)));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expectCanonical(JSON.parse(text));
  });

  it.each<TopologyTarget>(['local', 'cloud'])('renders the %s topology independently of file and list order', async (target) => {
    const forward = await makeRepo();
    const reversed = await makeRepo(true);
    expect(deployedServices(reversed)).toEqual([...deployedServices(forward)].reverse());

    expect(deriveTopology(target, reversed)).toEqual(deriveTopology(target, forward));
    expect(renderTfvars(deriveTopology(target, reversed))).toBe(renderTfvars(deriveTopology(target, forward)));
  });
});

describe('local topology application on an injected emulator client', () => {
  const NAMES = PUSH_ROUTES.map(([consumer, topic]) => subscriptionName(consumer, topic));

  it('creates every topic, DLQ topic, push subscription and DLQ replay subscription on the first run', async () => {
    const topology = deriveTopology('local', await makeRepo());
    const { pushKey } = await generatedPushKey();
    const ports = loadPorts();
    const fake = new FakeEmulator();

    const result = await applyLocalTopology(topology, { projectId: PROJECT, pushKey, ports, pubsub: fake });

    expect(result).toEqual({ topics: 3, dlqTopics: 3, pushSubscriptions: 3, replaySubscriptions: 3, updated: 0 });
    expect([...fake.topics.keys()].sort()).toEqual([ARCHIVED, CHANGED, NOTE_CREATED, ...NAMES.map(dlqTopicName)].sort());
    expect([...fake.subscriptions.keys()].sort()).toEqual([...NAMES, ...NAMES.map(dlqReplaySubscriptionName)].sort());
    for (const [consumer, topic] of PUSH_ROUTES) {
      const name = subscriptionName(consumer, topic);
      expect(fake.subscriptions.get(name)).toEqual({
        topic: topicPath(topic),
        options: expect.objectContaining({
          pushConfig: { pushEndpoint: `http://127.0.0.1:${ports[consumer]}${pushPath(name)}?key=${encodeURIComponent(pushKey)}` },
          enableMessageOrdering: true,
          deadLetterPolicy: { deadLetterTopic: topicPath(dlqTopicName(name)), maxDeliveryAttempts: 5 },
        }),
      });
      expect(fake.subscriptions.get(dlqReplaySubscriptionName(name))).toEqual({ topic: topicPath(dlqTopicName(name)) });
    }
  });

  it('creates nothing and leaves the emulator state unchanged on a second run', async () => {
    const topology = deriveTopology('local', await makeRepo());
    const { pushKey } = await generatedPushKey();
    const fake = new FakeEmulator();
    const opts = { projectId: PROJECT, pushKey, ports: loadPorts(), pubsub: fake };
    await applyLocalTopology(topology, opts);
    const before = fake.state();

    const again = await applyLocalTopology(topology, opts);

    expect(again).toEqual({ topics: 0, dlqTopics: 0, pushSubscriptions: 0, replaySubscriptions: 0, updated: NAMES.length });
    expect(fake.state()).toEqual(before);
  });

  it('recreates an existing push subscription without message ordering, since ordering is fixed at creation', async () => {
    const topology = deriveTopology('local', await makeRepo());
    const { pushKey } = await generatedPushKey();
    const fake = new FakeEmulator();
    const opts = { projectId: PROJECT, pushKey, ports: loadPorts(), pubsub: fake };
    await applyLocalTopology(topology, opts);
    const name = subscriptionName('timesheets', ARCHIVED);
    const options = fake.subscriptions.get(name)?.options as PushSubscriptionOptions;
    fake.subscriptions.set(name, { topic: topicPath(ARCHIVED), options: { ...options, enableMessageOrdering: false } });

    const again = await applyLocalTopology(topology, opts);

    expect(again).toEqual({ topics: 0, dlqTopics: 0, pushSubscriptions: 0, replaySubscriptions: 0, updated: NAMES.length });
    expect(fake.subscriptions.get(name)).toEqual({ topic: topicPath(ARCHIVED), options });
  });

  const refusals: { label: string; target: TopologyTarget; client: boolean; ports: () => Readonly<Record<string, number>>; message: string }[] = [
    { label: 'a cloud topology', target: 'cloud', client: true, ports: loadPorts, message: 'only a local topology' },
    { label: 'an unset emulator host without a client', target: 'local', client: false, ports: loadPorts, message: 'PUBSUB_EMULATOR_HOST is not set' },
    { label: 'a consumer without a local port', target: 'local', client: true, ports: () => ({}), message: 'no local port for' },
  ];

  it.each(refusals)('refuses $label with a TopologyError', async ({ target, client, ports, message }) => {
    const topology = deriveTopology(target, await makeRepo());
    const { pushKey } = await generatedPushKey();
    const fake = new FakeEmulator();

    const error: unknown = await applyLocalTopology(topology, {
      emulatorHost: '',
      projectId: PROJECT,
      pushKey,
      ports: ports(),
      ...(client ? { pubsub: fake } : {}),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TopologyError);
    expect((error as Error).message).toContain(message);
    expect(fake.subscriptions.size).toBe(0);
  });
});

describe('topology CLI through runCli', () => {
  const cloudCounts = { topics: 2, subscriptions: 2, queues: Object.keys(expectedQueues('cloud')).length, callers: 1 };

  it('writes exactly the rendered cloud topology to --out', async () => {
    const root = await makeRepo();
    const out = path.join(await tempDir('opt2-topology-out-'), 'topology.auto.tfvars.json');

    const run = await cli(['--target', 'cloud', '--out', out, '--repo-root', root]);

    expect(run).toEqual({
      code: 0,
      exits: [0],
      line: { command: COMMAND, ok: true, code: 0, target: 'cloud', path: out, ...cloudCounts },
    });
    expect(await readFile(out, 'utf8')).toBe(renderTfvars(deriveTopology('cloud', root)));
    expect(existsSync(path.join(root, TFVARS_RELATIVE_PATH))).toBe(false);
  });

  const checks: { label: string; edit: ((text: string) => string) | undefined; code: number; changed: boolean }[] = [
    { label: 'matches', edit: (text) => text, code: 0, changed: false },
    {
      label: 'differs',
      edit: (text) => stableStringify({ ...(JSON.parse(text) as Record<string, unknown>), service_calls: {} }),
      code: 1,
      changed: true,
    },
    { label: 'is missing', edit: undefined, code: 1, changed: true },
  ];

  it.each(checks)('--check exits $code when the variables file $label, naming the file', async ({ edit, code, changed }) => {
    const root = await makeRepo();
    const file = path.join(root, TFVARS_RELATIVE_PATH);
    const written = edit?.(renderTfvars(deriveTopology('cloud', root)));
    if (written !== undefined) await writeAt(root, TFVARS_RELATIVE_PATH, written);

    const run = await cli(['--target', 'cloud', '--check', '--repo-root', root]);

    expect(run).toEqual({
      code,
      exits: [code],
      line: {
        command: COMMAND,
        ok: code === 0,
        code,
        target: 'cloud',
        path: file,
        changed,
        ...(written === undefined ? { missing: true } : {}),
        ...cloudCounts,
      },
    });
    if (written === undefined) expect(existsSync(file)).toBe(false);
    else expect(await readFile(file, 'utf8')).toBe(written);
  });

  it('reports the local topology on --dry-run without calling the emulator', async () => {
    vi.stubEnv('PUBSUB_EMULATOR_HOST', '');
    const root = await makeRepo();
    const fake = new FakeEmulator();

    const run = await cli(['--target', 'local', '--dry-run', '--repo-root', root], { pubsub: fake });

    expect(run).toEqual({
      code: 0,
      exits: [0],
      line: {
        command: COMMAND,
        ok: true,
        code: 0,
        target: 'local',
        dryRun: true,
        packages: [...PACKAGE_NAMES].sort(),
        topics: [ARCHIVED, CHANGED, NOTE_CREATED],
        subscriptions: Object.fromEntries(
          PUSH_ROUTES.map(([consumer, topic]) => subscriptionName(consumer, topic)).map((name) => [name, pushPath(name)]),
        ),
        queues: Object.keys(expectedQueues('local')).sort(),
        serviceCalls: { people: ['identity'] },
      },
    });
    expect(fake.calls).toBe(0);
  });

  it('applies the local topology with the generated push key and the ports.env ports', async () => {
    const root = await makeRepo();
    const { env, pushKey } = await generatedPushKey();
    const fake = new FakeEmulator();
    const applied: LocalApplyResult = { topics: 3, dlqTopics: 3, pushSubscriptions: 3, replaySubscriptions: 3, updated: 0 };

    const run = await cli(['--target', 'local', '--repo-root', root], { env: { ...env, GOOGLE_CLOUD_PROJECT: PROJECT }, pubsub: fake });

    expect(run).toEqual({
      code: 0,
      exits: [0],
      line: {
        command: COMMAND,
        ok: true,
        code: 0,
        target: 'local',
        projectId: PROJECT,
        created: applied,
        queues: Object.keys(expectedQueues('local')).sort(),
      },
    });
    const ports = loadPorts();
    for (const [consumer, topic] of PUSH_ROUTES) {
      const name = subscriptionName(consumer, topic);
      expect(fake.subscriptions.get(name)?.options?.pushConfig.pushEndpoint).toBe(
        `http://127.0.0.1:${ports[consumer]}${pushPath(name)}?key=${encodeURIComponent(pushKey)}`,
      );
    }
  });

  it.each([
    { label: 'no --target', argv: [] },
    { label: 'an unknown --target', argv: ['--target', 'staging'] },
    { label: '--dry-run with --target cloud', argv: ['--target', 'cloud', '--dry-run'] },
    { label: '--check with --target local', argv: ['--target', 'local', '--check'] },
  ])('exits 2 with a UsageError for $label', async ({ argv }) => {
    const run = await cli(argv);

    expect(run).toMatchObject({ code: 2, exits: [2], line: { command: COMMAND, ok: false, code: 2, error: { type: 'UsageError' } } });
  });
});

describe('committed topology.auto.tfvars.json', () => {
  it('equals the cloud topology rendered from this checkout, as CI regenerates it', async () => {
    const committed = await readFile(path.join(REPO_ROOT, TFVARS_RELATIVE_PATH), 'utf8');

    expect(renderTfvars(deriveTopology('cloud', REPO_ROOT))).toBe(committed);
  });

  it('is derived from the deployed services the contract sample mirrors', () => {
    expect(deployedServices(REPO_ROOT)).toEqual(SAMPLE_DEPLOYED);
  });
});
