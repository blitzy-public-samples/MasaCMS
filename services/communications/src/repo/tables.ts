// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Owned tables of schema `communications`, as the platform repository declares them. */
import type { CanonicalColumn, TableDefinition } from '@opt2/platform/migration-kit';
import type { QueueName } from '@opt2/platform/tasks';

/** Units of write authority of schema `communications`, as `opt2/table-ownership.json` names them, in declaration order. */
export const UNITS = [
  'communications.message_template',
  'communications.message',
  'communications.delivery_status',
  'communications.email',
  'communications.email_stat',
  'communications.email_return_stat',
  'communications.mailing_list',
  'communications.mailing_list_member',
  'communications.trash',
] as const;

/** One communications unit id. */
export type CommunicationsUnit = (typeof UNITS)[number];

/** Delivery states of `message.state` and `delivery_status.status`; a message starts `queued`. */
export const MESSAGE_STATES = ['queued', 'sent', 'delivered', 'failed'] as const;

/** One message delivery state. */
export type MessageState = (typeof MESSAGE_STATES)[number];

/** Values of the target-only `source` of `message` and `delivery_status`. */
export const MESSAGE_SOURCES = ['send', 'login-mail'] as const;

/** How a message was created: a send request or an identity login-mail event. */
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/** Values of `scheduled_task.kind`. */
export const SCHEDULED_TASK_KINDS = ['survey-launch', 'survey-reminder'] as const;

/** One scheduled-task kind. */
export type ScheduledTaskKind = (typeof SCHEDULED_TASK_KINDS)[number];

/** Values of `scheduled_task.status`; a new task is `scheduled`. */
export const SCHEDULED_TASK_STATUSES = ['scheduled', 'done', 'superseded', 'cancelled'] as const;

/** One scheduled-task status. */
export type ScheduledTaskStatus = (typeof SCHEDULED_TASK_STATUSES)[number];

// The 0002 migration declares no CHECK on scheduled_task.origin; these are the only values its two writers store.
/** Values of `scheduled_task.origin`: created from a `surveys.survey.scheduled.v1` event, or adopted from a fixture ACF task. */
export const SCHEDULED_TASK_ORIGINS = ['event', 'adopted'] as const;

/** Where a scheduled task came from. */
export type ScheduledTaskOrigin = (typeof SCHEDULED_TASK_ORIGINS)[number];

/** Queues of `scheduled_task.queue`: survey launches and survey reminders. */
export const SCHEDULED_TASK_QUEUES = ['surveys-launch', 'communications-reminders'] as const satisfies readonly QueueName[];

/** One scheduled-task queue. */
export type ScheduledTaskQueue = (typeof SCHEDULED_TASK_QUEUES)[number];

/** A gated communications table definition: its unit is one of `UNITS`. */
export interface CommunicationsTableDefinition extends TableDefinition {
  unit: CommunicationsUnit;
}

const TENANT_ID: CanonicalColumn = { name: 'tenant_id', type: 's' };
const LEGACY_ROW_HASH: CanonicalColumn = { name: 'legacy_row_hash', type: 's' };
const OCCURRENCE: CanonicalColumn = { name: 'occurrence', type: 'i' };

/** `communications.message_template`, from `synthetic.message_template`. */
export const MESSAGE_TEMPLATE: CommunicationsTableDefinition = {
  table: 'message_template',
  columns: [
    TENANT_ID,
    { name: 'template_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'subject', type: 's' },
    { name: 'body_text', type: 's' },
    { name: 'body_html', type: 's' },
    { name: 'created', type: 't' },
    { name: 'lastupdate', type: 't' },
  ],
  key: ['template_id'],
  unit: 'communications.message_template',
};

/** `communications.message`, from `synthetic.message`, plus the target-only `source`, `event_id` and `row_version`. */
export const MESSAGE: CommunicationsTableDefinition = {
  table: 'message',
  columns: [
    TENANT_ID,
    { name: 'message_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'template_id', type: 's' },
    { name: 'to_address', type: 's' },
    { name: 'from_address', type: 's' },
    { name: 'subject', type: 's' },
    { name: 'body_text', type: 's' },
    { name: 'body_html', type: 's' },
    { name: 'state', type: 's' },
    { name: 'created', type: 't' },
    { name: 'sent_at', type: 't' },
    { name: 'source', type: 's' },
    { name: 'event_id', type: 's' },
    { name: 'row_version', type: 'i' },
  ],
  key: ['message_id'],
  unit: 'communications.message',
};

/** `communications.delivery_status`, from `synthetic.delivery_status`, plus the target-only `source`; append-only. */
export const DELIVERY_STATUS: CommunicationsTableDefinition = {
  table: 'delivery_status',
  columns: [
    TENANT_ID,
    { name: 'status_id', type: 's' },
    { name: 'message_id', type: 's' },
    { name: 'status', type: 's' },
    { name: 'detail', type: 's' },
    { name: 'mailpit_id', type: 's' },
    { name: 'recorded_at', type: 't' },
    { name: 'source', type: 's' },
  ],
  key: ['status_id'],
  unit: 'communications.delivery_status',
};

// No unit: scheduled_task has no legacy table and no cut-over group, so a gate for it would stay `legacy`
// and reject every seam-2 consumer and adoption write; units are only the target tables opt2/table-ownership.json splits.
/** `communications.scheduled_task`: survey launch and reminder tasks; no legacy table, never mapped. */
export const SCHEDULED_TASK: TableDefinition = {
  table: 'scheduled_task',
  columns: [
    TENANT_ID,
    { name: 'scheduled_task_id', type: 's' },
    { name: 'task_name', type: 's' },
    { name: 'queue', type: 's' },
    { name: 'queue_task_name', type: 's' },
    { name: 'kind', type: 's' },
    { name: 'source_type', type: 's' },
    { name: 'source_id', type: 's' },
    { name: 'reminder_n', type: 'i' },
    { name: 'schedule_time', type: 't' },
    { name: 'status', type: 's' },
    { name: 'target_route', type: 's' },
    { name: 'schedule_version', type: 'i' },
    { name: 'origin', type: 's' },
    { name: 'enqueued_at', type: 't' },
    { name: 'dequeued_at', type: 't' },
    { name: 'created_at', type: 't' },
    { name: 'updated_at', type: 't' },
  ],
  key: ['scheduled_task_id'],
};

/** `communications.email`, from Masa `temails`; mapping-only. */
export const EMAIL: CommunicationsTableDefinition = {
  table: 'email',
  columns: [
    TENANT_ID,
    { name: 'emailid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'subject', type: 's' },
    { name: 'bodytext', type: 's' },
    { name: 'bodyhtml', type: 's' },
    { name: 'createddate', type: 't' },
    { name: 'deliverydate', type: 't' },
    { name: 'status', type: 'i' },
    { name: 'grouplist', type: 's' },
    { name: 'lastupdateby', type: 's' },
    { name: 'lastupdatebyid', type: 's' },
    { name: 'numbersent', type: 'i' },
    { name: 'replyto', type: 's' },
    { name: 'format', type: 's' },
    { name: 'fromlabel', type: 's' },
    { name: 'isdeleted', type: 'i' },
    { name: 'template', type: 's' },
  ],
  key: ['emailid'],
  unit: 'communications.email',
};

/** `communications.email_stat`, from Masa `temailstats`; mapping-only, keyless. */
export const EMAIL_STAT: CommunicationsTableDefinition = {
  table: 'email_stat',
  columns: [
    TENANT_ID,
    { name: 'emailid', type: 's' },
    { name: 'email', type: 's' },
    { name: 'emailopen', type: 'i' },
    { name: 'returnclick', type: 'i' },
    { name: 'bounce', type: 'i' },
    { name: 'sent', type: 'i' },
    { name: 'created', type: 't' },
    LEGACY_ROW_HASH,
    OCCURRENCE,
  ],
  key: null,
  unit: 'communications.email_stat',
};

/** `communications.email_return_stat`, from Masa `temailreturnstats`; mapping-only, keyless. */
export const EMAIL_RETURN_STAT: CommunicationsTableDefinition = {
  table: 'email_return_stat',
  columns: [
    TENANT_ID,
    { name: 'emailid', type: 's' },
    { name: 'email', type: 's' },
    { name: 'url', type: 's' },
    { name: 'created', type: 't' },
    LEGACY_ROW_HASH,
    OCCURRENCE,
  ],
  key: null,
  unit: 'communications.email_return_stat',
};

/** `communications.mailing_list`, from Masa `tmailinglist`; mapping-only, keyless. */
export const MAILING_LIST: CommunicationsTableDefinition = {
  table: 'mailing_list',
  columns: [
    TENANT_ID,
    { name: 'mlid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'description', type: 's' },
    { name: 'lastupdate', type: 't' },
    { name: 'ispurge', type: 'i' },
    { name: 'ispublic', type: 'i' },
    LEGACY_ROW_HASH,
    OCCURRENCE,
  ],
  key: null,
  unit: 'communications.mailing_list',
};

/** `communications.mailing_list_member`, from Masa `tmailinglistmembers`; mapping-only, keyless. */
export const MAILING_LIST_MEMBER: CommunicationsTableDefinition = {
  table: 'mailing_list_member',
  columns: [
    TENANT_ID,
    { name: 'mlid', type: 's' },
    { name: 'email', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'fname', type: 's' },
    { name: 'lname', type: 's' },
    { name: 'company', type: 's' },
    { name: 'isverified', type: 'i' },
    { name: 'created', type: 't' },
    LEGACY_ROW_HASH,
    OCCURRENCE,
  ],
  key: null,
  unit: 'communications.mailing_list_member',
};

/** `communications.trash`, the `ttrash` rows of objectClass email and mailinglist; mapping-only, `objectstring` is byte-exact WDDX. */
export const TRASH: CommunicationsTableDefinition = {
  table: 'trash',
  columns: [
    TENANT_ID,
    { name: 'objectid', type: 's' },
    { name: 'parentid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'objectlabel', type: 's' },
    { name: 'objectclass', type: 's' },
    { name: 'objecttype', type: 's' },
    { name: 'objectsubtype', type: 's' },
    { name: 'objectstring', type: 's' },
    { name: 'deleteddate', type: 't' },
    { name: 'deletedby', type: 's' },
    { name: 'deleteid', type: 's' },
    { name: 'orderno', type: 'i' },
  ],
  key: ['objectid'],
  unit: 'communications.trash',
};

/** Every owned table, in catalog order; the `tables` of the communications repository. */
export const OWNED_TABLES: readonly TableDefinition[] = [
  MESSAGE_TEMPLATE,
  MESSAGE,
  DELIVERY_STATUS,
  SCHEDULED_TASK,
  EMAIL,
  EMAIL_STAT,
  EMAIL_RETURN_STAT,
  MAILING_LIST,
  MAILING_LIST_MEMBER,
  TRASH,
];

/** Columns per mapped table that exist only in the target and are never mapped to or from legacy. */
export const TARGET_ONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  message: ['source', 'event_id', 'row_version'],
  delivery_status: ['source'],
};

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** A `communications.message_template` row as pg returns it. */
export type MessageTemplateRow = {
  tenant_id: string;
  template_id: string;
  siteid: string;
  name: string;
  subject: string;
  body_text: string;
  body_html: string;
  created: Date;
  lastupdate: Date | null;
};

/** A `communications.message` row as pg returns it. */
export type MessageRow = {
  tenant_id: string;
  message_id: string;
  siteid: string;
  template_id: string | null;
  to_address: string;
  from_address: string;
  subject: string;
  body_text: string;
  body_html: string;
  state: MessageState;
  created: Date;
  sent_at: Date | null;
  source: MessageSource;
  event_id: string | null;
  /** int8, which pg returns as a decimal string. */
  row_version: string;
};

/** A `communications.delivery_status` row as pg returns it. */
export type DeliveryStatusRow = {
  tenant_id: string;
  status_id: string;
  message_id: string;
  status: MessageState;
  detail: string | null;
  mailpit_id: string | null;
  recorded_at: Date;
  source: MessageSource;
};

/** A `communications.scheduled_task` row as pg returns it. */
export type ScheduledTaskRow = {
  tenant_id: string;
  scheduled_task_id: string;
  task_name: string;
  queue: ScheduledTaskQueue;
  queue_task_name: string;
  kind: ScheduledTaskKind;
  source_type: string;
  source_id: string;
  reminder_n: number | null;
  schedule_time: Date;
  status: ScheduledTaskStatus;
  target_route: string;
  schedule_version: number;
  origin: ScheduledTaskOrigin;
  enqueued_at: Date | null;
  dequeued_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/** A `communications.email` row as pg returns it. */
export type EmailRow = {
  tenant_id: string;
  emailid: string;
  siteid: string | null;
  subject: string | null;
  bodytext: string | null;
  bodyhtml: string | null;
  createddate: Date | null;
  deliverydate: Date | null;
  status: number | null;
  grouplist: string | null;
  lastupdateby: string | null;
  lastupdatebyid: string | null;
  numbersent: number;
  replyto: string | null;
  format: string | null;
  fromlabel: string | null;
  isdeleted: number;
  template: string | null;
};

/** A `communications.email_stat` row as pg returns it. */
export type EmailStatRow = {
  tenant_id: string;
  emailid: string | null;
  email: string | null;
  emailopen: number;
  returnclick: number;
  bounce: number;
  sent: number;
  created: Date | null;
  legacy_row_hash: string;
  occurrence: number;
};

/** A `communications.email_return_stat` row as pg returns it. */
export type EmailReturnStatRow = {
  tenant_id: string;
  emailid: string | null;
  email: string | null;
  url: string | null;
  created: Date | null;
  legacy_row_hash: string;
  occurrence: number;
};

/** A `communications.mailing_list` row as pg returns it. */
export type MailingListRow = {
  tenant_id: string;
  mlid: string | null;
  siteid: string | null;
  name: string | null;
  description: string | null;
  lastupdate: Date | null;
  ispurge: number | null;
  ispublic: number | null;
  legacy_row_hash: string;
  occurrence: number;
};

/** A `communications.mailing_list_member` row as pg returns it. */
export type MailingListMemberRow = {
  tenant_id: string;
  mlid: string | null;
  email: string | null;
  siteid: string | null;
  fname: string | null;
  lname: string | null;
  company: string | null;
  isverified: number;
  created: Date | null;
  legacy_row_hash: string;
  occurrence: number;
};

/** A `communications.trash` row as pg returns it. */
export type TrashRow = {
  tenant_id: string;
  objectid: string;
  parentid: string;
  siteid: string;
  objectlabel: string;
  objectclass: string;
  objecttype: string;
  objectsubtype: string;
  objectstring: string | null;
  deleteddate: Date | null;
  deletedby: string;
  deleteid: string | null;
  orderno: number | null;
};
