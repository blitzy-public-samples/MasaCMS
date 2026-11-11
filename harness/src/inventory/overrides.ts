import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from '@opt2/platform/service-kit';
import { repoPath } from '../lib/paths.js';
import { pinnedSha } from '../lib/pin.js';

/** Default location of the reviewed admin role-gate overrides. */
export const ROLE_OVERRIDES_PATH: string = repoPath('harness/inventory/role-overrides.yaml');

/** Default location of the reviewed legacy table-writer overrides. */
export const WRITER_OVERRIDES_PATH: string = repoPath('harness/inventory/writer-overrides.yaml');

/** How a legacy writer is reached: an inventoried request, an ACF task, a `cfthread`, or application start-up. */
export const Trigger = z.enum(['request', 'scheduler', 'thread', 'appstart']);
export type Trigger = z.infer<typeof Trigger>;

/** Change a writer makes to the session user's login state. */
export const SessionEffects = z.enum(['none', 'login', 'logout', 'relogin']);
export type SessionEffects = z.infer<typeof SessionEffects>;

/** Kind of write a writer performs. */
export const WriterOp = z.enum(['insert', 'update', 'delete', 'save', 'schedule']);
export type WriterOp = z.infer<typeof WriterOp>;

/** Mechanism that keeps a non-request writer from running outside a write window, by cut-over validator id. */
export const PreventedBy = z.enum([
  'scheduler-registration',
  'native-sitemonitor-task',
  'startup-url-conversion',
  'fixture-survey-tasks',
  'fixture-export-threads',
]);
export type PreventedBy = z.infer<typeof PreventedBy>;

/** One role term of a legacy gate; `m:<nnn>` is a core module grant and `deny` refuses every caller. */
export type RoleName = 'public' | 'member' | 'system-user' | 'site-admin' | 's2' | 'deny' | `m:${string}`;

/** A gate's role requirement: one role term, or any or all of nested requirements. */
export type RequiredRole = RoleName | { anyOf: RequiredRole[] } | { allOf: RequiredRole[] };

const ROLE_TERM = /^(?:public|member|system-user|site-admin|s2|deny|m:\d{3})$/;
const ROLE_TEMPLATE_TERM = /^(?:public|member|system-user|site-admin|s2|deny|m:(?:\d{3}|X))$/;

function roleExpression(term: RegExp, terms: string): z.ZodType<RequiredRole> {
  const leaf = z.custom<RoleName>((value) => typeof value === 'string' && term.test(value));
  const expression: z.ZodType<RequiredRole> = z.lazy(() =>
    z.union(
      [
        leaf,
        z.strictObject({ anyOf: z.array(expression).min(1) }),
        z.strictObject({ allOf: z.array(expression).min(1) }),
      ],
      { error: `must be one of ${terms}, or {anyOf: [...]} or {allOf: [...]} of such terms` },
    ),
  );
  return expression;
}

/** Role requirement of a gate, an override or one of its conditions. */
export const RequiredRole: z.ZodType<RequiredRole> = roleExpression(
  ROLE_TERM,
  'public, member, system-user, site-admin, s2, deny, m:<3 digits>',
);

/** Role requirement of an extractor pattern, where `m:X` stands for the matched module id's last three digits. */
export const RequiredRoleTemplate: z.ZodType<RequiredRole> = roleExpression(
  ROLE_TEMPLATE_TERM,
  'public, member, system-user, site-admin, s2, deny, m:<3 digits>, m:X',
);

const text = z.string().min(1);

const commitSha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase hex commit id');

const repoRelativePath = z
  .string()
  .refine(
    (p) => !p.includes('\\') && p.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'must be a repository-relative path with / separators',
  );

/** Source location of an inventory entry: a repository-relative path and an inclusive `[start, end]` line range. */
export const SourceRef = z.strictObject({
  path: repoRelativePath,
  lines: z
    .tuple([z.int().min(1), z.int().min(1)])
    .refine(([start, end]) => start <= end, 'start line must not exceed end line'),
});
export type SourceRef = z.infer<typeof SourceRef>;

const GateScope = z.enum(['request', 'session', 'siteSetting', 'config']);

const NodeVerdict = z.enum(['editor', 'author', 'read', 'deny', 'none']);

interface Identified {
  id: string;
}

/** Flags each id of `items` already in `seen`, case-insensitively; lists sharing one id namespace share `seen`. */
function flagDuplicateIds(
  ctx: z.RefinementCtx,
  items: readonly Identified[],
  path: readonly (string | number)[],
  seen: Set<string> = new Set(),
): void {
  items.forEach((item, index) => {
    const key = item.id.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', message: `duplicate id ${item.id}`, path: [...path, index, 'id'] });
    }
    seen.add(key);
  });
}

// Patterns carry the reviewed prose `shape`, not a regex: controllers.ts implements the matcher for each id.
const extractorPattern = z.strictObject({
  id: z.enum(['P0', 'P1', 'P2', 'P3', 'P4', 'P5']),
  shape: text,
  requiredRole: RequiredRoleTemplate,
  examples: z.array(text).optional(),
});

const gateRule = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/, 'must be a lower-case slug'),
    on: GateScope,
    predicate: text,
    outcome: text.optional(),
    redirect: z.enum(['clogin.logout', 'cMessage.noaccess']).optional(),
    source: SourceRef,
  })
  .refine((rule) => (rule.outcome === undefined) !== (rule.redirect === undefined), {
    message: 'exactly one of outcome or redirect is required',
  });

const applicationGate = z.strictObject({
  source: SourceRef,
  siteFrom: z.strictObject({
    order: z.array(text).min(1),
    except: z.strictObject({ action: text, order: z.array(text).min(1) }).optional(),
    unknownSite: text,
    source: SourceRef,
  }),
  siteArray: z.strictObject({ requiredRole: RequiredRole, built: text, cleared: text, source: SourceRef }),
  anonymous: text,
  rules: z.array(gateRule).min(1),
});

const denialDefault = z.strictObject({ source: SourceRef, anonymous: text, authenticated: text });

const roleCondition = z.strictObject({
  on: GateScope,
  predicate: text,
  requiredRole: RequiredRole,
  denial: text.optional(),
  source: SourceRef,
});

const roleOverride = z
  .looseObject({
    id: z.string().regex(/^role:[a-z0-9]+\.([a-z0-9]+|\*)$/i, 'must be role:<circuit>.<action> or role:<circuit>.*'),
    circuit: text,
    action: text,
    requiredRole: RequiredRole,
    siteFrom: z.union([text.transform((site) => [site]), z.array(text).min(1)]).optional(),
    when: z.array(roleCondition).min(1).optional(),
    nodePermission: z
      .strictObject({
        verdicts: z.array(NodeVerdict).min(1),
        precedence: SourceRef,
        denial: text.optional(),
        source: SourceRef,
      })
      .optional(),
    denial: text.optional(),
    gate: SourceRef,
    reason: text,
  })
  .refine((o) => o.id.toLowerCase() === `role:${o.circuit}.${o.action}`.toLowerCase(), {
    message: 'must equal role:<circuit>.<action>',
    path: ['id'],
  });

/** Schema of `harness/inventory/role-overrides.yaml`; override entries may carry extra reviewer keys. */
export const roleOverridesSchema = z
  .strictObject({
    sourceSha: commitSha,
    extractorPatterns: z.array(extractorPattern).min(1),
    applicationGate,
    denialDefault,
    overrides: z.array(roleOverride),
  })
  .superRefine((doc, ctx) => {
    flagDuplicateIds(ctx, doc.extractorPatterns, ['extractorPatterns']);
    flagDuplicateIds(ctx, doc.applicationGate.rules, ['applicationGate', 'rules']);
    flagDuplicateIds(ctx, doc.overrides, ['overrides']);
  });

/** A validated role-overrides document. */
export type RoleOverrides = z.infer<typeof roleOverridesSchema>;
/** A `before()` shape the extractor classifies, with its role template. */
export type ExtractorPattern = RoleOverrides['extractorPatterns'][number];
/** The admin application gate that runs before every circuit's own gate. */
export type ApplicationGate = RoleOverrides['applicationGate'];
/** A reviewed classification of one circuit action, or of every action with `*`. */
export type RoleOverride = RoleOverrides['overrides'][number];

const tableName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/, 'must be a lower-cased legacy table name');

const writerId = z.string().regex(/^wov:[a-z0-9-]+$/, 'must be wov:<lower-case slug>');

const writerFields = z.strictObject({
  id: writerId,
  tables: z.array(tableName).optional(),
  tablesFrom: z.strictObject({ job: text }).optional(),
  columns: z.array(text).min(1).optional(),
  component: repoRelativePath,
  method: text.nullable(),
  op: WriterOp,
  source: SourceRef,
  routeKeys: z.array(text),
  entryScope: z.strictObject({ families: z.array(text).min(1), when: text }).optional(),
  keyScope: z.union([z.literal('table'), z.array(text).min(1)]),
  trigger: Trigger,
  sessionEffects: SessionEffects,
  condition: text.optional(),
  noGroupJoin: z.boolean().optional(),
  preventedBy: PreventedBy.optional(),
  dynamic: z.boolean().optional(),
  reason: text,
});

type WriterFields = z.infer<typeof writerFields>;

/** A reviewed legacy writer; it names its tables directly or through a scheduled job's steps. */
export type WriterOverride = Omit<WriterFields, 'tables' | 'tablesFrom'> &
  ({ tables: string[]; tablesFrom?: undefined } | { tables?: undefined; tablesFrom: { job: string } });

const writerOverride = writerFields
  .superRefine((w, ctx) => {
    if ((w.tables === undefined) === (w.tablesFrom === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'exactly one of tables or tablesFrom is required', path: ['tables'] });
    }
    if (w.tables?.length === 0 && w.dynamic !== true) {
      ctx.addIssue({ code: 'custom', message: 'must list a table unless dynamic is true', path: ['tables'] });
    }
    if (w.preventedBy !== undefined && w.trigger === 'request') {
      ctx.addIssue({ code: 'custom', message: 'only writers whose trigger is not request', path: ['preventedBy'] });
    }
    // A request writer reached before dispatch on any request of its families names an entryScope, not route keys.
    if (w.trigger === 'request' && w.routeKeys.length === 0 && w.dynamic !== true && w.entryScope === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a request writer needs route keys unless dynamic is true or it has an entryScope',
        path: ['routeKeys'],
      });
    }
  })
  .transform((w) => w as WriterOverride);

/** Why a settled call adds no writer: not executed CFML, writes no table, cannot run at the pin, or already counted. */
export const SettledResolution = z.enum(['not-cfml', 'non-write', 'unreachable', 'counted']);
export type SettledResolution = z.infer<typeof SettledResolution>;

/** Reviewed resolution of the unresolved calls in one source span; `countedBy` names what counts their writes. */
export const settledCallSchema = z
  .strictObject({
    id: writerId,
    source: SourceRef,
    calls: z.array(text).min(1),
    resolution: SettledResolution,
    countedBy: z.array(text).min(1).optional(),
    reason: text,
  })
  .superRefine((s, ctx) => {
    if ((s.resolution === 'counted') !== (s.countedBy !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'required when resolution is counted and forbidden otherwise',
        path: ['countedBy'],
      });
    }
  });

/** A validated settled-call record. */
export type SettledCall = z.infer<typeof settledCallSchema>;

/** Schema of `harness/inventory/writer-overrides.yaml`; writer and settled-call ids share one namespace. */
export const writerOverridesSchema = z
  .strictObject({
    sourceSha: commitSha,
    writers: z.array(writerOverride),
    settledCalls: z.array(settledCallSchema).optional(),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    flagDuplicateIds(ctx, doc.writers, ['writers'], seen);
    flagDuplicateIds(ctx, doc.settledCalls ?? [], ['settledCalls'], seen);
  });

/** A validated writer-overrides document. */
export type WriterOverrides = z.infer<typeof writerOverridesSchema>;

/** Raised when an override file cannot be read, is not YAML, fails its schema or carries another source SHA. */
export class OverrideError extends Error {
  override name = 'OverrideError';
  readonly path: string;
  readonly issues: readonly string[];

  constructor(path: string, issues: readonly string[], options?: ErrorOptions) {
    super(`override file ${path}: ${issues.join('; ')}`, options);
    this.path = path;
    this.issues = issues;
  }
}

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message,
  );
}

function parseWith<T>(schema: z.ZodType<T>, text: string, sourceLabel: string): T {
  let document: unknown;
  try {
    document = parse(text);
  } catch (err) {
    throw new OverrideError(sourceLabel, [`is not valid YAML: ${(err as Error).message}`], { cause: err });
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    throw new OverrideError(sourceLabel, describeIssues(parsed.error), { cause: parsed.error });
  }
  return parsed.data;
}

/** Validates role-overrides YAML `text`; throws `OverrideError` naming `sourceLabel`. Does not check the pin. */
export function parseRoleOverrides(text: string, sourceLabel: string): RoleOverrides {
  return parseWith(roleOverridesSchema, text, sourceLabel);
}

/** Validates writer-overrides YAML `text`; throws `OverrideError` naming `sourceLabel`. Does not check the pin. */
export function parseWriterOverrides(text: string, sourceLabel: string): WriterOverrides {
  return parseWith(writerOverridesSchema, text, sourceLabel);
}

async function readOverrideFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new OverrideError(path, [`cannot be read: ${(err as Error).message}`], { cause: err });
  }
}

function assertPinned(sourceSha: string, path: string): void {
  const pinned = pinnedSha();
  if (sourceSha !== pinned) {
    throw new OverrideError(path, [`sourceSha: ${sourceSha} does not match the pinned source SHA ${pinned}`]);
  }
}

/** Reads `path`, validates it and checks its `sourceSha` against the source pin; throws `OverrideError`. */
export async function loadRoleOverrides(path: string = ROLE_OVERRIDES_PATH): Promise<RoleOverrides> {
  const document = parseRoleOverrides(await readOverrideFile(path), path);
  assertPinned(document.sourceSha, path);
  return document;
}

/** Reads `path`, validates it and checks its `sourceSha` against the source pin; throws `OverrideError`. */
export async function loadWriterOverrides(path: string = WRITER_OVERRIDES_PATH): Promise<WriterOverrides> {
  const document = parseWriterOverrides(await readOverrideFile(path), path);
  assertPinned(document.sourceSha, path);
  return document;
}
