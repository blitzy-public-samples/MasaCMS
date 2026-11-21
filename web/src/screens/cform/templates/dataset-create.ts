import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Markup of the form-builder `dataset-create` template. */
export function datasetCreate(input: { readonly rb: RbLookup }): string {
  return `
<span>
		<div id="dataset-create" class="mura-template-form">
			<h2>${input.rb.rbKey('formbuilder.dataset.form')}: <span id="mura-template-form-label"></span></h2>
					<ul class="template-form">
						<li>
							<label for="dataset">${input.rb.rbKey('formbuilder.dataset')}</label>
							<select class="select" name="datasetid">
								<option value="">${input.rb.rbKey('formbuilder.dataset.chooseone')}</option>
								<option value="4FA62B2D-3A29-44B1-8603FB892C60014B">Big Long Honking Name Shirt Sizes</option>
								<option value="77917A42-28F4-4BA4-B88732109F9A05C5">Colors</option>
							</select>
							<input type="button" class="button ui-icon ui-icon-check" name="set-dataset" value="${input.rb.rbKey('formbuilder.dataset.set')}" />
						</li>
						<li>
							<label for="filter">${input.rb.rbKey('formbuilder.dataset.filter')}</label>
							<input class="text medium" type="text" name="filter" id="dataset-filter" value="" maxlength="50" />
							<input type="button" class="button ui-icon ui-icon-check" name="set-filter" value="" />
						</li>
					</ul>
					<div class="btn-wrap">
					<input type="button" class="btn" name="new-datasource" value="${input.rb.rbKey('formbuilder.dataset.createnew')}" />
					</div>
		</div>
	</span>
`;
}
