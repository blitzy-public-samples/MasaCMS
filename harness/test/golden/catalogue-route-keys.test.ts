import {
  esapiUrlEncode,
  matchRouteKey,
  type RouteKeyOptions,
  type RouteKeyRequest,
} from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, type Step } from '../../src/golden/catalogue.js';
import { defaultRouteKeyOptions } from '../../src/golden/route-key-options.js';
import { basicAuth } from '../../src/golden/session.js';
import { inventoryRouteKeyForRequest } from '../../src/inventory/route-keys.js';

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
  const options: RouteKeyOptions = defaultRouteKeyOptions();
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
    ['GS-CO-08', 'sort', 'admin:carch.list'],
    ['GS-CO-08', 'sort-home', 'admin:carch.list{sharedid}'],
    ['GS-CO-09', 'pending-version', 'api:content.findversionhistory'],
    ['GS-CO-09', 'chain-edit', 'admin:cchain.edit'],
    ['GS-CO-09', 'approve', 'admin:carch.approvalaction{action=approve}'],
    ['GS-CO-09', 'reject', 'admin:carch.approvalaction'],
    ['GS-CO-09', 'delete-page-tokens', 'api:generatecsrftokens'],
    ['GS-CO-09', 'delete-page', 'admin:carch.update'],
    ['GS-CO-14', 'response-form', 'admin:carch.datamanager'],
    ['GS-CO-14', 'response-update', 'admin:carch.datamanager'],
    ['GS-CO-14', 'form-object-params', 'admin:carch.updateobjectparams'],
    ['GS-CO-14', 'draft-version', 'api:content.findone'],
    ['GS-CO-20', 'comments', 'api:comment.findquery'],
    ['GS-CO-20', 'comments-page', 'admin:ccomments.loadcommentspage'],
    ['GS-CO-20', 'proxy-page', 'cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=rendercommentspage'],
    ['GS-CO-20', 'approve', 'admin:ccomments.approve'],
    ['GS-CO-20', 'approved', 'api:comment.findone'],
    ['GS-CO-20', 'unapprove', 'admin:ccomments.singleedit'],
    ['GS-CO-20', 'visitor-comment', 'api:comment.save'],
    ['GS-CO-20', 'visitor-rename', 'api:comment.save'],
    ['GS-CO-20', 'visitor-delete', 'admin:ccomments.bulkedit'],
    ['GS-CO-20', 'purge', 'admin:ccomments.purgedeletedcomments'],
    ['GS-CO-15', 'invalid-method-call', 'api:!invalidmethodcall'],
    ['GS-CO-15', 'bearer', 'rest:content.findone'],
    ['GS-CO-15', 'forbidden-validation-errors', 'api:content.save'],
    ['GS-CO-15', 'not-found-path', 'api:content.findone'],
    ['GS-ID-08', 'new', 'admin:cwebservice.edit'],
    ['GS-ID-08', 'rest-read', 'rest:content.findall'],
    ['GS-ID-08', 'tokeninfo', 'rest:tokeninfo'],
    ['GS-PS-04', 'public-reload', 'reload:application'],
  ])('keys a %s %s request as %s', (scenario, step, key) => {
    expect(keyed.filter((r) => r.scenario === scenario && r.step === step).map((r) => r.key)).toContain(key);
  });
});
