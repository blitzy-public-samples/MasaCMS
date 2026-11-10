import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Renders the form-builder `dataset-sourced` template: the read-only source panel of a sourced dataset. */
export function datasetSourced(input: { readonly rb: RbLookup }): string {
  return `
	<div id="mura-tb-grid" class="mura-tb-form">
		<div id="dataset-sourced" class="mura-tb-header">
			<h2>${input.rb.rbKey('formbuilder.source')}</h2>
			<ul class="right">
				<li><div class="ui-button" id="button-grid-edit" title="${input.rb.rbKey('formbuilder.dataset.edit')}"><span class="ui-icon ui-icon-pencil"></span></div></li>
			</ul>
		</div>
		<div class="columns">
			<div class="col2">
				<ul class="template-form">
					<li>
						<label for="dataset">${input.rb.rbKey('formbuilder.source')}</label>
						<input id="tb-source" class="text medium disabled" name="source" type="text" value="" maxlength="150" disabled="true" />
					</li>
				</ul>
			</div>
		</div>
	</div>
`;
}
