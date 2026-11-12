// The `cSettings.loadcustomimage` fragment: the Edit Site custom image size dialog form (server-only).
import { cfUuid, LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import { encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import type { FragmentScreen, RawBody, ScreenContext } from '../registry';

/** The `imageSize` bean values the dialog shows. */
export interface CustomImageSize {
  readonly sizeID: string;
  readonly name: string;
  readonly height: string;
  readonly width: string;
}

/** The definition `index.ts` completes with its circuit, action, mode, owner and gate. */
export type LoadCustomImageScreen = Omit<
  FragmentScreen<CustomImageSize>,
  'circuit' | 'action' | 'mode' | 'owner' | 'gate' | 'load'
> & {
  load(ctx: ScreenContext): Promise<CustomImageSize>;
};

/** settingsImageSizeBean `init()`: a fresh CF uuid, an empty name, `AUTO` height and width. */
function newImageSize(): CustomImageSize {
  return { sizeID: cfUuid(), name: '', height: 'AUTO', width: 'AUTO' };
}

/** `imageSize.loadBy(sizeid=rc.sizeid)`: the stored size, else the defaulted new size the add flow saves under. */
async function loadImageSize({ req, gateway }: ScreenContext): Promise<CustomImageSize> {
  const sizeId = req.rc.sizeid;
  if (sizeId === undefined) throw new TypeError('Element SIZEID is undefined in RC.');
  // No path segment can carry an empty id, and legacy's lookup by an empty id matches no row.
  if (sizeId === '') return newImageSize();
  const response = await gateway.programsSites.call('get', '/v1/sites/{siteId}/image-sizes/{sizeId}', {
    params: { siteId: req.rc.siteid ?? '', sizeId },
  });
  return okBody(response, 'programs-sites', 'getImageSize');
}

/** The view's markup as ACF emits it: only the `cfoutput` body, a newline on each side. */
function renderCustomImageForm(size: CustomImageSize): SafeHtml {
  // Legacy encodes only the name; the id, height and width are echoed unencoded.
  return html`
 <div id="custom-image-form" data-sizeid="${raw(size.sizeID)}" class="mura-layout-row">
  \t<div class="mura-control-group">
        <label>Name</label>
        <input id="custom-image-name" type="text" value="${raw(encodeHtmlAttr(size.name))}"  onchange="removePunctuation(this);" maxlength="50"/>
    </div>
     <div class="mura-control-group">
        <label>Height</label>
        <input id="custom-image-height" type="text" value="${raw(size.height)}" maxlength="20"/>
    </div>
   \t<div class="mura-control-group">
        <label>Width</label>
        <input id="custom-image-width" type="text" value="${raw(size.width)}" maxlength="20"/>
    </div>
</div>
`;
}

/** `cSettings.loadcustomimage`: the bare form the dialog loads for a new or stored custom image size. */
export const loadCustomImageScreen: LoadCustomImageScreen = Object.freeze({
  load: loadImageSize,
  render: (_ctx: ScreenContext, size: CustomImageSize): RawBody => ({
    status: 200,
    contentType: LEGACY_HTML_CONTENT_TYPE,
    body: renderCustomImageForm(size),
  }),
});
