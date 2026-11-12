// `cchain.edit`, also rendered by `cchain.update`: the approval chain form of `admin/core/views/cchain/edit.cfm` (server-only).
import { cfToBoolean, cfUuid } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import { applyDefaults } from '@/lib/request-context';
import type { PageScreen, ScreenContext } from '../registry';
import { renderCchainSecondaryMenu } from './dsp_secondary_menu';
import { renderCchainJs } from './js';

/** A legacy error struct, keyed and ordered as strategies-content reports it. */
export type CchainErrors = Readonly<Record<string, string>>;

/** The approval chain bean the view loads by `rc.chainID`, saved or new. */
export interface CchainEditChain {
  readonly chainId: string;
  readonly name: string;
  readonly description: string;
  readonly siteId: string;
  readonly isNew: boolean;
  readonly errors: CchainErrors;
}

/** A group the chain does not hold yet (`getAvailableGroupsIterator`). */
export interface CchainAvailableGroup {
  readonly userId: string;
  readonly groupName: string;
}

/** A group of the chain (`getMembershipsIterator`). */
export interface CchainMembership {
  readonly groupId: string;
  readonly groupName: string;
}

/** What the edit view renders: the chain, its addable groups by name and its members by `orderno`, as served. */
export interface CchainEditData {
  readonly chain: CchainEditChain;
  readonly availableGroups: readonly CchainAvailableGroup[];
  readonly memberships: readonly CchainMembership[];
}

// The shell view type is taken from the registry's page contract, which this screen implements.
type ShellView = Awaited<ReturnType<PageScreen<CchainEditData>['render']>>;

type Struct = Readonly<Record<string, unknown>>;

const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A struct member by case-insensitive key, as CFML reads it; undefined when absent. */
function member(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple member as CFML text; absent and SQL NULL read as `''`, complex values throw. */
function text(struct: Struct, key: string): string {
  const value = member(struct, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${key} is not a simple value`);
}

/** A struct member; throws when it is not a struct. */
function structOf(struct: Struct, key: string): Struct {
  const value = member(struct, key);
  if (!isStruct(value)) throw new TypeError(`${key} is not a struct`);
  return value;
}

/** The rows of an iterator member; throws when it is not a list of structs. */
function rowsOf(struct: Struct, key: string): readonly Struct[] {
  const value = member(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${key} is not a list of rows`);
  return value;
}

/** The bean's error struct as text; an absent struct is the empty one a loaded bean holds. */
function errorsOf(chain: Struct): CchainErrors {
  if (member(chain, 'errors') === undefined) return {};
  const errors = structOf(chain, 'errors');
  return Object.fromEntries(Object.keys(errors).map((key) => [key, text(errors, key)]));
}

/** The edit data of a strategies-content screen model: `rc.chain`, `rc.availableGroups` and `rc.memberships`. */
function chainEditData(rc: Struct): CchainEditData {
  const chain = structOf(rc, 'chain');
  return {
    chain: {
      chainId: text(chain, 'chainID'),
      name: text(chain, 'name'),
      description: text(chain, 'description'),
      siteId: text(chain, 'siteID'),
      isNew: cfToBoolean(member(chain, 'isNew')),
      errors: errorsOf(chain),
    },
    availableGroups: rowsOf(rc, 'availableGroups').map((row) => ({
      userId: text(row, 'userID'),
      groupName: text(row, 'groupName'),
    })),
    memberships: rowsOf(rc, 'memberships').map((row) => ({
      groupId: text(row, 'groupID'),
      groupName: text(row, 'groupName'),
    })),
  };
}

/**
 * Loads the chain of `rc.chainID` with its groups; an empty id becomes a new CF UUID in `ctx.req.rc` first, as the
 * view sets `rc.chainID`. Gateway unavailability propagates.
 * @throws GatewayDenialError When strategies-content refuses the read (401 or 403).
 * @throws TypeError When the screen model lacks the chain, its group lists or a boolean `isNew`.
 */
export async function loadCchainEdit(ctx: ScreenContext): Promise<CchainEditData> {
  let chainid = ctx.req.rc.chainid ?? '';
  if (chainid === '') {
    chainid = cfUuid();
    // A later key of the same name, in any case, replaces the value and keeps the request's casing.
    ctx.req = { ...ctx.req, rc: applyDefaults({ ...ctx.req.rc, chainID: chainid }) };
  }
  const siteid = ctx.req.rc.siteid ?? '';
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/approval-chains/{chainid}', {
    params: { siteid, chainid },
  });
  const data = chainEditData(okBody(response, 'strategies-content', 'getApprovalChain').rc);
  await ctx.csrf.prefetch([data.chain.chainId]);
  return data;
}

/** `utility.displayErrors`: every message but `siteID`'s, unencoded and in struct order, spaced as ACF emits them. */
function displayErrors(errors: CchainErrors): SafeHtml {
  const entries = Object.entries(errors);
  return join(
    entries.flatMap(([key, message], index) =>
      // The `<br>` test counts every key, `siteID` included.
      key.toLowerCase() === 'siteid' ? [] : [raw(`${message} ${entries.length > index + 1 ? '<br> ' : ''}`)],
    ),
  );
}

/** One `availableID` item of the available-groups list. */
function availableItem({ userId, groupName }: CchainAvailableGroup): SafeHtml {
  return html`
              <li class="ui-state-default">
                ${raw(encodeHtml(groupName))}
                <input name="availableID" type="hidden" value="${raw(userId)}">
              </li>
            `;
}

/** One `groupID` item of the chain's ordered group list. */
function membershipItem({ groupId, groupName }: CchainMembership): SafeHtml {
  return html`
              <li class="ui-state-highlight">
                ${raw(encodeHtml(groupName))}
                <input name="groupID" type="hidden" value="${raw(groupId)}">
              </li>
            `;
}

/** The edit view body; the secondary menu follows `ctx.req.action`, so `cchain.update` gets an empty one. */
export function renderCchainEdit(ctx: ScreenContext, data: CchainEditData): ShellView {
  const { chain } = data;
  const label = (key: string): SafeHtml => raw(ctx.rb.rbKey(`approvalchains.${key}`));
  const menu = renderCchainSecondaryMenu(ctx.req, ctx.rb, { chainId: chain.chainId, isNew: chain.isNew });
  const errors =
    Object.keys(chain.errors).length === 0
      ? ''
      : html`
          <div class="alert alert-error"><span>${displayErrors(chain.errors)}</span></div>
        `;
  const deleteConfirm = raw(encodeJs(ctx.rb.rbKey('approvalchains.deleteconfirm')));
  // Legacy leaves a space between the encoded site id and the CSRF fields.
  const deleteUrl = html`./?muraAction=cchain.delete&chainID=${raw(chain.chainId)}&siteid=${raw(encodeUrl(chain.siteId))} ${ctx.csrf.render(chain.chainId, 'url')}`;

  const body = html`


<div class="mura-header">
  \n\t<h1>${label('editapprovalchain')}</h1>
  \n\t${menu}


</div> <!-- /.mura-header -->


<div class="block block-constrain">
    <div class="block block-bordered">
      <div class="block-content">

        ${errors}

      <form novalidate="novalidate" action="./?muraAction=cchain.save" method="post" name="form1" onsubmit="return validateForm(this);">
      <div class="mura-control-group">
         <label>
            ${label('name')}
         </label>
          <input name="name" type="text" required="true" message="${label('namerequired')}" value="${raw(encodeHtmlAttr(chain.name))}" maxlength="50">
        </div>
      <div class="mura-control-group">
          <label>
            ${label('description')}
          </label>
          <textarea name="description" rows="6">${raw(encodeHtml(chain.description))}</textarea>
      </div>

      <div class="mura-control-group" id="availableGroups">
      \t<div class="help-block">
          <span>
            The first group in the chain will be the first group required to make the decision to &quot;Approve&quot; or &quot;Reject&quot; any additions or changes.
            Approval chains do <em>not</em> affect &quot;permissions&quot; for creating or updating content, they merely force content to go through a review process.
          </span>
      \t</div>
        <label>
          <span class="half">${label('groupsavailable')}</span> <span class="half">${label('groupselected')}</span>
        </label>

        <div id="sortableGroups">
          <p class="dragMsg">
            <span class="dragFrom half">${label('dragfrom')}&hellip;</span><span class="half">&hellip;${label('dragto')}</span>
          </p>

          <ul id="groupAvailableListSort" class="groupDisplayListSortOptions">
            ${data.availableGroups.map(availableItem)}
          </ul>

          <ol id="groupAssignmentListSort" class="groupDisplayListSortOptions">
            ${data.memberships.map(membershipItem)}
          </ol>
          <script>
            $(function(){
                chainManager.setGroupMembershipSort();
              });
          </script>
        </div>
      </div>
      <div class="mura-actions">
        <div class="form-actions">
          \n            <button class="btn" type="button"onclick="confirmDialog('${deleteConfirm}','${deleteUrl}');"><i class="mi-trash"></i>${label('delete')}</button>
            <button class="btn mura-primary" type="button" onclick="submitForm(document.forms.form1,'save');"><i class="mi-check-circle"></i>${label('update')}</button>
          \n          <input type="hidden" name="siteid" value="${raw(chain.siteId)}">
          <input type=hidden name="chainID" value="${raw(chain.chainId)}">
          ${ctx.csrf.render(chain.chainId, 'form')}
        </div>
      </div>
      </form>
      \n${renderCchainJs()}

    </div> <!-- /.block-content -->
  </div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->
`;
  return { body };
}
