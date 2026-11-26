// Time bounds of @opt2/platform/auth: Google ID-token checks and abandoning credential work at a signal's abort.
import { OAuth2Client, type TokenPayload } from 'google-auth-library';

/** Upper bound of one Google ID-token verification, certificate fetch included. */
export const GOOGLE_AUTH_TIMEOUT_MS = 10_000;

/** Settles as `work` does, or rejects with `signal.reason` once `signal` aborts; `work` itself runs on. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return work;
  }
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  // The race keeps a handler on `work`, so its rejection after an abort is never unhandled.
  return Promise.race([aborted, work]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/** OAuth2Client for Google ID-token checks whose every certificate request attempt times out. */
export function createGoogleIdTokenClient(): OAuth2Client {
  return new OAuth2Client({ transporterOptions: { timeout: GOOGLE_AUTH_TIMEOUT_MS } });
}

/** Payload of a Google-signed ID token for `audience`; rejects once GOOGLE_AUTH_TIMEOUT_MS passes. */
export async function verifyGoogleIdToken(
  client: OAuth2Client,
  idToken: string,
  audience: string,
): Promise<TokenPayload | undefined> {
  const ticket = await untilAborted(
    client.verifyIdToken({ idToken, audience }),
    AbortSignal.timeout(GOOGLE_AUTH_TIMEOUT_MS),
  );
  return ticket.getPayload();
}
