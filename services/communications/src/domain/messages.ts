// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Messages as the fixture `communications.cfc` serves them: compose and queue, send over SMTP, confirm through Mailpit, list and detail. */
import { LegacyApiError, cfDateTimeFormat, javaTrim } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import { withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { FixtureApiError, fixturePage, type FixtureListResult } from '../legacy/fixture-envelope.js';
import * as queries from '../repo/queries.js';
import type { DeliveryStatusRow, MessageRow, MessageSource, MessageState } from '../repo/tables.js';
import { recordStatus, type DomainDeps, type MailDeps } from './delivery.js';
import type { OutgoingMail } from './mail-transport.js';
import { isValidEmail } from './sender-address.js';
import { param, textParam } from './templates.js';

/** Send-message params under the fixture's names, read ignoring case as CFML struct keys resolve; values as received. */
export interface MessageInput {
  templateId?: unknown;
  /** Values for `{{key}}` placeholders: an object, or a JSON object string in form posts. */
  variables?: unknown;
  to?: unknown;
  from?: unknown;
  subject?: unknown;
  bodyText?: unknown;
  bodyHtml?: unknown;
  [key: string]: unknown;
}

/**
 * Message-list filters: `siteId` is the token's `site`, set by the route; `pageIndex` (default 1) and
 * `itemsPerPage` (default 50, at most 1000) are the raw request params, read ignoring case.
 */
export interface MessageFilters {
  siteId: string;
  pageIndex?: unknown;
  itemsPerPage?: unknown;
  [key: string]: unknown;
}

/** Who sends and what: `tenantId`, `siteId` and `userId` are the verified token's `tid`, `site` and `sub`. */
export interface CreateMessageArgs {
  tenantId: string;
  siteId: string;
  userId: string;
  input: MessageInput;
  context?: WriteContext;
}

/** A `synthetic.message` row as the fixture's envelope.rows() emits it: NULL as '', datetimes as `yyyy-mm-ddTHH:nn:ss`. */
export interface MessageView {
  message_id: string;
  siteid: string;
  template_id: string;
  to_address: string;
  from_address: string;
  subject: string;
  body_text: string;
  body_html: string;
  state: MessageState;
  created: string;
  sent_at: string;
}

/** A `synthetic.delivery_status` row as the fixture's envelope.rows() emits it. */
export interface DeliveryStatusView {
  status_id: string;
  message_id: string;
  status: MessageState;
  detail: string;
  mailpit_id: string;
  recorded_at: string;
}

/** The fixture's message detail: the message columns, then `history[]` by `recorded_at`, then `status_id`. */
export interface MessageDetailView extends MessageView {
  history: DeliveryStatusView[];
}

/** One page of the site's messages as envelope.cfc queryPage() returns it; the route renders it as `fixtureList`'s `listResult`. */
export interface MessagePage extends FixtureListResult {
  list: MessageView[];
  totalItems: number;
}

/** Sender the fixture uses when `from` is absent or empty. */
export const DEFAULT_FROM_ADDRESS = 'noreply@opt2.local';

/** Detail of the `failed` history row the fixture records when the SMTP send throws. */
export const SMTP_ERROR_DETAIL = 'smtp-error';

/** Detail of the `failed` history row the fixture records when Mailpit never shows the sent message. */
export const MAILPIT_NOT_FOUND_DETAIL = 'mailpit-not-found';

const SEND_SOURCE: MessageSource = 'send';
// The synthetic.message column sizes, which the fixture checks before its insert.
const MAX_ADDRESS_LENGTH = 255;
const MAX_SUBJECT_LENGTH = 255;
const FIXTURE_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss";
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** Subject and bodies of a message to queue. */
interface MessageContent {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

/** A message as composeMessage() resolves it; `templateId` is null for literal content. */
interface ComposedMessage extends MessageContent {
  templateId: string | null;
  to: string;
  from: string;
}

/** CFML isSimpleValue for a JSON or form value. */
function isSimple(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** CFML `isJSON(text) ? deserializeJSON(text) : ''`. */
function deserialize(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return '';
  }
}

/** The fixture's variablesParam(): an object or JSON object string of simple values; absent, null or '' is none. */
function variablesParam(input: MessageInput): Readonly<Record<string, string | number | boolean>> {
  const raw = param(input, 'variables') ?? '';
  const value = isSimple(raw) ? (String(raw) === '' ? {} : deserialize(String(raw))) : raw;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.values(value).every(isSimple)) {
    throw new LegacyApiError('invalidParameters');
  }
  return value as Record<string, string | number | boolean>;
}

/** Replaces each `{{key}}` whose key equals a `values` key case-sensitively, in one pass; other placeholders stay as written. */
function substitute(text: string, values: Readonly<Record<string, string | number | boolean>>): string {
  return text.replace(PLACEHOLDER, (placeholder, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : placeholder));
}

/** The template's content with `variables` filled in; throws the fixture's `notFound` when the tenant has no such template. */
async function templateContent(tx: TenantTx, templateId: string, input: MessageInput): Promise<MessageContent> {
  const template = await queries.findTemplate(tx, templateId);
  if (template === null) {
    throw new FixtureApiError('notFound');
  }
  const values = variablesParam(input);
  return {
    subject: substitute(template.subject, values),
    bodyText: substitute(template.body_text, values),
    bodyHtml: substitute(template.body_html, values),
  };
}

/** Literal content; a blank subject or no non-empty body answers `invalidParameters`. */
function literalContent(input: MessageInput): MessageContent {
  const content = { subject: textParam(input, 'subject'), bodyText: textParam(input, 'bodyText'), bodyHtml: textParam(input, 'bodyHtml') };
  if (javaTrim(content.subject) === '' || (content.bodyText === '' && content.bodyHtml === '')) {
    throw new LegacyApiError('invalidParameters');
  }
  return content;
}

/** The fixture's composeMessage(): template or literal content, then the recipient, sender and subject checks, in its order. */
async function composeMessage(tx: TenantTx, input: MessageInput): Promise<ComposedMessage> {
  const templateId = textParam(input, 'templateId');
  const to = textParam(input, 'to');
  const from = textParam(input, 'from') || DEFAULT_FROM_ADDRESS;
  const content = templateId === '' ? literalContent(input) : await templateContent(tx, templateId, input);
  if (
    !isValidEmail(to) ||
    to.length > MAX_ADDRESS_LENGTH ||
    !isValidEmail(from) ||
    from.length > MAX_ADDRESS_LENGTH ||
    content.subject.length > MAX_SUBJECT_LENGTH
  ) {
    throw new LegacyApiError('invalidParameters');
  }
  return { ...content, templateId: templateId === '' ? null : templateId, to, from };
}

/** A datetime column as envelope.rows() emits it; NULL as ''. */
function fixtureTimestamp(value: Date | null): string {
  return value === null ? '' : cfDateTimeFormat(value, FIXTURE_TIMESTAMP_MASK);
}

/** The fixture view of a message row, in the fixture's column order. */
export function messageView(row: MessageRow): MessageView {
  return {
    message_id: row.message_id,
    siteid: row.siteid,
    template_id: row.template_id ?? '',
    to_address: row.to_address,
    from_address: row.from_address,
    subject: row.subject,
    body_text: row.body_text,
    body_html: row.body_html,
    state: row.state,
    created: fixtureTimestamp(row.created),
    sent_at: fixtureTimestamp(row.sent_at),
  };
}

/** The fixture view of a delivery-status history row, in the fixture's column order. */
export function deliveryStatusView(row: DeliveryStatusRow): DeliveryStatusView {
  return {
    status_id: row.status_id,
    message_id: row.message_id,
    status: row.status,
    detail: row.detail ?? '',
    mailpit_id: row.mailpit_id ?? '',
    recorded_at: fixtureTimestamp(row.recorded_at),
  };
}

/** Records `state` for `message` in its own gated tenant transaction; returns the updated message. */
async function recordInTenant(
  deps: Pick<DomainDeps, 'db' | 'repository' | 'clock'>,
  tenantId: string,
  message: MessageRow,
  state: MessageState,
  options: { mailpitId?: string; detail?: string; context?: WriteContext } = {},
): Promise<MessageRow> {
  const change = await withGatedTenant(deps.db, tenantId, (tx) =>
    recordStatus(tx, deps, message, state, options.mailpitId ?? null, options.context, options.detail ?? null),
  );
  return change.message;
}

/** Composes and stores a `queued` message with its `queued` history row in one gated transaction; throws the fixture's validation errors. */
export async function createMessage(
  deps: Pick<DomainDeps, 'db' | 'repository' | 'clock'>,
  args: CreateMessageArgs,
): Promise<MessageRow> {
  // The table has no author column, so `userId` is the changelog actor; a caller context overrides it.
  const context: WriteContext = { actorUserId: args.userId, ...args.context };
  return withGatedTenant(deps.db, args.tenantId, async (tx) => {
    const mail = await composeMessage(tx, args.input);
    const message = await deps.repository.insertMessage(
      tx,
      {
        siteId: args.siteId,
        templateId: mail.templateId,
        toAddress: mail.to,
        fromAddress: mail.from,
        subject: mail.subject,
        bodyText: mail.bodyText,
        bodyHtml: mail.bodyHtml,
        state: 'queued',
        source: SEND_SOURCE,
      },
      context,
    );
    return (await recordStatus(tx, deps, message, 'queued', null, context)).message;
  });
}

/** The mail for a stored message: its recipient, subject and parts, under its own id as Message-ID. */
export function outgoingMailFor(message: MessageRow, from: { name: string; address: string }): OutgoingMail {
  return {
    to: message.to_address,
    from,
    subject: message.subject,
    text: message.body_text,
    html: message.body_html,
    messageId: message.message_id,
  };
}

/** The line Masa's mailer logs when a send fails, for a site or, without one, for the settings.ini server. */
// mailer.cfc sendText's form, with the safe error text standing in for serializeJSON(cfcatch); login mail sends through here too.
function mailServerErrorText(siteId: string, reason: string): string {
  return siteId === ''
    ? `The current mail server settings in the settings.ini are not valid: ${reason}`
    : `The current mail server settings for the site '${siteId}' are not valid: ${reason}`;
}

/**
 * Sends `mail` for a committed message and records `sent`; a transport error is logged and recorded as `failed`
 * (`smtp-error`), never thrown. Gate errors of the recording transaction propagate. Returns the updated message.
 */
export async function sendMessage(
  deps: Pick<MailDeps, 'db' | 'repository' | 'clock' | 'logger' | 'transport'>,
  args: { tenantId: string; message: MessageRow; mail: OutgoingMail; context?: WriteContext },
): Promise<MessageRow> {
  try {
    await deps.transport.send(args.mail);
  } catch (error) {
    const record = serializeError(error);
    deps.logger.error({ tenantId: args.tenantId, error: record }, mailServerErrorText(args.message.siteid, record.message));
    return recordInTenant(deps, args.tenantId, args.message, 'failed', { detail: SMTP_ERROR_DETAIL, context: args.context });
  }
  return recordInTenant(deps, args.tenantId, args.message, 'sent', { context: args.context });
}

/** Looks a sent message up in Mailpit and records `delivered` with its Mailpit id, or `failed` (`mailpit-not-found`); returns the updated message. */
export async function confirmMessage(
  deps: Pick<MailDeps, 'db' | 'repository' | 'clock' | 'deliveryStatus'>,
  args: { tenantId: string; message: MessageRow; context?: WriteContext },
): Promise<MessageRow> {
  const mailpitId = await deps.deliveryStatus.confirm(args.message.message_id);
  return mailpitId === null
    ? recordInTenant(deps, args.tenantId, args.message, 'failed', { detail: MAILPIT_NOT_FOUND_DETAIL, context: args.context })
    : recordInTenant(deps, args.tenantId, args.message, 'delivered', { mailpitId, context: args.context });
}

/** The fixture's send: queue and commit, send, confirm unless the send failed; returns the message detail read afterwards. */
export async function submitMessage(
  deps: Pick<MailDeps, 'db' | 'repository' | 'clock' | 'logger' | 'transport' | 'deliveryStatus'>,
  args: CreateMessageArgs,
): Promise<MessageDetailView> {
  const { tenantId } = args;
  const context: WriteContext = { actorUserId: args.userId, ...args.context };
  const created = await createMessage(deps, { ...args, context });
  // The fixture's cfmail sends to the validated recipient unfiltered, from the bare address without a display name.
  const mail = outgoingMailFor(created, { name: '', address: created.from_address });
  const sent = await sendMessage(deps, { tenantId, message: created, mail, context });
  if (sent.state === 'sent') {
    await confirmMessage(deps, { tenantId, message: sent, context });
  }
  return withTenant(deps.db, tenantId, (tx) => getMessage(tx, created.message_id));
}

/** One page of the site's messages by `created`, then `message_id`, after validating paging as envelope.cfc page() does. */
export async function listMessages(tx: TenantTx, filters: MessageFilters): Promise<MessagePage> {
  const { pageIndex, itemsPerPage } = fixturePage(filters);
  const page = await queries.listMessages(tx, { siteId: filters.siteId, pageIndex, itemsPerPage });
  return { list: page.items.map(messageView), pageIndex, itemsPerPage, totalItems: page.total };
}

/** The message with its delivery-status history; throws the fixture's `notFound` when the tenant has no such message. */
export async function getMessage(tx: TenantTx, messageId: string): Promise<MessageDetailView> {
  const detail = await queries.getMessageDetail(tx, messageId);
  if (detail === null) {
    throw new FixtureApiError('notFound');
  }
  return { ...messageView(detail.message), history: detail.history.map(deliveryStatusView) };
}
