// Masa's default scriptProtect scan of the url scope, as the shared platform port runs it (core/appcfc/scriptProtect_include.cfm:5-11).
import { portcullisScan } from '@opt2/platform/legacy-compat';

/** Raised where the scan itself fails, which legacy answers with the ColdFusion error page. */
export class UrlScanError extends Error {
  override readonly name: string = 'UrlScanError';
}

/** The url scope after `portcullisScan`, names lower-cased; throws {@link UrlScanError} where legacy's scan fails. */
export function scanUrlScope(url: ReadonlyMap<string, string>): Map<string, string> {
  const scope = portcullisScan(url);
  if (scope.failed) throw new UrlScanError('The scriptProtect scan of the url scope failed.');
  return new Map(scope.entries.map(([name, value]) => [name.toLowerCase(), String(value)]));
}
