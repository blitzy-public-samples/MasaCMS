import { describe, expect, it } from 'vitest';
import { transportForPath, type RouteMatrixEntry } from '../../src/auth/index.js';
import {
  assertResponseMatchesOpenApi, contractOperations, contractRouteKey, declarationMismatches, diffRoutes, injectedBody, injectedResponse,
  operationAuthProblems, operationDeclaration, operationIdProblems, operationRouteKeys, routeDeclaration, toContractPath, withoutHeadTwins,
  type ContractOperation, type InjectedAnswer,
} from '../../src/testing/index.js';

const OK = { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['status'] } } } } };
const DOC = {
  openapi: '3.1.0',
  info: { title: 'Fixture', version: '1.0.0' },
  paths: {
    '/healthz': { get: { operationId: 'healthz', 'x-opt2-transport': 'service', 'x-opt2-public': true, responses: OK } },
    '/v1/items/{itemId}': {
      get: { operationId: 'getItem', 'x-opt2-transport': 'service', 'x-opt2-requires': ['s2', 'member'], responses: {} },
      delete: { operationId: 'deleteItem', 'x-opt2-transport': 'service', 'x-opt2-requires': ['s2'], 'x-opt2-site-check': false, responses: {} },
    },
    '/_api/json/v1': {
      get: { operationId: 'jsonGet', 'x-opt2-transport': 'service', 'x-opt2-public': true, 'x-opt2-edge': true, 'x-opt2-fastify-path': ['/_api/json/v1*', '/index.cfm/_api/json/v1*'], responses: {} },
    },
  },
} as const;
const OPERATIONS = contractOperations(DOC);
const LOOSE_DOC = { paths: { '/a': { get: { operationId: 7 }, delete: { operationId: 'del' }, put: 'x' }, '/b': 'x' } };
const INDEX_CFM = { prefix: /^\/index\.cfm(?=\/)/i, wildcard: 'drop' as const };

const route = (method: string, url: string, extra: Partial<RouteMatrixEntry> = {}): RouteMatrixEntry => ({ method, url, transport: 'service', siteCheck: true, ...extra });
const op = (method: string, path: string, members: Record<string, unknown>, operationId = 'op'): ContractOperation => ({ method, path, operationId, operation: members });
const answer = (body: string, contentType?: string | string[]): InjectedAnswer => ({ statusCode: 200, body, headers: contentType === undefined ? {} : { 'content-type': contentType } });
const ROUTES = [
  route('GET', '/healthz', { public: true }),
  route('GET', '/v1/items/:itemId', { requires: ['member', 's2'] }),
  route('DELETE', '/v1/items/:itemId', { requires: ['s2'], siteCheck: false }),
  route('GET', '/_api/json/v1*', { public: true, edge: true }),
  route('GET', '/index.cfm/_api/json/v1*', { public: true, edge: true }),
];
const HEADS = [route('GET', '/a'), route('HEAD', '/a'), route('HEAD', '/b')];
const MISMATCHED = [route('GET', '/v1/items/:itemId', { requires: ['member'] }), route('DELETE', '/v1/items/:itemId', { requires: ['s2'] })];
const FLAGS = ['public', 'edge', 'invocationOptional', 'siteCheck'] as const;
const FLAGGED = { public: true, edge: true, invocationOptional: true, siteCheck: false };
const FLAGGED_OP = op('GET', '/x', { 'x-opt2-public': true, 'x-opt2-edge': true, 'x-opt2-invocation-optional': true, 'x-opt2-site-check': false });
const CONTRACT_FORM = { transport: 'service', requires: ['member', 's2'] };
const GET_ITEM = OPERATIONS[1] as ContractOperation;
const FRAMED = injectedResponse({ method: 'GET', url: '/healthz?probe=1' }, answer('{"status":"ok"}', 'application/json'));
const ids = (operations: readonly ContractOperation[]): string[] => operations.map(({ method, operationId }) => `${method} ${operationId}`);
const authOf = (members: Record<string, unknown>, options: Parameters<typeof operationAuthProblems>[1] = {}): string[] => operationAuthProblems([op('GET', '/v1/x', members)], options);

describe('contract-route helpers', () => {
  it.each([
    ['/v1/items/:itemId', {}, '/v1/items/{itemId}'],
    ['/v1/sessions/:sid(.+)::end', {}, '/v1/sessions/{sid}:end'],
    ['/x/:id(^a(b)c$)/y', {}, '/x/{id}/y'],
    ['/x/:id([)(]+)/y', {}, '/x/{id}/y'],
    ['/x/:id(\\)+)/y', {}, '/x/{id}/y'],
    ['/j*', {}, '/j*'],
    ['/j*', { wildcard: 'drop' as const }, '/j'],
    ['/files/*', { wildcard: { as: '{path}' } }, '/files/{path}'],
    ['/files/*', { wildcard: (path: string) => `${path}!` }, '/files/*!'],
    ['/INDEX.CFM/j*', INDEX_CFM, '/j'],
  ])('toContractPath maps %s with %o to %s', (url, options, expected) => {
    expect(toContractPath(url, options)).toBe(expected);
  });

  it.each<[string, () => unknown, unknown]>([
    ['contractOperations lists operations in path, then specification method, order', () => ids(OPERATIONS), ['GET healthz', 'GET getItem', 'DELETE deleteItem', 'GET jsonGet']],
    ['contractOperations takes the methods given, skipping non-objects and reading a non-string operationId as empty', () => ids(contractOperations(LOOSE_DOC, { methods: ['DELETE', 'put', 'get'] })), ['DELETE del', 'GET ']],
    ['contractRouteKey keys a route by its method and contract path', () => contractRouteKey({ method: 'GET', url: '/files/*' }, { wildcard: { as: '{path}' } }), 'GET /files/{path}'],
    ['operationRouteKeys keys an operation by its template', () => operationRouteKeys(op('GET', '/a/{id}', {})), ['GET /a/{id}']],
    ['operationRouteKeys keys an operation by its x-opt2-fastify-path', () => operationRouteKeys(op('POST', '/a/{id}:end', { 'x-opt2-fastify-path': '/a/:id::end' })), ['POST /a/{id}:end']],
    ['operationRouteKeys keys an operation by each path of its list', () => operationRouteKeys(op('GET', '/j', { 'x-opt2-fastify-path': ['/j*', '/index.cfm/j*'] }), INDEX_CFM), ['GET /j', 'GET /j']],
    ['withoutHeadTwins drops the HEAD twin of each GET route and keeps a HEAD route of its own', () => withoutHeadTwins(HEADS), [HEADS[0], HEADS[2]]],
    ['withoutHeadTwins keeps the twins keep accepts', () => withoutHeadTwins(HEADS, () => true), HEADS],
    ['diffRoutes finds nothing when the routes are exactly the operations', () => diffRoutes(ROUTES, OPERATIONS, INDEX_CFM), { undeclared: [], unregistered: [] }],
    ['diffRoutes reports a route the contract does not declare', () => diffRoutes(ROUTES, OPERATIONS.slice(1), INDEX_CFM), { undeclared: ['GET /healthz'], unregistered: [] }],
    ['diffRoutes names each key no route serves', () => diffRoutes(ROUTES.slice(0, 3), OPERATIONS, INDEX_CFM).unregistered, ['jsonGet (GET /_api/json/v1)', 'jsonGet (GET /_api/json/v1)']],
    ['diffRoutes reports each such key once as a key', () => diffRoutes(ROUTES.slice(0, 3), OPERATIONS, { ...INDEX_CFM, report: 'key' }).unregistered, ['GET /_api/json/v1']],
    ['declarations default to transport, requires and public', () => [routeDeclaration({ ...CONTRACT_FORM, siteCheck: true }), operationDeclaration(GET_ITEM)], [CONTRACT_FORM, CONTRACT_FORM]],
    ['declarations read only the fields asked for', () => [routeDeclaration({ transport: 'service', requires: ['s2'] }, ['requires']), operationDeclaration(GET_ITEM, ['transport'])], [{ requires: ['s2'] }, { transport: 'service' }]],
    ['declarations keep the flags that differ from their defaults', () => [routeDeclaration(FLAGGED, FLAGS), operationDeclaration(FLAGGED_OP, FLAGS)], [FLAGGED, FLAGGED]],
    ['routeDeclaration leaves out flags at their defaults', () => routeDeclaration({ public: false, siteCheck: true }, FLAGS), {}],
    ['declarationMismatches finds nothing for matching routes', () => declarationMismatches(ROUTES, OPERATIONS, { ...INDEX_CFM, fields: ['transport', 'requires', 'public', 'edge', 'siteCheck'] }), []],
    ['declarationMismatches names the operation and key of each mismatch', () => declarationMismatches(MISMATCHED, OPERATIONS), ['getItem GET /v1/items/{itemId}']],
    ['declarationMismatches appends the route declaration', () => declarationMismatches(MISMATCHED, OPERATIONS, { withDeclaration: true }), ['getItem GET /v1/items/{itemId}: {"transport":"service","requires":["member"]}']],
    ['declarationMismatches compares the fields asked for', () => declarationMismatches(MISMATCHED, OPERATIONS, { fields: ['siteCheck'], withDeclaration: true }), ['deleteItem DELETE /v1/items/{itemId}: {}']],
    ['operationIdProblems lists missing ids and each repeated id once', () => operationIdProblems([op('GET', '/a', {}, ''), op('GET', '/b', {}, 'b'), op('PUT', '/b', {}, 'b'), op('POST', '/b', {}, 'b')]), { missing: ['GET /a'], duplicated: ['b'] }],
    ['operationAuthProblems accepts the transport of its path and one access form', () => authOf({ 'x-opt2-transport': 'service', 'x-opt2-public': true }, { transportForPath }), []],
    ['operationAuthProblems names an unknown transport', () => authOf({ 'x-opt2-transport': 'smtp', 'x-opt2-public': true }), ['GET /v1/x: unknown transport smtp']],
    ['operationAuthProblems reads only the transports given', () => authOf({ 'x-opt2-transport': 'cloud-tasks', 'x-opt2-public': true }, { transports: ['service'] }), ['GET /v1/x: unknown transport cloud-tasks']],
    ['operationAuthProblems names a transport not its path takes', () => authOf({ 'x-opt2-transport': 'pubsub-push', 'x-opt2-requires': ['s2'] }, { transportForPath }), ['GET /v1/x: transport pubsub-push, the path takes service']],
    ['operationAuthProblems names a missing access form', () => authOf({ 'x-opt2-transport': 'service' }), ['GET /v1/x: declares both or neither of x-opt2-requires and x-opt2-public']],
    ['operationAuthProblems names an empty role list', () => authOf({ 'x-opt2-transport': 'service', 'x-opt2-requires': [] }), ['GET /v1/x: x-opt2-requires is not a non-empty list']],
    ['injectedBody parses a JSON or +json body', () => [injectedBody(answer('{"a":1}', 'application/json; charset=utf-8')), injectedBody(answer('[1]', 'application/problem+json'))], [{ a: 1 }, [1]]],
    ['injectedBody keeps the text of another or a listed content type', () => [injectedBody(answer('<p>', 'text/html')), injectedBody(answer('{"a":1}', ['application/json']))], ['<p>', '{"a":1}']],
    ['injectedBody reads an empty body as undefined or the empty text asked for', () => [injectedBody(answer('', 'application/json')), injectedBody(answer('', 'application/json'), '')], [undefined, '']],
    ['injectedResponse frames path, status, content type and text', () => FRAMED, { method: 'GET', path: '/healthz', status: 200, contentType: 'application/json', body: '{"status":"ok"}' }],
    ['injectedResponse takes the body given, undefined included', () => injectedResponse({ method: 'GET', url: '/' }, answer('{}'), { body: undefined }).body, undefined],
    ['assertResponseMatchesOpenApi accepts the framed response', () => assertResponseMatchesOpenApi(DOC, FRAMED), { status: 'ok' }],
  ])('%s', (_label, run, expected) => {
    expect(run()).toStrictEqual(expected);
  });

  it.each<[string, () => unknown, Error | SyntaxErrorConstructor]>([
    ['contractOperations throws a TypeError for a document without paths', () => contractOperations({}), new TypeError('OpenAPI document has no paths object')],
    ['contractOperations throws a TypeError for paths that are not an object', () => contractOperations({ paths: [] }), new TypeError('OpenAPI document has no paths object')],
    ['toContractPath throws a TypeError for a parameter pattern that never closes', () => toContractPath('/x/:id(a(b)'), new TypeError('Unbalanced parameter pattern in /x/:id(a(b)')],
    ['injectedBody throws on a JSON media type whose body is not JSON', () => injectedBody(answer('nope', 'application/json')), SyntaxError],
  ])('%s', (_label, run, error) => {
    expect(run).toThrow(error);
  });
});
