// The `csettings.loadcustomimages` fragment: the image size dialog's save or delete, then the site's sizes (server-only).
import { javaTrim, LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/programs-sites';
import { okBody } from '@/lib/gateway-client';
import { encodeJs, html, raw, type SafeHtml } from '@/lib/html';
import type { FragmentScreen, Rc, ScreenContext } from '../registry';

type ImageSize = components['schemas']['ImageSize'];
type ImageSizeList = components['schemas']['ImageSizeList'];

/** The rc fields `loadBy(sizeid).set(rc).save()` stores, forwarded as posted. */
const SAVED_FIELDS = ['siteid', 'sizeid', 'name', 'height', 'width'] as const;

/** `rc[name]`, failing as CFML does when the element is undefined. */
function rcValue(rc: Rc, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

// ACF's cfswitch Java-trims the expression and matches cases ignoring case; upper-casing reproduces that for these
// ASCII values, including `ſ` matching `s` as Java's equalsIgnoreCase does.
/** The `cfcase` of `rc.imageAction` that runs, if any. */
function imageActionOf(rc: Rc): 'save' | 'delete' | undefined {
  const action = javaTrim(rcValue(rc, 'imageAction')).toUpperCase();
  if (action === 'SAVE') return 'save';
  return action === 'DELETE' ? 'delete' : undefined;
}

/** Saves or deletes `rc.sizeid` in `rc.siteid` when the request names a size and a known action. */
async function applyImageAction({ req, gateway }: ScreenContext): Promise<void> {
  const sizeId = rcValue(req.rc, 'sizeid');
  if (sizeId === '') return;
  const action = imageActionOf(req.rc);
  if (action === undefined) return;
  const path = '/v1/sites/{siteId}/image-sizes/{sizeId}';
  const params = { siteId: rcValue(req.rc, 'siteid'), sizeId };
  if (action === 'delete') {
    okBody(await gateway.programsSites.call('delete', path, { params }), 'programs-sites', 'deleteImageSize');
    return;
  }
  const form = SAVED_FIELDS.flatMap((name): Array<readonly [string, string]> => {
    const value = req.rc[name];
    return value === undefined ? [] : [[name, value]];
  });
  okBody(await gateway.programsSites.call('put', path, { params, form }), 'programs-sites', 'saveImageSize');
}

/** One size row; the id is echoed as stored, the site id JavaScript-encoded and the cells HTML-encoded. */
function sizeRow(size: ImageSize): SafeHtml {
  const open = raw(`return openCustomImageSize('${size.sizeID}','${encodeJs(size.siteID)}');`);
  return html`
<tr>
<td class="actions"><ul>
\t<li class="edit"><a href="#" text="Edit" onclick="${open}"><i class="mi-pencil"></i></a></li>
</ul></td>
<td class="var-width"><a href="#" text="Edit" onclick="${open}">${size.name}</a></td>
<td>${size.height}</td>
<td>${size.width}</td>
</tr>
`;
}

/** The view's bytes as the ACF 2023 oracle serves them: the size table, else the empty-state notice. */
function renderCustomImageSizes(sizes: ImageSizeList): SafeHtml {
  if (sizes.length === 0) {
    return html`\n\t<div class="help-block-empty">There are currently no custom image sizes.</div>\n`;
  }
  return html`
<table class="mura-table-grid">
<tr>
<th class="actions"></th>
<th >Name</th>
<th>Height</th>
<th>Width</th>
</tr>
${sizes.map(sizeRow)}
</table>
`;
}

/** `csettings.loadcustomimages`: applies the posted save or delete, then lists `rc.siteid`'s custom image sizes. */
export const loadCustomImagesScreen: Required<Pick<FragmentScreen<ImageSizeList>, 'load' | 'render'>> = Object.freeze({
  async load(ctx: ScreenContext): Promise<ImageSizeList> {
    await applyImageAction(ctx);
    const siteId = rcValue(ctx.req.rc, 'siteid');
    const response = await ctx.gateway.programsSites.call('get', '/v1/sites/{siteId}/image-sizes', {
      params: { siteId },
    });
    return okBody(response, 'programs-sites', 'listImageSizes');
  },
  render: (_ctx: ScreenContext, sizes: ImageSizeList) => ({
    status: 200,
    contentType: LEGACY_HTML_CONTENT_TYPE,
    body: renderCustomImageSizes(sizes),
  }),
});
