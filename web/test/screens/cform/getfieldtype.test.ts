// cform.getFieldType relay: contract path and parameters, byte-exact body and content type, no web-side defaults.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { createResourceBundles } from '@/lib/resource-bundles/rb';
import { getFieldType } from '@/screens/cform/getfieldtype';
import type { ScreenContext } from '@/screens/registry';
import { fixtureBundles } from '../../fixtures/resource-bundles/generated-bundles';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

const PATH = '/v1/raw/cform/getfieldtype';
const ROUTE = routeKey('GET', 'strategies-content', PATH);
const LEGACY_JSON = 'application/json; charset=utf-8';
const FIELD_TYPE_ID = '7D3A1C52-9B4E-4F21-8C6D0E5F4A3B2C19';

// Key case, order and spacing a re-serialisation would change, plus multi-byte UTF-8.
const BODY = Buffer.from(
  `{"FIELDTYPEID":"${FIELD_TYPE_ID}", "ISDATA":1,"ISLONG":0,"FIELDTYPE":"dropdown",` +
    '"DISPLAYTYPE":"field","LABEL":"Größe"}',
  'utf8',
);

const rb = createResourceBundles(fixtureBundles).rbFor('en_US');

let restoreEnv: () => void;
let gateway: FakeGatewayClient;

beforeEach(() => {
  restoreEnv = useTestEnv();
  gateway = fakeGatewayClient({ [ROUTE]: { status: 200, headers: { 'content-type': LEGACY_JSON }, body: BODY } });
});

afterEach(() => {
  restoreEnv();
});

/** The screen context of an S2 `cform.getfieldtype` request carrying `rc`. */
function contextFor(rc: Readonly<Record<string, string>>): ScreenContext {
  return {
    req: adminS2Request({ circuit: 'cform', item: 'getfieldtype', rc }),
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb,
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

describe('getFieldType', () => {
  it.each([
    [
      'both values',
      { fieldTypeID: FIELD_TYPE_ID, fieldType: 'field-dropdown' },
      { fieldTypeID: FIELD_TYPE_ID, fieldType: 'field-dropdown' },
    ],
    [
      'lower-cased names',
      { fieldtypeid: FIELD_TYPE_ID, fieldtype: 'field-textarea' },
      { fieldTypeID: FIELD_TYPE_ID, fieldType: 'field-textarea' },
    ],
    ['only fieldType', { fieldType: 'field-radio' }, { fieldType: 'field-radio' }],
    ['only fieldTypeID', { fieldTypeID: FIELD_TYPE_ID }, { fieldTypeID: FIELD_TYPE_ID }],
    ['an empty fieldType, which legacy does not default', { fieldType: '' }, { fieldType: '' }],
    ['neither, leaving the defaults to the service', {}, {}],
  ])('forwards siteid plus %s, unchanged', async (_label, rc, forwarded) => {
    await getFieldType(contextFor(rc));

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({ service: 'strategies-content', method: 'GET', path: PATH });
    expect(gateway.calls[0]?.query).toEqual({ siteid: 'default', ...forwarded });
    expect(gateway.calls[0]?.form).toBeUndefined();
  });

  it('relays the status, content type and body bytes exactly', async () => {
    const result = await getFieldType(contextFor({ fieldType: 'field-dropdown' }));

    expect(result.status).toBe(200);
    expect(result.contentType).toBe(LEGACY_JSON);
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.body as Uint8Array).equals(BODY)).toBe(true);
  });

  it.each<[string, FakeReply]>([
    ['a denial', { status: 403, headers: { 'content-type': LEGACY_JSON }, body: '{"error":"forbidden"}' }],
    [
      'a legacy error page',
      { status: 500, headers: { 'content-type': 'text/html;charset=UTF-8' }, body: '<h1>Error</h1>' },
    ],
    ['an answer without a content type', { status: 200, body: '{}' }],
  ])('relays %s as received', async (_label, reply) => {
    gateway.setRoute(ROUTE, reply);

    const result = await getFieldType(contextFor({ fieldTypeID: 'not-a-uuid' }));

    expect(result.status).toBe(reply.status);
    expect(result.contentType).toBe(reply.headers?.['content-type'] ?? '');
    expect(Buffer.from(result.body as Uint8Array).toString('utf8')).toBe(reply.body);
  });

  it.each([
    [
      'an unreachable gateway',
      (): void => {
        gateway.failWith();
      },
    ],
    [
      'a 503 answer',
      (): void => {
        gateway.setRoute(ROUTE, { status: 503, body: '' });
      },
    ],
  ])('propagates unavailability from %s', async (_label, arrange) => {
    arrange();

    await expect(getFieldType(contextFor({}))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
