/** JSON API requests and legacy wire-format assertions shared by the offline and PostgreSQL legacy-api suites. */
import { expect } from 'vitest';
import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN, LEGACY_ERROR_MAP, etag, legacyHeaders } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import { userHeaders, type TestApp } from './app.js';
import type { TestActor } from './fixtures.js';
import type { IdentityDouble, RecordedIdentityRequest } from './identity-double.js';
import { legacyApiSettings } from '../../src/routes/legacy-api.js';

export type Family = 'json' | 'ajax' | 'rest';
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type LegacyErrorType = keyof typeof LEGACY_ERROR_MAP;

/** A response as `app.inject` answers it. */
export interface InjectedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

/** The legacy JSON API envelope. */
export interface Envelope {
  apiversion: string;
  method: string;
  params?: Record<string, unknown>;
  data?: Record<string, unknown>;
  error?: { message: string; code: string };
}

export const FAMILIES = ['json', 'ajax'] as const;
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['apiversion', 'method', 'params', 'data', 'error']);
const FORM = Object.freeze({ 'content-type': 'application/x-www-form-urlencoded' });
export const TOKEN = 'TEST-CSRF-TOKEN';
export const TOKEN_EXPIRES = '260630130000000';
export const CSRF = csrfHeaders(TOKEN);
/** The reload key the app reads from its environment, as legacy reads `application.appreloadkey`. */
export const RELOAD_KEY = legacyApiSettings(process.env).appReloadKey;

/** CSRF headers carrying `token`; identity consumes each token once per session. */
export function csrfHeaders(token: string): Readonly<Record<string, string>> {
  return Object.freeze({ [CSRF_HEADER_TOKEN]: token, [CSRF_HEADER_EXPIRES]: TOKEN_EXPIRES });
}

/** `/_api/<family>/v1/tenant-a<rest>`. */
export function apiPath(family: Family, rest: string): string {
  return `/_api/${family}/v1/${TENANT_A.siteId}${rest}`;
}

/** The session id an actor's token carries. */
export function sessionOf(actor: Pick<TestActor, 'sub'>): string {
  return `SESSION-${actor.sub}`;
}

/** `actor`'s user token and the gateway's invocation credential, with the actor's session. */
export function actorHeaders(actor: TestActor): Promise<Record<string, string>> {
  return userHeaders({ ...actor, sid: sessionOf(actor) });
}

/** One injected request; a form is sent url-encoded. */
export async function send(app: TestApp['app'], method: Method, url: string, headers: Record<string, string>, form?: Record<string, string>): Promise<InjectedResponse> {
  return app.inject({
    method,
    url,
    headers: { ...headers, ...(form === undefined ? {} : FORM) },
    ...(form === undefined ? {} : { payload: new URLSearchParams(form).toString() }),
  });
}

/** Asserts the legacy wire form of `res` at `status` and returns its envelope. */
export function legacyEnvelope(res: InjectedResponse, status: number): Envelope {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers.etag).toBe(etag(res.body));
  for (const [name, value] of Object.entries(legacyHeaders())) expect(res.headers[name.toLowerCase()]).toBe(value);
  const envelope = JSON.parse(res.body) as Envelope;
  expect(envelope.apiversion).toBe('v1');
  expect(typeof envelope.method).toBe('string');
  expect(Object.keys(envelope).filter((key) => !ENVELOPE_KEYS.has(key))).toEqual([]);
  expect('data' in envelope).not.toBe('error' in envelope);
  return envelope;
}

/** Asserts the legacy error envelope of `type`, at its mapped status unless another is given. */
export function legacyError(res: InjectedResponse, type: LegacyErrorType, status: number = LEGACY_ERROR_MAP[type].status): Envelope {
  const envelope = legacyEnvelope(res, status);
  const { message, code } = LEGACY_ERROR_MAP[type];
  expect(envelope.error).toEqual({ message, code });
  return envelope;
}

/** The `data` of a successful envelope. */
export function dataOf(res: InjectedResponse, status = 200): Record<string, unknown> {
  const { data } = legacyEnvelope(res, status);
  if (data === undefined) throw new Error('envelope without data');
  return data;
}

/** The identity operations people called, by contract operation id. */
export function operationIds(identity: IdentityDouble): string[] {
  return identity.requests.flatMap((request: RecordedIdentityRequest) => (request.operationId === undefined ? [] : [request.operationId]));
}

/** The roster steps people called on identity, in order. */
export function rosterSteps(identity: IdentityDouble): string[] {
  const steps = new Set(['prepareAccountOperation', 'commitAccountOperation', 'abortAccountOperation', 'finishAccountOperation', 'revertAccountOperation']);
  return operationIds(identity).filter((id) => steps.has(id));
}
