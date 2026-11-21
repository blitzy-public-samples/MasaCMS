// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
// The synthetic modules' fixture answers, as the gateway relays them to web, against their producers' contracts.
import { readFileSync } from 'node:fs';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GATEWAY_SERVICE_PREFIX } from '@/lib/env';
import { WEB_SERVICE_NAMES, type HttpMethod, type WebServiceName } from '@/lib/gateway-client';
import { communicationsAnswers } from '../fixtures/opt2/communications';
import { eSignatureAnswers } from '../fixtures/opt2/e-signature';
import { financeAnswers } from '../fixtures/opt2/finance';
import { reportingAnswers } from '../fixtures/opt2/reporting';
import { surveysAnswers } from '../fixtures/opt2/surveys';
import { timesheetsAnswersByRole } from '../fixtures/opt2/timesheets';
import { fakeServiceClient, type FakeRouteTable } from '../helpers/fake-gateway';

/** Every answer table of the synthetic fixtures, with the producer it stands in for. */
const TABLES: ReadonlyArray<{ readonly owner: WebServiceName; readonly name: string; readonly table: FakeRouteTable }> = [
  { owner: 'communications', name: 'communicationsAnswers', table: communicationsAnswers },
  { owner: 'e-signature', name: 'eSignatureAnswers', table: eSignatureAnswers },
  { owner: 'finance', name: 'financeAnswers', table: financeAnswers },
  { owner: 'reporting', name: 'reportingAnswers', table: reportingAnswers },
  { owner: 'surveys', name: 'surveysAnswers', table: surveysAnswers },
  ...Object.entries(timesheetsAnswersByRole).map(([role, table]) => ({
    owner: 'timesheets' as const,
    name: `timesheetsAnswersByRole.${role}`,
    table,
  })),
];

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const RELAY_PREFIX = `${GATEWAY_SERVICE_PREFIX}/`;

/** `METHOD /opt2/svc/<service><path>` as its method, gateway path, relayed service and service path. */
function relayed(key: string): { method: HttpMethod; target: string; service: WebServiceName; path: string } {
  const [method, target = ''] = key.split(' ');
  const [name, ...rest] = target.startsWith(RELAY_PREFIX) ? target.slice(RELAY_PREFIX.length).split('/') : [];
  const verb = METHODS.find((known) => known === method);
  const service = WEB_SERVICE_NAMES.find((known) => known === name);
  if (verb === undefined || service === undefined) throw new TypeError(`${key} is not a relayed route key`);
  return { method: verb, target, service, path: `/${rest.join('/')}` };
}

const contracts = new Map<WebServiceName, object>();

/** The producer contract of `service`, loaded once by relative path. */
function contract(service: WebServiceName): object {
  let doc = contracts.get(service);
  if (doc === undefined) {
    const file = new URL(`../../../services/${service}/contracts/openapi.yaml`, import.meta.url);
    doc = parse(readFileSync(file, 'utf8')) as object;
    contracts.set(service, doc);
  }
  return doc;
}

const CASES = TABLES.flatMap(({ owner, name, table }) =>
  Object.keys(table).map((key) => ({ owner, name, key, table, ...relayed(key) })),
);

describe('synthetic fixture answers against their producer contracts', () => {
  it('keys every answer to the producer its table stands in for', () => {
    expect(CASES.filter(({ owner, service }) => owner !== service).map(({ key }) => key)).toEqual([]);
    expect(TABLES.filter(({ table }) => Object.keys(table).length === 0).map(({ name }) => name)).toEqual([]);
  });

  it.each(CASES)('$name: $key answers as $service declares', async ({ table, method, target, service, path }) => {
    const response = await fakeServiceClient(table).request<Buffer>({ service: 'gateway', method, path: target });

    assertResponseMatchesOpenApi(contract(service), {
      method,
      path,
      status: response.status,
      contentType: response.headers['content-type'],
      body: response.body.toString('utf8'),
    });
  });
});
