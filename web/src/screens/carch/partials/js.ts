// Site Manager `request.ajax` block of `carch/js.cfm`: the architecture script and, on edit, the summary editor loader.
import { legacySettings } from '@/lib/env';
import { raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { adminAssetUrl } from '@/lib/urls';
import type { ScreenContext } from '../../registry';

// The text below is the block as ACF emits it: whitespace-only text between CFML tags is dropped, all other text is
// kept byte for byte. The `onHTMLEditHeader` plugin branch is absent because plugin scripts run only on legacy.

const SUMMARY_UNLOADED = `
\t<script type="text/javascript">
\t  summaryLoaded=false;
\t</script>

`;

const SUMMARY_OPEN = `
\t<script type="text/javascript">

\t summaryLoaded=true;

\t editSummary = function(){
\t \t\t`;

const EDITOR_OPEN = `
\t \t\tif(!summaryLoaded){
\t \t\t`;

const CKEDITOR = `
\t\t\t     if(jQuery('#summary').html()==''){
\t\t\t     \tjQuery('#summary').html('<p></p>');
\t\t\t     }
\t\t     \tjQuery('#summary').ckeditor(
\t\t     \t\t{ toolbar:'Summary',
\t\t     \t\t  customConfig : 'config.js.cfm'},
\t\t     \t\thtmlEditorOnComplete
\t\t     \t);
\t    \t\tsummaryLoaded=true;
\t\t     `;

const EDITOR_CLOSE = `

\t\t\t}
\t\t\t`;

const SUMMARY_CLOSE = `
\t\t}
  </script>
 `;

/** The FCKeditor summary loader; the theme `fckconfig.js.cfm` line is never emitted, since web cannot see theme files. */
function fckeditor(req: AdminRequest, themePath: string | undefined): string {
  if (themePath === undefined) throw new TypeError("carch js.cfm's FCKeditor loader needs getSite(rc.siteid).getThemeAssetPath()");
  return `
\t\t   \t\tFCKeditor_OnComplete=htmlEditorOnComplete;
\t\t     \tvar oFCKeditor = new FCKeditor( 'summary' ) ;
\t\t\t  \t//oFCKeditor.instanceName\t= "summary";
\t\t\t\toFCKeditor.value\t\t\t= document.contentForm.summary.value;
\t\t\t\toFCKeditor.BasePath\t\t= "${legacySettings().context}/wysiwyg/";
\t\t\t\toFCKeditor.Config.EditorAreaCSS\t= '${themePath}/css/editor.css';
\t\t\t\toFCKeditor.Config.StylesXmlPath = '${themePath}/css/fckstyles.xml';
\t\t\t\t
\t\t\t\toFCKeditor.width\t\t\t= "98%";
\t\t\t\toFCKeditor.ToolbarSet\t\t\t= "Summary";
\t\t\t\toFCKeditor.Config.DefaultLanguage='${req.session.rb.toLowerCase()}';
\t\t\t\toFCKeditor.Config.AutoDetectLanguage=false;
\t\t     \toFCKeditor.ReplaceTextarea();
\t\t     `;
}

/** The `editSummary` body for the configured `htmlEditorType`: empty for `none`, else the editor loader. */
function editorLoader(req: AdminRequest, themePath: string | undefined): string {
  const editorType = legacySettings().htmlEditorType.toLowerCase();
  if (editorType === 'none') return '';
  return EDITOR_OPEN + (editorType === 'fckeditor' ? fckeditor(req, themePath) : CKEDITOR) + EDITOR_CLOSE;
}

/**
 * The `js.cfm` `request.ajax` value, for `ShellView.ajax`.
 * @param action FW/1 item of the request (`listLast(rc.muraAction, '.')`), compared case-insensitively with `edit`.
 * @param themeAssetPath Legacy's `getSite(rc.siteid).getThemeAssetPath()`, which the FCKeditor loader of `edit` prints.
 * @throws TypeError When the FCKeditor loader prints and `themeAssetPath` is absent.
 */
export function carchJs(ctx: Pick<ScreenContext, 'req'>, action: string, themeAssetPath?: string): SafeHtml {
  const architecture = `
\t<script src="${adminAssetUrl('js/architecture.min.js', { coreversion: true })}" type="text/javascript" ></script>
`;
  if (action.toLowerCase() !== 'edit') return raw(architecture);
  return raw(architecture + SUMMARY_UNLOADED + SUMMARY_OPEN + editorLoader(ctx.req, themeAssetPath) + SUMMARY_CLOSE);
}
