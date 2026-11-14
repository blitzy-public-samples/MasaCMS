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
  postForm,
  select,
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
  pager,
  postedFields,
  requestedPage,
  screenUrl,
  stateLabel,
  type ListPage,
  type Message,
  type MessageTemplate,
} from './common';

const SCREEN = 'sends';

/** The contract's largest page size, at which the template choices read every page of templates. */
const TEMPLATE_CHOICES = 1000;

const SEND_FIELDS = ['templateId', 'to', 'from', 'variables', 'subject', 'bodyText', 'bodyHtml'] as const;

/** Send form values under the service's field names. */
export type SendForm = Record<(typeof SEND_FIELDS)[number], string>;

/** One page of the site's messages and the templates a send can use. */
export interface SendsData {
  readonly messages: readonly Message[];
  readonly page: ListPage;
  readonly templates: readonly MessageTemplate[];
}

/** Every template of the site in service order (`listTemplates`): the first page, then the remaining pages together. */
async function loadTemplateChoices(ctx: ScreenContext): Promise<MessageTemplate[]> {
  const templatePage = async (pageIndex?: number) => {
    const query = { pageIndex, itemsPerPage: TEMPLATE_CHOICES };
    const response = await ctx.gateway.communications.call('get', '/v1/templates', { query });
    return okBody(response, SERVICE, 'listTemplates').data;
  };
  const first = await templatePage();
  const later = Array.from({ length: Math.max(first.totalpages - 1, 0) }, (_, index) => templatePage(index + 2));
  return [first, ...(await Promise.all(later))].flatMap((page) => page.items);
}

/** The requested page of messages (`listMessages`) and every template as a choice, with the CSRF pair. */
export async function loadSends(ctx: ScreenContext): Promise<SendsData> {
  const [messages, templates] = await Promise.all([
    ctx.gateway.communications.call('get', '/v1/messages', { query: { pageIndex: requestedPage(ctx) } }),
    loadTemplateChoices(ctx),
    ctx.csrf.tokens(CSRF_CONTEXT),
  ]);
  const page = okBody(messages, SERVICE, 'listMessages').data;
  return { messages: page.items, page, templates };
}

/** The empty send form, its template preset from the request's `templateId`. */
function requestedForm(ctx: ScreenContext): SendForm {
  const templateId = ctx.req.rc['templateId'] ?? '';
  return { templateId, to: '', from: '', variables: '', subject: '', bodyText: '', bodyHtml: '' };
}

/** Messages list with delivery-status links, then the send form holding `form`, below `alert` when given. */
export function sendsBody(ctx: ScreenContext, data: SendsData, form: SendForm, alert?: SafeHtml): SafeHtml {
  const templateNames = new Map(data.templates.map((template) => [template.template_id, template.name]));
  const rows = data.messages.map((message) => [
    message.to_address,
    message.subject,
    message.template_id === '' ? '' : (templateNames.get(message.template_id) ?? message.template_id),
    stateLabel(ctx, message.state),
    message.created,
    message.sent_at,
    buttonLink('Delivery Status', screenUrl(ctx, 'delivery-status', { messageId: message.message_id })),
  ]);
  const headers = (['To', 'Subject', 'Template', 'State', 'Created', 'Sent', 'Actions'] as const).map((name) =>
    opt2Label(ctx, name),
  );
  const list = gridTable(headers, rows, 'There are no sends.');
  const choices = [
    { value: '', label: 'None (literal content)' },
    ...data.templates.map((template) => ({ value: template.template_id, label: template.name })),
  ];
  const fields = [
    controlGroup(opt2Label(ctx, 'Template'), select('templateId', choices, form.templateId)),
    controlGroup(opt2Label(ctx, 'To'), textInput('to', form.to, { maxlength: 255, required: true })),
    controlGroup(opt2Label(ctx, 'From'), textInput('from', form.from, { maxlength: 255 })),
    controlGroup('Variables (JSON object)', textarea('variables', form.variables, 3)),
    controlGroup(opt2Label(ctx, 'Subject'), textInput('subject', form.subject, { maxlength: 255 })),
    controlGroup('Text Body', textarea('bodyText', form.bodyText)),
    controlGroup('HTML Body', textarea('bodyHtml', form.bodyHtml)),
  ];
  const sendForm = postForm(actionUrl(ctx, 'send'), html`${fields}`, 'Send', { hidden: ctx.csrf.render(CSRF_CONTEXT) });
  const listBlock = block(html`${list}${pager(ctx, SCREEN, data.page)}`);
  return html`${moduleHeader(ctx, 'Sends')}${alert}${listBlock}${block(html`<h2>Send Message</h2>${sendForm}`)}`;
}

export const sendsScreen: Opt2ScreenDefinition<SendsData> = Object.freeze({
  module: MODULE,
  screen: SCREEN,
  roles: SENDER_ROLES,
  service: SERVICE,
  gate: SENDER_GATE,
  load: loadSends,
  render: (ctx: ScreenContext, data: SendsData) => opt2View(MODULE, sendsBody(ctx, data, requestedForm(ctx))),
});

/** Sends the posted message (`sendMessage`), then returns to Sends; a rejection re-renders the posted form. */
export async function sendMessage(ctx: ScreenContext): Promise<SubmitResult> {
  const form: SendForm = postedFields(ctx, SEND_FIELDS);
  return submitToService(
    ctx,
    {
      service: SERVICE,
      call: (gateway, headers) => gateway.communications.call('post', '/v1/messages', { form, headers }),
    },
    { module: MODULE, screen: SCREEN, params: { siteid: ctx.req.session.siteid } },
    async (alert) => sendsBody(ctx, await loadSends(ctx), form, alert),
  );
}

export const sendAction: Opt2ActionDefinition = Object.freeze({
  module: MODULE,
  action: 'send',
  roles: SENDER_ROLES,
  service: SERVICE,
  gate: SENDER_GATE,
  submit: sendMessage,
});
