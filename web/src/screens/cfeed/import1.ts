// `cFeed.import1`: the remote-feed import selection of `admin/core/views/cfeed/import1.cfm` over strategies-content (server-only).
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { ShellView } from '@/shell/document';
import type { PageScreen, ScreenContext } from '../registry';
import { cfeedGate } from './before';
import { cfeedAjaxScripts } from './js';
import { renderCfeedSecondaryMenu } from './secondary-menu';

const SERVICE = 'strategies-content';
const OPERATION = 'previewFeedImport';

/** A struct of the screen model; keys match case-insensitively, as in CFML. */
type Struct = Readonly<Record<string, unknown>>;

/** One feed item the import would bring in, as strategies-content selected it. */
export interface CfeedImportItem {
  /** Hashed guid, or link without one, that imported content stores as `remoteID`. */
  readonly remoteId: string;
  readonly link: string;
  readonly title: string;
  /** Item description markup, emitted unencoded. */
  readonly description: string;
  /** No active content carries the remote id yet (`rc.newBean.getIsNew()`). */
  readonly isNew: boolean;
}

/** The feed's name and version, and the first `maxItems` feed items that are new or changed since their import. */
export interface CfeedImport1Data {
  readonly feedName: string;
  /** `feedBean.getVersion()`, which picks the view's `cfswitch` branch. */
  readonly version: string;
  readonly items: readonly CfeedImportItem[];
}

/** Branch of the view's `cfswitch` on the feed version; undefined for a version no `cfcase` names. */
type ImportFormat = 'rss' | 'atom' | undefined;

/** A label of `session.rb`, unencoded as legacy writes it. */
type Label = (key: string) => SafeHtml;

/** The legacy inline style block, verbatim, since the screen reproduces legacy markup unchanged. */
const IMPORT_STYLE = raw(`<style type="text/css">
\t.mura-import-item img{
\t\tmax-width: 200px !important;
\t\tmargin-top: .5em !important;
\t}
\t.mura-import-item br:first-child,
\t.mura-import-item br:first-child + br{
\t\tdisplay: none;
\t}
</style>`);

/** A struct value by case-insensitive key; undefined when absent. */
function structValue(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** `value` as a struct; anything else throws, naming `what`. */
function structOf(value: unknown, what: string): Struct {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${OPERATION} returned ${what} that is not a struct`);
  }
  return value as Struct;
}

/** A simple struct value as CFML text; absent and SQL NULL read as `''`, complex values throw. */
function structText(struct: Struct, key: string): string {
  const value = structValue(struct, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${OPERATION} returned a ${key} that is not a simple value`);
}

/** The import item of one `rc.items` entry. */
function itemOf(entry: unknown): CfeedImportItem {
  const item = structOf(entry, 'an rc.items entry');
  const isNew = structValue(item, 'isNew');
  if (typeof isNew !== 'boolean') throw new TypeError(`${OPERATION} returned an rc.items entry whose isNew is not a boolean`);
  return {
    remoteId: structText(item, 'remoteID'),
    link: structText(item, 'link'),
    title: structText(item, 'title'),
    description: structText(item, 'description'),
    isNew,
  };
}

/** `rc[name]`; a missing value throws as CFML does on an undefined `rc` element. */
function rcParam(ctx: ScreenContext, name: string): string {
  const value = ctx.req.rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC`);
  return value;
}

// The contract leaves the screen model's `rc` open, so these keys are the ones the service's import preview emits.
/**
 * Reads `rc.feedBean` (`name`, `version`) and `rc.items` (`remoteID`, `link`, `title`, `description`, boolean `isNew`;
 * always an array) of the import preview for `rc.feedid` in `rc.siteid`.
 * @throws GatewayDenialError When strategies-content answers 401 or 403.
 * @throws Error For any other non-2xx answer, the remote fetch and parse failures included, as legacy's
 * `cfhttp throwOnError` and `parseXML` fail the page.
 */
export async function loadCfeedImport1(ctx: ScreenContext): Promise<CfeedImport1Data> {
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/feeds/{feedid}/import', {
    params: { siteid: rcParam(ctx, 'siteid'), feedid: rcParam(ctx, 'feedid') },
  });
  const { rc } = okBody(response, SERVICE, OPERATION);
  const feed = structOf(structValue(rc, 'feedBean'), 'an rc.feedBean');
  const items = structValue(rc, 'items');
  if (!Array.isArray(items)) throw new TypeError(`${OPERATION} returned no rc.items array`);
  return { feedName: structText(feed, 'name'), version: structText(feed, 'version'), items: items.map(itemOf) };
}

/** The `cfswitch` branch `version` selects, compared case-insensitively as `cfcase` compares. */
function importFormat(version: string): ImportFormat {
  const value = version.toLowerCase();
  if (value === 'rss 0.920' || value === 'rss 2.0') return 'rss';
  return value === 'atom' ? 'atom' : undefined;
}

/** The label lookup over `rb`. */
function labelsOf(rb: RbLookup): Label {
  return (key) => raw(rb.rbKey(key));
}

/** One selectable item; the title and link are encoded, the description is written raw as legacy writes it. */
function itemRow(item: CfeedImportItem, label: Label): SafeHtml {
  const marker = item.isNew ? '' : html` [${label('collections.update')}]`;
  return html`
\t\t\t\t\t\t\t\t\t<div class="mura-layout-row mura-import-item clearfix">
\t\t\t\t\t\t\t\t\t\t<div class="mura-12">
\t\t\t\t\t\t\t\t\t\t\t<label><input name="remoteID" value="${raw(encodeHtmlAttr(item.remoteId))}" type="checkbox" checked>&nbsp;&nbsp;${label('collections.import')}&nbsp;&nbsp;</label>
\t\t\t\t\t\t\t\t\t\t\t<label><strong><a href="${raw(encodeHtmlAttr(item.link))}" target="_blank">${raw(encodeHtml(item.title))}${marker}</a></strong></label>
\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t<div class="mura-12">${raw(item.description)}</div>
\t\t\t\t\t\t\t\t\t</div>

\t\t\t\t\t\t\t\t`;
}

/** The import button and hidden action legacy writes unless the format is unsupported. */
function importActions(label: Label): SafeHtml {
  return html`
\t\t\t\t\t\t<div class="mura-actions">
\t\t\t\t\t\t\t<div class="form-actions">
\t\t\t\t\t\t\t<button class="btn mura-primary" onclick="feedManager.confirmImport();"><i class="mi-sign-in"></i>${label('collections.import')}</button>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t</div>
\t\t\t\t\t\t<input type="hidden" name="action" value="import" />
\t\t\t\t\t\t`;
}

/** The selection form branch for `format`: item rows, the unsupported notice, or nothing for another version. */
function formatBranch(format: ImportFormat, items: readonly CfeedImportItem[], label: Label): SafeHtml {
  if (format === 'rss') return html`${items.map((item) => itemRow(item, label))}`;
  return format === 'atom' ? html`<p>${label('collections.formatnotsupport')}</p> ` : html``;
}

// Whitespace follows bytes captured from ACF 2023: tag-only CFML lines emit nothing and hidden items emit no bytes.
/** The import selection view: style block, header with the default-case menu, then the selection form. */
export function renderCfeedImport1(ctx: ScreenContext, data: CfeedImport1Data): ShellView {
  const { req, rb } = ctx;
  const label = labelsOf(rb);
  const format = importFormat(data.version);
  const formAction = raw(
    `./?muraAction=cFeed.import2&feedid=${encodeUrl(req.rc.feedid ?? '')}&siteid=${encodeUrl(req.rc.siteid ?? '')}`,
  );
  const body = html`

${IMPORT_STYLE}



<div class="mura-header">
\t<h1>${label('collections.remotefeedimportselection')}</h1>
\t
\t${renderCfeedSecondaryMenu(req, rb, { fuseaction: 'import1' })}

\t</div> <!-- /.mura-header -->

\t<div class="block block-constrain">
\t\t\t<div class="block block-bordered">
\t\t\t\t<div class="block-content">

\t\t\t\t\t<form novalidate="novalidate" action="${formAction}" method="post" name="contentForm" onsubmit="return false;">
\t\t\t\t\t\t
\t\t\t\t\t\t<h2>${raw(data.feedName)}</h2>
\t\t\t\t\t\t\t${formatBranch(format, data.items, label)}${format === 'atom' ? '' : importActions(label)}
\t\t\t\t\t</form>

\t\t\t\t<div class="clearfix"></div>
\t\t\t</div> <!-- /.block-content -->
\t\t</div> <!-- /.block-bordered -->
\t</div> <!-- /.block-constrain --> `;
  return { body, ajax: cfeedAjaxScripts() };
}

/** `cFeed.import1`: view-only page (no controller method) behind the cfeed `before()` gate. */
export const cfeedImport1Screen: PageScreen<CfeedImport1Data> = Object.freeze({
  circuit: 'cfeed',
  action: 'import1',
  owner: 'strategies-content',
  mode: 'page',
  gate: cfeedGate,
  load: loadCfeedImport1,
  render: renderCfeedImport1,
});
