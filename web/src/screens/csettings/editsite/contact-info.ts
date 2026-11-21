// Contact Info tab of the Site Settings editor (`admin/core/views/csettings/editsite.cfm`).
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import type { EditSiteModel } from './model';

/** `esapiEncode('html_attr', v)` as markup; `raw` keeps `html` from encoding the already-encoded value again. */
function attrValue(v: string): SafeHtml {
  return raw(encodeHtmlAttr(v));
}

/** Renders the `tabContactinfo` pane with the site's default contact fields. */
export function renderContactInfoTab(m: EditSiteModel): SafeHtml {
  const { bean } = m;
  return html`		<div id="tabContactinfo" class="tab-pane">
			<div class="block block-bordered">
				<!-- block header -->
			  <div class="block-header">
					<h3 class="block-title">Contact Info</h3>
				</div>
			  <!-- /block header -->
			  <div class="block-content">
					<div class="mura-control-group">
								<label>Contact Name </label>
									<input name="contactName" type="text" value="${attrValue(bean.contactName)}" size="50" maxlength="50" maxlength="100">
						</div>

					<div class="mura-control-group">
								<label>Contact Address </label>
									<input name="contactAddress" type="text" value="${attrValue(bean.contactAddress)}" size="50" maxlength="50" maxlength="100">
					</div>

					<div class="mura-control-group">
								<label>Contact City </label>
									<input name="contactCity" type="text" value="${attrValue(bean.contactCity)}" size="50" maxlength="50" maxlength="100">
								</div>
					<div class="mura-control-group">
								<label>Contact State </label>
									<input name="contactState" type="text" value="${attrValue(bean.contactState)}" size="50" maxlength="50" maxlength="100">
							</div>
					<div class="mura-control-group">
								<label>Contact Zip </label>
									<input name="contactZip" type="text" value="${attrValue(bean.contactZip)}" size="50" maxlength="50" maxlength="100">
								</div>
					<div class="mura-control-group">
								<label>Contact Phone </label>
								<input name="contactPhone" type="text" value="${attrValue(bean.contactPhone)}" size="50" maxlength="50" maxlength="100">
							</div>

					<div class="mura-control-group">
							<label>Contact Email </label>
							<input name="contactEmail" type="text" value="${attrValue(bean.contactEmail)}" size="50" maxlength="50" maxlength="100">
						</div>

			</div> 
		</div> 
	</div> 
`;
}
