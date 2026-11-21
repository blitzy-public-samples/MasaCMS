// Email tab of the Site Settings editor (`admin/core/views/csettings/editsite.cfm` lines 679-819).
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import { cfEq, checked, type EditSiteModel } from './model';

const DISABLED = raw('disabled');
const NOTHING = raw('');

/** `esapiEncode('html_attr', value)` as attribute markup. */
function attrValue(value: string): SafeHtml {
  return raw(encodeHtmlAttr(value));
}

/** Renders the `tabEmail` pane: mail server settings, the Test Email Settings button and the notification scripts. */
export function renderEmailTab(m: EditSiteModel): SafeHtml {
  const b = m.bean;
  const useDefaultSMTPServer = cfEq(b.useDefaultSMTPServer, 1);
  // Tab-only lines and trailing spaces are ACF whitespace-management output of the CFML comments and tags; string
  // interpolations (textarea content) get `esapiEncode('html')` from the html tag.
  return html`		<div id="tabEmail" class="tab-pane">
			<div class="block block-bordered">
				<!-- block header -->
			  <div class="block-header">
					<h3 class="block-title">Email</h3>
			  </div>
			  <!-- /block header -->
			  <div class="block-content">
				<div class="mura-control-group">
				<label>Default "From" Email Address</label>
						<input name="contact" type="text" value="${attrValue(b.contact)}" size="50" maxlength="50">
					</div>
				<div class="mura-control-group">
				<label>Mail Server IP/Host Name</label>
						<input name="MailServerIP" type="text" class="text" value="${attrValue(b.mailServerIP)}" size="50" maxlength="50">
					</div>
				<div class="mura-control-group">
				<label>Mail Server SMTP Port</label>
						<input name="MailServerSMTPPort" type="text" class="text" value="${attrValue(b.mailServerSMTPPort)}" size="5" maxlength="5">
					</div>
				<div class="mura-control-group">
				<label>Mail Server POP Port</label>
						<input name="MailServerPOPPort" type="text" class="text" value="${attrValue(b.mailServerPOPPort)}" size="5" maxlength="5">
					</div>

				<div class="mura-control-group">
				<label>Mail Server Username
					<span data-toggle="popover" title="" data-placement="right"
				  	data-content="Do Not Use a Personal Account. Email will be removed from server for tracking purposes."
				  	data-original-title="WARNING:">
				  	<i class="mi-warning"></i></span></label>
						<input name="MailServerUserName" type="text" value="${attrValue(b.mailServerUsername)}" size="255" maxlength="255">
				</div>
				<div class="mura-control-group">
				<label>Mail Server Password</label>
						<input name="MailServerPassword" type="text" value="${attrValue(b.mailServerPassword)}" size="255" maxlength="255">
				</div>

			<div class="mura-control-group">
				<label>Use TLS</label>
						<label class="radio inline">
						<input type="radio" name="mailServerTLS" value="true" ${checked(cfEq(b.mailServerTLS, 'true'))}>
						Yes </label>
						<label class="radio inline">
						<input type="radio" name="mailServerTLS" value="false" ${checked(cfEq(b.mailServerTLS, 'false'))}>
						No </label>
					</div>
			<div class="mura-control-group">
				<label>Use SSL</label>
						<label class="radio inline">
						<input type="radio" name="mailServerSSL" value="true" ${checked(cfEq(b.mailServerSSL, 'true'))}>
						Yes </label>
						<label class="radio inline">
						<input type="radio" name="mailServerSSL" value="false" ${checked(cfEq(b.mailServerSSL, 'false'))}>
						No </label>
					</div>
			<div class="mura-control-group">
				<label>Use Default SMTP Server</label>
						<label class="radio inline">
						<input type="radio" name="useDefaultSMTPServer" value="1" ${checked(useDefaultSMTPServer)}>
						Yes </label>
						<label class="radio inline">
						<input type="radio" name="useDefaultSMTPServer" value="0" ${checked(!useDefaultSMTPServer)}>
						No </label>
					</div>

			<div class="mura-control-group">
				
				

				<button type="button" class="btn btn-secondary mura-primary" onclick="testEmail( event );" id="testEmailSettings" ${useDefaultSMTPServer ? DISABLED : NOTHING}>
					<i class="mi-check-circle"></i> Test Email Settings
				</button>
			</div>

				<div class="mura-control-group">
   				<label>Content Pending Script</label>
   						<p class="help-block">Available Dynamic Content: #returnURL# #contentName# #contentType#</p>
   						<textarea rows="6" name="contentPendingScript">${b.contentPendingScript}</textarea>
	   			</div>

			 <div class="mura-control-group">
				<label>Content Approval Script</label>
						<p class="help-block">Available Dynamic Content: #returnURL# #contentName# #contentType#</p>
						<textarea rows="6" name="contentApprovalScript">${b.contentApprovalScript}</textarea>
			</div>

			 <div class="mura-control-group">
				<label>Content Rejection Script</label>
						<p class="help-block">Available Dynamic Content: #returnURL# #contentName# #contentType#</p>
						<textarea rows="6" name="contentRejectionScript">${b.contentRejectionScript}</textarea>
			</div>

			<div class="mura-control-group">
			   <label>Content Canceled Script</label>
					   <p class="help-block">Available Dynamic Content: #returnURL# #contentName# #contentType#</p>
					   <textarea rows="6" name="contentCanceledScript">${b.contentCanceledScript}</textarea>
		   </div>

			<div class="mura-control-group">
				<label>User Login Authorization Code Challenge Script</label>
					<p class="help-block">Available Dynamic Content: #firstName# #lastName# #username# #email# #authcode# #contactEmail# #contactName#</p>
					<textarea rows="6" name="sendAuthCodeScript">${b.sendAuthCodeScript}</textarea>
			</div>

			<div class="mura-control-group">
				<label>User Login Info Request Script</label>
					<p class="help-block">Available Dynamic Content: #firstName# #lastName# #username# #password# #contactEmail# #contactName# #returnURL#</p>
					<textarea rows="6" name="sendLoginScript">${b.sendLoginScript}</textarea>
			</div>

			<div class="mura-control-group">
				<label>Mailing List Confirmation Script</label>
					<p class="help-block">Available Dynamic Content: #listName# #contactName# #contactEmail# #returnURL#</p>
					<textarea rows="6" name="mailingListConfirmScript">${b.mailingListConfirmScript}</textarea>
			</div>
				<div class="mura-control-group">
				<label>Account Activation Script</label>
						<p class="help-block">Available Dynamic Content: #firstName# #lastName# #username# #contactEmail# #contactName#</p>
						<textarea rows="6" name="accountActivationScript">${b.accountActivationScript}</textarea>
			</div>
			
				<div class="mura-control-group">
				<label>Event Reminder Script</label>
						<p class="help-block">Available Dynamic Content: #returnURL# #eventTitle# #startDate# #startTime# #siteName# #eventContactName# #eventContactAddress# #eventContactCity# #eventContactState# #eventContactZip# #eventContactPhone#</p>
						<textarea rows="6" name="reminderScript">${b.reminderScript}</textarea>
			</div>

			</div> 
		</div> 
	</div> `;
}
