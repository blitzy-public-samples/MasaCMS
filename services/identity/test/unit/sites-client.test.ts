/** Identity's programs-sites client over a recording service client: the mail-settings lookup, its answer and fail-closed errors, checked against the programs-sites contract. */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { assertRequestMatchesOpenApi, assertResponseMatchesOpenApi, loadOpenApiDocument } from '@opt2/platform/testing';
import { createSitesClient, type SitesClient } from '../../src/legacy/sites-client.js';
import { siteMailSettingsOf } from '../helpers/app.js';

const SITES_CONTRACT = loadOpenApiDocument(new URL('../../../programs-sites/contracts/openapi.yaml', import.meta.url), parse) as object;

const LOOKUP_PATH = '/internal/v1/sites/mail-settings:lookup';

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

/** Checks the recorded request and the stub reply against the programs-sites operation the request called. */
function assertExchange(req: ServiceRequest | undefined, reply: Reply): void {
  if (req === undefined) throw new Error('programs-sites was not called');
  assertRequestMatchesOpenApi(SITES_CONTRACT, { method: req.method, path: req.path, contentType: 'application/json', body: req.json });
  assertResponseMatchesOpenApi(SITES_CONTRACT, { method: req.method, path: req.path, status: reply.status, contentType: 'application/json', body: reply.body });
}

const ERROR_BODIES: Record<number, unknown> = {
  400: { apiversion: 'v1', method: 'invalid', error: { message: 'Bad Request', code: 'invalid_request' } },
  403: { apiversion: 'v1', method: 'invalid', error: { message: 'Insufficient Account Permissions', code: 'invalid_request' } },
  503: { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } },
};

describe('site login-mail settings', () => {
  it('looks the listed ids up in one lookupSiteMailSettings call as identity itself, answering the items in order', async () => {
    const remote = { ...siteMailSettingsOf('tenant-a'), editProfileURL: null, remote: { serverPort: ':8443', context: '/remote' } };
    const reply = { status: 200, body: { items: [remote, siteMailSettingsOf('')] } };
    const { sites, requests } = sitesWith(reply);

    await expect(sites.mailSettings(['tenant-a', ''])).resolves.toEqual([remote, siteMailSettingsOf('default')]);
    expect(requests).toEqual([{ service: 'programs-sites', method: 'POST', path: LOOKUP_PATH, json: { siteIds: ['tenant-a', ''] }, userToken: null }]);
    assertExchange(requests[0], reply);
  });

  it.each([400, 403, 503])('fails closed with the legacy 503 when programs-sites answers %i', async (status) => {
    const reply = { status, body: ERROR_BODIES[status] };
    const { sites, requests } = sitesWith(reply);

    const failure = sites.mailSettings(['tenant-a']);

    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject({
      service: 'programs-sites',
      message: `Service programs-sites unavailable (HTTP_${status})`,
      cause: { code: `HTTP_${status}`, message: `programs-sites lookupSiteMailSettings answered HTTP ${status}` },
    });
    assertExchange(requests[0], reply);
  });
});
