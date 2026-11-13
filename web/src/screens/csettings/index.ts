// The csettings controller `before()` and the carried csettings screens for the screen registry (server-only).
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { tokenServesSite, type AdminRequest } from '@/lib/request-context';
import type { ScreenDefinition } from '../registry';
import { editSiteScreen } from './editsite';
import { listScreen } from './list';
import { loadCustomImageScreen } from './loadcustomimage';
import { loadCustomImagesScreen } from './loadcustomimages';

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

/** Action items, lower-cased, that `before()` opens to S2 alone (its `listFindNoCase` exclusions). */
const S2_ONLY_ITEMS: ReadonlySet<string> = new Set([
  'list',
  'editplugin',
  'deployplugin',
  'updateplugin',
  'updatepluginversion',
  'sitecopy',
  'sitecopyselect',
  'sitecopyresult',
]);

// identity mints site-admin for the token's site (the requested, else the session site), but legacy checks
// getSite(rc.siteid), `default` for Add Site's empty siteid; the role counts only for that site, so unknown ids fail.
/** Membership `Admin;<privateUserPoolID of getSite(rc.siteid)>;0`, read from the verified site-admin role. */
function isRequestedSiteAdmin(req: AdminRequest): boolean {
  const siteId = req.rc['siteid'] || 'default';
  return req.isSiteAdmin && req.user !== undefined && tokenServesSite(req.user, siteId);
}

/** csettings `before()`: S2, or the site's private-pool Admin outside the S2-only items; otherwise `secure()`. */
export const csettingsGate: ScreenGate = (req, { secure }) =>
  req.isS2 || (isRequestedSiteAdmin(req) && !S2_ONLY_ITEMS.has(req.item)) ? ALLOW : secure();

const listDefinition: ScreenDefinition = Object.freeze({
  ...listScreen,
  circuit: 'csettings',
  action: 'list',
  mode: 'page',
  owner: 'programs-sites',
  gate: csettingsGate,
});

const editSiteDefinition: ScreenDefinition = Object.freeze({
  ...editSiteScreen,
  circuit: 'csettings',
  action: 'editsite',
  mode: 'page',
  owner: 'programs-sites',
  gate: csettingsGate,
});

const loadCustomImageDefinition: ScreenDefinition = Object.freeze({
  ...loadCustomImageScreen,
  circuit: 'csettings',
  action: 'loadcustomimage',
  mode: 'fragment',
  owner: 'programs-sites',
  gate: csettingsGate,
});

const loadCustomImagesDefinition: ScreenDefinition = Object.freeze({
  ...loadCustomImagesScreen,
  circuit: 'csettings',
  action: 'loadcustomimages',
  mode: 'fragment',
  owner: 'programs-sites',
  gate: csettingsGate,
});

// updateSite stays on legacy: its Update branch writes the withheld trazunasettings table, and programs-sites serves
// none of its other branches. sitecopyresult has no target screen either; the gateway routes both to legacy.
/** The carried csettings actions: the Sites list, Edit Site and the two custom image size fragments. */
export const csettingsScreens: readonly ScreenDefinition[] = Object.freeze([
  listDefinition,
  editSiteDefinition,
  loadCustomImageDefinition,
  loadCustomImagesDefinition,
]);
