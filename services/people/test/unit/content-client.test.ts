import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import {
  newRequestContext,
  runWithRequestContext,
  ServiceUnavailableError,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, findOperation } from '@opt2/platform/testing';
import { createContentClient, type ContentClient } from '../../src/legacy/content-client.js';

const CONTENT_CONTRACT = parse(
  readFileSync(new URL('../../../strategies-content/contracts/openapi.yaml', import.meta.url), 'utf8'),
) as object;

const LOOKUP_PATH = '/internal/v1/files:lookup';
const PHOTO_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const OTHER_PHOTO_ID = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const MISSING_ID = 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

/** A content client over a service client that records each request and answers from `replies` in order. */
function contentWith(...replies: Reply[]): { content: ContentClient; requests: ServiceRequest[] } {
  const requests: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      requests.push(req);
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`unexpected request ${req.method} ${req.path}`);
      return Promise.resolve({ status: reply.status, headers: reply.headers ?? {}, body: reply.body as T });
    },
    close: () => Promise.resolve(),
  };
  return { content: createContentClient(client), requests };
}

/** Checks a stub reply against the strategies-content operation the request called. */
function assertContentReply(req: ServiceRequest | undefined, reply: Reply): void {
  if (req === undefined) throw new Error('strategies-content was not called');
  const { method, path } = req;
  assertResponseMatchesOpenApi(CONTENT_CONTRACT, { method, path, status: reply.status, contentType: 'application/json', body: reply.body });
}

/** Checks a request's JSON body against the `requestBody` of the strategies-content operation it calls. */
function assertContentRequestBody(req: ServiceRequest | undefined): void {
  if (req === undefined) throw new Error('strategies-content was not called');
  const { template, operation } = findOperation(CONTENT_CONTRACT, req.method, req.path);
  // The request body object has a response object's `content` shape, so the response checker validates it.
  const probe = { ...CONTENT_CONTRACT, paths: { [template]: { [req.method.toLowerCase()]: { responses: { '200': operation['requestBody'] } } } } };
  assertResponseMatchesOpenApi(probe, { method: req.method, path: req.path, status: 200, contentType: 'application/json', body: req.json });
}

const ERROR_BODIES: Record<number, unknown> = {
  400: { apiversion: 'v1', method: 'invalid', error: { message: 'Invalid parameters', code: 'invalid_request' } },
  403: { apiversion: 'v1', method: 'invalid', error: { message: 'Insufficient Account Permissions', code: 'invalid_request' } },
  503: { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } },
};

describe('photo file extensions', () => {
  it('looks up the listed photo files in one lookupFileExtensions call, each non-empty id once', async () => {
    const reply = {
      status: 200,
      body: {
        items: [
          { fileId: PHOTO_ID, fileExt: 'jpg' },
          { fileId: OTHER_PHOTO_ID, fileExt: null },
        ],
      },
    };
    const { content, requests } = contentWith(reply);
    const extensions = await content.photoFileExts([PHOTO_ID, null, '', OTHER_PHOTO_ID, MISSING_ID, undefined, PHOTO_ID]);
    expect([...extensions]).toEqual([
      [PHOTO_ID, 'jpg'],
      [OTHER_PHOTO_ID, ''],
    ]);
    expect(requests).toEqual([
      { service: 'strategies-content', method: 'POST', path: LOOKUP_PATH, json: { fileIds: [PHOTO_ID, OTHER_PHOTO_ID, MISSING_ID] } },
    ]);
    assertContentRequestBody(requests[0]);
    assertContentReply(requests[0], reply);
  });

  it.each([[[]], [[null, undefined, '']]])('makes no call for the photo ids %j', async (fileIds) => {
    const { content, requests } = contentWith();
    await expect(content.photoFileExts(fileIds)).resolves.toEqual(new Map());
    expect(requests).toEqual([]);
  });

  it.each([
    ['a stored photo', PHOTO_ID, [{ fileId: PHOTO_ID, fileExt: 'png' }], 'png'],
    ['a stored photo without an extension', PHOTO_ID, [{ fileId: PHOTO_ID, fileExt: null }], ''],
    ['an id that names no stored file', MISSING_ID, [], ''],
  ])('reads the extension of %s', async (_case, fileId, items, expected) => {
    const reply = { status: 200, body: { items } };
    const { content, requests } = contentWith(reply);
    await expect(content.photoFileExt(fileId)).resolves.toBe(expected);
    expect(requests).toEqual([{ service: 'strategies-content', method: 'POST', path: LOOKUP_PATH, json: { fileIds: [fileId] } }]);
    assertContentReply(requests[0], reply);
  });

  it.each([undefined, null, ''])('answers an empty extension without a call for the photo id %j', async (fileId) => {
    const { content, requests } = contentWith();
    await expect(content.photoFileExt(fileId)).resolves.toBe('');
    expect(requests).toEqual([]);
  });

  it.each([400, 403, 503])('fails closed when strategies-content answers %i', async (status) => {
    const reply = { status, body: ERROR_BODIES[status] };
    const { content, requests } = contentWith(reply);
    const failure = content.photoFileExt(PHOTO_ID);
    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject({ service: 'strategies-content' });
    await expect(failure).rejects.toThrow(`lookupFileExtensions HTTP_${status}`);
    assertContentReply(requests[0], reply);
  });

  it.each([
    [200, { items: [] }],
    [503, ERROR_BODIES[503]],
  ])('records the write positions of a %i answer in the request context', async (status, body) => {
    const { content } = contentWith({ status, body, headers: { 'x-opt2-write-position': 'strategies-content=5' } });
    const store = newRequestContext();
    await runWithRequestContext(store, () => content.photoFileExts([PHOTO_ID])).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ServiceUnavailableError);
    });
    expect(store.writePositions.get('strategies-content')).toBe('5');
  });

  it('looks up outside a request context without recording positions', async () => {
    const { content } = contentWith({ status: 200, body: { items: [] }, headers: { 'x-opt2-write-position': 'strategies-content=5' } });
    await expect(content.photoFileExt(PHOTO_ID)).resolves.toBe('');
  });
});
