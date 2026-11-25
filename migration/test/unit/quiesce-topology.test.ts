// Unit tests for the declared-topology reader, against the repository's contracts and contract texts a spied readFile returns.
import { readFile } from 'node:fs/promises';

import { InvalidEventNameError } from '@opt2/platform/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { YAMLParseError } from 'yaml';

import { loadConfig } from '../../src/config.js';
import { repoPath } from '../../src/paths.js';
import { ContractTopologyError, declaredSubscriptions, type DeclaredSubscription } from '../../src/quiesce/topology.js';

// A pass-through spy, so single tests can hand the reader a contract text.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const CONFIG = loadConfig();
const IDENTITY_CONTRACT = repoPath('services/identity/contracts/openapi.yaml');

afterEach(() => {
  vi.mocked(readFile).mockReset();
});

describe('declaredSubscriptions', () => {
  it('reads the push subscriptions the identity contract declares', async () => {
    await expect(declaredSubscriptions(CONFIG, 'identity')).resolves.toStrictEqual<DeclaredSubscription[]>([
      { name: 'identity.people.person.changed.v1', topic: 'people.person.changed.v1' },
      { name: 'identity.programs-sites.site.changed.v1', topic: 'programs-sites.site.changed.v1' },
    ]);
    expect(vi.mocked(readFile)).toHaveBeenCalledExactlyOnceWith(IDENTITY_CONTRACT, 'utf8');
  });

  it('keeps only push paths, sorted by subscription name', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      [
        'paths:',
        '  /internal/v1/events/identity.programs-sites.site.changed.v1: {}',
        '  /internal/v1/migration/position: {}',
        '  /internal/v1/events/identity.people.person.changed.v1: {}',
        '  /api/v1/users: {}',
      ].join('\n'),
    );

    await expect(declaredSubscriptions(CONFIG, 'identity')).resolves.toStrictEqual<DeclaredSubscription[]>([
      { name: 'identity.people.person.changed.v1', topic: 'people.person.changed.v1' },
      { name: 'identity.programs-sites.site.changed.v1', topic: 'programs-sites.site.changed.v1' },
    ]);
  });

  it.each<[string, string, new (...args: never[]) => Error, string | RegExp]>([
    [
      'a push path of another consumer',
      'paths:\n  /internal/v1/events/people.identity.group.changed.v1: {}\n',
      ContractTopologyError,
      `${IDENTITY_CONTRACT}: push path /internal/v1/events/people.identity.group.changed.v1 belongs to consumer people, not identity`,
    ],
    ['a push path that names no subscription', 'paths:\n  /internal/v1/events/identity: {}\n', InvalidEventNameError, 'Invalid event name "identity"'],
    ['no paths object', 'openapi: 3.1.0\n', ContractTopologyError, `${IDENTITY_CONTRACT}: declares no paths object`],
    ['a paths list', 'paths:\n  - /internal/v1/events/identity.people.person.changed.v1\n', ContractTopologyError, `${IDENTITY_CONTRACT}: declares no paths object`],
    ['an empty document', '', ContractTopologyError, `${IDENTITY_CONTRACT}: declares no paths object`],
    ['text that is no YAML', 'paths: [unclosed\n', YAMLParseError, /Flow sequence/],
  ])('rejects a contract with %s', async (_label, text, errorType, message) => {
    vi.mocked(readFile).mockResolvedValueOnce(text);

    const failure = await declaredSubscriptions(CONFIG, 'identity').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(errorType);
    expect((failure as Error).message).toMatch(message);
  });

  it('rejects with the read error when the owner’s package has no contract', async () => {
    const config = { owners: { ...CONFIG.owners, identity: { ...CONFIG.owners.identity, package: 'services/absent-consumer' } } };

    await expect(declaredSubscriptions(config, 'identity')).rejects.toMatchObject({
      code: 'ENOENT',
      path: repoPath('services/absent-consumer/contracts/openapi.yaml'),
    });
  });
});
