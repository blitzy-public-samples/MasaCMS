// The log line of a request the app does not log itself, with its fixed route classification.
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { validateLogRecord } from '@opt2/platform/logging';
import { UNMATCHED_ROUTE } from '@opt2/platform/service-kit';
import { createProcessLogger } from '@/server/logger';
import { logUnloggedRequest, requestRoute } from '@/server/request-log';
import { claimRequestLine, type RequestScope } from '@/server/shared';
import { captureLines } from '../helpers/log-lines';

const REQUEST_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A request as the server sees it: its request line, headers, status and whether its headers were sent. */
function exchange(
  url: string,
  headers: IncomingMessage['headers'] = {},
  headersSent = false,
): { req: IncomingMessage; res: ServerResponse } {
  const req = { method: 'GET', url, headers } as IncomingMessage;
  const res = Object.assign(new EventEmitter(), { statusCode: 404, headersSent }) as unknown as ServerResponse;
  return { req, res };
}

/** A fresh scope, as the custom server opens one per request. */
const newScope = (): RequestScope => ({ pipeline: false, logged: false });

describe('requestRoute', () => {
  it.each<[string | undefined, string]>([
    ['/healthz', '/healthz'],
    ['/healthz?probe=1', '/healthz'],
    ['/healthz/', UNMATCHED_ROUTE],
    ['/_next/static/chunks/main.js', '/_next/*'],
    ['/_next/image?url=%2Fa.png', '/_next/*'],
    ['/_next', UNMATCHED_ROUTE],
    ['/admin/clogin/main/', UNMATCHED_ROUTE],
    ['/nonexistent?/_next/', UNMATCHED_ROUTE],
    [undefined, UNMATCHED_ROUTE],
  ])('classifies %s as %s', (url, route) => {
    expect(requestRoute(url)).toBe(route);
  });
});

describe('logUnloggedRequest', () => {
  it('writes one INFO request line when the response finishes and closes', () => {
    const { lines, destination } = captureLines();
    const { req, res } = exchange('/_next/static/none.js', { 'x-request-id': REQUEST_ID });

    const logger = createProcessLogger({ OPT2_ENV: 'local' }, destination);
    logUnloggedRequest(req, res, newScope(), logger, performance.now());
    res.emit('finish');
    res.emit('close');

    expect(lines).toHaveLength(1);
    expect(validateLogRecord(lines[0]).errors).toEqual([]);
    expect(lines[0]).toMatchObject({
      severity: 'INFO',
      message: 'request',
      route: '/_next/*',
      httpMethod: 'GET',
      statusCode: 404,
      requestId: REQUEST_ID,
      latencyMs: expect.any(Number),
    });
  });

  it.each<[boolean, Record<string, number>]>([
    [false, {}],
    [true, { statusCode: 404 }],
  ])(
    'writes one aborted line, claiming it from a later pipeline, when the client goes first (headers sent: %s)',
    (headersSent, status) => {
      const { lines, destination } = captureLines();
      const { req, res } = exchange('/admin/clogin/main', {}, headersSent);
      const scope = newScope();

      logUnloggedRequest(req, res, scope, createProcessLogger({ OPT2_ENV: 'local' }, destination));
      res.emit('close');

      expect(claimRequestLine(scope)).toBe(false);
      expect(lines).toHaveLength(1);
      expect(validateLogRecord(lines[0]).errors).toEqual([]);
      expect(lines[0]).toMatchObject({ severity: 'INFO', message: 'request aborted', route: UNMATCHED_ROUTE, ...status });
      if (!headersSent) expect(lines[0]).not.toHaveProperty('statusCode');
    },
  );

  it('leaves the line of a request the pipeline took to the pipeline when the client goes first', () => {
    const { lines, destination } = captureLines();
    const { req, res } = exchange('/admin/clogin/main');
    const scope = newScope();

    logUnloggedRequest(req, res, scope, createProcessLogger({ OPT2_ENV: 'local' }, destination));
    scope.pipeline = true;
    res.emit('close');

    expect(lines).toEqual([]);
    expect(claimRequestLine(scope)).toBe(true);
  });

  it('writes nothing for a request the app logged', () => {
    const { lines, destination } = captureLines();
    const { req, res } = exchange('/admin/clogin/main');
    const scope = newScope();

    logUnloggedRequest(req, res, scope, createProcessLogger({ OPT2_ENV: 'local' }, destination));
    claimRequestLine(scope);
    res.emit('finish');
    res.emit('close');

    expect(lines).toEqual([]);
  });
});
