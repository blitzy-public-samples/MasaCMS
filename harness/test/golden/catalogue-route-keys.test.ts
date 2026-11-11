import {
  esapiUrlEncode,
  matchRouteKey,
  type RouteKeyOptions,
  type RouteKeyRequest,
} from '@opt2/platform/legacy-compat';
import { routeKeyCaseOptions } from '@opt2/platform/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, type Step } from '../../src/golden/catalogue.js';
import { basicAuth } from '../../src/golden/session.js';
import { inventoryRouteKeyForRequest, loadInventoryVariants } from '../../src/inventory/route-keys.js';

/** Neutral CF UUID standing in for path segments and id-valued placeholders. */
const NEUTRAL_ID = '00000000-0000-0000-0000000000000000';
const INNERMOST = /\$\{([^${}]*)\}/g;
const MATRIX_REF = /\$\{matrix\.([a-zA-Z][\w-]*)\}/g;
const CONTENT_TYPES = {
  form: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
  body: 'application/json',
};

type RequestShape = Pick<Step, 'method' | 'route' | 'auth' | 'headers' | 'form' | 'body' | 'multipart'>;

/** One expanded request of a step and the cover its key matched, if any. */
interface KeyedRequest {
  scenario: string;
  step: string;
  combination: string;
  key: string;
  cover: string | undefined;
}

/** Stand-in value of placeholder `name`: the route-key default reload key, a neutral id, an encoded value, or `x`. */
function neutral(name: string, inPath: boolean): string {
  if (name === 'secret:appreload') return 'appreload';
  if (name.startsWith('nodash:')) return NEUTRAL_ID.replaceAll('-', '');
  if (name.startsWith('urlencode:')) return esapiUrlEncode(name.slice('urlencode:'.length));
  return inPath || /id$/i.test(name.split(/[.:]/).pop() ?? '') ? NEUTRAL_ID : 'x';
}

/** `text` with every placeholder replaced by its neutral value, innermost first. */
function fill(text: string, inPath = false): string {
  let out = text;
  for (let last = ''; out !== last; ) {
    last = out;
    out = out.replace(INNERMOST, (_, name: string) => neutral(name, inPath));
  }
  return out;
}

/** Copy of `value` with `fn` applied to every string, object keys included. */
function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => mapStrings(item, fn)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [fn(key), mapStrings(item, fn)])) as T;
  }
  return value;
}

/** Cartesian product of a step matrix, in declared key order. */
function combinations(matrix: Step['matrix']): Record<string, string>[] {
  return Object.entries(matrix ?? {}).reduce<Record<string, string>[]>(
    (acc, [name, values]) => acc.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value }))),
    [{}],
  );
}

/** URL scope as the gateway dispatcher builds it: a repeated name maps to its values in order. */
function queryOf(search: string): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>();
  for (const [name, value] of new URLSearchParams(search)) {
    const previous = query.get(name);
    query.set(name, previous === undefined ? value : [previous, value].flat());
  }
  return Object.fromEntries(query);
}

/** `Authorization` header a step's `basic:` or `bearer:` auth mode sends. */
function authorization(auth: string | undefined): Record<string, string> {
  if (auth?.startsWith('basic:')) {
    const [user = '', ...secret] = auth.slice('basic:'.length).split(':');
    return { Authorization: basicAuth(user, secret.join(':')) };
  }
  return auth?.startsWith('bearer:') ? { Authorization: `Bearer ${auth.slice('bearer:'.length)}` } : {};
}

/** Route-key input of one request shape whose matrix placeholders are already substituted. */
function keyRequest(shape: RequestShape): RouteKeyRequest {
  const at = shape.route.indexOf('?');
  const request: RouteKeyRequest = {
    method: shape.method,
    path: fill(at === -1 ? shape.route : shape.route.slice(0, at), true),
    query: queryOf(at === -1 ? '' : fill(shape.route.slice(at + 1))),
    headers: authorization(shape.auth === undefined ? undefined : fill(shape.auth)),
  };
  if (shape.form !== undefined) request.form = mapStrings(shape.form, (text) => fill(text));
  if (shape.multipart !== undefined) {
    request.form = mapStrings(shape.multipart.fields, (text) => fill(text));
    request.multipartFileNames = shape.multipart.files.map(({ field, filename }) => ({ field, filename }));
  }
  if (shape.body !== undefined) request.jsonBody = mapStrings(shape.body, (text) => fill(text));
  const kind = (['form', 'multipart', 'body'] as const).find((name) => shape[name] !== undefined);
  if (kind !== undefined) request.headers['Content-Type'] = CONTENT_TYPES[kind];
  Object.assign(request.headers, mapStrings(shape.headers ?? {}, (text) => fill(text)));
  return request;
}

/** Every request the committed catalogue's steps send: each matrix combination, the step and each candidate. */
async function keyedRequests(): Promise<KeyedRequest[]> {
  const catalogue = await loadCatalogue();
  const options: RouteKeyOptions = { ...routeKeyCaseOptions, variants: (await loadInventoryVariants()).variants };
  const keyed: KeyedRequest[] = [];
  for (const scenario of catalogue.scenarios) {
    for (const step of scenario.steps) {
      for (const combo of combinations(step.matrix)) {
        const shapes: RequestShape[] = [step, ...(step.candidates ?? []).map((c) => ({ ...c, auth: step.auth }))];
        const matrixLabel = Object.keys(combo).length === 0 ? '' : ` matrix${JSON.stringify(combo)}`;
        const withMatrix = (text: string): string => text.replace(MATRIX_REF, (_, name: string) => combo[name] ?? '');
        for (const [index, shape] of shapes.entries()) {
          const result = await inventoryRouteKeyForRequest(keyRequest(mapStrings(shape, withMatrix)), options);
          keyed.push({
            scenario: scenario.id,
            step: step.name,
            combination: `${matrixLabel}${index === 0 ? '' : ` candidate[${index - 1}]`}`,
            key: result.key,
            cover: matchRouteKey(result, scenario.covers),
          });
        }
      }
    }
  }
  return keyed;
}

describe('golden catalogue covers', () => {
  let keyed: KeyedRequest[] = [];
  beforeAll(async () => {
    keyed = await keyedRequests();
  });

  it('names a cover for the route key of every expanded step request', () => {
    const misses = keyed
      .filter((request) => request.cover === undefined)
      .map(({ scenario, step, combination, key }) => `${scenario} ${step}${combination} -> ${key}`);
    expect(keyed.length).toBeGreaterThan(0);
    expect(misses, `requests whose route key matches no cover of their scenario:\n${misses.join('\n')}`).toEqual([]);
  });

  it.each([
    ['GS-CO-05', 'reads', 'api:content.findcrumbarray'],
    ['GS-CO-05', 'reads', 'api:content.findrelatedcontent'],
    ['GS-CO-05', 'reads', 'api:content.findversionhistory'],
    ['GS-CO-07', 'uploader-post-image', 'admin:carch.multifileupload{upload=image}'],
    ['GS-CO-09', 'pending-version', 'api:content.findversionhistory'],
    ['GS-CO-09', 'chain-edit', 'admin:cchain.edit'],
    ['GS-CO-15', 'invalid-method-call', 'api:!invalidmethodcall'],
    ['GS-ID-08', 'new', 'admin:cwebservice.edit'],
    ['GS-PS-04', 'public-reload', 'reload:application'],
  ])('keys a %s %s request as %s', (scenario, step, key) => {
    expect(keyed.filter((r) => r.scenario === scenario && r.step === step).map((r) => r.key)).toContain(key);
  });
});
