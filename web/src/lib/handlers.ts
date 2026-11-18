// Composition root of the admin entry points: authentication, request context, access gate, screen dispatch, session
// persistence and each response mode's legacy answer (server-only).
import { Readable } from 'node:stream';
import { LegacyFaultError, LegacyServiceUnavailableError, cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { requestIdFrom, systemClock } from '@opt2/platform/service-kit';
import {
  findOpt2Action,
  findOpt2Screen,
  findScreen,
  shellHooks,
  type PageRedirect,
  type RawBody,
  type ScreenContext,
  type SubmitResult,
  type UploadPart,
} from '../screens/registry';
import {
  loadShellData,
  renderAdminDocument,
  serializeAdminDocument,
  type AdminDocument,
  type ShellView,
} from '../shell/document';
import { applicationGate, deniedGate, runGate, type ScreenGate } from './access-gate';
import { WebAuthError, authenticateRequest, type WebAuth } from './auth';
import { createCsrfRenderer } from './csrf';
import {
  GatewayDenialError,
  createGatewayClient,
  discardStreamed,
  streamedCallOf,
  type StreamedCall,
} from './gateway-client';
import { isSafeHtml, toString as markupOf } from './html';
import {
  assignContext,
  buildAdminRequest,
  saveSessionWrites,
  type AdminMode,
  type AdminRequest,
  type AdminRequestInput,
  type AdminSessionWrites,
  type RequestContext,
} from './request-context';
import { receiveRequestBody, type ReceivedBody } from './request-body';
import { adminRbFor } from './resource-bundles/rb';
import {
  downloadResponse,
  fw1Redirect,
  htmlResponse,
  jsonResponse,
  legacyError,
  legacyUnavailable,
  notFound,
  withSetCookies,
  type DownloadSource,
  type LegacyResponseContext,
} from './responses';
import {
  headersToRecord,
  logRequest,
  logTransferEnd,
  markPipelineRequest,
  withRequestSpan,
  type TransferEnd,
  type TransferLogFields,
} from './telemetry';
import { fw1RedirectTarget } from './urls';

/** Path params of the admin trees: the route key's circuit and action. */
export interface AdminRouteParams {
  readonly circuit: string;
  readonly action: string;
}

/** Path params of a synthetic-module screen. */
export interface Opt2ScreenParams {
  readonly module: string;
  readonly screen: string;
}

/** Path params of a synthetic-module post action. */
export interface Opt2ActionParams {
  readonly module: string;
  readonly action: string;
}

/** FW/1 `maxNumContextsPreserved` of the admin. */
const MAX_PRESERVED_CONTEXTS = 10;

/** How one entry point answers each pipeline outcome. */
interface Answers<T> {
  redirect(location: string, setCookies: readonly string[], context: LegacyResponseContext): T;
  notFound(context: LegacyResponseContext): T;
  unavailable(context: LegacyResponseContext): T;
  /** Legacy's answer to a runtime error, for a failure the pipeline maps to no other answer; `fault` when web reproduces it. */
  error(context: LegacyResponseContext, fault?: LegacyFaultError): T;
  refused(status: 401 | 403): T;
  /** Status the request is logged with. */
  statusOf(answer: T): number;
  /** Releases an answer that will not be sent, ending any service stream it relays. */
  abandon(answer: T): void;
  /** Sends `answer` on its way: a service stream it relays reports an early end through `report`. */
  handOver(answer: T, report: TransferReport): void;
}

/** A relayed stream's early end, when it was observed and the service call the stream answers. */
interface EndedTransfer {
  readonly end: TransferEnd;
  readonly at: number;
  readonly callee: StreamedCall | undefined;
}

type TransferReport = (ended: EndedTransfer) => void;

/** One relayed stream's transfer: its first early end is reported once, and only after its answer was handed over. */
class Transfer {
  private ended: EndedTransfer | undefined;
  private report: TransferReport | undefined;

  constructor(private readonly callee: StreamedCall | undefined) {}

  end(end: TransferEnd): void {
    if (this.ended !== undefined) return;
    this.ended = { end, at: performance.now(), callee: this.callee };
    this.report?.(this.ended);
  }

  handOver(report: TransferReport): void {
    this.report = report;
    if (this.ended !== undefined) report(this.ended);
  }
}

/** The transfer of each response body {@link responseStreamOf} builds. */
const transfers = new WeakMap<ReadableStream<Uint8Array>, Transfer>();

const RESPONSE_ANSWERS: Answers<Response> = {
  redirect: (location, setCookies, context) => fw1Redirect(location, { setCookies, context }),
  notFound: (context) => notFound(context),
  unavailable: (context) => legacyUnavailable(context),
  error: (context, fault) => legacyError(context, fault),
  refused: (status) => new Response(null, { status }),
  statusOf: (response) => response.status,
  // Never handed out, so its body is unlocked. A body whose upstream already failed rejects the cancellation with that
  // failure, which its transfer recorded and an abandoned answer never reports.
  abandon: (response) => void response.body?.cancel().catch(() => undefined),
  handOver: (response, report) => {
    if (response.body !== null) transfers.get(response.body)?.handOver(report);
  },
};

/** One admin request as an entry point received it. */
interface PipelineRequest {
  readonly mode: AdminMode;
  /** Logged and handed to the request context; OPT-2 routes give their module and screen or action. */
  readonly route: AdminRouteParams;
  readonly method: string;
  readonly path: string;
  /** The query as received, `?` included; `''` without one. */
  readonly search: string;
  readonly headers: Headers;
  readonly searchParams: AdminRequestInput['searchParams'];
  /** The request whose body is the form scope; absent on the synthetic-module screens, which read none. */
  readonly bodySource?: Request;
}

/** An answer, plus session values it adds to the request set-up's writes. */
interface Outcome<T> {
  readonly answer: T;
  readonly writes?: AdminSessionWrites;
}

/** A resolved screen: its gate and how it answers once the gate lets the request through. */
interface Dispatch<T> {
  readonly gate?: ScreenGate;
  run(ctx: ScreenContext, context: LegacyResponseContext): Promise<Outcome<T>>;
}

/** Looks up the screen serving the built request; undefined answers not-found. */
type Resolve<T> = (req: AdminRequest, uploads: readonly UploadPart[]) => Dispatch<T> | undefined;

/** File parts of a form scope, as the registry's upload variants read them. */
function uploadsOf(form: FormData | URLSearchParams): UploadPart[] {
  if (form instanceof URLSearchParams) return [];
  return [...form].flatMap(([field, value]) => (typeof value === 'string' ? [] : [{ field, filename: value.name }]));
}

/** The answer for a failed request, with the fixed reason of an expected refusal; an unmapped error gets legacy's 500. */
function answerFailure<T>(
  error: unknown,
  input: Pick<PipelineRequest, 'mode' | 'headers'>,
  answers: Answers<T>,
  context: LegacyResponseContext,
): { answer: T; denial?: string } {
  if (error instanceof LegacyServiceUnavailableError) return { answer: answers.unavailable(context) };
  if (error instanceof WebAuthError) return { answer: answers.refused(error.status), denial: error.reason };
  if (error instanceof GatewayDenialError) {
    const denied = deniedGate(error.status, { mode: input.mode, headers: input.headers });
    if (denied.kind === 'redirect') {
      return {
        answer: answers.redirect(denied.location, [], context),
        denial: `${error.service} answered ${error.status}`,
      };
    }
  }
  return { answer: answers.error(context, error instanceof LegacyFaultError ? error : undefined) };
}

/**
 * Authenticates, builds the request context, resolves and gates the screen, runs it, persists the session writes in
 * one identity call and writes the request's one log line in its span, then hands the answer over. Unavailability,
 * refused credentials and service denials become `answers` and persist nothing; any other error is logged and answered
 * with legacy's 500 error page, persisting nothing. A staged body is then removed.
 */
async function withAdminPipeline<T>(input: PipelineRequest, answers: Answers<T>, resolve: Resolve<T>): Promise<T> {
  markPipelineRequest();
  const started = performance.now();
  const route = `${input.mode}:${input.route.circuit}.${input.route.action}`.toLowerCase();
  const requestId = requestIdFrom(headersToRecord(input.headers));
  let context: LegacyResponseContext = { acceptEncoding: input.headers.get('accept-encoding') };
  let user: WebAuth['user'];
  let statusCode = 500;
  let failure: unknown;
  let denial: string | undefined;
  let logged = false;
  const lineFields = (endedAt: number): TransferLogFields => ({
    route,
    httpMethod: input.method,
    statusCode,
    latencyMs: Math.round(endedAt - started),
    requestId,
    userId: user?.sub || undefined,
    tenantId: user?.tid,
  });
  // Called in the request span, so the line carries its trace fields; again outside it only if the span never ran.
  const logOnce = (): void => {
    if (logged) return;
    logged = true;
    logRequest({ ...lineFields(performance.now()), denial, error: failure });
  };
  // The request's line reported the answer at handover; a relayed stream that ends early afterwards gets its own.
  const reportTransfer: TransferReport = ({ end, at, callee }) => logTransferEnd(lineFields(at), callee, end);
  const answerRequest = async (): Promise<T> => {
    let received: ReceivedBody | undefined;
    let outcome: Outcome<T> | undefined;
    try {
      const auth = await authenticateRequest(input.headers, input.path);
      user = auth.user;
      received = input.bodySource === undefined ? undefined : await receiveRequestBody(input.bodySource);
      const gateway = createGatewayClient({ userToken: auth.userToken, requestId, inbound: input.headers });
      const now = systemClock.now();
      const req = await buildAdminRequest({
        params: input.route,
        searchParams: input.searchParams,
        receivedTarget: `${input.path}${input.search}`,
        headers: input.headers,
        form: received?.form,
        auth,
        gateway,
        mode: input.mode,
        now,
      });
      // Read before the screen runs: its `mura` writes replace this object, which is the base identity stores them against.
      const storedMura = req.session.muraValues;
      context = {
        locale: req.session.locale,
        acceptEncoding: context.acceptEncoding,
        // The set-up echoes the Origin only past its no-site redirects (admin/Application.cfc:440-451,521-533).
        ...(applicationGate(req).kind === 'allow' ? { accessControl: req.accessControlHeaders } : {}),
      };
      const dispatch = resolve(req, received === undefined ? [] : uploadsOf(received.form));
      if (dispatch === undefined) return answers.notFound(context);
      const ctx: ScreenContext = {
        req,
        gateway,
        csrf: createCsrfRenderer(gateway),
        rb: adminRbFor(req.session.rb),
        hooks: shellHooks,
        now,
        body: received?.body,
      };
      const decision = await runGate(req, dispatch.gate);
      outcome =
        decision.kind === 'redirect'
          ? { answer: answers.redirect(decision.location, req.pendingSetCookies, context) }
          : await dispatch.run(ctx, context);
      // Read from the screen's request after it ran: a screen may record values on it or replace it with its own.
      await saveSessionWrites(gateway, auth, { ...ctx.req.sessionWrites, ...outcome.writes }, storedMura);
      return outcome.answer;
    } catch (error) {
      if (outcome !== undefined) answers.abandon(outcome.answer);
      const mapped = answerFailure(error, input, answers, context);
      if (mapped.denial === undefined) failure = error;
      else denial = mapped.denial;
      return mapped.answer;
    } finally {
      // The screen's relays have completed and the answer holds only service replies, never the staged body.
      await received?.dispose?.();
    }
  };
  try {
    const handedOver = await withRequestSpan(input.method, route, input.headers, async (recordStatus) => {
      try {
        const answer = await answerRequest();
        statusCode = answers.statusOf(answer);
        return answer;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        recordStatus(statusCode);
        logOnce();
      }
    });
    answers.handOver(handedOver, reportTransfer);
    return handedOver;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    logOnce();
  }
}

// ---- Screen outcomes ----

/** `Set-Cookie` values of a response: the request set-up's, then those the screen relays. */
function cookiesOf(req: AdminRequest, relayed: readonly string[] = []): string[] {
  return [...req.pendingSetCookies, ...relayed];
}

/** The legacy layout around `view`, with the shell data it reads. */
async function renderDocument(ctx: ScreenContext, view: ShellView): Promise<AdminDocument> {
  const data = await loadShellData(ctx.req, { gateway: ctx.gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
  return renderAdminDocument(ctx.req, view, ctx.hooks, data);
}

/** The serialized document with the layout's cache headers. */
function documentResponse(
  doc: AdminDocument,
  status: number,
  setCookies: readonly string[],
  context: LegacyResponseContext,
): Response {
  const response = htmlResponse(serializeAdminDocument(doc), { noCache: doc.noCache, status, context });
  return withSetCookies(response, setCookies);
}

type RawMode = 'fragment' | 'json' | 'download';

/**
 * `stream` as a response body read as the client reads it; cancelling the body destroys `stream`, ending its call. An
 * upstream error or a cancellation ends the body's {@link Transfer}.
 */
function responseStreamOf(stream: Readable): ReadableStream<Uint8Array> {
  // Pulled through the async iterator, which reads nothing once `stream` is destroyed; `Readable.toWeb` can still
  // enqueue a buffered chunk after cancellation, which throws outside any caller.
  const chunks = stream[Symbol.asyncIterator]();
  const transfer = new Transfer(streamedCallOf(stream));
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: IteratorResult<unknown>;
      try {
        next = await chunks.next();
      } catch (error) {
        transfer.end({ kind: 'failed', error });
        throw error;
      }
      if (next.done === true) controller.close();
      else controller.enqueue(next.value as Uint8Array);
    },
    cancel: () => {
      transfer.end({ kind: 'cancelled' });
      discardStreamed(stream);
    },
  });
  transfers.set(body, transfer);
  return body;
}

/** A passed-through body: a stream relayed as it arrives, markup as its text, anything else as given. */
function passthroughBody(body: RawBody['body']): DownloadSource['body'] {
  if (body instanceof Readable) return responseStreamOf(body);
  return isSafeHtml(body) ? markupOf(body) : body;
}

/** A bare body with the legacy headers: markup and JSON text as given, bytes, streams and downloads passed through. */
function rawResponse(
  raw: RawBody,
  mode: RawMode,
  setCookies: readonly string[],
  context: LegacyResponseContext,
): Response {
  const status = raw.status ?? 200;
  const headers = raw.headers ?? {};
  let response: Response;
  if (mode === 'download' || raw.body instanceof Uint8Array || raw.body instanceof Readable) {
    const body = passthroughBody(raw.body);
    response = downloadResponse({ status, headers: { 'content-type': raw.contentType, ...headers }, body }, context);
  } else {
    const text = typeof raw.body === 'string' ? raw.body : markupOf(raw.body);
    const options = { status, contentType: raw.contentType, headers, context };
    response = mode === 'json' ? jsonResponse(text, options) : htmlResponse(text, options);
  }
  return withSetCookies(response, [...setCookies, ...(raw.setCookies ?? [])]);
}

/** `rc` entries a FW/1 key list names: every entry for `all`, else each listed key present in `rc`, in list order. */
function namedEntries(rc: RequestContext, keys: string): Array<readonly [string, string]> {
  const names = cfEq(keys, 'all') ? Object.keys(rc) : cfListToArray(keys, ',');
  return names.flatMap((name) => {
    const value = rc[name];
    return value === undefined ? [] : [[name, value] as const];
  });
}

/** CFML struct assignment: a key that differs only in case keeps its stored name. */
function setStructKey(struct: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  struct[Object.keys(struct).find((key) => key.toLowerCase() === lower) ?? name] = value;
}

/**
 * FW/1 `saveFlashContext(preserve)`: takes the next preserve key, purges the context stored ten keys earlier and adds
 * the named `rc` entries to the context under the key.
 */
function saveFlashContext(
  session: AdminRequest['session'],
  rc: RequestContext,
  preserve: string,
): { key: number; writes: AdminSessionWrites } {
  const key = session.nextPreserveKey;
  const purged = String(key - MAX_PRESERVED_CONTEXTS);
  const flash = Object.fromEntries(Object.entries(session.flash).filter(([stored]) => stored !== purged));
  const slot: Record<string, string> = { ...flash[String(key)] };
  for (const [name, value] of namedEntries(rc, preserve)) setStructKey(slot, name, value);
  return { key, writes: { flash: { ...flash, [String(key)]: slot }, nextPreserveKey: key + 1 } };
}

/** An FW/1 `redirect()`: its location and cookies, with the flash-context writes of a preserving redirect. */
function fw1RedirectOf(
  result: PageRedirect,
  req: AdminRequest,
): { location: string; setCookies: string[]; writes?: AdminSessionWrites } {
  const { action, append, preserve, path, queryString, setCookies } = result;
  const rc = result.rc === undefined ? req.rc : assignContext(req.rc, result.rc);
  const flash =
    preserve === undefined || cfEq(preserve, 'none') ? undefined : saveFlashContext(req.session, rc, preserve);
  const location = fw1RedirectTarget({
    action,
    append: append === undefined || cfEq(append, 'none') ? [] : namedEntries(rc, append),
    queryString,
    path,
    preserveKey: flash?.key,
    ses: req.ses,
  });
  return { location, setCookies: cookiesOf(req, setCookies), writes: flash?.writes };
}

/** The response of a redirect-mode outcome, with the flash-context writes of a preserving FW/1 redirect. */
async function submitOutcome(
  result: SubmitResult,
  ctx: ScreenContext,
  context: LegacyResponseContext,
): Promise<Outcome<Response>> {
  const { req } = ctx;
  switch (result.kind) {
    case 'redirect': {
      const { location, setCookies, writes } = fw1RedirectOf(result, req);
      return { answer: fw1Redirect(location, { setCookies, context }), writes };
    }
    case 'location':
      return { answer: fw1Redirect(result.location, { setCookies: cookiesOf(req, result.setCookies), context }) };
    case 'render': {
      const doc = await renderDocument(ctx, result.view);
      return { answer: documentResponse(doc, result.status ?? 200, cookiesOf(req, result.setCookies), context) };
    }
    case 'raw':
      return { answer: rawResponse(result.response, 'fragment', req.pendingSetCookies, context) };
  }
}

/** The loaded data of a screen; undefined for a screen without `load`. */
function loadData<D>(screen: { load?(ctx: ScreenContext): Promise<D> }, ctx: ScreenContext): Promise<D | undefined> {
  return screen.load === undefined ? Promise.resolve(undefined) : screen.load(ctx);
}

// ---- Dispatch per response mode ----

/** A view rendered inside the legacy layout, answered by `answer`. */
function documentDispatch<T>(
  gate: ScreenGate | undefined,
  view: (ctx: ScreenContext) => Promise<ShellView>,
  answer: (doc: AdminDocument, req: AdminRequest, context: LegacyResponseContext) => T,
): Dispatch<T> {
  return {
    gate,
    run: async (ctx, context) => ({ answer: answer(await renderDocument(ctx, await view(ctx)), ctx.req, context) }),
  };
}

/** The page screen of `route`: its redirect via `answers`, else its view via `answer`; undefined unless page mode. */
function pageDispatch<T>(
  req: AdminRequest,
  uploads: readonly UploadPart[],
  route: AdminRouteParams,
  answers: Answers<T>,
  answer: (doc: AdminDocument, req: AdminRequest, context: LegacyResponseContext) => T,
): Dispatch<T> | undefined {
  const screen = findScreen(route.circuit, route.action, req.rc, uploads);
  if (screen === undefined || screen.mode !== 'page') return undefined;
  const view = documentDispatch(screen.gate, async (ctx) => screen.render(ctx, await loadData(screen, ctx)), answer);
  return {
    gate: screen.gate,
    run: async (ctx, context) => {
      const redirect = await screen.redirect?.(ctx);
      if (redirect === undefined) return view.run(ctx, context);
      if (redirect.kind === 'location') {
        return { answer: answers.redirect(redirect.location, cookiesOf(ctx.req, redirect.setCookies), context) };
      }
      const { location, setCookies, writes } = fw1RedirectOf(redirect, ctx.req);
      return { answer: answers.redirect(location, setCookies, context), writes };
    },
  };
}

/** A post action: its submit outcome as a response. */
function submitDispatch(
  gate: ScreenGate | undefined,
  submit: (ctx: ScreenContext) => Promise<SubmitResult>,
): Dispatch<Response> {
  return { gate, run: async (ctx, context) => submitOutcome(await submit(ctx), ctx, context) };
}

/** A bare-body screen of `mode`. */
function rawDispatch(
  gate: ScreenGate | undefined,
  mode: RawMode,
  raw: (ctx: ScreenContext) => Promise<RawBody>,
): Dispatch<Response> {
  return {
    gate,
    run: async (ctx, context) => ({ answer: rawResponse(await raw(ctx), mode, ctx.req.pendingSetCookies, context) }),
  };
}

const pageResponse = (doc: AdminDocument, req: AdminRequest, context: LegacyResponseContext): Response =>
  documentResponse(doc, 200, cookiesOf(req), context);

/** Entry facts of a route-handler request; `withBody` reads its body as the form scope. */
function requestInput(mode: AdminMode, route: AdminRouteParams, request: Request, withBody: boolean): PipelineRequest {
  const url = new URL(request.url);
  return {
    mode,
    route,
    method: request.method,
    path: url.pathname,
    search: url.search,
    headers: request.headers,
    searchParams: url.searchParams,
    bodySource: withBody ? request : undefined,
  };
}

// ---- Entry points ----

/** Page mode as the complete legacy response: status, headers, cookies and the serialized layout. */
export function handleAdminPage(request: Request, params: AdminRouteParams): Promise<Response> {
  return withAdminPipeline(requestInput('page', params, request, true), RESPONSE_ANSWERS, (req, uploads) =>
    pageDispatch(req, uploads, params, RESPONSE_ANSWERS, pageResponse),
  );
}

/** Redirect mode: an FW/1 post action, answered with its redirect, re-rendered form or bare body. */
export function handleAdminAction(request: Request, params: AdminRouteParams): Promise<Response> {
  return withAdminPipeline(requestInput('redirect', params, request, true), RESPONSE_ANSWERS, (req, uploads) => {
    const screen = findScreen(params.circuit, params.action, req.rc, uploads);
    if (screen === undefined || screen.mode !== 'redirect') return undefined;
    return submitDispatch(screen.gate, (ctx) => screen.submit(ctx));
  });
}

/** Fragment, JSON and download modes: the bare legacy body of a carried action. */
export function handleAdminRaw(request: Request, params: AdminRouteParams): Promise<Response> {
  return withAdminPipeline(requestInput('raw', params, request, true), RESPONSE_ANSWERS, (req, uploads) => {
    const screen = findScreen(params.circuit, params.action, req.rc, uploads);
    switch (screen?.mode) {
      case 'fragment':
        return rawDispatch(screen.gate, 'fragment', async (ctx) => screen.render(ctx, await loadData(screen, ctx)));
      case 'json':
        return rawDispatch(screen.gate, 'json', async (ctx) => screen.json(ctx, await loadData(screen, ctx)));
      case 'download':
        return rawDispatch(screen.gate, 'download', async (ctx) => screen.download(ctx, await loadData(screen, ctx)));
      default:
        return undefined;
    }
  });
}

/** A synthetic-module screen inside the legacy layout, answered like a page-mode view. */
export function handleOpt2Page(request: Request, params: Opt2ScreenParams): Promise<Response> {
  const route = { circuit: params.module, action: params.screen };
  return withAdminPipeline(requestInput('opt2', route, request, false), RESPONSE_ANSWERS, () => {
    const def = findOpt2Screen(params.module, params.screen);
    return def === undefined
      ? undefined
      : documentDispatch(def.gate, async (ctx) => def.render(ctx, await def.load(ctx)), pageResponse);
  });
}

/** A synthetic-module post action, answered like an FW/1 post action. */
export function handleOpt2Action(request: Request, params: Opt2ActionParams): Promise<Response> {
  const route = { circuit: params.module, action: params.action };
  return withAdminPipeline(requestInput('opt2', route, request, true), RESPONSE_ANSWERS, () => {
    const def = findOpt2Action(params.module, params.action);
    return def === undefined ? undefined : submitDispatch(def.gate, (ctx) => def.submit(ctx));
  });
}
