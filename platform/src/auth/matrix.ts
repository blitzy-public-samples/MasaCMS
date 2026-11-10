// Route/role matrix export of @opt2/platform/auth: every route registerAuth recorded, with its auth declaration.
import type { FastifyInstance } from 'fastify';
import type { Transport } from './claims.js';
import { recordedRoutes, type RecordedRoute } from './hooks.js';

/** One route and method with the auth declaration it was validated with; exactly one of `requires` and `public`. */
export interface RouteMatrixEntry {
  /** Upper-case HTTP method. */
  method: string;
  /** Fastify route pattern, e.g. `/internal/v1/accounts/:userId/operations/:operationId:prepare`. */
  url: string;
  transport: Transport;
  requires?: string[];
  public?: true;
  edge?: true;
  siteCheck: boolean;
}

/** Declared routes of one app, deduplicated and sorted by url, then method. */
export interface RouteMatrix {
  routes: RouteMatrixEntry[];
}

/** Collects the routes `registerAuth` recorded on `app`; call after `await app.ready()`. Throws when `registerAuth` was not applied. */
export function collectRouteMatrix(app: FastifyInstance): RouteMatrix {
  const unique = new Map<string, RouteMatrixEntry>();
  for (const route of recordedRoutes(app)) {
    const entry = toEntry(route);
    const key = JSON.stringify(entry);
    if (!unique.has(key)) {
      unique.set(key, entry);
    }
  }
  // The serialized-entry tie-break orders same method and url registrations (e.g. distinct constraints) independently of registration order.
  const routes = [...unique]
    .sort(
      ([keyA, a], [keyB, b]) =>
        a.url.localeCompare(b.url, 'en') || a.method.localeCompare(b.method, 'en') || (keyA < keyB ? -1 : 1),
    )
    .map(([, entry]) => entry);
  return { routes };
}

/** Matrix as two-space-indented JSON with a trailing newline; byte-stable for the same routes. */
export function serializeRouteMatrix(matrix: RouteMatrix): string {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

function toEntry({ method, url, config }: RecordedRoute): RouteMatrixEntry {
  return {
    method,
    url,
    transport: config.transport ?? 'service',
    ...(config.requires === undefined ? { public: true as const } : { requires: [...config.requires] }),
    ...(config.edge === true ? { edge: true as const } : {}),
    siteCheck: config.siteCheck !== false,
  };
}
