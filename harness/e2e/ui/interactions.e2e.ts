// Browser interaction parity (GS-UI-01 … GS-UI-05): the legacy admin scripts driven in headless chromium, legacy
// direct and through the gateway.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
  type Request as PwRequest,
  type Response as PwResponse,
} from '@playwright/test';
import { routeKeyForRequest, type RouteKeyRequest } from '@opt2/platform/legacy-compat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isRehearsalScenario,
  loadCatalogue,
  readFixtureStatus,
  scenarioById,
  type Scenario,
  type Step,
} from '../../src/golden/catalogue.js';
import {
  createGoldenStepBuilder,
  goldenRun,
  goldenSetPath,
  goldenSetSchema,
  readGoldenSet,
  type GoldenSet,
  type GoldenSideEffects,
  type GoldenStep,
  type GoldenStepBuilder,
} from '../../src/golden/capture.js';
import {
  browserRecordSchema,
  browserResultPath,
  classifyScenario,
  exceptionEntries,
  loadDecisionList,
  loadExceptionsList,
  type DecisionList,
  type ParityResult,
  type ScenarioVerdict,
} from '../../src/golden/compare.js';
import { GoldenConfigError, type ExceptionEntry } from '../../src/golden/errors.js';
import {
  compareNormalised,
  loadRules,
  normaliseText,
  rulesForScenario,
  type Difference,
  type NormaliseRules,
  type NormalisedStep,
} from '../../src/golden/normalise/index.js';
import type { ReplayOutput } from '../../src/golden/replay.js';
// Outside this suite's declared inputs, but the one source of the committed variants: without it an image upload would
// not key as `{upload=image}` and keys would not match the dispatcher's, the catalogue's or the exceptions list's.
import { defaultRouteKeyOptions } from '../../src/golden/route-key-options.js';
import {
  ADMIN_LOGIN_PATH,
  appReloadKey,
  createScenarioContext,
  loadSecretStore,
  loadSeedStore,
  originBaseUrl,
  resolvePlaceholders,
  type Origin,
  type ScenarioContext,
  type SecretStore,
  type SeedStore,
} from '../../src/golden/session.js';
import { stateDir } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';
import { readJson, writeJsonReport } from '../../src/lib/report.js';
import { credentialsFor, redactSecrets } from '../helpers/admin-login.js';
import { resetMailpit } from '../helpers/mailpit.js';
import { activeTableVersion } from '../helpers/stack.js';

/** `capture` (legacy direct, v0001), `replay` (gateway, v0002) or `unset` (both, v0001, compared in memory). */
type Phase = 'capture' | 'replay' | 'unset';

const PHASE_VARIABLE = 'OPT2_UI_PHASE';
const GENERATED_BY = 'harness/e2e/ui/interactions.e2e.ts';

const SCENARIO_IDS = ['GS-UI-01', 'GS-UI-02', 'GS-UI-03', 'GS-UI-04', 'GS-UI-05'] as const;
type ScenarioId = (typeof SCENARIO_IDS)[number];

/** The `browser.flow` each scenario's catalogue entry must name. */
const FLOW_NAMES: Readonly<Record<ScenarioId, string>> = {
  'GS-UI-01': 'site-manager-tree',
  'GS-UI-02': 'edit-modal-tabs-status-approval',
  'GS-UI-03': 'multi-file-upload',
  'GS-UI-04': 'version-diff',
  'GS-UI-05': 'inline-save',
};

/** Cut-over table each phase needs: legacy-direct runs write legacy-authoritative units only under v0001. */
const REQUIRED_VERSION: Readonly<Record<Phase, string>> = { capture: 'v0001', replay: 'v0002', unset: 'v0001' };

/**
 * Verdicts that hold no unlisted difference. `withheld` (GS-UI-01's copy is a decision-list variant served by legacy)
 * compared clean too; the parity report lists it as unmet pending the user's decision, so it does not fail here.
 */
const ACCEPTED_RESULTS: ReadonlySet<ParityResult> = new Set<ParityResult>([
  'pass',
  'excepted',
  'halted',
  'known-issue',
  'withheld',
]);

/** Masa's Site Manager module id (the site tree), not a content id. */
const SITE_TREE_MODULE_ID = '00000000000000000000000000000000000';
const TREE = '#gridContainer';
const TREE_NEXT_PAGE = `${TREE} > .mura-results-wrapper ul.pagination a:has(i.mi-angle-right)`;
const UPLOAD_INPUT = 'form#fileupload input[type="file"][name="files"]';
const UPLOAD_ROW_READY = 'form#fileupload tbody.files tr.template-upload:not(.processing) button.start:not([disabled])';
const XHR_TYPES: ReadonlySet<string> = new Set(['xhr', 'fetch']);

/** Base route keys of the admin actions the flows wait for. */
const KEY = {
  loadSiteManager: 'admin:carch.loadsitemanager',
  loadSiteSection: 'admin:carch.loadsitesection',
  refreshSiteSection: 'admin:carch.refreshsitesection',
  saveCopyInfo: 'admin:carch.savecopyinfo',
  copy: 'admin:carch.copy',
  draftPromptData: 'admin:carch.draftpromptdata',
  edit: 'admin:carch.edit',
  statusModal: 'admin:carch.statusmodal',
  approvalAction: 'admin:carch.approvalaction',
  update: 'admin:carch.update',
  loadDiff: 'admin:carch.loaddiff',
  loadQuickEdit: 'admin:carch.loadquickedit',
  saveQuickEdit: 'admin:carch.savequickedit',
} as const;

const FINAL_DOM = 'final-dom';
/** Fixed so the final DOM pairs across sides whatever their XHR counts. */
const FINAL_DOM_INDEX = 1_000_000;
const CONSOLE_STEP = 'console';
const HTML_TYPE = 'text/html';

// Departs from Rule "WIP - Minimal Change 2" (no timeouts), which does not bind this refactor: an XHR that never
// answers would otherwise hold the test until the suite bound, with no message naming what it waited for.
/** Longest wait for one awaited XHR, or for a multipart body's DevTools record. */
const XHR_TIMEOUT_MS = 30_000;
/** Longest wait for the page's XHRs and navigations to finish after an action. */
const SETTLE_TIMEOUT_MS = 60_000;
/** Quiet period that counts as settled, as Playwright's `networkidle` uses. */
const QUIET_MS = 500;
const DIFFERENCES_SHOWN = 25;

/** Bytes of the catalogue file fixtures `image-png-8x8` and `pdf-one-page`, so both sides upload identical files. */
const PNG_8X8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAA00lEQVR4AQHIADf/AAAAgCAAgEAAgGAAgIAAgKAAgMAAgOAAgAAAIIAgIIBAIIBg' +
    'IICAIICgIIDAIIDgIIAAAECAIECAQECAYECAgECAoECAwECA4ECAAABggCBggEBggGBggIBggKBggMBggOBggAAAgIAggIBAgIBggICAgICggIDA' +
    'gIDggIAAAKCAIKCAQKCAYKCAgKCAoKCAwKCA4KCAAADAgCDAgEDAgGDAgIDAgKDAgMDAgODAgAAA4IAg4IBA4IBg4ICA4ICg4IDA4IDg4IDGe1gB' +
    '0ieB3QAAAABJRU5ErkJggg==',
  'base64',
);
const PDF_ONE_PAGE = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9L' +
    'aWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2' +
    'MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwg' +
    'L1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTEgPj4K' +
    'c3RyZWFtCkJUIC9GMSAxMiBUZiA3MiA3MjAgVGQgKE9QVC0yIGdvbGRlbiBmaXh0dXJlKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2' +
    'CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAw' +
    'MDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDEy' +
    'CiUlRU9GCg==',
  'base64',
);

/** One image (an `{upload=image}` legacy-write) and one document. */
const UPLOAD_FILES: ReadonlyArray<{ name: string; mimeType: string; buffer: Buffer }> = [
  { name: 'gs-ui-03.png', mimeType: 'image/png', buffer: PNG_8X8 },
  { name: 'gs-ui-03.pdf', mimeType: 'application/pdf', buffer: PDF_ONE_PAGE },
];

const EMPTY_SIDE_EFFECTS: GoldenSideEffects = { mail: [], rows: {}, tasks: [], files: [] };

type StepRecord = Parameters<GoldenStepBuilder['step']>[0];
type RecordedBody = StepRecord['request']['body'];
type RecordedFile = Extract<RecordedBody, { kind: 'multipart' }>['value']['files'][number];
type FieldValues = Extract<RecordedBody, { kind: 'form' }>['value'];

/** One XHR or fetch as the page issued it, its response once read. */
interface XhrRecord {
  /** Position by request start. */
  index: number;
  method: string;
  url: URL;
  requestContentType?: string;
  body: RecordedBody;
  routeKey: string;
  baseKey: string;
  /** Merged request parameters as the route key read them, lower-cased names. */
  params: Record<string, string>;
  response?: { status: number; contentType: string; text: string | null; sha256: string };
  failure?: string;
  done: boolean;
}

/** A flow's error, as recorded. */
interface FlowError {
  message: string;
  step?: string;
}

/** One origin's run of one scenario, normalised; `console` and `notes` are also carried on the final DOM step. */
interface BrowserSide {
  origin: Origin;
  steps: GoldenStep[];
  console: string[];
  notes: string[];
  /** XHRs addressed to an origin other than the run's own. */
  foreignOrigins: Array<{ step: string; origin: string }>;
  error?: FlowError;
}

/** The final DOM step's normalised form with the browser fields. */
type FinalDomStep = NormalisedStep & { console: string[]; notes: string[] };

/** The browser record compare.ts reads, written by replay. */
type BrowserReplayRecord = ReplayOutput & {
  result?: ParityResult;
  differences: Difference[];
  console: string[];
  notes: string[];
  foreignOrigins: BrowserSide['foreignOrigins'];
};

/** State a flow drives and records through. */
interface FlowRun {
  readonly scenario: Scenario;
  readonly origin: Origin;
  readonly baseUrl: string;
  readonly ctx: ScenarioContext;
  readonly xhr: XhrRecorder;
  readonly notes: string[];
  /** Name of the flow step under way, for errors. */
  step: string;
  /** Full-page review screenshot; never compared. */
  shot(): Promise<void>;
}

type Flow = (page: Page, run: FlowRun) => Promise<void>;

/** The phase `value` names; throws for any other value. */
function parsePhase(value: string | undefined): Phase {
  if (value === undefined || value === '') return 'unset';
  if (value === 'capture' || value === 'replay') return value;
  throw new Error(`${PHASE_VARIABLE} must be capture, replay or unset, got ${JSON.stringify(value)}`);
}

/** Lowercase hex SHA-256 of `bytes`. */
function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Message of a thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lower-cased media type of a content type, without parameters. */
function mediaType(contentType: string | undefined): string {
  return contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Query parameters as the gateway builds them: a repeated name maps to its values in order. */
function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>();
  for (const [name, value] of params) {
    const previous = query.get(name);
    query.set(name, previous === undefined ? value : [previous, value].flat());
  }
  return Object.fromEntries(query);
}

/** Adds `value` under `name`, turning a repeated name into a list. */
function addField(fields: FieldValues, name: string, value: string): void {
  const previous = fields[name];
  fields[name] = previous === undefined ? value : [previous, value].flat();
}

/** Route key of a request, under the shared precedence and the committed variants. */
function routeKeyOf(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: RecordedBody,
): ReturnType<typeof routeKeyForRequest> {
  const req: RouteKeyRequest = { method, path: url.pathname, query: queryOf(url.searchParams), headers };
  if (body.kind === 'form') req.form = body.value;
  if (body.kind === 'multipart') {
    req.form = body.value.fields;
    req.multipartFileNames = body.value.files.map((file) => ({ field: file.field, filename: file.filename }));
  }
  if (body.kind === 'json') req.jsonBody = body.value;
  return routeKeyForRequest(req, { appReloadKey: appReloadKey(process.env), ...defaultRouteKeyOptions() });
}

/** Origin-relative form of `url`, as recorded requests hold it. */
function relativeUrl(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/** Multipart boundary of a content type, or undefined. */
function boundaryOf(contentType: string | undefined): string | undefined {
  return /;\s*boundary="?([^";]+)"?/i.exec(contentType ?? '')?.[1];
}

/** Header value by case-insensitive name. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** `promise`, or a rejection naming `what` after `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}


/** A request body as recorded: form and multipart fields with secrets redacted, file parts by digest. */
async function recordedBody(buffer: Buffer | null, contentType: string | undefined): Promise<RecordedBody> {
  if (buffer === null || buffer.length === 0) return { kind: 'none' };
  const media = mediaType(contentType);
  if (media === 'application/x-www-form-urlencoded' || media === 'multipart/form-data') {
    const parsed = await new Response(new Uint8Array(buffer), {
      headers: { 'content-type': contentType ?? media },
    }).formData();
    const fields: FieldValues = {};
    const files: RecordedFile[] = [];
    for (const [name, value] of parsed) {
      if (typeof value === 'string') {
        addField(fields, name, redactSecrets(value));
      } else {
        const bytes = new Uint8Array(await value.arrayBuffer());
        files.push({
          field: name,
          filename: value.name,
          contentType: value.type,
          sha256: sha256(bytes),
          size: bytes.length,
        });
      }
    }
    return media === 'multipart/form-data'
      ? { kind: 'multipart', value: { fields, files } }
      : { kind: 'form', value: fields };
  }
  const text = redactSecrets(buffer.toString('utf8'));
  try {
    return { kind: 'json', value: JSON.parse(text) as unknown };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // The recorded body kinds have no plain-text form; such a body is kept as its JSON string.
    return { kind: 'json', value: text };
  }
}

/** Records the page's XHR and fetch exchanges in request-start order, its console errors and its documents. */
class XhrRecorder {
  readonly records: XhrRecord[] = [];
  readonly consoleErrors: string[] = [];
  /** The main frame's latest document response. */
  document: { status: number; contentType: string } | undefined;
  private readonly parsed = new Map<PwRequest, { record: XhrRecord; ready: Promise<void> }>();
  private readonly openDocuments = new Set<PwRequest>();
  private readonly watchers = new Set<() => void>();
  private readonly devToolsIds = new Map<string, string>();
  private readonly devToolsWaiters = new Map<string, (requestId: string) => void>();
  private recording = false;
  private seen = 0;
  private failure: Error | undefined;

  constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {
    page.on('request', (request) => this.onRequest(request));
    page.on('response', (response) => this.onResponse(response));
    page.on('requestfailed', (request) => this.onRequestFailed(request));
    page.on('console', (message) => {
      if (this.recording && message.type() === 'error') this.consoleErrors.push(`console.error: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      if (this.recording) this.consoleErrors.push(`pageerror: ${error.message}`);
    });
    cdp.on('Network.requestWillBeSent', (event) => this.onDevToolsRequest(event.requestId, event.request.headers));
  }

  /** Starts recording XHRs and console errors; documents are tracked from construction. */
  start(): void {
    this.recording = true;
  }

  /** Index the next recorded XHR will take. */
  mark(): number {
    return this.records.length;
  }

  /**
   * The first `count` completed XHRs at index `from` or later that `match`; rejects when one of them failed, when
   * recording failed, or after {@link XHR_TIMEOUT_MS}.
   */
  waitFor(from: number, match: (record: XhrRecord) => boolean, what: string, count = 1): Promise<XhrRecord[]> {
    return new Promise((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.watchers.delete(check);
      };
      const check = (): void => {
        if (this.failure !== undefined) {
          finish();
          reject(this.failure);
          return;
        }
        const hits = this.records.filter((r) => r.index >= from && r.done && match(r));
        const failed = hits.find((r) => r.response === undefined);
        if (failed !== undefined) {
          finish();
          reject(new Error(`${what}: ${failed.method} ${failed.routeKey} failed: ${failed.failure ?? 'no response'}`));
        } else if (hits.length >= count) {
          finish();
          resolve(hits.slice(0, count));
        }
      };
      const timer = setTimeout(() => {
        finish();
        const seen = this.records.filter((r) => r.index >= from).map((r) => r.routeKey || r.url.pathname);
        const since = seen.join(', ') || 'none';
        reject(new Error(`timed out after ${XHR_TIMEOUT_MS} ms waiting for ${what}; XHRs since: ${since}`));
      }, XHR_TIMEOUT_MS);
      this.watchers.add(check);
      check();
    });
  }

  /** Waits until no XHR or main-frame document is in flight and none has started for {@link QUIET_MS}. */
  async settle(): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let quietAt: number | undefined;
    for (;;) {
      if (this.failure !== undefined) throw this.failure;
      await this.page.waitForLoadState('load');
      const open = [
        ...this.records.filter((r) => !r.done).map((r) => `${r.method} ${r.routeKey || r.url.pathname}`),
        ...[...this.openDocuments].map((request) => `document ${new URL(request.url()).pathname}`),
      ];
      if (open.length === 0) {
        if (quietAt === this.seen) return;
        quietAt = this.seen;
      } else {
        quietAt = undefined;
      }
      if (Date.now() > deadline) throw new Error(`still in flight after ${SETTLE_TIMEOUT_MS} ms: ${open.join(', ')}`);
      await delay(QUIET_MS);
    }
  }

  /** Golden steps of the answered XHRs in request order; unanswered ones become notes. */
  async goldenSteps(builder: GoldenStepBuilder, notes: string[]): Promise<GoldenStep[]> {
    if (this.failure !== undefined) throw this.failure;
    const steps: GoldenStep[] = [];
    for (const record of this.records) {
      if (record.response === undefined) {
        notes.push(`xhr-${record.index} ${record.method} ${record.routeKey} ${record.failure ?? 'had no response'}`);
        continue;
      }
      steps.push(await xhrStep(builder, record, record.response));
    }
    return steps;
  }

  /** Whether `request` is a main-frame navigation. */
  private isDocument(request: PwRequest): boolean {
    return request.isNavigationRequest() && request.frame() === this.page.mainFrame();
  }

  /** Tracks a started document, or numbers a started XHR in request order while recording. */
  private onRequest(request: PwRequest): void {
    if (this.isDocument(request)) {
      this.openDocuments.add(request);
      this.seen += 1;
      return;
    }
    if (!this.recording || !XHR_TYPES.has(request.resourceType())) return;
    this.seen += 1;
    const record: XhrRecord = {
      index: this.records.length,
      method: request.method(),
      url: new URL(request.url()),
      body: { kind: 'none' },
      routeKey: '',
      baseKey: '',
      params: {},
      done: false,
    };
    const contentType = request.headers()['content-type'];
    if (contentType !== undefined) record.requestContentType = contentType;
    this.records.push(record);
    const ready = this.describe(request, record);
    this.parsed.set(request, { record, ready });
    this.track(ready);
  }

  /** Fills the record's parsed body and route key. */
  private async describe(request: PwRequest, record: XhrRecord): Promise<void> {
    const buffer = request.postDataBuffer() ?? (await this.multipartBody(record.requestContentType));
    record.body = await recordedBody(buffer, record.requestContentType);
    const key = routeKeyOf(record.method, record.url, request.headers(), record.body);
    record.routeKey = key.key;
    record.baseKey = key.baseKey;
    record.params = key.params;
  }

  /** Completes a document or XHR record with its status, content type and body. */
  private onResponse(response: PwResponse): void {
    const request = response.request();
    if (this.isDocument(request)) {
      this.document = { status: response.status(), contentType: response.headers()['content-type'] ?? '' };
      this.openDocuments.delete(request);
      this.notify();
      return;
    }
    const entry = this.parsed.get(request);
    if (entry === undefined) return;
    this.track(
      (async () => {
        await entry.ready;
        // Redirects and evicted responses have no body Playwright can return; they record a null body.
        const bytes = await response.body().catch(() => null);
        entry.record.response = {
          status: response.status(),
          contentType: response.headers()['content-type'] ?? '',
          text: bytes === null ? null : bytes.toString('utf8'),
          sha256: sha256(bytes ?? ''),
        };
        this.complete(entry.record);
      })(),
    );
  }

  /** Completes a document or XHR record that got no response. */
  private onRequestFailed(request: PwRequest): void {
    if (this.openDocuments.delete(request)) {
      this.notify();
      return;
    }
    const entry = this.parsed.get(request);
    if (entry === undefined) return;
    this.track(
      (async () => {
        await entry.ready;
        entry.record.failure = `failed: ${request.failure()?.errorText ?? 'unknown error'}`;
        this.complete(entry.record);
      })(),
    );
  }

  /** Marks `record` done and wakes the waiters. */
  private complete(record: XhrRecord): void {
    record.done = true;
    this.notify();
  }

  /** Re-evaluates every pending wait. */
  private notify(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  /** Keeps a listener's failure for the next wait, settle or step build instead of an unhandled rejection. */
  private track(work: Promise<void>): void {
    work.catch((err: unknown) => {
      this.failure ??= err instanceof Error ? err : new Error(String(err));
      this.notify();
    });
  }

  /** Indexes a DevTools request id by its multipart boundary. */
  private onDevToolsRequest(requestId: string, headers: Record<string, string>): void {
    const boundary = boundaryOf(headerValue(headers, 'content-type'));
    if (boundary === undefined) return;
    const waiter = this.devToolsWaiters.get(boundary);
    if (waiter === undefined) {
      this.devToolsIds.set(boundary, requestId);
    } else {
      this.devToolsWaiters.delete(boundary);
      waiter(requestId);
    }
  }

  /**
   * Body of a multipart request from DevTools, matched by its unique boundary: Playwright returns no post data for a
   * body with file parts. Null for a request that is not multipart.
   */
  private async multipartBody(contentType: string | undefined): Promise<Buffer | null> {
    const boundary = boundaryOf(contentType);
    if (boundary === undefined) return null;
    const requestId =
      this.devToolsIds.get(boundary) ??
      (await withTimeout(
        new Promise<string>((resolve) => this.devToolsWaiters.set(boundary, resolve)),
        XHR_TIMEOUT_MS,
        `the DevTools record of multipart request ${boundary}`,
      ));
    this.devToolsIds.delete(boundary);
    const posted = await this.cdp.send('Network.getRequestPostData', { requestId });
    return Buffer.from(posted.postData, posted.base64Encoded === true ? 'base64' : 'utf8');
  }
}

/** The golden step of one answered XHR; a body Playwright could not return is recorded as null. */
async function xhrStep(
  builder: GoldenStepBuilder,
  record: XhrRecord,
  response: NonNullable<XhrRecord['response']>,
): Promise<GoldenStep> {
  const contentType = response.contentType;
  const step = await builder.step({
    name: `xhr-${record.index}`,
    index: record.index,
    routeKey: record.routeKey,
    request: {
      method: record.method,
      url: relativeUrl(record.url),
      headers: record.requestContentType === undefined ? {} : { 'content-type': record.requestContentType },
      body: record.body,
    },
    // Only the content type is compared among the response headers.
    response: {
      status: response.status,
      headers: contentType === '' ? {} : { 'content-type': contentType },
      contentType,
      sha256: response.sha256,
      hops: [],
      text: response.text ?? '',
    },
    extracted: {},
  });
  if (response.text !== null) return step;
  const { status, headers, rawSha256 } = step.response;
  const { name, index, routeKey, maskedPaths } = step.normalised;
  const normalised: NormalisedStep = { name, index, routeKey, status: step.normalised.status, maskedPaths, body: null };
  if (step.normalised.headers !== undefined) normalised.headers = step.normalised.headers;
  return { ...step, response: { status, headers, body: null, rawSha256 }, normalised };
}

/** A predicate matching XHRs whose base route key is one of `keys`. */
function keyIs(...keys: string[]): (record: XhrRecord) => boolean {
  return (record) => keys.includes(record.baseKey);
}

/** Runs `action`, waits for `count` XHRs it issued that `match`, then for the page to settle. */
async function act(
  run: FlowRun,
  action: () => Promise<unknown>,
  match: (record: XhrRecord) => boolean,
  what: string,
  count = 1,
): Promise<XhrRecord[]> {
  const from = run.xhr.mark();
  await action();
  const hits = await run.xhr.waitFor(from, match, what, count);
  await run.xhr.settle();
  return hits;
}

/** The scenario's catalogue step named `name`. */
function catalogueStep(run: FlowRun, name: string): Step {
  const step = run.scenario.steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new GoldenConfigError(`${run.scenario.id}: the catalogue entry has no step ${name}`, {
      path: `scenario ${run.scenario.id}`,
    });
  }
  return step;
}

/** Route of catalogue step `name`, its placeholders resolved. */
function catalogueRoute(run: FlowRun, name: string): string {
  return resolvePlaceholders(catalogueStep(run, name).route, run.ctx);
}

/** Single-valued form field `field` of catalogue step `stepName`, its placeholders resolved. */
function catalogueField(run: FlowRun, stepName: string, field: string): string {
  const value = catalogueStep(run, stepName).form?.[field];
  if (typeof value !== 'string') {
    throw new GoldenConfigError(`${run.scenario.id}: step ${stepName} has no single form field ${field}`, {
      path: `scenario ${run.scenario.id}`,
    });
  }
  return resolvePlaceholders(value, run.ctx);
}

/** Field `field` of the seed row the scenario binds as `as`. */
function seedValue(run: FlowRun, as: string, field: string): string {
  const value: unknown = resolvePlaceholders(`\${seed.${as}.${field}}`, run.ctx);
  if (typeof value !== 'string' || value === '') {
    throw new GoldenConfigError(`${run.scenario.id}: seed row ${as} has no ${field}`, {
      path: `scenario ${run.scenario.id}`,
    });
  }
  return value;
}

/** Site Manager tree of `site` with `topId` as its top node. */
function treeRoute(site: string, topId: string): string {
  const query = new URLSearchParams({
    muraAction: 'cArch.list',
    siteid: site,
    moduleid: SITE_TREE_MODULE_ID,
    topid: topId,
  });
  return `/admin/?${query.toString()}`;
}

/** Opens the tree at `route` and waits for the tree XHR and its grid. */
async function openTree(page: Page, run: FlowRun, route: string): Promise<void> {
  await act(run, () => page.goto(`${run.baseUrl}${route}`), keyIs(KEY.loadSiteManager), 'the Site Manager tree');
  await page.locator(`${TREE} .mura-grid`).first().waitFor({ state: 'visible' });
}

/** Opens a page at `route` and waits for it and its XHRs to settle. */
async function openPage(page: Page, run: FlowRun, route: string): Promise<void> {
  await page.goto(`${run.baseUrl}${route}`);
  await run.xhr.settle();
}

/** The tree's breadcrumb link to `contentId`, which reloads the tree in-page from its first page. */
function breadcrumbLink(page: Page, contentId: string): Locator {
  return page.locator(`${TREE} ul.breadcrumb a[onclick*="'${contentId}'"]`).first();
}

/**
 * The node of `contentId` in the tree topped by `topId`: pages forward until it is shown, restarting once from the
 * first page through the breadcrumb when the tree stood past it.
 */
async function revealNode(page: Page, run: FlowRun, contentId: string, topId: string): Promise<Locator> {
  const node = page.locator(`${TREE} li.mura-node-data[data-contentid="${contentId}"]`).first();
  let restarted = false;
  for (;;) {
    if ((await node.count()) > 0) return node;
    const next = page.locator(TREE_NEXT_PAGE).first();
    if ((await next.count()) > 0) {
      await act(run, () => next.click(), keyIs(KEY.loadSiteManager), 'the next tree page');
    } else if (!restarted && (await page.locator(`${TREE} > .mura-results-wrapper ul.pagination`).count()) > 0) {
      restarted = true;
      await act(run, () => breadcrumbLink(page, topId).click(), keyIs(KEY.loadSiteManager), 'the first tree page');
    } else {
      throw new Error(`content ${contentId} is not on any page of the Site Manager tree`);
    }
  }
}

/**
 * The tree's numbered pagination link (dsp_nextN.cfm) to show next: the following page, else the nearest earlier one
 * past the first, so its start row is above 1 wherever the tree stands.
 */
async function otherTreePage(page: Page): Promise<Locator> {
  const pagination = `${TREE} > .mura-results-wrapper ul.pagination`;
  const links = page.locator(`${pagination} li a`);
  const numbers = (await links.allTextContents()).map((text) => Number(text.trim()));
  const current = Number((await page.locator(`${pagination} li.active a`).first().textContent())?.trim());
  const candidates = numbers.filter((n) => Number.isInteger(n) && n > 1 && n !== current);
  const target = candidates.includes(current + 1) ? current + 1 : Math.max(...candidates.filter((n) => n < current));
  const index = numbers.indexOf(target);
  if (!Number.isFinite(target) || index < 0) throw new Error('the Site Manager tree has no other page past the first');
  return links.nth(index);
}

/** Opens a node's menu (zoom, add, copy, paste and its action links). */
async function openNodeMenu(page: Page, node: Locator): Promise<void> {
  await node.locator(':scope > dl a.add').first().click();
  await page.locator('#newContentMenu').waitFor({ state: 'visible' });
}

/** `topid` of an admin route. */
function topIdOf(run: FlowRun, route: string): string {
  const topId = new URL(route, 'http://route.invalid').searchParams.get('topid');
  if (topId === null || topId === '') {
    throw new GoldenConfigError(`${run.scenario.id}: route ${route} names no topid`, {
      path: `scenario ${run.scenario.id}`,
    });
  }
  return topId;
}

/**
 * GS-UI-01: expand a folder, page the tree, copy a page and paste it under the folder. Copy and paste stay in one
 * page load, as legacy only offers paste there: list.cfm restores `copymoduleid`, which showMenu never reads.
 */
async function siteManagerTree(page: Page, run: FlowRun): Promise<void> {
  const folderId = seedValue(run, 'folder', 'contentID');
  const pageId = seedValue(run, 'page', 'contentID');
  const pageParent = seedValue(run, 'page', 'parentID');
  const openRoute = catalogueRoute(run, 'open');
  const topId = topIdOf(run, openRoute);

  run.step = 'open';
  await openTree(page, run, openRoute);
  await run.shot();

  run.step = 'expand';
  const folder = await revealNode(page, run, folderId, topId);
  const toggle = folder.locator(':scope > dl span.hasChildren.closed').first();
  if ((await toggle.count()) === 0) throw new Error(`folder ${folderId} shows no collapsed section to expand`);
  await act(run, () => toggle.click(), keyIs(KEY.loadSiteSection), 'the expanded folder section');
  await run.shot();

  run.step = 'page';
  const pageLink = await otherTreePage(page);
  const laterPage = (record: XhrRecord): boolean =>
    record.baseKey === KEY.loadSiteManager && Number(record.params.startrow ?? '1') > 1;
  await act(run, () => pageLink.click(), laterPage, 'another tree page');
  await run.shot();

  run.step = 'copy';
  if (pageParent !== topId) {
    await openNodeMenu(page, await revealNode(page, run, pageParent, topId));
    await act(run, () => page.locator('#newZoomLink').click(), keyIs(KEY.loadSiteManager), 'the zoomed tree');
  }
  await openNodeMenu(page, await revealNode(page, run, pageId, pageParent));
  await act(run, () => page.locator('#newCopyLink').click(), keyIs(KEY.saveCopyInfo), 'the copy record');
  await run.shot();

  run.step = 'paste';
  if (pageParent !== topId) {
    await act(run, () => breadcrumbLink(page, topId).click(), keyIs(KEY.loadSiteManager), 'the top of the tree');
  }
  await openNodeMenu(page, await revealNode(page, run, folderId, topId));
  const paste = page.locator('#newPasteLink');
  if (!(await paste.isVisible())) throw new Error(`the menu of folder ${folderId} offers no paste`);
  const from = run.xhr.mark();
  await paste.click();
  const [copied] = await run.xhr.waitFor(from, keyIs(KEY.copy), 'the paste');
  await run.xhr.waitFor((copied?.index ?? from) + 1, keyIs(KEY.loadSiteManager), 'the reloaded tree');
  await run.xhr.settle();
  await run.shot();
}

/** The legacy handler behind the edit screen's status link (dsp_status.cfm). */
interface StatusWindow {
  viewStatusInfo(contentHistId: string, siteId: string): boolean;
}

/** GS-UI-02: edit a page from the tree, expand every panel, open its status modal and approve when offered. */
async function editPanelsAndStatus(page: Page, run: FlowRun): Promise<void> {
  const pageId = seedValue(run, 'page', 'contentID');
  const comment = catalogueField(run, 'approve', 'comment');

  run.step = 'edit';
  const parentId = seedValue(run, 'page', 'parentID');
  await openTree(page, run, treeRoute(seedValue(run, 'page', 'siteID'), parentId));
  await openNodeMenu(page, await revealNode(page, run, pageId, parentId));
  const from = run.xhr.mark();
  await page.locator('#newContentOptions li.li-action.edit a').first().click();
  const [prompt] = await run.xhr.waitFor(from, keyIs(KEY.draftPromptData), 'the draft prompt');
  if (/"showdialog"\s*:\s*"true"/i.test(prompt?.response?.text ?? '')) {
    await page.locator('.draft-prompt-option').first().click();
  }
  await page.waitForURL((url) => routeKeyOf('GET', url, {}, { kind: 'none' }).baseKey === KEY.edit);
  await run.xhr.settle();
  await run.shot();

  run.step = 'panels';
  const headings = page.locator('.mura-panel-heading a[data-toggle="collapse"]');
  const total = await headings.count();
  for (let i = 0; i < total; i += 1) {
    const heading = headings.nth(i);
    const collapsed = ((await heading.getAttribute('class')) ?? '').split(/\s+/).includes('collapsed');
    if (!collapsed || !(await heading.isVisible())) continue;
    await heading.click();
    await run.xhr.settle();
  }
  await run.shot();

  run.step = 'status';
  const link = page.locator('a[onclick*="viewStatusInfo"]:visible').first();
  const opened = run.xhr.mark();
  if ((await link.count()) > 0) {
    await link.click();
  } else {
    // The seed carries no approval chain, so the screen may render no status link; its own handler opens the modal.
    run.notes.push('the edit screen renders no status link; its viewStatusInfo handler opened the status modal');
    const contentHistId = await page.inputValue('form#contentForm input[name="contenthistid"]');
    const siteId = await page.inputValue('form#contentForm input[name="siteid"]');
    await page.evaluate(
      ([histId, site]) => {
        (globalThis as unknown as StatusWindow).viewStatusInfo(histId, site);
      },
      [contentHistId, siteId] as const,
    );
  }
  await run.xhr.waitFor(opened, keyIs(KEY.statusModal), 'the status modal');
  await page.locator('#approvalModalContainer').waitFor({ state: 'visible' });
  await run.xhr.settle();
  await run.shot();

  run.step = 'approve';
  const apply = page.locator('#mura-approval-apply');
  if (!(await apply.isVisible())) {
    run.notes.push('the status modal offers no approval action for this version');
    return;
  }
  await page.locator('#approval-approve').check();
  await page.locator('#approval-comments').fill(comment);
  await act(run, () => apply.click(), keyIs(KEY.approvalAction), 'the approval action');
  await run.shot();
}

/** GS-UI-03: upload an image and a document through the multi-file uploader. */
async function multiFileUpload(page: Page, run: FlowRun): Promise<void> {
  run.step = 'uploader';
  await openPage(page, run, catalogueRoute(run, 'uploader'));
  await run.shot();

  run.step = 'upload';
  await page.setInputFiles(
    UPLOAD_INPUT,
    UPLOAD_FILES.map((file) => ({ name: file.name, mimeType: file.mimeType, buffer: file.buffer })),
  );
  const start = page.locator('.fileupload-buttonbar .mura-file-start');
  await start.waitFor({ state: 'visible' });
  // The global start drops a row still processing its file, so it is pressed once every row is ready to upload.
  await page.waitForFunction(
    `document.querySelectorAll(${JSON.stringify(UPLOAD_ROW_READY)}).length >= ${UPLOAD_FILES.length}`,
  );
  const upload = (record: XhrRecord): boolean => record.baseKey === KEY.update && record.method === 'POST';
  await act(run, () => start.click(), upload, 'one upload per file', UPLOAD_FILES.length);
  await run.shot();
}

/** GS-UI-04: compare the two newest versions from the history screen. */
async function versionDiff(page: Page, run: FlowRun): Promise<void> {
  run.step = 'history';
  await openPage(page, run, catalogueRoute(run, 'history'));
  await run.shot();

  run.step = 'diff';
  const first = page.locator('input[name="compare1"]');
  const second = page.locator('input[name="compare2"]');
  const versions = await first.count();
  const viewDiff = page.locator('#viewDiff');
  if (versions === 0 || (await viewDiff.count()) === 0) {
    throw new Error('the history screen offers no version comparison');
  }
  await first.nth(0).check();
  if (versions > 1) {
    await second.nth(1).check();
  } else {
    run.notes.push('the seeded node has one version, compared with itself');
    await second.nth(0).check();
  }
  await act(run, () => viewDiff.click(), keyIs(KEY.loadDiff), 'the version diff fragment');
  await page.locator('#contentDiffContainer').waitFor({ state: 'visible' });
  await run.shot();
}

/** GS-UI-05: change one attribute through the tree's quick editor and save it. */
async function inlineSave(page: Page, run: FlowRun): Promise<void> {
  const pageId = seedValue(run, 'page', 'contentID');
  const attribute = catalogueField(run, 'save', 'attribute');
  const value = catalogueField(run, 'save', attribute);

  run.step = 'quick-edit';
  const parentId = seedValue(run, 'page', 'parentID');
  await openTree(page, run, treeRoute(seedValue(run, 'page', 'siteID'), parentId));
  const node = await revealNode(page, run, pageId, parentId);
  const item = node.locator(`:scope > dl a.mura-quickEditItem[data-attribute="${attribute}"]`).first();
  if ((await item.count()) === 0) throw new Error(`node ${pageId} offers no quick edit of ${attribute}`);
  await act(run, () => item.click(), keyIs(KEY.loadQuickEdit), 'the quick editor');
  // The editor's select is hidden behind a niceSelect widget (loadquickedit.cfm:81), which is what a user operates.
  const widget = page.locator(`#mura-quickEditor #mura-quickEdit-${attribute.toLowerCase()} + .nice-select`);
  await widget.click();
  await widget.locator(`li.option[data-value="${value}"]`).click();
  await run.shot();

  run.step = 'save';
  const from = run.xhr.mark();
  await page.locator('#btn__quickedit__save').click();
  const [saved] = await run.xhr.waitFor(from, keyIs(KEY.saveQuickEdit), 'the quick-edit save');
  await run.xhr.waitFor(
    (saved?.index ?? from) + 1,
    keyIs(KEY.refreshSiteSection, KEY.loadSiteManager),
    'the refreshed tree',
  );
  await run.xhr.settle();
  await run.shot();
}

const FLOWS: Readonly<Record<ScenarioId, Flow>> = {
  'GS-UI-01': siteManagerTree,
  'GS-UI-02': editPanelsAndStatus,
  'GS-UI-03': multiFileUpload,
  'GS-UI-04': versionDiff,
  'GS-UI-05': inlineSave,
};


/** What the tests share, resolved once in `beforeAll`. */
interface Suite {
  phase: Phase;
  rules: NormaliseRules;
  secrets: SecretStore;
  seed: SeedStore;
  scenarios: Map<ScenarioId, Scenario>;
  activeVersion: string;
  /** Loaded for the phases that classify a comparison. */
  decisionList?: DecisionList;
  exceptions: ExceptionEntry[];
  screenshots: string;
  browser: Browser;
}

/** Admin login through the real form, alike on both origins; throws when legacy refuses it. */
async function loginAdmin(page: Page, baseUrl: string): Promise<void> {
  const { username, password } = credentialsFor('${secret:admin}');
  await page.goto(`${baseUrl}${ADMIN_LOGIN_PATH}`);
  const loginPage = page.url();
  const form = page.locator('form#loginForm');
  await form.locator('#username').fill(username);
  await form.locator('#password').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.href !== loginPage),
    form.locator('button[type="submit"]').click(),
  ]);
  await page.waitForLoadState('networkidle');
  if ((await page.locator('form#loginForm #password').count()) > 0) {
    throw new Error(`admin login as ${username} at ${new URL(baseUrl).origin} was refused`);
  }
}

/** Options of each run's fresh browser context: one viewport and locale, and the process time zone when set. */
function contextOptions(): NonNullable<Parameters<Browser['newContext']>[0]> {
  const timezoneId = process.env.TZ;
  return {
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    ...(timezoneId === undefined || timezoneId === '' ? {} : { timezoneId }),
  };
}

/** Runs `scenario`'s flow at `origin` in a fresh context; a flow error is recorded on the side, not thrown. */
async function runFlow(suite: Suite, scenario: Scenario, id: ScenarioId, origin: Origin): Promise<BrowserSide> {
  await resetMailpit();
  const ctx = createScenarioContext(scenario, { origin, secrets: suite.secrets, seed: suite.seed });
  const context: BrowserContext = await suite.browser.newContext(contextOptions());
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const xhr = new XhrRecorder(page, cdp);
    let shots = 0;
    const run: FlowRun = {
      scenario,
      origin,
      baseUrl: ctx.baseUrl,
      ctx,
      xhr,
      notes: [],
      step: 'login',
      shot: async () => {
        shots += 1;
        const file = path.join(suite.screenshots, `${id}-${origin}-${shots}.png`);
        await page.screenshot({ path: file, fullPage: true });
      },
    };
    let error: FlowError | undefined;
    try {
      await loginAdmin(page, ctx.baseUrl);
      xhr.start();
      await FLOWS[id](page, run);
      run.step = 'settle';
      await xhr.settle();
    } catch (err) {
      error = { message: redactSecrets(messageOf(err)), step: run.step };
    }
    return await recordSide(page, run, suite.rules, error);
  } finally {
    await context.close();
  }
}

/** The run normalised: XHR steps, then the final DOM, then console errors, all on one normalisation state. */
async function recordSide(
  page: Page,
  run: FlowRun,
  rules: NormaliseRules,
  flowError: FlowError | undefined,
): Promise<BrowserSide> {
  let error = flowError;
  const builder = createGoldenStepBuilder(run.scenario, rules);
  const notes = run.notes;
  const steps = await run.xhr.goldenSteps(builder, notes);
  let finalStep: GoldenStep | undefined;
  try {
    const html = await page.content();
    const url = new URL(page.url());
    const doc = run.xhr.document;
    if (doc === undefined) throw new Error('no document response was seen');
    const contentType = doc.contentType === '' ? HTML_TYPE : doc.contentType;
    finalStep = await builder.step({
      name: FINAL_DOM,
      index: FINAL_DOM_INDEX,
      routeKey: routeKeyOf('GET', url, {}, { kind: 'none' }).key,
      request: { method: 'GET', url: relativeUrl(url), headers: {}, body: { kind: 'none' } },
      response: {
        status: doc.status,
        headers: { 'content-type': contentType },
        contentType,
        sha256: sha256(html),
        hops: [],
        text: html,
      },
      extracted: {},
    });
  } catch (err) {
    error ??= { message: redactSecrets(messageOf(err)), step: FINAL_DOM };
  }
  const scenarioRules = rulesForScenario(rules, run.scenario);
  const messages = run.xhr.consoleErrors.map((raw) =>
    normaliseText(redactSecrets(raw), builder.state.ids, scenarioRules),
  );
  if (finalStep !== undefined) {
    const normalised: FinalDomStep = { ...finalStep.normalised, console: messages, notes: [...notes] };
    steps.push({ ...finalStep, normalised });
  }
  const own = new URL(run.baseUrl).origin;
  const foreignOrigins = run.xhr.records
    .filter((record) => record.url.origin !== own)
    .map((record) => ({ step: `xhr-${record.index}`, origin: record.url.origin }));
  const side: BrowserSide = { origin: run.origin, steps, console: messages, notes, foreignOrigins };
  if (error !== undefined) side.error = error;
  return side;
}

/** A string list stored on the final DOM step; absent reads as empty. */
function storedList(value: unknown, what: string, file: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) return value;
  throw new GoldenConfigError(`${file}: the final DOM step's ${what} is not a list of strings`, { path: file });
}

/** A captured side rebuilt from its stored steps. */
function storedSide(steps: GoldenStep[], file: string): BrowserSide {
  const final = steps.find((step) => step.name === FINAL_DOM)?.normalised as Partial<FinalDomStep> | undefined;
  return {
    origin: 'legacy',
    steps,
    console: storedList(final?.console, 'console', file),
    notes: storedList(final?.notes, 'notes', file),
    foreignOrigins: [],
  };
}

/** State-directory record of a capture that is not a valid committed set, `<id>.legacy.json`. */
function fallbackPath(id: string): string {
  return path.join(path.dirname(browserResultPath(id)), `${id}.legacy.json`);
}

/** State-directory record of an unset-phase comparison, `<id>.unset.json`. */
function unsetPath(id: string): string {
  return path.join(path.dirname(browserResultPath(id)), `${id}.unset.json`);
}

/**
 * The latest capture of `id`. A capture writing the committed set removes its fallback, so a fallback present is the
 * newer record and is read first; throws when the latest capture failed or none exists.
 */
async function capturedSide(id: ScenarioId): Promise<BrowserSide> {
  const fallback = fallbackPath(id);
  const committed = goldenSetPath(id);
  if (existsSync(fallback)) {
    const record = await readJson<Partial<GoldenSet> & { error?: FlowError; schemaIssues?: string }>(fallback);
    if (record.error !== undefined) {
      const at = record.error.step ?? '?';
      const why = `the last capture of ${id} failed at ${at}: ${record.error.message}`;
      throw new Error(`${why}; run ${PHASE_VARIABLE}=capture first`);
    }
    if (!Array.isArray(record.steps)) throw new GoldenConfigError(`${fallback} holds no steps`, { path: fallback });
    return storedSide(record.steps, fallback);
  }
  if (!existsSync(committed)) {
    throw new Error(`no capture of ${id} at ${committed} or ${fallback}; run ${PHASE_VARIABLE}=capture first`);
  }
  return storedSide((await readGoldenSet(id)).steps, committed);
}

/** An unlisted difference on `step` at `at`. */
function difference(
  step: string,
  at: string,
  kind: Difference['kind'],
  expected: unknown,
  actual: unknown,
): Difference {
  return { step, path: at, kind, expected, actual, classification: 'difference' };
}

/**
 * Differences of `target` against the legacy side: the normaliser's (status, content type, body, DOM model, masks),
 * route keys of paired steps, target console errors legacy did not raise (as a multiset), and target XHRs that
 * bypassed `ownOrigin`.
 */
function browserDifferences(
  legacy: BrowserSide,
  target: BrowserSide,
  scenario: Scenario,
  rules: NormaliseRules,
  ownOrigin: string,
): Difference[] {
  const found = compareNormalised(
    goldenRun({ steps: legacy.steps, sideEffects: EMPTY_SIDE_EFFECTS }),
    goldenRun({ steps: target.steps, sideEffects: EMPTY_SIDE_EFFECTS }),
    { rules, scenario },
  );
  const legacyKeys = new Map(legacy.steps.map((step) => [`${step.index}|${step.name}`, step.routeKey]));
  for (const step of target.steps) {
    const expected = legacyKeys.get(`${step.index}|${step.name}`);
    if (expected !== undefined && expected !== step.routeKey) {
      found.push(difference(step.name, 'routeKey', 'changed', expected, step.routeKey));
    }
  }
  const remaining = new Map<string, number>();
  for (const message of legacy.console) remaining.set(message, (remaining.get(message) ?? 0) + 1);
  target.console.forEach((message, i) => {
    const left = remaining.get(message) ?? 0;
    if (left > 0) remaining.set(message, left - 1);
    else found.push(difference(CONSOLE_STEP, `console[${i}]`, 'extra', undefined, message));
  });
  for (const { step, origin } of target.foreignOrigins) {
    found.push(difference(step, 'request.origin', 'changed', ownOrigin, origin));
  }
  return found;
}

/** compare.ts's verdict on a browser record. */
function verdictOf(suite: Suite, scenario: Scenario, record: Record<string, unknown>): ScenarioVerdict {
  if (suite.decisionList === undefined) throw new Error('the decision list was not loaded for this phase');
  return classifyScenario(null, null, {
    scenario,
    exceptions: suite.exceptions,
    rules: suite.rules,
    decisionList: suite.decisionList,
    fixtures: readFixtureStatus(),
    browser: browserRecordSchema.parse(record),
  });
}

/** Failure text of a verdict: its reason and the first differences. */
function describeVerdict(id: ScenarioId, verdict: ScenarioVerdict): string {
  const shown = verdict.differences.slice(0, DIFFERENCES_SHOWN).map((d) => JSON.stringify(d));
  const more = verdict.differences.length - shown.length;
  return [
    `${id}: ${verdict.result}${verdict.reason === null ? '' : ` (${verdict.reason})`}`,
    ...shown,
    ...(more > 0 ? [`… and ${more} more`] : []),
  ].join('\n');
}

const REPORT = { generatedBy: GENERATED_BY } as const;

/** Capture against legacy: the committed golden set when it validates, else the state-directory fallback. */
async function captureFlow(suite: Suite, id: ScenarioId, scenario: Scenario): Promise<void> {
  const side = await runFlow(suite, scenario, id, 'legacy');
  const { available, reason } = readFixtureStatus();
  const set: GoldenSet = {
    sourceSha: pinnedSha(),
    scenarioId: id,
    capturedAt: new Date().toISOString(),
    origin: 'legacy',
    tableVersion: null,
    fixtures: { available, reason },
    steps: side.steps,
    sideEffects: EMPTY_SIDE_EFFECTS,
  };
  const parsed = goldenSetSchema.safeParse(set);
  const issues = parsed.success
    ? undefined
    : parsed.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; ');
  if (side.error === undefined && issues === undefined) {
    await writeJsonReport(goldenSetPath(id), { ...set }, REPORT);
    await rm(fallbackPath(id), { force: true });
  } else {
    await writeJsonReport(fallbackPath(id), { ...set, error: side.error, schemaIssues: issues }, REPORT);
  }
  expect(side.error, `${id} capture failed at ${side.error?.step ?? ''}: ${side.error?.message ?? ''}`).toBeUndefined();
  expect(issues, `${id} golden set does not match its schema`).toBeUndefined();
}

/** Replay through the gateway against the capture, written where compare.ts reads browser records. */
async function replayFlow(suite: Suite, id: ScenarioId, scenario: Scenario): Promise<void> {
  const legacy = await capturedSide(id);
  const target = await runFlow(suite, scenario, id, 'gateway');
  const gatewayOrigin = new URL(originBaseUrl('gateway')).origin;
  const differences = browserDifferences(legacy, target, scenario, suite.rules, gatewayOrigin);
  const record: BrowserReplayRecord = {
    sourceSha: pinnedSha(),
    scenarioId: id,
    replayedAt: new Date().toISOString(),
    origin: 'gateway',
    tableVersion: suite.activeVersion,
    steps: target.steps,
    sideEffects: EMPTY_SIDE_EFFECTS,
    halted: [],
    differences,
    console: target.console,
    notes: target.notes,
    foreignOrigins: target.foreignOrigins,
  };
  if (target.error !== undefined) record.error = target.error;
  const verdict = await classifyAndWrite(suite, scenario, browserResultPath(id), { ...record });
  expect(ACCEPTED_RESULTS.has(verdict.result), describeVerdict(id, verdict)).toBe(true);
}

/** Legacy direct, then the gateway, compared in memory; written to the state directory only. */
async function unsetFlow(suite: Suite, id: ScenarioId, scenario: Scenario): Promise<void> {
  const legacy = await runFlow(suite, scenario, id, 'legacy');
  const target = await runFlow(suite, scenario, id, 'gateway');
  const gatewayOrigin = new URL(originBaseUrl('gateway')).origin;
  const differences = browserDifferences(legacy, target, scenario, suite.rules, gatewayOrigin);
  const error = legacy.error ?? target.error;
  const failedSide = error === legacy.error ? 'legacy' : 'gateway';
  const record: Record<string, unknown> = {
    sourceSha: pinnedSha(),
    scenarioId: id,
    comparedAt: new Date().toISOString(),
    tableVersion: suite.activeVersion,
    legacy,
    gateway: target,
    steps: [...legacy.steps, ...target.steps],
    halted: [],
    differences,
    ...(error === undefined ? {} : { error: { ...error, message: `${failedSide}: ${error.message}` } }),
  };
  const verdict = await classifyAndWrite(suite, scenario, unsetPath(id), record);
  expect(ACCEPTED_RESULTS.has(verdict.result), describeVerdict(id, verdict)).toBe(true);
}

/** Classifies `record`, writes it with the verdict's result and returns the verdict; it is written either way. */
async function classifyAndWrite(
  suite: Suite,
  scenario: Scenario,
  file: string,
  record: Record<string, unknown>,
): Promise<ScenarioVerdict> {
  let verdict: ScenarioVerdict;
  try {
    verdict = verdictOf(suite, scenario, record);
  } catch (err) {
    await writeJsonReport(file, record, REPORT);
    throw err;
  }
  await writeJsonReport(file, { ...record, result: verdict.result }, REPORT);
  return verdict;
}

/** Lower-cased person ids and usernames reserved for the rollback rehearsal. */
function reservedIdentities(seed: SeedStore): string[] {
  const rehearsal = seed.select({ as: 'rehearsal', source: 'reserved', path: 'reserved.rehearsal' });
  if (typeof rehearsal !== 'object' || rehearsal === null) {
    throw new GoldenConfigError('reserved.rehearsal in the seed config is not an object');
  }
  const { persons, usernames } = rehearsal as Record<string, unknown>;
  return [persons, usernames]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .map((value) => value.toLowerCase());
}

/** Throws for a rehearsal scenario, or one whose seedRefs, browser block or seed rows reach a reserved identity. */
function assertNoRehearsalIdentity(scenario: Scenario, rows: readonly unknown[], reserved: readonly string[]): void {
  const refuse = (why: string): never => {
    throw new GoldenConfigError(`${scenario.id} ${why}; only the GS-PE-RH scenarios may`, {
      path: `scenario ${scenario.id}`,
    });
  };
  if (isRehearsalScenario(scenario.id)) refuse('is a rollback-rehearsal scenario');
  if (scenario.seedRefs.some((ref) => ref.source === 'reserved')) refuse('binds a reserved seed path');
  const reach = JSON.stringify({ seedRefs: scenario.seedRefs, browser: scenario.browser, rows }).toLowerCase();
  const hit = reserved.find((value) => reach.includes(value));
  if (hit !== undefined) refuse(`reaches reserved rehearsal identity ${hit}`);
}

/** Every GS-UI scenario, checked: a browser block naming its flow, and no reserved rehearsal identity. */
function resolveScenarios(
  catalogue: Awaited<ReturnType<typeof loadCatalogue>>,
  phase: Phase,
  secrets: SecretStore,
  seed: SeedStore,
): Map<ScenarioId, Scenario> {
  const reserved = reservedIdentities(seed);
  const origin: Origin = phase === 'replay' ? 'gateway' : 'legacy';
  const scenarios = new Map<ScenarioId, Scenario>();
  for (const id of SCENARIO_IDS) {
    const scenario = scenarioById(catalogue, id);
    if (scenario.browser === undefined) {
      throw new GoldenConfigError(`${id} has no browser block in the catalogue`, { path: `scenario ${id}` });
    }
    if (scenario.browser.flow !== FLOW_NAMES[id]) {
      throw new GoldenConfigError(`${id} names browser flow ${scenario.browser.flow}, expected ${FLOW_NAMES[id]}`, {
        path: `scenario ${id}`,
      });
    }
    const ctx = createScenarioContext(scenario, { origin, secrets, seed });
    assertNoRehearsalIdentity(scenario, [...ctx.seedRows.values()], reserved);
    scenarios.set(id, scenario);
  }
  return scenarios;
}

const rawPhase = process.env[PHASE_VARIABLE];
const DESCRIBE_TITLES: Readonly<Record<Phase, string>> = {
  capture: 'browser interactions: capture against legacy (v0001)',
  replay: 'browser interactions: replay through the gateway (v0002)',
  unset: 'browser interactions: legacy and the gateway compared (v0001)',
};
// An invalid phase value takes the unset title here and fails in beforeAll.
const DESCRIBE_TITLE = DESCRIBE_TITLES[rawPhase === 'capture' || rawPhase === 'replay' ? rawPhase : 'unset'];

describe(DESCRIBE_TITLE, () => {
  let suite: Suite | undefined;

  beforeAll(async () => {
    const phase = parsePhase(rawPhase);
    const catalogue = await loadCatalogue();
    const rules = loadRules();
    const secrets = loadSecretStore();
    const seed = loadSeedStore();
    const scenarios = resolveScenarios(catalogue, phase, secrets, seed);
    const activeVersion = await activeTableVersion();
    if (activeVersion !== REQUIRED_VERSION[phase]) {
      throw new Error(
        `${PHASE_VARIABLE}=${rawPhase ?? ''} (${phase}) needs cut-over table ${REQUIRED_VERSION[phase]}; ` +
          `the gateway has ${activeVersion ?? 'none'} active`,
      );
    }
    const decisionList = phase === 'capture' ? undefined : await loadDecisionList();
    const exceptions = phase === 'capture' ? [] : exceptionEntries(await loadExceptionsList());
    const screenshots = path.join(stateDir(), 'screenshots');
    await mkdir(screenshots, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    suite = { phase, rules, secrets, seed, scenarios, activeVersion, exceptions, screenshots, browser };
    if (decisionList !== undefined) suite.decisionList = decisionList;
  });

  afterAll(async () => {
    await suite?.browser.close();
  });

  /** Runs scenario `id` in the selected phase. */
  async function runScenario(id: ScenarioId): Promise<void> {
    if (suite === undefined) throw new Error('beforeAll did not complete');
    const scenario = suite.scenarios.get(id);
    if (scenario === undefined) throw new Error(`${id} was not resolved from the catalogue`);
    if (suite.phase === 'capture') await captureFlow(suite, id, scenario);
    else if (suite.phase === 'replay') await replayFlow(suite, id, scenario);
    else await unsetFlow(suite, id, scenario);
  }

  // Literal titles, so the static listing of `vitest list` shows each test.
  it('GS-UI-01 Site Manager tree expand, page and move matches legacy', () => runScenario('GS-UI-01'));
  it('GS-UI-02 edit panels and status-modal approval matches legacy', () => runScenario('GS-UI-02'));
  it('GS-UI-03 multi-file upload matches legacy', () => runScenario('GS-UI-03'));
  it('GS-UI-04 version diff fragment matches legacy', () => runScenario('GS-UI-04'));
  it('GS-UI-05 inline quick-edit save matches legacy', () => runScenario('GS-UI-05'));
});

