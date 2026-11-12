// The document carch.update and carch.variationtargeting answer after a compact-display save (server-only).
import { cfEq } from '@opt2/platform/legacy-compat';
import { encodeJs } from '@/lib/html';
import { setSessionMuraValue } from '@/lib/request-context';
import { adminAssetUrl } from '@/lib/urls';
import type { ScreenContext } from '../../registry';
import { structText } from '../model';

/** A content bean the close document links to; strategies-content computes its URLs. */
export interface CloseCompactContent {
  readonly active: boolean;
  readonly isOnDisplay: boolean;
  readonly type: string;
  readonly contentId: string;
  readonly contentHistId: string;
  /** `getURL()`. */
  readonly url: string;
  /** `getURL(queryString="previewid=<contentHistId>")`. */
  readonly previewUrl: string;
}

/** `rc.contentBean` as the save left it. */
export interface CloseCompactEdited {
  readonly type: string;
  readonly contentId: string;
  readonly remoteUrl: string;
  readonly active: boolean;
}

/** The add branch's bean: the active version when the saved bean is active, else the saved bean. */
export interface CloseCompactCurrent extends CloseCompactContent {
  /** `getURL(queryString='previewID=<saved bean contentHistId>')`. */
  readonly previewUrlForEdited: string;
}

/** The active parent (File/Link add) or the active `rc.parentID` content (multiFileUpload). */
export interface CloseCompactParent extends CloseCompactContent {
  /** `getURL(queryString="previewid=<rc.parenthistid>")`. */
  readonly previewUrlForParentHistId: string;
  /** `loadBy(contenthistid=rc.parenthistid).exists()`. */
  readonly parentHistIdExists: boolean;
}

/** What dsp_close_compact_display.cfm reads, mapped by the caller from strategies-content data. */
export interface CloseCompactDisplayModel {
  /** `rc.action`. */
  readonly action: string;
  /** `rc.homeID`. */
  readonly homeId: string;
  /** Active home content `getURL()`; read when `homeId` is non-empty. */
  readonly homeUrl: string;
  /** `rc.preview`. */
  readonly preview: string;
  /** `rc.parenthistid`; defaults to `''`. */
  readonly parentHistId?: string;
  readonly edited: CloseCompactEdited;
  /** Set for action `add`. */
  readonly current?: CloseCompactCurrent;
  /** Set for a File or Link add and for multiFileUpload. */
  readonly parent?: CloseCompactParent;
  /** Active content of `rc.parentid`, set for every other save. */
  readonly fallback?: CloseCompactContent;
  /** Content renderer `useLayoutmanager()`. */
  readonly useLayoutManager: boolean;
}

/** Where the document sends the front end, and the bean `rc.contentBean` names when the script runs. */
interface CloseTarget {
  readonly href: string;
  readonly type: string;
  readonly contentId: string;
}

const COREVERSION = Object.freeze({ coreversion: true });

/** Joins `parts` with LF, the template's line ending. */
const lines = (...parts: readonly string[]): string => parts.join('\n');

/** `bean`, which the branch's legacy lookup always yields; throws when the caller left it out. */
function branchBean<T>(bean: T | undefined, field: 'current' | 'parent' | 'fallback'): T {
  if (bean === undefined) throw new TypeError(`closeCompactDisplay: model.${field} is required for this save`);
  return bean;
}

/** The live URL of a bean that is active and on display, else its preview URL. */
const liveOrPreview = (bean: CloseCompactContent): string =>
  bean.active && bean.isOnDisplay ? bean.url : bean.previewUrl;

/** The parent's URL, previewing `rc.parenthistid` when it names another existing version. */
function parentHref(parent: CloseCompactParent, parentHistId: string): string {
  return parentHistId.length > 0 && !cfEq(parent.contentHistId, parentHistId) && parent.parentHistIdExists
    ? parent.previewUrlForParentHistId
    : liveOrPreview(parent);
}

/** The view's href decision tree. */
function closeTarget(model: CloseCompactDisplayModel): CloseTarget {
  const { edited } = model;
  const saved = (href: string): CloseTarget => ({ href, type: edited.type, contentId: edited.contentId });
  const isAdd = cfEq(model.action, 'add');
  const isFileOrLink = cfEq(edited.type, 'File') || cfEq(edited.type, 'Link');

  if (cfEq(edited.type, 'Variation')) return saved(edited.remoteUrl);
  if (model.homeId.length > 0) return saved(model.homeUrl);
  if (isAdd && !isFileOrLink) {
    const current = branchBean(model.current, 'current');
    return saved(cfEq(model.preview, '1') ? current.previewUrlForEdited : liveOrPreview(current));
  }
  if ((isAdd && isFileOrLink) || cfEq(model.action, 'multiFileUpload')) {
    return saved(parentHref(branchBean(model.parent, 'parent'), model.parentHistId ?? ''));
  }
  // Legacy reassigns rc.contentBean to this bean, so the script reads its type and id.
  const fallback = branchBean(model.fallback, 'fallback');
  return { href: liveOrPreview(fallback), type: fallback.type, contentId: fallback.contentId };
}

/** The `var cmd` text of the inline script, with the whitespace ACF emits around it. */
function commandText(target: CloseTarget, instanceId: string, useLayoutManager: boolean): string {
  const setLocation = `var cmd={cmd:'setLocation',location:encodeURIComponent("${encodeJs(target.href)}")};`;
  if (!(useLayoutManager && instanceId.length > 0)) return `\n\t\t${setLocation}\n\t`;
  // The instance and content ids are written unencoded, as legacy writes them.
  let command: string;
  if (cfEq(target.type, 'Form') || cfEq(target.type, 'Component')) {
    command = `var cmd={cmd:'setObjectParams',reinit:true,instanceid:'${instanceId}',params:{objectid:'${target.contentId}'}};`;
  } else if (instanceId.length > 0) {
    command = `var cmd={cmd:'setObjectParams',reinit:true,instanceid:'${instanceId}',params:{}};`;
  } else {
    command = setLocation;
  }
  return `\n\t\t\t${command}\n\t\t`;
}

/** The full close document of a compact-display save; clears `session.mura.objectInstanceId` in `sessionWrites`. */
export function closeCompactDisplay(ctx: Pick<ScreenContext, 'req'>, model: CloseCompactDisplayModel): string {
  const { req } = ctx;
  const target = closeTarget(model);
  const instanceId = structText(req.session.mura, 'objectInstanceId');
  const command = commandText(target, instanceId, model.useLayoutManager);
  setSessionMuraValue(req, 'objectInstanceId', '');

  const href = encodeJs(target.href);
  const proxy = `${encodeJs(req.session.frontEndProxyLoc)}${adminAssetUrl('js/porthole/proxy.html')}`;
  // The bytes the ACF oracle serves: the leading newline follows the template's license comment (both including views
  // print nothing before it), and whitespace-only text between CFML tags is dropped.
  const head = lines(
    '',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '<head>',
    '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" />',
    '',
    `<script src="${adminAssetUrl('js/jquery/jquery.js', COREVERSION)}" type="text/javascript"></script>`,
    `<script src="${adminAssetUrl('js/porthole/porthole.min.js', COREVERSION)}" type="text/javascript"></script>`,
    '<script>',
    '\t',
  );
  const tail = lines(
    '',
    '\tfunction reload(){',
    '\t\tif (top.location != self.location) {',
    `\t\t\tfrontEndProxy = new Porthole.WindowProxy("${proxy}");`,
    '\t\t\tif (jQuery("#ProxyIFrame").length) {',
    '\t\t\t\tjQuery("#ProxyIFrame").load(function(){',
    "\t\t\t\t\tfrontEndProxy.post({cmd:'scrollToTop'});",
    '\t\t\t\t\tfrontEndProxy.post(cmd);',
    '\t\t\t\t});',
    '\t\t\t}',
    '\t\t\telse {',
    "\t\t\t\tfrontEndProxy.post({cmd:'scrollToTop'});",
    '\t\t\t\tfrontEndProxy.post(cmd);',
    '\t\t\t}',
    '',
    '\t\t} else {',
    `\t\t\tlocation.href="${href}";`,
    '\t\t}',
    '\t}',
    '</script>',
    '',
    '</head>',
    '<body onload="reload()">',
    '</body>',
    '</html>',
    '',
  );
  return head + command + tail;
}
