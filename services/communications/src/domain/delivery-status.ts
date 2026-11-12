// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { setTimeout as delay } from 'node:timers/promises';
import type { Clock } from '@opt2/platform/service-kit';
import { MESSAGE_ID_DOMAIN } from './mail-transport.js';

/** Most Mailpit lookups made per confirmation. */
export const MAILPIT_CONFIRM_ATTEMPTS = 10;

/** Pause between consecutive Mailpit lookups. */
export const MAILPIT_CONFIRM_INTERVAL_MS = 500;

/** Longest one Mailpit lookup may take, response body included; a slower lookup is a miss. */
export const MAILPIT_LOOKUP_TIMEOUT_MS = 2000;

/** Time one confirmation may spend on lookups and pauses together. */
export const MAILPIT_CONFIRM_BUDGET_MS = 10_000;

/** Port that tells whether a sent message reached the mail store. */
export interface DeliveryStatusSource {
  /** Returns the Mailpit `ID` of the message whose communications.message id is `messageId`, or null when not found. */
  confirm(messageId: string): Promise<string | null>;
}

/** Settings of the Mailpit delivery-status adapter. */
export interface MailpitDeliveryStatusOptions {
  /** Mailpit API origin, for example `MAILPIT_API_URL`. */
  baseUrl: string;
  /** Waits between lookups; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Accepted for symmetry with the other adapters; unused. */
  clock?: Clock;
}

interface MailpitSearchResult {
  messages?: Array<{ ID?: unknown }>;
}

/** Mailpit search URL for the Message-ID the service assigns, encoded as the fixture encodes it. */
export function mailpitSearchUrl(baseUrl: string, messageId: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/v1/search?query=${encodeURIComponent(`message-id:${messageId}@${MESSAGE_ID_DOMAIN}`)}`;
}

/** One search request bounded by `timeoutMs`; any failure, expiry or empty result is a miss (null). */
async function lookup(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = (await res.json()) as MailpitSearchResult | null;
    const id = body?.messages?.[0]?.ID;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/**
 * Delivery-status source that looks messages up through the Mailpit search API. A lookup starts only while a whole
 * second of the budget remains and is capped at those whole seconds.
 */
export function createMailpitDeliveryStatus(options: MailpitDeliveryStatusOptions): DeliveryStatusSource {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  return {
    async confirm(messageId) {
      const url = mailpitSearchUrl(options.baseUrl, messageId);
      const deadline = performance.now() + MAILPIT_CONFIRM_BUDGET_MS;
      for (let attempt = 1; attempt <= MAILPIT_CONFIRM_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          await sleep(MAILPIT_CONFIRM_INTERVAL_MS);
        }
        const remainingSeconds = Math.floor((deadline - performance.now()) / 1000);
        if (remainingSeconds < 1) {
          break;
        }
        const id = await lookup(url, Math.min(MAILPIT_LOOKUP_TIMEOUT_MS, remainingSeconds * 1000));
        if (id !== null) {
          return id;
        }
      }
      return null;
    },
  };
}
