// REST credential exchange through the real composition: a session identity ended before the gateway's check or token is exchanged for once more.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import type { components } from '../../src/generated/clients/identity.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import { cutoverTable, entry } from '../helpers/versions.js';

type AuthenticateResponse = components['schemas']['AuthenticateResponse'];

const SITE_A = 'tenant-a';
const URL_PATH = `/_api/rest/v1/${SITE_A}/variationtargeting`;

const INVALID_TOKEN = {
  status: 401,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  body: '{"apiversion":"v1","method":"Not Available","params":{},"error":{"code":"invalid_token","message":"Invalid Access Token"}}',
};

/** The REST variation-targeting save, served on strategies-content. */
const REST_TARGET_TABLE = cutoverTable({
  tableVersion: 'v0101',
  entries: [
    entry({
      route: 'rest:variationtargeting.save',
      owningService: 'strategies-content',
      kind: 'write',
      state: 'target',
      units: ['content.variation_targeting'],
    }),
  ],
});

/** A session's state when the gateway reads it; `ends-before-mint` is active then, and identity ends it as its token is asked for. */
type ExchangedState = 'active' | 'ended' | 'ends-before-mint';

describe('REST sessions identity ends before the check or the token', () => {
  let gw: TestGateway;
  /** Sessions identity ends as the gateway asks for their token, after its check found them active. */
  const endsBeforeMint = new Set<string>();

  beforeAll(async () => {
    gw = await buildTestGateway({ version: REST_TARGET_TABLE });
    gw.identity.onMint(({ sessionId }) => {
      if (endsBeforeMint.delete(sessionId)) gw.identity.endSession(sessionId);
    });
  }, 120_000);

  afterAll(async () => {
    await gw?.close();
  });

  const service = () => {
    const double = gw.targets['strategies-content'];
    if (double === undefined) throw new TypeError('no target double serves strategies-content');
    return double;
  };

  /** A session identity created for an exchange, in `state` when the gateway reads it. */
  const exchanged = (state: ExchangedState, consumedParams: string[] = []): AuthenticateResponse => {
    const sessionId = `ids-rest-${randomUUID()}`;
    gw.identity.setSession({
      sessionId,
      userId: 'U-REST',
      siteId: SITE_A,
      epoch: 2,
      state: state === 'ended' ? 'ended' : 'active',
      mode: 'target-primary',
      roles: [Roles.systemUser],
    });
    if (state === 'ends-before-mint') endsBeforeMint.add(sessionId);
    return { outcome: 'authenticated', sessionId, consumedParams };
  };

  /** Posts the save with each `answers` entry as identity's next exchange; everything returned is this request's own. */
  const post = async (answers: Array<() => AuthenticateResponse>) => {
    const queue = [...answers];
    const answered: AuthenticateResponse[] = [];
    gw.identity.onAuthenticate(() => {
      const answer = queue.shift()?.() ?? { outcome: 'anonymous', sessionId: null };
      answered.push(answer);
      return answer;
    });
    const asked = gw.identity.authentications.length;
    const forwarded = service().requests.length;
    const minted = gw.identity.minted.length;
    try {
      const res = await gw.app.inject({
        method: 'POST',
        url: `${URL_PATH}?client_id=C1`,
        headers: { authorization: `Basic ${Buffer.from(`C1:${randomUUID()}`).toString('base64')}`, 'content-type': 'application/json' },
        payload: { variationid: 'V1' },
      });
      return {
        res,
        answered,
        exchanges: gw.identity.authentications.slice(asked),
        received: service().requests.slice(forwarded),
        minted: gw.identity.minted.slice(minted),
      };
    } finally {
      gw.identity.onAuthenticate(undefined);
    }
  };

  it.each<[string, Exclude<ExchangedState, 'active'>, number]>([
    ['its check', 'ended', 0],
    ['its token', 'ends-before-mint', 1],
  ])("sends identity's answer to the exchange repeated after the first session ended before %s, never forwarding the request", async (_label, first, tokens) => {
    const { res, exchanges, received, minted } = await post([
      () => exchanged(first, ['client_id', 'client_secret']),
      () => ({ outcome: 'denied', sessionId: null, legacyResponse: INVALID_TOKEN }),
    ]);
    expect({ status: res.statusCode, wwwAuthenticate: res.headers['www-authenticate'], body: res.body }).toEqual({
      status: 401,
      wwwAuthenticate: INVALID_TOKEN.headers['WWW-Authenticate'],
      body: INVALID_TOKEN.body,
    });
    expect({ exchanges: exchanges.length, received: received.length, minted: minted.length }).toEqual({ exchanges: 2, received: 0, minted: tokens });
    expect(exchanges[1]).toStrictEqual(exchanges[0]);
  });

  // `mintedFor` lists the exchanges, by index, whose session the gateway asked identity's token for.
  it.each<[string, ExchangedState[], number[]]>([
    ['the one exchange of a session still active', ['active'], [0]],
    ['the repeated exchange after the first session ended before its check', ['ended', 'active'], [1]],
    ['the repeated exchange after the first session ended before its token', ['ends-before-mint', 'active'], [0, 1]],
  ])('forwards the request with the user token of %s', async (_label, states, mintedFor) => {
    const { res, answered, exchanges, received, minted } = await post(states.map((state) => () => exchanged(state, ['client_id', 'client_secret'])));
    expect(res.statusCode).toBe(200);
    expect({
      exchanges: exchanges.length,
      minted: minted.map((token) => token.request),
      authorization: received.map((req) => req.headers.authorization),
      consumed: received[0]?.headers['x-opt2-consumed-params'],
    }).toEqual({
      exchanges: states.length,
      minted: mintedFor.map((index) => ({ sessionId: answered[index]?.sessionId, siteId: SITE_A })),
      authorization: [`Bearer ${minted.at(-1)?.token ?? ''}`],
      consumed: 'client_id,client_secret',
    });
  });

  it.each<[string, ExchangedState[], number]>([
    ['its check on both exchanges', ['ended', 'ended'], 0],
    ['its check, then before its token', ['ended', 'ends-before-mint'], 1],
    ['its token, then before its check', ['ends-before-mint', 'ended'], 1],
    ['its token on both exchanges', ['ends-before-mint', 'ends-before-mint'], 2],
  ])('fails closed in the JSON API envelope when the session ended before %s', async (_label, states, tokens) => {
    const { res, exchanges, received, minted } = await post(states.map((state) => () => exchanged(state, ['client_id'])));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual(JSON.parse(apiUnavailableResponse({ method: 'save' }).body));
    expect({ exchanges: exchanges.length, received: received.length, minted: minted.length }).toEqual({ exchanges: 2, received: 0, minted: tokens });
  });
});
