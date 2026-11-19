// Helpers the collection (cFeed) screens share: feed API endpoint, `utility.displayErrors`, CFML flags (server-only).
import { cfToBoolean } from '@opt2/platform/legacy-compat';
import type { GatewayClient } from '@/lib/gateway-client';
import { join, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { legacySitePath, legacySitePaths } from '@/lib/site-paths';

/** A flag as the contracts type it: an integer, a string or a boolean; SQL NULL as `null` or absent. */
export type CfFlag = number | string | boolean | null | undefined;

/** CFML truthiness of a flag: `''`, `null` and `undefined` are false, else CFML boolean conversion (throws as CFML). */
export function cfTruthy(value: CfFlag): boolean {
  return value === '' || value === null || value === undefined ? false : cfToBoolean(value);
}

/** CFML `yesNoFormat`. */
export function yesNoFormat(value: CfFlag): 'Yes' | 'No' {
  return cfTruthy(value) ? 'Yes' : 'No';
}

/** `utility.displayErrors`: every message but `siteID`'s, unencoded and in map order, as ACF emits them. */
export function displayErrors(errors: Readonly<Record<string, string>>): SafeHtml {
  const entries = Object.entries(errors);
  return join(
    entries.flatMap(([key, message], index) =>
      // The `<br>` test counts every key, `siteID` included, so a trailing `siteID` leaves a `<br>` after the last
      // message. The single spaces are the tag-body whitespace ACF whitespace management emits.
      key.toLowerCase() === 'siteid' ? [] : [raw(`${message} ${entries.length > index + 1 ? '<br> ' : ''}`)],
    ),
  );
}

/**
 * `rc.$.siteConfig().getApi('feed','v1').getEndpoint()` as legacy's live site bean holds it; a first touch, so read
 * only where a view evaluates it.
 * @throws GatewayDenialError When the gateway refuses web's call (401 or 403).
 * @throws Error When neither `rc.siteid` nor the session names a site, as `siteConfig()` throws.
 */
export async function legacyFeedEndpoint(req: AdminRequest, gateway: Pick<GatewayClient, 'legacySite'>): Promise<string> {
  const rcSiteId = req.rc.siteid ?? '';
  const siteid = rcSiteId !== '' ? rcSiteId : req.session.siteid;
  if (siteid === '') throw new Error('The SiteID is not set in the current Mura Scope event.');
  return legacySitePath(await legacySitePaths(req, gateway, { feedSite: siteid }), 'feedEndpoint');
}
