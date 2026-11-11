import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { matchRouteKey, type RouteKeyRequest, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { routeKeyCaseOptions } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadCatalogue, type Step } from '../../src/golden/catalogue.js';
import { basicAuth } from '../../src/golden/session.js';
import { inventoryRouteKeyForRequest, loadInventoryVariants } from '../../src/inventory/route-keys.js';
import { repoPath } from '../../src/lib/paths.js';

type Json = Record<string, unknown>;
type Scalar = string | number | boolean;
type Conjunction = readonly Json[];
type TemplateSegment = { literal: string } | { param: string; wildcard: boolean };
type RequestShape = Pick<Step, 'method' | 'route' | 'auth' | 'headers' | 'form' | 'body' | 'multipart'>;

interface Contract {
  file: string;
  doc: Json;
}

interface Operation {
  contract: Contract;
  template: string;
  method: string;
  segments: readonly TemplateSegment[];
  operation: Json;
  routeKeys: readonly string[] | undefined;
}

/** A poll condition or body extraction of a step. */
interface BodyPath {
  label: string;
  path: string;
  equals?: Scalar;
}

/** One expanded request of a path-bearing step and what the check found for it. */
interface CheckedRequest {
  scenario: string;
  step: string;
  variant: string;
  method: string;
  route: string;
  key: string;
  paths: readonly BodyPath[];
  operations: readonly Operation[];
  unmapped: string | undefined;
  /** Paths a contract excludes, a fixture contract leaves undeclared, no fixture source names, or legacy omits. */
  problems: string[];
  /** Paths a non-fixture contract leaves open without declaring. */
  undeclared: string[];
  /** Entity paths legacy's field selection serialises. */
  decided: string[];
  evidence: string[];
}

/** A body path's first key inside a JSON API entity, judged by legacy getFilteredValues. */
interface EntityField {
  entity: string;
  method: string;
  prefix: string;
  served: boolean;
  basis: string;
}

/** Neutral CF UUID standing in for every placeholder when keying a request. */
const NEUTRAL_ID = '00000000-0000-0000-0000000000000000';
const INNERMOST = /\$\{[^${}]*\}/g;
const MATRIX_REF = /\$\{matrix\.([a-zA-Z][\w-]*)\}/g;
const FIXTURE_ROOT = ['legacy-fixtures', 'cfml', 'api.cfm'];
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const CONTENT_TYPES = {
  form: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
  body: 'application/json',
};
const COMMUNICATIONS = 'services/communications/contracts/openapi.yaml';
const MESSAGE_DETAIL = '/legacy-fixtures/cfml/api.cfm/communications/messages/{id}';
const CONTENT = 'services/strategies-content/contracts/openapi.yaml';
const CONTENT_PATH = '/_api/json/v1/{siteid}/{path}';
/** Segments before the entity a JSON API method serialises: `data`, or `data.items[n]`. */
const ENTITY_DEPTH = new Map([
  ['findone', 1],
  ['findnew', 1],
  ['save', 1],
  ['findall', 3],
  ['findmany', 3],
  ['findquery', 3],
]);
const ENTITY_KEY = /^(?:api|rest):([^.{]+)\.([^.{]+)$/;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolvePointer(doc: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`$ref ${ref} is not a local JSON pointer`);
  let node: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    node = isRecord(node) || Array.isArray(node) ? (node as Json)[key] : undefined;
    if (node === undefined) throw new Error(`$ref ${ref} does not resolve`);
  }
  return node;
}

/** `value` with `$ref` chains followed; for parameters, path items and responses. */
function deref(doc: Json, value: unknown): unknown {
  let current = value;
  for (const seen = new Set<string>(); isRecord(current) && typeof current.$ref === 'string'; ) {
    if (seen.has(current.$ref)) throw new Error(`$ref ${current.$ref} is circular`);
    seen.add(current.$ref);
    current = resolvePointer(doc, current.$ref);
  }
  return current;
}

function loadContracts(): Contract[] {
  return readdirSync(repoPath('services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `services/${entry.name}/contracts/openapi.yaml`)
    .filter((file) => existsSync(repoPath(file)))
    .sort()
    .map((file) => ({ file, doc: parse(readFileSync(repoPath(file), 'utf8')) as Json }));
}

function operationsOf(contract: Contract): Operation[] {
  const paths = isRecord(contract.doc.paths) ? contract.doc.paths : {};
  return Object.entries(paths).flatMap(([template, raw]) => {
    const item = deref(contract.doc, raw);
    if (!isRecord(item)) return [];
    return HTTP_METHODS.flatMap((method) => {
      const operation = item[method];
      if (!isRecord(operation)) return [];
      const params = [item.parameters, operation.parameters]
        .flatMap((list) => (Array.isArray(list) ? list : []))
        .map((param: unknown) => deref(contract.doc, param))
        .filter(isRecord);
      const wildcards = new Set(
        params.filter((p) => p.in === 'path' && p['x-opt2-wildcard'] === true).map((p) => p.name),
      );
      const segments = template
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment): TemplateSegment => {
          const param = /^\{(.+)\}$/.exec(segment)?.[1];
          return param === undefined ? { literal: segment } : { param, wildcard: wildcards.has(param) };
        });
      const keys = operation['x-opt2-route-keys'];
      const routeKeys = Array.isArray(keys) ? keys.map(String) : undefined;
      return [{ contract, template, method: method.toUpperCase(), segments, operation, routeKeys }];
    });
  });
}

const CONTRACTS = loadContracts();
const OPERATIONS = CONTRACTS.flatMap(operationsOf);

/** Whether route `segments` fill `template`; a placeholder segment only fills a parameter, a wildcard one or more. */
function fillsTemplate(template: readonly TemplateSegment[], segments: readonly string[]): boolean {
  const [head, ...rest] = template;
  const [first] = segments;
  if (head === undefined || first === undefined) return head === undefined && first === undefined;
  if ('literal' in head) {
    const same = !first.includes('${') && first.toLowerCase() === head.literal.toLowerCase();
    return same && fillsTemplate(rest, segments.slice(1));
  }
  if (!head.wildcard) return fillsTemplate(rest, segments.slice(1));
  return segments.some((_, n) => fillsTemplate(rest, segments.slice(n + 1)));
}

function literalCount(op: Operation): number {
  return op.segments.filter((segment) => 'literal' in segment).length;
}

/** Most specific operations declaring the route path, the method and, where they list route keys, the request's key. */
function operationsFor(
  segments: readonly string[],
  key: RouteKeyResult,
): { operations: Operation[]; unmapped?: string } {
  const byPath = OPERATIONS.filter((op) => fillsTemplate(op.segments, segments));
  if (byPath.length === 0) return { operations: [], unmapped: 'no contract declares the path' };
  const templates = [...new Set(byPath.map((op) => `${op.contract.file} ${op.template}`))].join(', ');
  const byMethod = byPath.filter((op) => op.method === key.httpMethod);
  if (byMethod.length === 0) return { operations: [], unmapped: `no ${key.httpMethod} on ${templates}` };
  const byKey = byMethod.filter((op) => op.routeKeys === undefined || matchRouteKey(key, op.routeKeys) !== undefined);
  if (byKey.length === 0) return { operations: [], unmapped: `no operation of ${templates} lists ${key.key}` };
  const best = Math.max(...byKey.map(literalCount));
  return { operations: byKey.filter((op) => literalCount(op) === best) };
}

function product(left: readonly Conjunction[], right: readonly Conjunction[]): Conjunction[] {
  return left.flatMap((a) => right.map((b) => [...a, ...b]));
}

/** Alternatives of `schema`, each the schema objects that all apply: `$ref`, `allOf` joined; `anyOf`, `oneOf` split. */
function expand(doc: Json, schema: unknown, refs: readonly string[] = []): Conjunction[] {
  if (schema === false) return [];
  if (!isRecord(schema)) return [[]];
  let alternatives: Conjunction[] = [[schema]];
  const ref = schema.$ref;
  if (typeof ref === 'string' && !refs.includes(ref)) {
    alternatives = product(alternatives, expand(doc, resolvePointer(doc, ref), [...refs, ref]));
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) alternatives = product(alternatives, expand(doc, branch, refs));
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      alternatives = product(alternatives, branches.flatMap((branch: unknown) => expand(doc, branch, refs)));
    }
  }
  return alternatives;
}

const INDEX = /^\d+$/;

/** Sub-schema `node` declares for `segment`; names match exactly, then case-insensitively, as the runner reads them. */
function declaredChild(node: Json, segment: string): unknown {
  if (INDEX.test(segment)) {
    const index = Number(segment);
    if (Array.isArray(node.prefixItems) && index < node.prefixItems.length) return node.prefixItems[index];
    if (node.items !== undefined && node.items !== false) return node.items;
  }
  const properties = isRecord(node.properties) ? node.properties : {};
  const lower = segment.toLowerCase();
  const name = Object.hasOwn(properties, segment)
    ? segment
    : Object.keys(properties).find((candidate) => candidate.toLowerCase() === lower);
  if (name !== undefined) return properties[name] ?? true;
  if (isRecord(node.patternProperties)) {
    const match = Object.entries(node.patternProperties).find(([pattern]) => new RegExp(pattern, 'u').test(segment));
    if (match !== undefined) return match[1];
  }
  return isRecord(node.additionalProperties) ? node.additionalProperties : undefined;
}

function forbids(node: Json, segment: string): boolean {
  const types = node.type === undefined ? [] : [node.type].flat().map(String);
  const index = INDEX.test(segment);
  if (types.length > 0 && !types.includes('object') && !(index && types.includes('array'))) return true;
  if (index && (types.includes('array') || node.items !== undefined || node.prefixItems !== undefined)) {
    return node.items === false;
  }
  return node.additionalProperties === false;
}

/** Sub-schemas `conjunction` declares for `segment`; `open` when none declares it but all allow it, else `excluded`. */
function childSchemas(conjunction: Conjunction, segment: string): { declared: unknown[] } | 'open' | 'excluded' {
  const declared: unknown[] = [];
  let closed = false;
  for (const node of conjunction) {
    const child = declaredChild(node, segment);
    if (child !== undefined) declared.push(child);
    else if (forbids(node, segment)) return 'excluded';
    else if (!INDEX.test(segment) && node.unevaluatedProperties === false) closed = true;
  }
  if (declared.length > 0) return { declared };
  return closed ? 'excluded' : 'open';
}

function sameValue(a: unknown, b: Scalar): boolean {
  return a === b || (['string', 'number', 'boolean'].includes(typeof a) && String(a) === String(b));
}

function admits(conjunction: Conjunction, value: Scalar): boolean {
  return conjunction.every(
    (node) =>
      (!Array.isArray(node.enum) || node.enum.some((item: unknown) => sameValue(item, value))) &&
      (!Object.hasOwn(node, 'const') || sameValue(node.const, value)),
  );
}

function successSchemas(op: Operation): unknown[] {
  const responses = isRecord(op.operation.responses) ? op.operation.responses : {};
  return Object.entries(responses)
    .filter(([status]) => /^2(?:\d\d|XX)$/i.test(status))
    .flatMap(([, raw]) => {
      const response = deref(op.contract.doc, raw);
      const content = isRecord(response) && isRecord(response.content) ? response.content : {};
      return Object.entries(content)
        .filter(([type]) => /json/i.test(type))
        .map(([, media]) => (isRecord(media) ? media.schema : undefined))
        .filter((schema) => schema !== undefined);
    });
}

function pathSegments(path: string): string[] {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.');
}

type Verdict = 'declared' | 'open' | 'excluded';

/** Whether `op`'s success responses declare `body` (and polled value), leave it open from `openAt`, or exclude it. */
function pathVerdict(op: Operation, body: BodyPath): { verdict: Verdict; detail: string; openAt?: string } {
  const schemas = successSchemas(op);
  if (schemas.length === 0) return { verdict: 'excluded', detail: 'declares no JSON success response' };
  const segments = pathSegments(body.path);
  let alternatives = schemas.flatMap((schema) => expand(op.contract.doc, schema));
  let openAt: string | undefined;
  const unresolved = (excluded: string): { verdict: Verdict; detail: string; openAt?: string } =>
    openAt === undefined
      ? { verdict: 'excluded', detail: excluded }
      : { verdict: 'open', detail: `leaves ${openAt} open without declaring it`, openAt };
  for (const [index, segment] of segments.entries()) {
    const prefix = segments.slice(0, index + 1).join('.');
    alternatives = alternatives.flatMap((conjunction) => {
      const child = childSchemas(conjunction, segment);
      if (child === 'open') openAt ??= prefix;
      return typeof child === 'string' ? [] : expand(op.contract.doc, { allOf: child.declared });
    });
    if (alternatives.length === 0) return unresolved(`excludes ${prefix}`);
  }
  const { equals } = body;
  if (equals !== undefined && !alternatives.some((conjunction) => admits(conjunction, equals))) {
    return unresolved(`admits no ${JSON.stringify(equals)} at ${body.path}`);
  }
  return { verdict: 'declared', detail: 'declares it' };
}

/** Lower-cased `x-opt2-default-fields` of the `<entity>Entity` schema `op`'s `data` can be. */
function defaultFields(op: Operation, entity: string): string[] | undefined {
  const { components } = op.contract.doc;
  const schemas = isRecord(components) && isRecord(components.schemas) ? components.schemas : {};
  const name = Object.keys(schemas).find((candidate) => candidate.toLowerCase() === `${entity}entity`);
  const schema = name === undefined ? undefined : schemas[name];
  const fields = isRecord(schema) ? schema['x-opt2-default-fields'] : undefined;
  if (!Array.isArray(fields)) return undefined;
  const atData = successSchemas(op)
    .flatMap((root) => expand(op.contract.doc, root))
    .flatMap((conjunction) => {
      const child = childSchemas(conjunction, 'data');
      return typeof child === 'string' ? [] : expand(op.contract.doc, { allOf: child.declared });
    });
  return atData.some((conjunction) => conjunction.includes(schema as Json))
    ? fields.map((field) => String(field).toLowerCase())
    : undefined;
}

/** Lower-cased items of URL parameter `name`, read case-insensitively as the CF url scope does. */
function queryList(query: RouteKeyRequest['query'], name: string): string[] {
  return Object.entries(query)
    .filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, value]) => [value].flat().join(',').split(','))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
}

/** Top-level keys legacy getFilteredValues serialises for an entity; undefined when it serialises every value. */
function servedFields(
  defaults: readonly string[],
  entity: string,
  method: string,
  query: RouteKeyRequest['query'],
): { keys: Set<string>; basis: string } | undefined {
  // Saves and new beans serialise expanded: `fields` applies only when `entityname` names the entity, `expand` never.
  const expanded = method === 'save' || method === 'findnew';
  const requested = !expanded || queryList(query, 'entityname').includes(entity) ? queryList(query, 'fields') : [];
  const expand = expanded ? [] : queryList(query, 'expand');
  const fields =
    requested.length === 0
      ? defaults
      : [
          ...requested,
          entity === 'content' ? 'contentid' : `${entity}id`,
          'siteid',
          ...(expand.includes('crumbs') ? ['links', 'path'] : []),
        ];
  if ([...fields, ...expand].some((item) => item === '*' || item === 'all') || fields.includes('extendeddata')) {
    return undefined;
  }
  const added = ['isnew', 'id', 'entityname', ...expand, ...(method === 'save' ? ['saveerrors', 'errors'] : [])];
  return {
    keys: new Set([...fields, ...added]),
    basis: requested.length === 0 ? 'default fields' : `fields=${requested.join(',')}`,
  };
}

/** The key `path` reads inside the entity request `baseKey` serialises, where `op` declares its default fields. */
function entityField(
  op: Operation,
  baseKey: string,
  query: RouteKeyRequest['query'],
  path: string,
): EntityField | undefined {
  const [, entity, method] = ENTITY_KEY.exec(baseKey) ?? [];
  const depth = method === undefined ? undefined : ENTITY_DEPTH.get(method);
  if (entity === undefined || method === undefined || depth === undefined) return undefined;
  const segments = pathSegments(path);
  const lower = segments.map((segment) => segment.toLowerCase());
  const field = lower[depth];
  const inEntity = lower[0] === 'data' && (depth === 1 || (lower[1] === 'items' && INDEX.test(lower[2] ?? '')));
  const defaults = defaultFields(op, entity);
  if (!inEntity || field === undefined || defaults === undefined) return undefined;
  const served = servedFields(defaults, entity, method, query);
  if (served === undefined) return undefined;
  const prefix = segments.slice(0, depth + 1).join('.');
  return { entity, method, prefix, served: served.keys.has(field), basis: served.basis };
}

const sources = new Map<string, string[]>();

function sourceLines(file: string): string[] {
  let lines = sources.get(file);
  if (lines === undefined) {
    lines = readFileSync(repoPath(file), 'utf8').split('\n');
    sources.set(file, lines);
  }
  return lines;
}

/** Fixture CFML and SQL that build a module's responses. */
function fixtureFiles(module: string): string[] {
  const sqlDir = `legacy-fixtures/sql/${module}`;
  const sql = existsSync(repoPath(sqlDir))
    ? readdirSync(repoPath(sqlDir))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => `${sqlDir}/${name}`)
    : [];
  return [`legacy-fixtures/cfml/modules/${module}.cfc`, 'legacy-fixtures/cfml/lib/envelope.cfc', ...sql].filter(
    (file) => existsSync(repoPath(file)),
  );
}

/** `file:line` of the first fixture source naming `field` as a whole word, case-insensitively. */
function fieldEvidence(module: string, field: string): string | undefined {
  const word = new RegExp(`(?<![\\w])${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i');
  for (const file of fixtureFiles(module)) {
    const line = sourceLines(file).findIndex((text) => word.test(text));
    if (line !== -1) return `${file}:${line + 1}`;
  }
  return undefined;
}

function fill(text: string): string {
  let out = text;
  for (let last = ''; out !== last; ) {
    last = out;
    out = out.replace(INNERMOST, NEUTRAL_ID);
  }
  return out;
}

function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => mapStrings(item, fn)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [fn(key), mapStrings(item, fn)])) as T;
  }
  return value;
}

function combinations(matrix: Step['matrix']): Record<string, string>[] {
  return Object.entries(matrix ?? {}).reduce<Record<string, string>[]>(
    (acc, [name, values]) => acc.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value }))),
    [{}],
  );
}

function splitRoute(route: string): [path: string, search: string] {
  const at = route.indexOf('?');
  return at === -1 ? [route, ''] : [route.slice(0, at), route.slice(at + 1)];
}

function queryOf(search: string): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>();
  for (const [name, value] of new URLSearchParams(search)) {
    const previous = query.get(name);
    query.set(name, previous === undefined ? value : [previous, value].flat());
  }
  return Object.fromEntries(query);
}

/** Route-key input of a request shape whose matrix placeholders are substituted. */
function keyRequest(shape: RequestShape): RouteKeyRequest {
  const [path, search] = splitRoute(shape.route);
  const headers: Record<string, string> = {};
  const auth = shape.auth === undefined ? undefined : fill(shape.auth);
  if (auth?.startsWith('basic:')) {
    const [user = '', ...secret] = auth.slice('basic:'.length).split(':');
    headers.Authorization = basicAuth(user, secret.join(':'));
  } else if (auth?.startsWith('bearer:')) {
    headers.Authorization = `Bearer ${auth.slice('bearer:'.length)}`;
  }
  const kind = (['form', 'multipart', 'body'] as const).find((name) => shape[name] !== undefined);
  if (kind !== undefined) headers['Content-Type'] = CONTENT_TYPES[kind];
  Object.assign(headers, mapStrings(shape.headers ?? {}, fill));
  const request: RouteKeyRequest = { method: shape.method, path: fill(path), query: queryOf(fill(search)), headers };
  if (shape.form !== undefined) request.form = mapStrings(shape.form, fill);
  if (shape.multipart !== undefined) {
    request.form = mapStrings(shape.multipart.fields, fill);
    request.multipartFileNames = shape.multipart.files.map(({ field, filename }) => ({ field, filename }));
  }
  if (shape.body !== undefined) request.jsonBody = mapStrings(shape.body, fill);
  return request;
}

function bodyPaths(step: Step, combo: Record<string, string>): BodyPath[] {
  const substitute = (text: string): string => text.replace(MATRIX_REF, (_, name: string) => combo[name] ?? '');
  const paths: BodyPath[] = [];
  if (step.poll !== undefined) {
    paths.push({ label: 'poll', path: substitute(step.poll.until.path), equals: step.poll.until.equals });
  }
  for (const [name, extraction] of Object.entries(step.extract ?? {})) {
    if (extraction.from === 'body') paths.push({ label: `extract ${name}`, path: substitute(extraction.path) });
  }
  return paths;
}

function routeSegments(route: string): string[] {
  return splitRoute(route)[0]
    .split('/')
    .filter((segment) => segment !== '');
}

function fixtureModule(segments: readonly string[]): string | undefined {
  return FIXTURE_ROOT.every((part, i) => segments[i] === part) ? segments[FIXTURE_ROOT.length] : undefined;
}

/** Every request of a step carrying a poll or body extraction, checked against the contracts and fixture sources. */
async function checkCatalogue(): Promise<{ checked: CheckedRequest[]; unchecked: number }> {
  const catalogue = await loadCatalogue();
  const options = { ...routeKeyCaseOptions, variants: (await loadInventoryVariants()).variants };
  const checked: CheckedRequest[] = [];
  let unchecked = 0;
  for (const scenario of catalogue.scenarios) {
    for (const step of scenario.steps) {
      for (const combo of combinations(step.matrix)) {
        const paths = bodyPaths(step, combo);
        if (paths.length === 0) {
          unchecked += 1;
          continue;
        }
        const shapes: RequestShape[] = [step, ...(step.candidates ?? []).map((c) => ({ ...c, auth: step.auth }))];
        const matrixLabel = Object.keys(combo).length === 0 ? '' : ` matrix${JSON.stringify(combo)}`;
        for (const [index, raw] of shapes.entries()) {
          const shape = mapStrings(raw, (text) => text.replace(MATRIX_REF, (_, name: string) => combo[name] ?? ''));
          const request = keyRequest(shape);
          const key = await inventoryRouteKeyForRequest(request, options);
          const segments = routeSegments(shape.route);
          const { operations, unmapped } = operationsFor(segments, key);
          const module = fixtureModule(segments);
          const problems: string[] = [];
          const undeclared: string[] = [];
          const decided: string[] = [];
          for (const op of operations) {
            for (const body of paths) {
              const { verdict, detail, openAt } = pathVerdict(op, body);
              const where = `${op.contract.file} ${op.method} ${op.template}`;
              const field = verdict === 'excluded' ? undefined : entityField(op, key.baseKey, request.query, body.path);
              if (field !== undefined && (!field.served || verdict === 'declared' || openAt === field.prefix)) {
                const verb = field.served ? 'serves' : 'omits';
                const judged = `legacy ${field.entity} ${field.method} with ${field.basis} ${verb} ${field.prefix}`;
                const entry = `${body.label} ${body.path}: ${judged} (${where})`;
                (field.served ? decided : problems).push(entry);
                continue;
              }
              const finding = `${body.label} ${body.path}: ${where} ${detail}`;
              if (verdict === 'excluded' || (verdict === 'open' && module !== undefined)) problems.push(finding);
              else if (verdict === 'open') undeclared.push(finding);
            }
          }
          const evidence: string[] = [];
          if (module !== undefined) {
            const fields = new Set(paths.flatMap((body) => pathSegments(body.path)).filter((s) => !INDEX.test(s)));
            for (const field of fields) {
              const found = fieldEvidence(module, field);
              if (found === undefined) problems.push(`${field}: no fixture source of ${module} names it`);
              else evidence.push(`${field}@${found}`);
            }
          }
          checked.push({
            scenario: scenario.id,
            step: step.name,
            variant: `${matrixLabel}${index === 0 ? '' : ` candidate[${index - 1}]`}`,
            method: key.httpMethod,
            route: shape.route,
            key: key.key,
            paths,
            operations,
            unmapped,
            problems,
            undeclared,
            decided,
            evidence,
          });
        }
      }
    }
  }
  return { checked, unchecked };
}

function describeRequest(r: CheckedRequest): string {
  return `${r.scenario} ${r.step}${r.variant} ${r.method} ${r.route} (${r.key})`;
}

function describePaths(r: CheckedRequest): string {
  return r.paths.map((p) => `${p.label} ${p.path}${p.equals === undefined ? '' : ` = ${String(p.equals)}`}`).join('; ');
}

const result = checkCatalogue();

const REQUIRED: Array<[scenario: string, step: string]> = [
  ['GS-CM-02', 'history'],
  ['GS-RE-01', 'xlsx-poll'],
  ['GS-RE-01', 'csv-poll'],
  ['GS-RE-01', 'pdf-poll'],
  ['GS-RE-02', 'poll'],
];

const COLUMN_CASES = [
  {
    name: 'message',
    cfc: 'legacy-fixtures/cfml/modules/communications.cfc',
    select: /variables\.messageColumns = "([^"]+)"/,
    contract: COMMUNICATIONS,
    schema: 'MessageFields',
  },
  {
    name: 'delivery history',
    cfc: 'legacy-fixtures/cfml/modules/communications.cfc',
    select: /SELECT ([^"]+?) FROM synthetic\.delivery_status/,
    contract: COMMUNICATIONS,
    schema: 'DeliveryStatusEntry',
  },
  {
    name: 'export job',
    cfc: 'legacy-fixtures/cfml/modules/reporting.cfc',
    select: /variables\.jobColumns = "([^"]+)"/,
    contract: 'services/reporting/contracts/openapi.yaml',
    schema: 'ExportJob',
  },
];

describe('golden catalogue response paths', () => {
  it('reports which path-bearing steps it maps to a contract operation', async () => {
    const { checked, unchecked } = await result;
    const mapped = checked.filter((r) => r.operations.length > 0);
    const lines = [
      `${checked.length} path-bearing requests: ${mapped.length} mapped, ${checked.length - mapped.length} unmapped; ` +
        `${unchecked} step requests carry no poll or body extraction`,
      ...mapped.map((r) => {
        const operations = r.operations.map((op) => `${op.contract.file} ${op.method} ${op.template}`).join(' | ');
        const evidence = r.evidence.length > 0 ? ` cfml ${r.evidence.join(', ')}` : '';
        return `mapped   ${describeRequest(r)} -> ${operations} [${describePaths(r)}]${evidence}`;
      }),
      ...checked
        .filter((r) => r.operations.length === 0)
        .map((r) => `unmapped ${describeRequest(r)}: ${r.unmapped ?? ''} [${describePaths(r)}]`),
      ...checked.flatMap((r) => r.decided.map((finding) => `decided  ${describeRequest(r)}: ${finding}`)),
      ...checked.flatMap((r) => r.undeclared.map((finding) => `open     ${describeRequest(r)}: ${finding}`)),
    ];
    console.info(lines.join('\n'));
    expect(mapped.length).toBeGreaterThan(0);
  });

  it('maps every fixture-route step that reads a body path', async () => {
    const { checked } = await result;
    const unmapped = checked
      .filter((r) => fixtureModule(routeSegments(r.route)) !== undefined && r.operations.length === 0)
      .map((r) => `${describeRequest(r)}: ${r.unmapped ?? ''}`);
    expect(unmapped, unmapped.join('\n')).toEqual([]);
  });

  it('finds no excluded path, no undeclared fixture path, none unnamed by fixtures or omitted by legacy', async () => {
    const { checked } = await result;
    const problems = checked.flatMap((r) => r.problems.map((problem) => `${describeRequest(r)}: ${problem}`));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it.each(REQUIRED)('checks %s %s polling data.state against its contract', async (scenario, step) => {
    const { checked } = await result;
    const requests = checked.filter((r) => r.scenario === scenario && r.step === step);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.operations.length, describeRequest(request)).toBeGreaterThan(0);
      expect(request.paths.find((p) => p.label === 'poll')?.path).toBe('data.state');
      expect(request.problems).toEqual([]);
    }
  });

  it.each([
    [COMMUNICATIONS, MESSAGE_DETAIL, 'data.state', 'delivered', 'declared'],
    [COMMUNICATIONS, MESSAGE_DETAIL, 'data.state', 'bounced', 'excluded'],
    [COMMUNICATIONS, MESSAGE_DETAIL, 'data.history[0].status', 'delivered', 'declared'],
    [COMMUNICATIONS, MESSAGE_DETAIL, 'data.status', 'delivered', 'excluded'],
    [COMMUNICATIONS, MESSAGE_DETAIL, 'data.history[0].state', undefined, 'excluded'],
    [COMMUNICATIONS, MESSAGE_DETAIL, 'data.history', undefined, 'declared'],
    [CONTENT, CONTENT_PATH, 'data.contenthistid', undefined, 'declared'],
    [CONTENT, CONTENT_PATH, 'data.fileid', undefined, 'open'],
  ] as Array<[string, string, string, Scalar | undefined, Verdict]>)(
    'walks %s GET %s %s (equals %s) as %s',
    (file, template, path, equals, verdict) => {
      const op = OPERATIONS.find((o) => o.contract.file === file && o.method === 'GET' && o.template === template);
      expect(op).toBeDefined();
      const body: BodyPath = equals === undefined ? { label: 'poll', path } : { label: 'poll', path, equals };
      expect(pathVerdict(op as Operation, body).verdict).toBe(verdict);
    },
  );

  it.each([
    ['GET', 'api:content.findone', {}, 'data.contenthistid', true],
    ['GET', 'api:content.findone', {}, 'data.fileid', false],
    ['GET', 'api:content.findone', { fields: 'fileid' }, 'data.fileid', true],
    ['GET', 'api:content.findone', { Fields: 'fileid' }, 'data.contentid', true],
    ['GET', 'api:content.findone', { fields: 'fileid' }, 'data.title', false],
    ['GET', 'api:content.findone', { fields: 'fileid', expand: 'crumbs' }, 'data.path', true],
    ['GET', 'api:content.findone', { fields: '*' }, 'data.fileid', undefined],
    ['GET', 'api:content.findone', { fields: 'extendeddata' }, 'data.fileid', undefined],
    ['GET', 'api:content.findone', {}, 'apiversion', undefined],
    ['GET', 'api:content.findquery', {}, 'data.items[0].fileid', false],
    ['GET', 'api:content.findquery', {}, 'data.items[0].contenthistid', true],
    ['GET', 'api:content.findquery', {}, 'data.totalitems', undefined],
    ['GET', 'api:content.findnew', {}, 'data.id', true],
    ['GET', 'api:file.findone', {}, 'data.fileid', undefined],
    ['POST', 'api:comment.save', {}, 'data.commentid', false],
    ['POST', 'api:comment.save', { fields: 'commentid' }, 'data.commentid', false],
    ['POST', 'api:comment.save', { fields: 'commentid', entityname: 'comment' }, 'data.commentid', true],
    ['POST', 'api:comment.save', {}, 'data.id', true],
    ['POST', 'api:comment.save', {}, 'data.errors', true],
  ] as Array<[string, string, Record<string, string>, string, boolean | undefined]>)(
    'judges %s %s %j %s as served %s',
    (method, baseKey, query, path, served) => {
      const op = OPERATIONS.find(
        (o) => o.contract.file === CONTENT && o.method === method && o.template === CONTENT_PATH,
      );
      expect(op).toBeDefined();
      expect(entityField(op as Operation, baseKey, query, path)?.served).toBe(served);
    },
  );

  it.each(COLUMN_CASES)('declares the $name columns its fixture CFML selects', ({ cfc, select, contract, schema }) => {
    const columns = select
      .exec(readFileSync(repoPath(cfc), 'utf8'))?.[1]
      ?.split(',')
      .map((column) => column.trim().replace(/^\[|\]$/g, '').toLowerCase());
    expect(columns, `${cfc} ${String(select)}`).toBeDefined();
    const doc = CONTRACTS.find((c) => c.file === contract)?.doc ?? {};
    const declared = resolvePointer(doc, `#/components/schemas/${schema}`);
    const properties = isRecord(declared) && isRecord(declared.properties) ? Object.keys(declared.properties) : [];
    expect([...properties].sort()).toEqual([...(columns ?? [])].sort());
  });
});
