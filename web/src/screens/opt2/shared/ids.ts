// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { isCfUuid } from '@opt2/platform/legacy-compat';
import type { SafeHtml } from '@/lib/html';
import { alertBox } from './markup';
import { INVALID_PARAMETERS } from './submit';

// A path id fills one encoded URL segment, which keeps dots, so `..` would climb the service path; every synthetic
// record id is a ColdFusion UUID, so any other non-empty id is refused before the call.
/** Whether `id`, a non-empty request id bound for a service path, is not a ColdFusion UUID. */
export function isMalformedId(id: string): boolean {
  return id !== '' && !isCfUuid(id);
}

/** The alert of the services' 400 `invalidParameters` answer, which a request naming a malformed id gets. */
export function invalidParametersAlert(): SafeHtml {
  return alertBox(INVALID_PARAMETERS);
}
