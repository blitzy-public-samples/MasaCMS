// Basic tab of the Site Settings editor: the `tabBasic` pane of `admin/core/views/csettings/editsite.cfm`.
import { encodeHtml, encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { cfEq, checked, selected, type EditSiteModel, type ReCaptchaLanguage } from './model';

// The templates are the legacy markup verbatim, its defects included, because parity forbids correcting it. Their tabs
// are the legacy indentation as ACF emits it: CFML tags and comments leave their surrounding whitespace, except that
// whitespace-only text between two CFML tags is dropped and whitespace-only text between an expression and a CFML tag
// becomes one space.

type Scalar = string | number;

/** `esapiEncode('html_attr', value)`. */
function attrValue(value: Scalar): SafeHtml {
  return raw(encodeHtmlAttr(String(value)));
}

/** A label as `rbKey` returns it, unencoded as legacy writes it. */
function label(rb: RbLookup, key: string): SafeHtml {
  return raw(rb.rbKey(key));
}

/** A label HTML-attribute-encoded, for the popover attributes. */
function labelAttr(rb: RbLookup, key: string): SafeHtml {
  return raw(encodeHtmlAttr(rb.rbKey(key)));
}

/** CFML `value eq 1`. */
function isOne(value: Scalar): boolean {
  return cfEq(value, 1);
}

/** `listSort`/`StructSort` with `textnocase` and `asc`: code-unit order of the lower-cased strings. */
function compareNoCase(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Editable id on Add Site (`rc.siteid` empty), otherwise a disabled copy plus the hidden field; unencoded as legacy. */
function siteIdField(m: EditSiteModel): SafeHtml {
  const siteID = raw(m.bean.siteID);
  if (m.requestSiteId === '') {
    return html`
								<p class="help-block">Warning: No spaces, punctuation, dots or file delimiters allowed.</p>
										<input name="siteid" type="text" value="${siteID}" size="25" maxlength="25" required="true" onchange="removePunctuation(this);">
								`;
  }
  return html`
										<input  id="disabledInput" type="text" placeholder="${siteID}" disabled>
								<input name="siteid" type="hidden" value="${siteID}">
							`;
}

/** Site ID through Use SSL. */
function identitySection(m: EditSiteModel): SafeHtml {
  const { bean, rb } = m;
  return html`<div id="tabBasic" class="tab-pane active">
				<div class="block block-bordered">
						<!-- block header -->
					  <div class="block-header">
							<h3 class="block-title">Basic Settings</h3>
					  </div>
					  <!-- /block header -->
					  <div class="block-content">
							<div class="mura-control-group">
								<label>Site ID</label>
								${siteIdField(m)}
							</div>
							<div class="mura-control-group">
								<label>Site Name</label>
								<input name="site" type="text" value="${attrValue(bean.site)}" size="50" maxlength="50">
					</div>

				
						<div class="mura-control-group">
							<label>
								<span data-toggle="popover" title="" data-placement="right"
							  	data-content="${labelAttr(rb, 'siteconfig.sitesettings.tagline.tooltip')}"
							  	data-original-title="${labelAttr(rb, 'siteconfig.sitesettings.tagline')}">
							${label(rb, 'siteconfig.sitesettings.tagline')}
									<i class="mi-question-circle"></i>
								</span>
					</label>
								<input name="tagline" type="text" value="${attrValue(bean.tagline)}" size="50" maxlength="255">
				</div>

				
						<div class="mura-control-group">
							<label>
								<span data-toggle="popover" title="" data-placement="right"
							  	data-content="${labelAttr(rb, 'siteconfig.sitesettings.primarydomain.tooltip')}"
							  	data-original-title="${labelAttr(rb, 'siteconfig.sitesettings.primarydomain')}">			${label(rb, 'siteconfig.sitesettings.primarydomain')}
									<i class="mi-question-circle"></i>
								</span>
							</label>
							<input name="domain" type="text" value="${attrValue(bean.domain)}" size="50" maxlength="255">
					</div>

						<div class="mura-control-group">
							<label>Domain Alias List <span>(Line Delimited)</span></label>
							<textarea name="domainAlias" rows="6">${raw(encodeHtml(bean.domainAlias))}</textarea>
				</div>

					
							<div class="mura-control-group">
								<label>Enforce Primary Domain</label>
							<label class="radio inline">
										<input type="radio" name="enforcePrimaryDomain" value="0"${checked(!isOne(bean.enforcePrimaryDomain))}>
								Off
							</label>
							<label class="radio inline">
										<input type="radio" name="enforcePrimaryDomain" value="1"${checked(isOne(bean.enforcePrimaryDomain))}>
								On
							</label>
						</div>

					
							<div class="mura-control-group">
								<label>
								<span data-toggle="popover" title="" data-placement="right"
							  	data-content="${labelAttr(rb, 'siteconfig.sitesettings.usessl.tooltip')}"
							  	data-original-title="${labelAttr(rb, 'siteconfig.sitesettings.usessl')}">
									${label(rb, 'siteconfig.sitesettings.usessl')} <i class="mi-question-circle"></i></span>
								</label>
							<label class="radio inline">
									<input type="radio" name="useSSL" value="0"${checked(!isOne(bean.useSSL))}>
								${label(rb, 'sitemanager.no')}
							</label>
							<label class="radio inline">
									<input type="radio" name="useSSL" value="1"${checked(isOne(bean.useSSL))}>
								${label(rb, 'sitemanager.yes')}
							</label>
						</div>

`;
}

const LOCALE_DEPRECATED = html`
												(not supported, deprecated)
											`;

/** One `siteLocale` option per supported locale, in `listSort(…, 'textnocase', 'ASC')` order. */
function localeOptions(m: EditSiteModel): SafeHtml[] {
  return [...m.supportedLocales].sort(compareNoCase).map(
    (l) => html`
										<option value="${raw(l)}"${selected(cfEq(m.bean.siteLocale, l))}>
											${raw(l)} ${m.isSupportedLocale(l) ? '' : LOCALE_DEPRECATED}
										</option>
									`,
  );
}

const THEME_NONE = html`
										<option value="">None</option>
									`;

/** One `theme` option per theme in query order; Add Site (no bean site id) also selects the first. */
function themeOptions(m: EditSiteModel): SafeHtml[] {
  const { bean } = m;
  return m.themes.map(
    (name, index) => html`
										<option value="${raw(name)}"${selected(cfEq(name, bean.theme) || (bean.siteID === '' && index === 0))}>${raw(name)}</option>
									`,
  );
}

const EXPORT_LOCATION_INVALID = html`
								<p class="help-block">The current value is not a valid directory</p>
							`;

/** Locale through Site Mode. */
function settingsSection(m: EditSiteModel): SafeHtml {
  const { bean } = m;
  const exportLocationInvalid = bean.exportLocation.length > 0 && !m.exportLocationExists;
  return html`							<div class="mura-control-group">
								<label>Locale</label>
								<select name="siteLocale">
								<option value="">Default</option>
								${localeOptions(m)}
							</select>
							</div>

							<div class="mura-control-group">
								<label>Theme</label>
								<select name="theme">
								${m.hasNonThemeTemplates ? THEME_NONE : ''}${themeOptions(m)}
							</select>
							</div>
							<div class="mura-control-group">
								<label>Page Limit</label>
										<input name="pagelimit" type="text" value="${attrValue(bean.pageLimit)}" size="5" maxlength="6">
							</div>
							<div class="mura-control-group">
								<label>Default  Rows <span>(in Content Tree View)</span></label>
										<input name="nextN" type="text" value="${attrValue(bean.nextN)}" size="5" maxlength="5">
					</div>
							<div class="mura-control-group">
								<label>Site Caching</label>
								<label class="radio inline">
										<input type="radio" name="cache" value="0"${checked(!isOne(bean.cache))}>
								Off</label>
								<label class="radio inline">
										<input type="radio" name="cache" value="1"${checked(isOne(bean.cache))}>
								On</label>
							</div>
						
							<div class="mura-control-group">
								<label>Cache Free Memory Threshold <span class="help-inline">(Defaults to 60%)</span></label>
								<input name="cacheFreeMemoryThreshold" type="text" value="${attrValue(bean.cacheFreeMemoryThreshold)}" size="3" maxlength="3">
										%
					</div>
							<div class="mura-control-group">
								<label>Lock Site Architecture</label>
								<p class="help-block">Restricts Addition or Deletion of Site Content</p>
								<label class="radio inline">
										<input type="radio" name="locking" value="none" ${checked(cfEq(bean.locking, 'none') || cfEq(bean.locking, ''))}>
								None</label>
								<label class="radio inline">
										<input type="radio" name="locking" value="all" ${checked(cfEq(bean.locking, 'all'))}>
								All</label>
								<label class="radio inline">
										<input type="radio" name="locking" value="top" ${checked(cfEq(bean.locking, 'top'))}>
								Top</label>
							</div>
							<div class="mura-control-group">
								<label>Allow Comments to be Posted Without Site Admin Approval</label>
								<label class="radio inline">
										<input type="radio" name="CommentApprovalDefault" value="1" ${checked(isOne(bean.commentApprovalDefault))}>
								Yes</label>
								<label class="radio inline">
										<input type="radio" name="CommentApprovalDefault" value="0" ${checked(!isOne(bean.commentApprovalDefault))}>
								No</label>
						</div>

							<div class="mura-control-group">
								<label>Static HTML Export Location (BETA)</label>
						${exportLocationInvalid ? EXPORT_LOCATION_INVALID : ''}
								<input name="exportLocation" type="text" value="${attrValue(bean.exportLocation)}" maxlength="100"/>
					</div>
							 <div class="mura-control-group">
								<label>Custom Tag Groups <span class="help-inline">("^" Delimiter. List elements must use valid variable names.)</span></label>
									<input name="customTagGroups" type="text" value="${attrValue(bean.customTagGroups)}" maxlength="255"/>
				</div>
							<div class="mura-control-group">
								<label>Site Mode</label>
							<select name="enableLockdown">
									<option value=""${selected(cfEq(bean.enableLockdown, ''))}>Live</option>
									<option value="development"${selected(cfEq(bean.enableLockdown, 'development'))}>Development</option>
									<option value="maintenance"${selected(cfEq(bean.enableLockdown, 'maintenance'))}>Maintenance</option>
								</select>
						</div>

`;
}

/** Allow Content Locking, shown only when the global `lockableNodes` flag is on. */
function lockableNodesGroup(m: EditSiteModel): SafeHtml {
  if (!m.config.lockableNodes) return raw('');
  const { bean } = m;
  return html`
							<div class="mura-control-group">
									<label>Allow Content Locking</label>
									<p class="help-block">Grants content editors the right to exlusively lock a content node and all of it's versions when editing.</p>
									<label class="radio inline">
											<input type="radio" name="hasLockableNodes" value="1" ${checked(isOne(bean.hasLockableNodes))}>
									Yes</label>
									<label class="radio inline">
											<input type="radio" name="hasLockableNodes" value="0" ${checked(!isOne(bean.hasLockableNodes))}>
									No</label>
					</div>
				`;
}

/** Content locking through Use SSL for Resources. */
function remoteSection(m: EditSiteModel): SafeHtml {
  const { bean, rb } = m;
  return html`				
				${lockableNodesGroup(m)}
				

				
						<div class="mura-control-group">
								<label>Is this a Remote Site? (WARNING: When set to true all content MUST be rendered via the JSON/REST APIs)</label>
								<label class="radio inline">
										<input type="radio" name="IsRemote" value="0"${checked(!isOne(bean.isRemote))}>
								No</label>
								<label class="radio inline">
										<input type="radio" name="IsRemote" value="1"${checked(isOne(bean.isRemote))}>
								Yes</label>
						</div>
						<div class="mura-control-group">
								<label>Remote Context</label>
									<input name="remotecontext" type="text" value="${attrValue(bean.remoteContext)}" maxlength="100">
						</div>
						<div class="mura-control-group">
								<label>Remote Port</label>
									<input name="remoteport" type="text" value="${attrValue(bean.remotePort)}"maxlength="4">
				</div>

						<div class="mura-control-group">
									<label>
									<span data-toggle="popover" title="" data-placement="right"
							  		data-content="${labelAttr(rb, 'siteconfig.sitesettings.resourcedomain.tooltip')}"
							  		data-original-title="${labelAttr(rb, 'siteconfig.sitesettings.resourcedomain')}">
									${label(rb, 'siteconfig.sitesettings.resourcedomain')}
											<i class="mi-question-circle"></i>
										</span>
							</label>
										<input name="resourcedomain" type="text" value="${attrValue(bean.resourceDomain)}" size="50" maxlength="255">
						</div>
						<div class="mura-control-group">
								<label>${label(rb, 'siteconfig.sitesettings.resourcessl')} </label>
							<label class="radio inline">
										<input type="radio" name="resourceSSL" value="0"${checked(!isOne(bean.resourceSSL))}>
								${label(rb, 'sitemanager.no')}
							</label>
							<label class="radio inline">
										<input type="radio" name="resourceSSL" value="1"${checked(isOne(bean.resourceSSL))}>
								${label(rb, 'sitemanager.yes')}
							</label>
						</div>
`;
}

/** One `reCAPTCHALanguage` option per language, ordered by code as `StructSort(…, 'textnocase', 'asc')` orders keys. */
function languageOptions(m: EditSiteModel): SafeHtml[] {
  return [...m.recaptchaLanguages]
    .sort((a: ReCaptchaLanguage, b: ReCaptchaLanguage) => compareNoCase(a.value, b.value))
    .map(
      (lang) => html`
									<option value="${raw(lang.value)}"${selected(cfEq(m.bean.reCAPTCHALanguage, lang.value))}>${raw(lang.label)}</option>
								`,
    );
}

/** The reCAPTCHA notice above the key fields, shown while either key is empty. */
function recaptchaMessage(rb: RbLookup): SafeHtml {
  return html`
					<div class="help-block-inline">
						${label(rb, 'siteconfig.recaptcha.message')}
					</div>
				`;
}

/** The Google key-registration button under the site key, shown while either key is empty. */
function recaptchaGetKeys(rb: RbLookup): SafeHtml {
  return html`
								<div class="mura-control justify">
									<a class="btn" href="http://www.google.com/recaptcha/admin" target="_blank">
									<i class="mi-key"></i> ${label(rb, 'siteconfig.recaptcha.getgooglekeys')}
									</a>
								</div>
							`;
}

/** reCAPTCHA site key, secret and language, then the pane's closing tags. */
function recaptchaSection(m: EditSiteModel): SafeHtml {
  const { bean, rb } = m;
  const keysMissing = bean.reCAPTCHASiteKey.length === 0 || bean.reCAPTCHASecret.length === 0;
  // The secret label ends in a stray `</a>` and leaves its `<span>` open, as legacy emits it.
  // The empty option is always selected: legacy tests the misspelt `getReCAPTACHALanguage()`, which is always empty.
  return html`				

				
				${keysMissing ? recaptchaMessage(rb) : ''}

					<div class="mura-control-group">
						
						<label>
						<span data-toggle="popover" title="" data-placement="right"
					  	data-content="${labelAttr(rb, 'siteconfig.recaptcha.getapikeys')}"
					  	data-original-title="${labelAttr(rb, 'siteconfig.recaptcha.sitekey')}">
								${label(rb, 'siteconfig.recaptcha.sitekey')} <i class="mi-question-circle"></i></span>
						</label>
							<input name="reCAPTCHASiteKey" class="mura-constrain" type="text" value="${attrValue(bean.reCAPTCHASiteKey)}" maxlength="50">
							${keysMissing ? recaptchaGetKeys(rb) : ''}
					</div>
					
						<div class="mura-control-group">
								<label>
								<span data-toggle="popover" title="" data-placement="right"
							  	data-content="${labelAttr(rb, 'siteconfig.recaptcha.getapikeys')}"
							  	data-original-title="${labelAttr(rb, 'siteconfig.recaptcha.secret')}">
								${labelAttr(rb, 'siteconfig.recaptcha.secret')} <i class="mi-question-circle"></i></a>
								</label>
								<input name="reCAPTCHASecret" class="mura-constrain" type="text" value="${attrValue(bean.reCAPTCHASecret)}" maxlength="50">
					</div>
					
						<div class="mura-control-group">
								<label>
								<span data-toggle="popover" title="" data-placement="right"
							  	data-content="${labelAttr(rb, 'siteconfig.recaptcha.languageoptions')}"
							  	data-original-title="${labelAttr(rb, 'siteconfig.recaptcha.language')}">
									${label(rb, 'siteconfig.recaptcha.language')} <i class="mi-question-circle"></i></span>
								</label>
							
							<select class="mura-constrain" name="reCAPTCHALanguage">
								<option value=""
									selected>- ${label(rb, 'siteconfig.recaptcha.selectlanguage')} -</option>
								${languageOptions(m)}
							</select>
						</div>

				

			</div> 
		</div> 
	</div> `;
}

/** Markup of the Basic tab pane, from its `div#tabBasic` through its closing tag. */
export function renderBasicTab(m: EditSiteModel): SafeHtml {
  return html`${identitySection(m)}${settingsSection(m)}${remoteSection(m)}${recaptchaSection(m)}`;
}
