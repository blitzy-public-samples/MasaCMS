import { describe, expect, it } from 'vitest';
import {
  ContractAssertionError,
  TENANT_A,
  assertEventMatches,
  assertProducerConsumerCompatible,
  assertResponseMatchesOpenApi,
  findOperation,
  testEnvelope,
  type ConsumerExpectation,
  type ContractViolation,
  type ResponseUnderTest,
} from '../../src/testing/index.js';

const SOURCE_SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const CF_UUID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const RFC_UUID = '3f1e2d4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const CONTENT_TEMPLATE = '/_api/json/v1/{siteid}/content/{id}';
const NOTE_TOPIC = 'stub.note.created.v1';

const json = (schema: object) => ({ 'application/json': { schema } });

const doc = {
  openapi: '3.1.0',
  info: { title: 'contract assertions fixture', version: '1.0.0', 'x-source-sha': SOURCE_SHA },
  paths: {
    [CONTENT_TEMPLATE]: {
      get: {
        operationId: 'findContent',
        responses: {
          '200': { description: 'entity', content: json({ $ref: '#/components/schemas/LegacyEnvelope' }) },
          '4XX': { description: 'client error', content: json({ $ref: '#/components/schemas/LegacyError' }) },
          default: { description: 'server error', content: json({ $ref: '#/components/schemas/LegacyServerError' }) },
        },
      },
    },
    '/v1/notes': {
      post: {
        operationId: 'createNote',
        responses: {
          '201': {
            description: 'created',
            content: json({
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string', minLength: 35, maxLength: 35 } },
            }),
          },
        },
      },
    },
  },
  components: {
    schemas: {
      LegacyEnvelope: {
        type: 'object',
        required: ['apiversion', 'method'],
        properties: {
          apiversion: { const: 'v1' },
          method: { type: 'string' },
          params: { type: 'object' },
          data: { type: 'object' },
        },
      },
      LegacyError: {
        type: 'object',
        required: ['apiversion', 'method', 'error'],
        properties: {
          apiversion: { const: 'v1' },
          method: { type: 'string' },
          params: { type: 'object' },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
      LegacyServerError: {
        allOf: [
          { $ref: '#/components/schemas/LegacyError' },
          { properties: { error: { properties: { code: { const: 'server_error' } } } } },
        ],
      },
    },
  },
};

const payloadSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `urn:opt2:stub:event:${NOTE_TOPIC}`,
  $comment: `source-sha: ${SOURCE_SHA}`,
  title: `${NOTE_TOPIC} payload`,
  'x-opt2-kind': 'state',
  type: 'object',
  additionalProperties: false,
  required: ['noteId', 'body'],
  properties: {
    noteId: { type: 'string', minLength: 1 },
    body: { type: 'string' },
    title: { type: 'string' },
  },
};

const params = { siteid: 'tenant-a', entityname: 'content', id: CF_UUID };
const envelopeBody = { apiversion: 'v1', method: 'findOne', params, data: { contentid: CF_UUID, title: 'Home' } };
const clientError = {
  apiversion: 'v1',
  method: 'findOne',
  params,
  error: { code: 'invalid_token', message: 'Invalid Access Token' },
};
const serverError = { ...clientError, error: { code: 'server_error', message: 'Unhandled Exception' } };
const notePayload = { noteId: 'n1', body: 'x' };

/** Runs `fn` and returns the ContractAssertionError it throws; any other outcome fails the test. */
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

const contentResponse = (status: number, body: unknown): ResponseUnderTest => ({
  method: 'GET',
  path: `/_api/json/v1/tenant-a/content/${CF_UUID}`,
  status,
  contentType: 'application/json; charset=utf-8',
  body,
});

const noteEnvelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...testEnvelope({
    topic: NOTE_TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateId: notePayload.noteId,
    aggregateVersion: 1,
    payload: notePayload,
  }),
  ...overrides,
});

describe('findOperation', () => {
  it('resolves a concrete path to its templated operation', () => {
    const match = findOperation(doc, 'get', '/_api/json/v1/default/content/X');
    expect(match.template).toBe(CONTENT_TEMPLATE);
    expect(match.operation.operationId).toBe('findContent');
  });

  it.each([
    ['GET', '/v1/unknown'],
    ['GET', '/_api/json/v1/default/content/X/extra'],
    ['DELETE', `/_api/json/v1/tenant-a/content/${CF_UUID}`],
    ['GET', '/v1/notes'],
  ])('throws for the undeclared operation %s %s, as the response assertion does', (method, path) => {
    const expected = [{ instancePath: '', message: `no operation for ${method} ${path}`, keyword: 'operation' }];
    expect(caught(() => findOperation(doc, method, path)).errors).toEqual(expected);
    const response = { method, path, status: 200, contentType: 'application/json', body: {} };
    expect(caught(() => assertResponseMatchesOpenApi(doc, response)).errors).toEqual(expected);
  });
});

describe('assertResponseMatchesOpenApi', () => {
  it('passes a conforming legacy envelope whose content type carries a charset', () => {
    expect(assertResponseMatchesOpenApi(doc, contentResponse(200, envelopeBody))).toBe(envelopeBody);
  });

  it.each([
    ['method is missing', { apiversion: 'v1', params, data: {} }, '/', 'required'],
    ['apiversion is v2', { ...envelopeBody, apiversion: 'v2' }, '/apiversion', 'const'],
  ])('rejects a 200 body where %s', (_case, body, instancePath, keyword) => {
    const error = caught(() => assertResponseMatchesOpenApi(doc, contentResponse(200, body)));
    expect(error.context).toBe(`GET ${CONTENT_TEMPLATE} 200 application/json`);
    expect(error.errors).toEqual([expect.objectContaining({ instancePath, keyword })]);
  });

  const fallbacks: { title: string; status: number; accepted: object; refused: object; finding: Partial<ContractViolation> }[] = [
    {
      title: 'falls back from the exact status to 4XX',
      status: 404,
      accepted: clientError,
      refused: envelopeBody,
      finding: { instancePath: '/', keyword: 'required', message: "must have required property 'error'" },
    },
    {
      title: 'falls back from the exact status and 5XX to default',
      status: 503,
      accepted: serverError,
      refused: clientError,
      finding: { instancePath: '/error/code', keyword: 'const' },
    },
  ];

  it.each(fallbacks)('$title', ({ status, accepted, refused, finding }) => {
    expect(assertResponseMatchesOpenApi(doc, contentResponse(status, accepted))).toBe(accepted);
    const error = caught(() => assertResponseMatchesOpenApi(doc, contentResponse(status, refused)));
    expect(error.errors).toEqual([expect.objectContaining(finding)]);
  });

  it('resolves $ref chains through allOf inside the document', () => {
    const body = { ...serverError, error: { code: 'server_error' } };
    const error = caught(() => assertResponseMatchesOpenApi(doc, contentResponse(500, body)));
    expect(error.errors).toEqual([
      { instancePath: '/error', message: "must have required property 'message'", keyword: 'required' },
    ]);
  });

  it.each([
    ['a 35-character CF UUID', CF_UUID, []],
    ['a 36-character RFC 4122 uuid', RFC_UUID, [{ instancePath: '/id', keyword: 'maxLength' }]],
  ])('checks a created note id that is %s', (_case, id, findings) => {
    const response = { method: 'POST', path: '/v1/notes', status: 201, contentType: 'application/json', body: { id } };
    if (findings.length === 0) {
      expect(assertResponseMatchesOpenApi(doc, response)).toEqual({ id });
    } else {
      const error = caught(() => assertResponseMatchesOpenApi(doc, response));
      expect(error.errors).toEqual(findings.map((finding) => expect.objectContaining(finding)));
    }
  });

  it('throws for a status the operation does not declare', () => {
    const response = { method: 'POST', path: '/v1/notes', status: 400, contentType: 'application/json', body: clientError };
    expect(caught(() => assertResponseMatchesOpenApi(doc, response)).errors).toEqual([
      { instancePath: '', message: 'status 400 is not declared', keyword: 'status' },
    ]);
  });
});

describe('assertEventMatches', () => {
  it('passes a testEnvelope against the platform envelope contract and the topic schema', () => {
    const envelope = noteEnvelope();
    expect(assertEventMatches(undefined, payloadSchema, envelope)).toBe(envelope);
  });

  it.each([
    ['an extra payload field', { payload: { ...notePayload, extra: true } }, ['payload']],
    ['an extra top-level envelope field', { extra: true }, ['envelope']],
    ['a legacy site id as tenantId', { tenantId: TENANT_A.siteId }, ['envelope/tenantId']],
    ['a CF UUID as tenantId', { tenantId: CF_UUID }, ['envelope/tenantId']],
  ])('rejects %s at the stage it violates', (_case, overrides, instancePaths) => {
    const error = caught(() => assertEventMatches(undefined, payloadSchema, noteEnvelope(overrides)));
    expect(error.context).toBe(`event ${NOTE_TOPIC}`);
    expect(error.errors.map((violation) => violation.instancePath)).toEqual(instancePaths);
  });
});

describe('assertProducerConsumerCompatible', () => {
  it('accepts a consumer that relies only on what the producer declares', () => {
    const expectation: ConsumerExpectation = {
      required: ['noteId'],
      types: { noteId: 'string' },
      kind: 'state',
      samples: [notePayload],
    };
    expect(() => assertProducerConsumerCompatible(payloadSchema, expectation)).not.toThrow();
  });

  const incompatible: { title: string; expectation: ConsumerExpectation; finding: Partial<ContractViolation> }[] = [
    {
      title: 'a field the producer leaves optional',
      expectation: { required: ['title'] },
      finding: { instancePath: '/title', keyword: 'required' },
    },
    {
      title: 'a field the producer does not declare',
      expectation: { required: ['author'] },
      finding: { instancePath: '/author', keyword: 'properties' },
    },
    {
      title: 'a changed type',
      expectation: { required: [], types: { noteId: 'integer' } },
      finding: { instancePath: '/noteId', keyword: 'type' },
    },
    {
      title: 'another kind',
      expectation: { required: [], kind: 'process' },
      finding: { instancePath: '', keyword: 'x-opt2-kind', message: 'x-opt2-kind is state; the consumer expects process' },
    },
    {
      title: 'a sample the producer refuses',
      expectation: { required: [], samples: [{ noteId: 'n1' }] },
      finding: { instancePath: 'samples/0', keyword: 'schema' },
    },
    {
      title: 'a userPool fan-out the producer does not declare',
      expectation: { required: [], fanout: 'userPool' },
      finding: { instancePath: '', keyword: 'x-opt2-tenant-fanout' },
    },
  ];

  it.each(incompatible)('rejects a consumer expecting $title', ({ expectation, finding }) => {
    const error = caught(() => assertProducerConsumerCompatible(payloadSchema, expectation));
    expect(error.context).toBe(`producer urn:opt2:stub:event:${NOTE_TOPIC}`);
    expect(error.errors).toEqual([expect.objectContaining(finding)]);
  });
});
