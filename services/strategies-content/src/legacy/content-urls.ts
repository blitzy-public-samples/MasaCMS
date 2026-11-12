/**
 * Masa content filename, URL-title, materialized-path and URL rules (contentUtility, contentManager,
 * contentRendererUtility, contentServer, fileManager, settingsBean). Pure: every uniqueness check and stored-file
 * lookup is a caller-supplied predicate. Notes marked "ACF" were observed on Adobe ColdFusion 2023.0.26.
 */
import {
  LEGACY_ADMIN_SENTINEL_ID,
  cfEq,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import type { ContentRow, FileRow } from '../repo/tables.js';

/** Site and global values the legacy URL getters read; the route layer builds it from the site projection and env. */
export interface LegacySiteUrlConfig {
  siteId: string;
  /** settingsBean `getScheme()`: `https` when the site uses SSL or the request arrived over HTTPS. */
  scheme: 'http' | 'https';
  /** settingsBean `domain`, the site's primary domain. */
  domain: string;
  /**
   * Host `getWebPath` resolves when given none (settingsBean.cfc:1440-1448): `domain` for a remote site, else
   * `cgi.server_name` when it is a valid site domain and `enforcePrimaryDomain` is off, else `domain`.
   */
  requestDomain: string;
  /** `request.muraPreviewDomain` when it is a valid domain of the site (admin requests set it), else ''. */
  previewDomain: string;
  /** settingsBean `getServerPort()`: '' or `:<port>`. */
  serverPort: string;
  /** settingsBean `getContext()`. */
  context: string;
  /** The site renderer's resolved `siteIDInURLS` (false for a remote site). */
  siteIdInUrls: boolean;
  /** The site renderer's resolved `indexFileInURLS` (false for a remote site). */
  indexFileInUrls: boolean;
  hashUrls: boolean;
  /** settingsBean `getUseSSL()` (`useSSL` or `extranetSSL`). */
  useSSL: boolean;
  filePoolId: string;
  /**
   * configBean `fileAssetPath`, '' when unset. The site's `getFileAssetPath` is derived from it rather than passed in,
   * because that value changes with `complete` and `secure`.
   */
  configFileAssetPath: string;
  /** configBean `getAssetPath()`; a URL value prefixes direct image URLs. */
  assetPath: string;
  /** configBean `getSiteAssetPath()`, e.g. `/sites`. */
  siteAssetPath: string;
  /** configBean `fileStore`: `fileDir`, `s3` or `database`. */
  fileStore: string;
  legacyIndexFileLocation: boolean;
  /** configBean `getURLTitleDelim()`, Masa default `-`. */
  urlTitleDelim: string;
  allowUnicodeInFilenames: boolean;
  placeholderImgId: string;
  placeholderImgExt: string;
  /** The site renderer's `directImages` (contentRenderer.cfc:95, default true). */
  directImages: boolean;
  /** Remote site with a `resourceDomain`: asset URLs use it with configBean `serverPort` and `context`. */
  resource?: { domain: string; ssl: boolean; serverPort: string; context: string };
}

/** The configBean values the filename rules read. */
export type FilenameRules = Pick<LegacySiteUrlConfig, 'urlTitleDelim' | 'allowUnicodeInFilenames'>;

const HOME_CONTENT_ID = LEGACY_ADMIN_SENTINEL_ID;
const IMAGE_EXTS: readonly string[] = ['jpg', 'jpeg', 'png', 'gif', 'svg'];
const RENDITION_SIZES: readonly string[] = ['small', 'medium', 'large', 'source'];
const ARCHIVED_FILENAME_TYPES: readonly string[] = ['file', 'link', 'page', 'folder', 'gallery', 'calendar'];
const DIRECT_FILE_STORES: readonly string[] = ['filedir', 's3'];
const MAX_FILENAME_LENGTH = 250;

// ACF iterates contentUtility's approximations struct in this order, which decides the case a pair keeps:
// replaceNoCase(chr(230), 'ae') runs first and also turns Æ into `ae`. ẞ (U+1E9E) does not match ß under ACF.
const APPROXIMATIONS: ReadonlyArray<readonly [RegExp, string]> = (
  [
    [230, 'ae'], [198, 'AE'], [196, 'Ae'], [228, 'ae'], [246, 'oe'], [214, 'Oe'], [252, 'ue'], [220, 'Ue'],
    [248, 'o'], [216, 'O'], [223, 'ss'], [8217, "'"], [8220, '"'], [8221, '"'], [171, '"'], [187, '"'],
  ] as const
).map(([code, replacement]) => [new RegExp(String.fromCharCode(code), 'gi'), replacement] as const);

const HTML_EDIT_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const HTML_TAG = /<[^>]*>/g;
// POSIX [[:punct:]] and [[:space:]] as ACF's regex engine matches them: ASCII only.
const POSIX_PUNCT = /[!-/:-@[-`{-~]/g;
const POSIX_SPACE = /[ \t\n\v\f\r]/g;
const FILENAME_SPACE_TOKEN = 'svphsv';

// ACF isValid('URL'), observed: trimmed; http, https, ftp or file with an RFC 2396 server authority, or an opaque
// news: URI; path characters as java.net.URI accepts them (non-ASCII allowed; space, {}, |, [] refused).
const URI_CHAR = String.raw`(?:[\w\-.!~*'();/?:@&=+$,]|%[0-9A-Fa-f]{2}|[^\x00-\x9F\s])`;
const URI_USERINFO = String.raw`(?:(?:[\w\-.!~*'();:&=+$,]|%[0-9A-Fa-f]{2}|[^\x00-\x9F\s])*@)?`;
const URI_HOST = String.raw`(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z](?:[a-z0-9-]*[a-z0-9])?\.?|\d{1,3}(?:\.\d{1,3}){3})`;
const CF_URL = new RegExp(
  String.raw`^(?:(?:https?|ftp|file)://${URI_USERINFO}${URI_HOST}(?::\d*)?(?:[/?]${URI_CHAR}*)?(?:#${URI_CHAR}*)?` +
    String.raw`|news:(?!/)${URI_CHAR}+(?:#${URI_CHAR}*)?)$`,
  'i',
);

/** CFML listFindNoCase over a lower-case list. */
function listFindNoCase(list: readonly string[], value: string): boolean {
  return list.includes(value.toLowerCase());
}

/** CFML listLast(s, '/'): empty items are skipped. */
function lastPathSegment(s: string): string {
  return cfListToArray(s, '/').at(-1) ?? '';
}

/**
 * CFML URLEncodedFormat (ACF): every character but ASCII letters and digits as `%XX` of its UTF-8 bytes.
 * legacy-compat's esapiUrlEncode is Java URLEncoder (space as `+`, `.-*_` kept), so it cannot stand in here.
 */
function cfUrlEncodedFormat(s: string): string {
  return encodeURIComponent(s).replace(/[-_.!~*'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** ACF isValid('URL', s). */
function isCfUrl(s: string): boolean {
  return CF_URL.test(javaTrim(s));
}

/** ACF `HTMLEditFormat`: drops CR and encodes `&`, `<`, `>` and `"`; `'` and non-ASCII are kept. */
export function cfHtmlEditFormat(s: string): string {
  return s.replaceAll('\r', '').replace(/[&<>"]/g, (ch) => HTML_EDIT_ENTITIES[ch] ?? ch);
}

/** contentUtility `approximate` (contentUtility.cfc:93-98, 2027-2033): letter approximations, case-insensitive as replaceNoCase. */
export function approximate(s: string): string {
  return APPROXIMATIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), s);
}

/** contentUtility `deaccent` (contentUtility.cfc:2035-2042): NFD, then Java `\p{InCombiningDiacriticalMarks}` removed. */
export function deaccent(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]+/g, '');
}

/**
 * contentUtility `urlSafeFormat` (contentUtility.cfc:2015-2025); regexes are built from `delim` as legacy builds them.
 * An empty result becomes a new upper-case CF UUID, which legacy does not lower-case.
 */
export function urlSafeFormat(str: string, delim = '-'): string {
  let s = deaccent(approximate(str)).replace(HTML_TAG, '').replaceAll("'", '');
  s = s.replace(new RegExp(`[^a-zA-Z0-9\\${delim}]`, 'g'), () => delim);
  s = s.replace(new RegExp(`\\${delim}+`, 'g'), () => delim);
  s = s.replace(new RegExp(`^${delim}`, 'g'), '').replace(new RegExp(`${delim}$`, 'g'), '');
  return s === '' ? cfUuid() : s.toLowerCase();
}

/** contentUtility `formatFilename` (contentUtility.cfc:695-726). */
export function formatFilename(filename: string, rules: FilenameRules): string {
  const delim = rules.urlTitleDelim;
  if (!rules.allowUnicodeInFilenames) return urlSafeFormat(filename, delim);
  let s = filename.replace(HTML_TAG, '').replaceAll(' ', FILENAME_SPACE_TOKEN);
  s = s.replace(new RegExp(`\\${delim}`, 'g'), FILENAME_SPACE_TOKEN).replace(POSIX_PUNCT, '');
  s = s.replaceAll(FILENAME_SPACE_TOKEN, () => delim);
  s = s.replace(new RegExp(`\\${delim}+`, 'g'), () => delim).toLowerCase();
  return s.replace(POSIX_SPACE, '');
}

/** Inputs of {@link uniqueFilename}. */
export interface UniqueFilenameInput extends FilenameRules {
  urlTitle: string;
  contentId: string;
  parentId: string;
  /** Filename of the parent's active version; '' when it has none. */
  parentFilename: string;
  /**
   * doesFileExist (contentUtility.cfc:319-337): an active Folder, Page, Calendar, Gallery, File or Link of the same
   * site other than `contentId` has this filename.
   */
  exists: (filename: string) => boolean;
}

/** Filename and URL title {@link uniqueFilename} assigns. */
export interface UniqueFilename {
  filename: string;
  urlTitle: string;
}

/** contentUtility `setUniqueFilename` (contentUtility.cfc:728-770), including its truncation quirks past 250 characters. */
export function uniqueFilename(input: UniqueFilenameInput): UniqueFilename {
  let filename = formatFilename(input.urlTitle, input);
  if (filename === '' && !cfEq(input.contentId, HOME_CONTENT_ID)) filename = '-';
  const urlTitle = filename;

  if (!cfEq(input.parentId, HOME_CONTENT_ID)) {
    let parentFilename = input.parentFilename.slice(0, MAX_FILENAME_LENGTH);
    if (parentFilename.endsWith('/')) parentFilename = input.parentFilename.slice(0, MAX_FILENAME_LENGTH - 1);
    filename = `${parentFilename}/${filename}`;
  }

  let pass = 0;
  let candidate = filename;
  while (input.exists(candidate)) {
    pass += 1;
    candidate = filename;
    if (candidate.length > MAX_FILENAME_LENGTH) {
      candidate = filename.slice(0, MAX_FILENAME_LENGTH - String(pass).length);
      if (candidate.endsWith('/')) candidate = `${candidate.slice(0, candidate.length - 2)}/`.replace('//', '/');
    }
    candidate += String(pass);
  }

  return pass > 0 ? { filename: candidate, urlTitle: lastPathSegment(candidate) } : { filename, urlTitle };
}

/** Appends 1, 2, … to `value` until `exists` is false (contentUtility.cfc:772-804). */
function appendPassUntilFree(value: string, exists: (candidate: string) => boolean): string {
  let pass = 0;
  let candidate = value;
  while (exists(candidate)) {
    pass += 1;
    candidate = `${value}${pass}`;
  }
  return candidate;
}

/**
 * contentUtility `setUniqueURLTitle` (contentUtility.cfc:772-787). `exists` is doesLoadKeyExist for `urltitle`
 * (339-377): `urltitle LIKE` the candidate, same site and module, active, other content id.
 */
export function uniqueUrlTitle(input: { urlTitle: string; exists: (urlTitle: string) => boolean }): string {
  return appendPassUntilFree(input.urlTitle, input.exists);
}

/**
 * contentUtility `setUniqueTitle` (contentUtility.cfc:789-804). `exists` is doesLoadKeyExist for `title`
 * (339-377): `title =` the candidate, same site and module, active, other content id.
 */
export function uniqueTitle(input: { title: string; exists: (title: string) => boolean }): string {
  return appendPassUntilFree(input.title, input.exists);
}

/**
 * Whether a save archives the filename in `content.filename_archive` (contentManager.cfc:1693-1698). Legacy swallows
 * any archive error (cftry), so the caller must not fail the save on an archive conflict.
 */
export function shouldArchiveFilename(row: Pick<ContentRow, 'approved' | 'type'>): boolean {
  return (row.approved ?? 0) !== 0 && listFindNoCase(ARCHIVED_FILENAME_TYPES, row.type ?? '');
}

/**
 * contentManager `setMaterializedPath` (contentManager.cfc:906-920): ids from the root down to the parent, then the
 * content id, as a CF comma list.
 * @param crumbIdsLeafFirst content ids of the parent's crumb list, parent first and root last.
 */
export function materializedPath(crumbIdsLeafFirst: readonly string[], contentId: string): string {
  return cfListAppend(crumbIdsLeafFirst.reduceRight((path, id) => cfListAppend(path, id), ''), contentId);
}

/** Inputs of {@link getWebPath}; `secure` defaults to the site's `useSSL`, as settingsBean does. */
export interface WebPathOptions {
  secure?: boolean;
  complete?: boolean;
  domain?: string;
  useProtocol?: boolean;
}

/** settingsBean `getWebPath` (settingsBean.cfc:1435-1467): the site origin plus context, or the context alone. */
export function getWebPath(site: LegacySiteUrlConfig, opts: WebPathOptions = {}): string {
  const { secure = site.useSSL, complete = false, domain = '', useProtocol = true } = opts;
  if (!secure && !complete) return site.context;
  const host = site.previewDomain || domain || site.requestDomain;
  const protocol = !useProtocol ? '//' : secure ? 'https://' : `${site.scheme}://`;
  return `${protocol}${host}${site.serverPort}${site.context}`;
}

/** settingsBean `getResourcePath` (settingsBean.cfc:1473-1497). */
function getResourcePath(site: LegacySiteUrlConfig, opts: Required<Omit<WebPathOptions, 'domain'>> & { domain: string }): string {
  const { resource } = site;
  if (resource !== undefined) {
    const protocol = !opts.useProtocol
      ? '//'
      : resource.ssl || site.useSSL
        ? 'https://'
        : `${opts.secure ? 'https' : site.scheme}://`;
    return `${protocol}${resource.domain}${resource.serverPort}${resource.context}`;
  }
  if (!opts.complete) return site.context;
  return getWebPath(site, { ...opts, domain: site.previewDomain || opts.domain || site.requestDomain });
}

/** settingsBean `getFileAssetPath` (settingsBean.cfc:751-757): the file pool's asset URL. */
export function getFileAssetPath(site: LegacySiteUrlConfig, opts: Omit<WebPathOptions, 'domain'> = {}): string {
  if (site.configFileAssetPath !== '') return `${site.configFileAssetPath}/${site.filePoolId}`;
  const { secure = site.useSSL, complete = false, useProtocol = true } = opts;
  const resourcePath = getResourcePath(site, { secure, complete, useProtocol, domain: site.domain });
  return `${resourcePath}${site.siteAssetPath}/${site.filePoolId}`;
}

/** The URL flags {@link getUrlStem} reads. */
export type UrlStemConfig = Pick<
  LegacySiteUrlConfig,
  'siteIdInUrls' | 'indexFileInUrls' | 'hashUrls' | 'legacyIndexFileLocation' | 'siteAssetPath'
>;

/** contentServer `getURLStem` (contentServer.cfc:946-1001); export HTML (legacy-served) never applies. */
export function getUrlStem(site: UrlStemConfig, siteId: string, filename: string): string {
  let path = filename;
  if (path !== '') {
    if (!path.startsWith('/')) path = `/${path}`;
    if (!site.hashUrls && !path.endsWith('/')) path = `${path}/`;
  }
  const prefix = site.hashUrls ? '/#' : '';

  if (!site.siteIdInUrls) {
    if (path === '') return '/';
    return site.indexFileInUrls ? `/index.cfm${prefix}${path}` : `${prefix}${path}`;
  }
  if (!site.indexFileInUrls) return path === '' ? `/${siteId}/` : `/${siteId}${prefix}${path}`;
  if (site.legacyIndexFileLocation) {
    return path === '' ? `${site.siteAssetPath}/${siteId}/` : `${site.siteAssetPath}/${siteId}/index.cfm${prefix}${path}`;
  }
  return path === '' ? `/index.cfm/${siteId}/` : `/index.cfm/${siteId}${prefix}${path}`;
}

/** Inputs of {@link createHref}. */
export interface CreateHrefOptions {
  filename: string;
  contentId?: string;
  querystring?: string;
  complete?: boolean;
  secure?: boolean;
  /** Site of the request's event; a different site makes the URL complete (contentRendererUtility.cfc:1588-1596). */
  eventSiteId?: string;
  /**
   * Filename of a content id, standing in for the bean legacy loads when the caller has none: used when `filename`
   * is empty and `contentId` is set and not the home id (1621-1634).
   */
  filenameOf?: (contentId: string) => string;
}

/** The hash-URL query string `_/<name>/<value>…` (contentRendererUtility.cfc:1601-1613). */
function hashQueryString(querystring: string): string {
  let out = '_';
  for (const pair of cfListToArray(cfListToArray(querystring, '?')[0] ?? '', '&')) {
    const parts = cfListToArray(pair, '=');
    const [name] = parts;
    // Legacy reads qq[1] of the empty array, which throws.
    if (name === undefined) throw new RangeError(`The element at position 1 of the list "${pair}" cannot be found.`);
    out += `/${cfUrlEncodedFormat(name)}/${parts.length === 2 ? parts[1] : 'true'}`;
  }
  return out;
}

/**
 * contentRendererUtility `createHREF` (contentRendererUtility.cfc:1563-1660), HTML-edit-formatted as legacy returns
 * it. The content type only changes export HTML output, which stays legacy-served.
 */
export function createHref(site: LegacySiteUrlConfig, opts: CreateHrefOptions): string {
  const { contentId = '', eventSiteId = '', secure = false } = opts;
  const complete = (opts.complete ?? false) || (eventSiteId !== '' && !cfEq(eventSiteId, site.siteId));
  const begin = getWebPath(site, { secure, complete });

  let querystring = opts.querystring ?? '';
  if (querystring !== '') {
    if (site.hashUrls) querystring = hashQueryString(querystring);
    else if (!querystring.startsWith('?')) querystring = `?${querystring}`;
  }

  let filename = opts.filename;
  if (opts.filenameOf !== undefined && filename === '' && contentId !== '' && !cfEq(contentId, HOME_CONTENT_ID)) {
    filename = opts.filenameOf(contentId);
  }

  if (site.hashUrls && querystring !== '' && !filename.endsWith('/')) querystring = `/${querystring}`;

  return site.hashUrls
    ? cfHtmlEditFormat(`${begin}${getUrlStem(site, site.siteId, filename + querystring)}`)
    : cfHtmlEditFormat(`${begin}${getUrlStem(site, site.siteId, filename)}${querystring}`);
}

/** Inputs of {@link createHrefForRss}. */
export interface CreateHrefForRssOptions extends Pick<CreateHrefOptions, 'filename' | 'contentId' | 'secure' | 'filenameOf'> {
  type: string;
  showMeta?: string;
  fileExt?: string;
}

/**
 * contentRendererUtility `createHREFforRSS` (contentRendererUtility.cfc:1662-1699): Link and File items carry
 * `showMeta` (and `fileExt`); never complete, also across sites, where the other site's renderer builds it.
 */
export function createHrefForRss(site: LegacySiteUrlConfig, opts: CreateHrefForRssOptions): string {
  const { type, showMeta = '0', fileExt = '' } = opts;
  const querystring = cfEq(type, 'Link')
    ? `showMeta=${showMeta}`
    : cfEq(type, 'File')
      ? `showMeta=${showMeta}&fileExt=.${fileExt}`
      : '';
  return createHref(site, {
    filename: opts.filename,
    contentId: opts.contentId,
    secure: opts.secure,
    filenameOf: opts.filenameOf,
    querystring,
  });
}

/** contentManager `getURL` (contentManager.cfc:2742-2750): the content's link, built by its own site's renderer. */
export function contentUrl(
  site: LegacySiteUrlConfig,
  row: Pick<ContentRow, 'filename'>,
  opts: Pick<CreateHrefOptions, 'querystring' | 'complete' | 'secure'> = {},
): string {
  return createHref(site, { ...opts, filename: row.filename ?? '' });
}

/** Inputs of {@link imageUrl}. */
export interface ImageUrlOptions {
  fileId?: string;
  fileExt?: string;
  /** `undefined` (default), `small`, `medium`, `large`, `source`, `custom` (with width or height) or a custom size name. */
  size?: string;
  /** Defaults to the site renderer's `directImages`. */
  direct?: boolean;
  complete?: boolean;
  height?: string | number;
  width?: string | number;
  secure?: boolean;
  useProtocol?: boolean;
  /** fileManager `readMeta(fileID).fileEXT`, for a call that names no extension. */
  fileExtOf?: (fileId: string) => string;
  /** Whether `name` (e.g. `<fileID>_small.jpg`) exists in the file pool's `cache/file` store; absent means it exists. */
  variantExists?: (name: string) => boolean;
  /** Width and height of the file pool site's custom image size by formatted name (`timagesizes`); undefined when none. */
  customImageSize?: (name: string) => { width: string; height: string } | undefined;
}

/**
 * Name processImgCfimage `getCustomImage` (processImgCfimage.cfc:160-264) returns for a rendition, or '' where legacy
 * cannot produce one: the rendition is missing, an original exists and the size has no numeric width or height.
 * Legacy generates a missing rendition here; the target never renders image bytes and returns the same name.
 */
function customImageName(
  site: LegacySiteUrlConfig,
  fileId: string,
  fileExt: string,
  rendition: { size: string } | { width: string; height: string },
  opts: ImageUrlOptions,
): string {
  let name: string;
  let width = 'AUTO';
  let height = 'AUTO';
  if ('size' in rendition) {
    name = `${fileId}_${rendition.size.toLowerCase()}.${fileExt}`;
    const dimensions = opts.customImageSize?.(formatFilename(rendition.size, site));
    if (dimensions !== undefined) ({ width, height } = dimensions);
  } else {
    width = javaTrim(rendition.width.replace(/px/gi, ''));
    height = javaTrim(rendition.height.replace(/px/gi, ''));
    name = `${fileId}_W${width}_H${height}.${fileExt}`;
  }

  const exists = opts.variantExists ?? (() => true);
  if (!exists(name)) {
    const originalExists = exists(`${fileId}_source.${fileExt}`) || exists(`${fileId}.${fileExt}`);
    if (originalExists && !cfIsNumeric(width) && !cfIsNumeric(height)) return '';
  }
  return lastPathSegment(name.replaceAll('\\', '/'));
}

/** fileManager `createHREFForImage` (fileManager.cfc:955-1067): a direct `cache/file` URL or the `_api/render` route. */
export function imageUrl(site: LegacySiteUrlConfig, opts: ImageUrlOptions = {}): string {
  let fileId = opts.fileId ?? '';
  let fileExt = opts.fileExt ?? '';
  if (fileId === '') {
    fileId = site.placeholderImgId;
    fileExt = site.placeholderImgExt;
  }
  if (fileExt === '') fileExt = opts.fileExtOf?.(fileId) ?? '';
  if (!listFindNoCase(IMAGE_EXTS, fileExt)) return '';

  const { complete = false, secure = false, useProtocol = true, direct = site.directImages } = opts;
  const size = opts.size ?? 'undefined';

  if (!direct || !listFindNoCase(DIRECT_FILE_STORES, site.fileStore)) {
    const route = cfEq(size, 'large') || cfEq(fileExt, 'svg') ? 'file' : size;
    const webPath = getWebPath(site, { secure, complete, useProtocol });
    return `${webPath}/index.cfm/_api/render/${route}/?fileID=${fileId}&fileEXT=${fileExt}`;
  }

  const assetBase = isCfUrl(site.assetPath)
    ? `${site.assetPath}/${site.filePoolId}`
    : getFileAssetPath(site, { complete, secure, useProtocol });
  const begin = `${assetBase}/cache/file/`;
  if (cfEq(fileExt, 'svg')) return `${begin}${fileId}.${fileExt}`;

  let width = String(opts.width ?? '');
  let height = String(opts.height ?? '');
  let resolved = size;
  if (cfEq(resolved, 'undefined')) resolved = cfIsNumeric(width) || cfIsNumeric(height) ? 'Custom' : 'Large';
  if (cfEq(resolved, 'Custom')) {
    if (!cfIsNumeric(width)) width = 'auto';
    if (!cfIsNumeric(height)) height = 'auto';
    if (!cfIsNumeric(width) && !cfIsNumeric(height)) resolved = 'small';
  }

  if (listFindNoCase(RENDITION_SIZES, resolved)) {
    const suffix = cfEq(resolved, 'large') ? '' : `_${resolved.toLowerCase()}`;
    return `${begin}${fileId}${suffix}.${fileExt}`;
  }
  if (!cfEq(resolved, 'custom')) {
    const name = customImageName(site, fileId, fileExt, { size: resolved }, opts);
    return name === '' ? '' : `${begin}${name}`;
  }
  return `${begin}${customImageName(site, fileId, fileExt, { width, height }, opts)}`;
}

/** The content and file columns the image helpers read. */
export type ContentImageRow = Pick<ContentRow, 'fileid'> & Pick<FileRow, 'fileext'>;

/**
 * contentManager `getImageURL` (contentManager.cfc:2759-2781): a File with a non-image extension shows the
 * placeholder; the renderer forces its own `directImages`; an empty URL falls back to `defaultUrl`.
 */
export function contentImageUrl(
  site: LegacySiteUrlConfig,
  row: ContentImageRow & Pick<ContentRow, 'type'>,
  opts: Omit<ImageUrlOptions, 'fileId' | 'fileExt' | 'direct'> & { defaultUrl?: string } = {},
): string {
  const { defaultUrl = '', ...imageOpts } = opts;
  const nonImageFile = cfEq(row.type ?? '', 'File') && !listFindNoCase(IMAGE_EXTS, row.fileext ?? '');
  const url = imageUrl(site, {
    ...imageOpts,
    fileId: nonImageFile ? '' : (row.fileid ?? ''),
    fileExt: nonImageFile ? '' : (row.fileext ?? ''),
  });
  return url !== '' ? url : defaultUrl;
}

/** contentManager `hasImage` (contentManager.cfc:2752-2757): an image file, or a site placeholder when allowed. */
export function hasImage(
  row: ContentImageRow,
  site: Pick<LegacySiteUrlConfig, 'placeholderImgId'>,
  usePlaceholder = true,
): boolean {
  const hasImageFile = (row.fileid ?? '') !== '' && listFindNoCase(IMAGE_EXTS, row.fileext ?? '');
  return hasImageFile || (usePlaceholder && site.placeholderImgId !== '');
}
