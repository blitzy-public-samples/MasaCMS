// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Shared scaffolding of the finance suites: the app built for `app.inject` over an in-memory `finance` schema, local storage and test credentials. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN } from '@opt2/platform/legacy-compat';
import { UNIT_GATE_TABLE, type GatePhase, type GateState } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  baseEnvSchema,
  loadEnv,
  type BaseEnv,
  type Clock,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import {
  isNonTenantTable,
  tenantDbFromPool,
  type Pool,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
} from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  authHeadersFor,
  businessClock,
  createCapturingPublisher,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type RoleSubject,
} from '@opt2/platform/testing';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import {
  NON_UNIT_TABLES,
  OWNED_TABLES,
  OWNER,
  PROGRAM_BINDING,
  SCHEMA,
  UNITS,
  type FinanceAttachmentRow,
  type FinanceRecordRow,
  type FinanceRecordVersionRow,
  type FinanceRollupRow,
  type ProgramBindingRow,
  type StagedObjectRow,
} from '../../src/repo/tables.js';

const STATE_DIR_PREFIX = 'opt2-finance-';
const STORAGE_HMAC_KEY_FILE = path.join('secrets', 'storage-hmac-key');

/** State directories testEnv created that no app has removed yet. */
const createdStateDirs = new Set<string>();
let exitCleanupRegistered = false;

/** Tracks `dir` for removal when the process exits or a signal ends it; buildTestApp removes its own directories when their app closes. */
function removeAtExit(dir: string): void {
  createdStateDirs.add(dir);
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  const removeAll = (): void => {
    for (const created of createdStateDirs) rmSync(created, { recursive: true, force: true });
    createdStateDirs.clear();
  };
  process.once('exit', removeAll);
  // A worker ended by SIGTERM or SIGINT skips 'exit'; the signal is raised again once the directories are gone.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      removeAll();
      process.kill(process.pid, signal);
    });
  }
}

function removeStateDir(dir: string): void {
  createdStateDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/** Writes the test signing keys and push key, plus a random storage HMAC key unless `stateDir` already holds one. */
async function prepareStateDir(stateDir: string): Promise<void> {
  await writeTestSecrets(stateDir);
  const keyFile = path.join(stateDir, STORAGE_HMAC_KEY_FILE);
  await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  // A kept key lets apps sharing one directory verify each other's signed URLs.
  await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  });
}

/** Parsed local-mode env for `buildApp`, secrets written to a fresh `os.tmpdir()` state dir unless `overrides` sets `OPT2_STATE_DIR`; an `undefined` override drops a variable. */
export async function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}): Promise<BaseEnv> {
  const ownStateDir = 'OPT2_STATE_DIR' in overrides ? undefined : mkdtempSync(path.join(tmpdir(), STATE_DIR_PREFIX));
  if (ownStateDir !== undefined) removeAtExit(ownStateDir);
  const raw: Record<string, string | undefined> = {
    PORT: '8119',
    OPT2_SERVICE_NAME: OWNER,
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    // Password mode requires every PG_* variable; with an injected db no pool ever connects with these.
    PG_HOST: process.env.PG_HOST || '127.0.0.1',
    PG_PORT: process.env.PG_PORT || '5432',
    PG_DATABASE: process.env.PG_DATABASE || 'opt2',
    PG_USER: process.env.PG_USER || 'finance_app',
    PG_PASSWORD: process.env.PG_PASSWORD || 'unused',
    GOOGLE_CLOUD_PROJECT: 'opt2-local',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    // Never fetched: testVerifier() verifies user tokens against the test key pair.
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_GATEWAY_URL: 'http://127.0.0.1:8100',
    OPT2_MIGRATION_URL: 'http://127.0.0.1:8102',
    OPT2_SERVICE_URLS: '{}',
    OPT2_STATE_DIR: ownStateDir,
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    TZ: process.env.TZ ?? 'UTC',
    ...overrides,
  };
  const env = loadEnv(baseEnvSchema, Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  await prepareStateDir(env.OPT2_STATE_DIR);
  return env;
}

/** Clock every suite shares: local `2026-06-30T12:00:00`, the seed's business date and the default `asOf`. */
export const TEST_CLOCK: Clock = businessClock();

/** A PostgreSQL error as node-pg raises it, with its SQLSTATE `code`. */
type PgError = Error & { code: string; severity: 'ERROR' };

function pgError(code: string, message: string, fields: Readonly<Record<string, string>> = {}): PgError {
  return Object.assign(new Error(message), { ...fields, code, severity: 'ERROR' as const });
}

/** SQL the recording database does not interpret; run() rethrows it with the statement text. */
class UnsupportedSqlError extends Error {
  override readonly name: string = 'UnsupportedSqlError';
}

function unsupported(what: string): never {
  throw new UnsupportedSqlError(what);
}

type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'param' | 'op';

/** One SQL token; a `word` is lower-cased, an `ident` keeps its quoted text. */
interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const OPERATORS = ['::', '<=', '>=', '<>', '!=', '&&', '||', '(', ')', ',', '.', ';', '=', '<', '>', '+', '-', '*', '/', '[', ']'] as const;
const TOKEN_PATTERNS: readonly (readonly [TokenKind | 'skip', RegExp])[] = [
  ['skip', /\s+|--[^\n]*/y],
  ['string', /'((?:[^']|'')*)'/y],
  ['ident', /"((?:[^"]|"")*)"/y],
  ['param', /\$(\d+)/y],
  ['word', /[A-Za-z_][A-Za-z0-9_$]*/y],
  ['number', /\d+(?:\.\d+)?/y],
];

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  scan: while (at < sql.length) {
    for (const [kind, pattern] of TOKEN_PATTERNS) {
      pattern.lastIndex = at;
      const match = pattern.exec(sql);
      if (match === null) continue;
      at = pattern.lastIndex;
      if (kind === 'string') tokens.push({ kind, text: (match[1] ?? '').replace(/''/g, "'") });
      else if (kind === 'ident') tokens.push({ kind, text: (match[1] ?? '').replace(/""/g, '"') });
      else if (kind === 'param') tokens.push({ kind, text: match[1] ?? '' });
      else if (kind === 'word') tokens.push({ kind, text: match[0].toLowerCase() });
      else if (kind === 'number') tokens.push({ kind, text: match[0] });
      continue scan;
    }
    const op = OPERATORS.find((candidate) => sql.startsWith(candidate, at));
    if (op === undefined) unsupported(`the character ${JSON.stringify(sql.charAt(at))}`);
    tokens.push({ kind: 'op', text: op });
    at += op.length;
  }
  return tokens;
}

type Expr =
  | { readonly k: 'col'; readonly table?: string; readonly name: string }
  | { readonly k: 'param'; readonly n: number }
  | { readonly k: 'lit'; readonly v: string | number | boolean | null | Decimal }
  | { readonly k: 'default' }
  | { readonly k: 'star' }
  | { readonly k: 'cast'; readonly e: Expr; readonly type: string }
  | { readonly k: 'collate'; readonly e: Expr }
  | FnExpr
  | { readonly k: 'not'; readonly e: Expr }
  | { readonly k: 'neg'; readonly e: Expr }
  | { readonly k: 'bin'; readonly op: string; readonly l: Expr; readonly r: Expr }
  | { readonly k: 'isnull'; readonly e: Expr; readonly not: boolean }
  | { readonly k: 'distinct'; readonly l: Expr; readonly r: Expr; readonly not: boolean }
  | { readonly k: 'any'; readonly op: string; readonly l: Expr; readonly r: Expr }
  | { readonly k: 'in'; readonly l: Expr; readonly list: readonly Expr[]; readonly not: boolean }
  | { readonly k: 'row'; readonly items: readonly Expr[] }
  | { readonly k: 'array'; readonly items: readonly Expr[] };

interface FnExpr {
  readonly k: 'fn';
  readonly name: string;
  readonly args: readonly Expr[];
  filter?: Expr;
}

type ColExpr = Extract<Expr, { k: 'col' }>;

type SelectItem = { readonly star: true } | { readonly star: false; readonly e: Expr; readonly alias?: string };

interface OrderItem {
  readonly e: Expr;
  readonly desc: boolean;
  readonly nullsFirst: boolean;
}

interface TableRef {
  schema?: string;
  table: string;
  alias?: string;
}

interface LockClause {
  readonly mode: 'update' | 'share';
  readonly wait: 'wait' | 'nowait' | 'skip';
}

interface Assignment {
  readonly column: string;
  readonly e: Expr;
}

interface SelectStmt {
  readonly kind: 'select';
  readonly items: readonly SelectItem[];
  from?: TableRef;
  where?: Expr;
  groupBy: readonly Expr[];
  orderBy: readonly OrderItem[];
  limit?: Expr;
  offset?: Expr;
  lock?: LockClause;
}

type ConflictClause =
  | { readonly columns?: readonly string[]; readonly action: 'nothing' }
  | { readonly columns?: readonly string[]; readonly action: 'update'; readonly set: readonly Assignment[]; readonly where?: Expr };

interface InsertStmt {
  readonly kind: 'insert';
  readonly target: TableRef;
  readonly columns: readonly string[];
  values?: Expr[][];
  source?: SelectStmt;
  conflict?: ConflictClause;
  returning?: readonly SelectItem[];
}

interface UpdateStmt {
  readonly kind: 'update';
  readonly target: TableRef;
  readonly set: readonly Assignment[];
  where?: Expr;
  returning?: readonly SelectItem[];
}

interface DeleteStmt {
  readonly kind: 'delete';
  readonly target: TableRef;
  where?: Expr;
  returning?: readonly SelectItem[];
}

type DataStmt = SelectStmt | InsertStmt | UpdateStmt | DeleteStmt;

/** Column type as the catalogue declares it; `int8` also covers `xid8` and `bigserial`. */
interface ColumnType {
  readonly base: 'text' | 'char' | 'uuid' | 'int4' | 'int8' | 'numeric' | 'timestamp' | 'bool';
  readonly array: boolean;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly serial?: boolean;
}

interface CatalogColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly notNull: boolean;
  readonly fallback?: Expr;
}

interface UniqueConstraint {
  readonly name: string;
  readonly columns: readonly string[];
}

interface CheckConstraint {
  readonly name: string;
  readonly e: Expr;
}

interface CatalogTable {
  readonly name: string;
  readonly columns: readonly CatalogColumn[];
  readonly column: ReadonlyMap<string, CatalogColumn>;
  readonly unique: readonly UniqueConstraint[];
  readonly checks: readonly CheckConstraint[];
  /** True once the DDL forces row level security on the table. */
  tenantOwned: boolean;
}

type DdlStmt =
  | { readonly kind: 'table'; readonly schema: string | undefined; readonly table: CatalogTable }
  | { readonly kind: 'force-rls'; readonly schema: string | undefined; readonly table: string }
  | { readonly kind: 'ignored' };

const RESERVED_AFTER_TABLE: ReadonlySet<string> = new Set(['where', 'group', 'order', 'limit', 'offset', 'for', 'on', 'returning', 'set', 'values', 'select']);
const COMPARISONS: ReadonlySet<string> = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);


/** Recursive-descent parser of the SQL subset the finance app and platform emit, plus the DDL of `db/migrations`. */
class SqlParser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isWord(word: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'word' && token.text === word;
  }

  private isOp(op: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'op' && token.text === op;
  }

  private eatWord(word: string): boolean {
    if (!this.isWord(word)) return false;
    this.pos += 1;
    return true;
  }

  private eatOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.pos += 1;
    return true;
  }

  private expectWord(word: string): void {
    if (!this.eatWord(word)) this.fail(word.toUpperCase());
  }

  private expectOp(op: string): void {
    if (!this.eatOp(op)) this.fail(`'${op}'`);
  }

  private fail(expected: string): never {
    const token = this.peek();
    return unsupported(`${expected} expected at ${token === undefined ? 'the end' : JSON.stringify(token.text)}`);
  }

  private finish(): void {
    this.eatOp(';');
    if (this.pos < this.tokens.length) this.fail('the end of the statement');
  }

  private name(): string {
    const token = this.peek();
    if (token?.kind !== 'word' && token?.kind !== 'ident') return this.fail('a name');
    this.pos += 1;
    return token.text;
  }

  private names(): string[] {
    this.expectOp('(');
    const names = [this.name()];
    while (this.eatOp(',')) names.push(this.name());
    this.expectOp(')');
    return names;
  }

  private qualifiedName(): TableRef {
    const first = this.name();
    return this.eatOp('.') ? { schema: first, table: this.name() } : { table: first };
  }

  private tableRef(): TableRef {
    const ref = this.qualifiedName();
    if (this.eatWord('as')) {
      ref.alias = this.name();
    } else {
      const token = this.peek();
      if (token?.kind === 'word' && !RESERVED_AFTER_TABLE.has(token.text)) {
        ref.alias = token.text;
        this.pos += 1;
      }
    }
    return ref;
  }

  statement(): DataStmt {
    let stmt: DataStmt;
    if (this.isWord('select')) stmt = this.select();
    else if (this.isWord('insert')) stmt = this.insert();
    else if (this.isWord('update')) stmt = this.update();
    else if (this.isWord('delete')) stmt = this.delete();
    else return this.fail('SELECT, INSERT, UPDATE or DELETE');
    this.finish();
    return stmt;
  }

  private select(): SelectStmt {
    this.expectWord('select');
    const stmt: SelectStmt = { kind: 'select', items: this.selectItems(), groupBy: [], orderBy: [] };
    if (this.eatWord('from')) stmt.from = this.tableRef();
    if (this.eatWord('where')) stmt.where = this.expr();
    if (this.eatWord('group')) {
      this.expectWord('by');
      stmt.groupBy = this.exprList();
    }
    if (this.eatWord('order')) {
      this.expectWord('by');
      const items = [this.orderItem()];
      while (this.eatOp(',')) items.push(this.orderItem());
      stmt.orderBy = items;
    }
    if (this.eatWord('limit')) stmt.limit = this.expr();
    if (this.eatWord('offset')) stmt.offset = this.expr();
    if (this.eatWord('for')) stmt.lock = this.lockClause();
    return stmt;
  }

  private selectItems(): SelectItem[] {
    const items = [this.selectItem()];
    while (this.eatOp(',')) items.push(this.selectItem());
    return items;
  }

  private selectItem(): SelectItem {
    if (this.eatOp('*')) return { star: true };
    const e = this.expr();
    return this.eatWord('as') ? { star: false, e, alias: this.name() } : { star: false, e };
  }

  private orderItem(): OrderItem {
    const e = this.expr();
    const desc = this.eatWord('desc') ? true : (this.eatWord('asc'), false);
    let nullsFirst = desc;
    if (this.eatWord('nulls')) {
      if (this.eatWord('first')) nullsFirst = true;
      else if (this.eatWord('last')) nullsFirst = false;
      else this.fail('FIRST or LAST');
    }
    return { e, desc, nullsFirst };
  }

  private lockClause(): LockClause {
    let mode: LockClause['mode'];
    if (this.eatWord('update')) mode = 'update';
    else if (this.eatWord('share')) mode = 'share';
    else if (this.eatWord('no')) {
      this.expectWord('key');
      this.expectWord('update');
      mode = 'update';
    } else if (this.eatWord('key')) {
      this.expectWord('share');
      mode = 'share';
    } else return this.fail('UPDATE or SHARE');
    if (this.eatWord('nowait')) return { mode, wait: 'nowait' };
    if (this.eatWord('skip')) {
      this.expectWord('locked');
      return { mode, wait: 'skip' };
    }
    return { mode, wait: 'wait' };
  }

  private insert(): InsertStmt {
    this.expectWord('insert');
    this.expectWord('into');
    const stmt: InsertStmt = { kind: 'insert', target: this.tableRef(), columns: this.names() };
    if (this.eatWord('values')) {
      stmt.values = [this.tuple()];
      while (this.eatOp(',')) stmt.values.push(this.tuple());
    } else if (this.isWord('select')) {
      stmt.source = this.select();
    } else {
      this.fail('VALUES or SELECT');
    }
    if (this.eatWord('on')) {
      this.expectWord('conflict');
      const columns = this.isOp('(') ? this.names() : undefined;
      this.expectWord('do');
      if (this.eatWord('nothing')) {
        stmt.conflict = { columns, action: 'nothing' };
      } else {
        this.expectWord('update');
        this.expectWord('set');
        const set = this.assignments();
        stmt.conflict = this.eatWord('where') ? { columns, action: 'update', set, where: this.expr() } : { columns, action: 'update', set };
      }
    }
    if (this.eatWord('returning')) stmt.returning = this.selectItems();
    return stmt;
  }

  private update(): UpdateStmt {
    this.expectWord('update');
    const target = this.tableRef();
    this.expectWord('set');
    const stmt: UpdateStmt = { kind: 'update', target, set: this.assignments() };
    if (this.eatWord('where')) stmt.where = this.expr();
    if (this.eatWord('returning')) stmt.returning = this.selectItems();
    return stmt;
  }

  private delete(): DeleteStmt {
    this.expectWord('delete');
    this.expectWord('from');
    const stmt: DeleteStmt = { kind: 'delete', target: this.tableRef() };
    if (this.eatWord('where')) stmt.where = this.expr();
    if (this.eatWord('returning')) stmt.returning = this.selectItems();
    return stmt;
  }

  private assignments(): Assignment[] {
    const items: Assignment[] = [];
    do {
      const column = this.name();
      this.expectOp('=');
      items.push({ column, e: this.expr() });
    } while (this.eatOp(','));
    return items;
  }

  private tuple(): Expr[] {
    this.expectOp('(');
    const items = this.exprList();
    this.expectOp(')');
    return items;
  }

  private exprList(): Expr[] {
    const items = [this.expr()];
    while (this.eatOp(',')) items.push(this.expr());
    return items;
  }

  expr(): Expr {
    let l = this.conjunction();
    while (this.eatWord('or')) l = { k: 'bin', op: 'or', l, r: this.conjunction() };
    return l;
  }

  private conjunction(): Expr {
    let l = this.negation();
    while (this.eatWord('and')) l = { k: 'bin', op: 'and', l, r: this.negation() };
    return l;
  }

  private negation(): Expr {
    return this.eatWord('not') ? { k: 'not', e: this.negation() } : this.predicate();
  }

  private predicate(): Expr {
    const l = this.additive();
    if (this.eatWord('is')) {
      const not = this.eatWord('not');
      if (this.eatWord('null')) return { k: 'isnull', e: l, not };
      this.expectWord('distinct');
      this.expectWord('from');
      return { k: 'distinct', l, r: this.additive(), not };
    }
    if (this.isWord('not') && this.isWord('in', 1)) {
      this.pos += 2;
      return { k: 'in', l, list: this.tuple(), not: true };
    }
    if (this.eatWord('in')) return { k: 'in', l, list: this.tuple(), not: false };
    const token = this.peek();
    if (token?.kind === 'op' && (COMPARISONS.has(token.text) || token.text === '&&')) {
      this.pos += 1;
      if (COMPARISONS.has(token.text) && this.eatWord('any')) {
        this.expectOp('(');
        const r = this.expr();
        this.expectOp(')');
        return { k: 'any', op: token.text, l, r };
      }
      return { k: 'bin', op: token.text, l, r: this.additive() };
    }
    return l;
  }

  private additive(): Expr {
    let l = this.multiplicative();
    for (let token = this.peek(); token?.kind === 'op' && ['+', '-', '||'].includes(token.text); token = this.peek()) {
      this.pos += 1;
      l = { k: 'bin', op: token.text, l, r: this.multiplicative() };
    }
    return l;
  }

  private multiplicative(): Expr {
    let l = this.unary();
    for (let token = this.peek(); token?.kind === 'op' && ['*', '/'].includes(token.text); token = this.peek()) {
      this.pos += 1;
      l = { k: 'bin', op: token.text, l, r: this.unary() };
    }
    return l;
  }

  private unary(): Expr {
    return this.eatOp('-') ? { k: 'neg', e: this.unary() } : this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.eatOp('::')) {
        e = { k: 'cast', e, type: this.castType() };
      } else if (this.eatWord('collate')) {
        this.name();
        e = { k: 'collate', e };
      } else {
        return e;
      }
    }
  }

  private castType(): string {
    let type = this.name();
    // Type modifiers do not change how a cast value compares or prints here.
    if (this.eatOp('(')) {
      while (!this.eatOp(')')) {
        if (this.peek() === undefined) this.fail("')'");
        this.pos += 1;
      }
    }
    if (this.eatWord('without')) {
      this.expectWord('time');
      this.expectWord('zone');
    }
    if (this.eatOp('[')) {
      this.expectOp(']');
      type += '[]';
    }
    return type;
  }

  private primary(): Expr {
    const token = this.peek();
    if (token === undefined) return this.fail('an expression');
    if (token.kind === 'param') {
      this.pos += 1;
      return { k: 'param', n: Number(token.text) };
    }
    if (token.kind === 'number') {
      this.pos += 1;
      return { k: 'lit', v: token.text.includes('.') ? (parseDecimal(token.text) as Decimal) : Number(token.text) };
    }
    if (token.kind === 'string') {
      this.pos += 1;
      return { k: 'lit', v: token.text };
    }
    if (token.kind === 'op') {
      if (!this.eatOp('(')) return this.fail('an expression');
      const items = this.exprList();
      this.expectOp(')');
      return items.length === 1 ? (items[0] as Expr) : { k: 'row', items };
    }
    if (token.kind === 'word') {
      const keyword = this.keywordPrimary(token.text);
      if (keyword !== undefined) return keyword;
    }
    this.pos += 1;
    if (token.kind === 'word' && this.isOp('(')) return this.call(token.text);
    const parts = [token.text];
    while (this.eatOp('.')) parts.push(this.name());
    const name = parts[parts.length - 1] as string;
    return parts.length === 1 ? { k: 'col', name } : { k: 'col', table: parts[parts.length - 2] as string, name };
  }

  /** NULL, TRUE, FALSE, DEFAULT, ARRAY[…] and LOCALTIMESTAMP[(p)]; undefined for any other word. */
  private keywordPrimary(word: string): Expr | undefined {
    switch (word) {
      case 'null':
      case 'true':
      case 'false':
        this.pos += 1;
        return { k: 'lit', v: word === 'null' ? null : word === 'true' };
      case 'default':
        this.pos += 1;
        return { k: 'default' };
      case 'array': {
        if (!this.isOp('[', 1)) return undefined;
        this.pos += 2;
        const items = this.isOp(']') ? [] : this.exprList();
        this.expectOp(']');
        return { k: 'array', items };
      }
      case 'localtimestamp':
        this.pos += 1;
        if (this.eatOp('(')) {
          this.primary();
          this.expectOp(')');
        }
        return { k: 'fn', name: 'localtimestamp', args: [] };
      default:
        return undefined;
    }
  }

  private call(name: string): Expr {
    this.expectOp('(');
    let args: Expr[] = [];
    if (this.eatOp('*')) args = [{ k: 'star' }];
    else if (!this.isOp(')')) args = this.exprList();
    this.expectOp(')');
    const fn: FnExpr = { k: 'fn', name, args };
    if (this.eatWord('filter')) {
      this.expectOp('(');
      this.expectWord('where');
      fn.filter = this.expr();
      this.expectOp(')');
    }
    return fn;
  }

  /** One DDL statement of a migration: a table, a forced RLS flag, or a statement that defines nothing modelled here. */
  ddl(): DdlStmt {
    if (this.eatWord('create')) {
      if (this.eatWord('table')) {
        const ref = this.qualifiedName();
        return { kind: 'table', schema: ref.schema, table: this.createTable(ref.table) };
      }
      if (this.isWord('index') || this.isWord('unique') || this.isWord('policy')) return { kind: 'ignored' };
      return this.fail('TABLE, INDEX or POLICY');
    }
    if (this.eatWord('alter')) {
      this.expectWord('table');
      const ref = this.qualifiedName();
      const force = this.eatWord('force');
      if (!force) this.expectWord('enable');
      this.expectWord('row');
      this.expectWord('level');
      this.expectWord('security');
      this.finish();
      return force ? { kind: 'force-rls', schema: ref.schema, table: ref.table } : { kind: 'ignored' };
    }
    return this.fail('CREATE or ALTER');
  }

  private createTable(name: string): CatalogTable {
    const columns: CatalogColumn[] = [];
    const unique: UniqueConstraint[] = [];
    const checks: CheckConstraint[] = [];
    // PostgreSQL numbers repeated generated names: <table>_check, <table>_check1, …
    const tableCheck = (): string => {
      const taken = new Set(checks.map((check) => check.name));
      let suffix = 0;
      while (taken.has(`${name}_check${suffix === 0 ? '' : suffix}`)) suffix += 1;
      return `${name}_check${suffix === 0 ? '' : suffix}`;
    };
    this.expectOp('(');
    do {
      if (this.eatWord('primary')) {
        this.expectWord('key');
        unique.unshift({ name: `${name}_pkey`, columns: this.names() });
      } else if (this.eatWord('unique')) {
        const cols = this.names();
        unique.push({ name: `${name}_${cols.join('_')}_key`, columns: cols });
      } else if (this.eatWord('check')) {
        checks.push({ name: tableCheck(), e: this.tuple()[0] as Expr });
      } else {
        columns.push(this.columnDef(name, unique, checks));
      }
    } while (this.eatOp(','));
    this.expectOp(')');
    this.finish();
    const primaryKey = new Set(unique.find((constraint) => constraint.name === `${name}_pkey`)?.columns);
    const declared = columns.map((column) => (primaryKey.has(column.name) ? { ...column, notNull: true } : column));
    return { name, columns: declared, column: new Map(declared.map((column) => [column.name, column])), unique, checks, tenantOwned: false };
  }

  private columnDef(table: string, unique: UniqueConstraint[], checks: CheckConstraint[]): CatalogColumn {
    const name = this.name();
    const type = this.columnType();
    let notNull = false;
    let fallback: Expr | undefined;
    for (;;) {
      if (this.eatWord('not')) {
        this.expectWord('null');
        notNull = true;
      } else if (this.eatWord('null')) {
        notNull = false;
      } else if (this.eatWord('default')) {
        fallback = this.expr();
      } else if (this.eatWord('primary')) {
        this.expectWord('key');
        notNull = true;
        unique.unshift({ name: `${table}_pkey`, columns: [name] });
      } else if (this.eatWord('unique')) {
        unique.push({ name: `${table}_${name}_key`, columns: [name] });
      } else if (this.eatWord('check')) {
        checks.push({ name: `${table}_${name}_check`, e: this.tuple()[0] as Expr });
      } else {
        break;
      }
    }
    return fallback === undefined ? { name, type, notNull } : { name, type, notNull, fallback };
  }

  private columnType(): ColumnType {
    const word = this.name();
    const modifiers: number[] = [];
    if (this.eatOp('(')) {
      do {
        const token = this.peek();
        if (token?.kind !== 'number') this.fail('a type modifier');
        modifiers.push(Number(token.text));
        this.pos += 1;
      } while (this.eatOp(','));
      this.expectOp(')');
    }
    if (this.eatWord('without')) {
      this.expectWord('time');
      this.expectWord('zone');
    }
    const array = this.eatOp('[') ? (this.expectOp(']'), true) : false;
    const [first, second] = modifiers;
    switch (word) {
      case 'text':
        return { base: 'text', array };
      case 'char':
      case 'character':
        return { base: 'char', array, length: first ?? 1 };
      case 'uuid':
        return { base: 'uuid', array };
      case 'integer':
      case 'int':
      case 'int4':
        return { base: 'int4', array };
      case 'bigint':
      case 'int8':
      case 'xid8':
        return { base: 'int8', array };
      case 'bigserial':
        return { base: 'int8', array, serial: true };
      case 'numeric':
        return first === undefined ? { base: 'numeric', array } : { base: 'numeric', array, precision: first, scale: second ?? 0 };
      case 'timestamp':
        return { base: 'timestamp', array };
      case 'boolean':
        return { base: 'bool', array };
      default:
        return unsupported(`the column type ${word}`);
    }
  }
}

/** Splits migration DDL into statements at top-level semicolons. */
function ddlStatements(ddl: string): Token[][] {
  const statements: Token[][] = [[]];
  for (const token of tokenize(ddl)) {
    if (token.kind === 'op' && token.text === ';') statements.push([]);
    else (statements[statements.length - 1] as Token[]).push(token);
  }
  return statements.filter((statement) => statement.length > 0);
}


/** An exact decimal: `units` × 10^-`scale`. */
class Decimal {
  constructor(
    readonly units: bigint,
    readonly scale: number,
  ) {}
}

/** A `char(n)` value: stored blank-padded, compared and cast to text without its trailing blanks, as bpchar is. */
class Bpchar {
  constructor(readonly padded: string) {}

  get text(): string {
    return this.padded.replace(/ +$/, '');
  }
}

/** The value of a row constructor, compared item by item. */
class RowValue {
  constructor(readonly items: readonly unknown[]) {}
}

/** `pg_current_snapshot()`: the oldest xid still in progress and the next xid to assign. */
class Snapshot {
  constructor(
    readonly xmin: bigint,
    readonly xmax: bigint,
  ) {}
}

const DECIMAL_TEXT = /^\s*([+-])?(\d*)(?:\.(\d*))?\s*$/;
const INTEGER_TEXT = /^\s*([+-]?\d+)\s*$/;
const UUID_TEXT = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i;
const TIMESTAMP_TEXT = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?\s*$/i;
const INT4_MIN = -2_147_483_648n;
const INT4_MAX = 2_147_483_647n;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;
const TRUE_TEXT: ReadonlySet<string> = new Set(['t', 'true', 'y', 'yes', 'on', '1']);
const FALSE_TEXT: ReadonlySet<string> = new Set(['f', 'false', 'n', 'no', 'off', '0']);

function describeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Bpchar) return value.padded;
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function invalidInput(type: string, value: unknown): PgError {
  return pgError('22P02', `invalid input syntax for type ${type}: "${describeValue(value)}"`);
}

function parseDecimal(text: string): Decimal | undefined {
  const match = DECIMAL_TEXT.exec(text);
  const integer = match?.[2] ?? '';
  const fraction = match?.[3] ?? '';
  if (match === null || (integer === '' && fraction === '')) return undefined;
  const units = BigInt(`${integer}${fraction}` || '0');
  return new Decimal(match[1] === '-' ? -units : units, fraction.length);
}

function isNumeric(value: unknown): value is number | bigint | Decimal {
  return typeof value === 'number' || typeof value === 'bigint' || value instanceof Decimal;
}

function toDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'bigint') return new Decimal(value, 0);
  if (typeof value === 'number' && Number.isInteger(value)) return new Decimal(BigInt(value), 0);
  const parsed = typeof value === 'number' || typeof value === 'string' ? parseDecimal(String(value)) : undefined;
  if (parsed === undefined) throw invalidInput('numeric', value);
  return parsed;
}

/** `value` at `scale` decimals, rounding half away from zero as numeric does. */
function rescale(value: Decimal, scale: number): Decimal {
  if (scale >= value.scale) return new Decimal(value.units * 10n ** BigInt(scale - value.scale), scale);
  const divisor = 10n ** BigInt(value.scale - scale);
  const quotient = value.units / divisor;
  const remainder = value.units % divisor;
  const away = (remainder < 0n ? -remainder : remainder) * 2n >= divisor;
  return new Decimal(away ? quotient + (value.units < 0n ? -1n : 1n) : quotient, scale);
}

function decimalText(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const body = value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
  return negative ? `-${body}` : body;
}

function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale).units;
  const y = rescale(b, scale).units;
  return x < y ? -1 : x > y ? 1 : 0;
}

function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return new Decimal(rescale(a, scale).units + rescale(b, scale).units, scale);
}

/** `value` as a numeric(p,s) column stores it; throws numeric field overflow beyond p − s integer digits. */
function fitNumeric(value: Decimal, type: ColumnType): Decimal {
  if (type.scale === undefined || type.precision === undefined) return value;
  const fitted = rescale(value, type.scale);
  const magnitude = (fitted.units < 0n ? -fitted.units : fitted.units).toString();
  if (fitted.units !== 0n && magnitude.length - type.scale > type.precision - type.scale) {
    throw pgError('22003', 'numeric field overflow');
  }
  return fitted;
}

function integerOf(value: unknown, type: 'integer' | 'bigint'): bigint {
  let result: bigint | undefined;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number' && Number.isInteger(value)) result = BigInt(value);
  else if (value instanceof Decimal) result = rescale(value, 0).units;
  else if (typeof value === 'string') {
    const digits = INTEGER_TEXT.exec(value)?.[1];
    if (digits !== undefined) result = BigInt(digits);
  }
  if (result === undefined) throw invalidInput(type, value);
  const [min, max] = type === 'integer' ? [INT4_MIN, INT4_MAX] : [INT8_MIN, INT8_MAX];
  if (result < min || result > max) throw pgError('22003', `value "${describeValue(value)}" is out of range for type ${type}`);
  return result;
}

function toInt4(value: unknown): number {
  return Number(integerOf(value, 'integer'));
}

function toInt8(value: unknown): bigint {
  return integerOf(value, 'bigint');
}

function uuidText(value: unknown): string {
  const match = typeof value === 'string' ? UUID_TEXT.exec(value.trim()) : null;
  if (match === null) throw invalidInput('uuid', value);
  return match.slice(1, 6).join('-').toLowerCase();
}

function toTimestamp(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalidInput('timestamp without time zone', value);
    return new Date(value.getTime());
  }
  const match = typeof value === 'string' ? TIMESTAMP_TEXT.exec(value) : null;
  if (match === null) throw invalidInput('timestamp without time zone', value);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? '0')) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw pgError('22008', `date/time field value out of range: "${String(value)}"`);
  }
  const fraction = match[7] ?? '';
  // timestamp(3) keeps milliseconds, rounding the rest.
  return new Date(date.getTime() + (fraction === '' ? 0 : Math.round(Number(`0.${fraction}`) * 1000)));
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim().toLowerCase() : undefined;
  if (text !== undefined && TRUE_TEXT.has(text)) return true;
  if (text !== undefined && FALSE_TEXT.has(text)) return false;
  throw invalidInput('boolean', value);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** A timestamp as PostgreSQL prints it: `YYYY-MM-DD HH:MM:SS[.fff]`, trailing fraction zeros dropped. */
function timestampText(date: Date): string {
  const base = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const ms = date.getMilliseconds();
  return ms === 0 ? base : `${base}.${pad(ms, 3).replace(/0+$/, '')}`;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Bpchar) return value.text;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Decimal) return decimalText(value);
  if (value instanceof Date) return timestampText(value);
  if (Array.isArray(value)) return `{${value.map(arrayElementText).join(',')}}`;
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  // node-pg sends any other object parameter as its JSON text.
  if (typeof value === 'object' && value !== null && !(value instanceof RowValue) && !(value instanceof Snapshot)) return JSON.stringify(value);
  return unsupported(`a text form of ${describeValue(value)}`);
}

function arrayElementText(item: unknown): string {
  if (item === null || item === undefined) return 'NULL';
  const text = textOf(item);
  return text === '' || /[{}",\\\s]/.test(text) || text.toUpperCase() === 'NULL' ? `"${text.replace(/[\\"]/g, '\\$&')}"` : text;
}

/** Elements of an array literal such as `{}` or `{a,"b c",NULL}`. */
function parseArrayLiteral(text: string): (string | null)[] {
  const body = /^\{(.*)\}$/s.exec(text.trim())?.[1];
  if (body === undefined) throw pgError('22P02', `malformed array literal: "${text}"`);
  const items: (string | null)[] = [];
  let at = 0;
  while (body !== '' && at <= body.length) {
    if (body.charAt(at) === '"') {
      let item = '';
      let end = at + 1;
      for (; end < body.length && body.charAt(end) !== '"'; end += 1) {
        if (body.charAt(end) === '\\') end += 1;
        item += body.charAt(end);
      }
      items.push(item);
      at = end + 2;
    } else {
      const comma = body.indexOf(',', at);
      const raw = (comma === -1 ? body.slice(at) : body.slice(at, comma)).trim();
      items.push(raw.toUpperCase() === 'NULL' ? null : raw);
      at = comma === -1 ? body.length + 1 : comma + 1;
    }
  }
  return items;
}

/** `text` as char(`length`) stores it: blank-padded, too long only when non-blank characters exceed `length`. */
function bpchar(text: string, length: number): string {
  const trimmed = text.replace(/ +$/, '');
  const size = [...trimmed].length;
  if (size > length) throw pgError('22001', `value too long for type character(${length})`);
  return trimmed + ' '.repeat(length - size);
}

function storeScalar(value: unknown, type: ColumnType): unknown {
  switch (type.base) {
    case 'text':
      return textOf(value);
    case 'char':
      return bpchar(textOf(value), type.length ?? 1);
    case 'uuid':
      return uuidText(value instanceof Bpchar ? value.text : value);
    case 'int4':
      return toInt4(value);
    case 'int8':
      return toInt8(value).toString();
    case 'numeric':
      return decimalText(fitNumeric(toDecimal(value), type));
    case 'timestamp':
      return toTimestamp(value);
    case 'bool':
      return toBool(value);
  }
}

/** `value` in the form node-pg returns for `column`: int8 and numeric as text, timestamps as local Dates, char(n) blank-padded. */
function storeValue(value: unknown, column: CatalogColumn): unknown {
  if (value === null || value === undefined) return null;
  if (!column.type.array) return storeScalar(value, column.type);
  const items: readonly unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? parseArrayLiteral(value)
      : unsupported(`an array for ${column.name} from ${describeValue(value)}`);
  return items.map((item) => (item === null || item === undefined ? null : storeScalar(item, column.type)));
}

/** A stored value as expressions compare it: int8 as bigint, numeric as Decimal, char(n) as Bpchar. */
function fromStored(value: unknown, column: CatalogColumn): unknown {
  if (value === null || value === undefined) return null;
  const convert = (item: unknown): unknown => {
    if (item === null) return null;
    if (column.type.base === 'int8') return BigInt(item as string);
    if (column.type.base === 'numeric') return parseDecimal(item as string);
    return column.type.base === 'char' ? new Bpchar(item as string) : item;
  };
  return column.type.array ? (value as unknown[]).map(convert) : convert(value);
}

/** An expression value in the form node-pg returns it. */
function toWire(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Decimal) return decimalText(value);
  if (value instanceof Bpchar) return value.padded;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Snapshot) return `${value.xmin}:${value.xmax}:`;
  if (value instanceof RowValue) return `(${value.items.map((item) => (item === null ? '' : textOf(item))).join(',')})`;
  return Array.isArray(value) ? value.map(toWire) : value;
}

/** A copy of a stored row, so callers cannot change the store through it. */
function copyRow(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? new Date(value.getTime()) : Array.isArray(value) ? [...(value as unknown[])] : value]),
  );
}

function castValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (type.endsWith('[]')) {
    const items: readonly unknown[] = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? parseArrayLiteral(value)
        : unsupported(`a cast of ${describeValue(value)} to ${type}`);
    return items.map((item) => castValue(item, type.slice(0, -2)));
  }
  switch (type) {
    case 'text':
    case 'varchar':
      return textOf(value);
    case 'bpchar':
    case 'char':
      return new Bpchar(textOf(value));
    case 'integer':
    case 'int':
    case 'int4':
    case 'smallint':
      return toInt4(value);
    case 'bigint':
    case 'int8':
    case 'xid8':
      return toInt8(value);
    case 'numeric':
      return toDecimal(value);
    case 'uuid':
      return uuidText(value instanceof Bpchar ? value.text : value);
    case 'timestamp':
      return toTimestamp(value);
    case 'boolean':
    case 'bool':
      return toBool(value);
    default:
      return unsupported(`a cast to ${type}`);
  }
}

function compareArrays(a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    // Array comparison sorts NULL elements after every other value.
    const order = x === null || y === null ? Number(x === null) - Number(y === null) : (compareValues(x, y) ?? 0);
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

/** Item-by-item order of two rows; null once an item pair compares unknown before the order is decided. */
function compareRows(a: RowValue, b: RowValue): number | null {
  for (let i = 0; i < Math.min(a.items.length, b.items.length); i += 1) {
    const order = compareValues(a.items[i], b.items[i]);
    if (order === null || order !== 0) return order;
  }
  return Math.sign(a.items.length - b.items.length);
}

/** SQL order of two non-null values; null when either is NULL. Text compares by code unit, as COLLATE "C" does. */
function compareValues(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof RowValue && b instanceof RowValue) return compareRows(a, b);
  if (a instanceof Date || b instanceof Date) return Math.sign(toTimestamp(a).getTime() - toTimestamp(b).getTime());
  if (isNumeric(a) || isNumeric(b)) return compareDecimal(toDecimal(a), toDecimal(b));
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(toBool(a)) - Number(toBool(b));
  if (Array.isArray(a) && Array.isArray(b)) return compareArrays(a, b);
  const blankPadded = a instanceof Bpchar || b instanceof Bpchar;
  const x = blankPadded ? textOf(a).replace(/ +$/, '') : textOf(a);
  const y = blankPadded ? textOf(b).replace(/ +$/, '') : textOf(b);
  return compareText(x, y);
}

/** Byte order of the UTF-8 forms, as COLLATE "C" sorts; UTF-16 code units agree with it below the surrogate range. */
function compareText(x: string, y: string): number {
  if (/[\ud800-\uffff]/.test(x + y)) return Math.sign(Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')));
  return x < y ? -1 : x > y ? 1 : 0;
}

function notDistinct(a: unknown, b: unknown): boolean {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull && bNull;
  if (a instanceof RowValue && b instanceof RowValue) return a.items.length === b.items.length && a.items.every((item, i) => notDistinct(item, b.items[i]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => notDistinct(item, b[i]));
  return compareValues(a, b) === 0;
}

function holds(op: string, order: number): boolean {
  switch (op) {
    case '=':
      return order === 0;
    case '<>':
    case '!=':
      return order !== 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    default:
      return unsupported(`the operator ${op}`);
  }
}

/** `l op r` with SQL's three-valued logic; rows compare item by item. */
function comparison(op: string, l: unknown, r: unknown): boolean | null {
  if (l instanceof RowValue && r instanceof RowValue && (op === '=' || op === '<>' || op === '!=')) {
    let unknown = false;
    for (let i = 0; i < Math.max(l.items.length, r.items.length); i += 1) {
      const order = compareValues(l.items[i], r.items[i]);
      if (order === null) unknown = true;
      else if (order !== 0) return op !== '=';
    }
    return unknown ? null : op === '=';
  }
  const order = compareValues(l, r);
  return order === null ? null : holds(op, order);
}

/** to_char over the fields the platform formats: YYYY, MM, DD, HH24, MI, SS, MS and double-quoted literals. */
function toChar(date: Date, format: string): string {
  const fields: Readonly<Record<string, () => string>> = {
    YYYY: () => pad(date.getFullYear(), 4),
    HH24: () => pad(date.getHours()),
    MM: () => pad(date.getMonth() + 1),
    DD: () => pad(date.getDate()),
    MI: () => pad(date.getMinutes()),
    SS: () => pad(date.getSeconds()),
    MS: () => pad(date.getMilliseconds(), 3),
  };
  let out = '';
  for (let at = 0; at < format.length; ) {
    if (format.charAt(at) === '"') {
      const end = format.indexOf('"', at + 1);
      out += format.slice(at + 1, end === -1 ? format.length : end);
      at = end === -1 ? format.length : end + 1;
      continue;
    }
    const field = Object.keys(fields).find((name) => format.startsWith(name, at));
    out += field === undefined ? format.charAt(at) : (fields[field] as () => string)();
    at += field === undefined ? 1 : field.length;
  }
  return out;
}


const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url);
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/** Thrown when the migrations and the repository's table definitions disagree, so no suite runs against a stale model. */
class CatalogueDriftError extends Error {
  override readonly name: string = 'CatalogueDriftError';
}

let catalogueCache: ReadonlyMap<string, CatalogTable> | undefined;

/** Tables of schema `finance` as `db/migrations` declares them, parsed once per process. */
function catalogue(): ReadonlyMap<string, CatalogTable> {
  catalogueCache ??= loadCatalogue();
  return catalogueCache;
}

function loadCatalogue(): ReadonlyMap<string, CatalogTable> {
  const tables = new Map<string, CatalogTable>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => MIGRATION_FILE.test(name)).sort()) {
    for (const tokens of ddlStatements(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'))) {
      let stmt: DdlStmt;
      try {
        stmt = new SqlParser(tokens).ddl();
      } catch (err) {
        throw new CatalogueDriftError(`${file}: ${(err as Error).message} in ${tokens.map((token) => token.text).join(' ')}`);
      }
      if (stmt.kind === 'ignored') continue;
      if (stmt.schema !== SCHEMA) throw new CatalogueDriftError(`${file}: only schema ${SCHEMA} is modelled, not ${stmt.schema ?? 'an unqualified table'}`);
      if (stmt.kind === 'table') {
        tables.set(stmt.table.name, stmt.table);
        continue;
      }
      const table = tables.get(stmt.table);
      if (table === undefined) throw new CatalogueDriftError(`${file}: row level security forced on unknown table ${stmt.table}`);
      table.tenantOwned = true;
    }
  }
  assertCatalogue(tables);
  return tables;
}

function assertCatalogue(tables: ReadonlyMap<string, CatalogTable>): void {
  for (const def of [...OWNED_TABLES, ...NON_UNIT_TABLES]) {
    const table = tables.get(def.table);
    if (table === undefined) throw new CatalogueDriftError(`the migrations define no table ${SCHEMA}.${def.table}`);
    const missing = def.columns.filter((column) => !table.column.has(column.name)).map((column) => column.name);
    if (missing.length > 0) throw new CatalogueDriftError(`${SCHEMA}.${def.table} has no column ${missing.join(', ')}`);
    const primaryKey = table.unique.find((constraint) => constraint.name === `${def.table}_pkey`)?.columns ?? [];
    const expected = ['tenant_id', ...def.key];
    if (primaryKey.length !== expected.length || !expected.every((column) => primaryKey.includes(column))) {
      throw new CatalogueDriftError(`${SCHEMA}.${def.table} primary key (${primaryKey.join(', ')}) is not (${expected.join(', ')})`);
    }
  }
  for (const table of tables.values()) {
    if (table.tenantOwned === isNonTenantTable(table.name)) {
      throw new CatalogueDriftError(`${SCHEMA}.${table.name} ${table.tenantOwned ? 'forces' : 'lacks'} row level security against the platform's tenant tables`);
    }
  }
  if (!tables.has(UNIT_GATE_TABLE)) throw new CatalogueDriftError(`the migrations define no ${SCHEMA}.${UNIT_GATE_TABLE}`);
}

/** Expression form of a stored row: int8 as bigint, numeric as Decimal, char(n) as Bpchar. */
function expressionRow(table: CatalogTable, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(table.columns.map((column) => [column.name, fromStored(values[column.name], column)]));
}

const TENANT_SETTING = 'app.tenant_id';
const LOCK_TIMEOUT_SETTING = 'lock_timeout';
const SETTING_DEFAULTS: ReadonlyMap<string, string> = new Map([
  [LOCK_TIMEOUT_SETTING, '0'],
  ['statement_timeout', '0'],
  ['transaction_isolation', 'read committed'],
]);
const FIRST_XID = 1000n;
const AGGREGATES: ReadonlySet<string> = new Set(['count', 'sum', 'max', 'min']);

type LockMode = 'share' | 'update';

/** One version of a row; `xmin` and `xmax` name the inserting and the deleting transaction while it is in progress. */
interface RowVersion {
  readonly table: string;
  values: Record<string, unknown>;
  xmin: Tx | null;
  xmax: Tx | null;
  readonly lockers: Map<Tx, LockMode>;
}

type UndoEntry =
  | { readonly kind: 'insert'; readonly version: RowVersion }
  | { readonly kind: 'delete'; readonly version: RowVersion }
  | { readonly kind: 'lock'; readonly version: RowVersion; readonly previous: LockMode | undefined };

interface Savepoint {
  readonly name: string;
  readonly undo: number;
  readonly writes: number;
  readonly settings: ReadonlyMap<string, string>;
}

/** A committed write; `table` is schema-qualified and `row` is the row as pg returns it. */
export interface RecordedWrite {
  readonly table: string;
  readonly op: 'insert' | 'update' | 'delete';
  readonly row: Readonly<Record<string, unknown>>;
  readonly tenantId: string | null;
}

/** An executed statement with the pattern that answered it and the transaction's `app.tenant_id`, null when empty or outside one. */
export interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly pattern: string;
  readonly tenantId: string | null;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** One transaction of the recording database; its xid is assigned at its first write, lock or `pg_current_xact_id()`. */
class Tx {
  xid: bigint | undefined;
  aborted = false;
  readonly undo: UndoEntry[] = [];
  readonly savepoints: Savepoint[] = [];
  readonly writes: RecordedWrite[] = [];
  readonly settings = new Map<string, string>();
  readonly advisory = new Set<string>();
  waitingFor: Tx | undefined;
  private signal = deferred();

  constructor(
    readonly start: Date,
    readonly session: Session,
  ) {}

  /** Settles at this transaction's next end or rollback to a savepoint, when locks it held may have been released. */
  changed(): Promise<void> {
    return this.signal.promise;
  }

  notify(): void {
    const settled = this.signal;
    this.signal = deferred();
    settled.resolve();
  }
}

/** A pooled connection's state: its open transaction and its session-level settings. */
interface Session {
  tx: Tx | undefined;
  readonly settings: Map<string, string>;
}

/** Thrown inside a statement that must wait for `blocker`; the statement is undone, awaited and run again. */
class LockWait extends Error {
  override readonly name: string = 'LockWait';

  constructor(readonly blocker: Tx) {
    super('the statement waits for a lock another transaction holds');
  }
}

type Answer = readonly QueryResultRow[] | ((params: readonly unknown[]) => readonly QueryResultRow[]);

interface Override {
  readonly matches: (raw: string, normalized: string) => boolean;
  readonly answer: Answer;
}

interface Failure {
  readonly matches: (raw: string, normalized: string) => boolean;
  readonly error: Error;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function matcher(match: string | RegExp): (raw: string, normalized: string) => boolean {
  if (typeof match === 'string') {
    const wanted = normalizeSql(match);
    return (_raw, normalized) => normalized.includes(wanted);
  }
  return (raw, normalized) => {
    match.lastIndex = 0;
    if (match.test(raw)) return true;
    match.lastIndex = 0;
    return match.test(normalized);
  };
}

function result(command: string, rows: QueryResultRow[] = [], rowCount: number = rows.length): QueryResult {
  return { command, rowCount, oid: 0, rows, fields: [] };
}

function lockTimeoutMs(setting: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/i.exec(setting);
  if (match === null) throw pgError('22023', `invalid value for parameter "lock_timeout": "${setting}"`);
  const factor: Readonly<Record<string, number>> = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * (factor[(match[2] ?? 'ms').toLowerCase()] ?? 1);
}

/** Settles after `ms`, or as soon as `until` settles; the timer never outlives the wait. */
async function timeout(ms: number, until: Promise<void>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  try {
    return await Promise.race([until.then(() => false), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}


/** What one statement runs with: its transaction and bound parameters. */
interface Exec {
  readonly store: RecordingStore;
  readonly tx: Tx;
  readonly params: readonly unknown[];
}

/** Rows an expression reads: by qualifier, and for unqualified names; `group` holds the member rows of an aggregate. */
interface Scope {
  readonly ex: Exec;
  readonly qualified: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly row: Readonly<Record<string, unknown>> | undefined;
  readonly group?: readonly Scope[];
}

function emptyScope(ex: Exec): Scope {
  return { ex, qualified: new Map(), row: undefined };
}

function rowScope(ex: Exec, qualifiers: readonly string[], row: Readonly<Record<string, unknown>>): Scope {
  return { ex, qualified: new Map(qualifiers.map((name) => [name, row])), row };
}

function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

/** A parameter as the server receives it from node-pg; undefined binds NULL. */
function paramValue(value: unknown): unknown {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.map(paramValue) : value;
}

/** SQL truth of `value`: null for NULL, else the boolean it casts to. */
function truth(value: unknown): boolean | null {
  return isNull(value) ? null : toBool(value);
}

function evaluate(e: Expr, scope: Scope): unknown {
  switch (e.k) {
    case 'col':
      return columnValue(e, scope);
    case 'param': {
      const { params } = scope.ex;
      if (e.n < 1 || e.n > params.length) throw pgError('08P01', `bind message supplies ${params.length} parameters, but $${e.n} is referenced`);
      return paramValue(params[e.n - 1]);
    }
    case 'lit':
      return e.v;
    case 'default':
      throw pgError('42601', 'DEFAULT is not allowed in this context');
    case 'star':
      throw pgError('42601', '* is allowed only in count(*) and select lists');
    case 'cast':
      return castValue(evaluate(e.e, scope), e.type);
    case 'collate':
      return evaluate(e.e, scope);
    case 'fn':
      return callFunction(e, scope);
    case 'not': {
      const value = truth(evaluate(e.e, scope));
      return value === null ? null : !value;
    }
    case 'neg':
      return arithmetic('-', 0, evaluate(e.e, scope));
    case 'bin':
      return binary(e.op, e.l, e.r, scope);
    case 'isnull': {
      const value = evaluate(e.e, scope);
      // A row IS NULL when every item is null, and IS NOT NULL when none is.
      if (value instanceof RowValue) return value.items.every((item) => isNull(item) !== e.not);
      return isNull(value) !== e.not;
    }
    case 'distinct': {
      const same = notDistinct(evaluate(e.l, scope), evaluate(e.r, scope));
      return e.not ? same : !same;
    }
    case 'any': {
      const list = evaluate(e.r, scope);
      if (isNull(list)) return null;
      if (!Array.isArray(list)) throw pgError('42809', `op ANY/ALL (array) requires an array on its right side, not ${describeValue(list)}`);
      return anyTrue(list.map((item) => comparison(e.op, evaluate(e.l, scope), item)));
    }
    case 'in': {
      const value = evaluate(e.l, scope);
      const found = anyTrue(e.list.map((item) => comparison('=', value, evaluate(item, scope))));
      return found === null ? null : found !== e.not;
    }
    case 'row':
      return new RowValue(e.items.map((item) => evaluate(item, scope)));
    case 'array':
      return e.items.map((item) => evaluate(item, scope));
  }
}

/** OR over three-valued results. */
function anyTrue(results: readonly (boolean | null)[]): boolean | null {
  if (results.includes(true)) return true;
  return results.includes(null) ? null : false;
}

function columnValue(e: ColExpr, scope: Scope): unknown {
  if (e.table !== undefined) {
    const row = scope.qualified.get(e.table);
    if (row === undefined) throw pgError('42P01', `missing FROM-clause entry for table "${e.table}"`);
    if (!(e.name in row)) throw pgError('42703', `column ${e.table}.${e.name} does not exist`);
    return row[e.name];
  }
  if (scope.row === undefined || !(e.name in scope.row)) throw pgError('42703', `column "${e.name}" does not exist`);
  return scope.row[e.name];
}

function binary(op: string, left: Expr, right: Expr, scope: Scope): unknown {
  if (op === 'and' || op === 'or') {
    const l = truth(evaluate(left, scope));
    if (l === (op === 'or')) return l;
    const r = truth(evaluate(right, scope));
    if (r === (op === 'or')) return r;
    return l === null || r === null ? null : l;
  }
  const l = evaluate(left, scope);
  const r = evaluate(right, scope);
  if (COMPARISONS.has(op)) return comparison(op, l, r);
  if (isNull(l) || isNull(r)) return null;
  if (op === '&&') {
    if (!Array.isArray(l) || !Array.isArray(r)) throw pgError('42883', `operator does not exist: ${describeValue(l)} && ${describeValue(r)}`);
    return l.some((x) => !isNull(x) && r.some((y) => !isNull(y) && compareValues(x, y) === 0));
  }
  if (op === '||') return Array.isArray(l) || Array.isArray(r) ? [l, r].flat() : textOf(l) + textOf(r);
  return arithmetic(op, l, r);
}

/** `l op r` over integers and numerics; int4 stays int4, int8 stays bigint, anything else is numeric. */
function arithmetic(op: string, l: unknown, r: unknown): unknown {
  if (isNull(l) || isNull(r)) return null;
  if (!isNumeric(l) || !isNumeric(r)) {
    if (typeof l !== 'string' && typeof r !== 'string') throw pgError('42883', `operator does not exist: ${describeValue(l)} ${op} ${describeValue(r)}`);
  }
  const integral = (v: unknown): boolean => typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && INTEGER_TEXT.test(v));
  if (integral(l) && integral(r)) {
    const x = toInt8(l);
    const y = toInt8(r);
    let out: bigint;
    if (op === '+') out = x + y;
    else if (op === '-') out = x - y;
    else if (op === '*') out = x * y;
    else if (op === '/') {
      if (y === 0n) throw pgError('22012', 'division by zero');
      out = x / y;
    } else return unsupported(`the operator ${op}`);
    const narrow = typeof l !== 'bigint' && typeof r !== 'bigint';
    if (narrow && (out < INT4_MIN || out > INT4_MAX)) throw pgError('22003', 'integer out of range');
    if (out < INT8_MIN || out > INT8_MAX) throw pgError('22003', 'bigint out of range');
    return narrow ? Number(out) : out;
  }
  const x = toDecimal(l);
  const y = toDecimal(r);
  if (op === '+') return addDecimal(x, y);
  if (op === '-') return addDecimal(x, new Decimal(-y.units, y.scale));
  if (op === '*') return new Decimal(x.units * y.units, x.scale + y.scale);
  return unsupported(`numeric ${op}`);
}

function hasAggregate(e: Expr): boolean {
  switch (e.k) {
    case 'fn':
      return AGGREGATES.has(e.name) || e.args.some(hasAggregate);
    case 'cast':
    case 'collate':
    case 'not':
    case 'neg':
    case 'isnull':
      return hasAggregate(e.e);
    case 'bin':
    case 'distinct':
    case 'any':
      return hasAggregate(e.l) || hasAggregate(e.r);
    case 'in':
      return hasAggregate(e.l) || e.list.some(hasAggregate);
    case 'row':
    case 'array':
      return e.items.some(hasAggregate);
    default:
      return false;
  }
}

function aggregate(e: FnExpr, scope: Scope): unknown {
  if (scope.group === undefined) throw pgError('42803', `aggregate function ${e.name} is not allowed here`);
  const { filter } = e;
  const members = filter === undefined ? scope.group : scope.group.filter((member) => truth(evaluate(filter, member)) === true);
  const [arg] = e.args;
  if (arg === undefined || e.args.length !== 1) throw pgError('42883', `function ${e.name} takes one argument here`);
  if (e.name === 'count') return BigInt(arg.k === 'star' ? members.length : members.filter((member) => !isNull(evaluate(arg, member))).length);
  const values = members.map((member) => evaluate(arg, member)).filter((value) => !isNull(value));
  if (values.length === 0) return null;
  if (e.name === 'sum') {
    // sum(integer) is bigint; sum over bigint or numeric is numeric.
    if (values.every((value) => typeof value === 'number')) return values.reduce<bigint>((total, value) => total + toInt8(value), 0n);
    return values.reduce<Decimal>((total, value) => addDecimal(total, toDecimal(value)), new Decimal(0n, 0));
  }
  const pick = e.name === 'max' ? 1 : -1;
  return values.reduce((best, value) => (Math.sign(compareValues(value, best) ?? 0) === pick ? value : best));
}

function stringArg(value: unknown): string | null {
  return isNull(value) ? null : textOf(value);
}

/** Removes the characters of `chars` from the chosen ends of `text`. */
function trimChars(text: string, chars: string, start: boolean, end: boolean): string {
  const set = new Set(chars);
  const items = [...text];
  let from = 0;
  let to = items.length;
  while (start && from < to && set.has(items[from] as string)) from += 1;
  while (end && to > from && set.has(items[to - 1] as string)) to -= 1;
  return items.slice(from, to).join('');
}

function translateText(text: string, from: string, to: string): string {
  const source = [...from];
  const target = [...to];
  return [...text]
    .map((char) => {
      const at = source.indexOf(char);
      return at === -1 ? char : (target[at] ?? '');
    })
    .join('');
}

/** `hashtextextended`'s role here: a stable 64-bit key per text and seed for advisory locks. */
function hashText(text: string, seed: bigint): bigint {
  return createHash('sha256').update(`${seed}:${text}`).digest().readBigInt64BE(0);
}

function callFunction(e: FnExpr, scope: Scope): unknown {
  if (AGGREGATES.has(e.name)) return aggregate(e, scope);
  if (e.filter !== undefined) throw pgError('42809', `FILTER specified, but ${e.name} is not an aggregate function`);
  const { store, tx } = scope.ex;
  const args = (): unknown[] => e.args.map((arg) => evaluate(arg, scope));
  switch (e.name) {
    case 'coalesce':
      for (const arg of e.args) {
        const value = evaluate(arg, scope);
        if (!isNull(value)) return value;
      }
      return null;
    case 'nullif': {
      const [a, b] = args();
      return !isNull(a) && !isNull(b) && compareValues(a, b) === 0 ? null : (a ?? null);
    }
    case 'lower':
    case 'upper': {
      const text = stringArg(args()[0]);
      return text === null ? null : e.name === 'lower' ? text.toLowerCase() : text.toUpperCase();
    }
    case 'translate': {
      const [text = null, from = null, to = null] = args().map(stringArg);
      return text === null || from === null || to === null ? null : translateText(text, from, to);
    }
    case 'rtrim':
    case 'ltrim':
    case 'btrim': {
      const [text, chars = ' '] = args().map(stringArg);
      if (text === null || text === undefined || chars === null) return null;
      return trimChars(text, chars, e.name !== 'rtrim', e.name !== 'ltrim');
    }
    case 'octet_length':
    case 'char_length':
    case 'character_length':
    case 'length': {
      const text = stringArg(args()[0]);
      if (text === null) return null;
      return e.name === 'octet_length' ? Buffer.byteLength(text, 'utf8') : [...text].length;
    }
    case 'to_char': {
      const [value, format] = args();
      return isNull(value) || isNull(format) ? null : toChar(toTimestamp(value), textOf(format));
    }
    case 'to_regclass': {
      const name = stringArg(args()[0]);
      return name === null ? null : store.regclass(name);
    }
    case 'localtimestamp':
      return new Date(tx.start.getTime());
    case 'pg_current_xact_id':
      return store.assignXid(tx);
    case 'pg_current_snapshot':
      return store.snapshot();
    case 'pg_snapshot_xmin':
    case 'pg_snapshot_xmax': {
      const [snapshot] = args();
      if (isNull(snapshot)) return null;
      if (!(snapshot instanceof Snapshot)) throw pgError('42883', `function ${e.name}(${describeValue(snapshot)}) does not exist`);
      return e.name === 'pg_snapshot_xmin' ? snapshot.xmin : snapshot.xmax;
    }
    case 'set_config': {
      const [name, value, local] = args();
      if (isNull(name)) throw pgError('22023', 'SET requires parameter name');
      return store.setConfig(tx, textOf(name), isNull(value) ? '' : textOf(value), toBool(local ?? false));
    }
    case 'current_setting': {
      const [name, missingOk] = args();
      if (isNull(name)) return null;
      return store.setting(tx, textOf(name), missingOk === undefined ? false : toBool(missingOk));
    }
    case 'hashtextextended': {
      const [text, seed] = args();
      return isNull(text) || isNull(seed) ? null : hashText(textOf(text), toInt8(seed));
    }
    case 'pg_advisory_xact_lock':
    case 'pg_try_advisory_xact_lock': {
      const [key] = args();
      if (isNull(key)) return null;
      const locked = store.advisoryLock(tx, toInt8(key).toString(), e.name === 'pg_advisory_xact_lock');
      // pg_advisory_xact_lock returns void, which node-pg reads as an empty string.
      return e.name === 'pg_advisory_xact_lock' ? '' : locked;
    }
    case 'unnest':
      throw pgError('0A000', 'set-returning functions are supported only at the top of a select list');
    default:
      return unsupported(`the function ${e.name}()`);
  }
}

/** The column name pg gives an unaliased select item. */
function outputName(e: Expr): string {
  switch (e.k) {
    case 'col':
      return e.name;
    case 'fn':
      return e.name;
    case 'collate':
      return outputName(e.e);
    case 'cast':
      return e.e.k === 'col' || e.e.k === 'fn' ? outputName(e.e) : e.type.replace(/\[\]$/, '');
    case 'row':
      return 'row';
    case 'array':
      return 'array';
    default:
      return '?column?';
  }
}

/** Grouping key of a value: equal SQL values, such as 1.5 and 1.50 or blank-padded chars, give equal keys. */
function groupKey(value: unknown): string {
  if (isNull(value)) return 'N';
  if (value instanceof Decimal) {
    const text = decimalText(value);
    return `d${text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text}`;
  }
  if (isNumeric(value)) return groupKey(toDecimal(value));
  if (value instanceof Date) return `t${value.getTime()}`;
  if (value instanceof RowValue || Array.isArray(value)) return `r${JSON.stringify((value instanceof RowValue ? value.items : value).map(groupKey))}`;
  return `s${textOf(value instanceof Bpchar ? value.text : value)}`;
}


/** Marks a VALUES item written as DEFAULT. */
const DEFAULT_VALUE: unique symbol = Symbol('DEFAULT');

/** Holder id of gates `setGate` closes. */
const RECORDING_GATE_HOLDER = 'recording-db';

interface Conflict {
  readonly constraint: UniqueConstraint;
  readonly version: RowVersion;
}

function uniqueViolation(table: CatalogTable, constraint: UniqueConstraint, values: Readonly<Record<string, unknown>>): PgError {
  const key = constraint.columns.map((column) => textOf(fromStored(values[column], table.column.get(column) as CatalogColumn))).join(', ');
  return pgError('23505', `duplicate key value violates unique constraint "${constraint.name}"`, {
    detail: `Key (${constraint.columns.join(', ')})=(${key}) already exists.`,
    constraint: constraint.name,
    table: table.name,
    schema: SCHEMA,
  });
}

/** Rows, transactions and locks of one recording database; every handle and pool on it shares this store. */
class RecordingStore {
  readonly versions = new Map<string, RowVersion[]>();
  readonly writeLog: RecordedWrite[] = [];
  readonly queryLog: RecordedQuery[] = [];
  readonly overrides: Override[] = [];
  readonly failures: Failure[] = [];
  lastWriteXid: bigint | undefined;
  private readonly serials = new Map<string, bigint>();
  private readonly running = new Set<Tx>();
  private readonly advisoryHolders = new Map<string, Tx>();
  private nextXid = FIRST_XID;
  private latestCompleted = FIRST_XID - 1n;

  constructor(
    readonly catalog: ReadonlyMap<string, CatalogTable>,
    readonly clock: Clock,
  ) {
    for (const name of catalog.keys()) this.versions.set(name, []);
  }

  /** The modelled table a statement names; SQL must qualify it with `finance`, which is the only schema modelled. */
  table(ref: TableRef): CatalogTable {
    if (ref.schema === undefined) throw pgError('42P01', `relation "${ref.table}" does not exist`);
    if (ref.schema !== SCHEMA) return unsupported(`relation ${ref.schema}.${ref.table}, outside schema ${SCHEMA}`);
    const found = this.catalog.get(ref.table);
    if (found === undefined) throw pgError('42P01', `relation "${SCHEMA}.${ref.table}" does not exist`);
    return found;
  }

  /** The table a helper call names, bare or qualified with `finance`. */
  namedTable(name: string): CatalogTable {
    const { schema = SCHEMA, table } = parseRelationName(name);
    const found = schema === SCHEMA ? this.catalog.get(table) : undefined;
    if (found === undefined) throw new TypeError(`the recording db models no table ${name}; it has ${[...this.catalog.keys()].join(', ')}`);
    return found;
  }

  /** `to_regclass`: the relation's name when it exists, else null. */
  regclass(name: string): string | null {
    const { schema, table } = parseRelationName(name);
    return schema === SCHEMA && this.catalog.has(table) ? `${SCHEMA}.${table}` : null;
  }

  begin(session: Session): Tx {
    return new Tx(this.clock.now(), session);
  }

  assignXid(tx: Tx): bigint {
    if (tx.xid === undefined) {
      tx.xid = this.nextXid;
      this.nextXid += 1n;
      this.running.add(tx);
    }
    return tx.xid;
  }

  /** `pg_current_snapshot()`: the oldest xid in progress, else the first not yet completed, and one past the latest completed. */
  snapshot(): Snapshot {
    const xmax = this.latestCompleted + 1n;
    let xmin = xmax;
    for (const tx of this.running) if (tx.xid !== undefined && tx.xid < xmin) xmin = tx.xid;
    return new Snapshot(xmin, xmax);
  }

  setting(tx: Tx, name: string, missingOk: boolean): string | null {
    const value = tx.settings.get(name) ?? tx.session.settings.get(name) ?? SETTING_DEFAULTS.get(name);
    if (value !== undefined) return value;
    if (missingOk) return null;
    throw pgError('42704', `unrecognized configuration parameter "${name}"`);
  }

  setConfig(tx: Tx, name: string, value: string, local: boolean): string {
    if (name === LOCK_TIMEOUT_SETTING) lockTimeoutMs(value);
    (local ? tx.settings : tx.session.settings).set(name, value);
    return value;
  }

  /** NULLIF(current_setting('app.tenant_id', true), '')::uuid, the tenant every row level security policy compares with. */
  tenantOf(tx: Tx): string | null {
    const raw = this.setting(tx, TENANT_SETTING, true) ?? '';
    return raw === '' ? null : uuidText(raw);
  }

  /** Versions `tx` sees in `table`, after the forced tenant policy of a tenant-owned table. */
  scan(tx: Tx, table: CatalogTable): RowVersion[] {
    const tenant = table.tenantOwned ? this.tenantOf(tx) : undefined;
    return (this.versions.get(table.name) as RowVersion[]).filter(
      (version) => (version.xmin === null || version.xmin === tx) && version.xmax !== tx && (tenant === undefined || (tenant !== null && version.values.tenant_id === tenant)),
    );
  }

  /** The transaction whose update, delete or row lock conflicts with `mode` on `version`, if any. */
  lockBlocker(version: RowVersion, tx: Tx, mode: LockMode): Tx | undefined {
    if (version.xmax !== null && version.xmax !== tx) return version.xmax;
    for (const [holder, held] of version.lockers) {
      if (holder !== tx && (mode === 'update' || held === 'update')) return holder;
    }
    return undefined;
  }

  lockRow(tx: Tx, version: RowVersion, mode: LockMode): void {
    this.assignXid(tx);
    const previous = version.lockers.get(tx);
    const next: LockMode = previous === 'update' || mode === 'update' ? 'update' : 'share';
    if (previous === next) return;
    tx.undo.push({ kind: 'lock', version, previous });
    version.lockers.set(tx, next);
  }

  /** Takes the transaction-level advisory lock `key`; throws LockWait when another holds it and `wait`, else returns whether it was taken. */
  advisoryLock(tx: Tx, key: string, wait: boolean): boolean {
    const holder = this.advisoryHolders.get(key);
    if (holder !== undefined && holder !== tx) {
      if (wait) throw new LockWait(holder);
      return false;
    }
    this.advisoryHolders.set(key, tx);
    tx.advisory.add(key);
    return true;
  }

  /** A complete row of `table`: `provided` values coerced to their column types, omitted columns from their defaults. */
  buildRow(ex: Exec, table: CatalogTable, provided: ReadonlyMap<string, unknown>): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const column of table.columns) {
      const value = provided.get(column.name);
      if (provided.has(column.name) && value !== DEFAULT_VALUE) values[column.name] = storeValue(value, column);
      else values[column.name] = this.defaultValue(ex, table, column);
    }
    return values;
  }

  defaultValue(ex: Exec, table: CatalogTable, column: CatalogColumn): unknown {
    if (column.type.serial === true) {
      const key = `${table.name}.${column.name}`;
      // Sequences are not transactional: a rolled-back insert still consumes its value.
      const next = (this.serials.get(key) ?? 0n) + 1n;
      this.serials.set(key, next);
      return next.toString();
    }
    return column.fallback === undefined ? null : storeValue(evaluate(column.fallback, emptyScope(ex)), column);
  }

  /** NOT NULL, CHECK and, when `rls`, the WITH CHECK side of the tenant policy. */
  checkRow(tx: Tx, table: CatalogTable, values: Readonly<Record<string, unknown>>, rls: boolean, ex: Exec): void {
    for (const column of table.columns) {
      if (column.notNull && values[column.name] === null) {
        throw pgError('23502', `null value in column "${column.name}" of relation "${table.name}" violates not-null constraint`, {
          column: column.name,
          table: table.name,
          schema: SCHEMA,
        });
      }
    }
    const scope = rowScope(ex, [table.name], expressionRow(table, values));
    for (const check of table.checks) {
      if (truth(evaluate(check.e, scope)) === false) {
        throw pgError('23514', `new row for relation "${table.name}" violates check constraint "${check.name}"`, {
          constraint: check.name,
          table: table.name,
          schema: SCHEMA,
        });
      }
    }
    if (rls && table.tenantOwned) {
      const tenant = this.tenantOf(tx);
      if (tenant === null || values.tenant_id !== tenant) {
        throw pgError('42501', `new row violates row-level security policy for table "${table.name}"`, { table: table.name, schema: SCHEMA });
      }
    }
  }

  /** The first live row sharing a key of `constraints` with `values`; throws LockWait while such a row's insert or delete is in progress. */
  findConflict(tx: Tx, table: CatalogTable, values: Readonly<Record<string, unknown>>, constraints: readonly UniqueConstraint[], ignore?: RowVersion): Conflict | undefined {
    for (const constraint of constraints) {
      const columns = constraint.columns.map((name) => table.column.get(name) as CatalogColumn);
      const key = columns.map((column) => fromStored(values[column.name], column));
      if (key.some(isNull)) continue;
      for (const version of this.versions.get(table.name) as RowVersion[]) {
        if (version === ignore) continue;
        if (!columns.every((column, i) => compareValues(fromStored(version.values[column.name], column), key[i]) === 0)) continue;
        if (version.xmin !== null && version.xmin !== tx) throw new LockWait(version.xmin);
        if (version.xmax === tx) continue;
        if (version.xmax !== null) throw new LockWait(version.xmax);
        return { constraint, version };
      }
    }
    return undefined;
  }

  insertVersion(tx: Tx, table: CatalogTable, values: Record<string, unknown>): RowVersion {
    this.assignXid(tx);
    const version: RowVersion = { table: table.name, values, xmin: tx, xmax: null, lockers: new Map() };
    (this.versions.get(table.name) as RowVersion[]).push(version);
    tx.undo.push({ kind: 'insert', version });
    this.recordWrite(tx, table, 'insert', values);
    return version;
  }

  replaceVersion(tx: Tx, table: CatalogTable, old: RowVersion, values: Record<string, unknown>): RowVersion {
    this.assignXid(tx);
    old.xmax = tx;
    tx.undo.push({ kind: 'delete', version: old });
    const version: RowVersion = { table: table.name, values, xmin: tx, xmax: null, lockers: new Map() };
    (this.versions.get(table.name) as RowVersion[]).push(version);
    tx.undo.push({ kind: 'insert', version });
    this.recordWrite(tx, table, 'update', values);
    return version;
  }

  deleteVersion(tx: Tx, table: CatalogTable, version: RowVersion): void {
    this.assignXid(tx);
    version.xmax = tx;
    tx.undo.push({ kind: 'delete', version });
    this.recordWrite(tx, table, 'delete', version.values);
  }

  private recordWrite(tx: Tx, table: CatalogTable, op: RecordedWrite['op'], values: Readonly<Record<string, unknown>>): void {
    const tenant = values.tenant_id;
    tx.writes.push({ table: `${SCHEMA}.${table.name}`, op, row: copyRow(values), tenantId: typeof tenant === 'string' ? tenant : null });
  }

  private removeVersion(version: RowVersion): void {
    const list = this.versions.get(version.table) as RowVersion[];
    const at = list.lastIndexOf(version);
    if (at !== -1) list.splice(at, 1);
  }

  /** Undoes `tx`'s changes and locks back to its undo log length `mark`. */
  undoTo(tx: Tx, mark: number): void {
    while (tx.undo.length > mark) {
      const entry = tx.undo.pop() as UndoEntry;
      if (entry.kind === 'insert') this.removeVersion(entry.version);
      else if (entry.kind === 'delete') entry.version.xmax = null;
      else if (entry.previous === undefined) entry.version.lockers.delete(tx);
      else entry.version.lockers.set(tx, entry.previous);
    }
  }

  /** Commits or rolls back `tx`, releasing its locks; a commit that wrote appends to the write log when `record`. */
  finish(tx: Tx, commit: boolean, record = true): void {
    if (commit) {
      for (const { version } of tx.undo) {
        if (version.xmax === tx) this.removeVersion(version);
        else if (version.xmin === tx) version.xmin = null;
        version.lockers.delete(tx);
      }
      tx.undo.length = 0;
    } else {
      this.undoTo(tx, 0);
    }
    for (const key of tx.advisory) {
      if (this.advisoryHolders.get(key) === tx) this.advisoryHolders.delete(key);
    }
    tx.advisory.clear();
    if (tx.xid !== undefined) {
      this.running.delete(tx);
      if (tx.xid > this.latestCompleted) this.latestCompleted = tx.xid;
      if (commit && record && tx.writes.length > 0) {
        this.lastWriteXid = tx.xid;
        this.writeLog.push(...tx.writes);
      }
    }
    tx.writes.length = 0;
    tx.notify();
  }

  savepoint(tx: Tx, name: string): void {
    tx.savepoints.push({ name, undo: tx.undo.length, writes: tx.writes.length, settings: new Map(tx.settings) });
  }

  rollbackToSavepoint(tx: Tx, name: string): void {
    const at = tx.savepoints.findLastIndex((savepoint) => savepoint.name === name);
    const savepoint = tx.savepoints[at];
    if (savepoint === undefined) throw pgError('3B001', `savepoint "${name}" does not exist`);
    if (tx.undo.length > savepoint.undo) this.undoTo(tx, savepoint.undo);
    tx.writes.length = savepoint.writes;
    tx.settings.clear();
    for (const [key, value] of savepoint.settings) tx.settings.set(key, value);
    tx.savepoints.length = at + 1;
    tx.aborted = false;
    tx.notify();
  }

  releaseSavepoint(tx: Tx, name: string): void {
    const at = tx.savepoints.findLastIndex((savepoint) => savepoint.name === name);
    if (at === -1) throw pgError('3B001', `savepoint "${name}" does not exist`);
    tx.savepoints.length = at;
  }

  /** Waits until `wait.blocker` releases what it holds, within `lock_timeout` from `started`; a wait cycle is a deadlock. */
  async wait(tx: Tx, wait: LockWait, started: number): Promise<void> {
    for (let other: Tx | undefined = wait.blocker; other !== undefined; other = other.waitingFor) {
      if (other === tx) throw pgError('40P01', 'deadlock detected');
    }
    const limit = lockTimeoutMs(this.setting(tx, LOCK_TIMEOUT_SETTING, false) ?? '0');
    const changed = wait.blocker.changed();
    tx.waitingFor = wait.blocker;
    try {
      if (limit <= 0) {
        await changed;
        return;
      }
      const remaining = started + limit - Date.now();
      if (remaining <= 0 || (await timeout(remaining, changed))) throw pgError('55P03', 'canceling statement due to lock timeout');
    } finally {
      tx.waitingFor = undefined;
    }
  }

  /** Inserts committed rows directly, outside any logged transaction; the batch is all or nothing. */
  seedRows(tableName: string, rows: readonly Readonly<Record<string, unknown>>[]): void {
    const table = this.namedTable(tableName);
    const tx = this.begin({ tx: undefined, settings: new Map() });
    const ex: Exec = { store: this, tx, params: [] };
    const list = this.versions.get(table.name) as RowVersion[];
    const added: RowVersion[] = [];
    try {
      for (const row of rows) {
        const unknown = Object.keys(row).filter((name) => !table.column.has(name));
        if (unknown.length > 0) throw new TypeError(`seed row of ${SCHEMA}.${table.name} has no column ${unknown.join(', ')}`);
        const values = this.buildRow(ex, table, new Map(Object.entries(row)));
        this.checkRow(tx, table, values, false, ex);
        const conflict = this.findConflict(tx, table, values, table.unique);
        if (conflict !== undefined) throw uniqueViolation(table, conflict.constraint, values);
        const version: RowVersion = { table: table.name, values, xmin: null, xmax: null, lockers: new Map() };
        list.push(version);
        added.push(version);
      }
    } catch (err) {
      for (const version of added) this.removeVersion(version);
      throw err instanceof LockWait ? new Error(`seed of ${SCHEMA}.${table.name} conflicts with a row of an open transaction`) : err;
    } finally {
      this.finish(tx, true, false);
    }
  }

  /** Sets the committed gate row of `unit`, inserting it when absent. */
  setGate(unit: string, state: GateState, phase: GatePhase): void {
    const table = this.namedTable(UNIT_GATE_TABLE);
    const existing = (this.versions.get(table.name) as RowVersion[]).find((version) => version.xmin === null && version.values.unit === unit);
    if (existing !== undefined && (existing.xmax !== null || existing.lockers.size > 0)) {
      throw new Error(`the gate of ${unit} is held by an open transaction`);
    }
    const row = { unit, state, phase, holder_id: state === 'closed' ? RECORDING_GATE_HOLDER : null, updated_at: this.clock.now() };
    if (existing === undefined) {
      this.seedRows(table.name, [row]);
      return;
    }
    const tx = this.begin({ tx: undefined, settings: new Map() });
    const ex: Exec = { store: this, tx, params: [] };
    try {
      const values = this.buildRow(ex, table, new Map(Object.entries(row)));
      this.checkRow(tx, table, values, false, ex);
      existing.values = values;
    } finally {
      this.finish(tx, true, false);
    }
  }

  /** Committed rows of `table`, optionally of one tenant, as pg returns them. */
  committedRows(tableName: string, tenantId?: string): Record<string, unknown>[] {
    const table = this.namedTable(tableName);
    const tenant = tenantId === undefined ? undefined : uuidText(tenantId);
    return (this.versions.get(table.name) as RowVersion[])
      .filter((version) => version.xmin === null && (tenant === undefined || version.values.tenant_id === tenant))
      .map((version) => copyRow(version.values));
  }

  /** Runs one statement on `session`, as a pg client's `query` would. */
  async run(session: Session, input: string | QueryConfig, values?: readonly unknown[]): Promise<QueryResult> {
    const sql = typeof input === 'string' ? input : input.text;
    const params: readonly unknown[] = values ?? (typeof input === 'string' ? undefined : input.values) ?? [];
    const normalized = normalizeSql(sql);
    const pattern = PATTERNS.find((candidate) => candidate.match.test(normalized));
    const { tx } = session;
    this.queryLog.push({ sql, params: [...params], pattern: pattern?.name ?? 'unmatched', tenantId: tx === undefined ? null : this.loggedTenant(tx) });
    if (tx?.aborted === true && pattern?.whenAborted !== true) {
      throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    }
    const failure = this.failures.findIndex((candidate) => candidate.matches(sql, normalized));
    if (failure !== -1) {
      const [{ error }] = this.failures.splice(failure, 1) as [Failure];
      if (tx !== undefined) tx.aborted = true;
      throw error;
    }
    const override = this.overrides.find((candidate) => candidate.matches(sql, normalized));
    if (override !== undefined) {
      const rows = typeof override.answer === 'function' ? override.answer(params) : override.answer;
      return result('SELECT', rows.map(copyRow));
    }
    try {
      if (pattern === undefined) return unsupported('a statement no pattern answers');
      return await pattern.run({ store: this, session, sql, normalized }, params);
    } catch (err) {
      if (session.tx !== undefined && pattern?.whenAborted !== true) session.tx.aborted = true;
      if (err instanceof UnsupportedSqlError) throw new Error(`recording db cannot run ${err.message}: ${sql}`);
      throw err;
    }
  }

  /** Rolls back the open transaction of a session going back to the pool or destroyed. */
  abandon(session: Session): void {
    if (session.tx !== undefined) this.finish(session.tx, false);
    session.tx = undefined;
  }

  private loggedTenant(tx: Tx): string | null {
    try {
      return this.tenantOf(tx);
    } catch {
      return null;
    }
  }
}

/** A relation name as `to_regclass` or a test names it: `table`, `schema.table`, either part optionally double-quoted. */
function parseRelationName(name: string): { schema?: string; table: string } {
  const parts = tokenize(name).filter((token) => !(token.kind === 'op' && token.text === '.'));
  const texts = parts.map((token) => token.text);
  if (parts.some((token) => token.kind !== 'word' && token.kind !== 'ident') || texts.length < 1 || texts.length > 2) {
    throw new TypeError(`not a relation name: ${name}`);
  }
  const [first = '', second] = texts;
  return second === undefined ? { table: first } : { schema: first, table: second };
}


/** A source row of a query: the row version it reads, if any, and the scope its expressions see. */
interface SourceRow {
  readonly version: RowVersion | undefined;
  readonly scope: Scope;
}

/** Output column names and expression-form values of a query. */
interface Projection {
  readonly names: string[];
  readonly rows: unknown[][];
}

function qualifierOf(ref: TableRef): string {
  return ref.alias ?? ref.table;
}

function nullRow(table: CatalogTable): Record<string, unknown> {
  return Object.fromEntries(table.columns.map((column) => [column.name, null]));
}

function targetColumn(table: CatalogTable, name: string): CatalogColumn {
  const column = table.column.get(name);
  if (column === undefined) throw pgError('42703', `column "${name}" of relation "${table.name}" does not exist`);
  return column;
}

/** LIMIT or OFFSET as a row count; NULL yields undefined. */
function rowBound(e: Expr | undefined, ex: Exec, clause: 'LIMIT' | 'OFFSET'): number | undefined {
  if (e === undefined) return undefined;
  const value = evaluate(e, emptyScope(ex));
  if (isNull(value)) return undefined;
  const count = toInt8(value);
  if (count < 0n) throw pgError(clause === 'LIMIT' ? '2201W' : '2201X', `${clause} must not be negative`);
  return Number(count);
}

function runSelect(ex: Exec, stmt: SelectStmt): Projection {
  const { from } = stmt;
  const table = from === undefined ? undefined : ex.store.table(from);
  let rows: SourceRow[] =
    table === undefined || from === undefined
      ? [{ version: undefined, scope: rowScope(ex, [], {}) }]
      : ex.store.scan(ex.tx, table).map((version) => ({ version, scope: rowScope(ex, [qualifierOf(from)], expressionRow(table, version.values)) }));
  const { where } = stmt;
  if (where !== undefined) rows = rows.filter((row) => truth(evaluate(where, row.scope)) === true);
  const grouped = stmt.groupBy.length > 0 || stmt.items.some((item) => !item.star && hasAggregate(item.e)) || stmt.orderBy.some((item) => hasAggregate(item.e));
  if (grouped) {
    if (stmt.lock !== undefined) throw pgError('0A000', 'FOR UPDATE is not allowed with GROUP BY clause or aggregate functions');
    rows = groupRows(ex, table, stmt, rows);
  }
  const order = stmt.orderBy.map((item) => ({ ...item, e: orderExpr(item.e, stmt, table) }));
  if (order.length > 0) rows = sortRows(rows, order);
  const offset = rowBound(stmt.offset, ex, 'OFFSET') ?? 0;
  const limit = rowBound(stmt.limit, ex, 'LIMIT') ?? Number.POSITIVE_INFINITY;
  if (stmt.lock !== undefined && table !== undefined) rows = lockRows(ex, table, rows, stmt.lock, offset, limit);
  else rows = rows.slice(offset, offset + limit);
  return project(stmt.items, table, rows);
}

function groupRows(ex: Exec, table: CatalogTable | undefined, stmt: SelectStmt, rows: readonly SourceRow[]): SourceRow[] {
  if (stmt.items.some((item) => item.star)) throw pgError('42803', 'SELECT * cannot be combined with GROUP BY or aggregates here');
  const groups = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const key = stmt.groupBy.map((e) => groupKey(evaluate(e, row.scope))).join('\u0000');
    const members = groups.get(key);
    if (members === undefined) groups.set(key, [row]);
    else members.push(row);
  }
  // An aggregate without GROUP BY yields one row even over no rows.
  if (groups.size === 0 && stmt.groupBy.length === 0) groups.set('', []);
  const empty = table === undefined || stmt.from === undefined ? rowScope(ex, [], {}) : rowScope(ex, [qualifierOf(stmt.from)], nullRow(table));
  return [...groups.values()].map((members) => ({ version: undefined, scope: { ...(members[0]?.scope ?? empty), group: members.map((member) => member.scope) } }));
}

/** ORDER BY item resolved as pg does: an output column number, or a bare name of an output column that is not an input column. */
function orderExpr(e: Expr, stmt: SelectStmt, table: CatalogTable | undefined): Expr {
  if (e.k === 'lit' && typeof e.v === 'number') {
    const item = stmt.items[e.v - 1];
    if (item === undefined || item.star) throw pgError('42P10', `ORDER BY position ${e.v} is not in select list`);
    return item.e;
  }
  if (e.k !== 'col' || e.table !== undefined || table?.column.has(e.name) === true) return e;
  const item = stmt.items.find((candidate) => !candidate.star && candidate.alias === e.name);
  return item === undefined || item.star ? e : item.e;
}

function sortRows(rows: readonly SourceRow[], order: readonly OrderItem[]): SourceRow[] {
  const keyed = rows.map((row) => ({ row, keys: order.map((item) => evaluate(item.e, row.scope)) }));
  keyed.sort((a, b) => {
    for (const [i, item] of order.entries()) {
      const x = a.keys[i];
      const y = b.keys[i];
      if (isNull(x) && isNull(y)) continue;
      if (isNull(x)) return item.nullsFirst ? -1 : 1;
      if (isNull(y)) return item.nullsFirst ? 1 : -1;
      const sign = compareValues(x, y) ?? 0;
      if (sign !== 0) return item.desc ? -sign : sign;
    }
    return 0;
  });
  return keyed.map(({ row }) => row);
}

/** FOR UPDATE or FOR SHARE over the selected rows; SKIP LOCKED skips before OFFSET and LIMIT apply, as pg does. */
function lockRows(ex: Exec, table: CatalogTable, rows: readonly SourceRow[], lock: LockClause, offset: number, limit: number): SourceRow[] {
  const { store, tx } = ex;
  const blockerOf = (row: SourceRow): Tx | undefined => (row.version === undefined ? undefined : store.lockBlocker(row.version, tx, lock.mode));
  const candidates = lock.wait === 'skip' ? rows.filter((row) => blockerOf(row) === undefined) : rows;
  const chosen = candidates.slice(offset, offset + limit);
  for (const row of chosen) {
    const blocker = blockerOf(row);
    if (blocker === undefined) continue;
    if (lock.wait === 'nowait') throw pgError('55P03', `could not obtain lock on row in relation "${table.name}"`);
    throw new LockWait(blocker);
  }
  for (const row of chosen) if (row.version !== undefined) store.lockRow(tx, row.version, lock.mode);
  return chosen;
}

function project(items: readonly SelectItem[], table: CatalogTable | undefined, rows: readonly SourceRow[]): Projection {
  const names = items.flatMap((item) => {
    if (!item.star) return [item.alias ?? outputName(item.e)];
    if (table === undefined) throw pgError('42601', 'SELECT * with no tables specified is not valid');
    return table.columns.map((column) => column.name);
  });
  const setReturning = items.map((item) => !item.star && item.e.k === 'fn' && item.e.name === 'unnest');
  const out: unknown[][] = [];
  for (const row of rows) {
    const value = (item: SelectItem, element: unknown): unknown[] => {
      if (item.star) return (table as CatalogTable).columns.map((column) => row.scope.row?.[column.name] ?? null);
      return [element === undefined ? evaluate(item.e, row.scope) : element];
    };
    if (!setReturning.includes(true)) {
      out.push(items.flatMap((item) => value(item, undefined)));
      continue;
    }
    const arrays = items.map((item, i) => (setReturning[i] === true && !item.star ? unnestArgument(item.e as FnExpr, row.scope) : undefined));
    const length = Math.max(0, ...arrays.map((array) => array?.length ?? 0));
    for (let at = 0; at < length; at += 1) {
      out.push(items.flatMap((item, i) => (arrays[i] === undefined ? value(item, undefined) : [arrays[i]?.[at] ?? null])));
    }
  }
  return { names, rows: out };
}

function unnestArgument(e: FnExpr, scope: Scope): readonly unknown[] {
  const [arg] = e.args;
  if (arg === undefined || e.args.length !== 1) throw pgError('42883', 'unnest takes one array here');
  const value = evaluate(arg, scope);
  if (isNull(value)) return [];
  if (!Array.isArray(value)) throw pgError('42804', `unnest requires an array, not ${describeValue(value)}`);
  return value;
}

/** Rows as node-pg returns them; a repeated output name keeps its last value. */
function wireRows({ names, rows }: Projection): QueryResultRow[] {
  return rows.map((values) => Object.fromEntries(names.map((name, i) => [name, toWire(values[i])])));
}

function returning(ex: Exec, table: CatalogTable, qualifier: string, items: readonly SelectItem[] | undefined, affected: readonly Record<string, unknown>[]): QueryResultRow[] {
  if (items === undefined) return [];
  const rows = affected.map((values) => ({ version: undefined, scope: rowScope(ex, [qualifier], expressionRow(table, values)) }));
  return wireRows(project(items, table, rows));
}

/** `values` after an UPDATE SET list evaluated against the old row in `scope`. */
function assignValues(ex: Exec, table: CatalogTable, old: Readonly<Record<string, unknown>>, set: readonly Assignment[], scope: Scope): Record<string, unknown> {
  const values = copyRow(old);
  for (const { column, e } of set) {
    const target = targetColumn(table, column);
    values[target.name] = e.k === 'default' ? ex.store.defaultValue(ex, table, target) : storeValue(evaluate(e, scope), target);
  }
  return values;
}

function arbitersOf(table: CatalogTable, clause: ConflictClause): readonly UniqueConstraint[] {
  const { columns } = clause;
  if (columns === undefined) return table.unique;
  const found = table.unique.find((constraint) => constraint.columns.length === columns.length && columns.every((name) => constraint.columns.includes(name)));
  if (found === undefined) throw pgError('42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
  return [found];
}

function runInsert(ex: Exec, stmt: InsertStmt): QueryResult {
  const { store, tx } = ex;
  const table = store.table(stmt.target);
  const qualifier = qualifierOf(stmt.target);
  const columns = stmt.columns.map((name) => targetColumn(table, name));
  const repeated = columns.find((column, i) => columns.indexOf(column) !== i);
  if (repeated !== undefined) throw pgError('42701', `column "${repeated.name}" specified more than once`);
  const tuples: readonly unknown[][] =
    stmt.values === undefined
      ? runSelect(ex, stmt.source as SelectStmt).rows
      : stmt.values.map((tuple) => tuple.map((e) => (e.k === 'default' ? DEFAULT_VALUE : evaluate(e, emptyScope(ex)))));
  const arbiters = stmt.conflict === undefined ? [] : arbitersOf(table, stmt.conflict);
  const touched = new Set<RowVersion>();
  const affected: Record<string, unknown>[] = [];
  for (const tuple of tuples) {
    if (tuple.length !== columns.length) {
      throw pgError('42601', tuple.length > columns.length ? 'INSERT has more expressions than target columns' : 'INSERT has more target columns than expressions');
    }
    const values = store.buildRow(ex, table, new Map(columns.map((column, i) => [column.name, tuple[i]])));
    store.checkRow(tx, table, values, true, ex);
    const conflict = arbiters.length === 0 ? undefined : store.findConflict(tx, table, values, arbiters);
    if (conflict !== undefined) {
      const clause = stmt.conflict as ConflictClause;
      if (clause.action === 'nothing') continue;
      const updated = upsert(ex, table, qualifier, clause, conflict.version, values, touched);
      if (updated !== undefined) {
        touched.add(updated);
        affected.push(updated.values);
      }
      continue;
    }
    const duplicate = store.findConflict(tx, table, values, table.unique);
    if (duplicate !== undefined) throw uniqueViolation(table, duplicate.constraint, values);
    touched.add(store.insertVersion(tx, table, values));
    affected.push(values);
  }
  return result('INSERT', returning(ex, table, qualifier, stmt.returning, affected), affected.length);
}

/** ON CONFLICT DO UPDATE of `existing`; undefined when its WHERE leaves the row as it is, which still locks it. */
function upsert(
  ex: Exec,
  table: CatalogTable,
  qualifier: string,
  clause: Extract<ConflictClause, { action: 'update' }>,
  existing: RowVersion,
  proposed: Readonly<Record<string, unknown>>,
  touched: ReadonlySet<RowVersion>,
): RowVersion | undefined {
  const { store, tx } = ex;
  if (touched.has(existing)) throw pgError('21000', 'ON CONFLICT DO UPDATE command cannot affect row a second time');
  const blocker = store.lockBlocker(existing, tx, 'update');
  if (blocker !== undefined) throw new LockWait(blocker);
  if (table.tenantOwned && existing.values.tenant_id !== store.tenantOf(tx)) {
    throw pgError('42501', `new row violates row-level security policy (USING expression) for table "${table.name}"`);
  }
  const current = expressionRow(table, existing.values);
  const scope: Scope = { ex, qualified: new Map([[qualifier, current], ['excluded', expressionRow(table, proposed)]]), row: current };
  if (clause.where !== undefined && truth(evaluate(clause.where, scope)) !== true) {
    store.lockRow(tx, existing, 'update');
    return undefined;
  }
  const values = assignValues(ex, table, existing.values, clause.set, scope);
  store.checkRow(tx, table, values, true, ex);
  const duplicate = store.findConflict(tx, table, values, table.unique, existing);
  if (duplicate !== undefined) throw uniqueViolation(table, duplicate.constraint, values);
  return store.replaceVersion(tx, table, existing, values);
}

/** Rows of an UPDATE or DELETE target that its WHERE selects, once no other transaction holds them. */
function targetRows(ex: Exec, table: CatalogTable, qualifier: string, where: Expr | undefined): RowVersion[] {
  const { store, tx } = ex;
  const targets = store
    .scan(tx, table)
    .filter((version) => where === undefined || truth(evaluate(where, rowScope(ex, [qualifier], expressionRow(table, version.values)))) === true);
  for (const version of targets) {
    const blocker = store.lockBlocker(version, tx, 'update');
    if (blocker !== undefined) throw new LockWait(blocker);
  }
  return targets;
}

function runUpdate(ex: Exec, stmt: UpdateStmt): QueryResult {
  const { store, tx } = ex;
  const table = store.table(stmt.target);
  const qualifier = qualifierOf(stmt.target);
  const affected: Record<string, unknown>[] = [];
  for (const version of targetRows(ex, table, qualifier, stmt.where)) {
    const values = assignValues(ex, table, version.values, stmt.set, rowScope(ex, [qualifier], expressionRow(table, version.values)));
    store.checkRow(tx, table, values, true, ex);
    const duplicate = store.findConflict(tx, table, values, table.unique, version);
    if (duplicate !== undefined) throw uniqueViolation(table, duplicate.constraint, values);
    store.replaceVersion(tx, table, version, values);
    affected.push(values);
  }
  return result('UPDATE', returning(ex, table, qualifier, stmt.returning, affected), affected.length);
}

function runDelete(ex: Exec, stmt: DeleteStmt): QueryResult {
  const table = ex.store.table(stmt.target);
  const qualifier = qualifierOf(stmt.target);
  const affected: Record<string, unknown>[] = [];
  for (const version of targetRows(ex, table, qualifier, stmt.where)) {
    ex.store.deleteVersion(ex.tx, table, version);
    affected.push(version.values);
  }
  return result('DELETE', returning(ex, table, qualifier, stmt.returning, affected), affected.length);
}

const parsedStatements = new Map<string, DataStmt>();

function parseStatement(sql: string): DataStmt {
  let stmt = parsedStatements.get(sql);
  if (stmt === undefined) {
    stmt = new SqlParser(tokenize(sql)).statement();
    parsedStatements.set(sql, stmt);
  }
  return stmt;
}

/** Runs `stmt`; a statement that meets a lock is undone, waits for its holder and runs again, as pg re-reads after a lock wait. */
async function execute(ex: Exec, stmt: DataStmt): Promise<QueryResult> {
  const started = Date.now();
  for (;;) {
    const undo = ex.tx.undo.length;
    const writes = ex.tx.writes.length;
    try {
      switch (stmt.kind) {
        case 'select':
          return result('SELECT', wireRows(runSelect(ex, stmt)));
        case 'insert':
          return runInsert(ex, stmt);
        case 'update':
          return runUpdate(ex, stmt);
        case 'delete':
          return runDelete(ex, stmt);
      }
    } catch (err) {
      if (!(err instanceof LockWait)) throw err;
      ex.store.undoTo(ex.tx, undo);
      ex.tx.writes.length = writes;
      await ex.store.wait(ex.tx, err, started);
    }
  }
}

/** What a pattern runs with: the store, the pooled session and the statement as sent and normalized. */
interface StatementContext {
  readonly store: RecordingStore;
  readonly session: Session;
  readonly sql: string;
  readonly normalized: string;
}

/** One statement family the recording db answers; `whenAborted` marks those pg still runs in a failed transaction. */
interface SqlPattern {
  readonly name: string;
  readonly match: RegExp;
  readonly whenAborted?: boolean;
  run(ctx: StatementContext, params: readonly unknown[]): QueryResult | Promise<QueryResult>;
}

/** Runs a SELECT, INSERT, UPDATE or DELETE in the session's transaction, or in one of its own outside a transaction block. */
async function runData(ctx: StatementContext, params: readonly unknown[]): Promise<QueryResult> {
  const stmt = parseStatement(ctx.sql);
  const { store, session } = ctx;
  const own = session.tx === undefined;
  const tx = session.tx ?? store.begin(session);
  try {
    const out = await execute({ store, tx, params }, stmt);
    if (own) store.finish(tx, true);
    return out;
  } catch (err) {
    if (own) store.finish(tx, false);
    throw err;
  }
}

function openTx(ctx: StatementContext, statement: string): Tx {
  if (ctx.session.tx === undefined) throw pgError('25P01', `${statement} can only be used in transaction blocks`);
  return ctx.session.tx;
}

function savepointName(ctx: StatementContext, pattern: RegExp): string {
  return pattern.exec(ctx.normalized)?.[1] ?? unsupported('a savepoint name');
}

const IDENTIFIER = '([a-z_][a-z0-9_$]*)';
const ROLLBACK_TO = new RegExp(`^rollback(?: work| transaction)? to (?:savepoint )?${IDENTIFIER};?$`);
const SAVEPOINT = new RegExp(`^savepoint ${IDENTIFIER};?$`);
const RELEASE = new RegExp(`^release (?:savepoint )?${IDENTIFIER};?$`);

/** Matches `finance.<table>` in normalized SQL, either part quoted or not. */
function financeTable(table: string): RegExp {
  return new RegExp(`"?${SCHEMA}"?\\."?${table}"?(?![a-z0-9_$])`);
}

const PATTERNS: readonly SqlPattern[] = [
  {
    name: 'begin',
    match: /^(?:begin|start transaction)(?: work| transaction)?(?: isolation level read committed)?;?$/,
    run(ctx) {
      // BEGIN inside a transaction block only warns.
      ctx.session.tx ??= ctx.store.begin(ctx.session);
      return result('BEGIN');
    },
  },
  {
    name: 'commit',
    match: /^(?:commit|end)(?: work| transaction)?;?$/,
    whenAborted: true,
    run({ store, session }) {
      const { tx } = session;
      if (tx === undefined) return result('COMMIT');
      session.tx = undefined;
      // COMMIT of a failed transaction rolls it back and reports ROLLBACK.
      store.finish(tx, !tx.aborted);
      return result(tx.aborted ? 'ROLLBACK' : 'COMMIT');
    },
  },
  {
    name: 'rollback-to-savepoint',
    match: ROLLBACK_TO,
    whenAborted: true,
    run(ctx) {
      ctx.store.rollbackToSavepoint(openTx(ctx, 'ROLLBACK TO SAVEPOINT'), savepointName(ctx, ROLLBACK_TO));
      return result('ROLLBACK');
    },
  },
  {
    name: 'rollback',
    match: /^(?:rollback|abort)(?: work| transaction)?;?$/,
    whenAborted: true,
    run({ store, session }) {
      store.abandon(session);
      return result('ROLLBACK');
    },
  },
  {
    name: 'savepoint',
    match: SAVEPOINT,
    run(ctx) {
      ctx.store.savepoint(openTx(ctx, 'SAVEPOINT'), savepointName(ctx, SAVEPOINT));
      return result('SAVEPOINT');
    },
  },
  {
    name: 'release-savepoint',
    match: RELEASE,
    run(ctx) {
      ctx.store.releaseSavepoint(openTx(ctx, 'RELEASE SAVEPOINT'), savepointName(ctx, RELEASE));
      return result('RELEASE');
    },
  },
  { name: 'tenant-setting', match: /^select set_config\('app\.tenant_id', \$1, true\);?$/, run: runData },
  { name: 'lock-timeout', match: /^select (?:current_setting|set_config)\('lock_timeout'/, run: runData },
  { name: 'snapshot', match: /^select pg_snapshot_xm(?:in|ax)\(pg_current_snapshot\(\)\)/, run: runData },
  { name: 'advisory-lock', match: /^select pg_(?:try_)?advisory_xact_lock\(/, run: runData },
  { name: 'relation-probe', match: /^select to_regclass\(/, run: runData },
  { name: 'changelog-insert', match: new RegExp(`^insert into ${financeTable('changelog').source} `), run: runData },
  { name: 'changelog-page', match: new RegExp(`^select .* from ${financeTable('changelog').source}`), run: runData },
  { name: 'unit-gate', match: financeTable(UNIT_GATE_TABLE), run: runData },
  { name: 'open-operation', match: financeTable('open_operation'), run: runData },
  { name: 'tenant-registry', match: financeTable('tenant_registry'), run: runData },
  { name: 'tenant-grant', match: financeTable('tenant_grant'), run: runData },
  { name: 'inbox', match: financeTable('inbox'), run: runData },
  { name: 'consumer-aggregate-version', match: financeTable('consumer_aggregate_version'), run: runData },
  { name: 'migration-batch', match: financeTable('migration_batch'), run: runData },
  { name: 'migration-watermark', match: financeTable('migration_watermark'), run: runData },
  { name: 'program-binding', match: financeTable(PROGRAM_BINDING.table), run: runData },
  { name: 'insert', match: /^insert into /, run: runData },
  { name: 'update', match: /^update /, run: runData },
  { name: 'delete', match: /^delete from /, run: runData },
  { name: 'select', match: /^select /, run: runData },
];

/** The part of a pg client the transaction runner uses. */
interface FakeConnection {
  query(input: string | QueryConfig, values?: unknown[]): Promise<QueryResult>;
  release(err?: Error | boolean): void;
}

/** The part of a pg pool `tenantDbFromPool` uses; released sessions are reused, keeping their session-level settings as pg does. */
class FakePool {
  private ended = false;
  private readonly idle: Session[] = [];

  constructor(private readonly store: RecordingStore) {}

  connect(): Promise<FakeConnection> {
    if (this.ended) return Promise.reject(new Error('Cannot use a pool after calling end on the pool'));
    const session: Session = this.idle.pop() ?? { tx: undefined, settings: new Map() };
    let held = true;
    return Promise.resolve({
      query: (input, values) => (held ? this.store.run(session, input, values) : Promise.reject(new Error('Client was released to the pool'))),
      release: (err) => {
        if (!held) throw new Error('Release called on client which has already been released to the pool.');
        held = false;
        this.store.abandon(session);
        // An errored release destroys the connection instead of pooling it.
        if (err === undefined || err === false) this.idle.push(session);
      },
    });
  }

  async query(input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    const client = await this.connect();
    try {
      return await client.query(input, values);
    } finally {
      client.release();
    }
  }

  end(): Promise<void> {
    if (this.ended) return Promise.reject(new Error('Called end on pool more than once'));
    this.ended = true;
    this.idle.length = 0;
    return Promise.resolve();
  }

  /** Accepts pg's error listener; fake connections never fail while idle. */
  on(): this {
    return this;
  }
}

function handleOn(store: RecordingStore): TenantDb {
  return tenantDbFromPool(new FakePool(store) as unknown as Pool, { schema: SCHEMA });
}


/** A `finance.unit_gate` row as pg returns it. */
export type UnitGateRow = {
  unit: string;
  state: GateState;
  holder_id: string | null;
  phase: GatePhase;
  updated_at: Date;
};

/** A row of a platform table, keyed by column name. */
type PlatformRow = Record<string, unknown>;

/** Row shape of each table the recording db models. */
export interface RecordingRowTypes {
  record: FinanceRecordRow;
  record_version: FinanceRecordVersionRow;
  attachment: FinanceAttachmentRow;
  rollup: FinanceRollupRow;
  program_binding: ProgramBindingRow;
  staged_object: StagedObjectRow;
  unit_gate: UnitGateRow;
  tenant_registry: PlatformRow;
  tenant_grant: PlatformRow;
  changelog: PlatformRow;
  open_operation: PlatformRow;
  migration_batch: PlatformRow;
  migration_watermark: PlatformRow;
  inbox: PlatformRow;
  consumer_aggregate_version: PlatformRow;
}

/** A table of schema `finance`, by its bare name. */
export type RecordingTable = keyof RecordingRowTypes;

/** A table named bare or qualified with `finance`. */
export type RecordingTableName<T extends RecordingTable = RecordingTable> = T | `${typeof SCHEMA}.${T}`;

/** A seed row; omitted columns take their defaults. */
export type RecordingSeedRow<T extends RecordingTable = RecordingTable> = Readonly<Partial<RecordingRowTypes[T]>>;

/** Rows per table; a table named here replaces its default rows (open gates, the tenant-a and tenant-b program bindings). */
export type RecordingSeed = { readonly [T in RecordingTable]?: readonly RecordingSeedRow<T>[] };

/** Rows a `respond` override answers with, or the function computing them from the statement's parameters. */
export type RecordingAnswer = readonly QueryResultRow[] | ((params: readonly unknown[]) => readonly QueryResultRow[]);

/** Settings of {@link createRecordingDb}; `clock` gives LOCALTIMESTAMP, the transaction start, and the default rows' times. */
export interface RecordingDbOptions {
  clock?: Clock;
}

/** In-memory schema `finance` behind the platform transaction runner, with forced RLS, constraints, row locks and xids as pg has them. */
export interface RecordingDb extends TenantDb {
  /** Committed writes in commit order, changelog rows included. */
  writes(): readonly RecordedWrite[];
  /** Every statement run so far, in order. */
  queries(): readonly RecordedQuery[];
  /** Empties the write and statement logs; rows, gates and overrides stay. */
  clear(): void;
  /** Appends committed rows, completing omitted columns from their defaults. */
  seed<T extends RecordingTable>(table: RecordingTableName<T>, rows: readonly RecordingSeedRow<T>[]): void;
  /** Committed rows of `table`, optionally of one tenant only. */
  rows<T extends RecordingTable>(table: RecordingTableName<T>, tenantId?: string): RecordingRowTypes[T][];
  /** Answers statements matching `match` before any pattern does, newest override first; returns its removal. */
  respond(match: string | RegExp, answer: RecordingAnswer): () => void;
  /** The next statement matching `match` throws `error`, by default a SQLSTATE 40001 serialization failure. */
  failNext(match: string | RegExp, error?: Error): void;
  /** Sets the committed gate of `unit`; `legacy` refuses writes at once, while `closed` holds them for the platform's real 30 s budget, so suites fake only `Date` to pass it. */
  setGate(unit: string, state: GateState, phase?: GatePhase): void;
  /** Decimal xid of the last committed transaction that wrote, as `X-Opt2-Write-Position` carries it. */
  lastXid(): string | undefined;
  /** Another handle on the same rows with a pool of its own, as the attachment staging ledger needs. */
  handle(): TenantDb;
}

const recordingDbs = new WeakSet<TenantDb>();

function isRecordingDb(db: TenantDb): db is RecordingDb {
  return recordingDbs.has(db);
}

function defaultSeed(now: Date): RecordingSeed {
  return {
    unit_gate: UNITS.map((unit) => ({ unit, state: 'open', phase: 'quiet', holder_id: null, updated_at: now })),
    // legacy-fixtures/sql/010_program_site.sql binds program 1 to tenant-a and program 2 to tenant-b.
    program_binding: [TENANT_A, TENANT_B].map((tenant, i) => ({
      tenant_id: tenant.tenantId,
      site_id: tenant.siteId,
      legacy_program_id: i + 1,
      updated_at: now,
    })),
  };
}

/** Creates a {@link RecordingDb}; nothing connects to PostgreSQL. */
export function createRecordingDb(seed: RecordingSeed = {}, options: RecordingDbOptions = {}): RecordingDb {
  const store = new RecordingStore(catalogue(), options.clock ?? TEST_CLOCK);
  const unknown = Object.keys(seed).filter((name) => !store.catalog.has(name));
  if (unknown.length > 0) throw new TypeError(`the recording db models no table ${unknown.join(', ')}`);
  const rowsOf = (source: RecordingSeed, name: string): readonly Readonly<Record<string, unknown>>[] | undefined =>
    (source as Readonly<Record<string, readonly Readonly<Record<string, unknown>>[] | undefined>>)[name];
  const defaults = defaultSeed(store.clock.now());
  for (const name of store.catalog.keys()) {
    const rows = name in seed ? rowsOf(seed, name) : rowsOf(defaults, name);
    if (rows !== undefined && rows.length > 0) store.seedRows(name, rows);
  }
  const base = handleOn(store);
  const db: RecordingDb = {
    schema: base.schema,
    withTenant: (tenantId, fn) => base.withTenant(tenantId, fn),
    withMetadata: (fn, opts) => base.withMetadata(fn, opts),
    end: () => base.end(),
    writes: () => [...store.writeLog],
    queries: () => [...store.queryLog],
    clear() {
      store.writeLog.length = 0;
      store.queryLog.length = 0;
    },
    seed(table, rows) {
      store.seedRows(table, rows);
    },
    rows: <T extends RecordingTable>(table: RecordingTableName<T>, tenantId?: string) => store.committedRows(table, tenantId) as RecordingRowTypes[T][],
    respond(match, answer) {
      const override: Override = { matches: matcher(match), answer };
      store.overrides.unshift(override);
      return () => {
        const at = store.overrides.indexOf(override);
        if (at !== -1) store.overrides.splice(at, 1);
      };
    },
    failNext(match, error = pgError('40001', 'could not serialize access due to concurrent update')) {
      store.failures.push({ matches: matcher(match), error });
    },
    setGate(unit, state, phase = 'quiet') {
      store.setGate(unit, state, phase);
    },
    lastXid: () => store.lastWriteXid?.toString(),
    handle: () => handleOn(store),
  };
  recordingDbs.add(db);
  return Object.freeze(db);
}

/** CSRF token and expiry headers a fixture write sends; the identity double answers every token with its current verdict. */
export const CSRF_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [CSRF_HEADER_TOKEN]: 'OPT2FINANCETESTCSRFTOKEN',
  [CSRF_HEADER_EXPIRES]: '991231235959000',
});

/** Identity's CSRF consume route as the app's service client reaches it. */
export interface CsrfDouble {
  /** Consume requests identity received, in order. */
  readonly calls: readonly CsrfConsumeRequest[];
  /** Sets the `valid` verdict identity answers; initially true. */
  answer(valid: boolean): void;
}

/** Reporting's answer to an export source-scope lookup: a status and body, or an error the service client throws. */
export type ReportingScopeAnswer = { status: number; body?: unknown } | Error;

/** Reporting's export source-scope route as the app's service client reaches it. */
export interface ReportingDouble {
  /** Scope lookups reporting received, in order. */
  readonly lookups: readonly ServiceRequest[];
  /** Sets how reporting answers each later lookup; initially its notFound, as for a job it does not store. */
  answer(next: ReportingScopeAnswer | ((req: ServiceRequest) => ReportingScopeAnswer)): void;
}

/** Path of reporting's export source-scope lookup, with the job id in place. */
const REPORTING_SCOPE_PATH = /^\/internal\/v1\/exports\/[^/]+\/source-scope$/;

/** Reporting's legacy notFound envelope. */
const REPORTING_NOT_FOUND: ReportingScopeAnswer = { status: 404, body: { error: { code: 'invalid_request', message: 'Not Found' } } };

/**
 * Replaces `request` on the app's service client, which the CSRF hook and the export reads use at request time, with identity's
 * CSRF consume and reporting's scope lookup; any other service call throws.
 */
function installServiceDoubles(app: FastifyInstance): { csrf: CsrfDouble; reporting: ReportingDouble } {
  const calls: CsrfConsumeRequest[] = [];
  const lookups: ServiceRequest[] = [];
  let valid = true;
  let scope: ReportingScopeAnswer | ((req: ServiceRequest) => ReportingScopeAnswer) = REPORTING_NOT_FOUND;
  function request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (req.service === IDENTITY_SERVICE && req.method === 'POST' && req.path === CSRF_CONSUME_PATH) {
      calls.push(req.json as CsrfConsumeRequest);
      return Promise.resolve({ status: 200, headers: {}, body: { valid } as T });
    }
    if (req.service === 'reporting' && req.method === 'GET' && REPORTING_SCOPE_PATH.test(req.path)) {
      lookups.push(req);
      const answer = typeof scope === 'function' ? scope(req) : scope;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ status: answer.status, headers: { 'content-type': 'application/json' }, body: answer.body as T });
    }
    return Promise.reject(new Error(`finance test app made an unexpected service call: ${req.service} ${req.method} ${req.path}`));
  }
  Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  return {
    csrf: {
      calls,
      answer(next) {
        valid = next;
      },
    },
    reporting: {
      lookups,
      answer(next) {
        scope = next;
      },
    },
  };
}

type EventPublisher = NonNullable<BuildAppOptions['publisher']>;

/** Options of {@link buildTestApp}; it creates each dependency it is not given. */
export interface TestAppOptions<D extends TenantDb = RecordingDb, P extends EventPublisher = CapturingPublisher> {
  /** Overrides of {@link testEnv}. */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  /** Defaults to a recording db; a db of the caller's own needs `stagingDb` unless it is a recording db. */
  db?: D;
  stagingDb?: TenantDb;
  /** Seed of the recording db buildTestApp creates. */
  seed?: RecordingSeed;
  storage?: LocalStorageAdapter;
  publisher?: P;
  /** Seeds the platform fixture sites into `tenant_registry`; defaults to true for the recording db buildTestApp creates. */
  registry?: boolean;
  /** False returns the app before `ready`, so a suite can still add routes. */
  ready?: boolean;
}

/** A finance app under test with the fakes it runs on; closing the app removes a state directory testEnv created for it. */
export interface TestApp<D extends TenantDb = RecordingDb, P extends EventPublisher = CapturingPublisher> {
  readonly app: FastifyInstance;
  readonly db: D;
  readonly storage: LocalStorageAdapter;
  readonly publisher: P;
  readonly clock: Clock;
  readonly stateDir: string;
  readonly csrf: CsrfDouble;
  readonly reporting: ReportingDouble;
}

/** Builds the finance app for `app.inject` over local fakes; it never listens, and needs no PostgreSQL, emulator or network. */
export async function buildTestApp<D extends TenantDb = RecordingDb, P extends EventPublisher = CapturingPublisher>(
  opts: TestAppOptions<D, P> = {},
): Promise<TestApp<D, P>> {
  if (opts.db !== undefined && opts.seed !== undefined) throw new TypeError('buildTestApp: seed applies only to the recording db it creates');
  const env = await testEnv(opts.env);
  const stateDir = env.OPT2_STATE_DIR;
  const ownStateDir = opts.env === undefined || !('OPT2_STATE_DIR' in opts.env);
  const clock = opts.clock ?? TEST_CLOCK;
  let app: FastifyInstance | undefined;
  try {
    const storage = opts.storage ?? (await createLocalStorageAdapter({ stateDir, now: () => clock.now().getTime() }));
    const publisher = opts.publisher ?? (createCapturingPublisher() as unknown as P);
    const db: TenantDb = opts.db ?? createRecordingDb({ ...opts.seed }, { clock });
    const recording = isRecordingDb(db) ? db : undefined;
    if (opts.registry ?? opts.db === undefined) await seedRegistry(db, db.schema);
    app = await buildApp({ env, clock, verifierOverride: testVerifier(), db, stagingDb: opts.stagingDb ?? recording?.handle(), publisher, storage });
    const { csrf, reporting } = installServiceDoubles(app);
    if (ownStateDir) {
      app.addHook('onClose', (_instance, done) => {
        removeStateDir(stateDir);
        done();
      });
    }
    if (opts.ready !== false) {
      await app.ready();
      recording?.clear();
    }
    return { app, db: db as D, storage, publisher, clock, stateDir, csrf, reporting };
  } catch (err) {
    await app?.close().catch(() => undefined);
    if (ownStateDir) removeStateDir(stateDir);
    throw err;
  }
}

/** A subject `headersFor` accepts: a platform RoleSubject, the name of one in ROLE_SET, or a user's roles with optional fields. */
export type HeadersSubject = RoleSubject | string | (Pick<RoleSubject, 'roles'> & Partial<Omit<RoleSubject, 'roles'>>);

/** Options of {@link headersFor}; `csrf` (true by default) adds {@link CSRF_HEADERS} for user subjects. */
export interface HeadersOptions {
  site?: string;
  sub?: string;
  csrf?: boolean;
}

function roleSubject(subject: HeadersSubject): RoleSubject {
  if (typeof subject !== 'string') return { name: 'finance-test-user', kind: 'user', ...subject };
  const found = ROLE_SET.find((candidate) => candidate.name === subject);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject ${subject}`);
  return found;
}

/** Headers presenting `subject` to the finance app: the platform's tokens for audience `finance`, with the tenant from the token's `tid`. */
export async function headersFor(subject: HeadersSubject, { site = TENANT_A.siteId, sub, csrf = true }: HeadersOptions = {}): Promise<Record<string, string>> {
  const resolved = roleSubject(subject);
  const headers = await authHeadersFor(resolved, sub === undefined ? { site, audience: OWNER } : { site, audience: OWNER, sub });
  return resolved.kind === 'user' && csrf ? { ...headers, ...CSRF_HEADERS } : headers;
}

