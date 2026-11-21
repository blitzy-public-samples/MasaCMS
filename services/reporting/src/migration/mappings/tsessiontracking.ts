// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { TSESSIONTRACKING } from '../../repo/tables.js';

/** Masa `tsessiontracking` ↔ `reporting.session_tracking`, keyed by the legacy `trackingID`; tenant from `siteID`, the umbrella tenant when it names no site. */
export const sessionTrackingMapping: Mapping = defineMapping({
  legacyTable: 'tsessiontracking',
  targetTable: TSESSIONTRACKING.unit,
  unit: TSESSIONTRACKING.unit,
  columns: [
    { legacy: 'trackingID', target: 'trackingid', type: 'i' },
    { legacy: 'contentID', target: 'contentid', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'userid', target: 'userid', type: 's' },
    { legacy: 'remote_addr', target: 'remote_addr', type: 's' },
    { legacy: 'server_name', target: 'server_name', type: 's' },
    { legacy: 'query_string', target: 'query_string', type: 's' },
    { legacy: 'referer', target: 'referer', type: 's' },
    { legacy: 'user_agent', target: 'user_agent', type: 's' },
    { legacy: 'script_name', target: 'script_name', type: 's' },
    { legacy: 'urlToken', target: 'urltoken', type: 's' },
    { legacy: 'entered', target: 'entered', type: 't' },
    { legacy: 'country', target: 'country', type: 's' },
    { legacy: 'lang', target: 'lang', type: 's' },
    { legacy: 'locale', target: 'locale', type: 's' },
    { legacy: 'keywords', target: 'keywords', type: 's' },
    { legacy: 'originalUrlToken', target: 'originalurltoken', type: 's' },
    { legacy: 'fname', target: 'fname', type: 's' },
    { legacy: 'lname', target: 'lname', type: 's' },
    { legacy: 'company', target: 'company', type: 's' },
  ],
  key: TSESSIONTRACKING.key,
  tenant: { kind: 'site', column: 'siteID' },
});
