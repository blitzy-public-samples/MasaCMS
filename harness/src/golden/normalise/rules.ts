import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from '@opt2/platform/service-kit';
import {
  COMPARE_KINDS,
  OVERRIDE_OPERATIONS,
  SCENARIO_ID_PATTERN,
  type OverrideOperation,
  type Scenario,
} from '../catalogue.js';
import { GoldenConfigError } from '../errors.js';
import { originBaseUrl, type Origin } from '../session.js';
import { repoPath, type EnvLike } from '../../lib/paths.js';
import { pinnedSha } from '../../lib/pin.js';

/** Default location of the golden normalisation rules. */
export const RULES_PATH: string = repoPath('harness/golden/normalise.yaml');

/** Ids of the four known legacy issues; each is masked at its declared location only. */
export const KNOWN_ISSUE_IDS = ['date-mask', 'session-rotation', 'header-search-404', 'default-member'] as const;
export type KnownIssueId = (typeof KNOWN_ISSUE_IDS)[number];

/** Whether `value` is one of {@link KNOWN_ISSUE_IDS}. */
export function isKnownIssueId(value: string): value is KnownIssueId {
  return (KNOWN_ISSUE_IDS as readonly string[]).includes(value);
}

const REQUIRED_TOKEN_FIELDS = ['csrf_token', 'csrf_token_expires', 'access_token', 'refresh_token', 'authToken', 'returnID'];
const REQUIRED_DROPPED_HEADERS = [
  'Date',
  'Server',
  'Content-Length',
  'Connection',
  'Keep-Alive',
  'Transfer-Encoding',
  'traceparent',
  'tracestate',
  'traceresponse',
  'X-Request-Id',
];
const REQUIRED_MAIL_DROPS = ['Message-ID', 'Date', 'Received'];
const REQUIRED_TIMESTAMP_FORMATS: readonly { label: string; matches: (format: string) => boolean }[] = [
  { label: 'ISO-8601', matches: (format) => format.startsWith('ISO-8601') },
  { label: "CF {ts '…'}", matches: (format) => format.startsWith("{ts '") },
  { label: 'yyyy-mm-dd', matches: (format) => format.toLowerCase() === 'yyyy-mm-dd' },
  { label: 'RFC 1123', matches: (format) => format.startsWith('RFC 1123') },
  { label: 'yyMMddHHnnsslll', matches: (format) => format === 'yyMMddHHnnsslll' },
];

// Keys whose values name other rules by id; every such reference must resolve.
const RULE_REFERENCE_KEYS = ['apply', 'urlRule', 'targetRule', 'aggregateId'] as const;

const lowerCase = (value: string): string => value.toLowerCase();
const identity = (value: string): string => value;

function compiles(source: string, flags = ''): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

function duplicates(values: readonly string[], fold: (value: string) => string = identity): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    const key = fold(value);
    if (seen.has(key)) repeated.add(value);
    seen.add(key);
  }
  return [...repeated];
}

function requireMembers(required: readonly string[], fold: (value: string) => string) {
  return (have: readonly string[], ctx: z.RefinementCtx): void => {
    const present = new Set(have.map(fold));
    for (const name of required) {
      if (!present.has(fold(name))) ctx.addIssue({ code: 'custom', message: `must include ${name}` });
    }
  };
}

const ruleId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lower-case kebab-case rule id');
const ruleRefs = z.array(ruleId).min(1);
const names = z.array(z.string().min(1));
const nonEmptyNames = names.min(1);
const placeholder = z.string().regex(/^<[^<>\s]+>$/, 'must be a <placeholder>');
const ordinalPlaceholder = placeholder.refine((value) => value.includes('{n}'), 'must contain the {n} ordinal slot');
const pattern = z
  .string()
  .min(1)
  .refine((source) => compiles(source), 'must be a valid regular expression');
const matchMode = z.enum(['case-insensitive', 'exact']);
const whitespaceMode = z.enum(['collapse-and-trim', 'exact']);
const contentTypes = z.array(z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, 'must be a MIME type')).min(1);
const scenarioRef = z.union([
  z.literal('*'),
  z.string().regex(SCENARIO_ID_PATTERN, 'must be * or a scenario id GS-<AREA>-NN'),
]);
const routeKeyRef = z
  .string()
  .regex(/^(?:\*|[a-z][a-z0-9]*:[^\sA-Z]+)$/, 'must be * or a canonical lower-case route key <family>:<body>');

const sessionOrigin = z.enum(['legacy', 'gateway']) satisfies z.ZodType<Origin>;

const originsSchema = z.strictObject({
  id: ruleId,
  placeholder,
  values: nonEmptyNames,
  defaults: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an environment variable name'), sessionOrigin),
  hostAliases: names,
  schemes: z.array(z.enum(['http', 'https'])).min(1),
  match: z.array(z.enum(['scheme-origin', 'host-port', 'percent-encoded-host-port'])).min(1),
});
/** Capture and replay origins, `values` resolved to concrete origins by {@link loadRules}. */
export type OriginRules = z.infer<typeof originsSchema>;

const idPatternFields = {
  id: ruleId,
  pattern: z.string().min(1),
  flags: z.string().regex(/^[imsuv]*$/, 'must hold only the i, m, s, u or v flags'),
  boundary: pattern,
  placeholder: ordinalPlaceholder,
  ordinal: z.literal('scenario'),
  ordinalKey: z.enum(['exact', 'case-insensitive']),
};

function checkIdPattern(rule: { pattern: string; flags: string }, ctx: z.RefinementCtx): void {
  if (!compiles(rule.pattern, rule.flags)) {
    ctx.addIssue({ code: 'custom', message: 'must be a valid regular expression with its flags', path: ['pattern'] });
  }
}

const idsSchema = z
  .strictObject({
    ...idPatternFields,
    keepLiteral: names,
    rfc4122: z.strictObject(idPatternFields).superRefine(checkIdPattern),
  })
  .superRefine(checkIdPattern);
/** CF UUID ordinals, plus the RFC 4122 variant. */
export type IdRules = z.infer<typeof idsSchema>;

const timestampClassSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lower-case kebab-case class name'),
  format: z.string().min(1),
  pattern,
  scope: z.literal('whole-value').optional(),
  keys: nonEmptyNames.optional(),
});
/** One timestamp format class, matched in declaration order. */
export type TimestampClassRule = z.infer<typeof timestampClassSchema>;

const timestampsSchema = z.strictObject({
  id: ruleId,
  placeholder,
  assertSameFormatClass: z.boolean(),
  classification: z.literal('first-listed-wins'),
  boundary: pattern,
  keyMatch: z.literal('glob-case-insensitive'),
  classes: z
    .array(timestampClassSchema)
    .min(1)
    .superRefine((classes, ctx) => {
      for (const name of duplicates(classes.map((c) => c.name))) {
        ctx.addIssue({ code: 'custom', message: `declares class ${name} more than once` });
      }
      for (const required of REQUIRED_TIMESTAMP_FORMATS) {
        if (!classes.some((c) => required.matches(c.format))) {
          ctx.addIssue({ code: 'custom', message: `must include a ${required.label} format class` });
        }
      }
    }),
  dateOnlyFields: names,
  dateOnlyFieldMatch: z.literal('ignore-case-and-underscores'),
  dateOnlyFieldKinds: z.array(z.enum(['json-keys', 'form-fields', 'query-params', 'column-headers'])).min(1),
});
/** Timestamp classification and the date-only fields. */
export type TimestampRules = z.infer<typeof timestampsSchema>;

const tokensSchema = z.strictObject({
  id: ruleId,
  placeholder,
  fields: nonEmptyNames.superRefine(requireMembers(REQUIRED_TOKEN_FIELDS, lowerCase)),
  fieldMatch: matchMode,
  headers: names,
  headerMatch: matchMode,
  queryParams: names,
  queryParamMatch: matchMode,
  htmlInputs: names,
});
/** Fields, headers, query parameters and inputs whose values become the token placeholder. */
export type TokenRules = z.infer<typeof tokensSchema>;

const urlsSchema = z.strictObject({
  id: ruleId,
  placeholder,
  signedQueryParams: names,
  pathPrefixes: z.array(z.string().startsWith('/', 'must start with /')),
  downloadFields: z.array(z.strictObject({ key: z.string().min(1), whenContains: nonEmptyNames.optional() })),
  downloadFieldMatch: matchMode,
  otherwise: z.strictObject({ apply: ruleRefs, sortQuery: z.boolean() }),
});
/** Signed and download URLs, and the rules applied to every other URL. */
export type UrlRules = z.infer<typeof urlsSchema>;

const headersSchema = z.strictObject({
  id: ruleId,
  match: z.literal('case-insensitive'),
  drop: nonEmptyNames.superRefine(requireMembers(REQUIRED_DROPPED_HEADERS, lowerCase)),
  etag: z.strictObject({
    id: ruleId,
    header: z.string().min(1),
    contentTypes,
    check: z.literal('format-and-self-consistency'),
    format: pattern,
    selfConsistency: z.enum(['uppercase-sha256-of-raw-body', 'uppercase-md5-of-raw-body']),
    placeholder,
    mismatchPlaceholder: placeholder,
    otherContentTypes: z.literal('compare-exact'),
  }),
  location: z.strictObject({
    id: ruleId,
    header: z.string().min(1),
    normalise: z.literal('as-body-url'),
    apply: ruleRefs,
  }),
  compare: z.strictObject({
    id: ruleId,
    names: z.literal('lower-case'),
    values: z.literal('exact-after-rules'),
    apply: ruleRefs,
    alwaysCompared: names,
  }),
});
/** Dropped headers, the ETag check, `Location` and how the remaining headers compare. */
export type HeaderRules = z.infer<typeof headersSchema>;

const authSchema = z.strictObject({
  id: ruleId,
  cookies: z.strictObject({
    header: z.string().min(1),
    value: placeholder,
    names: z.literal('exact'),
    keepAttributes: names,
    attributeNames: z.literal('case-insensitive'),
    persistence: z.strictObject({
      from: nonEmptyNames,
      reference: z.literal('response-date'),
      classes: z.array(z.enum(['session', 'persistent', 'expired'])).min(1),
    }),
    sessionNames: nonEmptyNames,
  }),
  compareHeaders: names,
  compareHeaderValues: z.literal('exact'),
  redirects: z.strictObject({
    compare: z.literal('target'),
    statuses: z.array(z.number().int().min(300).max(399)).min(1),
    targetRule: ruleId,
  }),
});
/** Cookie, `WWW-Authenticate` and redirect comparison. */
export type AuthRules = z.infer<typeof authSchema>;

const envelopeSchema = z.strictObject({
  id: ruleId,
  contentTypes,
  fields: nonEmptyNames,
  errorFields: nonEmptyNames,
  comparison: z.literal('deep-equal-after-normalisation'),
  keyCase: z.literal('exact'),
  apply: ruleRefs,
  stacktrace: z.strictObject({ id: ruleId, optIn: z.boolean(), dropPaths: nonEmptyNames }),
});
/** Masa JSON envelope comparison. */
export type EnvelopeRules = z.infer<typeof envelopeSchema>;

const domTake = z.array(z.string().regex(/^[a-z][a-z-]*$/, 'must be a lower-case attribute or extraction name')).min(1);
const domExtractSchema = z.strictObject({
  selector: z.string().min(1),
  take: domTake,
  rows: z.string().min(1).optional(),
  cells: z.string().min(1).optional(),
  options: z.strictObject({ selector: z.string().min(1), take: domTake }).optional(),
  omitValueWhen: z.record(z.string().min(1), z.string().min(1)).optional(),
  urlRule: ruleId.optional(),
});
/** One DOM-model extraction: what to select and which parts to keep. */
export type DomExtractRule = z.infer<typeof domExtractSchema>;

const domSchema = z.strictObject({
  id: ruleId,
  parser: z.literal('cheerio'),
  screenshots: z.literal('review-only'),
  exclude: names,
  whitespace: whitespaceMode,
  apply: ruleRefs,
  extract: z.strictObject({
    title: domExtractSchema,
    headings: domExtractSchema,
    labels: domExtractSchema,
    controls: domExtractSchema,
    buttons: domExtractSchema,
    links: domExtractSchema,
    tables: domExtractSchema,
    alerts: domExtractSchema,
    forms: domExtractSchema,
  }),
  actionUrl: z.strictObject({
    id: ruleId,
    attributes: nonEmptyNames,
    apply: ruleRefs,
    lowerCaseValuesOf: names,
    paramNames: matchMode,
    keepParamOrder: z.boolean(),
    ampersandEntity: z.literal('equal'),
  }),
});
/** Admin HTML DOM model and admin action URLs. */
export type DomRules = z.infer<typeof domSchema>;

const exportsSchema = z.strictObject({
  id: ruleId,
  apply: ruleRefs,
  csv: z.strictObject({ parser: z.literal('csv-parse'), compare: z.literal('cells'), whitespace: whitespaceMode }),
  xlsx: z.strictObject({
    parser: z.literal('exceljs'),
    compare: z.literal('cells-per-sheet'),
    sheetNames: z.enum(['compare', 'ignore']),
    dates: z.literal('iso-before-timestamp-rule'),
  }),
  pdf: z.strictObject({ parser: z.literal('pdfjs-dist'), compare: z.literal('text-per-page'), whitespace: whitespaceMode }),
  file: z.strictObject({ compare: z.array(z.enum(['sha256', 'contentType', 'contentDispositionFilename'])).min(1) }),
  neverCompareBytes: z.array(z.enum(['csv', 'xlsx', 'pdf'])),
});
/** CSV, XLSX, PDF and downloaded-file comparison. */
export type ExportRules = z.infer<typeof exportsSchema>;

const transitionsSchema = z.strictObject({
  id: ruleId,
  compare: z.literal('ordered-state-sequence-per-aggregate'),
  aggregateId: ruleRefs,
  stateNames: z.literal('literal'),
});
/** Status-transition sequences per aggregate. */
export type TransitionRules = z.infer<typeof transitionsSchema>;

const mailSchema = z.strictObject({
  id: ruleId,
  source: z.literal('mailpit-api'),
  compare: nonEmptyNames,
  htmlText: z.literal('cheerio-text'),
  dropHeaders: nonEmptyNames.superRefine(requireMembers(REQUIRED_MAIL_DROPS, lowerCase)),
  apply: ruleRefs,
  order: nonEmptyNames,
});
/** Mailpit message comparison. */
export type MailRules = z.infer<typeof mailSchema>;

const rowsSchema = z.strictObject({
  id: ruleId,
  source: z.literal('canonical'),
  target: z.string().startsWith('/', 'must start with /'),
  legacy: z.literal('read-only-sql'),
  encoding: z.string().min(1),
  order: z.literal('key'),
  keyForm: z.literal('normalised'),
  keyless: z.literal('multiset-with-counts'),
  apply: ruleRefs,
  literal: z.strictObject({ money: pattern, dateOnlyFields: z.boolean() }),
});
/** Stored-row comparison over canonical encodings. */
export type RowRules = z.infer<typeof rowsSchema>;

const tasksSchema = z.strictObject({
  id: ruleId,
  compare: nonEmptyNames,
  base: z.strictObject({ requestFields: nonEmptyNames, fallback: z.literal('earliest-task-time') }),
  times: z.literal('offset-seconds-from-base'),
  apply: ruleRefs,
  order: nonEmptyNames,
});
/** Scheduled-task comparison as offsets from the scheduling base. */
export type TaskRules = z.infer<typeof tasksSchema>;

const filesSchema = z.strictObject({
  id: ruleId,
  compare: nonEmptyNames,
  variants: nonEmptyNames,
  apply: ruleRefs,
});
/** Stored file-variant comparison. */
export type FileRules = z.infer<typeof filesSchema>;

const knownIssueScopeSchema = z
  .strictObject({
    compareKinds: z.array(z.enum(COMPARE_KINDS)).min(1).optional(),
    selectors: nonEmptyNames.optional(),
    textPattern: pattern.optional(),
    headers: nonEmptyNames.optional(),
    cookieNames: nonEmptyNames.optional(),
    observations: z.array(z.enum(['presence', 'absence', 'value-equal-across-login'])).min(1).optional(),
    attributes: nonEmptyNames.optional(),
    steps: z
      .strictObject({
        knownIssue: z.enum(KNOWN_ISSUE_IDS),
        parts: z.array(z.enum(['status', 'body'])).min(1),
        appliesTo: z.array(scenarioRef).min(1),
      })
      .optional(),
  })
  .refine(
    (scope) => [scope.selectors, scope.headers, scope.cookieNames, scope.steps].some((part) => part !== undefined),
    'must declare a location: selectors, headers, cookieNames or steps',
  );
/** Where a known-issue mask applies: selectors, headers, cookies, or the status and body of flagged steps. */
export type KnownIssueScope = z.infer<typeof knownIssueScopeSchema>;

const knownIssueSchema = z
  .strictObject({
    id: z.enum(KNOWN_ISSUE_IDS),
    title: z.string().min(1),
    scope: knownIssueScopeSchema,
    source: z.array(z.string().regex(/^[\w./-]+:\d+(?:-\d+)?$/, 'must be <path>:<line>[-<line>]')).min(1),
    routeKeys: z.array(routeKeyRef).min(1),
    appliesTo: z.array(scenarioRef).min(1),
    report: z.literal('known-issue'),
  })
  .superRefine((issue, ctx) => {
    if (issue.scope.steps !== undefined && issue.scope.steps.knownIssue !== issue.id) {
      ctx.addIssue({ code: 'custom', message: `must name its own id ${issue.id}`, path: ['scope', 'steps', 'knownIssue'] });
    }
  });
/** One known-issue mask definition. */
export type KnownIssueRule = z.infer<typeof knownIssueSchema>;

const knownIssuesSchema = z
  .array(knownIssueSchema)
  .superRefine((issues, ctx) => {
    const ids = issues.map((issue) => issue.id);
    for (const id of KNOWN_ISSUE_IDS) {
      if (!ids.includes(id)) ctx.addIssue({ code: 'custom', message: `must declare known issue ${id}` });
    }
    for (const id of duplicates(ids)) {
      ctx.addIssue({ code: 'custom', message: `declares known issue ${id} more than once` });
    }
  });

/** Scenario overrides applied to a rules object; every list is empty as loaded. */
export type AppliedOverrides = { scenario: string | null } & Record<OverrideOperation, string[]>;

function emptyApplied(): AppliedOverrides {
  return {
    scenario: null,
    dropPaths: [],
    literalPaths: [],
    extraTokenFields: [],
    dropHeaders: [],
    applyRules: [],
    domExclude: [],
    sortArrays: [],
  };
}

function overrideOperation<V extends string>(value: V) {
  return z.strictObject({ value: z.literal(value), description: z.string().min(1) });
}

// `applied` is added after parsing, so the file itself can never carry scenario overrides.
const overridesSchema = z
  .strictObject({
    scope: z.literal('scenario'),
    knownIssueScoping: z.literal('fixed'),
    pathSyntax: z.string().min(1),
    operations: z.strictObject({
      dropPaths: overrideOperation('json-paths'),
      literalPaths: overrideOperation('json-paths'),
      extraTokenFields: overrideOperation('field-names'),
      dropHeaders: overrideOperation('header-names'),
      applyRules: overrideOperation('rule-ids'),
      domExclude: overrideOperation('css-selectors'),
      sortArrays: overrideOperation('json-paths'),
    }) satisfies z.ZodType<Record<OverrideOperation, unknown>>,
  })
  .transform((section) => ({ ...section, applied: emptyApplied() }));
/** The scenario-override operations the catalogue may use, and the overrides currently applied. */
export type OverrideRules = z.infer<typeof overridesSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eachObject(
  value: unknown,
  visit: (entry: Record<string, unknown>, path: readonly PropertyKey[]) => void,
  path: readonly PropertyKey[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => eachObject(item, visit, [...path, index]));
  } else if (isRecord(value)) {
    visit(value, path);
    for (const [key, child] of Object.entries(value)) eachObject(child, visit, [...path, key]);
  }
}

function checkRuleGraph(doc: unknown, ctx: z.RefinementCtx): void {
  const declared = new Map<string, string>();
  eachObject(doc, (entry, path) => {
    if (typeof entry.id !== 'string') return;
    const first = declared.get(entry.id);
    if (first === undefined) declared.set(entry.id, path.map(String).join('.'));
    else ctx.addIssue({ code: 'custom', message: `duplicate rule id ${entry.id}, first declared at ${first}`, path: [...path, 'id'] });
  });
  eachObject(doc, (entry, path) => {
    for (const key of RULE_REFERENCE_KEYS) {
      const ref = entry[key];
      const refs = typeof ref === 'string' ? [ref] : Array.isArray(ref) ? ref : [];
      refs.forEach((id: unknown, index) => {
        if (typeof id === 'string' && !declared.has(id)) {
          const at = typeof ref === 'string' ? [...path, key] : [...path, key, index];
          ctx.addIssue({ code: 'custom', message: `names unknown rule id ${id}`, path: at });
        }
      });
    }
  });
}

/** The `harness/golden/normalise.yaml` document; origins stay templates until {@link loadRules} resolves them. */
export const normaliseRulesSchema = z
  .strictObject({
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase hex commit id'),
    version: z.literal(1),
    origins: originsSchema,
    ids: idsSchema,
    timestamps: timestampsSchema,
    tokens: tokensSchema,
    urls: urlsSchema,
    headers: headersSchema,
    auth: authSchema,
    envelope: envelopeSchema,
    dom: domSchema,
    exports: exportsSchema,
    transitions: transitionsSchema,
    mail: mailSchema,
    rows: rowsSchema,
    tasks: tasksSchema,
    files: filesSchema,
    knownIssues: knownIssuesSchema,
    overrides: overridesSchema,
  })
  .superRefine(checkRuleGraph);
/** Validated, deep-frozen normalisation rules. */
export type NormaliseRules = z.infer<typeof normaliseRulesSchema>;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function pointer(file: string, path: readonly PropertyKey[]): string {
  const segments = path.map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1'));
  return `${file}#/${segments.join('/')}`;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

const TEMPLATE_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Environment values win; an unset variable takes the session origin its default names, as requests do.
function resolveOrigins(origins: OriginRules, env: EnvLike, file: string): string[] {
  const fail = (message: string, index: number, cause?: unknown): never => {
    throw new GoldenConfigError(`normalise rules ${file}: origins.values.${index}: ${message}`, {
      path: pointer(file, ['origins', 'values', index]),
      cause,
    });
  };
  const sessionBaseUrl = (origin: Origin, name: string, index: number): string => {
    try {
      return originBaseUrl(origin, env);
    } catch (err) {
      if (!(err instanceof GoldenConfigError)) throw err;
      return fail(`\${${name}} is not set and its ${origin} session origin is unresolved: ${err.message}`, index, err);
    }
  };
  const expand = (template: string, index: number): string =>
    template.replace(TEMPLATE_VARIABLE, (_match, name: string) => {
      const fromEnv = env[name];
      if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
      const fallback = origins.defaults[name];
      if (fallback === undefined) return fail(`\${${name}} is not set and has no default`, index);
      return sessionBaseUrl(fallback, name, index);
    });
  return origins.values.map((template, index) => {
    const value = expand(template, index);
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    const scheme = url?.protocol.slice(0, -1) ?? '';
    if (url === undefined || url.href !== `${url.origin}/` || !(origins.schemes as readonly string[]).includes(scheme)) {
      return fail(`${template} resolves to ${value}, which is not an ${origins.schemes.join(' or ')} origin`, index);
    }
    return url.origin;
  });
}

/**
 * Reads and validates the rules at `path`, binds the pinned source SHA and resolves origins from `env`.
 * Throws `GoldenConfigError` when the file cannot be read or parsed, fails the schema, carries another
 * source SHA, or leaves an origin variable unresolved.
 */
export function loadRules(path: string = RULES_PATH, env: EnvLike = process.env): NormaliseRules {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new GoldenConfigError(`normalise rules ${path} cannot be read: ${(err as Error).message}`, { path, cause: err });
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new GoldenConfigError(`normalise rules ${path} are not valid YAML: ${(err as Error).message}`, {
      path,
      cause: err,
    });
  }
  const parsed = normaliseRulesSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GoldenConfigError(`normalise rules ${path}: ${describeIssues(parsed.error)}`, {
      path: pointer(path, parsed.error.issues[0]?.path ?? []),
      cause: parsed.error,
    });
  }
  const pinned = pinnedSha();
  if (parsed.data.sourceSha !== pinned) {
    throw new GoldenConfigError(
      `normalise rules ${path}: sourceSha ${parsed.data.sourceSha} does not match the pinned source SHA ${pinned}`,
      { path: pointer(path, ['sourceSha']) },
    );
  }
  const values = resolveOrigins(parsed.data.origins, env, path);
  return deepFreeze({ ...parsed.data, origins: { ...parsed.data.origins, values } });
}

function ruleEntries(rules: NormaliseRules): Map<string, Record<string, unknown>> {
  const entries = new Map<string, Record<string, unknown>>();
  eachObject(rules, (entry) => {
    if (typeof entry.id === 'string' && !entries.has(entry.id)) entries.set(entry.id, entry);
  });
  return entries;
}

/** Every rule id declared across all sections, known-issue ids included. */
export function ruleIds(rules: NormaliseRules): ReadonlySet<string> {
  return new Set(ruleEntries(rules).keys());
}

/** Whether rule `id` is active: an opt-in rule only once applied overrides name it; throws for an unknown id. */
export function ruleEnabled(rules: NormaliseRules, id: string): boolean {
  const entry = ruleEntries(rules).get(id);
  if (entry === undefined) throw new GoldenConfigError(`normalise rules declare no rule ${id}`);
  return entry.optIn !== true || rules.overrides.applied.applyRules.includes(id);
}

function union(base: readonly string[], extra: readonly string[], fold: (value: string) => string): string[] {
  const seen = new Set(base.map(fold));
  const merged = [...base];
  for (const value of extra) {
    if (!seen.has(fold(value))) merged.push(value);
    seen.add(fold(value));
  }
  return merged;
}

/**
 * New deep-frozen rules with a scenario's `normalisationOverrides` applied: token fields, dropped headers and
 * DOM exclusions are merged into their sections, and every operation is recorded in `overrides.applied`.
 * Returns `rules` itself when there is nothing to apply.
 * @param scenarioId Scenario the overrides belong to, named in errors and recorded in `overrides.applied`.
 */
export function applyOverrides(
  rules: NormaliseRules,
  overrides: Scenario['normalisationOverrides'] | undefined,
  scenarioId?: string,
): NormaliseRules {
  if (overrides === undefined || OVERRIDE_OPERATIONS.every((op) => (overrides[op]?.length ?? 0) === 0)) return rules;
  const owner = scenarioId ?? 'scenario';
  const fail = (message: string): never => {
    throw new GoldenConfigError(`${owner} normalisationOverrides: ${message}`, {
      path: scenarioId === undefined ? undefined : `scenario ${scenarioId}`,
    });
  };
  const previous = rules.overrides.applied.scenario;
  if (previous !== null && scenarioId !== undefined && previous !== scenarioId) {
    fail(`rules already carry the overrides of scenario ${previous}`);
  }
  const known = ruleIds(rules);
  for (const id of overrides.applyRules ?? []) {
    if (!known.has(id)) fail(`applyRules names unknown rule id ${id}`);
    if (isKnownIssueId(id)) fail(`applyRules names known-issue mask ${id}, whose scoping is fixed`);
  }

  const tokenFold = rules.tokens.fieldMatch === 'case-insensitive' ? lowerCase : identity;
  const applied = { ...rules.overrides.applied, scenario: scenarioId ?? previous };
  for (const op of OVERRIDE_OPERATIONS) {
    const fold = op === 'dropHeaders' ? lowerCase : op === 'extraTokenFields' ? tokenFold : identity;
    applied[op] = union(rules.overrides.applied[op], overrides[op] ?? [], fold);
  }
  return deepFreeze({
    ...rules,
    tokens: { ...rules.tokens, fields: union(rules.tokens.fields, applied.extraTokenFields, tokenFold) },
    headers: { ...rules.headers, drop: union(rules.headers.drop, applied.dropHeaders, lowerCase) },
    dom: { ...rules.dom, exclude: union(rules.dom.exclude, applied.domExclude, identity) },
    overrides: { ...rules.overrides, applied },
  });
}
