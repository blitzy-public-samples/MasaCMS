// The collections (cFeed) controller `before()`: its access gate and its `rc` param defaults (server-only).
import type { ScreenGate } from '@/lib/access-gate';
import { administersRequestedSite, restoreFlashContext, servesRequestedSite } from '@/lib/request-context';
import { MODULE_IDS } from '@/shell/nav';
import type { Rc } from '../registry';

/** cfeed `before()` gate: `secure()` unless the site has the feed manager and the user may manage collections. */
export const cfeedGate: ScreenGate = (req, { secure }) => {
  const hasFeedManager = req.site?.hasFeedManager === true;
  // `||` binds loosest, as in legacy: a site without the feed manager secures everyone, S2 included.
  const denied =
    !hasFeedManager ||
    (!administersRequestedSite(req) &&
      !(servesRequestedSite(req) && req.modulePerm(MODULE_IDS.collections) && req.modulePerm(MODULE_IDS.content)));
  return denied ? secure() : { kind: 'allow' };
};

/** The `param` defaults of cfeed `before()`, in legacy order, as the string values an `rc` holds. */
export const CFEED_RC_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  startrow: '1',
  keywords: '',
  categoryID: '',
  contentID: '',
  restricted: '0',
  closeCompactDisplay: '',
  compactDisplay: '',
  homeID: '',
  action: '',
  assignmentID: '',
  regionID: '0',
  orderno: '0',
  instanceParams: '',
  instanceid: '',
});

const DEFAULTS_KEY = 'cfeed';

// restoreFlashContext adds a context's values only where `rc` lacks the key, matched case-insensitively, which is
// exactly CFML `param` over a struct; reusing it keeps the result a regular read-only rc view.
/** A copy of `rc` with each {@link CFEED_RC_DEFAULTS} entry added where its key, in any case, is absent. */
export function applyCfeedDefaults(rc: Rc): Rc {
  return restoreFlashContext(rc, { fw1pk: DEFAULTS_KEY }, { [DEFAULTS_KEY]: CFEED_RC_DEFAULTS });
}
