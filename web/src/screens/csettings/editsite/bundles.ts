// Deploy Bundle tab of the Site Settings editor, byte for byte as `csettings/editsite.cfm` emits it (inline styles and
// whitespace included); bundle deploy itself stays legacy-served.
import { html, raw, type SafeHtml } from '@/lib/html';
import { cfEq, type EditSiteModel } from './model';

const USERS_HIDDEN = raw(' style="display:none;"');
const THEME_CHECKED = raw(' checked="true"');
const THEME_NOTICE_HIDDEN = raw(' style="display:none"');

/** Java-disabled branch of the tab: the closed notice block. */
const JAVA_DISABLED = html`
			<div class="block block-bordered">
				<div class="mura-control-group">
					<div class="help-block-empty">
						Java is disabled. This feature is unavailable.
					</div>
				</div>
			</div>
			`;

/** Restore-mode radios, include checkboxes and their notices, rendered for S2 users only. */
function importOptions(m: EditSiteModel): SafeHtml {
  const ownUserPools =
    cfEq(m.bean.publicUserPoolID, m.bean.siteID) && cfEq(m.bean.privateUserPoolID, m.bean.siteID);
  const mailingListMembers = m.sessionSiteEmailBroadcaster && html`
								<label class="checkbox" for="bundleImportMailingListMembersMode">
								<input id="bundleImportMailingListMembersMode" name="bundleImportMailingListMembersMode" value="all" type="checkbox">
								Mailing Lists Members</label>
							`;
  return html`


				<div class="mura-control-group">
					<label> Are you restoring a site from a backup bundle? </label>
						<label class="radio inline"><input type="radio" name="bundleImportKeyMode" value="copy" checked="checked">No - <em>Assign New Keys to Imported Items</em></label>
						<label class="radio inline" for=""><input type="radio" name="bundleImportKeyMode" value="publish">Yes - <em>Maintain All Keys from Imported Items</em></label>
					</div>

				<div class="mura-control-group">
				<label>Include:</label>
				<div class="mura-control">
								<label class="checkbox" for="bundleImportContentMode">
								<input id="bundleImportContentMode" name="bundleImportContentMode" value="all" type="checkbox" onchange="if(this.checked){jQuery('#contentRemovalNotice').show();}else{jQuery('#contentRemovalNotice').hide();}">
								Site Architecture &amp; Content</label>
						<span id="bundleImportUsersModeLI"${ownUserPools ? '' : USERS_HIDDEN}>
								<label class="checkbox" for="bundleImportUsersMode">
								<input id="bundleImportUsersMode" name="bundleImportUsersMode" value="all" type="checkbox"  onchange="if(this.checked){jQuery('#userNotice').show();}else{jQuery('#userNotice').hide();}">
								Site Members &amp; Administrative Users</label>
							</span>

							${mailingListMembers}
								<label class="checkbox" for="bundleImportFormDataMode">
								<input id="bundleImportFormDataMode" name="bundleImportFormDataMode" value="all" type="checkbox">
								Form Response Data</label>
								<label class="checkbox" for="bundleImportPluginMode">
								<input id="bundleImportPluginMode" name="bundleImportPluginMode" value="all" type="checkbox">
								All Plugins</label>
					</div>
						<p class="help-block" style="display:none" id="contentRemovalNotice"><strong>Important:</strong> When importing content from a Masa CMS bundle ALL of the existing content will be deleted.</p>
						<p class="help-block" style="display:none" id="userNotice"><strong>Important:</strong> Importing users will remove all existing user data which may include the account that you are currently logged in as.</p>
					</div>
				 `;
}

/** Java-enabled branch of the tab: the bundle header and form controls, closing only `div.block-content`. */
function deployBlock(m: EditSiteModel): SafeHtml {
  const allRenderingFiles = m.isS2 && html`
								 <label class="radio inline">
									<input type="radio" name="bundleImportRenderingMode" value="all" onchange="if(this.value!='none'){jQuery('#themeNotice').show();}else{jQuery('#themeNotice').hide();}">All</label>
							`;
  const preferred = m.config.postBundles && html`
								<strong>(Preferred)</strong>
							`;
  const serverPathHelp = m.config.postBundles && html`
						<p class="help-block">
							Selecting a bundle file from the server eliminates the need to upload the file via your web browser, avoiding potential timeout issues and server upload restrictions.
						</p>
					`;
  const bundleFile = m.config.postBundles
    ? html`
					<div class="mura-control-group">
						<label>
							<span data-toggle="popover" title="" data-placement="right"
							data-content="Uploading large files via the web browser can result in potential timeout issues and trigger server upload restrictions."
							data-original-title="WARNING">Upload Bundle File <i class="mi-question-circle"></i></span>
						</label>
						<input type="file" name="bundleFile" accept=".zip"/>
					</div>
				`
    : html`
					<input type="hidden" name="bundleFile" value=""/>
				`;
  return html`
			<div class="block block-bordered">
				<!-- block header -->
			  <div class="block-header">
					<h3 class="block-title">Deploy Site Bundle</h3>
			  </div>
			  <!-- /block header -->
			  <div class="block-content">
				${m.isS2 && importOptions(m)}
				<div class="mura-control-group">
					<label> Which rendering files would you like to import? </label>
							${allRenderingFiles}
							<label class="radio inline">
							<input type="radio" name="bundleImportRenderingMode" value="theme" onchange="if(this.value!='none'){jQuery('#themeNotice').show();}else{jQuery('#themeNotice').hide();}"${m.isS2 ? '' : THEME_CHECKED}>Theme Only</label>

							<label class="radio inline">
							<input type="radio" name="bundleImportRenderingMode" value="none" checked="checked" onchange="if(this.value!='none'){jQuery('#themeNotice').show();}else{jQuery('#themeNotice').hide();}">None</label>

							<p class="help-block"${m.isS2 ? THEME_NOTICE_HIDDEN : ''} id="themeNotice"><strong>Important:</strong> Your site theme assignment and gallery image settings will be updated.</p>
					</div>

				<div class="mura-control-group">
					<label>
						<span
							data-toggle="popover"
							title=""
							data-placement="right"
							data-content="Enter the complete server path to the Site Bundle here. For example: C://path/to/bundle/file.zip"
							data-original-title="INFO">
							Select Bundle File From Server
							${preferred}
							<i class="mi-question-circle"></i>
						</span>
					</label>
					<div class="mura-control justify">
						<input class="text" type="text" name="serverBundlePath" id="serverBundlePath" value="">
						<input type="button" value="Browse Server" class="mura-finder" data-serverpath="true" data-resourcetype="root" data-target="serverBundlePath"/>
					</div>
					${serverPathHelp}
				</div>

				${bundleFile}

			</div> 
			`;
}

/** Renders the `#tabBundles` pane (`editsite.cfm` 1182-1293) for the Edit Site composer. */
export function renderBundlesTab(m: EditSiteModel): SafeHtml {
  // Legacy's two closers are unconditional: with Java disabled the second one closes the composer's tab-content.
  return html`		<div id="tabBundles" class="tab-pane">
			${m.config.javaEnabled ? deployBlock(m) : JAVA_DISABLED}
		</div> 
	</div> 
`;
}
