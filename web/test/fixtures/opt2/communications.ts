// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components, operations } from '@/generated/clients/communications';
import { TENANT_A } from '@opt2/platform/testing';
import { routeKey, type FakeRouteTable } from '../../helpers/fake-gateway';
import { tenantASiteAdminSession } from '../session';

type S = components['schemas'];

export const COMMUNICATIONS_IDS = Object.freeze({
  templates: Object.freeze({
    welcome: 'C0330001-0000-0000-0000000000000001',
    surveyReminder: 'C0330001-0000-0000-0000000000000002',
    saved: 'C0330001-0000-0000-0000000000000003',
  } as const),
  messages: Object.freeze({
    delivered: 'C0330002-0000-0000-0000000000000001',
    sent: 'C0330002-0000-0000-0000000000000002',
    failed: 'C0330002-0000-0000-0000000000000003',
    queued: 'C0330002-0000-0000-0000000000000004',
    newSend: 'C0330002-0000-0000-0000000000000005',
  } as const),
  statuses: Object.freeze({
    deliveredQueued: 'C0330003-0000-0000-0000000000000001',
    deliveredSent: 'C0330003-0000-0000-0000000000000002',
    deliveredDelivered: 'C0330003-0000-0000-0000000000000003',
    newSendQueued: 'C0330003-0000-0000-0000000000000004',
    newSendSent: 'C0330003-0000-0000-0000000000000005',
    newSendDelivered: 'C0330003-0000-0000-0000000000000006',
  } as const),
} as const);

const MAILPIT_IDS = { delivered: 'kP3vN8qR2sT6wX9yZ4bC7d', newSend: 'mF5hJ2kL8nP4qR7sV3wX6z' } as const;
const DEFAULT_FROM = 'noreply@opt2.local';
const SITE_ADMIN_FROM = tenantASiteAdminSession.mura.email;

export const messageTemplates: S['MessageTemplate'][] = [
  {
    template_id: COMMUNICATIONS_IDS.templates.welcome,
    siteid: TENANT_A.siteId,
    name: 'welcome',
    subject: 'Welcome to {{siteName}}, {{firstName}}',
    body_text: 'Hello {{firstName}},\n\nYour {{siteName}} account is ready.',
    body_html: '<p>Hello {{firstName}},</p><p>Your {{siteName}} account is ready.</p>',
    created: '2026-05-04T09:00:00',
    lastupdate: '2026-06-12T14:30:00',
  },
  {
    template_id: COMMUNICATIONS_IDS.templates.surveyReminder,
    siteid: TENANT_A.siteId,
    name: 'survey-reminder',
    subject: 'Reminder: {{surveyTitle}} closes {{closeDate}}',
    body_text: 'Hello {{firstName}},\n\nPlease complete {{surveyTitle}} before {{closeDate}}.\n\nThank you.',
    body_html: '',
    created: '2026-05-18T10:15:00',
    lastupdate: '2026-06-30T08:45:00',
  },
];

const deliveredMessage: S['Message'] = {
  message_id: COMMUNICATIONS_IDS.messages.delivered,
  siteid: TENANT_A.siteId,
  template_id: COMMUNICATIONS_IDS.templates.welcome,
  to_address: 'avery.quinn@seed.opt2.test',
  from_address: SITE_ADMIN_FROM,
  subject: 'Welcome to Tenant A, Avery',
  body_text: 'Hello Avery,\n\nYour Tenant A account is ready.',
  body_html: '<p>Hello Avery,</p><p>Your Tenant A account is ready.</p>',
  state: 'delivered',
  created: '2026-06-29T09:00:00',
  sent_at: '2026-06-29T09:00:01',
};

const sentMessage: S['Message'] = {
  message_id: COMMUNICATIONS_IDS.messages.sent,
  siteid: TENANT_A.siteId,
  template_id: COMMUNICATIONS_IDS.templates.surveyReminder,
  to_address: 'blake.morgan@seed.opt2.test',
  from_address: DEFAULT_FROM,
  subject: 'Reminder: Staff Wellbeing Survey closes July 3, 2026',
  body_text: 'Hello Blake,\n\nPlease complete Staff Wellbeing Survey before July 3, 2026.\n\nThank you.',
  body_html: '',
  state: 'sent',
  created: '2026-06-29T15:30:00',
  sent_at: '2026-06-29T15:30:01',
};

const failedMessage: S['Message'] = {
  message_id: COMMUNICATIONS_IDS.messages.failed,
  siteid: TENANT_A.siteId,
  template_id: COMMUNICATIONS_IDS.templates.welcome,
  to_address: 'casey.lee@seed.opt2.test',
  from_address: SITE_ADMIN_FROM,
  subject: 'Welcome to Tenant A, Casey',
  body_text: 'Hello Casey,\n\nYour Tenant A account is ready.',
  body_html: '<p>Hello Casey,</p><p>Your Tenant A account is ready.</p>',
  state: 'failed',
  created: '2026-06-30T08:10:00',
  sent_at: '',
};

const queuedMessage: S['Message'] = {
  message_id: COMMUNICATIONS_IDS.messages.queued,
  siteid: TENANT_A.siteId,
  template_id: COMMUNICATIONS_IDS.templates.surveyReminder,
  to_address: 'devon.ross@seed.opt2.test',
  from_address: DEFAULT_FROM,
  subject: 'Reminder: Staff Wellbeing Survey closes July 3, 2026',
  body_text: 'Hello Devon,\n\nPlease complete Staff Wellbeing Survey before July 3, 2026.\n\nThank you.',
  body_html: '',
  state: 'queued',
  created: '2026-06-30T09:05:00',
  sent_at: '',
};

export const messages: S['Message'][] = [deliveredMessage, sentMessage, failedMessage, queuedMessage];

export const messageDetail: S['MessageDetail'] = {
  ...deliveredMessage,
  history: [
    {
      status_id: COMMUNICATIONS_IDS.statuses.deliveredQueued,
      message_id: COMMUNICATIONS_IDS.messages.delivered,
      status: 'queued',
      detail: '',
      mailpit_id: '',
      recorded_at: '2026-06-29T09:00:00',
    },
    {
      status_id: COMMUNICATIONS_IDS.statuses.deliveredSent,
      message_id: COMMUNICATIONS_IDS.messages.delivered,
      status: 'sent',
      detail: '',
      mailpit_id: '',
      recorded_at: '2026-06-29T09:00:01',
    },
    {
      status_id: COMMUNICATIONS_IDS.statuses.deliveredDelivered,
      message_id: COMMUNICATIONS_IDS.messages.delivered,
      status: 'delivered',
      detail: '',
      mailpit_id: MAILPIT_IDS.delivered,
      recorded_at: '2026-06-29T09:00:02',
    },
  ],
};

export const saveTemplateInvalid: {
  readonly status: 400;
  readonly body: operations['createTemplate']['responses'][400]['content']['application/json;charset=utf-8'];
} = {
  status: 400,
  body: { apiversion: 'v1', method: 'invalid', error: { message: 'Invalid parameters', code: 'invalid_request' } },
};

export const sendInvalid: {
  readonly status: 400;
  readonly body: operations['sendMessage']['responses'][400]['content']['application/json;charset=utf-8'];
} = {
  status: 400,
  body: { apiversion: 'v1', method: 'invalid', error: { message: 'Invalid parameters', code: 'invalid_request' } },
};

const templateListAnswer: operations['listTemplates']['responses'][200]['content']['application/json'] = {
  data: {
    items: messageTemplates,
    startindex: 1,
    endindex: messageTemplates.length,
    itemsperpage: 50,
    totalitems: messageTemplates.length,
    totalpages: 1,
    pageindex: 1,
  },
};

const messageListAnswer: operations['listMessages']['responses'][200]['content']['application/json'] = {
  data: {
    items: messages,
    startindex: 1,
    endindex: messages.length,
    itemsperpage: 50,
    totalitems: messages.length,
    totalpages: 1,
    pageindex: 1,
  },
};

const messageDetailAnswer: operations['getMessage']['responses'][200]['content']['application/json'] = {
  data: messageDetail,
};

const savedTemplateAnswer: operations['createTemplate']['responses'][200]['content']['application/json'] = {
  data: {
    template_id: COMMUNICATIONS_IDS.templates.saved,
    siteid: TENANT_A.siteId,
    name: 'timesheet-overdue',
    subject: 'Timesheet {{periodLabel}} is overdue',
    body_text: 'Hello {{firstName}},\n\nYour timesheet for {{periodLabel}} is still in draft.',
    body_html: '<p>Hello {{firstName}},</p><p>Your timesheet for {{periodLabel}} is still in draft.</p>',
    created: '2026-06-30T10:30:00',
    lastupdate: '2026-06-30T10:30:00',
  },
};

// sendMessage answers once its synchronous send is confirmed, as the fixture does, so the new message is delivered.
const sendAnswer: operations['sendMessage']['responses'][200]['content']['application/json'] = {
  data: {
    message_id: COMMUNICATIONS_IDS.messages.newSend,
    siteid: TENANT_A.siteId,
    template_id: COMMUNICATIONS_IDS.templates.surveyReminder,
    to_address: 'emery.hayes@seed.opt2.test',
    from_address: DEFAULT_FROM,
    subject: 'Reminder: Staff Wellbeing Survey closes July 3, 2026',
    body_text: 'Hello Emery,\n\nPlease complete Staff Wellbeing Survey before July 3, 2026.\n\nThank you.',
    body_html: '',
    state: 'delivered',
    created: '2026-06-30T10:00:00',
    sent_at: '2026-06-30T10:00:01',
    history: [
      {
        status_id: COMMUNICATIONS_IDS.statuses.newSendQueued,
        message_id: COMMUNICATIONS_IDS.messages.newSend,
        status: 'queued',
        detail: '',
        mailpit_id: '',
        recorded_at: '2026-06-30T10:00:00',
      },
      {
        status_id: COMMUNICATIONS_IDS.statuses.newSendSent,
        message_id: COMMUNICATIONS_IDS.messages.newSend,
        status: 'sent',
        detail: '',
        mailpit_id: '',
        recorded_at: '2026-06-30T10:00:01',
      },
      {
        status_id: COMMUNICATIONS_IDS.statuses.newSendDelivered,
        message_id: COMMUNICATIONS_IDS.messages.newSend,
        status: 'delivered',
        detail: '',
        mailpit_id: MAILPIT_IDS.newSend,
        recorded_at: '2026-06-30T10:00:02',
      },
    ],
  },
};

export const communicationsAnswers = {
  [routeKey('GET', 'communications', '/v1/templates')]: { status: 200, body: templateListAnswer },
  [routeKey('POST', 'communications', '/v1/templates')]: { status: 200, body: savedTemplateAnswer },
  [routeKey('GET', 'communications', '/v1/messages')]: { status: 200, body: messageListAnswer },
  [routeKey('POST', 'communications', '/v1/messages')]: { status: 200, body: sendAnswer },
  [routeKey('GET', 'communications', `/v1/messages/${COMMUNICATIONS_IDS.messages.delivered}`)]: {
    status: 200,
    body: messageDetailAnswer,
  },
} satisfies FakeRouteTable;
