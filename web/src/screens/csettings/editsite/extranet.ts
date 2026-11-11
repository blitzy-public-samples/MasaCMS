// Extranet tab of `csettings/editsite.cfm`.
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import { cfEq, checked, type EditSiteModel } from './model';

/** Renders the Extranet Settings tab pane from the site bean. */
export function renderExtranetTab(m: EditSiteModel): SafeHtml {
  const { bean } = m;
  const publicReg = cfEq(bean.extranetPublicReg, 1);
  // Legacy writes the notify list unencoded; reproduced as legacy renders it, not escaped.
  const notify = raw(bean.extranetPublicRegNotify);
  return html`		<div id="tabExtranet" class="tab-pane">
			<div class="block block-bordered">
				<!-- block header -->
			  <div class="block-header">
					<h3 class="block-title">Extranet Settings</h3>
			  </div>
			  <!-- /block header -->
			  <div class="block-content">
				<div class="mura-control-group">
				<label>Allow Public Site Registration</label>
						<label class="radio inline">
						<input type="radio" name="extranetpublicreg" value="0" ${checked(!publicReg)}>
						No </label>
						<label class="radio inline">
						<input type="radio" name="extranetpublicreg" value="1" ${checked(publicReg)}>
						Yes </label>
					</div>
			

				<div class="mura-control-group">
				<label>Custom Login URL</label>
						<input name="loginURL" type="text" value="${raw(encodeHtmlAttr(bean.loginURL))}" maxlength="255">
				</div>
				<div class="mura-control-group">
				<label>Custom Profile URL</label>
						<input name="editProfileURL" type="text" value="${raw(encodeHtmlAttr(bean.editProfileURL))}" maxlength="255">
				</div>
				

				<div class="mura-control-group">
				<label>Email Site Registration Notifications to:</label>
						<input name="ExtranetPublicRegNotify" type="text" value="${notify}" size="255" maxlength="255">
			</div>

			</div> 
		</div> 
	</div> `;
}
