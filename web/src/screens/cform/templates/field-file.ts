import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Renders the form-builder `field-file` template (legacy `formbuilder/templates/field-file.cfm`). */
export function fieldFile(input: { readonly rb: RbLookup }): string {
  return `<span>
		<div class="mura-tb-form">
			<div class="mura-tb-header fileuploadfield">
				<h2><span id="mura-tb-form-label"></span></h2>
				<ul class="mura-tb-nav-utility">
					<li><div id="button-trash" title="${input.rb.rbKey('formbuilder.delete')}"></div></li>
				</ul>
			</div>

			<div class="ui-tabs" id="ui-tabs">

			<ul class="ui-tabs-nav">
				<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>
				<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-validation"><span>Validation</span></a></li>
			</ul>

			<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">

					<ul class="template-form">
						<li>
							<label for="label">${input.rb.rbKey('formbuilder.field.label')}</label>
							<input class="text tb-label" type="text" name="label" value="" maxlength="250" data-required='true' />
						</li>
						<li>
							<label for="name">${input.rb.rbKey('formbuilder.field.name')}</label>
							<input id="tb-name" class="text disabled" name="name" type="text" value="" maxlength="250" disabled="true" />
						</li>
						<li>
							<label for="placeholder">${input.rb.rbKey('formbuilder.field.placeholder')}</label>
							<input class="text " type="text" name="placeholder" value="" maxlength="255" data-required='false' />
						</li>
					</ul>
			</div>
			<div class="ui-tabs-panel" id="mura-tb-form-tab-validation">
					<ul class="template-form">
						<li>
							<label for="validatetype">${input.rb.rbKey('formbuilder.field.validatetype')}</label>
							<select class="select" name="validatetype">
								<option value="">${input.rb.rbKey('formbuilder.field.validate.none')}</option>
								<option value="regex">${input.rb.rbKey('formbuilder.field.validate.regex')}</option>
							</select>
						</li>
						<li>
							<label for="validateregex">${input.rb.rbKey('formbuilder.field.validateregex')}</label>
							<input class="text long" type="text" name="validateregex" value="" maxlength="350" />
						</li>
						<li>
							<label for="validatemessage">${input.rb.rbKey('formbuilder.field.validatemessage')}</label>
							<input class="text long" type="text" name="validatemessage" value="" maxlength="250" />
						</li>
						<li class="checkbox">
							<label for="isrequired">
							${input.rb.rbKey('formbuilder.field.isrequired')}</label>
							<input type="checkbox" name="isrequired" value="1">
						</li>
					</ul>
			</div>
		</div>
	</span>
`;
}
