// The `cChangesets.save` action: the strategies-content save, then FW/1's list redirect or the edit view re-rendered.
import { okBody } from '@/lib/gateway-client';
import type { PageControllerRedirect, PageRedirect, PageScreen, ScreenContext } from '../registry';
import { changesetEditData, renderChangesetEditView, type ChangesetEditData } from './edit';

type ShellView = Awaited<ReturnType<PageScreen<ChangesetEditData>['render']>>;

const SERVICE = 'strategies-content';
const OPERATION = 'saveChangeset';

/** `fw.redirect(action="cChangesets.list", append="changesetID,siteID", path="./")`. */
const LIST_REDIRECT: PageRedirect = Object.freeze({
  kind: 'redirect',
  action: 'cChangesets.list',
  append: 'changesetID,siteID',
  path: './',
});

/** The saved bean and the view data the controller step received, read by `load` for the same request. */
const RERENDERS = new WeakMap<ScreenContext, ChangesetEditData>();

const isStruct = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `save()`: posts every rc field, the CSRF pair included, for the owner to validate and save. A save without errors
 * answers the list redirect with the `rc` values the owner's redirect names, the new `changesetID` among them;
 * otherwise the edit model is kept for the view.
 * @throws TypeError When the owner returns no saved bean (a rejected token), where legacy's view reads `rc.changeset`.
 * @throws GatewayDenialError When strategies-content answers 401 or 403; any other non-2xx answer throws `Error`.
 */
async function saveChangeset(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const { rc } = ctx.req;
  const response = await ctx.gateway.strategiesContent.call('post', '/v1/sites/{siteid}/changesets', {
    params: { siteid: rc.siteid ?? '' },
    form: Object.entries(rc),
  });
  if (response.location !== undefined) return { kind: 'location', location: response.location };
  const { errors, redirect, data } = okBody(response, SERVICE, OPERATION);
  if (redirect !== null) return { ...LIST_REDIRECT, rc: Object.fromEntries(redirect.params) };
  const model = data?.rc;
  if (!isStruct(model) || !Object.keys(model).some((key) => key.toLowerCase() === 'changeset')) {
    throw new TypeError('Element CHANGESET is undefined in RC.');
  }
  const view = changesetEditData(model);
  // The contract hands the bean's error struct over at the top level, in struct order.
  RERENDERS.set(ctx, { ...view, changeset: { ...view.changeset, errors: Object.entries(errors) } });
  return undefined;
}

/**
 * The model the controller step kept, with the CSRF pair of the saved change set.
 * @throws Error When the controller step has not run for `ctx`.
 */
async function loadSavedChangeset(ctx: ScreenContext): Promise<ChangesetEditData> {
  const data = RERENDERS.get(ctx);
  if (data === undefined) throw new Error('cChangesets.save loaded before its controller step ran');
  await ctx.csrf.prefetch([data.changeset.changesetId]);
  return data;
}

/** `cChangesets.save` without the circuit gate, which `./index.ts` adds; `save.cfm` includes `edit.cfm`. */
export const changesetSaveScreen: Omit<PageScreen<ChangesetEditData>, 'gate'> = Object.freeze({
  circuit: 'cchangesets',
  action: 'save',
  // Inventoried as a page: the gateway folds the posted form into a page request, and the controller step writes.
  mode: 'page',
  owner: SERVICE,
  redirect: saveChangeset,
  load: loadSavedChangeset,
  // Legacy sets `rc.changesetID` to the saved bean's id, so even a failed add renders as an edit.
  render: (ctx: ScreenContext, data: ChangesetEditData): ShellView => ({
    body: renderChangesetEditView(ctx, data, { rcChangesetId: data.changeset.changesetId }),
  }),
});
