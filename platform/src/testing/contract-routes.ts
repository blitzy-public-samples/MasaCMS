/** Contract-suite helpers: OpenAPI operations, Fastify routes in contract form, route and declaration diffs, operation checks and injected responses. */
import { TRANSPORTS, type RouteMatrixEntry } from '../auth/index.js';
import type { ResponseUnderTest } from './contracts.js';

type Json = Record<string, unknown>;

/** Operation keys of an OpenAPI 3.1 path item, in specification order. */
export const OPENAPI_METHODS: readonly string[] = Object.freeze(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/** Media types whose text is JSON: `application/json` and `application/<subtype>+json`. */
export const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/** One operation of a contract document. */
export interface ContractOperation {
  /** Upper-case HTTP method. */
  readonly method: string;
  /** Path template. */
  readonly path: string;
  /** `operationId`; '' when the operation declares none. */
  readonly operationId: string;
  readonly operation: Readonly<Json>;
}

/** A route as the matrix records it: method and Fastify url. */
export type RouteLocator = Pick<RouteMatrixEntry, 'method' | 'url'>;

/** How Fastify urls become contract paths. */
export interface ContractPathOptions {
  /** Removed from the url first, e.g. `/^\/index\.cfm(?=\/)/i`. */
  prefix?: RegExp;
  /** A trailing `*`: kept (default), dropped, replaced by `as`, or mapped from the converted path. */
  wildcard?: 'keep' | 'drop' | { as: string } | ((path: string) => string);
}

/** Options of {@link diffRoutes}. */
export interface RouteDiffOptions extends ContractPathOptions {
  /** An unregistered operation as `<operationId> (<key>)` (default) or as its key, once. */
  report?: 'operation' | 'key';
}

/** Registered routes the contract does not declare and declared keys no route serves, each sorted. */
export interface RouteDiff {
  undeclared: string[];
  unregistered: string[];
}

/** Declaration members a comparison reads. */
export type DeclarationField = 'transport' | 'requires' | 'public' | 'edge' | 'invocationOptional' | 'siteCheck';

/** A route's auth declaration as a route table or the route matrix states it. */
export interface DeclaredRoute {
  transport?: unknown;
  requires?: readonly string[];
  public?: boolean;
  edge?: boolean;
  invocationOptional?: boolean;
  siteCheck?: boolean;
}

/** A declaration in comparable form: `requires` sorted, defaults left out. */
export interface RouteDeclaration {
  transport?: unknown;
  requires?: string[];
  public?: true;
  edge?: true;
  invocationOptional?: true;
  siteCheck?: false;
}

/** Options of {@link declarationMismatches}. */
export interface DeclarationMismatchOptions extends ContractPathOptions {
  /** Members compared; transport, requires and public by default. */
  fields?: readonly DeclarationField[];
  /** Appends `: <route declaration as JSON>` to each entry. */
  withDeclaration?: boolean;
}

/** Options of {@link operationAuthProblems}. */
export interface OperationAuthOptions {
  /** Accepted `x-opt2-transport` values; every platform transport by default. */
  transports?: readonly string[];
  /** When given, each operation must declare the transport this returns for its path. */
  transportForPath?: (path: string) => string;
}

/** An `app.inject` response as these helpers read it. */
export interface InjectedAnswer {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | number | string[] | undefined>>;
}

const CONTRACT_FIELDS: readonly DeclarationField[] = Object.freeze(['transport', 'requires', 'public']);

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every operation of `doc`, in path order and then `methods` order; throws TypeError when `doc` has no `paths` object. */
export function contractOperations(doc: object, options: { methods?: readonly string[] } = {}): ContractOperation[] {
  const { paths } = doc as Json;
  if (!isRecord(paths)) throw new TypeError('OpenAPI document has no paths object');
  const methods = options.methods ?? OPENAPI_METHODS;
  return Object.entries(paths).flatMap(([path, item]) =>
    !isRecord(item)
      ? []
      : methods.flatMap((method) => {
          const operation = item[method.toLowerCase()];
          if (!isRecord(operation)) return [];
          const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
          return [{ method: method.toUpperCase(), path, operationId, operation }];
        }),
  );
}

/** Index just past the `)` closing the parameter pattern that opens at `open`; escapes and character classes may hold parentheses. */
function afterPattern(url: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < url.length; i += 1) {
    const char = url.charAt(i);
    if (char === '\\') i += 1;
    else if (inClass) inClass = char !== ']';
    else if (char === '[') inClass = true;
    else if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return i + 1;
  }
  throw new TypeError(`Unbalanced parameter pattern in ${url}`);
}

/** A Fastify url in contract form: `::` is a literal colon, `:name` and its `(pattern)` become `{name}`, then `wildcard` applies. */
export function toContractPath(url: string, options: ContractPathOptions = {}): string {
  const source = options.prefix === undefined ? url : url.replace(options.prefix, '');
  let path = '';
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('::', i)) {
      path += ':';
      i += 2;
      continue;
    }
    const param = /^:([A-Za-z_]\w*)/.exec(source.slice(i));
    if (param === null) {
      path += source.charAt(i);
      i += 1;
      continue;
    }
    i += param[0].length;
    if (source.charAt(i) === '(') i = afterPattern(source, i);
    path += `{${param[1] ?? ''}}`;
  }
  const { wildcard = 'keep' } = options;
  if (!path.endsWith('*') || wildcard === 'keep') return path;
  if (wildcard === 'drop') return path.slice(0, -1);
  return typeof wildcard === 'function' ? wildcard(path) : `${path.slice(0, -1)}${wildcard.as}`;
}

/** `METHOD path` key of a registered route in contract form. */
export function contractRouteKey(route: RouteLocator, options: ContractPathOptions = {}): string {
  return `${route.method} ${toContractPath(route.url, options)}`;
}

/** `METHOD path` keys an operation is served under: each `x-opt2-fastify-path`, one or a list, in contract form, else its template. */
export function operationRouteKeys(operation: ContractOperation, options: ContractPathOptions = {}): string[] {
  const served = operation.operation['x-opt2-fastify-path'];
  const paths =
    typeof served === 'string'
      ? [toContractPath(served, options)]
      : Array.isArray(served)
        ? served.map((url) => toContractPath(String(url), options))
        : [operation.path];
  return paths.map((path) => `${operation.method} ${path}`);
}

/** `routes` without Fastify's automatic HEAD twins of GET routes, except those `keep` accepts. */
export function withoutHeadTwins<R extends RouteLocator>(routes: readonly R[], keep: (route: R) => boolean = () => false): R[] {
  const gets = new Set(routes.filter((route) => route.method === 'GET').map((route) => route.url));
  return routes.filter((route) => route.method !== 'HEAD' || !gets.has(route.url) || keep(route));
}

/** Registered routes the contract does not declare, and operations with a key no route serves. */
export function diffRoutes(routes: readonly RouteLocator[], operations: readonly ContractOperation[], options: RouteDiffOptions = {}): RouteDiff {
  const registered = new Set(routes.map((route) => contractRouteKey(route, options)));
  const served = operations.map((operation) => ({ operation, keys: operationRouteKeys(operation, options) }));
  const declared = new Set(served.flatMap(({ keys }) => keys));
  const missing = served.flatMap(({ operation, keys }) =>
    keys.filter((key) => !registered.has(key)).map((key) => (options.report === 'key' ? key : `${operation.operationId} (${key})`)),
  );
  return {
    undeclared: [...registered].filter((key) => !declared.has(key)).sort(),
    unregistered: (options.report === 'key' ? [...new Set(missing)] : missing).sort(),
  };
}

function declarationOf(
  values: { transport: unknown; requires: unknown; public: unknown; edge: unknown; invocationOptional: unknown; siteCheck: unknown },
  fields: readonly DeclarationField[],
): RouteDeclaration {
  const declaration: RouteDeclaration = {};
  for (const field of fields) {
    if (field === 'transport') declaration.transport = values.transport;
    else if (field === 'requires' && Array.isArray(values.requires)) declaration.requires = values.requires.map(String).sort();
    else if (field === 'siteCheck' && values.siteCheck === false) declaration.siteCheck = false;
    else if ((field === 'public' || field === 'edge' || field === 'invocationOptional') && values[field] === true) declaration[field] = true;
  }
  return declaration;
}

/** A registered route's declaration in comparable form; transport, requires and public by default. */
export function routeDeclaration(route: DeclaredRoute, fields: readonly DeclarationField[] = CONTRACT_FIELDS): RouteDeclaration {
  return declarationOf(
    { transport: route.transport, requires: route.requires, public: route.public, edge: route.edge, invocationOptional: route.invocationOptional, siteCheck: route.siteCheck },
    fields,
  );
}

/** The declaration an operation's `x-opt2-*` members require of its route, in the form of {@link routeDeclaration}. */
export function operationDeclaration(operation: ContractOperation, fields: readonly DeclarationField[] = CONTRACT_FIELDS): RouteDeclaration {
  const op = operation.operation;
  return declarationOf(
    {
      transport: op['x-opt2-transport'],
      requires: op['x-opt2-requires'],
      public: op['x-opt2-public'],
      edge: op['x-opt2-edge'],
      invocationOptional: op['x-opt2-invocation-optional'],
      siteCheck: op['x-opt2-site-check'],
    },
    fields,
  );
}

/** `<operationId> <key>` of every route whose declaration differs from an operation served at its key. */
export function declarationMismatches(
  routes: ReadonlyArray<RouteLocator & DeclaredRoute>,
  operations: readonly ContractOperation[],
  options: DeclarationMismatchOptions = {},
): string[] {
  const fields = options.fields ?? CONTRACT_FIELDS;
  const served = operations.map((operation) => ({ operation, keys: operationRouteKeys(operation, options) }));
  return routes.flatMap((route) => {
    const key = contractRouteKey(route, options);
    const actual = JSON.stringify(routeDeclaration(route, fields));
    return served
      .filter(({ operation, keys }) => keys.includes(key) && JSON.stringify(operationDeclaration(operation, fields)) !== actual)
      .map(({ operation }) => `${operation.operationId} ${key}${options.withDeclaration === true ? `: ${actual}` : ''}`);
  });
}

/** `METHOD path` of operations without an operationId, and each operationId declared more than once, sorted. */
export function operationIdProblems(operations: readonly ContractOperation[]): { missing: string[]; duplicated: string[] } {
  const ids = operations.map(({ operationId }) => operationId);
  return {
    missing: operations.filter(({ operationId }) => operationId === '').map(({ method, path }) => `${method} ${path}`),
    duplicated: [...new Set(ids.filter((id, index) => id !== '' && ids.indexOf(id) !== index))].sort(),
  };
}

/** Every operation whose transport is unknown or not its path's, or that declares other than exactly one non-empty role list or public access. */
export function operationAuthProblems(operations: readonly ContractOperation[], options: OperationAuthOptions = {}): string[] {
  const transports = options.transports ?? TRANSPORTS;
  return operations.flatMap(({ method, path, operation }) => {
    const at = `${method} ${path}`;
    const transport = operation['x-opt2-transport'];
    const requires = operation['x-opt2-requires'];
    const declaresPublic = operation['x-opt2-public'] === true;
    const problems: string[] = [];
    if (!transports.includes(String(transport))) problems.push(`${at}: unknown transport ${String(transport)}`);
    const expected = options.transportForPath?.(path);
    if (expected !== undefined && transport !== expected) problems.push(`${at}: transport ${String(transport)}, the path takes ${expected}`);
    if ((requires === undefined) !== declaresPublic) problems.push(`${at}: declares both or neither of x-opt2-requires and x-opt2-public`);
    if (requires !== undefined && !(Array.isArray(requires) && requires.length > 0)) problems.push(`${at}: x-opt2-requires is not a non-empty list`);
    return problems;
  });
}

/** The body of `res`: parsed for a non-empty JSON media type, else its text, `empty` when there is none. */
export function injectedBody(res: InjectedAnswer, empty: '' | undefined = undefined): unknown {
  if (res.body === '') return empty;
  const contentType = res.headers['content-type'];
  return typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType) ? (JSON.parse(res.body) as unknown) : res.body;
}

/** `res` to `request` as assertResponseMatchesOpenApi reads it: the url's path, the status, the content type and `options.body`, else the text sent. */
export function injectedResponse(
  request: { method: string; url: string },
  res: InjectedAnswer,
  options: { body?: unknown } = {},
): ResponseUnderTest {
  return {
    method: request.method,
    path: request.url.split('?')[0] ?? request.url,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: 'body' in options ? options.body : res.body,
  };
}
