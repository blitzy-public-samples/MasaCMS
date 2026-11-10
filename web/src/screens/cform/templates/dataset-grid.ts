import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Form-builder `dataset-grid` template markup, as `formbuilder/templates/dataset-grid.cfm` emits it. */
export function datasetGrid(input: { readonly rb: RbLookup }): string {
  return `<span>
<div class="ui-tabs">
			<ul class="ui-tabs-nav">
				<li id="button-grid-edit" title="${input.rb.rbKey('formbuilder.dataset.edit')}" class="ui-state-default ui-corner-top"><a href="javascript:void(null);"><span>Source</span></a></li>
				<li class="ui-state-default ui-state-active ui-corner-top ui-tabs-selected"><a href="javascript:void(null);"><span>List</span></a></li>
			</ul>
			
			<div class="ui-tabs-panel" id="mura-tb-form-tab-list">
				<div id="dataset-grid" class="mura-tb-form template-form">
				<div id="mura-tb-grid-message" style="display: none">${input.rb.rbKey('formbuilder.dataset.mastermode')}</div>
				<div id="mura-tb-grid">
					<ul id="mura-tb-grid-table-header">
					</ul>
					<ul id="mura-tb-grid-table">
					</ul>
				</div>
			<div class="ui-button" id="button-grid-add" title="${input.rb.rbKey('formbuilder.dataset.add')}">${input.rb.rbKey('formbuilder.dataset.add')}</div>
		</div>
		</div>
	</div>
</span>`;
}
