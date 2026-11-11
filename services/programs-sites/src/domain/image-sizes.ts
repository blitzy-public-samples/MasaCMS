/** Port of Masa's site custom image size bean (settingsImageSizeBean.cfc) and the csettings image-size dialog actions. */
import { assertSiteMatches, type UserClaims } from '@opt2/platform/auth';
import { cfEq, cfIsNumeric, cfUuid, javaTrim } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import type { ProgramsSitesRepository } from '../repo/repository.js';
import type { ImageSizeRow } from '../repo/tables.js';

/** The contract's image size. */
export type ImageSize = components['schemas']['ImageSize'];

/** Instance values of `settingsImageSizeBean`, in CF string form. */
export interface ImageSizeBean {
  sizeId: string;
  siteId: string;
  name: string;
  height: string;
  width: string;
  isNew: 0 | 1;
}

/** configBean settings `formatFilename` reads; defaults `-` and false (configBean.cfc:190,205). */
export interface ImageSizeNameOptions {
  urlTitleDelim?: string;
  allowUnicodeInFilenames?: boolean;
}

/** Request values of `csettings.loadcustomimages`; keys match case-insensitively, as CFML struct keys do. */
export type ImageSizePost = Readonly<Record<string, unknown>>;

const DEFAULT_URL_TITLE_DELIM = '-';
const DEFAULT_ALLOW_UNICODE_IN_FILENAMES = false;
const AUTO = 'AUTO';

// contentUtility.approximations (contentUtility.cfc:93-98).
const APPROXIMATIONS: ReadonlyMap<string, string> = new Map([
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['ä', 'ae'],
  ['Ä', 'Ae'],
  ['ö', 'oe'],
  ['Ö', 'Oe'],
  ['ü', 'ue'],
  ['Ü', 'Ue'],
  ['ß', 'ss'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['\u2019', "'"],
  ['\u201C', '"'],
  ['\u201D', '"'],
  ['«', '"'],
  ['»', '"'],
]);
// Exact matching reproduces approximate()'s replaceNoCase: each key's case variant is itself a key, and ACF 2023 leaves ẞ unmatched.
const APPROXIMATE = new RegExp(`[${[...APPROXIMATIONS.keys()].join('')}]`, 'g');
const COMBINING_MARKS = /[\u0300-\u036F]+/g;
const HTML_TAG = /<[^>]*>/g;
const APOSTROPHE = /'/g;
const SPACE = / /g;
// The ORO engine ACF's reReplace uses reads [[:punct:]] and [[:space:]] as their ASCII POSIX classes.
const POSIX_PUNCT = /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/g;
const POSIX_SPACE = /[ \t\n\v\f\r]/g;
const PLACEHOLDER = 'svphsv';
const PLACEHOLDERS = new RegExp(PLACEHOLDER, 'g');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** `contentUtility.urlSafeFormat` (contentUtility.cfc:2015-2025) with `approximate` and `deaccent`. */
function urlSafeFormat(text: string, delim: string): string {
  const d = escapeRegExp(delim);
  const toDelim = (): string => delim;
  const safe = text
    .replace(APPROXIMATE, (c) => APPROXIMATIONS.get(c) ?? c)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(HTML_TAG, '')
    .replace(APOSTROPHE, '')
    .replace(new RegExp(`[^a-zA-Z0-9${d}]`, 'g'), toDelim)
    .replace(new RegExp(`(?:${d})+`, 'g'), toDelim)
    .replace(new RegExp(`^${d}`), '')
    .replace(new RegExp(`${d}$`), '');
  return safe === '' ? cfUuid() : safe.toLowerCase();
}

/** The unicode branch of `contentUtility.formatFilename` (contentUtility.cfc:702-721). */
function unicodeFilename(text: string, delim: string): string {
  const d = escapeRegExp(delim);
  const toDelim = (): string => delim;
  return text
    .replace(HTML_TAG, '')
    .replace(SPACE, PLACEHOLDER)
    .replace(new RegExp(d, 'g'), PLACEHOLDER)
    .replace(POSIX_PUNCT, '')
    .replace(PLACEHOLDERS, toDelim)
    .replace(new RegExp(`(?:${d})+`, 'g'), toDelim)
    .toLowerCase()
    .replace(POSIX_SPACE, '');
}

/** Port of `contentUtility.formatFilename`, which `setName` applies; an all-symbol name becomes an uppercase CF UUID unless unicode names are allowed. */
export function formatImageSizeName(name: string, opts?: ImageSizeNameOptions): string {
  const delim = opts?.urlTitleDelim ?? DEFAULT_URL_TITLE_DELIM;
  const allowUnicode = opts?.allowUnicodeInFilenames ?? DEFAULT_ALLOW_UNICODE_IN_FILENAMES;
  return allowUnicode ? unicodeFilename(name, delim) : urlSafeFormat(name, delim);
}

/** Port of `setHeight` and `setWidth`: `value` as given when CFML-numeric or `== "AUTO"`, else `current`. */
function guardedDimension(value: unknown, current: string): string {
  const text = String(value);
  return cfIsNumeric(value) || cfEq(text, AUTO) ? text : current;
}

/** A bean after `init()`: a fresh CF UUID, empty site and name, `AUTO` height and width, new. */
export function newImageSizeBean(): ImageSizeBean {
  return { sizeId: cfUuid(), siteId: '', name: '', height: AUTO, width: AUTO, isNew: 1 };
}

/** Port of `loadBy` → `set(rs)` on a stored row: setters run on the stored values, NULL reads as `''`. */
export function beanFromRow(row: ImageSizeRow, opts?: ImageSizeNameOptions): ImageSizeBean {
  return {
    sizeId: javaTrim(row.sizeid),
    siteId: javaTrim(row.siteid ?? ''),
    name: formatImageSizeName(row.name ?? '', opts),
    height: guardedDimension(row.height ?? '', AUTO),
    width: guardedDimension(row.width ?? '', AUTO),
    isNew: 0,
  };
}

/** Port of `bean.set(struct)` over the image size properties present in `data`; returns the updated copy of `bean`. */
export function applyImageSizeSet(bean: ImageSizeBean, data: ImageSizePost, opts?: ImageSizeNameOptions): ImageSizeBean {
  const next = { ...bean };
  for (const [key, value] of Object.entries(data)) {
    // set() skips NULL values, and the primary key when its value is empty (bean.cfc:333).
    if (value === null || value === undefined) {
      continue;
    }
    switch (key.toLowerCase()) {
      case 'sizeid':
        if (String(value) !== '') {
          next.sizeId = javaTrim(String(value));
        }
        break;
      case 'siteid':
        next.siteId = javaTrim(String(value));
        break;
      case 'name':
        next.name = formatImageSizeName(String(value), opts);
        break;
      case 'height':
        next.height = guardedDimension(value, next.height);
        break;
      case 'width':
        next.width = guardedDimension(value, next.width);
        break;
    }
  }
  return next;
}

/** The contract shape of `bean`. */
export function toImageSize(bean: ImageSizeBean): ImageSize {
  return {
    sizeID: bean.sizeId,
    siteID: bean.siteId,
    name: bean.name,
    height: bean.height,
    width: bean.width,
    isNew: bean.isNew,
  };
}

/** The value of `key` in `post` by case-insensitive match, the last match winning; `''` when absent or NULL. */
function postedText(post: ImageSizePost, key: string): string {
  let text = '';
  for (const [name, value] of Object.entries(post)) {
    if (name.toLowerCase() === key) {
      text = value === null || value === undefined ? '' : String(value);
    }
  }
  return text;
}

/** Image size operations of the Edit Site dialog; every one runs in the token tenant `claims.tid`. */
export interface ImageSizesDomain {
  /** The custom image sizes of `siteId` by `sizeid` (settingsBean.getCustomImageSizeIterator); 403 unless `siteId` is the token's site. */
  listImageSizes(db: TenantDb, claims: UserClaims, siteId: string): Promise<ImageSizeBean[]>;
  /** `csettings.loadcustomimage`: the stored size, else a new bean under a fresh id, which the dialog posts back. */
  loadImageSize(db: TenantDb, claims: UserClaims, sizeId: string): Promise<ImageSizeBean>;
  /** `loadcustomimages` with `imageaction=save`: the saved bean, or null with nothing written when `sizeid` is empty. */
  saveImageSize(db: TenantDb, claims: UserClaims, input: ImageSizePost): Promise<ImageSizeBean | null>;
  /** `loadcustomimages` with `imageaction=delete`: true when a size was deleted; an empty or unknown `sizeId` deletes nothing. */
  deleteImageSize(db: TenantDb, claims: UserClaims, sizeId: string): Promise<boolean>;
}

/**
 * Builds the image size operations over the injected repository.
 * A `sizeid` of another tenant is invisible under RLS, so save inserts it as new where legacy would update the other site's row.
 */
export function createImageSizesDomain(deps: { repo: ProgramsSitesRepository; nameOptions?: ImageSizeNameOptions }): ImageSizesDomain {
  const { repo, nameOptions } = deps;

  async function load(tx: TenantTx, sizeId: string): Promise<ImageSizeBean> {
    const row = await repo.findImageSize(tx, { sizeId });
    return row === null ? newImageSizeBean() : beanFromRow(row, nameOptions);
  }

  async function listImageSizes(db: TenantDb, claims: UserClaims, siteId: string): Promise<ImageSizeBean[]> {
    assertSiteMatches(siteId, claims);
    const rows = await withTenant(db, claims.tid, (tx) => repo.listImageSizes(tx, siteId));
    return rows.map((row) => beanFromRow(row, nameOptions));
  }

  async function loadImageSize(db: TenantDb, claims: UserClaims, sizeId: string): Promise<ImageSizeBean> {
    if (sizeId === '') {
      return newImageSizeBean();
    }
    return withTenant(db, claims.tid, (tx) => load(tx, sizeId));
  }

  async function saveImageSize(db: TenantDb, claims: UserClaims, input: ImageSizePost): Promise<ImageSizeBean | null> {
    const sizeId = postedText(input, 'sizeid');
    if (sizeId === '') {
      return null;
    }
    assertSiteMatches(postedText(input, 'siteid'), claims);
    return withGatedTenant(db, claims.tid, async (tx) => {
      const bean = applyImageSizeSet(await load(tx, sizeId), input, nameOptions);
      await repo.saveImageSize(tx, {
        sizeid: bean.sizeId,
        siteid: bean.siteId,
        name: bean.name,
        height: bean.height,
        width: bean.width,
      });
      return { ...bean, isNew: 0 };
    });
  }

  async function deleteImageSize(db: TenantDb, claims: UserClaims, sizeId: string): Promise<boolean> {
    if (sizeId === '') {
      return false;
    }
    return withGatedTenant(db, claims.tid, (tx) => repo.deleteImageSize(tx, sizeId));
  }

  return Object.freeze({ listImageSizes, loadImageSize, saveImageSize, deleteImageSize });
}
