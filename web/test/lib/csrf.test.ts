// Tests of web's CSRF renderer over identity-issued token pairs, against the in-memory gateway client.
import { beforeAll, describe, expect, it } from 'vitest';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, renderCsrfFields } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/identity';
import { createCsrfRenderer, type CsrfFormat, type CsrfTokens } from '@/lib/csrf';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { CSRF_BY_CONTEXT, CSRF_LOGIN, CSRF_UPDATECORE } from '../fixtures/identity/csrf';
import {
  fakeGatewayClient,
  routeKey,
  type FakeCall,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRoute,
} from '../helpers/fake-gateway';
import { userTokenFor } from '../helpers/tokens';

type IssuedCsrfToken = components['schemas']['CsrfTokenSet']['tokens'][number];
type CsrfTokensRequest = components['schemas']['CsrfTokensRequest'];

const ISSUE_PATH = '/v1/csrf/tokens';
const ISSUE_TOKENS = routeKey('POST', 'identity', ISSUE_PATH);
const CONSUME_PATH = '/internal/v1/csrf/consume';
const REISSUED_LOGIN: Readonly<IssuedCsrfToken> = Object.freeze({ ...CSRF_LOGIN, csrf_token: 'A'.repeat(64) });

let userToken: string;

beforeAll(async () => {
  const token = await userTokenFor('admin');
  if (token === undefined) throw new TypeError('SUBJECTS.admin has no user token');
  userToken = token;
});

const pairOf = (issued: Readonly<IssuedCsrfToken>): CsrfTokens => ({
  token: issued.csrf_token,
  expires: issued.csrf_token_expires,
});

const issuedReply = (tokens: readonly Readonly<IssuedCsrfToken>[]): FakeReply => ({ status: 200, body: { tokens } });

/** issueCsrfTokens over `issued`: 401 without a user token, else the known pairs of the requested contexts. */
function issueFrom(issued: Readonly<Record<string, Readonly<IssuedCsrfToken>>>): FakeRoute {
  return (request) => {
    if (request.headers.authorization === undefined) return { status: 401 };
    const { contexts } = request.json as CsrfTokensRequest;
    return issuedReply(contexts.flatMap((context) => issued[context] ?? []));
  };
}

/** An in-memory gateway whose identity issues `issued` to the admin's session. */
function identityGateway(issued = CSRF_BY_CONTEXT): FakeGatewayClient {
  return fakeGatewayClient({ [ISSUE_TOKENS]: issueFrom(issued) }, { userToken });
}

/** The recorded identity call issuing `contexts`. */
const issueCall = (contexts: readonly string[]): FakeCall => ({
  service: 'identity',
  method: 'POST',
  path: ISSUE_PATH,
  json: { contexts },
  userToken,
});

describe('createCsrfRenderer tokens', () => {
  it('issues the pair of a context through identity', async () => {
    const gateway = identityGateway();

    await expect(createCsrfRenderer(gateway).tokens('login')).resolves.toEqual(pairOf(CSRF_LOGIN));
    expect(gateway.calls).toEqual([issueCall(['login'])]);
  });

  it('memoises each context for the renderer', async () => {
    const gateway = identityGateway();
    const renderer = createCsrfRenderer(gateway);

    await renderer.tokens('login');
    await expect(renderer.tokens('login')).resolves.toEqual(pairOf(CSRF_LOGIN));
    expect(gateway.calls).toHaveLength(1);

    await expect(renderer.tokens('updatecore')).resolves.toEqual(pairOf(CSRF_UPDATECORE));
    expect(gateway.calls).toEqual([issueCall(['login']), issueCall(['updatecore'])]);
  });

  it('fetches again on a new renderer', async () => {
    const gateway = identityGateway();

    await createCsrfRenderer(gateway).tokens('login');
    await createCsrfRenderer(gateway).tokens('login');
    expect(gateway.calls).toEqual([issueCall(['login']), issueCall(['login'])]);
  });

  it('shares one call between concurrent requests for a context', async () => {
    const gateway = identityGateway();
    const renderer = createCsrfRenderer(gateway);

    const pairs = await Promise.all([renderer.tokens('login'), renderer.tokens('login')]);
    expect(pairs).toEqual([pairOf(CSRF_LOGIN), pairOf(CSRF_LOGIN)]);
    expect(gateway.calls).toHaveLength(1);
  });

  it('prefetches the distinct contexts in one call, after which render calls nothing', async () => {
    const gateway = identityGateway();
    const renderer = createCsrfRenderer(gateway);

    await renderer.prefetch(['login', 'updatecore', 'login']);
    expect(gateway.calls).toEqual([issueCall(['login', 'updatecore'])]);

    renderer.render('login');
    renderer.render('updatecore', 'url');
    await renderer.prefetch(['updatecore']);
    await expect(renderer.tokens('updatecore')).resolves.toEqual(pairOf(CSRF_UPDATECORE));
    expect(gateway.calls).toHaveLength(1);
  });

  it('prefetches only contexts not yet requested', async () => {
    const gateway = identityGateway();
    const renderer = createCsrfRenderer(gateway);

    const login = renderer.tokens('login');
    await renderer.prefetch(['login', 'updatecore']);
    await expect(login).resolves.toEqual(pairOf(CSRF_LOGIN));
    expect(gateway.calls).toEqual([issueCall(['login']), issueCall(['updatecore'])]);
  });

  it('issues a fresh pair that replaces the memoised one', async () => {
    const gateway = identityGateway();
    const renderer = createCsrfRenderer(gateway);

    await renderer.tokens('login');
    gateway.setRoute(ISSUE_TOKENS, issueFrom({ login: REISSUED_LOGIN }));
    await expect(renderer.tokens('login', { fresh: true })).resolves.toEqual(pairOf(REISSUED_LOGIN));
    await expect(renderer.tokens('login')).resolves.toEqual(pairOf(REISSUED_LOGIN));
    expect(toString(renderer.render('login'))).toBe(renderCsrfFields(pairOf(REISSUED_LOGIN)));
    expect(gateway.calls).toHaveLength(2);
  });

  it('keeps the fresh pair when the superseded issue answers last', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let issued = 0;
    const gateway = fakeGatewayClient(
      {
        [ISSUE_TOKENS]: async () => {
          issued += 1;
          if (issued > 1) return issuedReply([REISSUED_LOGIN]);
          await released;
          return issuedReply([CSRF_LOGIN]);
        },
      },
      { userToken },
    );
    const renderer = createCsrfRenderer(gateway);

    const superseded = renderer.tokens('login');
    await expect(renderer.tokens('login', { fresh: true })).resolves.toEqual(pairOf(REISSUED_LOGIN));
    release();
    await expect(superseded).resolves.toEqual(pairOf(CSRF_LOGIN));
    expect(toString(renderer.render('login', 'url'))).toBe(renderCsrfFields(pairOf(REISSUED_LOGIN), 'url'));
    expect(gateway.calls).toHaveLength(2);
  });

  it('rejects with GatewayUnavailableError when identity is unavailable', async () => {
    const gateway = identityGateway();
    gateway.failWith();

    const rejected = createCsrfRenderer(gateway).tokens('login');
    await expect(rejected).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(rejected).rejects.toMatchObject({ service: 'identity' });
    await expect(createCsrfRenderer(gateway).prefetch(['login', 'updatecore'])).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
  });

  it('rejects when identity refuses the call', async () => {
    const gateway = fakeGatewayClient({ [ISSUE_TOKENS]: issueFrom(CSRF_BY_CONTEXT) });

    await expect(createCsrfRenderer(gateway).tokens('login')).rejects.toThrow(
      'identity issueCsrfTokens answered HTTP 401',
    );
  });

  it('rejects when identity issues no pair for the context', async () => {
    await expect(createCsrfRenderer(identityGateway()).tokens('unlisted')).rejects.toThrow(
      'identity issued no CSRF tokens for context "unlisted"',
    );
  });
});

describe('createCsrfRenderer render, as renderCSRFTokens 254-270', () => {
  const { csrf_token: token, csrf_token_expires: expires } = CSRF_LOGIN;
  const hiddenFields =
    `<input type="hidden" name="csrf_token" value="${token}" />` +
    `<input type="hidden" name="csrf_token_expires" value="${expires}" />`;

  it.each<{ name: string; format?: CsrfFormat; expected: string }>([
    { name: 'default', expected: hiddenFields },
    { name: 'form', format: 'form', expected: hiddenFields },
    { name: 'url', format: 'url', expected: `&csrf_token=${token}&csrf_token_expires=${expires}` },
    { name: 'json', format: 'json', expected: `{csrf_token:'${token}',csrf_token_expires:'${expires}'}` },
  ])('renders the $name format with the shared legacy-compat renderer', async ({ format, expected }) => {
    const renderer = createCsrfRenderer(identityGateway());
    await renderer.prefetch(['login']);

    const markup = toString(renderer.render('login', format));
    expect(markup).toBe(expected);
    expect(markup).toBe(renderCsrfFields(pairOf(CSRF_LOGIN), format));
  });

  it('names the fields as legacy', () => {
    expect(CSRF_FIELD_TOKEN).toBe('csrf_token');
    expect(CSRF_FIELD_EXPIRES).toBe('csrf_token_expires');
  });

  it('throws for a context whose pair has not arrived', async () => {
    const renderer = createCsrfRenderer(identityGateway());
    const message = 'CSRF tokens for context "updatecore" have not been fetched';

    expect(() => renderer.render('updatecore')).toThrow(message);
    const pending = renderer.tokens('updatecore');
    expect(() => renderer.render('updatecore')).toThrow(message);
    await pending;
    expect(toString(renderer.render('updatecore'))).toBe(renderCsrfFields(pairOf(CSRF_UPDATECORE)));
  });
});

describe('createCsrfRenderer never validates', () => {
  it('exposes no validate or consume operation', () => {
    const renderer = createCsrfRenderer(identityGateway());

    expect('validate' in renderer).toBe(false);
    expect('consume' in renderer).toBe(false);
    expect(Object.keys(renderer).sort()).toEqual(['prefetch', 'render', 'tokens']);
  });

  it("only calls identity's token-issuing operation", async () => {
    const gateway = identityGateway();
    const renderer = createCsrfRenderer(gateway);

    await renderer.prefetch(['login', 'updatecore']);
    renderer.render('login');
    renderer.render('updatecore', 'json');
    await renderer.tokens('login', { fresh: true });

    expect(gateway.calls).toEqual([issueCall(['login', 'updatecore']), issueCall(['login'])]);
    expect(gateway.calls.map(({ path }) => path)).not.toContain(CONSUME_PATH);
  });
});
