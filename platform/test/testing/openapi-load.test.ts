import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ContractAssertionError,
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  loadOpenApiDocument,
} from '../../src/testing/index.js';

type Json = Record<string, unknown>;

const FIXTURES = new URL('../fixtures/openapi-load/', import.meta.url);
const SERVICE = new URL('service/openapi.json', FIXTURES);
const HEALTH_PATH = '/v1/sites/alpha/health';

const raw = (url: URL): Json => JSON.parse(readFileSync(url, 'utf8')) as Json;
const SHARED = raw(new URL('shared.json', FIXTURES));

function componentsOf(doc: Json): Record<string, Json> {
  return doc.components as Record<string, Json>;
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
}

describe('loadOpenApiDocument', () => {
  it.each([
    ['schemas', 'Health'],
    ['schemas', 'Status'],
    ['schemas', 'Odd Name/~'],
    ['parameters', 'SiteId'],
    ['responses', 'Unauthorized'],
    ['headers', 'WritePosition'],
    ['requestBodies', 'Apply'],
    ['securitySchemes', 'ApiKey'],
  ])('replaces the %s alias %s with the shared component', (kind, name) => {
    const loaded = loadOpenApiDocument(SERVICE, JSON.parse);
    expect(componentsOf(loaded)[kind]?.[name]).toEqual(componentsOf(SHARED)[kind]?.[name]);
  });

  it.each([
    ['a file URL', SERVICE],
    ['an absolute path', fileURLToPath(SERVICE)],
    ['a path relative to the working directory', relative(process.cwd(), fileURLToPath(SERVICE))],
  ])('reads %s and keeps everything but the aliases as parsed', (_label, file) => {
    const expected = raw(SERVICE);
    for (const [kind, entries] of Object.entries(componentsOf(expected))) {
      for (const name of Object.keys(entries).filter((key) => key !== 'Local')) {
        entries[name] = componentsOf(SHARED)[kind]?.[name];
      }
    }
    expect(loadOpenApiDocument(file, JSON.parse)).toEqual(expected);
  });

  it('follows an alias of an alias relative to the file that declares it', () => {
    const loaded = loadOpenApiDocument(new URL('chain/openapi.json', FIXTURES), JSON.parse);
    expect(componentsOf(loaded).schemas).toEqual({
      Health: componentsOf(SHARED).schemas?.Health,
      Status: componentsOf(SHARED).schemas?.Status,
    });
  });

  it('returns a self-contained document deep-equal to its parse', () => {
    const file = new URL('shared.json', FIXTURES);
    expect(loadOpenApiDocument(file, JSON.parse)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });

  it('parses each alias target once and shares no object between results', () => {
    let parses = 0;
    const parse = (text: string): unknown => {
      parses += 1;
      return JSON.parse(text) as unknown;
    };
    const first = loadOpenApiDocument(SERVICE, parse);
    const health = componentsOf(first).schemas?.Health as { required: string[] };
    health.required.push('mutated');
    const second = loadOpenApiDocument(SERVICE, parse);
    expect(parses).toBe(3);
    expect(componentsOf(second).schemas?.Health).toEqual(componentsOf(SHARED).schemas?.Health);
    expect(componentsOf(second).schemas?.Health).not.toBe(componentsOf(first).schemas?.Health);
    expect(componentsOf(second).schemas?.Status).not.toBe(componentsOf(first).schemas?.Status);
  });

  it.each([
    ['a document that is not an object', 'not-a-document.json', /not-a-document\.json: is not an OpenAPI document object/],
    ['a missing file', 'missing-file.json', /missing-file\.json#\/components\/schemas\/Health: \$ref \.\/absent\.json#\/components\/schemas\/Health cannot be read/],
    ['a missing target', 'missing-target.json', /missing-target\.json#\/components\/schemas\/Nope: .* does not resolve: .*shared\.json has no #\/components\/schemas\/Nope/],
    ['a kind mismatch', 'kind-mismatch.json', /kind-mismatch\.json#\/components\/schemas\/SiteId: .*parameters\/SiteId must point to #\/components\/schemas\/SiteId/],
    ['a name mismatch', 'name-mismatch.json', /name-mismatch\.json#\/components\/schemas\/Healthy: .* must point to #\/components\/schemas\/Healthy/],
    ['no fragment', 'no-fragment.json', /no-fragment\.json#\/components\/schemas\/Health: \$ref \.\.\/shared\.json must point to/],
    ['a fragment that is not a pointer', 'relative-fragment.json', /relative-fragment\.json#\/components\/schemas\/Health: .* must point to/],
    ['a malformed pointer', 'malformed-pointer.json', /malformed-pointer\.json#\/components\/schemas\/Health: .* must point to/],
    ['a URI that is not a file', 'not-a-file.json', /not-a-file\.json#\/components\/schemas\/Health: \$ref https:.* is not a file reference/],
    ['sibling keys on an alias', 'siblings.json', /siblings\.json#\/components\/schemas\/Health: .* has sibling keys \(description\)/],
    ['an alias cycle', 'cycle-a.json', /cycle-b\.json#\/components\/schemas\/Loop: \$ref \.\/cycle-a\.json#\/components\/schemas\/Loop forms an alias cycle: \S+cycle-a\.json#\S+ -> \S+cycle-b\.json#\S+ -> \S+cycle-a\.json#\/components\/schemas\/Loop$/],
    ['an alias of itself', 'self-cycle.json', /self-cycle\.json#\/components\/schemas\/Loop: .* alias cycle/],
    ['a non-local $ref outside components', 'outside-component.json', /outside-component\.json#\/paths\/~1x\/get\/responses\/200: \$ref \.\.\/shared\.json#\/components\/responses\/Unauthorized is not local/],
    ['a non-local $ref inside a target', 'target-outside-component.json', /target-with-nested-ref\.json#\/components\/schemas\/Wrapped\/properties\/a: .* is not local/],
    ['a local $ref the result does not resolve', 'unresolved-local.json', /unresolved-local\.json#\/components\/schemas\/Health\/properties\/status: \$ref #\/components\/schemas\/Status does not resolve/],
  ])('throws a TypeError naming the file and pointer for %s', (_label, fixture, message) => {
    const error = thrown(() => loadOpenApiDocument(new URL(`errors/${fixture}`, FIXTURES), JSON.parse));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toMatch(message);
  });
});

describe('contract assertions over a loaded document', () => {
  const doc = loadOpenApiDocument(SERVICE, JSON.parse);

  it('validates responses through aliased schemas and responses', () => {
    const response = { method: 'GET', path: HEALTH_PATH, contentType: 'application/json' };
    expect(assertResponseMatchesOpenApi(doc, { ...response, status: 200, body: { status: 'ok' } })).toEqual({ status: 'ok' });
    expect(assertResponseMatchesOpenApi(doc, { ...response, status: 401, body: '"ok"' })).toBe('ok');
    expect(() => assertResponseMatchesOpenApi(doc, { ...response, status: 200, body: { status: 'down' } })).toThrow(
      ContractAssertionError,
    );
  });

  it('validates requests through aliased parameters, request bodies and security schemes', () => {
    expect(() => assertRequestMatchesOpenApi(doc, { method: 'GET', path: HEALTH_PATH, query: { apikey: 'k' } })).not.toThrow();
    expect(() => assertRequestMatchesOpenApi(doc, { method: 'GET', path: '/v1/sites/ALPHA/health' })).toThrow(/path\/siteid/);
    const apply = { method: 'POST', path: HEALTH_PATH, contentType: 'application/json' };
    expect(() => assertRequestMatchesOpenApi(doc, { ...apply, body: { unit: 'people.person' } })).not.toThrow();
    expect(() => assertRequestMatchesOpenApi(doc, { ...apply, body: {} })).toThrow(/body must have required property 'unit'/);
    expect(() => assertRequestMatchesOpenApi(doc, { method: 'POST', path: HEALTH_PATH })).toThrow(/body is required/);
  });

  it.each([
    [
      'a response reference',
      () => assertResponseMatchesOpenApi(raw(SERVICE), { method: 'GET', path: HEALTH_PATH, status: 401, contentType: 'application/json', body: '"ok"' }),
      /^\$ref \.\.\/shared\.json#\/components\/responses\/Unauthorized at #\/components\/responses\/Unauthorized is not local; load the document with loadOpenApiDocument$/,
    ],
    [
      'a parameter reference',
      () => assertRequestMatchesOpenApi(raw(SERVICE), { method: 'GET', path: HEALTH_PATH }),
      /^\$ref \.\.\/shared\.json#\/components\/parameters\/SiteId at #\/components\/parameters\/SiteId is not local; load the document with loadOpenApiDocument$/,
    ],
    [
      'a schema the validator compiles',
      () => assertResponseMatchesOpenApi(raw(SERVICE), { method: 'GET', path: HEALTH_PATH, status: 200, contentType: 'application/json', body: { status: 'ok' } }),
      /^\$ref \.\.\/shared\.json#\/components\/schemas\/Health at #\/components\/schemas\/Health is not local; load the document with loadOpenApiDocument$/,
    ],
  ])('throws a TypeError naming the non-local $ref of an unloaded document at %s', (_label, assertion, message) => {
    const error = thrown(assertion);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toMatch(message);
  });
});
