// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** OPT-2 annotations of the reporting OpenAPI contract, checked offline against the pin, queues and route keys. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { routeKeyForRequest } from '@opt2/platform/legacy-compat';
import { QUEUES } from '@opt2/platform/tasks';

interface Operation {
  operationId?: unknown;
  security?: unknown;
  'x-opt2-requires'?: unknown;
  'x-opt2-public'?: unknown;
  'x-opt2-transport'?: unknown;
  'x-opt2-route-keys'?: unknown;
}

interface Contract {
  openapi?: unknown;
  info?: Record<string, unknown>;
  'x-opt2-calls'?: unknown;
  paths: Record<string, Record<string, unknown>>;
}

interface ContractOperation {
  path: string;
  method: string;
  op: Operation;
}

const CONTRACT_URL = new URL('../../contracts/openapi.yaml', import.meta.url);
const EVENTS_DIR_URL = new URL('../../contracts/events/', import.meta.url);
const PIN_URL = new URL('../../../../opt2/source-pin.json', import.meta.url);
const SYNTHETIC_HEADER = '# SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/';
const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm/reporting/';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const SAMPLE_ID = '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';

const source = readFileSync(CONTRACT_URL, 'utf8');
const contract = parse(source) as Contract;
const pin = JSON.parse(readFileSync(PIN_URL, 'utf8')) as { sha: string };

const operations: ContractOperation[] = Object.entries(contract.paths).flatMap(([path, item]) =>
  HTTP_METHODS.filter((method) => Object.hasOwn(item, method)).map((method) => ({
    path,
    method,
    op: item[method] as Operation,
  })),
);
const fixtureOperations = operations.filter(({ path }) => path.startsWith(FIXTURE_PREFIX));
// `%s` names keep the full path, which `$` interpolation truncates.
const named = (ops: ContractOperation[]): Array<[string, ContractOperation]> =>
  ops.map((o) => [`${o.method.toUpperCase()} ${o.path}`, o]);

function isPublic(op: Operation): boolean {
  return op['x-opt2-public'] === true;
}

function expectedTransport(path: string): string {
  if (path.startsWith('/internal/v1/events/')) return 'pubsub-push';
  if (path.startsWith('/internal/v1/tasks/')) return 'cloud-tasks';
  return 'service';
}

describe('reporting contract', () => {
  it('opens with the synthetic label', () => {
    expect(source.split(/\r?\n/, 1)[0]).toBe(SYNTHETIC_HEADER);
  });

  it('is OpenAPI 3.1.0 for reporting at the pinned SHA', () => {
    expect(contract.openapi).toBe('3.1.0');
    expect(contract.info?.title).toBe('reporting');
    expect(contract.info?.version).toBe('1.0.0');
    expect(contract.info?.['x-source-sha']).toBe(pin.sha);
  });

  it('calls only finance and timesheets', () => {
    expect(contract['x-opt2-calls']).toEqual(['finance', 'timesheets']);
  });

  it('names every operation with a unique operationId', () => {
    const ids = operations.map(({ op }) => op.operationId);
    for (const id of ids) expect(id).toEqual(expect.stringMatching(/\S/));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serves the reporting-export-run task path and no other task path', () => {
    const queue = QUEUES['reporting-export-run'];
    expect(queue.targetService).toBe('reporting');
    expect(Object.keys(contract.paths).filter((path) => path.startsWith('/internal/v1/tasks/'))).toEqual([
      queue.targetPath,
    ]);
  });

  it('has no outbox sweep route and no event contracts', () => {
    expect(Object.keys(contract.paths)).not.toContain('/internal/v1/outbox/sweep');
    expect(existsSync(EVENTS_DIR_URL)).toBe(false);
  });

  it('declares fixture routes', () => {
    expect(fixtureOperations.length).toBeGreaterThan(0);
  });
});

describe('reporting operations', () => {
  it.each(named(operations))('%s declares security, empty only when public', (_name, { op }) => {
    expect(Array.isArray(op.security)).toBe(true);
    if (isPublic(op)) expect(op.security).toEqual([]);
    else expect(op.security).not.toEqual([]);
  });

  it.each(named(operations))('%s declares exactly one of required roles or public', (_name, { op }) => {
    const requires = op['x-opt2-requires'];
    const hasRoles =
      Array.isArray(requires) &&
      requires.length > 0 &&
      requires.every((role) => typeof role === 'string' && role !== '');
    expect(hasRoles !== isPublic(op)).toBe(true);
    expect(isPublic(op) ? requires : op['x-opt2-public']).toBeUndefined();
  });

  it.each(named(operations))(
    '%s declares its path family transport, never public on a managed one',
    (_name, { path, op }) => {
      const transport = expectedTransport(path);
      expect(op['x-opt2-transport']).toBe(transport);
      if (transport !== 'service') expect(isPublic(op)).toBe(false);
    },
  );

  it.each(named(fixtureOperations))(
    '%s carries the route key of its method and path',
    (_name, { path, method, op }) => {
      const { key } = routeKeyForRequest({
        method: method.toUpperCase(),
        path: path.replace(/\{[^}]+\}/g, SAMPLE_ID),
        query: {},
        headers: {},
      });
      expect(op['x-opt2-route-keys']).toEqual([key]);
    },
  );
});
