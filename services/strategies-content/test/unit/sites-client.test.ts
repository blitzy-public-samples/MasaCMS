/** strategies-content's programs-sites client over a recording service client: the custom image size read, its answer and fail-closed errors, checked against the programs-sites contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { createSitesClient, type SitesClient } from '../../src/legacy/sites-client.js';

const SITES_CONTRACT = parse(readFileSync(new URL('../../../programs-sites/contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const CAROUSEL = { sizeID: 'C63AB001-1111-2222-3333444455556666', siteID: 'default', name: 'carouselimage', height: '400', width: '1200', isNew: 0 };
const HERO = { sizeID: 'C63AB002-1111-2222-3333444455556666', siteID: 'default', name: 'hero', height: 'AUTO', width: '800', isNew: 0 };

interface Reply {
  status: number;
  body?: unknown;
}

/** A sites client over a service client that records each request and answers from `replies` in order. */
function sitesWith(...replies: Reply[]): { sites: SitesClient; requests: ServiceRequest[] } {
  const requests: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      requests.push(req);
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`unexpected request ${req.method} ${req.path}`);
      return Promise.resolve({ status: reply.status, headers: {}, body: reply.body as T });
    },
    close: () => Promise.resolve(),
  };
  return { sites: createSitesClient(client), requests };
}

/** Checks the stub reply against the programs-sites operation the recorded request called. */
function assertExchange(req: ServiceRequest | undefined, reply: Reply): void {
  if (req === undefined) throw new Error('programs-sites was not called');
  assertResponseMatchesOpenApi(SITES_CONTRACT, { method: req.method, path: req.path, status: reply.status, contentType: 'application/json', body: reply.body });
}

const ERROR_BODIES: Record<number, unknown> = {
  400: { apiversion: 'v1', method: 'invalid', error: { message: 'Bad Request', code: 'invalid_request' } },
  403: { apiversion: 'v1', method: 'invalid', error: { message: 'Insufficient Account Permissions', code: 'invalid_request' } },
  503: { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } },
};

describe('site custom image sizes', () => {
  it.each([
    ['default', '/internal/v1/sites/default/image-sizes'],
    ['a b/c', '/internal/v1/sites/a%20b%2Fc/image-sizes'],
  ])('reads the sizes of %j in one listSiteCustomImageSizes call as this service, answering them in order', async (siteId, path) => {
    const reply = { status: 200, body: [CAROUSEL, HERO] };
    const { sites, requests } = sitesWith(reply);

    await expect(sites.customImageSizes(siteId)).resolves.toEqual([CAROUSEL, HERO]);
    expect(requests).toEqual([{ service: 'programs-sites', method: 'GET', path, userToken: null }]);
    assertExchange(requests[0], reply);
  });

  it.each([400, 403, 503])('fails closed with the legacy 503 when programs-sites answers %i', async (status) => {
    const reply = { status, body: ERROR_BODIES[status] };
    const { sites, requests } = sitesWith(reply);

    const failure = sites.customImageSizes('default');

    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject({
      service: 'programs-sites',
      message: `Service programs-sites unavailable (HTTP_${status})`,
      cause: { code: `HTTP_${status}`, message: `programs-sites listSiteCustomImageSizes answered HTTP ${status}` },
    });
    assertExchange(requests[0], reply);
  });
});
