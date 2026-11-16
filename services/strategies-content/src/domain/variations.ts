/** Variation targeting (contentVariationTargetingBean): reads, saves, deletes and the variation script the `variations` setting gates. */
import { LegacyApiError, cfUuid } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import type { BeanFeedSource } from '../repo/bean-feed-sql.js';
import type { ContentRepository } from '../repo/repository.js';
import { VARIATION_TARGETING, type VariationTargetingRow } from '../repo/tables.js';
import { writeContextFor, type Actor, type ContentConfig, type DomainDeps, type LegacyErrors } from './context.js';
import { getModulePerm } from './permissions.js';

/** A variation targeting bean's values [contentVariationTargetingBean.cfc:82-86]; NULL columns read as ''. */
export interface VariationTargeting {
  targetingid: string;
  contentid: string;
  siteid: string;
  initjs: string;
  targetingjs: string;
  /** 1 for a new bean no stored row backs, 0 once loaded or saved. */
  isNew: 0 | 1;
}

/** Values a save sets on the loaded bean; omitted fields keep the loaded (or new) bean's values. */
export interface VariationTargetingValues {
  /** Loads by this id when set; otherwise loads by `contentid` and `siteid` as content.getVariationTargeting() does. */
  targetingid?: string;
  contentid?: string;
  siteid?: string;
  initjs?: string;
  targetingjs?: string;
}

/** Options of a targeting save. */
export interface VariationTargetingSaveOptions {
  /** The bean's saveErrors: write despite validation errors (beanORM.cfc:206-218, 389). */
  saveErrors?: boolean;
}

/** A targeting save's outcome: the bean as stored, null when validation errors kept it unwritten, and those errors. */
export interface VariationTargetingSave {
  saved: VariationTargeting | null;
  errors: LegacyErrors;
}

/** One live Variation item of a site with its targeting scripts. */
export interface VariationScriptItem {
  contentid: string;
  title: string;
  initjs: string;
  targetingjs: string;
}

/** The data part of `/_api/resource/variation` (variation.js.cfm); the script text itself is assembled elsewhere. */
export interface VariationScriptModel {
  siteId: string;
  /** `url.contenttype` (cfparam default ''), which the script declares. */
  contentType: string;
  /** The site's live Variation items by title. */
  variations: VariationScriptItem[];
}

// The JSON API registers variationTargeting under the Content module (jsonApiUtility.cfc:104), and AllowAction's
// default branch checks the entity's registered module, not Variation content's module 099.
const VARIATION_TARGETING_MODULE_ID = '00000000000000000000000000000000000';

/** configBean `getValue('variations', false)`: whether the JSON API registers `variationTargeting` and the variation script is served. */
export function variationsEnabled(config: Pick<ContentConfig, 'variations'>): boolean {
  return config.variations;
}

/** The bean values of a stored row. */
function fromRow(row: VariationTargetingRow): VariationTargeting {
  return {
    targetingid: row.targetingid,
    contentid: row.contentid ?? '',
    siteid: row.siteid ?? '',
    initjs: row.initjs ?? '',
    targetingjs: row.targetingjs ?? '',
    isNew: 0,
  };
}

/** A new bean as beanORM loadBy leaves it when no row matches: the load keys set, a new createUUID() id, empty scripts. */
function newTargeting(keys: Pick<VariationTargeting, 'contentid' | 'siteid'> & { targetingid?: string }): VariationTargeting {
  return { targetingid: keys.targetingid ?? cfUuid(), contentid: keys.contentid, siteid: keys.siteid, initjs: '', targetingjs: '', isNew: 1 };
}

/** contentVariationTargetingBean.loadBy(contentid, siteid) in `tx`: the stored targeting, or a new bean. */
async function loadForContent(tx: TenantTx, repository: ContentRepository, contentId: string, siteId: string): Promise<VariationTargeting> {
  const row = await repository.variation.targetingFor(tx, { contentId, siteId });
  return row === null ? newTargeting({ contentid: contentId, siteid: siteId }) : fromRow(row);
}

/** contentVariationTargetingBean.loadBy(targetingid) in `tx`: the stored row, or null. */
async function findById(tx: TenantTx, repository: ContentRepository, targetingId: string): Promise<VariationTargetingRow | null> {
  return repository.platform.findByKey<VariationTargetingRow>(tx, VARIATION_TARGETING.table, { targetingid: targetingId });
}

/** A beanValidator rule of a contentVariationTargetingBean property: the value it reads and when that value fails. */
interface TargetingRule {
  value: (bean: VariationTargeting) => string;
  required?: boolean;
  maxLength: number;
}

// Keyed as bean.getValidations keys them (relationships by fkcolumn); the char, varchar and text datatype rules always
// pass for text, so only these can fail.
const RULES: Readonly<Record<string, TargetingRule>> = {
  targetingid: { value: (b) => b.targetingid, required: true, maxLength: 35 },
  contentid: { value: (b) => b.contentid, maxLength: 35 },
  siteid: { value: (b) => b.siteid, maxLength: 25 },
};

/** contentVariationTargetingBean.validate(): beanValidator's errors, then beanORM's primary key check (Masa's default `stricthtml` off). */
function validateTargeting(bean: VariationTargeting): LegacyErrors {
  const errors: LegacyErrors = {};
  for (const [key, rule] of Object.entries(RULES)) {
    const value = rule.value(bean);
    // A rule of a property that is not required skips an empty value; CFML len() counts UTF-16 code units.
    if (value === '' ? rule.required === true : value.length > rule.maxLength) errors[key] = `The property named '${key}' is not valid`;
  }
  if (bean.targetingid === '') errors['primarykey'] = "The primary key 'targetingid' is required.";
  return errors;
}

const VALUE_FIELDS = ['targetingid', 'contentid', 'siteid', 'initjs', 'targetingjs'] as const;

/** The bean fields `input` supplies. */
function suppliedValues(input: VariationTargetingValues): Partial<VariationTargeting> {
  const values: Partial<VariationTargeting> = {};
  for (const field of VALUE_FIELDS) {
    const value = input[field];
    if (value !== undefined) values[field] = value;
  }
  return values;
}

/**
 * content.getVariationTargeting() for `contentId` in `siteId`: the stored targeting, or a new bean with empty scripts.
 * Callers apply their own access rule, as the content render and the admin view do.
 */
export function readVariationTargeting(
  deps: Pick<DomainDeps, 'db' | 'repository'>,
  actor: Actor,
  input: { contentId: string; siteId: string },
): Promise<VariationTargeting> {
  return withTenant(deps.db, actor.tenantId, (tx) => loadForContent(tx, deps.repository, input.contentId, input.siteId));
}

/** A stored targeting row's columns as the entity's beanFeed query returns them; NULL columns stay null. */
export type VariationTargetingColumns = Omit<VariationTargetingRow, 'tenant_id'>;

/**
 * contentVariationTargetingBean.loadBy(targetingid) in the request site, as the JSON API loads the entity: the stored
 * targeting, or a new bean holding `targetingId` and `siteId` with empty scripts.
 */
export function findVariationTargeting(
  deps: Pick<DomainDeps, 'db' | 'repository'>,
  actor: Actor,
  input: { targetingId: string; siteId: string },
): Promise<VariationTargeting> {
  return withTenant(deps.db, actor.tenantId, async (tx) => {
    const row = await findById(tx, deps.repository, input.targetingId);
    return row === null ? newTargeting({ targetingid: input.targetingId, contentid: '', siteid: input.siteId }) : fromRow(row);
  });
}

/**
 * The rows the entity's beanFeed selects for the actor's tenant, in primary-key order (only those of `ids` when given),
 * as a SQL feed source `fn` reads in one tenant transaction.
 */
export function withVariationTargetingFeed<T>(
  deps: Pick<DomainDeps, 'db' | 'repository'>,
  actor: Actor,
  input: { ids?: readonly string[] },
  fn: (source: BeanFeedSource<VariationTargetingColumns>) => Promise<T>,
): Promise<T> {
  return withTenant(deps.db, actor.tenantId, async (tx) => {
    const spec = await deps.repository.variation.targetingFeed(tx, input);
    return fn(deps.repository.beanFeed.source<VariationTargetingColumns>((run) => run(tx), spec));
  });
}

/**
 * contentVariationTargetingBean `set(values).save()` in the caller's gated transaction: loads by `targetingid`, else by
 * `contentid` and `siteid`, applies `input`, validates, and inserts or updates the row unless validation fails without
 * `saveErrors` [beanORM.cfc:379-389]. It runs whatever the `variations` setting, as contentManager.add saves a
 * Variation's initJS [contentManager.cfc:1125-1127,1737-1740].
 * @returns the bean as stored (null when unwritten) and its validation errors.
 */
export async function saveVariationTargetingInTx(
  tx: TenantTx,
  repository: ContentRepository,
  input: VariationTargetingValues,
  actor: Actor,
  opts: VariationTargetingSaveOptions = {},
): Promise<VariationTargetingSave> {
  const { targetingid, contentid = '', siteid = '' } = input;
  let loaded: VariationTargeting;
  if (targetingid !== undefined && targetingid !== '') {
    const row = await findById(tx, repository, targetingid);
    loaded = row === null ? newTargeting({ targetingid, contentid, siteid }) : fromRow(row);
  } else {
    loaded = await loadForContent(tx, repository, contentid, siteid);
  }
  const bean: VariationTargeting = { ...loaded, ...suppliedValues(input) };
  const errors = validateTargeting(bean);
  if (Object.keys(errors).length > 0 && opts.saveErrors !== true) return { saved: null, errors };
  const saved = await repository.variation.upsertTargeting(
    tx,
    {
      targetingid: bean.targetingid,
      contentid: bean.contentid,
      siteid: bean.siteid,
      initjs: bean.initjs,
      targetingjs: bean.targetingjs,
    },
    writeContextFor(actor),
  );
  return { saved: fromRow(saved), errors };
}

/**
 * JSON API `variationTargeting` save [jsonApiUtility.cfc:1903-2068], whatever the `variations` setting: refuses with
 * `authorization` without the entity's module permission, then saves `input` (an empty or omitted `targetingid` saves
 * under a new id).
 * @returns the bean as stored (null when validation kept it unwritten) and its validation errors.
 */
export async function saveVariationTargeting(
  deps: DomainDeps,
  actor: Actor,
  input: VariationTargetingValues,
  opts: VariationTargetingSaveOptions = {},
): Promise<VariationTargetingSave> {
  if (!getModulePerm(actor, VARIATION_TARGETING_MODULE_ID)) {
    throw new LegacyApiError('authorization');
  }
  const targetingid = input.targetingid === undefined || input.targetingid === '' ? cfUuid() : input.targetingid;
  return withGatedTenant(deps.db, actor.tenantId, (tx) =>
    saveVariationTargetingInTx(tx, deps.repository, { ...input, targetingid }, actor, opts),
  );
}

/**
 * JSON API `variationTargeting` delete [jsonApiUtility.cfc:3259-3337], whatever the `variations` setting: an absent row
 * is a silent no-op; a stored one is deleted after the module permission check, which refuses with `authorization`.
 * @returns the deleted bean, or null when none was stored.
 */
export async function deleteVariationTargeting(deps: DomainDeps, actor: Actor, targetingId: string): Promise<VariationTargeting | null> {
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    if ((await findById(tx, deps.repository, targetingId)) === null) {
      return null;
    }
    if (!getModulePerm(actor, VARIATION_TARGETING_MODULE_ID)) {
      throw new LegacyApiError('authorization');
    }
    const deleted = await deps.repository.variation.deleteTargeting(tx, { targetingId }, writeContextFor(actor));
    return deleted === null ? null : fromRow(deleted);
  });
}

/**
 * The variation content and targeting scripts of `siteId` for the variation script: each live Variation item with
 * content.getVariationTargeting()'s initjs and targetingjs, as the Variation JSON render adds them [standardEventsHandler.cfc:1006-1010].
 * @returns null when the `variations` setting is off, as legacy then serves no script.
 */
export async function variationScriptModel(
  deps: DomainDeps,
  actor: Actor,
  input: { siteId: string; contentType: string },
): Promise<VariationScriptModel | null> {
  if (!variationsEnabled(deps.config)) {
    return null;
  }
  return withTenant(deps.db, actor.tenantId, async (tx) => {
    const items = await deps.repository.content.componentType(tx, { siteId: input.siteId, type: 'Variation' });
    const contentIds = items.map((item) => item.contentid ?? '');
    const rows = await deps.repository.variation.targetingsForContents(tx, { contentIds, siteId: input.siteId });
    const variations = items.map((item, index): VariationScriptItem => {
      const row = rows[index] ?? null;
      const targeting = row === null ? { initjs: '', targetingjs: '' } : fromRow(row);
      return { contentid: item.contentid ?? '', title: item.menutitle ?? '', initjs: targeting.initjs, targetingjs: targeting.targetingjs };
    });
    return { siteId: input.siteId, contentType: input.contentType, variations };
  });
}
