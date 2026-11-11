// Tests of the fake gateways' query and form recording for field names that shadow Object.prototype members.
import { afterEach, describe, expect, it } from 'vitest';
import { fakeGatewayClient, startFakeGateway, type FakeGateway } from './fake-gateway';

type Pairs = [string, string][];
type Recorded = Readonly<Record<string, string | string[]>> | undefined;

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const PING_PATH = '/opt2/svc/identity/v1/ping';
const OBJECT_PROTOTYPE = Object.getOwnPropertyDescriptors(Object.prototype);

let fake: FakeGateway | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** The fields one fake recorded for a request carrying `pairs` in its query or form. */
const RECORDERS: readonly (readonly [string, (pairs: Pairs) => Promise<Recorded>])[] = [
  [
    'HTTP fake query',
    async (pairs) => {
      fake = await startFakeGateway();
      await (await fetch(`${fake.url}${PING_PATH}?${new URLSearchParams(pairs)}`)).arrayBuffer();
      return fake.requests[0]?.query;
    },
  ],
  [
    'HTTP fake form',
    async (pairs) => {
      fake = await startFakeGateway();
      const response = await fetch(`${fake.url}${PING_PATH}`, {
        method: 'POST',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: new URLSearchParams(pairs).toString(),
      });
      await response.arrayBuffer();
      return fake.requests[0]?.form;
    },
  ],
  [
    'in-memory client query',
    async (pairs) => {
      const client = fakeGatewayClient();
      await client.get('identity', '/v1/ping', { query: new URLSearchParams(pairs) });
      return client.calls[0]?.query;
    },
  ],
  [
    'in-memory client form',
    async (pairs) => {
      const client = fakeGatewayClient();
      await client.postForm('identity', '/v1/ping', pairs);
      return client.calls[0]?.form;
    },
  ],
];

/** A single and a repeated field named `name`, with the value each is recorded as. */
function casesOf(name: string): { label: string; name: string; pairs: Pairs; expected: string | string[] }[] {
  return [
    { label: `${name}=a`, name, pairs: [[name, 'a']], expected: 'a' },
    { label: `${name}=a&${name}=b`, name, pairs: [[name, 'a'], [name, 'b']], expected: ['a', 'b'] },
  ];
}

const CASES = ['constructor', 'toString', '__proto__'].flatMap((name) => casesOf(name));

describe.each(RECORDERS)('%s', (_fake, record) => {
  it.each(CASES)('records $label as one own field', async ({ name, pairs, expected }) => {
    const recorded = (await record(pairs)) ?? {};

    expect(Object.keys(recorded)).toEqual([name]);
    expect(Object.getOwnPropertyDescriptor(recorded, name)).toEqual({
      value: expected,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(recorded)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(OBJECT_PROTOTYPE);
  });
});
