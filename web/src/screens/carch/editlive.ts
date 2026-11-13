// The `cArch.editLive` action: finds a node by title or id and redirects to its compact edit screen (server-only).
import { cfUuid } from '@opt2/platform/legacy-compat';
import { encodeUrl } from '@/lib/html';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { carchPageData, type CarchPageModel } from './service';

const SERVICE = 'strategies-content';

/** A struct member by case-insensitive name, as CFML reads it; undefined when absent. */
function memberOf(struct: Readonly<Record<string, unknown>>, name: string): unknown {
  if (Object.hasOwn(struct, name)) return struct[name];
  const lower = name.toLowerCase();
  const key = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : struct[key];
}

/** `rc.contentBean.getEditURL(compactDisplay='true')` as strategies-content built it; throws when it is missing. */
function editUrlOf(model: CarchPageModel): string {
  const bean = memberOf(model.rc, 'contentBean');
  const url =
    typeof bean === 'object' && bean !== null ? memberOf(bean as Record<string, unknown>, 'editUrl') : undefined;
  if (typeof url !== 'string' || url === '') {
    throw new TypeError(`${SERVICE} getContentEditModel returned no rc.contentBean.editUrl for carch.editlive`);
  }
  return url;
}

/** carch `editLive()`: the node by `rc.title`, else `rc.contentid`, typed as `rc.type`, in the compact editor. */
async function submitEditLive(ctx: ScreenContext): Promise<SubmitResult> {
  ctx.req = applyCarchDefaults(ctx.req);
  const { rc } = ctx.req;
  // editLive's own `param` defaults, read after before() has already set `type` to Page on a non-ajax request.
  const type = rc.type ?? '';
  const title = rc.title ?? '';
  const outcome = await carchPageData(ctx, 'editlive', {
    siteid: rc.siteid ?? '',
    // A node the request does not name (a title lookup sends no contentid) loads as a new bean, whose id
    // getContentID() mints with createUUID(); the path segment needs a value, so a fresh CF UUID stands in.
    contentid: rc.contentid || cfUuid(),
    type,
    compactDisplay: 'true',
    ...(title === '' ? {} : { title }),
  });
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`${SERVICE} rejected the carch.editlive read with HTTP ${outcome.status}`);
  }
  return { kind: 'location', location: `${editUrlOf(outcome.data)}&instanceid=${encodeUrl(rc.instanceid ?? '')}` };
}

/** The `cArch.editLive` admin action, answered with legacy's `cflocation`. */
export const editliveScreen: RedirectScreen = Object.freeze({
  circuit: 'carch',
  action: 'editlive',
  owner: CARCH_OWNER,
  mode: 'redirect',
  gate: carchGate,
  submit: submitEditLive,
});
