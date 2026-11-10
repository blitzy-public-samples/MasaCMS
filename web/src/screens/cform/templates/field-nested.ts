import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Renders the legacy `field-nested` form-builder template, listing the forms `loadForms` returns as `formid` options. */
export async function fieldNested(input: {
  readonly rb: RbLookup;
  readonly loadForms: () => Promise<readonly { contentID: string; title: string }[]>;
}): Promise<string> {
  const forms = await input.loadForms();
  const options = forms
    .map(
      (form) => `
									<option value="${form.contentID}">${form.title}</option>
								`,
    )
    .join('');
  return `<span>
		<div class="mura-tb-form">
			<div class="mura-tb-header nestedform">
				<h2><span id="mura-tb-form-label"></span></h2>
				<ul class="mura-tb-nav-utility">
					<li><div id="button-trash" title="${input.rb.rbKey('formbuilder.delete')}"></div></li>
				</ul>
			</div>
			
			<div class="ui-tabs" id="ui-tabs">
			
			<ul class="ui-tabs-nav">
				<li class="ui-state-default ui-corner-top"><a href="#mura-tb-form-tab-basic"><span>Basic</span></a></li>
			</ul>
						
			<div class="ui-tabs-panel" id="mura-tb-form-tab-basic">
			
					<ul class="template-form">
						<li>
							<label for="label">${input.rb.rbKey('formbuilder.field.label')}</label>
							<input class="text tb-label" type="text" name="label" value="" maxlength="250" data-required='true' />
						</li>
						<li>
							<label for="prefix">${input.rb.rbKey('formbuilder.field.prefix')}</label>
							<input id="tb-name" class="text disabled" name="name" type="text" value="" maxlength="250" disabled="true" />
						</li>
						<li>
							<label for="value">${input.rb.rbKey('formbuilder.form')}</label>
							<select name="formid" id="tb-formid">
								${options}
							</select>
						</li>
						
					</ul>
			</div>		
		</div>
		</div>
	</span>
`;
}
