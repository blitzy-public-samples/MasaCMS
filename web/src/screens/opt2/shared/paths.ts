// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { encodeUrl } from '@/lib/html';
import { boundAdminUrl } from '@/lib/urls';
import type { Opt2Module } from '../../registry';

/** Query parameters in emitted order; `undefined` values are left out. */
export type Opt2Params = Readonly<Record<string, string | number | undefined>>;

/** `?name=value&…` with URL-encoded values, or `''` when no parameter has a value. */
function queryString(params: Opt2Params): string {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) pairs.push(`${name}=${encodeUrl(String(value))}`);
  }
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

/** Browser URL of a synthetic-module screen, `/opt2/admin/<module>/<screen>?…`, not HTML-encoded. */
export function opt2ScreenUrl(module: Opt2Module, screen: string, params: Opt2Params = {}): string {
  return `/opt2/admin/${module}/${screen}${queryString(params)}`;
}

/** Browser URL of a synthetic-module post action, `/opt2/admin-actions/<module>/<action>?…`, not HTML-encoded. */
export function opt2ActionUrl(module: Opt2Module, action: string, params: Opt2Params = {}): string {
  return `/opt2/admin-actions/${module}/${action}${queryString(params)}`;
}

/** Legacy `cMessage.noaccess` admin URL, `<context><adminDir>/?muraAction=cMessage.noaccess`. */
export function noAccessUrl(): string {
  return boundAdminUrl('cMessage', 'noaccess');
}
