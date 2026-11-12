/** Mailpit access for e2e suites, over its HTTP API only, reusing the golden side-effect client. */
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_MAILPIT_URL, collectMail, type MailMessage } from '../../src/golden/side-effects.js';
import type { EnvLike } from '../../src/lib/paths.js';

// The golden client, reused unchanged so the harness keeps one Mailpit client; its mailCount is the `limit=1` count query.
export { collectMail, mailCount, resetMailpit, type MailMessage } from '../../src/golden/side-effects.js';

const WAIT_TIMEOUT_MS = 15_000;
const WAIT_INTERVAL_MS = 250;

/** Mailpit API base URL: `MAILPIT_API_URL` without trailing slashes, else the stack default. */
export function mailpitApiUrl(env: EnvLike = process.env): string {
  // An empty value counts as unset, as side-effects.ts reads it, so both always address the same Mailpit.
  const configured = env.MAILPIT_API_URL;
  return (configured === undefined || configured === '' ? DEFAULT_MAILPIT_URL : configured).replace(/\/+$/, '');
}

/** Bounds of {@link waitForMail} and the environment its Mailpit reads use. */
export interface WaitForMailOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Passed to `collectMail`, which takes the environment rather than message ids; `predicate` does the filtering. */
  env?: EnvLike;
}

/** Recipients and subject of each message; bodies are left out because login mail carries links and tokens. */
function summarise(messages: readonly MailMessage[]): string {
  if (messages.length === 0) return 'none';
  return messages.map((m) => `${JSON.stringify(m.subject)} to ${m.to.join(', ') || '(no recipients)'}`).join('; ');
}

/**
 * First Mailpit message satisfying `predicate`, polled every `intervalMs` (250) for up to `timeoutMs` (15 000).
 * Unlike the golden `waitForMail`, which waits for the mailbox to go quiet, this waits for one specific message.
 */
export async function waitForMail(
  predicate: (m: MailMessage) => boolean,
  opts: WaitForMailOptions = {},
): Promise<MailMessage> {
  const { timeoutMs = WAIT_TIMEOUT_MS, intervalMs = WAIT_INTERVAL_MS, env = process.env } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await collectMail(env);
    const match = messages.find(predicate);
    if (match !== undefined) return match;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`no Mailpit message at ${mailpitApiUrl(env)} matched within ${timeoutMs} ms; seen: ${summarise(messages)}`);
    }
    await delay(Math.min(intervalMs, remaining));
  }
}
