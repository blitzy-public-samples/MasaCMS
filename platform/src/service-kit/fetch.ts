import { Agent, fetch as undiciFetch, Request as UndiciRequest, type RequestInit as UndiciRequestInit } from 'undici';

/**
 * Returns a `fetch` over undici whose dispatcher has no header or body timeout, for callers that bound each call
 * themselves through its `AbortSignal`. Answers are undici's own `Response` instances.
 */
export function createSignalBoundFetch(): typeof globalThis.fetch {
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return (input, init) => {
    // undici accepts only its own Request and FormData classes, so a global one is re-read through a global Request,
    // whose properties form a valid undici RequestInit.
    const normalized = input instanceof Request || init?.body instanceof FormData ? new Request(input, init) : undefined;
    if (normalized === undefined) {
      return undiciFetch(input as string | URL, { ...(init as UndiciRequestInit), dispatcher }) as unknown as Promise<Response>;
    }
    const request = new UndiciRequest(normalized.url, normalized as unknown as UndiciRequestInit);
    return undiciFetch(request, { dispatcher }) as unknown as Promise<Response>;
  };
}
