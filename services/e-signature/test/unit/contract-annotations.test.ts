// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Offline checks of the e-signature OpenAPI contract's metadata and x-opt2 annotations. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { routeKeyForEntryPoint } from '@opt2/platform/legacy-compat';
import { OUTBOX_SWEEP_PATH, QUEUES } from '@opt2/platform/tasks';

type SecurityRequirement = Record<string, string[]>;

interface Operation {
  operationId?: string;
  security?: SecurityRequirement[];
  'x-opt2-transport'?: unknown;
  'x-opt2-requires'?: unknown;
  'x-opt2-public'?: unknown;
  'x-opt2-site-check'?: unknown;
  'x-opt2-route-keys'?: unknown;
}

interface Contract {
  openapi: unknown;
  info: { title?: unknown; version?: unknown; description?: unknown; 'x-source-sha'?: unknown };
  security?: SecurityRequirement[];
  paths: Record<string, Record<string, unknown>>;
  components: { securitySchemes: Record<string, unknown> };
  'x-opt2-calls'?: unknown;
}

const LABEL = 'SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/';
const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm/';
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
// A fixture route checks an optional user token itself, so it is reachable without one.
const OPTIONAL_USER_SECURITY: SecurityRequirement[] = [{}, { userToken: [], invocationCredential: [] }];

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as {
  load: (text: string) => unknown;
};

const contract = load(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as Contract;
const pin = JSON.parse(await readFile(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as {
  sha?: unknown;
};

/** Transport a route must declare: managed Pub/Sub push, managed Cloud Tasks, or a service call. */
function expectedTransport(path: string): 'pubsub-push' | 'cloud-tasks' | 'service' {
  if (path.startsWith('/internal/v1/events/')) return 'pubsub-push';
  if (path.startsWith('/internal/v1/tasks/') || path.startsWith('/internal/v1/jobs/') || path === OUTBOX_SWEEP_PATH) {
    return 'cloud-tasks';
  }
  return 'service';
}

/** Security an operation resolves: its own, else the contract default. */
function securityOf(op: Operation): SecurityRequirement[] {
  return op.security ?? contract.security ?? [];
}

/** Shared route key of a fixture operation, computed from its method and path. */
function fixtureRouteKey(method: string, path: string): string {
  return routeKeyForEntryPoint({ kind: 'fixture', httpMethod: method.toUpperCase(), path }).key;
}

const operations = Object.entries(contract.paths).flatMap(([path, item]) =>
  METHODS.filter((method) => item[method] !== undefined).map((method) => {
    const op = item[method] as Operation;
    return { label: String(op.operationId), method, path, transport: expectedTransport(path), op };
  }),
);
const fixtureOperations = operations.filter(({ path }) => path.startsWith(FIXTURE_PREFIX));

describe('e-signature contract annotations', () => {
  it('is OpenAPI 3.1.0 titled e-signature at version 1.0.0', () => {
    expect(contract.openapi).toBe('3.1.0');
    expect(contract.info.title).toBe('e-signature');
    expect(contract.info.version).toBe('1.0.0');
  });

  it('records the pinned source SHA', () => {
    expect(pin.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(contract.info['x-source-sha']).toBe(pin.sha);
  });

  it('opens its description with the synthetic label', () => {
    expect(String(contract.info.description).slice(0, LABEL.length)).toBe(LABEL);
  });

  it('calls only identity and people', () => {
    expect(contract['x-opt2-calls']).toEqual(['identity', 'people']);
  });

  it('gives every operation a unique operationId', () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(ids).not.toContain(undefined);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('defaults to a user token plus an invocation credential', () => {
    expect(contract.security).toEqual([{ userToken: [], invocationCredential: [] }]);
  });

  it.each(operations)('$label resolves a security requirement of declared schemes', ({ op, path }) => {
    if (op['x-opt2-public'] === true) {
      expect(op.security).toEqual(path.startsWith(FIXTURE_PREFIX) ? OPTIONAL_USER_SECURITY : []);
    } else {
      const resolved = securityOf(op);
      expect(resolved).not.toEqual([]);
      for (const requirement of resolved) {
        expect(Object.keys(requirement)).not.toEqual([]);
        expect(Object.keys(contract.components.securitySchemes)).toEqual(expect.arrayContaining(Object.keys(requirement)));
      }
    }
  });

  it.each(operations)('$label declares either required roles or public access', ({ op }) => {
    const roles = op['x-opt2-requires'];
    if (op['x-opt2-public'] === true) {
      expect(roles).toBeUndefined();
    } else {
      expect(roles).toBeInstanceOf(Array);
      expect(roles).not.toEqual([]);
      for (const role of roles as unknown[]) expect(role).toEqual(expect.stringMatching(/\S/));
    }
  });

  it.each(operations)('$label uses the $transport transport', ({ op, transport }) => {
    expect(op['x-opt2-transport']).toBe(transport);
    if (transport !== 'service') {
      expect(op['x-opt2-public']).not.toBe(true);
      expect(securityOf(op).flatMap((requirement) => Object.keys(requirement))).not.toContain('userToken');
    }
  });

  it('serves exactly the task routes of the queues that target e-signature', () => {
    const queuePaths = Object.values(QUEUES)
      .filter((queue) => queue.targetService === 'e-signature')
      .map((queue) => queue.targetPath);
    const taskPaths = Object.keys(contract.paths).filter((path) => expectedTransport(path) === 'cloud-tasks');
    expect(taskPaths.sort()).toEqual(queuePaths.sort());
  });

  it.each(fixtureOperations)('$label is public with its own site check, on a path declaring every request method and the method override', ({ op, path }) => {
    expect([op['x-opt2-public'], op['x-opt2-site-check']]).toEqual([true, false]);
    const item = contract.paths[path] ?? {};
    expect(METHODS.filter((method) => item[method] !== undefined)).toEqual(['get', 'put', 'post', 'delete', 'options', 'head', 'patch']);
    expect(item.parameters).toContainEqual({ $ref: '#/components/parameters/MethodOverride' });
  });

  it.each(fixtureOperations)('$label maps to a well-formed e-signature fixture route key', ({ method, path }) => {
    const wellFormed = new RegExp(String.raw`^fixture:esignature/[a-z]+(?:/(?:\{id\}|[a-z]+))*@${method}$`);
    expect(fixtureRouteKey(method, path)).toMatch(wellFormed);
  });

  it('declares, on each fixture operation carrying x-opt2-route-keys, exactly its shared route key', () => {
    const declaring = fixtureOperations.filter(({ op }) => op['x-opt2-route-keys'] !== undefined);
    expect(declaring.map(({ label, op }) => [label, op['x-opt2-route-keys']])).toEqual(
      declaring.map(({ label, method, path }) => [label, [fixtureRouteKey(method, path)]]),
    );
  });
});
