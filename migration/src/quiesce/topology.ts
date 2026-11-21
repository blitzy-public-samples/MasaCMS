/** Push subscriptions each consumer declares in its OpenAPI contract. */
import { readFile } from 'node:fs/promises';

import { PUSH_PATH_PREFIX, consumerOfSubscription, topicOfSubscription } from '@opt2/platform/events';
import { parse } from 'yaml';

import type { MigrationConfig, OwnerName } from '../config.js';
import { repoPath } from '../paths.js';

/** A push subscription a consumer's contract declares as a `/internal/v1/events/<name>` path. */
export interface DeclaredSubscription {
  name: string;
  topic: string;
}

/** A consumer contract has no paths object or declares a push path of another consumer. */
export class ContractTopologyError extends Error {
  override readonly name: string = 'ContractTopologyError';
  readonly file: string;

  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
    this.file = file;
  }
}

/**
 * Subscriptions `owner` declares as push paths in its package's `contracts/openapi.yaml`, sorted by name.
 * @throws ContractTopologyError for a contract without paths or a push path of another consumer; read, YAML and name errors propagate.
 */
export async function declaredSubscriptions(config: Pick<MigrationConfig, 'owners'>, owner: OwnerName): Promise<DeclaredSubscription[]> {
  const file = repoPath(`${config.owners[owner].package}/contracts/openapi.yaml`);
  const contract: unknown = parse(await readFile(file, 'utf8'));
  const paths = (contract as { paths?: unknown } | null)?.paths;
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) throw new ContractTopologyError(file, 'declares no paths object');
  return Object.keys(paths)
    .filter((route) => route.startsWith(PUSH_PATH_PREFIX))
    .map((route) => {
      const name = route.slice(PUSH_PATH_PREFIX.length);
      const consumer = consumerOfSubscription(name);
      if (consumer !== owner) throw new ContractTopologyError(file, `push path ${route} belongs to consumer ${consumer}, not ${owner}`);
      return { name, topic: topicOfSubscription(name) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
