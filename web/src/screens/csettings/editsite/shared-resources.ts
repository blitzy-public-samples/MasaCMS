// Shared Resources tab of the Site Settings editor (`admin/core/views/csettings/editsite.cfm` lines 496-578).
import { html, raw, type SafeHtml } from '@/lib/html';
import { cfEq, cfListFind, type EditSiteModel, type SiteOption } from './model';

const SELECTED = raw('selected');
const NOTHING = raw('');
// A CFML comment renders nothing; it also keeps the space legacy leaves before it from being trailing whitespace.
const CFML_COMMENT = NOTHING;

/** `selected` when `cond`, else nothing; legacy writes the token without a leading space. */
function selectedToken(cond: boolean): SafeHtml {
  return cond ? SELECTED : NOTHING;
}

/**
 * ACF 2023 `HTMLEditFormat`: `&`, `<`, `>` and `"` as entities, carriage returns dropped, everything else kept.
 * The category and content pool names use it rather than `esapiEncode('html')`, so their bytes match legacy.
 */
function htmlEditFormat(s: string): SafeHtml {
  return raw(
    s.replace(/\r/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  );
}

/** A `siteconfig.sharedresources.*` label, unencoded as legacy writes it. */
function label(m: EditSiteModel, key: string): SafeHtml {
  return raw(m.rb.rbKey(`siteconfig.sharedresources.${key}`));
}

/** The `div#tabSharedresources` pool-select pane, byte for byte as legacy emits it, without surrounding newlines. */
export function renderSharedResourcesTab(m: EditSiteModel): SafeHtml {
  const { bean } = m;
  const others: readonly SiteOption[] = m.sites.filter((row) => !cfEq(row.siteid, bean.siteID));
  const poolToken = (pool: string, row: SiteOption) => selectedToken(cfEq(row.siteid, pool));
  const contentToken = (siteid: string) => selectedToken(cfListFind(bean.contentPoolID, siteid));

  return html`		<div id="tabSharedresources" class="tab-pane">
			<div class="block block-bordered">
				<!-- block header -->
			  <div class="block-header">
					<h3 class="block-title">Shared Resources</h3>
				</div>
			  <!-- /block header -->
			  <div class="block-content">
				<div class="mura-control-group">
					<label>${label(m, 'memberuserpool')}</label>
							<select  id="publicUserPoolID" name="publicUserPoolID" onchange="if(this.value!='' || jQuery('#privateUserPoolID').val()!=''){jQuery('#bundleImportUsersModeLI').hide();jQuery('#bundleImportUsersMode').attr('checked',false);}else{jQuery('#bundleImportUsersModeLI').show();}">
							<option value="">This site</option>
							${others.map((row) => html`
									<option value="${raw(row.siteid)}" ${poolToken(bean.publicUserPoolID, row)}>${row.site}</option>
								`)}
						</select>
						</div>

				<div class="mura-control-group">
				<label>${label(m, 'systemuserpool')}</label>
						<select  id="privateUserPoolID" name="privateUserPoolID" onchange="if(this.value!='' || jQuery('#publicUserPoolID').val()!=''){jQuery('#bundleImportUsersModeLI').hide();jQuery('#bundleImportUsersMode').attr('checked',false);}else{jQuery('#bundleImportUsersModeLI').show();}">
						<option value="">This site</option>
						${others.map((row) => html`
								<option value="${raw(row.siteid)}" ${poolToken(bean.privateUserPoolID, row)}>${row.site}</option>
							`)}
					</select>
					</div>

				<div class="mura-control-group">
				<label>${label(m, 'displayobjectpool')}</label>
						<select  name="displayPoolID">
						<option value="">This site</option>
						${others.map((row) => html`
								<option value="${raw(row.siteid)}" ${poolToken(bean.displayPoolID, row)}>${row.site}</option>
							`)}
					</select>
					</div>

				<div class="mura-control-group">
					<label>${label(m, 'filepool')}</label>
					<select  name="filePoolID">
						<option value="">This site</option>
						${others.map((row) => html`
								<option value="${raw(row.siteid)}" ${poolToken(bean.filePoolID, row)}>${row.site}</option>
							`)}
					</select>
					</div>

				<div class="mura-control-group">
					<label>${label(m, 'categorypool')}</label>
					<select id="categoryPoolID" name="categoryPoolID">
							<option value="">This site</option>
							${others.map((row) => html`
									<option value="${raw(row.siteid)}" ${poolToken(bean.categoryPoolID, row)}>${htmlEditFormat(row.site)}</option>
								`)}
						</select>
					</div>

				<div class="mura-control-group">
					 <label>${label(m, 'contentpool')}</label>
						<select id="contentPoolID" name="contentPoolID" multiple>
								<option value="${raw(m.requestSiteId)}" ${contentToken(m.requestSiteId)}>This site</option>
								${others.map((row) => html`
										<option value="${raw(row.siteid)}" ${contentToken(row.siteid)}>${htmlEditFormat(row.site)}</option>
									`)}
							</select>
					 </div>

			</div> ${CFML_COMMENT}
		</div> ${CFML_COMMENT}
	</div> ${CFML_COMMENT}`;
}
