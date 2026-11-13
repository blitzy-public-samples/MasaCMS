// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext, SubmitResult } from '../../registry';
import { block, controlGroup, gridTable, opt2View, postForm, submitToService, textarea, textInput } from '../shared';
import {
  CSRF_CONTEXT,
  MODULE,
  SENDER_GATE,
  SENDER_ROLES,
  SERVICE,
  actionUrl,
  buttonLink,
  moduleHeader,
  pager,
  postedFields,
  requestedPage,
  screenUrl,
  type ListPage,
  type MessageTemplate,
} from './common';

const SCREEN = 'templates';

const TEMPLATE_FIELDS = ['name', 'subject', 'bodyText', 'bodyHtml'] as const;

/** Template form values under the service's field names. */
export type TemplateForm = Record<(typeof TEMPLATE_FIELDS)[number], string>;

/** One page of the site's templates. */
export interface TemplatesData {
  readonly templates: readonly MessageTemplate[];
  readonly page: ListPage;
}

const EMPTY_FORM: TemplateForm = Object.freeze({ name: '', subject: '', bodyText: '', bodyHtml: '' });

/** The requested page of templates (`listTemplates`), with the form's CSRF pair fetched. */
export async function loadTemplates(ctx: ScreenContext): Promise<TemplatesData> {
  const [response] = await Promise.all([
    ctx.gateway.communications.call('get', '/v1/templates', { query: { pageIndex: requestedPage(ctx) } }),
    ctx.csrf.tokens(CSRF_CONTEXT),
  ]);
  const page = okBody(response, SERVICE, 'listTemplates').data;
  return { templates: page.items, page };
}

/** Templates list with send links, then the new-template form holding `form`, below `alert` when given. */
export function templatesBody(
  ctx: ScreenContext,
  data: TemplatesData,
  form: TemplateForm = EMPTY_FORM,
  alert?: SafeHtml,
): SafeHtml {
  const rows = data.templates.map((template) => [
    template.name,
    template.subject,
    template.created,
    template.lastupdate,
    buttonLink('Send', screenUrl(ctx, 'sends', { templateId: template.template_id })),
  ]);
  const list = gridTable(['Name', 'Subject', 'Created', 'Last Update', 'Actions'], rows, 'There are no templates.');
  const fields = [
    controlGroup('Name', textInput('name', form.name, { maxlength: 100, required: true })),
    controlGroup('Subject', textInput('subject', form.subject, { maxlength: 255, required: true })),
    controlGroup('Text Body', textarea('bodyText', form.bodyText)),
    controlGroup('HTML Body', textarea('bodyHtml', form.bodyHtml)),
  ];
  const addForm = postForm(actionUrl(ctx, 'save-template'), html`${fields}`, 'Save Template', {
    hidden: ctx.csrf.render(CSRF_CONTEXT),
  });
  const listBlock = block(html`${list}${pager(ctx, SCREEN, data.page)}`);
  return html`${moduleHeader(ctx, 'Templates')}${alert}${listBlock}${block(html`<h2>Add Template</h2>${addForm}`)}`;
}

export const templatesScreen: Opt2ScreenDefinition<TemplatesData> = Object.freeze({
  module: MODULE,
  screen: SCREEN,
  roles: SENDER_ROLES,
  service: SERVICE,
  gate: SENDER_GATE,
  load: loadTemplates,
  render: (ctx: ScreenContext, data: TemplatesData) => opt2View(MODULE, templatesBody(ctx, data)),
});

/** Stores the posted template (`createTemplate`), then returns to Templates; a rejection re-renders the posted form. */
export async function saveTemplate(ctx: ScreenContext): Promise<SubmitResult> {
  const form: TemplateForm = postedFields(ctx, TEMPLATE_FIELDS);
  return submitToService(
    ctx,
    {
      service: SERVICE,
      call: (gateway, headers) => gateway.communications.call('post', '/v1/templates', { form, headers }),
    },
    { module: MODULE, screen: SCREEN, params: { siteid: ctx.req.session.siteid } },
    async (alert) => templatesBody(ctx, await loadTemplates(ctx), form, alert),
  );
}

export const saveTemplateAction: Opt2ActionDefinition = Object.freeze({
  module: MODULE,
  action: 'save-template',
  roles: SENDER_ROLES,
  service: SERVICE,
  gate: SENDER_GATE,
  submit: saveTemplate,
});
