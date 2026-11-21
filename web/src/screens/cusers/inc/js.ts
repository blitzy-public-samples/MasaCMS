// cUsers `inc/js.cfm`: the client script the user views put in `request.ajax` (server-only).
import { raw, type SafeHtml } from '@/lib/html';
import { adminAssetUrl } from '@/lib/urls';
import type { ScreenContext } from '../../registry';

/** Script tag the cUsers views inject into `request.ajax`; context and admin directory are trusted config, kept raw. */
export function renderUsersJs(_ctx: ScreenContext): SafeHtml {
  const src = adminAssetUrl('js/searchParams.js', { coreversion: true });
  return raw(`<script src="${src}" type="text/javascript" ></script>`);
}
