// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { SITE_ORDER, type SiteKey } from '../config.js';
import { printable } from '../errors.js';
import {
  FIXTURE_TABLE_SPECS,
  fixtureKey,
  type FixtureContext,
  type FixtureRow,
  type FixtureTableSpec,
  type FixtureTables,
} from '../fixture-tables.js';
import { cfUuidFrom } from '../ids.js';
import type { UserRow } from '../masa.js';
import type { SeedRandom } from '../random.js';

type FinalState = 'sent' | 'delivered' | 'failed';

/** One delivery_status entry of a message's history. */
interface HistoryStep {
  status: FinalState;
  detail: string | null;
}

/** Seeded template with its unrendered texts and the minute offset of its last edit. */
interface Template {
  id: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  editedMinute: number;
  row: FixtureRow;
}

const MODULE = 'communications';
const SENDER_ROLE = 'communications.sender';
const MINUTES_PER_DAY = 1440;
const FIRST_STATUS_MAX_MINUTES = 2;
const NEXT_STATUS_MAX_MINUTES = 15;
// Latest creation minute (relative to business-date midnight) that keeps every status row before the business date.
const LATEST_CREATED_MINUTE = -(FIRST_STATUS_MAX_MINUTES + NEXT_STATUS_MAX_MINUTES + 1);
const GUARANTEED_STATES: readonly FinalState[] = ['delivered', 'sent', 'failed'];
const STATE_WEIGHTS: readonly (readonly [FinalState, number])[] = [
  ['delivered', 80],
  ['sent', 10],
  ['failed', 10],
];
// Detail values the fixture's live send records: an SMTP failure, or a sent message Mailpit never showed.
const SMTP_ERROR = 'smtp-error';
const MAILPIT_NOT_FOUND = 'mailpit-not-found';
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const TEMPLATE_KINDS: readonly { name: string; subject: string }[] = [
  { name: 'Welcome', subject: 'Welcome to {{siteName}}, {{firstName}}' },
  { name: 'Password Reminder', subject: 'Your {{siteName}} password reminder' },
  { name: 'Event Invitation', subject: '{{firstName}}, you are invited to a {{siteName}} event' },
  { name: 'Monthly Newsletter', subject: '{{siteName}} monthly newsletter' },
  { name: 'Survey Invitation', subject: 'Share your feedback with {{siteName}}' },
  { name: 'Timesheet Reminder', subject: '{{firstName}}, your timesheet is due' },
  { name: 'Approval Request', subject: 'Approval requested in {{siteName}}' },
  { name: 'Account Update', subject: 'Your {{siteName}} account was updated' },
  { name: 'Policy Notice', subject: 'Policy update for {{siteName}} members' },
  { name: 'Weekly Digest', subject: 'Your weekly {{siteName}} digest, {{firstName}}' },
];

/** Registry spec of a communications table; throws `RangeError` when the registry lacks it. */
function specFor(table: string): FixtureTableSpec {
  const found = FIXTURE_TABLE_SPECS.find((entry) => entry.module === MODULE && entry.table === table);
  if (found === undefined) throw new RangeError(`No ${MODULE} fixture table ${table} in the registry`);
  return found;
}

/** Timestamp `minute` minutes from business-date midnight, with drawn milliseconds. */
function stamp(ctx: FixtureContext, rng: SeedRandom, minute: number): string {
  return ctx.calendar.localTimestamp(0, minute, rng.int(0, 99) * 10);
}

/** Replaces each `{{key}}` whose key is in `values` (case-sensitive); other placeholders stay as written. */
function render(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole: string, key: string) => (Object.hasOwn(values, key) ? (values[key] as string) : whole));
}

/** `count` templates created in the first eighth of the history window, some edited within the next eighth. */
function buildTemplates(ctx: FixtureContext, rng: SeedRandom, siteID: SiteKey, count: number): Template[] {
  const { faker } = rng;
  const windowStart = -ctx.config.historyDays * MINUTES_PER_DAY;
  const span = Math.floor((ctx.config.historyDays * MINUTES_PER_DAY) / 8);
  return Array.from({ length: count }, (_, i): Template => {
    const kind = TEMPLATE_KINDS[i % TEMPLATE_KINDS.length] as (typeof TEMPLATE_KINDS)[number];
    const round = Math.floor(i / TEMPLATE_KINDS.length);
    const id = cfUuidFrom(rng);
    const createdMinute = windowStart + rng.int(0, span);
    const editedMinute = rng.bool() ? createdMinute : createdMinute + rng.int(1, span);
    const created = stamp(ctx, rng, createdMinute);
    const lastUpdate = ctx.calendar.addMinutes(created, editedMinute - createdMinute);
    const paragraphs = Array.from({ length: rng.int(1, 2) }, () => faker.lorem.paragraph());
    const closing = faker.lorem.sentence();
    const bodyText = ['Hello {{firstName}} {{lastName}},', ...paragraphs, closing, '{{siteName}}'].join('\n\n');
    const bodyHtml = [
      '<p>Hello {{firstName}} {{lastName}},</p>',
      ...paragraphs.map((text) => `<p>${text}</p>`),
      `<p>${closing}</p>`,
      '<p>{{siteName}}</p>',
    ].join('\n');
    return {
      id,
      subject: kind.subject,
      bodyText,
      bodyHtml,
      editedMinute,
      row: {
        template_id: id,
        siteID,
        name: round === 0 ? kind.name : `${kind.name} ${round + 1}`,
        subject: kind.subject,
        body_text: bodyText,
        body_html: bodyHtml,
        created,
        lastUpdate,
      },
    };
  });
}

/** `count` final states holding each of sent, delivered and failed when `count` allows, in drawn order. */
function finalStates(rng: SeedRandom, count: number): FinalState[] {
  const states = GUARANTEED_STATES.slice(0, count);
  while (states.length < count) states.push(rng.weighted(STATE_WEIGHTS));
  return rng.shuffle(states);
}

/** Status history that ends in `state`, as the fixture's send records it after queueing. */
function historyFor(rng: SeedRandom, state: FinalState): HistoryStep[] {
  switch (state) {
    case 'sent':
      return [{ status: 'sent', detail: null }];
    case 'delivered':
      return [
        { status: 'sent', detail: null },
        { status: 'delivered', detail: null },
      ];
    case 'failed':
      return rng.bool()
        ? [{ status: 'failed', detail: SMTP_ERROR }]
        : [
            { status: 'sent', detail: null },
            { status: 'failed', detail: MAILPIT_NOT_FOUND },
          ];
  }
}

/** Appends `count` historical messages of the site and their delivery-status rows. */
function buildMessages(
  ctx: FixtureContext,
  rng: SeedRandom,
  siteID: SiteKey,
  templates: readonly Template[],
  count: number,
  messageRows: FixtureRow[],
  statusRows: FixtureRow[],
): void {
  const domain = `@${ctx.config.emailDomain}`;
  const senders = ctx.index.actors(siteID, SENDER_ROLE).map((userID) => ctx.index.user(userID));
  const recipients = ctx.masa.users.filter(
    (user: UserRow) => user.siteID === siteID && user.email.endsWith(domain) && !ctx.index.isReserved(user.userID),
  );
  if (templates.length === 0 || senders.length === 0 || recipients.length === 0) {
    throw printable(new RangeError(`Site ${siteID} needs templates, ${SENDER_ROLE} actors and seed users for ${count} messages`));
  }
  const siteName = ctx.index.site(siteID).site;

  for (const state of finalStates(rng, count)) {
    const template = rng.pick(templates);
    const sender = rng.pick(senders);
    const recipient = rng.pick(recipients);
    const messageId = cfUuidFrom(rng);
    const created = stamp(ctx, rng, rng.int(template.editedMinute + 1, LATEST_CREATED_MINUTE));
    const values = { firstName: recipient.fname, lastName: recipient.lname, siteName };

    let recorded = ctx.calendar.addMinutes(created, rng.int(0, FIRST_STATUS_MAX_MINUTES));
    let sentAt: string | null = null;
    const steps = historyFor(rng, state);
    for (const [i, step] of steps.entries()) {
      if (i > 0) recorded = ctx.calendar.addMinutes(recorded, rng.int(1, NEXT_STATUS_MAX_MINUTES));
      if (step.status === 'sent') sentAt = recorded;
      statusRows.push({
        status_id: cfUuidFrom(rng),
        message_id: messageId,
        status: step.status,
        detail: step.detail,
        mailpit_id: null,
        recorded_at: recorded,
      });
    }

    messageRows.push({
      message_id: messageId,
      siteID,
      template_id: template.id,
      to_address: recipient.email,
      from_address: sender.email,
      subject: render(template.subject, values),
      body_text: render(template.bodyText, values),
      body_html: render(template.bodyHtml, values),
      state,
      created,
      sent_at: sentAt,
    });
  }
}

/** Communications rows of the dataset: templates, historical messages and their delivery-status histories. */
export function buildCommunicationsFixtures(ctx: FixtureContext): FixtureTables {
  const tables: FixtureTables = Object.fromEntries(
    FIXTURE_TABLE_SPECS.filter((entry) => entry.module === MODULE).map((entry): [string, FixtureRow[]] => [fixtureKey(entry), []]),
  );
  const rowsOf = (table: string): FixtureRow[] => tables[fixtureKey(specFor(table))] as FixtureRow[];
  const templateRows = rowsOf('message_template');
  const messageRows = rowsOf('message');
  const statusRows = rowsOf('delivery_status');

  for (const siteID of SITE_ORDER) {
    const { messageTemplates, messages } = ctx.config.sites[siteID].counts;
    if (messageTemplates === 0 && messages === 0) continue;
    const rng = ctx.random.fork(`${MODULE}/${siteID}`);
    const templates = buildTemplates(ctx, rng, siteID, messageTemplates);
    templateRows.push(...templates.map((template) => template.row));
    if (messages > 0) buildMessages(ctx, rng, siteID, templates, messages, messageRows, statusRows);
  }
  return tables;
}
