import { describe, expect, it } from 'vitest';
import { envelopeSchema, type EventEnvelope } from '../../src/events/index.js';
import {
  ContractAssertionError,
  assertEventMatches,
  assertProducerConsumerCompatible,
  assertResponseMatchesOpenApi,
  findOperation,
  type ConsumerExpectation,
  type JsonType,
  type ResponseUnderTest,
} from '../../src/testing/contracts.js';
import { TENANT_A } from '../../src/testing/fixtures.js';

function caught(fn: () => unknown): ContractAssertionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractAssertionError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a ContractAssertionError');
}

const jsonOf = (ref: string) => ({ 'application/json': { schema: { $ref: ref } } });

const doc = {
  openapi: '3.1.0',
  info: { title: 'contracts self-test', version: '1.0.0' },
  paths: {
    '/v1/notes': {
      get: {
        operationId: 'listNotes',
        responses: {
          '200': { description: 'list', content: jsonOf('#/components/schemas/NoteList') },
          '4XX': { $ref: '#/components/responses/LegacyError' },
        },
      },
      post: {
        operationId: 'createNote',
        responses: {
          '201': { description: 'created', content: jsonOf('#/components/schemas/Note') },
          default: { description: 'error', content: jsonOf('#/components/schemas/LegacyError') },
        },
      },
    },
    '/v1/notes/{noteId}': {
      get: {
        operationId: 'getNote',
        responses: {
          '200': { description: 'note', content: jsonOf('#/components/schemas/Note') },
          '404': {
            description: 'missing',
            content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/LegacyError' } } },
          },
        },
      },
      delete: { operationId: 'deleteNote', responses: { '204': { description: 'deleted' } } },
    },
    '/v1/notes/search': {
      get: {
        operationId: 'searchNotes',
        responses: { '200': { description: 'csv', content: { 'text/csv': { schema: { type: 'string', minLength: 1 } } } } },
      },
    },
    '/v1/files/{fileId}/{variant}': {
      get: {
        operationId: 'getFile',
        responses: {
          '200': {
            description: 'bytes',
            content: { 'image/*': { schema: { type: 'string', minLength: 3 } }, '*/*': {} },
          },
        },
      },
    },
    '/v1/formats': {
      post: {
        operationId: 'formats',
        responses: { '200': { description: 'formats', content: jsonOf('#/components/schemas/Formats') } },
      },
    },
    '/v1/aliases': { $ref: '#/paths/~1v1~1notes' },
  },
  components: {
    schemas: {
      Note: {
        type: 'object',
        additionalProperties: false,
        required: ['noteId', 'title'],
        properties: { noteId: { type: 'string' }, title: { type: 'string', minLength: 1 } },
      },
      NoteList: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Note' } } },
          },
        },
      },
      LegacyError: {
        type: 'object',
        required: ['apiversion', 'error'],
        properties: {
          apiversion: { type: 'string' },
          error: { type: 'object', required: ['code', 'message'] },
        },
      },
      Formats: {
        type: 'object',
        properties: {
          uuid: { type: 'string', format: 'uuid' },
          at: { type: 'string', format: 'date-time' },
          day: { type: 'string', format: 'date' },
          clock: { type: 'string', format: 'time' },
          email: { type: 'string', format: 'email' },
          link: { type: 'string', format: 'uri' },
          count: { type: 'integer', format: 'int64' },
          secret: { type: 'string', format: 'password' },
          legacyId: { type: 'string', format: 'cf-uuid' },
        },
      },
    },
    responses: {
      LegacyError: { description: 'legacy error envelope', content: jsonOf('#/components/schemas/LegacyError') },
    },
  },
};

const note = { noteId: 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6', title: 'Hello' };
const legacyError = { apiversion: 'v1', error: { code: 'badRequest', message: 'Bad Request' } };

const respond = (overrides: Partial<ResponseUnderTest>): ResponseUnderTest => ({
  method: 'GET',
  path: '/v1/notes',
  status: 200,
  contentType: 'application/json; charset=utf-8',
  body: { data: { items: [note] } },
  ...overrides,
});

describe('findOperation', () => {
  it.each([
    ['GET', '/v1/notes/search', '/v1/notes/search', 'searchNotes'],
    ['get', '/v1/notes/ABC?expand=true', '/v1/notes/{noteId}', 'getNote'],
    ['DELETE', '/v1/notes/search', '/v1/notes/{noteId}', 'deleteNote'],
    ['GET', '/v1/files/F1/small', '/v1/files/{fileId}/{variant}', 'getFile'],
    ['POST', '/v1/aliases', '/v1/aliases', 'createNote'],
  ])('resolves %s %s to %s', (method, path, template, operationId) => {
    const match = findOperation(doc, method, path);
    expect(match.template).toBe(template);
    expect(match.operation.operationId).toBe(operationId);
  });

  it.each([
    ['GET', '/v2/notes'],
    ['PUT', '/v1/notes'],
    ['GET', '/v1/notes/A/B'],
  ])('throws for %s %s', (method, path) => {
    const error = caught(() => findOperation(doc, method, path));
    expect(error.errors).toEqual([
      { instancePath: '', message: `no operation for ${method} ${path}`, keyword: 'operation' },
    ]);
    expect(error.message).toBe(`${method} ${path}\nno operation for ${method} ${path}`);
  });

  it('throws for a document without paths', () => {
    expect(() => findOperation({ openapi: '3.1.0' }, 'GET', '/')).toThrow(ContractAssertionError);
  });
});

describe('assertResponseMatchesOpenApi', () => {
  it('passes a valid body and returns the JSON-parsed text', () => {
    const body = { data: { items: [note] } };
    expect(assertResponseMatchesOpenApi(doc, respond({ body }))).toBe(body);
    expect(assertResponseMatchesOpenApi(doc, respond({ body: JSON.stringify(body) }))).toEqual(body);
    expect(assertResponseMatchesOpenApi(doc, respond({ body, contentType: ['APPLICATION/JSON'] }))).toBe(body);
  });

  it('reports a missing required property with its instance path', () => {
    const error = caught(() => assertResponseMatchesOpenApi(doc, respond({ body: { data: { items: [{ noteId: 'x' }] } } })));
    expect(error.context).toBe('GET /v1/notes 200 application/json');
    expect(error.errors).toEqual([
      { instancePath: '/data/items/0', message: "must have required property 'title'", keyword: 'required' },
    ]);
    expect(error.message).toBe("GET /v1/notes 200 application/json\n/data/items/0 must have required property 'title'");
  });

  it('lists every error, roots as "/" and names additional properties', () => {
    const error = caught(() =>
      assertResponseMatchesOpenApi(doc, respond({ method: 'POST', status: 201, body: { ...note, title: '', extra: 1 } })),
    );
    expect(error.errors.map((e) => `${e.instancePath} ${e.keyword}`)).toEqual([
      '/ additionalProperties',
      '/title minLength',
    ]);
    expect(error.message).toContain('/ must NOT have additional properties (extra)');
    const root = caught(() => assertResponseMatchesOpenApi(doc, respond({ body: [] })));
    expect(root.errors[0]?.instancePath).toBe('/');
  });

  it.each([
    ['the exact status', 'GET', '/v1/notes/N1', 404, 'application/problem+json', JSON.stringify(legacyError)],
    ['a 4XX fallback through a component response', 'GET', '/v1/notes', 401, 'application/json', legacyError],
    ['a default fallback', 'POST', '/v1/notes', 500, 'application/json', legacyError],
    ['the operation of a referenced path item', 'GET', '/v1/aliases', 403, 'application/json', legacyError],
  ])('selects %s', (_case, method, path, status, contentType, body) => {
    expect(() => assertResponseMatchesOpenApi(doc, { method, path, status, contentType, body })).not.toThrow();
    const error = caught(() => assertResponseMatchesOpenApi(doc, { method, path, status, contentType, body: {} }));
    expect(error.errors.map((e) => e.message)).toContain("must have required property 'apiversion'");
  });

  it('throws for an undeclared status', () => {
    const error = caught(() => assertResponseMatchesOpenApi(doc, respond({ status: 500 })));
    expect(error.errors).toEqual([{ instancePath: '', message: 'status 500 is not declared', keyword: 'status' }]);
  });

  it('passes an empty body where no content is declared and rejects a body there', () => {
    const response = { method: 'DELETE', path: '/v1/notes/N2', status: 204 };
    for (const body of [undefined, null, '']) {
      expect(assertResponseMatchesOpenApi(doc, { ...response, body })).toBe(body);
    }
    const error = caught(() => assertResponseMatchesOpenApi(doc, { ...response, contentType: 'application/json', body: {} }));
    expect(error.errors[0]?.keyword).toBe('content');
  });

  it.each([
    ['an undeclared media type', 'text/html; charset=utf-8'],
    ['a missing content type', undefined],
  ])('throws for %s', (_case, contentType) => {
    const error = caught(() => assertResponseMatchesOpenApi(doc, respond({ contentType })));
    expect(error.errors[0]?.keyword).toBe('content');
    expect(error.errors[0]?.message).toContain('declares application/json');
  });

  it('validates non-JSON text as a string', () => {
    const csv = respond({ path: '/v1/notes/search', contentType: 'text/csv; charset=utf-8', body: 'a,b' });
    expect(assertResponseMatchesOpenApi(doc, csv)).toBe('a,b');
    expect(caught(() => assertResponseMatchesOpenApi(doc, { ...csv, body: '' })).errors[0]?.keyword).toBe('minLength');
  });

  it.each([
    ['type/*', 'image/png', 'png', 'xx'],
    ['*/*', 'application/pdf', '%PDF', undefined],
  ])('falls back to %s', (_case, contentType, body, invalid) => {
    const response = respond({ path: '/v1/files/F1/source', contentType, body });
    expect(assertResponseMatchesOpenApi(doc, response)).toBe(body);
    if (invalid !== undefined) {
      expect(() => assertResponseMatchesOpenApi(doc, { ...response, body: invalid })).toThrow(ContractAssertionError);
    }
  });

  it('rejects text that is not JSON under a JSON media type', () => {
    const error = caught(() => assertResponseMatchesOpenApi(doc, respond({ body: '{not json' })));
    expect(error.errors[0]?.keyword).toBe('json');
  });

  it('checks the inline formats and ignores the rest', () => {
    const valid = {
      uuid: TENANT_A.tenantId,
      at: '2026-06-30T12:00:00.000Z',
      day: '2026-06-30',
      email: 'admin@example.com',
      link: 'https://example.com/a',
      count: 9007199254740991,
      secret: 'x',
      legacyId: 'anything',
    };
    const response = respond({ method: 'POST', path: '/v1/formats', body: valid });
    expect(assertResponseMatchesOpenApi(doc, response)).toBe(valid);
    const invalid = { uuid: 'nope', at: '2026-06-30', day: '30/06/2026', email: 'admin', link: 'not a uri' };
    const error = caught(() => assertResponseMatchesOpenApi(doc, { ...response, body: invalid }));
    expect(error.errors.map((e) => `${e.instancePath} ${e.keyword}`)).toEqual([
      '/uuid format',
      '/at format',
      '/day format',
      '/email format',
      '/link format',
    ]);
  });

  it.each([
    ['at', '2028-02-29T12:00:00Z'],
    ['at', '2000-02-29T00:00:00Z'],
    ['at', '2026-03-31T23:59:59.123456+05:30'],
    ['at', '2026-01-01t00:00:00z'],
    ['at', '2026-11-30T16:00:00-08:00'],
    ['at', '2026-01-01T12:00:00.1234567890Z'],
    ['at', '2016-12-31T23:59:60Z'],
    ['at', '2016-12-31T18:59:60-05:00'],
    ['day', '2028-02-29'],
    ['clock', '23:59:59Z'],
    ['clock', '12:00:00+05:30'],
    ['clock', '12:00:00.1234567890+05:30'],
    ['clock', '23:59:60Z'],
  ])('accepts the RFC 3339 %s value %s', (field, value) => {
    const body = { [field]: value };
    expect(assertResponseMatchesOpenApi(doc, respond({ method: 'POST', path: '/v1/formats', body }))).toBe(body);
  });

  it.each([
    ['at', '2026-02-30T12:00:00Z'],
    ['at', '2026-99-99T99:99:99Z'],
    ['at', '2026-13-01T00:00:00Z'],
    ['at', '2026-04-31T00:00:00Z'],
    ['at', '2100-02-29T00:00:00Z'],
    ['at', '2026-01-01T24:00:00Z'],
    ['at', '2026-01-01T12:60:00Z'],
    ['at', '2026-01-01T12:00:00+24:00'],
    ['at', '2026-01-01T12:00:60Z'],
    ['at', '2016-12-31T23:59:60+01:00'],
    ['at', '2026-01-01 12:00:00Z'],
    ['day', '2026-02-30'],
    ['day', '2026-00-10'],
    ['clock', '24:00:00Z'],
    ['clock', '12:00:00'],
    ['clock', '12:00:60Z'],
    ['clock', '12:00:00.Z'],
  ])('rejects the invalid %s value %s', (field, value) => {
    const response = respond({ method: 'POST', path: '/v1/formats', body: { [field]: value } });
    const error = caught(() => assertResponseMatchesOpenApi(doc, response));
    expect(error.errors.map((e) => `${e.instancePath} ${e.keyword}`)).toEqual([`/${field} format`]);
  });

  it('keeps separate registrations for distinct documents', () => {
    const other = structuredClone(doc);
    other.components.schemas.Note.properties.title = { type: 'string', minLength: 10 };
    const response = respond({ method: 'POST', status: 201, body: note });
    expect(() => assertResponseMatchesOpenApi(doc, response)).not.toThrow();
    expect(() => assertResponseMatchesOpenApi(other, response)).toThrow(ContractAssertionError);
  });
});

const ARCHIVED_TOPIC = 'people.person.archived.v1';

const archivedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `urn:opt2:testing-contracts:event:${ARCHIVED_TOPIC}`,
  title: `${ARCHIVED_TOPIC} payload`,
  'x-opt2-kind': 'process',
  'x-opt2-tenant-fanout': 'userPool',
  type: 'object',
  additionalProperties: false,
  required: ['personId', 'siteId', 'effectiveFrom'],
  properties: {
    personId: { type: 'string', minLength: 1 },
    siteId: { type: 'string', minLength: 1 },
    effectiveFrom: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
};

const payload = { personId: 'P1', siteId: 'tenant-a', effectiveFrom: '2026-06-30' };

function envelopeFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: '7d2b1f0c-3a4e-4c5d-8e6f-9a0b1c2d3e4f',
    eventType: 'people.person.archived',
    schemaVersion: '1.0.0',
    tenantId: TENANT_A.tenantId,
    occurredAt: '2026-06-30T12:00:00.000Z',
    producer: 'people',
    aggregateType: 'person',
    aggregateId: 'P1',
    aggregateVersion: 1,
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    correlationId: 'corr-1',
    payload,
    ...overrides,
  };
}

const withoutTenant = (): Record<string, unknown> => {
  const { tenantId: _omitted, ...rest } = envelopeFor();
  return rest;
};

describe('assertEventMatches', () => {
  it('passes a valid envelope against the platform envelope contract and returns it', () => {
    const envelope = envelopeFor();
    const result: EventEnvelope = assertEventMatches(undefined, archivedSchema, envelope);
    expect(result).toBe(envelope);
  });

  it('fails on a missing tenantId', () => {
    const error = caught(() => assertEventMatches(undefined, archivedSchema, withoutTenant()));
    expect(error.context).toBe(`event ${ARCHIVED_TOPIC}`);
    expect(error.errors).toEqual([
      { instancePath: 'envelope', message: "must have required property 'tenantId'", keyword: 'schema' },
    ]);
    expect(error.message).toBe(`event ${ARCHIVED_TOPIC}\nenvelope must have required property 'tenantId'`);
  });

  it('lists envelope and payload errors separately', () => {
    const envelope = { ...withoutTenant(), payload: { ...payload, effectiveFrom: 'June', extra: true } };
    const error = caught(() => assertEventMatches(undefined, archivedSchema, envelope));
    expect(error.errors.map((e) => e.instancePath)).toEqual(['envelope', 'payload', 'payload/effectiveFrom']);
    expect(error.message).toContain('payload must NOT have additional properties (extra)');
  });

  it.each([
    ['eventType', 'people.person.changed', 'people.person.archived'],
    ['schemaVersion', '2.0.0', '1.0.0'],
  ])('checks %s against the topic the schema names', (field, value, expected) => {
    const error = caught(() => assertEventMatches(undefined, archivedSchema, envelopeFor({ [field]: value })));
    expect(error.errors).toEqual([
      { instancePath: `envelope/${field}`, message: `must be ${expected} on topic ${ARCHIVED_TOPIC}`, keyword: 'topic' },
    ]);
  });

  it('reads the topic from the title when the $id names none', () => {
    const schema = { ...archivedSchema, $id: 'urn:opt2:testing-contracts:titled' };
    expect(() => assertEventMatches(undefined, schema, envelopeFor({ eventType: 'people.person.changed' }))).toThrow(
      ContractAssertionError,
    );
    const anonymous = { ...archivedSchema, $id: 'urn:opt2:testing-contracts:anonymous', title: 'Archived person' };
    expect(assertEventMatches(undefined, anonymous, envelopeFor({ eventType: 'people.person.changed' }))).toBeDefined();
  });

  it('validates against a given envelope schema, including fresh copies of the platform contract', () => {
    expect(() => assertEventMatches(envelopeSchema(), archivedSchema, envelopeFor())).not.toThrow();
    expect(() => assertEventMatches(envelopeSchema(), archivedSchema, envelopeFor())).not.toThrow();
    const error = caught(() => assertEventMatches(envelopeSchema(), archivedSchema, withoutTenant()));
    expect(error.errors).toEqual([
      { instancePath: 'envelope', message: "must have required property 'tenantId'", keyword: 'required' },
    ]);
    const minimal = { type: 'object', required: ['payload'], properties: { aggregateVersion: { type: 'integer' } } };
    const typed = caught(() => assertEventMatches(minimal, archivedSchema, envelopeFor({ aggregateVersion: 'one' })));
    expect(typed.errors).toEqual([{ instancePath: 'envelope/aggregateVersion', message: 'must be integer', keyword: 'type' }]);
  });

  it('rejects a value that is not an envelope', () => {
    const error = caught(() => assertEventMatches(undefined, archivedSchema, 'not an envelope'));
    expect(error.errors).toEqual([{ instancePath: 'envelope', message: 'must be object', keyword: 'schema' }]);
  });
});

const producerSchema = {
  $id: 'urn:opt2:testing-contracts:event:people.person.changed.v1',
  title: 'people.person.changed.v1 payload',
  'x-opt2-kind': 'state',
  type: 'object',
  required: ['personId', 'address', 'score'],
  properties: {
    personId: { $ref: '#/$defs/cfId' },
    nickname: { type: 'string' },
    score: { type: 'integer' },
    amount: { type: 'number' },
    address: { allOf: [{ $ref: '#/definitions/address' }, { type: 'object', required: ['city'] }] },
  },
  $defs: { cfId: { type: 'string', minLength: 1 } },
  definitions: {
    address: { type: 'object', properties: { city: { type: 'string' }, zip: { type: 'string' } } },
  },
};

const unionProducer = {
  'x-opt2-kind': 'process',
  type: 'object',
  required: ['zip'],
  properties: { zip: { type: ['string', 'null'] }, anything: {}, both: { allOf: [{ type: ['string', 'null'] }, { type: 'string' }] } },
};

const cyclicProducer = {
  'x-opt2-kind': 'state',
  type: 'object',
  properties: { loop: { $ref: '#/$defs/a' } },
  $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } },
};

const arrayProducer = {
  'x-opt2-kind': 'state',
  type: 'object',
  properties: {
    ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    refIds: { type: 'array', items: { $ref: '#/$defs/id' } },
    pooled: { allOf: [{ $ref: '#/$defs/idList' }, { items: { type: ['string', 'null'] } }] },
    nested: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } },
    untyped: { type: 'array' },
    anyItems: { type: 'array', items: {} },
    mixed: { type: 'array', items: { type: ['string', 'number'] } },
    either: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
  },
  $defs: { id: { type: 'string' }, idList: { type: 'array', items: { $ref: '#/$defs/id' } } },
};

const sample = { personId: 'P1', score: 3, address: { city: 'Springfield' } };

describe('assertProducerConsumerCompatible', () => {
  it('passes when the producer provides every field, type, sample and declaration', () => {
    const expectation: ConsumerExpectation = {
      required: ['personId', 'score', 'address', 'address.city'],
      types: { personId: 'string', score: 'number', 'address.city': ['string', 'null'], nickname: 'string' },
      samples: [sample],
      kind: 'state',
    };
    expect(() => assertProducerConsumerCompatible(producerSchema, expectation)).not.toThrow();
  });

  it.each([
    ['a field the producer leaves optional', 'nickname', '/nickname', 'required'],
    ['an optional nested field behind $ref and allOf', 'address.zip', '/address/zip', 'required'],
    ['an undeclared field', 'missing', '/missing', 'properties'],
    ['an undeclared nested field', 'address.street', '/address/street', 'properties'],
  ])('fails when the consumer requires %s', (_case, field, instancePath, keyword) => {
    const error = caught(() => assertProducerConsumerCompatible(producerSchema, { required: [field] }));
    expect(error.context).toBe('producer urn:opt2:testing-contracts:event:people.person.changed.v1');
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]).toMatchObject({ instancePath, keyword });
  });

  const typeCases: { schema: object; field: string; accepts: JsonType | JsonType[]; compatible: boolean }[] = [
    { schema: producerSchema, field: 'personId', accepts: 'number', compatible: false },
    { schema: producerSchema, field: 'amount', accepts: 'integer', compatible: false },
    { schema: producerSchema, field: 'amount', accepts: 'number', compatible: true },
    { schema: unionProducer, field: 'zip', accepts: 'string', compatible: false },
    { schema: unionProducer, field: 'zip', accepts: ['null', 'string'], compatible: true },
    { schema: unionProducer, field: 'both', accepts: 'string', compatible: true },
    { schema: unionProducer, field: 'anything', accepts: 'string', compatible: false },
    { schema: cyclicProducer, field: 'loop', accepts: 'string', compatible: false },
  ];

  it.each(typeCases)('checks $field as $accepts (compatible: $compatible)', ({ schema, field, accepts, compatible }) => {
    const check = () => assertProducerConsumerCompatible(schema, { required: [], types: { [field]: accepts } });
    if (compatible) {
      expect(check).not.toThrow();
    } else {
      expect(caught(check).errors[0]).toMatchObject({ instancePath: `/${field}`, keyword: 'type' });
    }
  });

  const itemCases: { field: string; accepts: JsonType | JsonType[]; keyword?: string; message?: string }[] = [
    { field: 'ids', accepts: 'string' },
    { field: 'refIds', accepts: 'string' },
    { field: 'pooled', accepts: 'string' },
    { field: 'nested.tags', accepts: 'string' },
    { field: 'mixed', accepts: ['number', 'string'] },
    { field: 'refIds', accepts: 'number', keyword: 'type', message: 'is string but the consumer accepts number' },
    { field: 'untyped', accepts: 'string', keyword: 'items', message: 'declares no items schema the consumer can rely on' },
    { field: 'anyItems', accepts: 'string', keyword: 'type', message: 'declares no type the consumer can rely on' },
    { field: 'either', accepts: 'string', keyword: 'type', message: 'declares no type the consumer can rely on' },
    { field: 'mixed', accepts: 'string', keyword: 'type', message: 'is string|number but the consumer accepts string' },
  ];

  it.each(itemCases)('checks $field items as $accepts (violation: $keyword)', ({ field, accepts, keyword, message }) => {
    const check = () => assertProducerConsumerCompatible(arrayProducer, { required: [], itemTypes: { [field]: accepts } });
    if (keyword === undefined) {
      expect(check).not.toThrow();
    } else {
      expect(caught(check).errors).toStrictEqual([{ instancePath: `/${field.split('.').join('/')}/items`, message, keyword }]);
    }
  });

  it('reports an undeclared field once when it is required, typed and item-typed', () => {
    const error = caught(() =>
      assertProducerConsumerCompatible(producerSchema, {
        required: ['missing'],
        types: { missing: 'string' },
        itemTypes: { missing: 'string' },
      }),
    );
    expect(error.errors).toHaveLength(1);
  });

  it('collects sample, kind and fanout findings into one error', () => {
    const error = caught(() =>
      assertProducerConsumerCompatible(producerSchema, {
        required: ['nickname'],
        samples: [sample, { ...sample, score: 'high' }],
        kind: 'process',
        fanout: 'userPool',
      }),
    );
    expect(error.errors.map((e) => `${e.instancePath}|${e.keyword}`)).toEqual([
      '/nickname|required',
      'samples/1/score|schema',
      '|x-opt2-kind',
      '|x-opt2-tenant-fanout',
    ]);
    expect(error.message).toContain('x-opt2-tenant-fanout is absent; the consumer expects userPool');
  });

  it('accepts a matching fanout', () => {
    expect(() =>
      assertProducerConsumerCompatible(archivedSchema, { required: ['personId'], kind: 'process', fanout: 'userPool' }),
    ).not.toThrow();
  });
});
