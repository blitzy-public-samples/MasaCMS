// Legacy `renderCSRFTokens` output on reproduced admin screens, over token pairs identity issues (server-only).
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, renderCsrfFields, type CsrfTokens } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/identity';
import { okBody, type GatewayClient } from './gateway-client';
import { raw, type SafeHtml } from './html';

export type { CsrfTokens };

/** Output formats of legacy `renderCSRFTokens`. */
export type CsrfFormat = 'form' | 'url' | 'json';

/** Options of {@link CsrfRenderer.tokens}. */
export interface CsrfTokenOptions {
  /** Issues a new pair even when one is memoised; the new pair replaces it for `render`. */
  readonly fresh?: boolean;
}

/** The CSRF token pairs of one admin request, issued by identity and memoised per context unless `fresh` is requested. */
export interface CsrfRenderer {
  /** The pair for `context`, issued on first use and memoised unless `fresh` is set. */
  tokens(context: string, options?: CsrfTokenOptions): Promise<CsrfTokens>;
  /** Issues every context not yet requested in one identity call, so `render` can run synchronously. */
  prefetch(contexts: readonly string[]): Promise<void>;
  /** The `renderCSRFTokens` markup for a fetched context; throws when `context` has not been fetched. */
  render(context: string, format?: CsrfFormat): SafeHtml;
}

type IssuedTokens = components['schemas']['CsrfTokenSet']['tokens'][number];

/**
 * The pairs identity issues for `contexts`, keyed by context; unavailability propagates as `GatewayUnavailableError`.
 * @throws GatewayDenialError When identity answers 401 or 403.
 */
async function issue(gateway: GatewayClient, contexts: readonly string[]): Promise<ReadonlyMap<string, CsrfTokens>> {
  const { tokens } = okBody(await gateway.identity.csrfTokens([...contexts]), 'identity', 'issueCsrfTokens');
  return new Map(
    tokens.map((issued: IssuedTokens): [string, CsrfTokens] => [
      issued.context,
      { token: issued[CSRF_FIELD_TOKEN], expires: issued[CSRF_FIELD_EXPIRES] },
    ]),
  );
}

function pairFor(pairs: ReadonlyMap<string, CsrfTokens>, context: string): CsrfTokens {
  const tokens = pairs.get(context);
  if (tokens === undefined) throw new Error(`identity issued no CSRF tokens for context "${context}"`);
  return tokens;
}

/** A renderer whose token pairs come from identity through `gateway`, for the lifetime of one admin request. */
export function createCsrfRenderer(gateway: GatewayClient): CsrfRenderer {
  const pending = new Map<string, Promise<CsrfTokens>>();
  const fetched = new Map<string, CsrfTokens>();

  /** Memoises the pair `batch` issues for `context`, unless a later request for it has replaced this one. */
  function memoise(context: string, batch: Promise<ReadonlyMap<string, CsrfTokens>>): Promise<CsrfTokens> {
    const pair: Promise<CsrfTokens> = batch.then((pairs) => {
      const tokens = pairFor(pairs, context);
      if (pending.get(context) === pair) fetched.set(context, tokens);
      return tokens;
    });
    pending.set(context, pair);
    return pair;
  }

  return {
    tokens(context, { fresh = false } = {}) {
      const memo = pending.get(context);
      return memo !== undefined && !fresh ? memo : memoise(context, issue(gateway, [context]));
    },

    async prefetch(contexts) {
      const missing = [...new Set(contexts)].filter((context) => !pending.has(context));
      if (missing.length > 0) {
        const batch = issue(gateway, missing);
        for (const context of missing) memoise(context, batch);
      }
      await Promise.all(contexts.map((context) => pending.get(context)));
    },

    render(context, format = 'form') {
      const tokens = fetched.get(context);
      if (tokens === undefined) throw new Error(`CSRF tokens for context "${context}" have not been fetched`);
      return raw(renderCsrfFields(tokens, format));
    },
  };
}
