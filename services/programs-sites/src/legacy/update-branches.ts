/** Pre-write detection of settingsManager.update branches that write outside programs-sites (core/mura/settings). */
import { cfEq, javaTrim, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { applySet, getSiteValue, type SiteBean, type SiteData, type SiteStoredValue } from './site-fields.js';
import { hasSiteErrors, validateSite } from './validation.js';

/** A settingsManager.update branch whose writes belong to another owner or to the legacy runtime. */
export type ForeignBranchName = 'placeholder-image' | 'razuna' | 'bundle' | 'display-pool-copy';

/** A foreign branch an update would run: why it is foreign, and the legacy `path:lines` that run it. */
export interface ForeignBranch {
  branch: ForeignBranchName;
  reason: string;
  legacySource: string;
}

/** Request keys the razuna settings bean persists (razunaSettingsBean.cfc:6-10). */
export const RAZUNA_KEYS = ['hostName', 'hostID', 'apiKey', 'damPath', 'servertype'] as const;

const RAZUNA_REQUIRED_KEYS = ['hostName', 'hostID', 'apiKey'] as const;

const RAZUNA_SERVER_TYPES: ReadonlySet<string> = new Set(['cloud', 'local']);

const BRANCH_DETAILS: Readonly<Record<ForeignBranchName, Omit<ForeignBranch, 'branch'>>> = {
  razuna: {
    reason: 'Saves trazunasettings, a table withheld on the decision list.',
    legacySource: 'core/mura/settings/settingsManager.cfc:271',
  },
  'placeholder-image': {
    reason: 'Writes tfiles and the file store, which strategies-content owns.',
    legacySource: 'core/mura/settings/settingsManager.cfc:273-290',
  },
  'display-pool-copy': {
    reason: 'Copies the default site directory on the legacy web-root filesystem.',
    legacySource: 'core/mura/settings/settingsManager.cfc:293,413-426',
  },
  bundle: {
    reason: 'Restores a site bundle through the legacy bundle engine.',
    legacySource: 'core/mura/settings/settingsManager.cfc:294,636-680',
  },
};

/** `data[key]` as a CFML struct reads it: case-insensitive, the last matching key winning as it does in applySet. */
function dataValue(data: SiteData, key: string): unknown {
  const lower = key.toLowerCase();
  let value: unknown;
  for (const [name, entry] of Object.entries(data)) {
    if (name.toLowerCase() === lower) value = entry;
  }
  return value;
}

/** A razuna field as bean.set holds it (bean.cfc:333-334,427-430): undefined when absent or null, text trimmed. */
function razunaValue(data: SiteData, key: string): unknown {
  const value = dataValue(data, key);
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? javaTrim(value) : value;
}

/** validate_required on a supplied value (beanValidator.cfc:261-274): non-empty text or collection, else any value. */
function meetsRequired(value: unknown): boolean {
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

// legacy: core/mura/settings/settingsManager.cfc:271 runs set(data).save() on every update, and beanORM.cfc:387-395
// persists only a valid bean. Omitted keys may come from the stored trazunasettings row, unreadable here, so they
// count as valid: the check is a deliberate superset of legacy's save.
function runsRazuna(data: SiteData): boolean {
  const value = (key: (typeof RAZUNA_KEYS)[number]): unknown => razunaValue(data, key);
  if (!RAZUNA_KEYS.some((key) => meetsRequired(value(key)))) return false;
  const emptyRequired = RAZUNA_REQUIRED_KEYS.some((key) => {
    const supplied = value(key);
    return supplied !== undefined && !meetsRequired(supplied);
  });
  if (emptyRequired) return false;
  const serverType = value('servertype');
  // legacy: core/mura/bean/beanValidator.cfc:458-464, listFindNoCase over `cloud,local`.
  return (
    serverType === undefined ||
    (typeof serverType === 'string' && RAZUNA_SERVER_TYPES.has(serverType.toLowerCase()))
  );
}

/** CF `len(v)` on a bean value; a non-text value, which CF cannot measure, counts as non-empty, failing closed. */
function hasLength(value: SiteStoredValue): boolean {
  return typeof value !== 'string' || value !== '';
}

// legacy: core/mura/settings/settingsManager.cfc:273-290 reads the trimmed bean values getNewPlaceholderImg and
// getDeletePlaceholderImg.
function runsPlaceholderImage(applied: SiteBean): boolean {
  return hasLength(getSiteValue(applied, 'newPlaceholderImg')) ||
    hasLength(getSiteValue(applied, 'deletePlaceholderImg'));
}

/** CFML `eq` between two bean ids; false when either is not text. */
function sameId(a: SiteStoredValue, b: SiteStoredValue): boolean {
  return typeof a === 'string' && typeof b === 'string' && cfEq(a, b);
}

// legacy: core/mura/settings/settingsManager.cfc:413-426 copies only while the site directory is missing; a site that
// already was its own display pool has that directory, so only a switch onto itself is flagged.
function runsDisplayPoolCopy(storedBean: SiteBean, applied: SiteBean): boolean {
  return (
    !sameId(getSiteValue(storedBean, 'displayPoolID'), getSiteValue(storedBean, 'siteID')) &&
    sameId(getSiteValue(applied, 'displayPoolID'), getSiteValue(applied, 'siteID'))
  );
}

/** CF `len()` on a raw request value: an absent or null key is undefined, any other value but '' is non-empty. */
function rawHasLength(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

// legacy: core/mura/settings/settingsManager.cfc:636-680 reads the untrimmed request data; its
// fileExists(serverBundlePath) cannot be evaluated here, so any server path counts.
function runsBundle(data: SiteData): boolean {
  return rawHasLength(dataValue(data, 'bundleFile')) || rawHasLength(dataValue(data, 'serverBundlePath'));
}

/** The foreign branches settingsManager.update would run for `data` on `storedBean`, in legacy run order. */
export function detectForeignBranches(storedBean: SiteBean, data: SiteData): ForeignBranch[] {
  const applied = applySet(storedBean, data);
  // legacy: core/mura/settings/settingsManager.cfc:265 runs no branch while the bean has errors.
  if (hasSiteErrors(validateSite(applied))) return [];
  // extendSetID data of tsettings subtypes is programs-sites' own (settingsManager.cfc:267-269). The legacy runtime
  // effects are replaced, not reproduced: the programs-sites.site.changed.v1 event and the projector's
  // site.cfm?op=refresh stand in for plugin events, clusterManager.reload, setSites, appInitialized, logEvent,
  // LogDeprecation and the newImageIDList redirect.
  const names: ForeignBranchName[] = [];
  if (runsRazuna(data)) names.push('razuna');
  if (runsPlaceholderImage(applied)) names.push('placeholder-image');
  if (runsDisplayPoolCopy(storedBean, applied)) names.push('display-pool-copy');
  if (runsBundle(data)) names.push('bundle');
  return names.map((branch) => ({ branch, ...BRANCH_DETAILS[branch] }));
}

/** Throws the legacy 503 when the update would run a foreign branch; callers invoke it before any write. */
export function assertNoForeignBranches(storedBean: SiteBean, data: SiteData): void {
  const branches = detectForeignBranches(storedBean, data);
  if (branches.length > 0) {
    throw new LegacyServiceUnavailableError(
      `Site update runs foreign branches: ${branches.map(({ branch }) => branch).join(', ')}`,
      'auto',
      'foreign-branch',
    );
  }
}
