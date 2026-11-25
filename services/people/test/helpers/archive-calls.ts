/** Fixture archive route calls and envelope checks shared by the offline and PostgreSQL archive suites. */
import { expect } from 'vitest';
import { parse } from 'yaml';
import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN, type LegacyErrorSpec } from '@opt2/platform/legacy-compat';
import { loadOpenApiDocument } from '@opt2/platform/testing';
import { FIXTURE_ARCHIVE_PATH } from '../../src/routes/fixture-archive.js';
import { userHeaders, type TestApp } from './app.js';
import { ARCHIVE_EFFECTIVE_FROM, type TestActor } from './fixtures.js';

export type InjectResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

export const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as object;

/** api.cfm's envelope `method` of the archive route. */
export const METHOD = 'people.persons.archive';
/** envelope.cfc's notFound row, which the JSON API error map lacks. */
export const NOT_FOUND: LegacyErrorSpec = { status: 404, code: 'invalid_request', message: 'Not Found' };

export const EFFECTIVE_FROM_TEXT = '2026-07-01T00:00:00';
export const ARCHIVED_AT_TEXT = '2026-06-30T12:00:00';
export const SADMIN_NAMES = { fname: 'Sasha', lname: 'Admin' } as const;

/** The archive path of `userId`. */
export const archivePath = (userId: string): string => FIXTURE_ARCHIVE_PATH.replace(':userId', encodeURIComponent(userId));

/** The fixture envelope of an error row: api.cfm's method, code before message. */
export function expectFixtureError(response: InjectResponse, row: LegacyErrorSpec): void {
  expect(response.statusCode).toBe(row.status);
  const body = response.json<{ error: Record<string, unknown> }>();
  expect(body).toStrictEqual({ apiversion: 'v1', method: METHOD, error: { code: row.code, message: row.message } });
  expect(Object.keys(body.error)).toEqual(['code', 'message']);
}

let csrfSequence = 0;

/** Headers of `actor` arriving through the gateway with a fresh CSRF token; `site` overrides the token's site. */
export async function actorHeaders(actor: Pick<TestActor, 'sub' | 'site' | 'roles' | 's2'>, opts: { sid?: string; site?: string } = {}): Promise<Record<string, string>> {
  csrfSequence += 1;
  return {
    ...(await userHeaders({ ...actor, site: opts.site ?? actor.site, ...(opts.sid === undefined ? {} : { sid: opts.sid }) })),
    [CSRF_HEADER_TOKEN]: `TOKEN-${String(csrfSequence)}`,
    [CSRF_HEADER_EXPIRES]: '260630130000000',
  };
}

/** One call of the archive route. */
export interface ArchiveCall {
  method?: 'GET' | 'POST';
  userId: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** A JSON object body, or a urlencoded form string. */
  body?: Record<string, unknown> | string;
}

/** Injects `call` into the archive route; a POST without a body sends `ARCHIVE_EFFECTIVE_FROM`. */
export function callArchive(app: TestApp['app'], call: ArchiveCall): Promise<InjectResponse> {
  const method = call.method ?? 'POST';
  const form = typeof call.body === 'string';
  return app.inject({
    method,
    url: archivePath(call.userId),
    query: call.query ?? {},
    headers: { ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...call.headers },
    ...(method === 'POST' ? { payload: call.body ?? { effectiveFrom: ARCHIVE_EFFECTIVE_FROM } } : {}),
  });
}
