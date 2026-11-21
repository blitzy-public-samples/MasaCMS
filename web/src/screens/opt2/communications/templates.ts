// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext, SubmitResult } from '../../registry';
import {
  block,
  controlGroup,
  gridTable,
  opt2Label,
  opt2View,
  pagination,
  postForm,
  readPage,
  submitToService,
  textarea,
  textInput,
} from '../shared';
import {
  CSRF_CONTEXT,
  MODULE,
  SENDER_GATE,
  SENDER_ROLES,
  SERVICE,
  actionUrl,
  buttonLink,
  moduleHeader,
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

/** The requested page of templates (`listTemplates`), page 1 past the last, with the form's CSRF pair fetched. */
export async function loadTemplates(ctx: ScreenContext): Promise<TemplatesData> {
  const [{ answer: response }] = await Promise.all([
    readPage(
      requestedPage(ctx),
      (pageIndex) => ctx.gateway.communications.call('get', '/v1/templates', { query: { pageIndex } }),
      (answer) => (answer.ok ? answer.body.data.totalpages : undefined),
    ),
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
  const headers = (['Name', 'Subject', 'Created', 'Last Update', 'Actions'] as const).map((name) =>
    opt2Label(ctx, name),
  );
  const list = gridTable(headers, rows, 'There are no templates.', {
    columnClasses: [undefined, 'var-width', 'hidden-xs hidden-sm', 'hidden-xs'],
  });
  const nameLabel = opt2Label(ctx, 'Name');
  const subjectLabel = opt2Label(ctx, 'Subject');
  const fields = [
    controlGroup(nameLabel, textInput('name', form.name, { maxlength: 100, required: true, label: nameLabel })),
    controlGroup(
      subjectLabel,
      textInput('subject', form.subject, { maxlength: 255, required: true, label: subjectLabel }),
    ),
    controlGroup('Text Body', textarea('bodyText', form.bodyText)),
    controlGroup('HTML Body', textarea('bodyHtml', form.bodyHtml)),
  ];
  const addForm = postForm(actionUrl(ctx, 'save-template'), html`${fields}`, 'Save Template', {
    hidden: ctx.csrf.render(CSRF_CONTEXT),
  });
  const pager = pagination(ctx, {
    page: data.page.pageindex,
    totalRecords: data.page.totalitems,
    recordsPerPage: data.page.itemsperpage,
    href: (pageIndex) => screenUrl(ctx, SCREEN, { pageIndex }),
  });
  const listBlock = block(html`${list}${pager}`);
  return html`${moduleHeader(ctx, 'Templates', SCREEN)}${alert}${listBlock}${block(html`<h2>Add Template</h2>${addForm}`)}`;
}

export const templatesScreen: Opt2ScreenDefinition<TemplatesData> = Object.freeze({
  module: MODULE,
  screen: SCREEN,
  roles: SENDER_ROLES,
  service: SERVICE,
  gate: SENDER_GATE,
  load: loadTemplates,
  render: (ctx: ScreenContext, data: TemplatesData) => opt2View(MODULE, templatesBody(ctx, data), SCREEN),
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
