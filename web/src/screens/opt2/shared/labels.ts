// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Admin-bundle label `key`, unencoded as legacy writes `rbKey` output. */
export function bundleLabel(rb: RbLookup, key: string): SafeHtml {
  return raw(rb.rbKey(key));
}

/** Admin-bundle key of each reusable OPT-2 label, named by its exact en value. */
export const OPT2_LABEL_KEYS = Object.freeze({
  Action: 'approvalchains.action',
  Actions: 'sitemanager.content.actions',
  All: 'sitemanager.all',
  Answers: 'formbuilder.matrix.answers',
  Approve: 'approvalchains.approve',
  'Content Type': 'sitemanager.drafts.contenttype',
  Created: 'params.created',
  'Created By': 'sitemanager.content.createdby',
  Download: 'sitemanager.download',
  'Due Date': 'sitemanager.duedate',
  File: 'sitemanager.content.type.file',
  Filter: 'email.filter',
  Format: 'email.format',
  From: 'params.from',
  Group: 'user.group',
  History: 'sitemanager.content.fields.history',
  Hours: 'user.hours',
  'Last Update': 'params.lastupdate',
  Name: 'user.name',
  Next: 'sitemanager.next',
  No: 'sitemanager.no',
  Queued: 'email.queued',
  Reject: 'approvalchains.reject',
  Save: 'email.save',
  Schedule: 'email.schedule',
  Sent: 'email.sent',
  Site: 'user.site',
  State: 'params.state',
  Status: 'email.status',
  Subject: 'email.subject',
  Submit: 'mailinglistmanager.submit',
  Template: 'sitemanager.template',
  Title: 'params.title',
  To: 'params.to',
  Version: 'sitemanager.version',
  'Version History': 'sitemanager.versionhistory',
  Yes: 'sitemanager.yes',
} as const);

/** Name of a catalogued OPT-2 label. */
export type Opt2LabelName = keyof typeof OPT2_LABEL_KEYS;

/** Catalogued label `name` in the session locale of `ctx` (a ScreenContext or anything carrying its `rb`). */
export function opt2Label(ctx: { readonly rb: RbLookup }, name: Opt2LabelName): SafeHtml {
  return bundleLabel(ctx.rb, OPT2_LABEL_KEYS[name]);
}
