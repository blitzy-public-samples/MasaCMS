// The log line of a request the app does not log itself: health checks, Next assets, redirects, 404s and 405s.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@opt2/platform/logging';
import { UNMATCHED_ROUTE, requestIdFrom } from '@opt2/platform/service-kit';
import { claimRequestLine, type RequestScope } from './shared.ts';

/** The fixed route of a request outside the admin pipeline: `/healthz`, `/_next/*` for Next's paths, else unmatched. */
export function requestRoute(url: string | undefined): string {
  const path = (url ?? '').split('?', 1)[0] ?? '';
  if (path === '/healthz') return '/healthz';
  if (path.startsWith('/_next/')) return '/_next/*';
  return UNMATCHED_ROUTE;
}

/** Writes the unclaimed INFO line of a request: `request` once `res` finishes, `request aborted` if it closes first. */
export function logUnloggedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  scope: RequestScope,
  logger: Logger,
  started: number = performance.now(),
): void {
  const write = (message: string, status: { statusCode?: number }): void => {
    if (!claimRequestLine(scope)) return;
    logger.info(
      {
        route: requestRoute(req.url),
        httpMethod: req.method,
        ...status,
        latencyMs: Math.round(performance.now() - started),
        requestId: requestIdFrom(req.headers),
      },
      message,
    );
  };
  res.once('finish', () => write('request', { statusCode: res.statusCode }));
  res.once('close', () => {
    // After 'finish' the line is claimed; the pipeline writes the line of a request it took once it completes.
    if (scope.pipeline) return;
    write('request aborted', res.headersSent ? { statusCode: res.statusCode } : {});
  });
}
