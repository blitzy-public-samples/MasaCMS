// The `cArch.lockCheck` page: the node's lock holder goes on to `destAction`, anyone else gets the draft prompt.
import { cfEq } from '@opt2/platform/legacy-compat';
import { encodeJs, raw, type SafeHtml } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { carchJs } from './partials/js';
import { carchPageData, type CarchPageModel } from './service';

const SERVICE = 'strategies-content';

/** A struct member by case-insensitive name, as CFML reads it; undefined when absent. */
function memberOf(struct: Readonly<Record<string, unknown>>, name: string): unknown {
  if (Object.hasOwn(struct, name)) return struct[name];
  const lower = name.toLowerCase();
  const key = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : struct[key];
}

/** `stats.getLockID()` from the model's `rc.stats` (the stats bean's values); a NULL column reads ''. */
function lockIdOf(model: CarchPageModel): string {
  const stats = memberOf(model.rc, 'stats');
  if (typeof stats !== 'object' || stats === null) {
    throw new TypeError(`${SERVICE} getContentVersionModel returned no rc.stats for carch.lockcheck`);
  }
  const lockId = memberOf(stats as Record<string, unknown>, 'lockid');
  if (lockId === undefined || lockId === null) return '';
  if (typeof lockId !== 'string') throw new TypeError(`${SERVICE} returned a non-string rc.stats.lockid`);
  return lockId;
}

/** `$.event(name)`: the rc value, '' when absent. */
const eventValue = (req: AdminRequest, name: string): string => req.rc[name] ?? '';

// Without the gateway's request-target header the URL scope stands in, as the nav reads it.
/** `cgi.query_string`: the forwarded request target's query, byte for byte. */
function cgiQueryString(req: AdminRequest): string {
  const target = req.headers.get(ORIGINAL_URL_HEADER);
  if (target === null) return req.currentUrl.replace(/^\.\/\??&?/, '');
  const queryAt = target.indexOf('?');
  return queryAt < 0 ? '' : target.slice(queryAt + 1);
}

/**
 * carch before(), then lockcheck.cfm's `cflocation` when the node is locked by the session user; a denied read answers
 * with the controller `secure()` redirect. Leaves the defaulted request on `ctx` for the view.
 * @throws Error When strategies-content rejects the read with another 4xx.
 */
async function lockHolderRedirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  ctx.req = applyCarchDefaults(ctx.req);
  const outcome = await carchPageData(ctx, 'lockcheck');
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`${SERVICE} rejected the carch.lockcheck read with HTTP ${outcome.status}`);
  }
  if (!cfEq(lockIdOf(outcome.data), ctx.req.session.mura.userID)) return undefined;
  // CFML replace() swaps the first case-sensitive occurrence; a replacer function keeps `$` in destAction literal.
  const query = cgiQueryString(ctx.req).replace('carch.lockcheck', () => eventValue(ctx.req, 'destAction'));
  return { kind: 'location', location: `./?${query}` };
}

// strategies-content serves this action only as the content-version model, not as rendered markup, so the view is
// rendered here from rc and the request target, as legacy prints them.
/** lockcheck.cfm's draft prompt: the configurator container and the script that loads `carch.draftpromptdata`. */
function draftPromptBody({ req, rb }: Pick<ScreenContext, 'req' | 'rb'>): SafeHtml {
  const js = (name: string): string => encodeJs(eventValue(req, name));
  const dest = js('destAction');
  return raw(`
<div id="configuratorContainer">
\t<h1 id="configuratorHeader">${rb.rbKey('sitemanager.draftprompt.title')}</h1>
\t<div id="configurator">
\t<div class="load-inline"></div>
\t</div>
</div>
<script type="text/javascript">
$(function(){

\tif (top.location != self.location) {
\t\tif(jQuery("#ProxyIFrame").length){
\t\t\tjQuery("#ProxyIFrame").load(
\t\t\t\tfunction(){
\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'configurator'});
\t\t\t\t}
\t\t\t);\t
\t\t} else {
\t\t\tfrontEndProxy.post({cmd:'setWidth',width:'configurator'});
\t\t}
\t}

\t$('#configuratorContainer .load-inline').spin(spinnerArgs2);

\tvar href = './?${encodeJs(cgiQueryString(req))}';
\tvar locknode=false;

\t$.ajax({
\t\t  url: "./index.cfm?muraAction=carch.draftpromptdata&contentid=${js('contentid')}&siteid=${js('siteid')}&targetversion=true&contenthistid=${js('contenthistid')}&homeid=${js('homeid')}",
\t\t  context: this,
\t\t  success: function(resp){

\t\t\t  if (resp.showdialog !== undefined && resp.showdialog === "true"){
\t\t\t\t
\t\t\t\t$('#configurator').html(resp.message);

\t\t\t\t$(".draft-prompt-option").click(function(e){
\t\t\t\t\te.preventDefault();
\t\t\t\t\thref = href.replace('carch.lockcheck','${dest}&locknode=' + locknode );
\t\t\t\t\tactionModal(href);
\t\t\t\t});

\t\t\t\t$("#locknodetoggle").on("change",function(){
\t\t\t\t\tlocknode=$(this).is(":checked");
\t\t\t\t});

\t\t\t} else {
\t\t\t\thref = href.replace('carch.lockcheck','${dest}&locknode=' + locknode );
\t\t\t\tactionModal(href);
\t\t\t}
\t\t}
\t});
});
</script>
`);
}

/** `cArch.lockCheck`: the lock holder's redirect, else the draft prompt with the `js.cfm` architecture script. */
export const lockcheckScreen: PageScreen<undefined> = Object.freeze({
  circuit: 'carch',
  action: 'lockcheck',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  redirect: lockHolderRedirect,
  render: (ctx: ScreenContext): ShellView => ({ body: draftPromptBody(ctx), ajax: carchJs(ctx, ctx.req.item) }),
});
