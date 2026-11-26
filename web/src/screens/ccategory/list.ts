// `cCategory.list`: the Categories screen of `ccategory/list.cfm` over strategies-content (server-only).
import { okBody } from '@/lib/gateway-client';
import { html, raw } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { ScreenContext } from '../registry';
import { categoryIdsOf, categoryTreeOf, renderCategoryNest, type CategoryNode } from './dsp-nest';
import { renderCategoryAjax } from './js';
import { ccategorySecondaryMenu } from './secondary-menu';

const SERVICE = 'strategies-content';
const OPERATION = 'listCategories';

/** The site's category tree, as `dsp_nest.cfm` reads it level by level. */
export interface CcategoryListData {
  readonly categories: readonly CategoryNode[];
}

/**
 * The category tree of `rc.siteid`, with every category's delete tokens prefetched.
 * @throws GatewayDenialError When strategies-content answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function loadCcategoryList(ctx: ScreenContext): Promise<CcategoryListData> {
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/categories', {
    params: { siteid: ctx.req.rc.siteid ?? '' },
  });
  const categories = categoryTreeOf(okBody(response, SERVICE, OPERATION).rc);
  await ctx.csrf.prefetch(categoryIdsOf(categories));
  return { categories };
}

/** The list view body with its secondary menu and category tree, and the `js.cfm` script block. */
export function renderCcategoryList(ctx: ScreenContext, data: CcategoryListData): ShellView {
  const nest = renderCategoryNest({
    nodes: data.categories,
    siteid: ctx.req.rc.siteid ?? '',
    rb: ctx.rb,
    csrf: ctx.csrf,
  });
  // ACF prints the view's tag-only lines as nothing; the include adds a line break around the menu.
  const body = html`

\t<div class="mura-header">
\t\t<h1>${raw(ctx.rb.rbKey('categorymanager'))}</h1>

\t\t
${ccategorySecondaryMenu(ctx.req)}

\t</div> <!-- /.mura-header -->

\t<div class="block block-constrain">
\t\t\t<div class="block block-bordered">
\t\t\t\t<div class="block-content">
\t\t\t\t\t\t${nest}
\t\t\t\t<div class="clearfix"></div>
\t\t\t</div> <!-- /.block-content -->
\t\t</div> <!-- /.block-bordered -->
\t</div> <!-- /.block-constrain -->

`;
  return { body, ajax: renderCategoryAjax(ctx.rb) };
}
