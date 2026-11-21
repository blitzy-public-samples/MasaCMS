// Remote panel of the content editor (`admin/core/views/carch/form/dsp_panel_remote.cfm`), server-only.
import { raw } from '@/lib/html';
import { datetimeSelector, type EditFormInput, type EditPageData, type PanelResult } from './custom-tags';

type Struct = Readonly<Record<string, unknown>>;

/** A struct member by case-insensitive name, as CFML reads it; undefined when absent. */
function memberOf(struct: Struct, name: string): unknown {
  if (Object.hasOwn(struct, name)) return struct[name];
  const lower = name.toLowerCase();
  const key = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : struct[key];
}

/** `rc.contentBean`, the edited version's `getAllValues()`; throws when the model holds none. */
function contentBeanOf(data: EditPageData): Struct {
  const bean = memberOf(data.rc, 'contentBean');
  if (typeof bean !== 'object' || bean === null || Array.isArray(bean)) {
    throw new TypeError('strategies-content edit model has no rc.contentBean struct for the Remote panel');
  }
  return bean as Struct;
}

/** A bean getter's value as CFML text: absent and SQL NULL read as `''`; complex values throw. */
function beanText(bean: Struct, name: string): string {
  const value = memberOf(bean, name);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`rc.contentBean.${name} is not a simple value`);
}

const DATE_TEXT = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/;

/** A stored date as CFML `ToString` prints the bean's date, `{ts 'yyyy-mm-dd HH:nn:ss'}`; other text as given. */
function cfDateString(value: string): string {
  const m = DATE_TEXT.exec(value.trim());
  return m === null ? value : `{ts '${m[1]} ${m[2] ?? '00'}:${m[3] ?? '00'}:${m[4] ?? '00'}'}`;
}

/** The Remote panel from the newline after `<cfoutput>` through `</div> \n`; bean values print unencoded, as legacy. */
export function renderPanelRemote(input: EditFormInput): PanelResult {
  const { ctx } = input;
  const bean = contentBeanOf(input.data);
  const label = (field: string): string => ctx.rb.rbKey(`sitemanager.content.fields.${field}`);
  const pubDate = datetimeSelector(ctx, {
    name: 'remotePubDate',
    datetime: cfDateString(beanText(bean, 'remotePubDate')),
    timeselectwrapper: true,
  });
  return {
    tabId: 'tabRemote',
    tabLabel: 'Remote',
    html: raw(`
<div class="mura-panel panel">
\t<div class="mura-panel-heading" role="tab" id="heading-remote">
\t\t<h4 class="mura-panel-title">
\t\t\t
\t\t\t<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-remote" aria-expanded="false" aria-controls="panel-remote">Remote </a>
\t\t</h4>
\t</div>
\t<div id="panel-remote" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-remote" aria-expanded="false" style="height: 0px;">
\t\t<div class="mura-panel-body">
\t\t\t
\t\t\t<span id="extendset-container-tabremotetop" class="extendset-container"></span>

\t\t\t
\t
\t\t\t\t<h2>${label('remoteinformation')}</h2>

\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${label('remoteid')}</label>
\t\t\t\t\t<input type="text" id="remoteID" name="remoteID" value="${beanText(bean, 'remoteID')}"  maxlength="255">
\t\t\t\t\t</div>

\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${label('remoteurl')}</label>
\t\t\t\t\t<input type="text" id="remoteURL" name="remoteURL" value="${beanText(bean, 'remoteURL')}"  maxlength="255">
\t\t\t\t\t</div>
\t\t\t\t\t
\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t<label>${label('remotepublicationdate')}</label>\t\t\t\t\t\t
\t\t\t\t\t\t${pubDate.value}
\t\t\t\t\t</div>

\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${label('remotesource')}</label>
\t\t\t\t\t<input type="text" id="remoteSource" name="remoteSource" value="${beanText(bean, 'remoteSource')}"  maxlength="255">
\t\t\t\t\t</div>

\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${label('remotesourceurl')}</label>
\t\t\t\t\t<input type="text" id="remoteSourceURL" name="remoteSourceURL" value="${beanText(bean, 'remoteSourceURL')}"  maxlength="255">
\t\t\t\t\t</div>
\t
\t\t\t
\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-remote">
\t\t\t\t<div class="bigui" id="bigui__remote" data-label="Manage Extended Attributes">
\t\t\t\t\t<div class="bigui__title">Manage Extended Attributes</div>
\t\t\t\t\t<div class="bigui__controls">
\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>
\t\t\t\t\t\t<span id="extendset-container-remote" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-remote"></span>
\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>
\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t\t
\t\t\t</div>
\t\t\t<span id="extendset-container-tabremotebottom" class="extendset-container"></span>
\t\t</div>
\t</div>
</div> 
`),
  };
}
