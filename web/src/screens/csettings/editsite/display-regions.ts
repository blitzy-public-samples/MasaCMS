// Display Regions tab of the Site Settings editor: `admin/core/views/csettings/editsite.cfm` markup as legacy emits it,
// tabs, trailing spaces and `for`-less labels included, so parity with legacy pages holds byte for byte.
import { html, raw, encodeHtmlAttr, type SafeHtml } from '@/lib/html';
import { cfEq, selected, type EditSiteBean, type EditSiteModel } from './model';

/** The `cfloop` options `from`..20 as CFML emits each iteration, selected where `current` CFML-equals the index. */
function loopOptions(from: number, current: EditSiteBean['columnCount' | 'primaryColumn']): SafeHtml[] {
  const options: SafeHtml[] = [];
  for (let i = from; i <= 20; i += 1) {
    options.push(html`
								<option value="${i}" ${selected(cfEq(current, i))}>${i}</option>
							`);
  }
  return options;
}

/** Display Regions pane (`editsite.cfm` 1084-1119): region count, primary region and the `^`-delimited region names. */
export function renderDisplayRegionsTab(m: EditSiteModel): SafeHtml {
  const { columnCount, primaryColumn, columnNames } = m.bean;
  const firstSelected = cfEq(columnCount, 1) || cfEq(columnCount, 0);
  return html`<div id="tabDisplayregions" class="tab-pane">
			<div class="block block-bordered">
				<!-- block header -->
			  <div class="block-header">
					<h3 class="block-title">Display Regions</h3>
			  </div>
			  <!-- /block header -->
			  <div class="block-content">
				<div class="mura-control-group">
					<label>Number of Display Regions</label>
						<select name="columnCount">
						<option value="1" ${selected(firstSelected)}> 1</option>
						${loopOptions(2, columnCount)}
					</select>
					</div>

				 <div class="mura-control-group">
				<label>Primary Display Region</label>
				<span class="help-block">Dynamic System Content such as Login Forms and Search Results get displayed here</span>
						<select name="primaryColumn">
						${loopOptions(1, primaryColumn)}
					</select>
						</div>

				<div class="mura-control-group">
				<label>Display Region Names <span class="help-inline">"^" Delimiter</span></label>
						<input name="columnNames" type="text" value="${raw(encodeHtmlAttr(columnNames))}">
					</div>

			</div> 
		</div> 
	</div> 
`;
}
