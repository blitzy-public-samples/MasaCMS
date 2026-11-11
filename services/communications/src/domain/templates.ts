// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Template store as the fixture `communications.cfc` answers it: create with the fixture's checks, and the paged site list. */
import { LegacyApiError, javaTrim } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { fixturePage, type FixtureListResult } from '../legacy/fixture-envelope.js';
import * as queries from '../repo/queries.js';
import type { MessageTemplateRow } from '../repo/tables.js';
import type { DomainDeps } from './delivery.js';

/** Create-template params under the fixture's names, read ignoring case as CFML struct keys resolve; values as received. */
export interface TemplateInput {
  name?: unknown;
  subject?: unknown;
  bodyText?: unknown;
  bodyHtml?: unknown;
  [param: string]: unknown;
}

/**
 * Template-list filters: `siteId` is the token's `site`, set by the route; `pageIndex` (default 1) and
 * `itemsPerPage` (default 50, at most 1000) are the raw request params, read ignoring case.
 */
export interface TemplateFilters {
  siteId: string;
  pageIndex?: unknown;
  itemsPerPage?: unknown;
  [param: string]: unknown;
}

/** One page of the site's templates as envelope.cfc queryPage() returns it; the route renders it as `fixtureList`'s `listResult`. */
export interface TemplatePage extends FixtureListResult {
  list: MessageTemplateRow[];
  totalItems: number;
}

// The synthetic.message_template column sizes, which the fixture checks before its insert.
const MAX_NAME_LENGTH = 100;
const MAX_SUBJECT_LENGTH = 255;

/** The param under `name` ignoring case; a later key differing only in case wins, as it overwrites in a CFML struct. */
function param(params: Readonly<Record<string, unknown>>, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).findLast((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

/** The fixture's textParam(): '' when absent or null, a simple value as text; objects and arrays answer `invalidParameters`. */
function textParam(params: Readonly<Record<string, unknown>>, name: string): string {
  const value = param(params, name) ?? '';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new LegacyApiError('invalidParameters');
  }
  return String(value);
}

/** Stores a template of `siteId` (the token's `site`) after the fixture's checks; returns the row or throws `invalidParameters`. */
export async function createTemplate(
  tx: TenantTx,
  deps: Pick<DomainDeps, 'repository' | 'clock'>,
  args: { siteId: string; userId: string; input: TemplateInput; context?: WriteContext },
): Promise<MessageTemplateRow> {
  const name = textParam(args.input, 'name');
  const subject = textParam(args.input, 'subject');
  const bodyText = textParam(args.input, 'bodyText');
  const bodyHtml = textParam(args.input, 'bodyHtml');
  const blank = javaTrim(name) === '' || javaTrim(subject) === '' || (bodyText === '' && bodyHtml === '');
  if (blank || name.length > MAX_NAME_LENGTH || subject.length > MAX_SUBJECT_LENGTH) {
    throw new LegacyApiError('invalidParameters');
  }
  // insertTemplate assigns the CF UUID and `created` = `lastupdate` from its clock. The table has no author column,
  // so `userId` (the token's `sub`) is recorded as the changelog actor; a caller context overrides it.
  return deps.repository.insertTemplate(
    tx,
    { siteId: args.siteId, name, subject, bodyText, bodyHtml },
    { actorUserId: args.userId, ...args.context },
  );
}

/** One page of the site's templates by `created`, then `template_id`, after validating paging as envelope.cfc page() does. */
export async function listTemplates(tx: TenantTx, filters: TemplateFilters): Promise<TemplatePage> {
  const { pageIndex, itemsPerPage } = fixturePage(filters);
  const page = await queries.listTemplates(tx, { siteId: filters.siteId, pageIndex, itemsPerPage });
  return { list: page.items, pageIndex, itemsPerPage, totalItems: page.total };
}
