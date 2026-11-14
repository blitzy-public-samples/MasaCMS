// cform.getfieldtemplate: the form-builder template markup html.cfm prints as the whole body (server-only).
import { okBody } from '@/lib/gateway-client';
import { relayField } from '@/lib/request-context';
import { HTML_CONTENT_TYPE } from '@/lib/responses';
import type { RawBody, Rc, ScreenContext } from '../registry';
import { fieldTemplateName, renderFormBuilderTemplate, type NestedFormOption } from './templates';

const NESTED_TEMPLATE = 'field-nested';
const NESTED_TEMPLATE_OPERATION = 'raw_cform_getfieldtemplate_post';
// field-nested.cfm prints each title unescaped, so a title ends at its first `</option>`.
const FORM_OPTION = /<option value="([^"]*)">([\s\S]*?)<\/option>/g;

/** The template `rc.fieldtype` names, as legacy's bare `text/html` body. */
export async function getFieldTemplate(ctx: ScreenContext): Promise<RawBody> {
  const fieldType = ctx.req.rc.fieldtype;
  if (fieldType === undefined) throw new TypeError('Element FIELDTYPE is undefined in RC.');
  const relayed = relayField(ctx.req, 'fieldType');
  return { status: 200, contentType: HTML_CONTENT_TYPE, body: await renderNamedTemplate(ctx, fieldType, relayed) };
}

// The strategies-content contract lists a site's forms only inside its rendered field-nested template, so that one
// template is relayed from the service; every other template is rendered here without a service call.
/**
 * The trimmed markup of the template `rawName` names, or legacy's missing-template message.
 * @param template The form fields naming the template to the service; `fieldType` of `rawName` when omitted.
 */
export async function renderNamedTemplate(
  ctx: ScreenContext,
  rawName: string,
  template: Rc = { fieldType: rawName },
): Promise<string> {
  if (fieldTemplateName(rawName) === NESTED_TEMPLATE) return nestedTemplateMarkup(ctx, template);
  return renderFormBuilderTemplate(rawName, { rb: ctx.rb, loadForms: () => loadNestedFormOptions(ctx) });
}

/** The session site's active forms except the POSTed `formid`, by title, as the service's field-nested lists them. */
export async function loadNestedFormOptions(ctx: ScreenContext): Promise<readonly NestedFormOption[]> {
  const markup = await nestedTemplateMarkup(ctx, { fieldType: NESTED_TEMPLATE });
  return [...markup.matchAll(FORM_OPTION)].map((match) => ({ contentID: match[1] ?? '', title: match[2] ?? '' }));
}

/** field-nested as strategies-content renders it for `session.siteid`, with `formid` only when the request has one. */
async function nestedTemplateMarkup(ctx: ScreenContext, template: Rc): Promise<string> {
  const response = await ctx.gateway.strategiesContent.call('post', '/v1/raw/cform/getfieldtemplate', {
    query: { siteid: ctx.req.session.siteid },
    form: { ...template, ...relayField(ctx.req, 'formid') },
  });
  return okBody(response, 'strategies-content', NESTED_TEMPLATE_OPERATION);
}
