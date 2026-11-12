// Port of carch/dsp_configuratorJS.cfm as the edit form's Layout & Objects panel includes it (server-only).
import { encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { ScreenContext } from '../../registry';

/** One entry of the site's non-plugin display-object lookup (`siteConfig().getDisplayObjectLookup()`). */
export interface ConfiguratorDisplayObject {
  objectid: string;
  configuratorInit: string;
  configuratorJS: string;
}

/** Request, site and global values the configurator script reads. */
export interface ConfiguratorJsInput {
  /** `rc.contentid`. */
  contentId: string;
  /** `rc.parentid`. */
  parentId: string;
  /** `rc.contenthistid`, emitted only when no content bean is loaded. */
  contentHistId: string;
  /** `rc.contentBean.getContentHistID()`; present exactly when `rc.contentBean` is defined. */
  contentBeanHistId?: string;
  /** Site setting `customTagGroups`, a comma list. */
  customTagGroups: string;
  /** Global setting `allowopenfeeds` as configured; `false` when unset. */
  allowOpenFeeds?: string | boolean;
  /** The lookup in legacy struct iteration order; plugin display objects are never included. */
  displayObjects: readonly ConfiguratorDisplayObject[];
  /** Content renderer `useLayoutManager()`. */
  useLayoutManager: boolean;
  /** `siteConfig().getAssetPath()`. */
  siteAssetPath: string;
}

/** Title variables in template order: name, `sitemanager.configurator.` key suffix, trailing text after `;`. */
const TITLE_VARIABLES: readonly (readonly [name: string, key: string, trailing: string])[] = [
  ['remoteFeedConfiguratorTitle', 'remotefeedtitle', ''],
  ['localIndexConfiguratorTitle', 'localindextitle', ''],
  ['tagCloudConfiguratorTitle', 'tagcloudtitle', ''],
  ['categorySummaryConfiguratorTitle', 'categorysummarytitle', '\t'],
  ['slideShowConfiguratorTitle', 'slideshowtitle', '\t'],
  ['relatedContentConfiguratorTitle', 'relatedcontenttitle', '\t'],
  ['siteMapConfiguratorTitle', 'sitemaptitle', '\t\t'],
  ['genericConfiguratorTitle', 'generictitle', '\t'],
  ['genericConfiguratorMessage', 'genericmessage', ''],
];

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};
// ACF 2023 serializeJSON (observed on the legacy server) leaves '/' and non-ASCII raw and writes the other C0
// characters and DEL as lowercase \u00xx; numeric- and boolean-looking items stay quoted strings.
const JSON_SPECIALS = /["\\\u0000-\u001F\u007F]/g;

/** ACF `serializeJSON(listToArray(list))`: comma items, empty ones dropped, as a JSON array of strings. */
function serializeListJson(list: string): string {
  const items = list
    .split(',')
    .filter((item) => item !== '')
    .map((item) => {
      const escaped = item.replace(
        JSON_SPECIALS,
        (c) => JSON_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      return `"${escaped}"`;
    });
  return `[${items.join(',')}]`;
}

/** The configurator globals `<script>`, then one configurator script tag per display object with a configurator. */
export function configuratorJs(ctx: Pick<ScreenContext, 'rb'>, input: ConfiguratorJsInput): SafeHtml {
  // Legacy tests configuratorInit for both loops, so an object with an init but no JS file still gets a script tag.
  const configurators = input.displayObjects.filter((object) => object.configuratorInit.length > 0);
  const titles = TITLE_VARIABLES.map(
    ([name, key, trailing]) =>
      `var ${name}='${encodeJs(ctx.rb.rbKey(`sitemanager.configurator.${key}`))}';${trailing}\n`,
  ).join('');
  // The content bean's history id is emitted unencoded, as legacy emits it.
  const contentHistId = input.contentBeanHistId !== undefined ? input.contentBeanHistId : encodeJs(input.contentHistId);
  const layoutManager =
    input.contentBeanHistId !== undefined && input.useLayoutManager ? '\n\tsiteManager.layoutmanager=true;\n' : '';
  // Display-object values and the asset path are emitted unencoded, as legacy emits them.
  const pushes = configurators
    .map((o) => `\n\tpluginConfigurators.push({'objectid':'${o.objectid}','init':'${o.configuratorInit}'});\n`)
    .join('');
  const scripts = configurators
    .map((o) => `\n<script type="text/javascript" src="${input.siteAssetPath}/${o.configuratorJS}"></script>\n`)
    .join('');
  // Line breaks follow ACF whitespace management, which drops whitespace-only text between two CFML tags
  // (the cfset, cfloop and cfif lines) and keeps every text run that holds output.
  return raw(
    '\n<script>\n' +
      `siteManager.customtaggroups=${serializeListJson(input.customTagGroups)};\n\n` +
      titles +
      `var contentid='${encodeJs(input.contentId)}';\n` +
      `var parentid='${encodeJs(input.parentId)}';\n` +
      `\nvar contenthistid='${contentHistId}';\n` +
      `\n\nsiteManager.allowopenfeeds=${String(input.allowOpenFeeds ?? false)};\n` +
      '\nvar pluginConfigurators=new Array();\n' +
      pushes +
      layoutManager +
      '\n</script>\n' +
      scripts,
  );
}
