// Time bounds of @opt2/platform/auth: abandoning work at an abort and bounding Google ID-token checks.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuth2Client } from 'google-auth-library';
import { CertificateFormat } from 'google-auth-library/build/src/auth/oauth2client.js';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_AUTH_TIMEOUT_MS,
  createGoogleIdTokenClient,
  untilAborted,
  verifyGoogleIdToken,
} from '../../src/auth/deadline.js';

const AUDIENCE = 'https://opt2-people-abc123-uc.a.run.app';
const NOW = Math.floor(Date.now() / 1000);

type FederatedCerts = Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>;

/** A promise that never settles. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** Replaces AbortSignal.timeout with a `ms` timeout and returns the spy, which records the requested durations. */
function shortenTimeouts(ms = 20) {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(ms));
}

/** OAuth2Client whose certificate fetch answers with `certs`, or never answers when `certs` is undefined. */
class StubCertsClient extends OAuth2Client {
  constructor(private readonly certs?: Record<string, string>) {
    super();
  }

  override getFederatedSignonCertsAsync(): Promise<FederatedCerts> {
    return this.certs === undefined ? pending() : Promise.resolve({ certs: this.certs, format: CertificateFormat.PEM });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GOOGLE_AUTH_TIMEOUT_MS', () => {
  it('is ten seconds', () => {
    expect(GOOGLE_AUTH_TIMEOUT_MS).toBe(10_000);
  });
});

describe('untilAborted', () => {
  it('returns the work itself without a signal', () => {
    const work = Promise.resolve('done');
    expect(untilAborted(work, undefined)).toBe(work);
  });

  it.each([
    {
      outcome: 'resolves',
      work: () => Promise.resolve('done'),
      settles: (p: Promise<string>) => expect(p).resolves.toBe('done'),
    },
    {
      outcome: 'rejects',
      work: () => Promise.reject(new Error('failed')),
      settles: (p: Promise<string>) => expect(p).rejects.toThrow('failed'),
    },
  ])('$outcome as the work does and removes its abort listener', async ({ work, settles }) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await settles(untilAborted(work(), controller.signal));
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
  });

  it.each([
    { when: 'aborts while the work is pending', work: () => pending<string>(), abortedBefore: false },
    { when: 'was aborted before the call', work: () => pending<string>(), abortedBefore: true },
    { when: 'was aborted before the call on settled work', work: () => Promise.resolve('done'), abortedBefore: true },
  ])('rejects with the abort reason when the signal $when', async ({ work, abortedBefore }) => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    if (abortedBefore) {
      controller.abort(reason);
    }
    const result = untilAborted(work(), controller.signal);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
  });

  it('leaves no unhandled rejection when the abandoned work fails after the abort', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      let fail: (err: Error) => void = () => undefined;
      const work = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      const controller = new AbortController();
      const result = untilAborted(work, controller.signal);
      controller.abort(new Error('deadline'));
      await expect(result).rejects.toThrow('deadline');
      fail(new Error('late failure'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});

describe('createGoogleIdTokenClient', () => {
  let server: Server;
  let certsUrl: string;
  let received = 0;

  beforeAll(async () => {
    // Accepts every certificate request and never answers it.
    server = createServer(() => {
      received += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    certsUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/oauth2/v1/certs`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('gives its transporter the Google-auth timeout as a default of every request', () => {
    const client = createGoogleIdTokenClient();
    expect(client).toBeInstanceOf(OAuth2Client);
    expect(client.transporter.defaults.timeout).toBe(GOOGLE_AUTH_TIMEOUT_MS);
    expect(createGoogleIdTokenClient()).not.toBe(client);
  });

  it('times out each attempt of a certificate fetch from a server that never answers', async () => {
    const timeouts = shortenTimeouts(100);
    const client = createGoogleIdTokenClient();
    Object.assign(client.endpoints, { oauth2FederatedSignonPemCertsUrl: certsUrl });
    await expect(client.getFederatedSignonCertsAsync()).rejects.toThrow(/Failed to retrieve verification certificates/);
    expect(received).toBeGreaterThan(0);
    expect(timeouts.mock.calls.length).toBeGreaterThanOrEqual(received);
    expect(timeouts.mock.calls.every(([ms]) => ms === GOOGLE_AUTH_TIMEOUT_MS)).toBe(true);
  });
});

describe('verifyGoogleIdToken', () => {
  it('returns the payload of a token verified within the Google-auth timeout', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const claims = { iss: 'https://accounts.google.com', aud: AUDIENCE, sub: '1047', iat: NOW, exp: NOW + 3600 };
    const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(privateKey);
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    const client = new StubCertsClient({ k1: await exportSPKI(publicKey) });
    await expect(verifyGoogleIdToken(client, idToken, AUDIENCE)).resolves.toEqual(claims);
    expect(timeouts).toHaveBeenCalledWith(GOOGLE_AUTH_TIMEOUT_MS);
  });

  it('rejects with the timeout reason when the certificate fetch never answers', async () => {
    const timeouts = shortenTimeouts();
    const started = Date.now();
    const err = await verifyGoogleIdToken(new StubCertsClient(), 'a.b.c', AUDIENCE).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(timeouts).toHaveBeenCalledWith(GOOGLE_AUTH_TIMEOUT_MS);
  });
});
