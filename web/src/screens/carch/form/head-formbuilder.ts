import { legacySettings } from '@/lib/env';
import { raw, type SafeHtml } from '@/lib/html';

/** Form builder scripts `form/head_formbuilder.cfm` adds with `cfhtmlhead`, for `ShellView.htmlHead`. */
export function headFormBuilder(): SafeHtml {
  const { context, adminDir } = legacySettings();
  const js = `${context}${adminDir}/assets/js`;
  // Settings unencoded, as legacy outputs them. Legacy places exactly these bytes before `</head>`: ACF whitespace
  // management reduces the cfsavecontent body to the cfoutput lines.
  return raw(`
<script src="${js}/jquery/jquery.jsonform.js" type="text/javascript"></script>
<script src="${js}/templatebuilder/jquery.templatebuilder.0.7.js" type="text/javascript"></script>
<script src="${js}/minigrid/jquery-ui-minigrid-0.7.js" type="text/javascript"></script>
`);
}
