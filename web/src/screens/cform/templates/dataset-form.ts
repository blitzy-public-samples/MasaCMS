import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Renders the form-builder dataset editor panel (`dataset-form.cfm`). */
export function datasetForm(input: { readonly rb: RbLookup }): string {
  return `
	<div class="ui-tabs">
		<ul class="ui-tabs-nav">
			<li title="${input.rb.rbKey('formbuilder.dataset.edit')}" class="ui-state-active ui-corner-top ui-tabs-selected"><a href="javascript:void(null);"><span>Source</span></a></li>
			<li id="button-grid-grid" class="ui-state-default ui-corner-top"><a href="javascript:void(null);"><span>List</span></a></li>
		</ul>
			<div class="ui-tabs-panel" id="mura-tb-form-tab-source">
			<div id="mura-tb-dataset" class="mura-tb-form">

					<ul class="template-form">
						<li class="mura-tb-grp-sourcetype">
							<label for="dataset">${input.rb.rbKey('formbuilder.dataset.sourcetype')}</label>
							<select class="select" name="sourcetype" id="mura-tb-dataset-sourcetype">
								<option value="entered">${input.rb.rbKey('formbuilder.dataset.sourcetype.entered')}</option>
								<option value="dsp">${input.rb.rbKey('formbuilder.dataset.sourcetype.dsp')}</option>
								<option value="object">${input.rb.rbKey('formbuilder.dataset.sourcetype.object')}</option>
								
								<option value="remote">${input.rb.rbKey('formbuilder.dataset.sourcetype.remote')}</option>
							</select>
						</li>

						<li class="mura-tb-dsi mura-tb-grp-entered" style="display: none">
							<label for="dataset">${input.rb.rbKey('formbuilder.dataset.issorted')}</label>
							<select class="select" name="issorted" id="mura-tb-dataset-issorted">
								<option value="0">${input.rb.rbKey('formbuilder.dataset.issorted.manual')}</option>
								<option value="1">${input.rb.rbKey('formbuilder.dataset.issorted.sorted')}</option>
							</select>
						</li>
						<li class="mura-tb-dsi mura-tb-grp-sorted" style="display: none">
							<label for="dataset">${input.rb.rbKey('formbuilder.dataset.sorttype')}</label>
							<select class="select" name="sorttype" id="mura-tb-dataset-sorttype">
								<option value="string">${input.rb.rbKey('formbuilder.dataset.sorttype.string')}</option>
								<option value="numeric">${input.rb.rbKey('formbuilder.dataset.sorttype.numeric')}</option>
								<option value="date">${input.rb.rbKey('formbuilder.dataset.sorttype.date')}</option>
							</select>
						</li>
						<li class="mura-tb-dsi mura-tb-grp-sorted" style="display: none">
							<label for="dataset">${input.rb.rbKey('formbuilder.dataset.sortcolumn')}</label>
							<select class="select" name="sortcolumn" id="mura-tb-dataset-sortcolumn">
								<option value="label">${input.rb.rbKey('formbuilder.dataset.sortcolumn.label')}</option>
								<option value="value">${input.rb.rbKey('formbuilder.dataset.sortcolumn.value')}</option>
							</select>
						</li>
						<li class="mura-tb-dsi mura-tb-grp-sorted" style="display: none">
							<label for="dataset">${input.rb.rbKey('formbuilder.dataset.sortdirection')}</label>
							<select class="select" name="sortdirection" id="mura-tb-dataset-sortdirection">
								<option value="asc">${input.rb.rbKey('formbuilder.dataset.sortdirection.asc')}</option>
								<option value="desc">${input.rb.rbKey('formbuilder.dataset.sortdirection.desc')}</option>
							</select>
						</li>
						<li class="mura-tb-dsi mura-tb-grp-source" style="display: none">
							<label for="dataset">${input.rb.rbKey('formbuilder.dataset.source')}</label>
							<input class="text tb-source" id="mura-tb-dataset-source" type="text" name="source" value="" maxlength="250" />
						</li>
					</ul>
					<div class="btn-wrap">
						<input type="button" class="btn" name="save-dataset" id="mura-tb-save-dataset" value="${input.rb.rbKey('formbuilder.dataset.update')}" />
					</div>
				</div>
			</div>

		</div>
`;
}
