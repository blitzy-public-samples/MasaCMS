// The one step runner capture (legacy), replay (gateway) and the workload share, so both origins see the same requests.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import { load } from 'cheerio';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  LEGACY_ERROR_MAP,
  routeKeyForRequest,
  type RouteKeyOptions,
  type RouteKeyRequest,
} from '@opt2/platform/legacy-compat';
import type { Extraction, MultipartSpec, PollSpec, Scenario, SettleSpec, Step, StepExpectation } from './catalogue.js';
import { GoldenConfigError } from './errors.js';
import {
  DEFAULT_SITE,
  appReloadKey,
  basicAuth,
  fetchFormTokens,
  jsonApiTokens,
  loginSessions,
  resolvePlaceholders,
  secretValues,
  session,
  type FormTokens,
  type ScenarioContext,
} from './session.js';
import {
  createHttpSession,
  type FetchLike,
  type HttpHop,
  type HttpRequest,
  type HttpResult,
  type HttpSession,
  type MultipartFile,
} from '../lib/http.js';

/** Form or multipart field values as sent. */
export type FieldValues = Record<string, string | string[]>;

/** A multipart file part, recorded by digest, never by bytes. */
export interface RecordedFile {
  field: string;
  filename: string;
  contentType: string;
  sha256: string;
  size: number;
}

/** Body of a recorded request. */
export type RecordedBody =
  | { kind: 'none' }
  | { kind: 'form'; value: FieldValues }
  | { kind: 'json'; value: unknown }
  | { kind: 'multipart'; value: { fields: FieldValues; files: RecordedFile[] } };

/** The request a step sent: origin-relative URL, the headers the step set plus Content-Type, and its body. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: RecordedBody;
}

/** Text or base64 form of a response body. */
export type BodyRepresentation = { text: string } | { bytesBase64: string };

/** A response as recorded: lower-cased headers (`set-cookie` an array), body as text or base64, and every hop. */
export type RecordedResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  contentType: string;
  sha256: string;
  hops: HttpHop[];
} & BodyRepresentation;

/** A candidate search that found no response legacy answers with the trigger it looks for. */
export interface StepGap {
  reason: string;
  candidatesTried: number;
}

/** One exchange of a step (one per matrix combination), secrets redacted. */
export interface StepRecord {
  name: string;
  index: number;
  matrixKey?: string;
  routeKey: string;
  request: RecordedRequest;
  response: RecordedResponse;
  /** Bindings this exchange extracted, by binding name. */
  extracted: Record<string, unknown>;
  /** Index into the step's `candidates` of the request sent. */
  candidateIndex?: number;
  expected?: StepExpectation;
  decisionListRef?: string;
  exceptionId?: string;
  gap?: StepGap;
}

/** Waits for a declared side effect: `spec` is the step's `settle`, `timeoutMs` its bound. */
export type SettleHook = (spec: SettleSpec, timeoutMs: number) => Promise<void>;

/** Candidate to re-send on replay: one index for every record, or one per step name and matrix key. */
export type CandidateChoice = number | ((step: string, matrixKey: string | undefined) => number | undefined);

/** Options of {@link runStep}. */
export interface StepRunOptions {
  /** `capture` searches a step's `candidates`; `replay` sends only the chosen one. */
  mode: 'capture' | 'replay';
  /** Position of the step in its scenario, stamped on its records (default 0). */
  index?: number;
  settle?: SettleHook;
  /** Replay: candidate the golden set kept; without one the step's own request is sent. */
  candidateIndex?: CandidateChoice;
  /** Legacy registries for route keys, such as the inventory's variants; the reload key defaults from the env. */
  routeKeyOptions?: RouteKeyOptions;
  /** Fetch for the fresh session of an `anonymous` step; pass the one the context was built with. */
  fetch?: FetchLike;
}

/** What {@link ScenarioRunOptions.onBeforeStep} asks for: run the step (void), leave it out, or end the run. */
export type BeforeStepAction = void | 'skip' | 'stop';

/** Options of {@link runScenarioSteps}. */
export interface ScenarioRunOptions extends Omit<StepRunOptions, 'index'> {
  /** Log the declared sessions in first (default true); false for a context whose jars were restored. */
  login?: boolean;
  onBeforeStep?: (index: number, step: Step) => BeforeStepAction | Promise<BeforeStepAction>;
}

/** Scenario fields a step needs: its id and the steps `csrfFrom` names. */
export type StepScenario = Pick<Scenario, 'id' | 'steps'>;

/** Gap reason recorded when no candidate triggers the expected legacy response. */
export const GAP_REASON = 'no deterministic legacy trigger';

/** Bound handed to the settle hook; the catalogue's `settle` declares no timeout of its own. */
export const SETTLE_TIMEOUT_MS = 60_000;

const SECRET_MASK = '<secret>';
const BASIC_CREDENTIALS = /\b(Basic\s+)([A-Za-z0-9+/]+={0,2})/gi;
const JSON_API_SITE = /^\/(?:index\.cfm\/)?_api\/(?:json|ajax|rest)\/v1\/([^/]+)/i;
const SERVER_ERROR = LEGACY_ERROR_MAP.server_error;

type RequestShape = Pick<Step, 'method' | 'route' | 'headers' | 'form' | 'body'> & { multipart?: MultipartSpec };

interface Found {
  found: boolean;
  value?: unknown;
}

const MISSING: Found = { found: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Plain, URL-encoded (component, form, and as a URL's query or path holds it) and JSON-escaped forms of `secret`. */
function secretForms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const formEncoded = new URLSearchParams({ v: secret }).toString().slice('v='.length);
  const inQuery = new URL(`http://secret.invalid/?${secret}`);
  const inPath = new URL(`http://secret.invalid/${secret}`);
  return [
    secret,
    encodeURIComponent(secret),
    formEncoded,
    `${inQuery.search.slice(1)}${inQuery.hash}`,
    inPath.pathname.slice(1),
    json,
    json.replaceAll('/', '\\/'),
  ];
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [fn(key), mapStrings(item, fn)]));
  }
  return value;
}

/**
 * Copy of `value`, object keys included, with every occurrence of each secret in any form {@link secretForms} lists
 * replaced by `<secret>`; a `Basic` credential whose decoded form holds one becomes `Basic <secret>`.
 */
export function redact<T>(value: T, secrets: readonly string[]): T {
  const forms = [...new Set(secrets.filter((secret) => secret !== '').flatMap(secretForms))]
    .filter((form) => form !== '')
    .sort((a, b) => b.length - a.length);
  if (forms.length === 0) return value;
  const mask = (text: string): string => {
    const basic = text.replace(BASIC_CREDENTIALS, (match: string, prefix: string, encoded: string) => {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      return forms.some((form) => decoded.includes(form)) ? `${prefix}${SECRET_MASK}` : match;
    });
    return forms.reduce((out, form) => out.replaceAll(form, SECRET_MASK), basic);
  };
  return mapStrings(value, mask) as T;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Text for text/*, JSON, XML, JavaScript and form-encoded bodies (and untyped UTF-8); base64 for everything else. */
export function bodyRepresentation(result: Pick<HttpResult, 'headers' | 'bytes' | 'text'>): BodyRepresentation {
  const media = (headerText(result.headers['content-type']) ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const textual =
    media.startsWith('text/') ||
    /^(?:application\/(?:json|xml)|[\w.-]+\/[\w.-]+\+(?:json|xml))$/.test(media) ||
    ['application/javascript', 'application/ecmascript', 'application/x-www-form-urlencoded'].includes(media) ||
    (media === '' && isStrictUtf8(result.bytes));
  return textual ? { text: result.text } : { bytesBase64: Buffer.from(result.bytes).toString('base64') };
}

// Catalogue fixtures are generated rather than committed as binaries. Stored (uncompressed) deflate keeps the PNG's
// bytes independent of the zlib version, so a golden set's file digests hold on every host that replays it.
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png8x8(): Buffer {
  const size = 8;
  const rows: number[] = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(0);
    for (let x = 0; x < size; x += 1) rows.push(x * 32, y * 32, 128);
  }
  const raw = Buffer.from(rows);
  const block = Buffer.alloc(5);
  block[0] = 1;
  block.writeUInt16LE(raw.length, 1);
  block.writeUInt16LE(~raw.length & 0xffff, 3);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(raw));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', Buffer.concat([Buffer.from([0x78, 0x01]), block, raw, checksum])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function onePagePdf(): Buffer {
  const content = 'BT /F1 12 Tf 72 720 Td (OPT-2 golden fixture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const FIXTURE_FILES: Readonly<Record<string, () => Buffer>> = {
  'image-png-8x8': png8x8,
  'pdf-one-page': onePagePdf,
};

/** Bytes of catalogue file fixture `fixture`; throws GoldenConfigError for an unknown id. */
export function fixtureBytes(fixture: string): Uint8Array {
  const make = Object.hasOwn(FIXTURE_FILES, fixture) ? FIXTURE_FILES[fixture] : undefined;
  if (make === undefined) {
    throw new GoldenConfigError(`unknown file fixture ${fixture}; known: ${Object.keys(FIXTURE_FILES).join(', ')}`);
  }
  return new Uint8Array(make());
}

/** A step's body with its placeholders resolved and its file fixtures loaded. */
type ResolvedBody =
  | { kind: 'none' }
  | { kind: 'form'; fields: FieldValues }
  | { kind: 'json'; value: unknown }
  | { kind: 'multipart'; fields: FieldValues; files: MultipartFile[] };

/** One request as sent, with what the record and route key are built from. */
interface Exchange {
  result: HttpResult;
  request: RecordedRequest;
  routeKey: string;
}

interface RecordMeta {
  index: number;
  matrixKey?: string;
  candidateIndex?: number;
  gap?: StepGap;
}

function stepError(ctx: ScenarioContext, step: Pick<Step, 'name'>, message: string): GoldenConfigError {
  return new GoldenConfigError(redact(`${ctx.scenarioId} step ${step.name}: ${message}`, secretValues(ctx)));
}

function resolvedText(ctx: ScenarioContext, step: Pick<Step, 'name'>, template: string, what: string): string {
  const value = resolvePlaceholders(template, ctx);
  if (typeof value !== 'string') throw stepError(ctx, step, `${what} does not resolve to a string`);
  return value;
}

/** Sent form of a resolved value: strings as they are, null as '', objects as JSON, other scalars by String. */
function fieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function fieldValues(value: unknown): FieldValues {
  const out: FieldValues = {};
  for (const [name, item] of Object.entries(isPlainObject(value) ? value : {})) {
    out[name] = Array.isArray(item) ? item.map(fieldText) : fieldText(item);
  }
  return out;
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** `explicit` over `base`; CFML scopes are case-insensitive, so a base name matching an explicit one is dropped. */
function mergeFields(base: FieldValues, explicit: Record<string, unknown>): Record<string, unknown> {
  const overridden = new Set(Object.keys(explicit).map((name) => name.toLowerCase()));
  const kept = Object.entries(base).filter(([name]) => !overridden.has(name.toLowerCase()));
  return { ...Object.fromEntries(kept), ...explicit };
}

function resolveBody(ctx: ScenarioContext, shape: RequestShape): ResolvedBody {
  if (shape.form !== undefined) return { kind: 'form', fields: fieldValues(resolvePlaceholders(shape.form, ctx)) };
  if (shape.body !== undefined) return { kind: 'json', value: resolvePlaceholders(shape.body, ctx) };
  if (shape.multipart === undefined) return { kind: 'none' };
  const spec = resolvePlaceholders(shape.multipart, ctx);
  return {
    kind: 'multipart',
    fields: fieldValues(spec.fields),
    files: spec.files.map((file) => ({
      name: fieldText(file.field),
      filename: fieldText(file.filename),
      contentType: fieldText(file.contentType),
      data: fixtureBytes(fieldText(file.fixture)),
    })),
  };
}

/** `body` with a form's CSRF pair and hidden fields beneath its explicit fields. */
function withFormTokens(ctx: ScenarioContext, step: Step, body: ResolvedBody, tokens: FormTokens): ResolvedBody {
  const base: FieldValues = { ...tokens.fields, [CSRF_FIELD_TOKEN]: tokens.token, [CSRF_FIELD_EXPIRES]: tokens.expires };
  switch (body.kind) {
    case 'none':
      return { kind: 'form', fields: base };
    case 'form':
      return { kind: 'form', fields: fieldValues(mergeFields(base, body.fields)) };
    case 'multipart':
      return { ...body, fields: fieldValues(mergeFields(base, body.fields)) };
    case 'json':
      if (!isPlainObject(body.value)) throw stepError(ctx, step, 'csrf fetch-form needs a form, multipart or object body');
      return { kind: 'json', value: mergeFields(base, body.value) };
  }
}

/** Page whose form supplies a `fetch-form` step's tokens: the `csrfFrom` step's route, else the step's own. */
function formSource(ctx: ScenarioContext, scenario: StepScenario, step: Step, route: string): string {
  if (step.csrfFrom === undefined) return route;
  const source = scenario.steps.find((candidate) => candidate.name === step.csrfFrom);
  if (source === undefined) throw stepError(ctx, step, `csrfFrom ${step.csrfFrom} names no step`);
  return resolvedText(ctx, source, source.route, 'route');
}

function paramNoCase(params: URLSearchParams, name: string): string | undefined {
  const exact = params.get(name);
  if (exact !== null) return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of params) if (key.toLowerCase() === lower) return value;
  return undefined;
}

/** Site a `json-api:` step asks for tokens on: its JSON API path segment, else its `siteid` parameter, else default. */
function csrfSite(route: string, body: ResolvedBody): string {
  const url = new URL(route, 'http://route.invalid');
  const segment = JSON_API_SITE.exec(url.pathname)?.[1];
  if (segment !== undefined) return decodeURIComponent(segment);
  const fromQuery = paramNoCase(url.searchParams, 'siteid');
  if (fromQuery !== undefined && fromQuery !== '') return fromQuery;
  const fields = body.kind === 'form' || body.kind === 'multipart' ? body.fields : body.kind === 'json' ? body.value : {};
  const record = isPlainObject(fields) ? fields : {};
  const key = Object.keys(record).find((name) => name.toLowerCase() === 'siteid');
  const value = key === undefined ? undefined : record[key];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && text !== '' ? text : DEFAULT_SITE;
}

// The catalogue's AuthMode has no OAuth form: a client_credentials token is an explicit step bound into `bearer:`.
/** `Authorization` a resolved `basic:<user>:<secret>` or `bearer:<token>` mode sends; none for the other modes. */
function authHeaders(auth: string): Record<string, string> {
  if (auth.startsWith('basic:')) {
    const credentials = auth.slice('basic:'.length);
    const colon = credentials.indexOf(':');
    return { authorization: basicAuth(credentials.slice(0, colon), credentials.slice(colon + 1)) };
  }
  return auth.startsWith('bearer:') ? { authorization: `Bearer ${auth.slice('bearer:'.length)}` } : {};
}

function stepSession(ctx: ScenarioContext, step: Step, auth: string, opts: StepRunOptions): HttpSession {
  // An anonymous request starts from an empty jar, so no cookie the scenario's sessions hold reaches it.
  if (auth === 'anonymous') return createHttpSession({ baseUrl: ctx.baseUrl, fetch: opts.fetch });
  return session(ctx, step.as === undefined ? undefined : resolvedText(ctx, step, step.as, 'as'));
}

function requestBody(body: ResolvedBody): Pick<HttpRequest, 'form' | 'json' | 'multipart'> {
  switch (body.kind) {
    case 'none':
      return {};
    case 'form':
      return { form: body.fields };
    case 'json':
      return { json: body.value };
    case 'multipart':
      return { multipart: { fields: body.fields, files: body.files } };
  }
}

function recordedBody(body: ResolvedBody): RecordedBody {
  switch (body.kind) {
    case 'none':
      return { kind: 'none' };
    case 'form':
      return { kind: 'form', value: body.fields };
    case 'json':
      return { kind: 'json', value: body.value };
    case 'multipart':
      return {
        kind: 'multipart',
        value: {
          fields: body.fields,
          files: body.files.map((file) => ({
            field: file.name,
            filename: file.filename,
            contentType: file.contentType,
            sha256: sha256Hex(file.data),
            size: file.data.length,
          })),
        },
      };
  }
}

/** Query scope as the gateway builds it: a repeated name maps to its values in order. */
function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>();
  for (const [name, value] of params) {
    const previous = query.get(name);
    query.set(name, previous === undefined ? value : [previous, value].flat());
  }
  return Object.fromEntries(query);
}

function routeKeyOf(ctx: ScenarioContext, request: RecordedRequest, body: ResolvedBody, opts: StepRunOptions): string {
  const url = new URL(request.url, 'http://route.invalid');
  const input: RouteKeyRequest = {
    method: request.method,
    path: url.pathname,
    query: queryOf(url.searchParams),
    headers: { ...request.headers },
  };
  if (body.kind === 'form' || body.kind === 'multipart') input.form = body.fields;
  if (body.kind === 'multipart') {
    input.multipartFileNames = body.files.map((file) => ({ field: file.name, filename: file.filename }));
  }
  if (body.kind === 'json') input.jsonBody = body.value;
  return routeKeyForRequest(input, { appReloadKey: appReloadKey(ctx.env), ...opts.routeKeyOptions }).key;
}

/** Sends `shape` once in the step's session, with the step's auth and freshly fetched CSRF tokens. */
async function exchange(
  ctx: ScenarioContext,
  scenario: StepScenario,
  step: Step,
  shape: RequestShape,
  opts: StepRunOptions,
): Promise<Exchange> {
  const route = resolvedText(ctx, step, shape.route, 'route');
  const auth = step.auth === undefined ? 'session' : resolvedText(ctx, step, step.auth, 'auth');
  const s = stepSession(ctx, step, auth, opts);
  const headers: Record<string, string> = authHeaders(auth);
  let body = resolveBody(ctx, shape);
  const csrf = resolvedText(ctx, step, step.csrf, 'csrf');
  if (csrf === 'fetch-form') {
    body = withFormTokens(ctx, step, body, await fetchFormTokens(s, formSource(ctx, scenario, step, route)));
  } else if (csrf.startsWith('json-api:')) {
    const tokens = await jsonApiTokens(s, csrfSite(route, body), csrf.slice('json-api:'.length));
    Object.assign(headers, lowerKeys(tokens));
  }
  for (const [name, value] of Object.entries(resolvePlaceholders(shape.headers ?? {}, ctx))) {
    headers[name.toLowerCase()] = fieldText(value);
  }

  const method = shape.method.toUpperCase();
  const result = await s.request({ method, path: route, headers, ...requestBody(body) });
  const first = result.hops[0];
  const sentUrl = new URL(first?.url ?? new URL(route, s.baseUrl).href);
  const sentHeaders = first?.requestHeaders ?? headers;
  const recorded: Record<string, string> = {};
  for (const name of [...Object.keys(headers), 'content-type']) {
    const value = sentHeaders[name];
    if (value !== undefined) recorded[name] = value;
  }
  const request: RecordedRequest = {
    method: first?.method ?? method,
    url: `${sentUrl.pathname}${sentUrl.search}`,
    headers: recorded,
    body: recordedBody(body),
  };
  return { result, request, routeKey: routeKeyOf(ctx, request, body, opts) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Value at dotted `path` (`data.items[0].id`); keys match exactly, then case-insensitively (ACF upper-cases keys). */
function valueAt(root: unknown, path: string): Found {
  let current = root;
  for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) return MISSING;
      current = current[Number(segment)];
      continue;
    }
    if (!isPlainObject(current)) return MISSING;
    const lower = segment.toLowerCase();
    const key = Object.hasOwn(current, segment)
      ? segment
      : Object.keys(current).find((name) => name.toLowerCase() === lower);
    if (key === undefined) return MISSING;
    current = current[key];
  }
  return { found: true, value: current };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function pollSatisfied(result: HttpResult, poll: PollSpec): boolean {
  const { found, value } = valueAt(parseJson(result.text), poll.until.path);
  return found && isScalar(value) && String(value) === String(poll.until.equals);
}

/** Sends `shape`, repeating every `poll.intervalMs` until its condition holds; throws GoldenConfigError past the bound. */
async function send(
  ctx: ScenarioContext,
  scenario: StepScenario,
  step: Step,
  shape: RequestShape,
  opts: StepRunOptions,
): Promise<Exchange> {
  const { poll } = step;
  if (poll === undefined) return exchange(ctx, scenario, step, shape, opts);
  const deadline = Date.now() + poll.timeoutMs;
  for (;;) {
    const sent = await exchange(ctx, scenario, step, shape, opts);
    if (pollSatisfied(sent.result, poll)) return sent;
    if (Date.now() + poll.intervalMs > deadline) {
      throw stepError(
        ctx,
        step,
        `poll ${poll.until.path} did not equal ${String(poll.until.equals)} within ${poll.timeoutMs} ms ` +
          `(last status ${sent.result.status})`,
      );
    }
    await delay(poll.intervalMs);
  }
}

/** Query parameter `param` of `raw` resolved against `base`, matched exactly, then case-insensitively. */
function urlParam(raw: string, base: string, param: string): string | undefined {
  return URL.canParse(raw, base) ? paramNoCase(new URL(raw, base).searchParams, param) : undefined;
}

function extractBinding(
  ctx: ScenarioContext,
  step: Step,
  binding: string,
  result: HttpResult,
  extraction: Extraction,
): unknown {
  const fail = (why: string): GoldenConfigError =>
    stepError(ctx, step, `binding ${binding}: ${why} (status ${result.status})`);
  const withParam = (raw: string, param: string | undefined, base: string): string => {
    if (param === undefined) return raw;
    const value = urlParam(raw, base, param);
    if (value === undefined) throw fail(`no ${param} parameter in the extracted URL`);
    return value;
  };
  if (extraction.from === 'body') {
    const { found, value } = valueAt(parseJson(result.text), extraction.path);
    if (!found) throw fail(`no ${extraction.path} in the response body`);
    return value;
  }
  if (extraction.from === 'dom') {
    const element = load(result.text)(extraction.selector).first();
    if (element.length === 0) throw fail(`no element matches ${extraction.selector}`);
    const raw = extraction.attr === undefined ? element.text().trim() : element.attr(extraction.attr);
    if (raw === undefined) throw fail(`${extraction.selector} has no ${extraction.attr ?? ''} attribute`);
    return withParam(raw, extraction.param, result.url);
  }
  if (extraction.from === 'location-query') {
    for (const hop of result.hops) {
      const value = hop.location === undefined ? undefined : urlParam(hop.location, hop.url, extraction.param);
      if (value !== undefined) return value;
    }
    throw fail(`no redirect Location carries ${extraction.param}`);
  }
  const name = extraction.from.slice('header:'.length).toLowerCase();
  const value = headerText(result.headers[name]);
  if (value === undefined) throw fail(`no ${name} response header`);
  return withParam(value, extraction.param, result.url);
}

function recordResponse(result: HttpResult): RecordedResponse {
  return {
    status: result.status,
    headers: result.headers,
    contentType: headerText(result.headers['content-type']) ?? '',
    sha256: sha256Hex(result.bytes),
    hops: result.hops,
    ...bodyRepresentation(result),
  };
}

/** Settles, extracts the step's bindings into `ctx.bindings` and builds its redacted record. */
async function finish(
  ctx: ScenarioContext,
  step: Step,
  sent: Exchange,
  opts: StepRunOptions,
  meta: RecordMeta,
): Promise<StepRecord> {
  if (step.settle !== undefined) await opts.settle?.(step.settle, SETTLE_TIMEOUT_MS);
  const extracted: Record<string, unknown> = {};
  for (const [binding, extraction] of Object.entries(step.extract ?? {})) {
    const value = extractBinding(ctx, step, binding, sent.result, extraction);
    extracted[binding] = value;
    ctx.bindings.set(`${step.name}.${binding}`, value);
  }
  const record: StepRecord = {
    name: step.name,
    index: meta.index,
    routeKey: sent.routeKey,
    request: sent.request,
    response: recordResponse(sent.result),
    extracted,
  };
  if (meta.matrixKey !== undefined) record.matrixKey = meta.matrixKey;
  if (meta.candidateIndex !== undefined) record.candidateIndex = meta.candidateIndex;
  if (step.expected !== undefined) record.expected = step.expected;
  if (step.decisionListRef !== undefined) record.decisionListRef = step.decisionListRef;
  if (step.exceptionId !== undefined) record.exceptionId = step.exceptionId;
  if (meta.gap !== undefined) record.gap = meta.gap;
  return redact(record, secretValues(ctx));
}

/** Whether legacy answered with the JSON API `server_error` envelope, the trigger a step's candidates search for. */
function isServerError(result: HttpResult): boolean {
  const { found, value } = valueAt(parseJson(result.text), 'error.code');
  return result.status === SERVER_ERROR.status && found && value === SERVER_ERROR.code;
}

async function runCombination(
  ctx: ScenarioContext,
  scenario: StepScenario,
  step: Step,
  opts: StepRunOptions,
  matrixKey: string | undefined,
): Promise<StepRecord> {
  const meta: RecordMeta = { index: opts.index ?? 0, ...(matrixKey === undefined ? {} : { matrixKey }) };
  const { candidates } = step;
  if (candidates === undefined) return finish(ctx, step, await send(ctx, scenario, step, step, opts), opts, meta);
  if (opts.mode === 'capture') {
    let last: { sent: Exchange; candidateIndex: number } | undefined;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const sent = await send(ctx, scenario, step, candidate, opts);
      if (isServerError(sent.result)) return finish(ctx, step, sent, opts, { ...meta, candidateIndex });
      last = { sent, candidateIndex };
    }
    if (last === undefined) throw stepError(ctx, step, 'candidates is empty');
    const gap: StepGap = { reason: GAP_REASON, candidatesTried: candidates.length };
    return finish(ctx, step, last.sent, opts, { ...meta, candidateIndex: last.candidateIndex, gap });
  }
  const choice = opts.candidateIndex;
  const chosen = typeof choice === 'function' ? choice(step.name, matrixKey) : choice;
  if (chosen === undefined) return finish(ctx, step, await send(ctx, scenario, step, step, opts), opts, meta);
  const candidate = candidates[chosen];
  if (candidate === undefined) throw stepError(ctx, step, `has no candidate ${chosen}`);
  return finish(ctx, step, await send(ctx, scenario, step, candidate, opts), opts, { ...meta, candidateIndex: chosen });
}

/** Combinations of a step matrix, first declared name varying slowest; one empty combination without a matrix. */
function combinations(matrix: Step['matrix']): Record<string, string>[] {
  return Object.entries(matrix ?? {}).reduce<Record<string, string>[]>(
    (acc, [name, values]) => acc.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value }))),
    [{}],
  );
}

/**
 * Runs `step` once per matrix combination (`${matrix.<name>}` bound to that combination's resolved values) and
 * returns one redacted record each. With `candidates`, capture keeps the first candidate legacy answers with
 * `server_error` (else the last, marked `gap`); replay sends only the chosen candidate.
 */
export async function runStep(
  ctx: ScenarioContext,
  scenario: StepScenario,
  step: Step,
  opts: StepRunOptions,
): Promise<StepRecord[]> {
  const records: StepRecord[] = [];
  for (const combo of combinations(step.matrix)) {
    const entries = Object.entries(combo);
    // Declared, unresolved values, so a capture record and its replay pair even where bound ids differ by origin.
    const matrixKey =
      step.matrix === undefined ? undefined : entries.map(([name, value]) => `${name}=${value}`).join(',');
    try {
      for (const [name, value] of entries) ctx.bindings.set(`matrix.${name}`, value);
      // Matrix values may hold placeholders of their own (`${seed.page.contentID}`), resolved per combination.
      for (const [name, value] of entries) ctx.bindings.set(`matrix.${name}`, resolvePlaceholders(value, ctx));
      records.push(await runCombination(ctx, scenario, step, opts, matrixKey));
    } finally {
      for (const [name] of entries) ctx.bindings.delete(`matrix.${name}`);
    }
  }
  return records;
}

/**
 * Logs the scenario's sessions in (unless `login: false`), then runs its steps in catalogue order and returns
 * every record, redacted with the secrets resolved by the end. The first error propagates unchanged.
 */
export async function runScenarioSteps(
  ctx: ScenarioContext,
  scenario: StepScenario & Partial<Pick<Scenario, 'sessions'>>,
  opts: ScenarioRunOptions,
): Promise<StepRecord[]> {
  const { login = true, onBeforeStep, ...stepOpts } = opts;
  if (login) await loginSessions(ctx, scenario);
  const records: StepRecord[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const action = await onBeforeStep?.(index, step);
    if (action === 'stop') break;
    if (action === 'skip') continue;
    records.push(...(await runStep(ctx, scenario, step, { ...stepOpts, index })));
  }
  return redact(records, secretValues(ctx));
}
