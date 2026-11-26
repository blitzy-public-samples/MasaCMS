/** Admin CSRF continuity over the composed app: identity consumes a token only where legacy validates, for legacy's context; legacy's bypasses consume none. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { IDENTITY_SERVICE, type CsrfConsumeRequest } from '@opt2/platform/service-kit';
import { TENANT_A, type InjectResponse } from '@opt2/platform/testing';
import { buildTestApp, createRecordingDb, type RecordingDb, type TestApp } from '../helpers/app.js';
import { IDS, contentSeed } from '../helpers/seed.js';
import { SUBJECT_USER_IDS, contentHeaders, subjectSessionId } from '../helpers/tokens.js';

type Row = Record<string, unknown>;
type Form = Record<string, string>;

interface CsrfDeclaration {
  validation: 'validates' | 'bypassed' | 'none';
  context?: string;
}

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { 'x-opt2-legacy-actions'?: string[]; 'x-opt2-csrf'?: CsrfDeclaration }>>;
  'x-opt2-excluded': Array<{ key: string; reason: string }>;
};

const SITE = TENANT_A.siteId;
const TOKEN_VALUE = 'T0KEN';
const EXPIRES_VALUE = '260630235959000';
const TOKEN = { [CSRF_FIELD_TOKEN]: TOKEN_VALUE, [CSRF_FIELD_EXPIRES]: EXPIRES_VALUE };
const { content: C, hist: H } = IDS;

// ---- the seed as keyed tables ----

/** Index of the first `needle` at parenthesis depth 0 from `from`, outside quotes; -1 when absent. */
function topLevel(sql: string, needle: string, from = 0): number {
  let depth = 0;
  let quoted = false;
  for (let i = from; i < sql.length; i += 1) {
    const ch = sql.charAt(i);
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && sql.startsWith(needle, i)) return i;
  }
  return -1;
}

/** `text` split at commas outside parentheses and quotes, each part trimmed. */
function items(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let at = topLevel(text, ','); at >= 0; at = topLevel(text, ',', start)) {
    parts.push(text.slice(start, at).trim());
    start = at + 1;
  }
  return [...parts, text.slice(start).trim()];
}

/** A value as SQL Server's case-insensitive, trailing-space-blind `char` comparison sees it. */
const fold = (value: unknown): string => String(value).trimEnd().toLowerCase();

/** `clause` with each parenthesised group holding an OR or a subquery read as TRUE. */
function opaque(clause: string): string {
  let out = '';
  for (let i = 0; i < clause.length; i += 1) {
    if (clause.charAt(i) !== '(') {
      out += clause.charAt(i);
      continue;
    }
    let depth = 0;
    let end = i;
    for (; end < clause.length; end += 1) {
      if (clause.charAt(end) === '(') depth += 1;
      if (clause.charAt(end) === ')' && (depth -= 1) === 0) break;
    }
    const inner = clause.slice(i + 1, end);
    if (inner.startsWith('SELECT ') || topLevel(inner, ' OR ') >= 0) {
      out += 'TRUE';
      i = end;
    } else out += '(';
  }
  return out;
}

/** The rows a WHERE clause keeps: its `col = $n`, `= ANY($n)`, `lower(rtrim(col))`, COLLATE, `= <int>` and `IS NULL` terms on `alias`, ANDed. */
function whereFilter(text: string, params: readonly unknown[], alias: string | undefined): (row: Row) => boolean {
  if (topLevel(text, ' OR ') >= 0) return () => true;
  const clause = opaque(text);
  const terms: Array<(row: Row) => boolean> = [];
  const bound = (index: string | undefined): string[] => [params[Number(index) - 1]].flat().map(fold);
  const term = (prefix: string | undefined, column: string | undefined, test: (value: unknown) => boolean): void => {
    if (column !== undefined && (prefix === undefined || prefix === alias)) terms.push((row) => !(column in row) || test(row[column]));
  };
  const among = (index: string | undefined) => (value: unknown): boolean => value !== null && value !== undefined && bound(index).includes(fold(value));
  for (const m of clause.matchAll(/(?:(\w+)\.)?"?(\w+)"?(?:::\w+)? = (?:ANY\()?\$(\d+)/g)) term(m[1], m[2], among(m[3]));
  for (const m of clause.matchAll(/\(\((?:(\w+)\.)?(\w+)::\w+\) COLLATE "\w+"\."\w+"\) = (?:ANY\()?\$(\d+)/g)) term(m[1], m[2], among(m[3]));
  for (const m of clause.matchAll(/lower\(rtrim\((?:(\w+)\.)?(\w+)\)\) = lower\(rtrim\(\$(\d+)/g)) term(m[1], m[2], among(m[3]));
  for (const m of clause.matchAll(/(?:(\w+)\.)?"?(\w+)"? = (-?\d+)(?![\w$.])/g)) term(m[1], m[2], (value) => value !== null && value !== undefined && fold(value) === m[3]);
  for (const m of clause.matchAll(/(?:(\w+)\.)?"?(\w+)"? IS NULL/g)) term(m[1], m[2], (value) => value === null || value === undefined);
  return (row) => terms.every((test) => test(row));
}

/** `rows` through a select list: `*`, `[alias.]col [AS name]` (other aliases' columns NULL) or a lone `count(…) AS name`. */
function projectRows(list: string, rows: Row[], alias: string | undefined): Row[] {
  const parts = items(list.replace(/^DISTINCT /i, ''));
  if (parts.length === 1 && /^(?:\w+\.)?\*$/.test(parts[0] ?? '')) return rows;
  const counted = parts.length === 1 ? /^count\([^)]*\)(?:::\w+)? AS "?(\w+)"?$/i.exec(parts[0] ?? '') : null;
  if (counted?.[1] !== undefined) return [{ [counted[1]]: rows.length }];
  const projected = rows.map((row) =>
    Object.fromEntries(
      parts.flatMap((part): Array<[string, unknown]> => {
        const column = /^(?:(\w+)\.)?"?(\w+)"?(?: AS "?(\w+)"?)?$/i.exec(part);
        const name = column?.[2];
        if (column !== null && name !== undefined) return [[column[3] ?? name, column[1] === undefined || column[1] === alias ? (row[name] ?? null) : null]];
        const named = / AS "?(\w+)"?$/i.exec(part)?.[1];
        return named === undefined ? [] : [[named, null]];
      }),
    ),
  );
  return /^DISTINCT /i.test(list) ? [...new Map(projected.map((row) => [JSON.stringify(row), row])).values()] : projected;
}

/** The clause after the first top-level `keyword` from `from`, up to its ORDER BY, GROUP BY, LIMIT, FOR or RETURNING. */
function clauseAfter(sql: string, keyword: string, from: number): string {
  const at = topLevel(sql, keyword, from);
  if (at < 0) return '';
  const start = at + keyword.length;
  const ends = [' ORDER BY ', ' GROUP BY ', ' LIMIT ', ' FOR ', ' RETURNING '].map((end) => topLevel(sql, end, start)).filter((i) => i >= 0);
  return sql.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}

/** `row` as `RETURNING *` answers it: a column the statement never set reads as NULL, as the canonical encoder needs every column. */
function withDefaults(row: Row): Row {
  return new Proxy(row, { has: () => true, get: (target, key) => (typeof key === 'string' ? (target[key] ?? null) : undefined) });
}

/** One VALUES or SET expression: a `$n` parameter, a number or a quoted literal; NULL for anything else. */
function valueOf(expression: string, params: readonly unknown[]): unknown {
  const m = /^(?:\$(\d+)(?:::[\w[\]]+)?|(-?\d+(?:\.\d+)?)|'((?:[^']|'')*)')$/.exec(expression.trim());
  if (m === null) return null;
  if (m[1] !== undefined) return params[Number(m[1]) - 1] ?? null;
  if (m[2] !== undefined) return Number(m[2]);
  return (m[3] ?? '').replace(/''/g, "'");
}

/** Tables the recording pool's own rules answer: gates, changelog, inbox and the staged-object ledger. */
const PLATFORM_TABLES = 'unit_gate|changelog|inbox|outbox|staged_object';
const STATEMENT_HEAD = /^(SELECT (.+?) FROM|UPDATE|DELETE FROM|INSERT INTO) "content"\."(\w+)"(?: (?!WHERE|LEFT|JOIN|ORDER|LIMIT|FOR|SET|AS|VALUES)(\w+))?/;

/**
 * Answers every SELECT, INSERT, UPDATE and DELETE of a `content` table from in-memory rows of the shared seed, plus `extra`,
 * in the statement's tenant. seedRecordingDb answers each read with all of a table's rows whatever its WHERE, so write
 * branches would walk crumbs forever or change the wrong row; these tables answer the same seed by key instead.
 */
function seedTables(target: RecordingDb, extra: Readonly<Record<string, readonly Row[]>> = {}): void {
  const tables = new Map<string, Row[]>();
  const tableOf = (name: string): Row[] => {
    const rows = tables.get(name) ?? [];
    tables.set(name, rows);
    return rows;
  };
  const store = (name: string, row: Row): Row => {
    const rows = tableOf(name);
    // tcontent_id is the content table's identity column, numbered as PostgreSQL would.
    const stored = name === 'content' ? { ...row, tcontent_id: Math.max(0, ...rows.map((r) => Number(r.tcontent_id))) + 1 } : { ...row };
    rows.push(stored);
    return stored;
  };
  for (const { rows } of contentSeed()) {
    for (const { table, row } of rows) if (table.key !== null) store(table.table.replace(/^content\./, ''), row);
  }
  for (const [name, rows] of Object.entries(extra)) for (const row of rows) store(name, row);

  target.respond(new RegExp(`^(?:SELECT|UPDATE|DELETE|INSERT)\\b.*?"content"\\."(?!(?:${PLATFORM_TABLES})")\\w+"`), (params, sql, ctx) => {
    const head = STATEMENT_HEAD.exec(sql);
    if (head === null || ctx.tenantId === null || new RegExp(`^(?:${PLATFORM_TABLES})$`).test(head[3] ?? '')) return [];
    const [, verb, list = '', name = '', alias] = head;
    const rows = tableOf(name);
    const returning = (out: Row[]): Row[] => {
      const listed = / RETURNING (.+)$/.exec(sql)?.[1];
      return listed === undefined ? out : projectRows(listed, out.map(withDefaults), alias);
    };
    if (verb === 'INSERT INTO') {
      const insert = /^INSERT INTO \S+ \(([^)]*)\) VALUES (.+?)(?: ON CONFLICT .*?)?(?: RETURNING .+)?$/.exec(sql);
      if (insert === null) return [];
      const columns = items(insert[1] ?? '').map((column) => column.replace(/"/g, ''));
      return returning(
        items(insert[2] ?? '').map((tuple) => {
          const values = items(tuple.replace(/^\(|\)$/g, ''));
          return store(name, Object.fromEntries(columns.map((column, i) => [column, valueOf(values[i] ?? 'NULL', params)])));
        }),
      );
    }
    if (/ FROM /.test(list) || topLevel(sql, ' GROUP BY ') >= 0) return [];
    const keep = whereFilter(clauseAfter(sql, ' WHERE ', head[0].length), params, alias);
    const tenant = fold(ctx.tenantId);
    const matched = rows.filter((row) => fold(row.tenant_id) === tenant && keep(row));
    if (verb === 'UPDATE') {
      for (const part of items(clauseAfter(sql, ' SET ', head[0].length))) {
        const assigned = /^"?(\w+)"? = (.+)$/.exec(part);
        const column = assigned?.[1];
        if (column !== undefined) for (const row of matched) row[column] = valueOf(assigned?.[2] ?? '', params);
      }
      return returning(matched.map((row) => ({ ...row })));
    }
    if (verb === 'DELETE FROM') {
      for (const row of matched) rows.splice(rows.indexOf(row), 1);
      return returning(matched);
    }
    const page = / LIMIT (\d+|\$\d+)(?: OFFSET (\d+|\$\d+))?(?: FOR .*)?$/.exec(sql);
    const number = (text: string | undefined): number => (text === undefined ? 0 : Number(text.startsWith('$') ? params[Number(text.slice(1)) - 1] : text));
    const paged = page === null ? matched : matched.slice(number(page[2]), number(page[2]) + number(page[1]));
    return projectRows(list, paged.map(withDefaults), alias);
  });
}

// ---- requests ----

/** What a case expects of an answer: its status, `Location` and JSON or text body. */
interface Outcome {
  status: number;
  location?: string;
  body: unknown;
}

let t: TestApp;
let db: RecordingDb;

/** The request URL of a contract path: `{siteid}` as tenant-a, other segments from `params`, raw entries with `?siteid=`. */
function urlOf(path: string, params: Readonly<Record<string, string>> = {}): string {
  const filled = path.replace(/\{(\w+)\}/g, (_match, name: string) => (name === 'siteid' ? SITE : (params[name] ?? '')));
  return path.startsWith('/v1/raw/') ? `${filled}?siteid=${SITE}` : filled;
}

/** Posts `form` URL-encoded with the token pair as the tenant-a S2. */
async function send(url: string, form: Form): Promise<InjectResponse> {
  const headers = await contentHeaders('s2', { site: SITE });
  const payload = new URLSearchParams({ ...form, ...TOKEN }).toString();
  return t.app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload });
}

/** The answer as an {@link Outcome}. */
function view(res: InjectResponse): Outcome {
  const location = res.headers.location;
  const json = String(res.headers['content-type'] ?? '').includes('json');
  return { status: res.statusCode, location: typeof location === 'string' ? location : undefined, body: json ? JSON.parse(res.body) : res.body };
}

/** The consume call identity receives for `context` with the submitted pair, in the S2's session. */
const consumeOf = (context: string): CsrfConsumeRequest => ({ sessionId: subjectSessionId('s2'), token: TOKEN_VALUE, expires: EXPIRES_VALUE, context });

/** Whether the request ran a write `pattern` matches. */
const written = (pattern: RegExp): boolean => db.writes().some((statement) => pattern.test(statement.sql));

const writeOf = (verb: 'INSERT INTO' | 'UPDATE' | 'DELETE FROM', table: string): RegExp => new RegExp(`^${verb} "content"\\."${table}" `);

/** An admin write answer: saved flag, no errors and the FW/1 redirect. */
const adminWrite = (saved: boolean, redirect: unknown, data?: Row): Outcome => ({ status: 200, body: { saved, errors: {}, redirect, ...(data === undefined ? {} : { data }) } });

const redirectTo = (circuit: string, action: string, params: Array<[string, string]>) => ({ circuit, action, params });

/** A content_stats row of `contentid` locked by the S2. */
const lockOf = (contentid: string, locktype: 'file' | 'node'): Row => ({
  tenant_id: TENANT_A.tenantId,
  contentid,
  siteid: SITE,
  views: 0,
  rating: 0,
  totalvotes: 0,
  upvotes: 0,
  downvotes: 0,
  comments: 0,
  disablecomments: 0,
  majorversion: 0,
  minorversion: 0,
  lockid: SUBJECT_USER_IDS.s2,
  locktype,
});

const EMPTY: Outcome = { status: 200, body: '' };
const CHAIN_LIST = redirectTo('cchain', 'list', [['siteid', SITE]]);
const changesetRedirect = (action: string, changesetId: string, keywords = false) =>
  redirectTo('cChangesets', action, [['changesetID', changesetId], ['siteID', SITE], ...(keywords ? ([['keywords', '']] as Array<[string, string]>) : [])]);

/** One action branch where legacy calls `validateCSRFTokens`. */
interface ValidatingCase {
  /** Legacy action and branch. */
  action: string;
  /** Contract path. */
  path: string;
  params?: Readonly<Record<string, string>>;
  form: Form;
  /** The `validateCSRFTokens(context=…)` expression the contract declares. */
  declared: string;
  /** That expression over the seeded ids. */
  context: string;
  /** The write a valid token lets through. */
  writes: RegExp;
  /** Rows the branch needs beyond the seed. */
  rows?: Readonly<Record<string, readonly Row[]>>;
  accepted: Outcome;
  refused: Outcome;
}

const VALIDATING: readonly ValidatingCase[] = [
  {
    action: 'carch.saveQuickEdit',
    path: '/v1/raw/carch/savequickedit',
    form: { contentid: C.pageOne, attribute: 'isnav', isnav: '0' },
    declared: 'rc.contentid & "quickedit"',
    context: `${C.pageOne}quickedit`,
    writes: writeOf('INSERT INTO', 'content'),
    accepted: EMPTY,
    refused: EMPTY,
  },
  {
    action: 'carch.lockFile',
    path: '/v1/raw/carch/lockfile',
    form: { contentid: C.fileNode },
    declared: 'rc.contentid & "lockfile"',
    context: `${C.fileNode}lockfile`,
    writes: writeOf('INSERT INTO', 'content_stats'),
    accepted: { status: 302, location: `/index.cfm/_api/render/file/?fileid=${IDS.files.pdf}&method=attachment`, body: '' },
    refused: EMPTY,
  },
  {
    action: 'carch.unlockFile',
    path: '/v1/raw/carch/unlockfile',
    form: { contentid: C.fileNode },
    declared: 'rc.contentid & "unlockfile"',
    context: `${C.fileNode}unlockfile`,
    writes: writeOf('UPDATE', 'content_stats'),
    rows: { content_stats: [lockOf(C.fileNode, 'file')] },
    accepted: EMPTY,
    refused: EMPTY,
  },
  {
    action: 'carch.unlockNode',
    path: '/v1/raw/carch/unlocknode',
    form: { contentid: C.pageOne },
    declared: 'rc.contentid & "unlocknode"',
    context: `${C.pageOne}unlocknode`,
    writes: writeOf('UPDATE', 'content_stats'),
    rows: { content_stats: [lockOf(C.pageOne, 'node')] },
    accepted: EMPTY,
    refused: EMPTY,
  },
  {
    action: 'carch.datamanager{action=Delete}',
    path: '/v1/sites/{siteid}/forms/{contentid}/responses/delete',
    params: { contentid: C.formNode },
    form: { action: 'Delete', responseid: IDS.forms.responseOne },
    declared: 'rc.responseid',
    context: IDS.forms.responseOne,
    writes: writeOf('DELETE FROM', 'form_response_packet'),
    accepted: { status: 200, body: expect.objectContaining({ saved: true, data: expect.objectContaining({ outcome: 'deleted' }) }) },
    refused: { status: 200, body: expect.objectContaining({ saved: false, data: expect.objectContaining({ outcome: 'none' }) }) },
  },
  {
    action: 'ccategory.update',
    path: '/v1/sites/{siteid}/categories',
    form: { action: 'update', categoryid: IDS.categories.pooledParent, name: 'Topics' },
    declared: 'rc.categoryid',
    context: IDS.categories.pooledParent,
    writes: writeOf('UPDATE', 'category'),
    accepted: adminWrite(true, redirectTo('cCategory', 'list', [['siteid', SITE]])),
    refused: adminWrite(false, null, { rc: {} }),
  },
  {
    action: 'cfeed.update',
    path: '/v1/raw/cfeed/update',
    form: { action: 'update', feedid: IDS.feeds.local, name: 'Latest News' },
    declared: 'rc.feedid',
    context: IDS.feeds.local,
    writes: writeOf('UPDATE', 'feed'),
    accepted: { status: 302, location: `./?muraAction=cFeed.list&siteid=${SITE}`, body: '' },
    refused: { status: 302, location: `./?muraAction=cFeed.list&siteid=${SITE}`, body: '' },
  },
  {
    action: 'cchain.save',
    path: '/v1/sites/{siteid}/approval-chains',
    form: { chainid: IDS.approval.chain, name: 'Content Approval' },
    declared: 'rc.chainid',
    context: IDS.approval.chain,
    writes: writeOf('UPDATE', 'approval_chain'),
    accepted: adminWrite(true, CHAIN_LIST),
    refused: adminWrite(false, CHAIN_LIST),
  },
  {
    action: 'cchain.delete',
    path: '/v1/sites/{siteid}/approval-chains/{chainid}/delete',
    params: { chainid: IDS.approval.chain },
    form: {},
    declared: 'rc.chainid',
    context: IDS.approval.chain,
    writes: writeOf('DELETE FROM', 'approval_chain'),
    accepted: adminWrite(true, CHAIN_LIST),
    refused: adminWrite(false, CHAIN_LIST),
  },
  {
    action: 'cchangesets.save',
    path: '/v1/sites/{siteid}/changesets',
    form: { changesetID: IDS.changesets.scheduledFuture, name: 'Future Release' },
    declared: 'rc.changesetid',
    context: IDS.changesets.scheduledFuture,
    writes: writeOf('UPDATE', 'changeset'),
    accepted: adminWrite(true, changesetRedirect('list', IDS.changesets.scheduledFuture)),
    refused: adminWrite(false, null, { rc: {} }),
  },
  {
    action: 'cchangesets.delete',
    path: '/v1/sites/{siteid}/changesets/{changesetid}/delete',
    params: { changesetid: IDS.changesets.scheduledFuture },
    form: {},
    declared: 'rc.changesetid',
    context: IDS.changesets.scheduledFuture,
    writes: writeOf('DELETE FROM', 'changeset'),
    accepted: adminWrite(true, changesetRedirect('list', IDS.changesets.scheduledFuture)),
    refused: adminWrite(false, changesetRedirect('list', IDS.changesets.scheduledFuture)),
  },
  {
    action: 'cchangesets.rollback',
    path: '/v1/sites/{siteid}/changesets/{changesetid}/rollback',
    params: { changesetid: IDS.changesets.scheduledFuture },
    form: {},
    declared: 'rc.changesetid',
    context: IDS.changesets.scheduledFuture,
    writes: writeOf('UPDATE', 'changeset'),
    accepted: adminWrite(true, changesetRedirect('edit', IDS.changesets.scheduledFuture)),
    refused: adminWrite(false, changesetRedirect('edit', IDS.changesets.scheduledFuture)),
  },
  {
    action: 'cchangesets.removeitem',
    path: '/v1/sites/{siteid}/changesets/{changesetid}/items/{contenthistid}/remove',
    params: { changesetid: IDS.changesets.scheduledDue, contenthistid: H.pageOneDraft },
    form: { contenthistid: H.pageOneDraft },
    declared: 'rc.changesetid',
    context: IDS.changesets.scheduledDue,
    writes: writeOf('UPDATE', 'content'),
    accepted: adminWrite(true, changesetRedirect('assignments', IDS.changesets.scheduledDue, true)),
    refused: adminWrite(false, changesetRedirect('assignments', IDS.changesets.scheduledDue, true)),
  },
];

/** One ccomments action: ccomments.cfc validates no token in any of them. */
interface CommentCase {
  action: string;
  path: string;
  params?: Readonly<Record<string, string>>;
  form: Form;
  writes: RegExp;
  answer: Outcome;
}

const COMMENT_DEFAULT = adminWrite(true, redirectTo('cComments', 'default', []));
const COMMENT_ACTIONS: readonly CommentCase[] = [
  { action: 'ccomments.approve', path: '/v1/sites/{siteid}/comments/{commentid}/approve', params: { commentid: IDS.comments.unapproved }, form: {}, writes: writeOf('UPDATE', 'comment'), answer: COMMENT_DEFAULT },
  { action: 'ccomments.unapprove', path: '/v1/sites/{siteid}/comments/{commentid}/unapprove', params: { commentid: IDS.comments.approved }, form: {}, writes: writeOf('UPDATE', 'comment'), answer: COMMENT_DEFAULT },
  { action: 'ccomments.delete', path: '/v1/sites/{siteid}/comments/{commentid}/delete', params: { commentid: IDS.comments.approved }, form: {}, writes: writeOf('UPDATE', 'comment'), answer: COMMENT_DEFAULT },
  { action: 'ccomments.markAsSpam', path: '/v1/sites/{siteid}/comments/{commentid}/spam', params: { commentid: IDS.comments.approved }, form: {}, writes: writeOf('UPDATE', 'comment'), answer: COMMENT_DEFAULT },
  { action: 'ccomments.purgeDeletedComments', path: '/v1/sites/{siteid}/comments/purge-deleted', form: {}, writes: writeOf('DELETE FROM', 'comment'), answer: COMMENT_DEFAULT },
  {
    action: 'ccomments.bulkEdit',
    path: '/v1/sites/{siteid}/comments/bulk',
    form: { bulkedit: 'approve', ckupdate: IDS.comments.unapproved },
    writes: writeOf('UPDATE', 'comment'),
    answer: adminWrite(true, null, { processed: true }),
  },
  {
    action: 'ccomments.singleEdit',
    path: '/v1/sites/{siteid}/comments/{commentid}',
    params: { commentid: IDS.comments.unapproved },
    form: { updateAction: 'approve' },
    writes: writeOf('UPDATE', 'comment'),
    answer: adminWrite(true, null),
  },
];

const APPROVAL_PATH = '/v1/raw/carch/approvalaction';
const CIRCUITS: ReadonlySet<string> = new Set(['carch', 'cchangesets', 'ccomments', 'ccategory', 'cfeed', 'cchain']);

/** The contract's CSRF declaration of each path these circuits serve. */
const DECLARED: ReadonlyMap<string, CsrfDeclaration> = new Map(
  Object.entries(OPENAPI.paths).flatMap(([path, item]) =>
    Object.values(item).flatMap((op): Array<[string, CsrfDeclaration]> => {
      const circuit = op['x-opt2-legacy-actions']?.[0]?.split('.')[0];
      const csrf = op['x-opt2-csrf'];
      return circuit !== undefined && CIRCUITS.has(circuit) && csrf !== undefined ? [[path, csrf]] : [];
    }),
  ),
);

beforeAll(async () => {
  db = createRecordingDb();
  t = await buildTestApp({
    db,
    env: { LOG_LEVEL: 'error' },
    clientHandlers: {
      [IDENTITY_SERVICE]: {
        'GET /v1/sessions/current/admin-state': () => ({ status: 200, headers: {}, body: {} }),
      },
    },
  });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  db.reset();
  t.client.clear();
  t.client.csrfValid = true;
});

describe('contract', () => {
  it('declares validation on exactly the validating paths, each with the legacy context expression of its branch', () => {
    const validating = [...DECLARED].filter(([, csrf]) => csrf.validation === 'validates').map(([path]) => path);
    expect([...new Set(VALIDATING.map(({ path }) => path))].sort()).toEqual(validating.sort());
    for (const row of VALIDATING) expect(DECLARED.get(row.path)?.context?.split(' | '), row.action).toContain(row.declared);
  });

  it('declares the approval short-circuit bypassed and every comment action without validation', () => {
    expect(DECLARED.get(APPROVAL_PATH)).toEqual({ validation: 'bypassed', context: 'approvalaction' });
    for (const row of COMMENT_ACTIONS) expect(DECLARED.get(row.path), row.action).toEqual({ validation: 'none' });
  });
});

describe('validating actions', () => {
  it.each(VALIDATING)('$action has identity consume the submitted pair once for its legacy context, then writes', async (row) => {
    seedTables(db, row.rows);
    const res = await send(urlOf(row.path, row.params), row.form);
    expect(view(res)).toEqual(row.accepted);
    expect(t.client.csrfConsumes).toEqual([consumeOf(row.context)]);
    expect(written(row.writes)).toBe(true);
  });

  it.each(VALIDATING)('$action writes nothing when identity refuses the token, and answers as legacy continues', async (row) => {
    t.client.csrfValid = false;
    seedTables(db, row.rows);
    const res = await send(urlOf(row.path, row.params), row.form);
    expect(view(res)).toEqual(row.refused);
    expect(t.client.csrfConsumes).toEqual([consumeOf(row.context)]);
    expect(db.writes()).toEqual([]);
  });
});

describe('reproduced bypasses', () => {
  it('carch.approvalaction consumes no token (`true or validateCSRFTokens`), records the approval, answers {contenthistid, previewurl} and leaves the token usable', async () => {
    seedTables(db);
    const res = await send(urlOf(APPROVAL_PATH), { requestID: IDS.approval.request, action: 'approve', comment: 'Approved' });
    expect(view(res)).toEqual({ status: 200, body: { contenthistid: H.sectionDraft, previewurl: `/section/?previewid=${H.sectionDraft}` } });
    expect(t.client.csrfConsumes).toEqual([]);
    expect(written(writeOf('INSERT INTO', 'approval_action'))).toBe(true);
    const next = await send(urlOf('/v1/sites/{siteid}/approval-chains'), { chainid: IDS.approval.chain, name: 'Content Approval' });
    expect(view(next)).toEqual(adminWrite(true, CHAIN_LIST));
    expect(t.client.csrfConsumes).toEqual([consumeOf(IDS.approval.chain)]);
  });

  it('cchangesets.publish, which checks no token in legacy, is withheld: no target route serves it and nothing is consumed or read', async () => {
    // publish writes the decision-list table tcontenteventreminders, so it stays on legacy with legacy's missing check.
    expect(OPENAPI['x-opt2-excluded'].map(({ key }) => key)).toContain('admin:cchangesets.publish');
    const res = await send(`/v1/sites/${SITE}/changesets/${IDS.changesets.scheduledDue}/publish`, { changesetID: IDS.changesets.scheduledDue });
    expect(res.statusCode).toBe(404);
    expect([t.client.csrfConsumes, db.statements]).toEqual([[], []]);
  });

  it.each<{ key: string; method: 'GET' | 'POST'; url: string; form: Form }>([
    { key: 'admin:carch.update', method: 'GET', url: urlOf('/v1/raw/carch/update'), form: { contentid: C.pageTwo, topid: C.root, action: 'deleteall' } },
    {
      key: 'admin:carch.update',
      method: 'POST',
      url: urlOf('/v1/raw/carch/update'),
      form: { contentid: C.pageTwo, contenthistid: H.pageTwoActive, parentid: C.section, type: 'Page', title: 'Page Two', action: 'add', approved: '0' },
    },
    {
      key: 'admin:carch.updateobjectparams',
      method: 'POST',
      url: `/v1/sites/${SITE}/content/versions/${H.pageOneActive}/object-params`,
      form: { contenthistid: H.pageOneActive, approved: '1', regionid: '2', object: 'text', objectid: 'obj1', name: 'Box', params: '{"a":1}' },
    },
  ])('$key is withheld: no target $method route serves it and nothing is consumed or read', async ({ key, method, url, form }) => {
    expect(OPENAPI['x-opt2-excluded'].map((entry) => entry.key)).toContain(key);
    const res =
      method === 'POST'
        ? await send(url, form)
        : await t.app.inject({ method, url: `${url}&${new URLSearchParams({ ...form, ...TOKEN }).toString()}`, headers: await contentHeaders('s2', { site: SITE }) });
    expect(res.statusCode).toBe(404);
    expect([t.client.csrfConsumes, db.statements]).toEqual([[], []]);
  });

  it.each(COMMENT_ACTIONS)('$action consumes no token and writes, as ccomments.cfc validates none', async (row) => {
    seedTables(db);
    const res = await send(urlOf(row.path, row.params), row.form);
    expect(view(res)).toEqual(row.answer);
    expect(t.client.csrfConsumes).toEqual([]);
    expect(written(row.writes)).toBe(true);
  });
});
