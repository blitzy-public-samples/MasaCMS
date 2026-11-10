import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Form-builder `field-section` template markup, as `field-section.cfm` emits it. */
export function fieldSection(input: { readonly rb: RbLookup }): string {
  return `<span>
		<div class="mura-tb-form" id="formblock-\${fieldid}">
			<div class="mura-tb-header">
				<h2> <span id="mura-tb-form-label"></span></h2>
				<ul class="mura-tb-nav-utility">
					<li><div id="button-trash" title="${input.rb.rbKey('formbuilder.delete')}"></div></li>
				</ul>
			</div>

			<div class="ui-tabs" id="ui-tabs">
			
				<ul class="template-form">
					<li>
						<label for="label">${input.rb.rbKey('formbuilder.field.label')}</label>
						<input class="text  tb-label" type="text" name="label" value="" data-label="true">
					</li>
					<li>
						<label for="name">${input.rb.rbKey('formbuilder.field.name')}</label>
						<input id="tb-name" class="text" name="name" type="text" value="" maxlength="50" disabled="true" />
					</li>
					<li>
						<label for="fieldsetopen">As Fieldset?
						</label>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
							<select class="select" name="fieldsetopen">
								<option value="0">No</option>
								<option value="1">Yes</option>
							</select>
							(label will not appear)
					</li>
					<li>
					<label for="fieldsetid">Fieldset ID</label>
						<input class="text" type="text" name="fieldsetid" value="" data-label="true">
					</li>
				</ul>
			</div>
		</div>

	</span>
`;
}
