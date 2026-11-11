import { isTenantId } from '@opt2/platform/tenancy';

// Same language as files.cfm's namePattern: fileDAO.cfc:153-199 variants plus the on-demand `_<size name>` and
// `_W<w>_H<h>` renditions of processImgCfimage.cfc:190-201; `ext` follows the last dot.
/** Name of a stored file-store object, `<fileID><variant>.<ext>`; groups are fileId, variant and ext. */
export const STORED_NAME_PATTERN = /^([A-Za-z0-9-]{35})(_[^/\\\u0000-\u001F\u007F]+)?\.([A-Za-z0-9]+)$/;

/** Suffix distinguishing an original (`''`) from its image renditions. */
export type StoredVariant = '' | '_source' | '_small' | '_medium' | `_${string}`;

/** The variants Masa's fileDAO writes, original first. */
export const STORED_VARIANTS: readonly StoredVariant[] = ['', '_source', '_small', '_medium'];

/** Parts of a stored name, kept exactly as found. */
export interface StoredName {
  fileId: string;
  variant: StoredVariant;
  ext: string;
}

/** Raised when a name or object key cannot be formed; `value` holds the rejected string. */
export class InvalidStoredNameError extends Error {
  override readonly name = 'InvalidStoredNameError';
  readonly value: string;

  constructor(value: string) {
    super(`Invalid stored file name or object key: ${JSON.stringify(value)}`);
    this.value = value;
  }
}

/** Splits a stored name into its parts; returns null when the name is not a stored object name. */
export function parseStoredName(name: string): StoredName | null {
  const match = STORED_NAME_PATTERN.exec(name);
  if (match === null) return null;
  const [, fileId = '', variant = '', ext = ''] = match;
  return { fileId, variant: variant as StoredVariant, ext };
}

/** Joins parts into `<fileId><variant>.<ext>`; throws InvalidStoredNameError unless the result parses back to `parts`. */
export function formatStoredName(parts: StoredName): string {
  const name = `${parts.fileId}${parts.variant}.${parts.ext}`;
  const parsed = parseStoredName(name);
  if (parsed?.fileId !== parts.fileId || parsed.variant !== parts.variant || parsed.ext !== parts.ext) {
    throw new InvalidStoredNameError(name);
  }
  return name;
}

/** Store-relative path `<siteId>/cache/file/<name>`, where siteId is the file pool site. */
export function storePath(siteId: string, name: string): string {
  return `${siteId}/cache/file/${name}`;
}

/** Last `/` segment of a store-relative path. */
export function nameFromStorePath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `content-files` object key `<tenantId>/<fileId><variant>.<ext>`; throws InvalidStoredNameError for a non-UUID tenant or an invalid name. */
export function objectKey(tenantId: string, fileId: string, variant: StoredVariant, ext: string): string {
  const name = formatStoredName({ fileId, variant, ext });
  if (!isTenantId(tenantId)) throw new InvalidStoredNameError(`${tenantId}/${name}`);
  return `${tenantId}/${name}`;
}

/** Inverse of objectKey; returns null unless the key is exactly `<tenant UUID>/<stored name>`. */
export function parseObjectKey(key: string): (StoredName & { tenantId: string }) | null {
  const segments = key.split('/');
  if (segments.length !== 2) return null;
  const [tenantId = '', name = ''] = segments;
  const parsed = parseStoredName(name);
  return parsed !== null && isTenantId(tenantId) ? { tenantId, ...parsed } : null;
}
