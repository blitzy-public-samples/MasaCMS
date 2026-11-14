// Route adapters of admin/core/controllers/cchain.cfc and its views over the approvals domain.
import { LegacyServiceUnavailableError, cfDateFormat, cfNumberString, cfTimeFormat } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  availableGroups,
  deleteChain,
  listChains,
  pendingApprovals,
  readChain,
  saveChain,
  type ApprovalChainBean,
  type ApprovalChainMembership,
  type ApprovalChainValues,
  type AvailableGroup,
  type PendingApprovalItem,
} from '../../domain/approvals.js';
import type { Actor, LegacyErrors } from '../../domain/context.js';
import type { components } from '../../generated/openapi.js';
import { buildCustomIconLookup, iconClass, type CustomIconLookup } from '../../legacy/admin-markup.js';
import type { Crumb } from '../../repo/content-queries.js';
import type { ExtendSubtypeRow } from '../../repo/tables.js';
import type { ContentRouteContext } from '../index.js';
import { adminCsrf, adminRedirect, circuitRouteConfig, csrfRejected, requireCircuitAccess, type AdminRedirect, type AdminWriteResult } from './access.js';

type AdminViewModel = components['schemas']['AdminViewModel'];
type Struct = Record<string, unknown>;

interface SiteParams {
  siteid: string;
}

interface ChainParams extends SiteParams {
  chainid: string;
}

const CHAINS_PATH = '/v1/sites/:siteid/approval-chains';
const CHAIN_PATH = `${CHAINS_PATH}/:chainid`;

/** The exceptions-list entry of a pending list holding a row whose preview URL pending.cfm prints. */
export const CCHAIN_PENDING_PREVIEW_EXCEPTION = 'EX-CCHAIN-PENDING-PREVIEW';
/** LegacyServiceUnavailableError reason of a view needing site URL settings this service does not hold. */
export const CCHAIN_SITE_SETTINGS_REASON = 'cchain-site-settings';
/** The types whose pending row prints `getURL(complete=1)` (pending.cfm's `cfcase` list, matched case-insensitively). */
const PREVIEW_TYPES: readonly string[] = ['page', 'folder', 'calendar', 'gallery', 'link', 'file'];

/** `rc[key]` ignoring case where CFML `isSimpleValue` holds; absent reads as `before()`'s '' default (cchain.cfc:90-97). */
function rcText(rc: Readonly<Struct>, key: string): string {
  const lower = key.toLowerCase();
  const name = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  const value = name === undefined ? undefined : rc[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** `rc.chainid`, the CSRF context of save and delete: the path's id where the operation has one, else the posted field. */
function chainIdOf(request: FastifyRequest): string {
  const { chainid } = request.params as Partial<ChainParams>;
  return chainid ?? rcText(legacyParamsOf(request), 'chainid');
}

/** `fw.redirect(action="cchain.list", append="siteid", path="./")` (cchain.cfc:104,112,120); the `./` path is web's. */
function listRedirect(siteid: string): AdminRedirect {
  return adminRedirect('cchain.list', { siteid }, ['siteid']);
}

/** A timestamp as the contract's LocalTimestamp (the legacy zone's wall clock); SQL NULL reads as ''. */
function localTimestamp(value: Date | null): string {
  return value === null ? '' : `${cfDateFormat(value, 'yyyy-mm-dd')}T${cfTimeFormat(value, 'HH:mm:ss.lll')}`;
}

/** approvalChainBean `getAllValues()`, keyed by its property names. */
function chainValues(values: ApprovalChainValues): Struct {
  return {
    chainID: values.chainid,
    siteID: values.siteid,
    name: values.name,
    description: values.description,
    created: localTimestamp(values.created),
    lastupdate: localTimestamp(values.lastupdate),
    lastupdateby: values.lastupdateby,
    lastupdatebyid: values.lastupdatebyid,
  };
}

/** The chain bean as `loadBy(chainID)` leaves it: its values, `isNew` and an empty error struct. */
function chainBean(chain: ApprovalChainBean): Struct {
  const errors: LegacyErrors = {};
  return { ...chainValues(chain.values), isNew: chain.isNew, errors };
}

/** One `getMembershipsIterator()` membership with its group's name. */
function membershipRow(membership: ApprovalChainMembership): Struct {
  return {
    membershipID: membership.membershipid,
    groupID: membership.groupid,
    orderNo: membership.orderno,
    groupName: membership.groupname,
  };
}

/** One `getAvailableGroupsIterator()` row under its `tusers` column names. */
function availableGroupRow(group: AvailableGroup): Struct {
  return { userID: group.groupid, groupName: group.groupname, siteID: group.siteid, isPublic: group.ispublic };
}

/** One `getCrumbArray()` crumb as CFML holds it, SQL NULL read as '', with `renderIcon`'s class as `icon`. */
function crumbStruct(crumb: Crumb, icons: CustomIconLookup): Struct {
  return { ...Object.fromEntries(Object.entries(crumb).map(([key, value]) => [key, value ?? ''])), icon: iconClass(icons, crumb) };
}

/** extendManager's custom icon lookup over the subtypes of each of `siteIds`. */
async function customIconsOf(ctx: ContentRouteContext, actor: Actor, siteIds: readonly string[]): Promise<CustomIconLookup> {
  const sites = [...new Set(siteIds)];
  if (sites.length === 0) return buildCustomIconLookup([]);
  const rows = await ctx.domain.db.withTenant(actor.tenantId, async (tx) => {
    const found: ExtendSubtypeRow[] = [];
    for (const siteId of sites) found.push(...(await ctx.domain.repository.extend.subtypes(tx, { siteId })));
    return found;
  });
  return buildCustomIconLookup(rows);
}

/** One `getPendingContentIterator()` row under its legacy column names, with its crumbs. */
function pendingRow(item: PendingApprovalItem, icons: CustomIconLookup): Struct {
  // No previewURL: the pending handler answers only rows whose type pending.cfm prints no preview for.
  return {
    requestID: item.requestid,
    created: localTimestamp(item.created),
    contentID: item.contentid,
    contentHistID: item.contenthistid,
    siteID: item.siteid,
    moduleID: item.moduleid,
    parentID: item.parentid,
    title: item.title,
    menuTitle: item.menutitle,
    summary: item.summary,
    type: item.type,
    subType: item.subtype,
    filename: item.filename,
    fileID: item.fileid,
    changesetID: item.changesetid,
    lastUpdate: localTimestamp(item.lastupdate),
    lastUpdateBy: item.lastupdateby,
    lastUpdateByID: item.lastupdatebyid,
    changesetName: item.changesetname,
    changesetPublishDate: localTimestamp(item.changesetpublishdate),
    crumbArray: item.crumbs.map((crumb) => crumbStruct(crumb, icons)),
  };
}

/** cchain admin routes: approval-chain list, edit, pending requests, save and delete. */
export async function registerChainRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  const config = circuitRouteConfig('cchain');
  // The preHandler runs after the platform's role and site checks, which admit no request the before() gate refuses, so
  // identity consumes a token only where legacy reaches validateCSRFTokens.
  const chainCsrf = adminCsrf(chainIdOf);

  /** cchain.list (list.cfm): the site's chains by name. */
  app.get<{ Params: SiteParams; Reply: AdminViewModel }>(CHAINS_PATH, { config }, async (request) => {
    const { siteid } = request.params;
    const actor = await requireCircuitAccess(request, ctx, 'cchain', siteid);
    const chains = await listChains(ctx.domain, actor, siteid);
    return { rc: { siteid, chains: chains.map(chainValues) } };
  });

  /** cchain.update (update.cfm includes edit.cfm): the chain, the groups it can add and its members in order. */
  app.get<{ Params: ChainParams; Reply: AdminViewModel }>(CHAIN_PATH, { config }, async (request) => {
    const { siteid, chainid } = request.params;
    const actor = await requireCircuitAccess(request, ctx, 'cchain', siteid);
    const chain = await readChain(ctx.domain, actor, chainid);
    const groups = await availableGroups(ctx.domain, actor, chainid);
    return {
      rc: {
        siteid,
        chainid,
        chain: chainBean(chain),
        availableGroups: groups.map(availableGroupRow),
        memberships: chain.memberships.map(membershipRow),
      },
    };
  });

  // hasChangesets is left to web's programs-sites site, the verified source of tsettings.
  /** cchain.pending (pending.cfm): the chain and, per membership in order, its pending versions oldest request first. */
  app.get<{ Params: ChainParams; Reply: AdminViewModel }>(`${CHAIN_PATH}/pending`, { config }, async (request) => {
    const { siteid, chainid } = request.params;
    const actor = await requireCircuitAccess(request, ctx, 'cchain', siteid);
    const { chain, groups } = await pendingApprovals(ctx.domain, actor, chainid);
    const items = groups.flatMap((group) => group.items);
    // A preview row's getURL(complete=1) reads tsettings and configBean URL values this service does not hold.
    if (items.some((item) => PREVIEW_TYPES.includes(item.type.toLowerCase()))) {
      throw new LegacyServiceUnavailableError(
        `cChain.pending prints preview URLs built from site settings this service does not hold (${CCHAIN_PENDING_PREVIEW_EXCEPTION})`,
        'auto',
        CCHAIN_SITE_SETTINGS_REASON,
      );
    }
    const icons = await customIconsOf(ctx, actor, items.flatMap((item) => item.crumbs.map((crumb) => crumb.siteid ?? '')));
    return {
      rc: {
        siteid,
        chainid,
        chain: chainBean(chain),
        members: groups.map(({ membership, items: rows }) => ({ ...membershipRow(membership), requests: rows.map((item) => pendingRow(item, icons)) })),
      },
    };
  });

  /** cchain.save (cchain.cfc:101-114): `loadBy(chainID).set(rc).save()` when the token validates, then the list redirect. */
  app.post<{ Params: SiteParams; Reply: AdminWriteResult }>(CHAINS_PATH, { config, preHandler: chainCsrf }, async (request) => {
    const { siteid } = request.params;
    const actor = await requireCircuitAccess(request, ctx, 'cchain', siteid);
    // Legacy reads `bean.hasErrors()` of the bean an earlier request left in the cached controller's variables scope (or
    // fails when none exists), which no instance can share; a refused token takes the no-error outcome and the redirect.
    if (csrfRejected(request)) return { saved: false, errors: {}, redirect: listRedirect(siteid) };
    const rc = legacyParamsOf(request);
    const { errors } = await saveChain(ctx.domain, actor, {
      chainId: chainIdOf(request),
      siteId: siteid,
      name: rcText(rc, 'name'),
      description: rcText(rc, 'description'),
      // before() defaults groupid to '', so `valueExists('groupID')` always holds and an empty list clears the members.
      groupId: rcText(rc, 'groupid'),
    });
    const saved = Object.keys(errors).length === 0;
    // With errors legacy takes no redirect and renders cchain.save, which has no view (EX-ADMIN-DEBUGPAGE).
    return { saved, errors, redirect: saved ? listRedirect(siteid) : null };
  });

  /** cchain.delete (cchain.cfc:116-121): the chain and its cascade when the token validates; always the list redirect. */
  app.post<{ Params: ChainParams; Reply: AdminWriteResult }>(`${CHAIN_PATH}/delete`, { config, preHandler: chainCsrf }, async (request) => {
    const { siteid, chainid } = request.params;
    const actor = await requireCircuitAccess(request, ctx, 'cchain', siteid);
    const removed = csrfRejected(request) ? null : await deleteChain(ctx.domain, actor, chainid);
    return { saved: removed !== null, errors: {}, redirect: listRedirect(siteid) };
  });
}
