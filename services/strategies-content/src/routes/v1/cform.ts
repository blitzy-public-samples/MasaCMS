/** cform admin routes: the form-builder dialog, bean and template responses, the form zip export and Import Form. */
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { promisify } from 'node:util';
import { crc32, deflateRaw, inflateRaw } from 'node:zlib';
import { LegacyServiceUnavailableError, cfDateFormat } from '@opt2/platform/legacy-compat';
import {
  IDENTITY_SERVICE,
  LEGACY_POST_LIMIT_BYTES,
  ServiceUnavailableError,
  legacyParamsOf,
  multipartFilesOf,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { Actor } from '../../domain/context.js';
import { cformDatasetBean, cformFieldBean, cformFieldTypeBean, cformFormBean, getActiveForm, getForms } from '../../domain/forms.js';
import {
  CformRequestError,
  acfStructKeyOrder,
  createAdminLabels,
  datasetBeanJson,
  fieldBeanJson,
  fieldTypeBeanJson,
  formBeanJson,
  renderCformResponse,
  renderFormBuilderTemplate,
  templateListsForms,
  type AdminLabels,
  type AdminRenderResult,
  type NestedFormRow,
} from '../../legacy/admin-render.js';
import { acfSerializeJson } from '../../legacy/cfjson.js';
import type { ContentRouteContext } from '../index.js';
import { adminCsrf, circuitRouteConfig, csrfRejected, requireCircuitAccess, type AdminWriteResult } from './access.js';

/** A raw cform action as `./raw.ts` runs it once the circuit gate admitted `actor`; none validates a CSRF token. */
interface CformRawAction {
  run(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<AdminRenderResult>;
}

type Params = Record<string, unknown>;

/** `arguments.rc.<key>` as text; a missing key fails as ACF fails reading it. */
function rcText(params: Params, key: string): string {
  const name = Object.keys(params).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  const value = name === undefined ? undefined : params[name];
  if (value === undefined) throw new CformRequestError(`Element RC.${key} is undefined in ARGUMENTS.`);
  if (typeof value !== 'string') throw new CformRequestError('Complex object types cannot be converted to simple values.');
  return value;
}

const FORM_MEDIA_TYPES: readonly string[] = ['application/x-www-form-urlencoded', 'multipart/form-data'];

/** The field names of ColdFusion's `form` scope: url-encoded and multipart bodies only. */
function formScopeKeys(request: FastifyRequest): string[] {
  const mediaType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const body = request.body;
  if (!FORM_MEDIA_TYPES.includes(mediaType) || typeof body !== 'object' || body === null) return [];
  return Object.keys(body);
}

/** Whether the `form` scope holds `key`, ignoring case. */
function formScopeHas(request: FastifyRequest, key: string): boolean {
  return formScopeKeys(request).some((name) => name.toLowerCase() === key.toLowerCase());
}

/** `form.<key>` as text (the merged value, in which the body wins); a missing field fails as ACF fails reading it. */
function formField(request: FastifyRequest, key: string): string {
  if (!formScopeHas(request, key)) throw new CformRequestError(`Element ${key.toUpperCase()} is undefined in FORM.`);
  return rcText(legacyParamsOf(request), key);
}

// ---- session labels (resourceBundleFactory.cfc, resourceBundle.cfc) ----

/** identity's store of the admin session values of the token's session. */
const ADMIN_STATE_PATH = '/v1/sessions/current/admin-state';
const EN_US = 'en_US';
// setAdminLocale's `session.rb` when nothing set it: configBean `defaultLocale` "Server" is the JVM locale, en_US.
const DEFAULT_RB = EN_US;
// application.rbFactory's directory, read from the pinned release beside this service.
const BUNDLE_DIR = new URL('../../../../../core/mura/resourceBundle/resources/', import.meta.url);
const bundles = new Map<string, Promise<Readonly<Record<string, string>>>>();

/** `session.rb` of the verified session, as identity stores it; the 503 when identity cannot answer. */
async function sessionRb(request: FastifyRequest): Promise<string> {
  const response = await request.server.opt2.client.request<{ rb?: unknown } | undefined>({
    service: IDENTITY_SERVICE,
    method: 'GET',
    path: ADMIN_STATE_PATH,
  });
  if (response.status !== 200) {
    const cause = Object.assign(new Error(`${IDENTITY_SERVICE} answered HTTP ${String(response.status)}`), {
      code: `HTTP_${String(response.status)}`,
    });
    throw new ServiceUnavailableError(IDENTITY_SERVICE, cause);
  }
  const rb = response.body?.rb;
  return typeof rb === 'string' && rb !== '' ? rb : DEFAULT_RB;
}

/** `application.rbFactory` labels of the session locale, with the en_US bundle consulted only for another locale. */
async function sessionLabels(request: FastifyRequest): Promise<AdminLabels> {
  const rb = await sessionRb(request);
  const fallback = rb.toLowerCase() === EN_US.toLowerCase() ? {} : await localeBundle(EN_US);
  return createAdminLabels(await localeBundle(rb), fallback);
}

/** resourceBundle.init(locale)'s keys, loaded once per locale. */
function localeBundle(locale: string): Promise<Readonly<Record<string, string>>> {
  let bundle = bundles.get(locale);
  if (bundle === undefined) {
    bundle = loadBundle(locale);
    bundles.set(locale, bundle);
    void bundle.catch(() => bundles.delete(locale));
  }
  return bundle;
}

/** loadResourceBundle: `<locale>.properties`, else `<language>.properties`, else no keys. */
async function loadBundle(locale: string): Promise<Readonly<Record<string, string>>> {
  const language = locale.split('_').find((part) => part !== '') ?? '';
  for (const name of [locale, language]) {
    const bytes = await bundleFile(name);
    if (bytes !== null) return parseBundle(bytes);
  }
  return {};
}

/** The bytes of `<name>.properties` in the bundle directory, or null when it does not exist. */
async function bundleFile(name: string): Promise<Buffer | null> {
  if (name === '' || /[/\\\0]/.test(name)) return null;
  try {
    return await readFile(new URL(`${encodeURIComponent(name)}.properties`, BUNDLE_DIR));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** A bundle file's keys (lower-cased) as loadResourceBundle reads it; a file holding `\u00` is first rewritten by convertToUTF. */
function parseBundle(bytes: Buffer): Record<string, string> {
  const text = bytes.toString('utf8');
  return lineBundle(text.includes('\\u00') ? convertedProperties(bytes) : text);
}

/** The line reader: `#` lines and lines without two `=`-delimited elements skipped; key = listFirst, value = listRest. */
function lineBundle(text: string): Record<string, string> {
  const bundle: Record<string, string> = {};
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('#') || line.split('=').filter((part) => part !== '').length < 2) continue;
    const key = (line.replace(/^=+/, '').split('=')[0] ?? '').replace(/[^a-zA-Z0-9_\-.]/g, '');
    bundle[key.toLowerCase()] = line.replace(/^=*[^=]*=*/, '');
  }
  return bundle;
}

/** convertToUTF's rewrite: the PropertyResourceBundle reading as `key=value` CRLF lines in sorted key order. */
function convertedProperties(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // PropertyResourceBundle reads a file that is not valid UTF-8 as ISO-8859-1.
    text = bytes.toString('latin1');
  }
  const properties = javaProperties(text);
  return [...properties.keys()]
    .sort()
    .map((key) => `${key}=${properties.get(key) ?? ''}\r\n`)
    .join('');
}

/** java.util.Properties.load: logical lines, separators and escapes; a later key wins. */
function javaProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r\n|\r|\n/);
  const trailingBackslashes = (s: string): number => s.length - s.replace(/\\+$/, '').length;
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? '').replace(/^[ \t\f]+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    while (trailingBackslashes(line) % 2 === 1) {
      line = line.slice(0, -1);
      if (i + 1 >= lines.length) break;
      i += 1;
      line += (lines[i] ?? '').replace(/^[ \t\f]+/, '');
    }
    let keyEnd = 0;
    let escaped = false;
    while (keyEnd < line.length && (escaped || !/[=: \t\f]/.test(line.charAt(keyEnd)))) {
      escaped = !escaped && line.charAt(keyEnd) === '\\';
      keyEnd += 1;
    }
    let valueStart = keyEnd;
    let separated = /[=:]/.test(line.charAt(keyEnd));
    if (keyEnd < line.length) valueStart += 1;
    while (valueStart < line.length && /[ \t\f=:]/.test(line.charAt(valueStart))) {
      if (/[=:]/.test(line.charAt(valueStart))) {
        if (separated) break;
        separated = true;
      }
      valueStart += 1;
    }
    out.set(unescapeProperty(line.slice(0, keyEnd)), unescapeProperty(line.slice(valueStart)));
  }
  return out;
}

const PROPERTY_ESCAPES: Readonly<Record<string, string>> = { t: '\t', n: '\n', r: '\r', f: '\f' };

/** Properties.loadConvert: `\uXXXX`, `\t`, `\n`, `\r`, `\f`, and any other escaped character as itself. */
function unescapeProperty(text: string): string {
  return text.replace(/\\(u(.{0,4})|[\s\S])/g, (_match, escape: string, hex: string | undefined) => {
    if (hex === undefined) return PROPERTY_ESCAPES[escape] ?? escape;
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Malformed \\uxxxx encoding.');
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

// ---- zip archives (mura.Zip over java.util.zip) ----

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
// ZipOutputStream: sizes follow the data (bit 3) and names are UTF-8 (bit 11).
const ZIP_FLAGS = 0x0808;
const DEFLATED = 8;
const STORED = 0;
/** The leading signatures of a zip archive: an entry, an empty archive, a spanned archive. */
const ZIP_MAGIC = [LOCAL_SIGNATURE, END_SIGNATURE, DESCRIPTOR_SIGNATURE] as const;
const deflateRawAsync = promisify(deflateRaw);
const inflateRawAsync = promisify(inflateRaw);

/** Java's DOS date and time of `at` in the process time zone; earlier than 1980 is 1980-01-01. */
function dosDateTime(at: Date): { time: number; date: number } {
  if (at.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/** mura.Zip.AddFiles of one file: ZipOutputStream at level 9 writing `name` deflated, stamped `at`. */
async function zipOne(name: string, data: Buffer, at: Date): Promise<Buffer> {
  const nameBytes = Buffer.from(name, 'utf8');
  const deflated = await deflateRawAsync(data, { level: 9 });
  const crc = crc32(data);
  const { time, date } = dosDateTime(at);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_SIGNATURE, 0);
  local.writeUInt16LE(ZIP_VERSION, 4);
  local.writeUInt16LE(ZIP_FLAGS, 6);
  local.writeUInt16LE(DEFLATED, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt16LE(nameBytes.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(deflated.length, 8);
  descriptor.writeUInt32LE(data.length, 12);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  central.writeUInt16LE(ZIP_VERSION, 4);
  central.writeUInt16LE(ZIP_VERSION, 6);
  central.writeUInt16LE(ZIP_FLAGS, 8);
  central.writeUInt16LE(DEFLATED, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + deflated.length + descriptor.length, 16);
  return Buffer.concat([local, nameBytes, deflated, descriptor, central, nameBytes, end]);
}

/** Whether `bytes` open as a zip archive, the content check of `fileUpload(…, "application/zip")`. */
function isZipArchive(bytes: Buffer): boolean {
  return bytes.length >= 4 && ZIP_MAGIC.some((signature) => bytes.readUInt32LE(0) === signature);
}

/**
 * The file mura.Zip.Extract leaves at `name` in the extraction folder: the last central-directory entry resolving to it.
 * Undefined when none does, when an entry name climbs out (isZipSafe refuses the archive), or when the archive cannot be
 * read or its matching entries together inflate past the post limit, because Extract catches every failure and the
 * following fileRead then finds no file.
 */
async function extractedFile(zip: Buffer, name: string): Promise<Buffer | undefined> {
  try {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) return undefined;
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    const entries: Array<{ name: string; method: number; size: number; local: number }> = [];
    for (let i = 0; i < count; i++) {
      if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return undefined;
      const nameLength = zip.readUInt16LE(offset + 28);
      entries.push({
        name: zip.toString('utf8', offset + 46, offset + 46 + nameLength),
        method: zip.readUInt16LE(offset + 10),
        size: zip.readUInt32LE(offset + 20),
        local: zip.readUInt32LE(offset + 42),
      });
      offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
    if (entries.some((entry) => /\.\.[/\\]/.test(entry.name))) return undefined;
    let found: Buffer | undefined;
    let remaining = LEGACY_POST_LIMIT_BYTES;
    for (const entry of entries) {
      if (posix.normalize(entry.name.replaceAll('\\', '/')).replace(/^\/+/, '') !== name) continue;
      const start = entry.local + 30 + zip.readUInt16LE(entry.local + 26) + zip.readUInt16LE(entry.local + 28);
      const data = zip.subarray(start, start + entry.size);
      if (entry.method === STORED) found = data;
      else if (entry.method === DEFLATED) {
        // maxOutputLength must be at least 1, so the length check enforces an exhausted budget.
        found = await inflateRawAsync(data, { maxOutputLength: Math.max(remaining, 1) });
        if (found.length > remaining) return undefined;
        remaining -= found.length;
      } else return found;
    }
    return found;
  } catch {
    return undefined;
  }
}

// ---- actions (cform.cfc:88-210) ----

/** The forms field-nested.cfm lists: the session site's active forms without the posted `form.formid`; undefined without one. */
async function nestedForms(
  request: FastifyRequest,
  ctx: ContentRouteContext,
  actor: Actor,
  template: string,
): Promise<NestedFormRow[] | undefined> {
  if (!templateListsForms(template) || !formScopeHas(request, 'formid')) return undefined;
  return getForms(ctx.domain, actor, actor.siteId, formField(request, 'formid'));
}

/** getDialog and getFieldTemplate: the template `rc[key]` names through html.cfm. */
async function templateResponse(
  request: FastifyRequest,
  ctx: ContentRouteContext,
  actor: Actor,
  key: 'dialog' | 'fieldtype',
): Promise<AdminRenderResult> {
  const template = rcText(legacyParamsOf(request), key);
  const labels = await sessionLabels(request);
  return renderCformResponse('html', renderFormBuilderTemplate(template, labels, await nestedForms(request, ctx, actor, template)));
}

const EXPORT_CONTENT_TYPE = 'application/zip';
const EXPORT_ENTRY = 'form.json';

// Legacy zips every *.json file of ColdFusion's temp directory beside the form.json it writes there; only form.json is
// the export, so the archive holds that one entry.
/** cform.export with export.cfm: the active form's body, responseMessage and responseSendTo as form.json in a zip. */
async function exportForm(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<AdminRenderResult> {
  const contentId = rcText(legacyParamsOf(request), 'contentid');
  const bean = await getActiveForm(ctx.domain, actor, contentId, actor.siteId);
  // `formJSON = {}` then dot-notation assignments: an unordered struct of upper-cased keys.
  const keys = acfStructKeyOrder(['BODY', 'RESPONSEMESSAGE', 'RESPONSESENDTO']);
  const formJson = acfSerializeJson(Object.fromEntries(keys.map((key) => [key, bean.get(key)])));
  const now = ctx.clock.now();
  const title = bean.text('title').toLowerCase().replace(/[^a-zA-Z0-9]+/g, '_');
  const zipTitle = `${title}_${cfDateFormat(now, 'yyyy_dd_mm')}_${actor.siteId}`;
  return {
    status: 200,
    contentType: EXPORT_CONTENT_TYPE,
    body: await zipOne(EXPORT_ENTRY, Buffer.from(formJson, 'utf8'), now),
    headers: { 'Content-disposition': `attachment;filename=${zipTitle}.zip` },
  };
}

/** The raw cform actions under `/v1/raw/cform/<action>`, keyed by the contract's action segments. */
export const cformRawActions = {
  export: { run: exportForm },
  getdataset: {
    run: async (request) => renderCformResponse('json', datasetBeanJson(cformDatasetBean(legacyParamsOf(request)))),
  },
  getdialog: { run: (request, ctx, actor) => templateResponse(request, ctx, actor, 'dialog') },
  getfield: {
    run: async (request) => {
      const input = cformFieldBean(legacyParamsOf(request));
      return renderCformResponse('json', fieldBeanJson(input, await sessionLabels(request)));
    },
  },
  getfieldtemplate: { run: (request, ctx, actor) => templateResponse(request, ctx, actor, 'fieldtype') },
  getfieldtype: {
    run: async (request) => renderCformResponse('json', fieldTypeBeanJson(cformFieldTypeBean(legacyParamsOf(request)))),
  },
  getform: { run: async (request) => renderCformResponse('json', formBeanJson(cformFormBean(legacyParamsOf(request)))) },
} satisfies Record<string, CformRawAction>;

// ---- Import Form (cform.cfc:110-159) ----

const IMPORT_PATH = '/v1/sites/:siteid/forms/import';
const IMPORT_CSRF_CONTEXT = 'formimport';
const INVALID_TOKEN_ALERT = 'Invalid security token. Please try again.';
const TITLE_REQUIRED = 'Title is required';
const NOT_A_FORM = 'Upload did not contain an exported Masa CMS Form';
const EXPORTED_FIELDS = ['body', 'responseMessage', 'responseSendTo'] as const;

/** The view re-rendered with nothing saved, carrying the `rc` values importform set. */
function rerender(data?: Record<string, string>): AdminWriteResult {
  return { saved: false, errors: {}, redirect: null, ...(data === undefined ? {} : { data }) };
}

/** Both `fileUpload` calls of `formzip`: the part's bytes, which must be a zip archive. */
async function uploadedZip(request: FastifyRequest): Promise<Buffer> {
  const part = multipartFilesOf(request).find((file) => file.field.toLowerCase() === 'formzip');
  if (part === undefined) throw new CformRequestError('The form field formzip did not contain a file.');
  const bytes = await buffer(part.stream());
  if (!isZipArchive(bytes)) {
    throw new CformRequestError(`The MIME type or the Extension of the uploaded file ${part.mimetype} was not accepted by the server.`);
  }
  return bytes;
}

/**
 * cform.importform's POST: CSRF context `formimport` checked only for a non-empty `formzip`, then the upload, title and
 * form.json checks legacy makes before saving the new Form.
 */
async function importForm(request: FastifyRequest, reply: FastifyReply, app: FastifyInstance): Promise<AdminWriteResult> {
  if (formScopeKeys(request).length === 0 || formField(request, 'formzip') === '') return rerender();
  await adminCsrf(() => IMPORT_CSRF_CONTEXT).call(app, request, reply);
  if (csrfRejected(request)) return rerender({ alert: INVALID_TOKEN_ALERT });
  const zip = await uploadedZip(request);
  if (formField(request, 'title') === '') return rerender({ errormessage: TITLE_REQUIRED });
  const file = await extractedFile(zip, EXPORT_ENTRY);
  if (file === undefined) throw new CformRequestError(`The file ${EXPORT_ENTRY} does not exist.`);
  let exported: unknown;
  try {
    exported = JSON.parse(file.toString('utf8'));
  } catch {
    return rerender({ errormessage: NOT_A_FORM });
  }
  const struct = typeof exported === 'object' && exported !== null && !Array.isArray(exported) ? Object.keys(exported) : undefined;
  for (const key of EXPORTED_FIELDS) {
    if (!struct?.some((name) => name.toLowerCase() === key.toLowerCase())) {
      throw new CformRequestError(`Element ${key.toUpperCase()} is undefined in FORMSTRUCT.`);
    }
  }
  // contentManager.add reads the site's URL, locking and region settings (programs-sites data), which no verified source
  // of this service holds, so the new Form is not saved on guessed values.
  throw new LegacyServiceUnavailableError('Form import needs site settings this service does not hold', 'auto', 'form-import-site-settings');
}

/** cform admin routes: form-builder dialog, bean and template responses. */
export async function registerFormRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  app.post<{ Params: { siteid: string }; Reply: AdminWriteResult }>(
    IMPORT_PATH,
    { config: circuitRouteConfig('cform') },
    async (request, reply) => {
      await requireCircuitAccess(request, ctx, 'cform', request.params.siteid);
      return importForm(request, reply, app);
    },
  );
}
