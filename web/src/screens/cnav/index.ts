// The reproduced `cnav` circuit for the screen registry (server-only).
import type { JsonScreen, RawBody, ScreenContext, ScreenDefinition } from '../registry';
import { loadSearchSiteData } from './searchsitedata';

// No gate: the controller has no before(), so only the application gate applies and anonymous requests reach the load.
const searchSiteDataScreen: JsonScreen<RawBody> = Object.freeze({
  circuit: 'cnav',
  action: 'searchsitedata',
  owner: 'strategies-content',
  mode: 'json',
  load: loadSearchSiteData,
  json: (_ctx: ScreenContext, data: RawBody): RawBody => data,
});

/** The circuit's one action, the `cNav.searchSiteData` site-search JSON. */
export const cnavScreens: readonly ScreenDefinition[] = Object.freeze([searchSiteDataScreen]);
