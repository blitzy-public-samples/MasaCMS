import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Form-builder dropdown field editor markup (`field-dropdown.cfm`), labels from the session bundle. */
export function fieldDropdown(input: { readonly rb: RbLookup }): string {
  return `<span>
		<div class="mura-tb-form" id="formblock-\${fieldid}">
			<div class="mura-tb-header dropdown">
				<h2> <span id="mura-tb-form-label"></span></h2>
				<ul class="mura-tb-nav-utility">
					<li><div id="button-trash" title="${input.rb.rbKey('formbuilder.delete')}"></div></li>
				</ul>
			</div>
			
			<div class="ui-tabs" id="ui-tabs">
			
			<ul class="ui-tabs-nav">
				<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>
				<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-advanced"><span>Advanced</span></a></li>
				<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-validation"><span>Validation</span></a></li>
			</ul>
			
			<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">
			
					<ul class="template-form">
						<li>
							<label for="label">${input.rb.rbKey('formbuilder.field.label')}</label>
							<input class="text  tb-label" type="text" name="label" value="" maxlength="50" data-required='true' data-label="true" />
						</li>
						<li>
							<label for="name">${input.rb.rbKey('formbuilder.field.name')}</label>
							<input id="tb-name" class="text  disabled" name="name" type="text" value="" maxlength="50" disabled="true" />
						</li>
						
					</ul>
				</div>
				<div class="ui-tabs-panel" id="mura-tb-form-tab-advanced">
					<ul class="template-form">
						<li>
							<label for="size">${input.rb.rbKey('formbuilder.field.size')}</label>
							<input class="text " type="text" name="size" value="" maxlength="50" data-required='false' />
						</li>
						<li>
							<label for="cssid">${input.rb.rbKey('formbuilder.field.cssid')}</label>
							<input class="text " type="text" name="cssid" value="" maxlength="50" data-required='false' />
						</li>
						<li>
							<label for="cssclass">${input.rb.rbKey('formbuilder.field.cssclass')}</label>
							<input class="text " type="text" name="cssclass" value="" maxlength="50" data-required='false' />
						</li>
						<li>
							<label for="wrappercssclass">${input.rb.rbKey('formbuilder.field.wrappercssclass')}</label>
							<input class="text " type="text" name="wrappercssclass" value="" maxlength="50" data-required='false' />
						</li>
						<li>
							<label for="tooltip">${input.rb.rbKey('formbuilder.field.tooltip')}</label>
							<textarea name="tooltip" value="" maxlength="250" ></textarea>
						</li>
					</ul>
					</div>
					<div class="ui-tabs-panel" id="mura-tb-form-tab-validation">
					
					<ul class="template-form">
						<li>
							<label for="validatemessage">${input.rb.rbKey('formbuilder.field.validatemessage')}</label>
							<input class="text long" type="text" name="validatemessage" value="" maxlength="250" />
						</li>
						<li class="checkbox">
							<label for="isrequired">
							${input.rb.rbKey('formbuilder.field.isrequired')}</label>
							<input type="checkbox" type="text" name="isrequired" value="1">
						</li>
					</ul>
					</div>
				</div>
			</div>
		</div>
	</span>
`;
}
