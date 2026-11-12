import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from '@opt2/platform/service-kit';
import { GoldenConfigError } from './errors.js';
import { repoPath, stateDir, type EnvLike } from '../lib/paths.js';
import { pinnedSha } from '../lib/pin.js';

/** Default location of the golden-scenario catalogue. */
export const CATALOGUE_PATH: string = repoPath('harness/golden/catalogue.yaml');

/** Scenario id form: `GS-<AREA>-NN`, or `GS-<AREA>-RH-NN` for a rollback-rehearsal scenario. */
export const SCENARIO_ID_PATTERN = /^GS-[A-Z]+(-RH)?-\d{2}$/;

/** The rollback-rehearsal scenarios: the only ones that replay under v0003 and may use the reserved identities. */
export const REHEARSAL_SCENARIO_IDS = ['GS-PE-RH-01', 'GS-PE-RH-02', 'GS-PE-RH-03'] as const;

const REHEARSAL_IDS: ReadonlySet<string> = new Set(REHEARSAL_SCENARIO_IDS);

/** Whether `id` is one of {@link REHEARSAL_SCENARIO_IDS}. */
export function isRehearsalScenario(id: string): boolean {
  return REHEARSAL_IDS.has(id);
}

/** What a scenario compares between capture and replay. */
export const COMPARE_KINDS = [
  'status',
  'envelope',
  'headers',
  'auth',
  'dom',
  'export',
  'transitions',
  'mail',
  'rows',
  'tasks',
  'files',
] as const;
export type CompareKind = (typeof COMPARE_KINDS)[number];

/** Cut-over table versions a scenario replays under. */
export const TABLE_VERSIONS = ['v0002', 'v0003'] as const;
export type TableVersion = (typeof TABLE_VERSIONS)[number];

/** Service folder names a scenario can belong to. */
export const SERVICES = [
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
] as const;
export type ServiceName = (typeof SERVICES)[number];

/** How a named session authenticates: admin login, public pages, JSON API, REST Basic or OAuth client credentials. */
export const SESSION_VIAS = ['admin', 'public', 'jsonapi', 'rest-basic', 'client-credentials'] as const;
export type SessionVia = (typeof SESSION_VIAS)[number];

/** Who a named session logs in as; `seed:<site>:<role>` is a seeded account looked up by role. */
export type SessionLogin = 'none' | 'admin' | 'qa_editor' | `seed:${string}:${string}`;

/** Step credentials; `basic:<user>:<secret>` and `bearer:<token>` carry placeholders, never values. */
export type AuthMode = 'session' | 'anonymous' | `basic:${string}` | `bearer:${string}`;

/** CSRF handling: tokens from an earlier step's form, JSON API tokens for a context, or none. */
export type CsrfMode = 'fetch-form' | 'none' | `json-api:${string}`;

/** Side-effect kinds a step can wait for after its response. */
export const SETTLE_KINDS = ['seam', 'projection', 'mail', 'tasks'] as const;
export type SettleKind = (typeof SETTLE_KINDS)[number];

/** A settle wait, optionally naming its target, e.g. `seam:people.person.archived.v1`. */
export type SettleSpec = SettleKind | `${SettleKind}:${string}`;

/** Declared outcome of a step or scenario that is not parity against a new service. */
export const STEP_EXPECTATIONS = ['withheld', 'halted', 'gap'] as const;
export type StepExpectation = (typeof STEP_EXPECTATIONS)[number];

/** HTTP methods a step can send. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Scenario-scoped normalisation operations of `harness/golden/normalise.yaml` `overrides.operations`. */
export const OVERRIDE_OPERATIONS = [
  'dropPaths',
  'literalPaths',
  'extraTokenFields',
  'dropHeaders',
  'applyRules',
  'domExclude',
  'sortArrays',
] as const;
export type OverrideOperation = (typeof OVERRIDE_OPERATIONS)[number];

/** A scenario's normalisation overrides, by operation. */
export type NormalisationOverrides = Partial<Record<OverrideOperation, string[]>>;

/** Skip reason recorded for a fixture-dependent scenario when the legacy fixtures are unavailable. */
export const FIXTURES_UNAVAILABLE = 'skipped: fixtures unavailable';

const NAME_PATTERN = /^[a-zA-Z][\w-]*$/;
const MATRIX_VALUE = /^\$\{matrix\.([a-zA-Z][\w-]*)\}$/;
const MATRIX_REF = /\$\{matrix\.([a-zA-Z][\w-]*)\}/g;
// A nested placeholder in the binding segment (`${seed.sheet${matrix.n}.id}`) is resolved per matrix value, so the
// lookahead leaves it unchecked rather than reporting its literal prefix.
const BINDING_REF = /\$\{([a-zA-Z][\w-]*)\.([a-zA-Z_][\w-]*)(?![\w$-])/g;

function patterned<T extends string>(pattern: RegExp, message: string): z.ZodType<T> {
  return z.custom<T>((value) => typeof value === 'string' && pattern.test(value), message);
}

const name = z.string().regex(NAME_PATTERN, 'must start with a letter and hold only letters, digits, _ and -');
const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lower-case kebab-case id');
const tableVersion = z.enum(TABLE_VERSIONS);
const compareList = z.array(z.enum(COMPARE_KINDS)).min(1);
const routeKey = z
  .string()
  .regex(/^[a-z][a-z0-9]*:[^\sA-Z]+$/, 'must be a canonical lower-case route key <family>:<body>[{variant}]');
const route = z
  .string()
  .refine(
    (value) => value.startsWith('/') || MATRIX_VALUE.test(value),
    'must be a path starting with / or ${matrix.<name>}',
  );
const httpMethod = z.enum(HTTP_METHODS);
const headerMap = z.record(z.string().min(1), z.string());
const formFields = z.record(z.string().min(1), z.union([z.string(), z.array(z.string())]));
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const exceptionId = z.string().regex(/^EX-[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'must be an exceptions-list id EX-…');

const authMode = patterned<AuthMode>(
  /^(?:session|anonymous|basic:.+:.+|bearer:.+)$/s,
  'must be session, anonymous, basic:<user>:<secret> or bearer:<token>',
);
const csrfMode = patterned<CsrfMode>(
  /^(?:fetch-form|none|json-api:.*)$/s,
  'must be fetch-form, none or json-api:<context>',
);
const settleSpec = patterned<SettleSpec>(
  /^(?:seam|projection|mail|tasks)(?::.+)?$/s,
  'must be seam, projection, mail or tasks, optionally followed by :<target>',
);
const sessionLogin = patterned<SessionLogin>(
  /^(?:none|admin|qa_editor|seed:[a-z0-9-]+:[\w.-]+)$/,
  'must be none, admin, qa_editor or seed:<site>:<role>',
);

const extraction = z.union(
  [
    z.strictObject({ from: z.literal('body'), path: z.string().min(1) }),
    z.strictObject({
      from: z.literal('dom'),
      selector: z.string().min(1),
      attr: z.string().min(1).optional(),
      param: z.string().min(1).optional(),
    }),
    z.strictObject({
      from: patterned<`header:${string}`>(/^header:[A-Za-z0-9-]+$/, 'must be header:<Name>'),
      param: z.string().min(1).optional(),
    }),
    z.strictObject({ from: z.literal('location-query'), param: z.string().min(1) }),
  ],
  {
    error:
      'must be {from: body, path}, {from: dom, selector, attr?, param?}, {from: header:<Name>, param?} ' +
      'or {from: location-query, param}',
  },
);
/** How a step binds a value from its response. */
export type Extraction = z.infer<typeof extraction>;

const multipartSpec = z.strictObject({
  fields: z.record(z.string().min(1), z.string()).default(() => ({})),
  files: z
    .array(
      z.strictObject({
        field: z.string().min(1),
        fixture: kebab,
        filename: z.string().min(1),
        contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, 'must be a MIME type'),
      }),
    )
    .min(1),
});
/** A multipart body; each file names a fixture file, never inline bytes. */
export type MultipartSpec = z.infer<typeof multipartSpec>;

const pollSpec = z
  .strictObject({
    until: z.strictObject({ path: z.string().min(1), equals: scalar }),
    intervalMs: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    lifecycle: z.array(z.strictObject({ state: z.string().min(1), at: z.string().min(1) })).min(1).optional(),
  })
  .refine((poll) => poll.intervalMs <= poll.timeoutMs, { message: 'must not exceed timeoutMs', path: ['intervalMs'] })
  .refine((poll) => new Set(poll.lifecycle?.map((entry) => entry.state)).size === (poll.lifecycle?.length ?? 0), {
    message: 'must not repeat a state',
    path: ['lifecycle'],
  })
  .refine((poll) => poll.lifecycle === undefined || poll.lifecycle.at(-1)?.state === String(poll.until.equals), {
    message: 'must end with the state until.equals names',
    path: ['lifecycle'],
  });
/** Repeat a step until a JSON path of its body equals a value, proving any `lifecycle` states in order. */
export type PollSpec = z.infer<typeof pollSpec>;

interface BodyFields {
  form?: unknown;
  body?: unknown;
  multipart?: unknown;
}

function checkSingleBody(item: BodyFields, ctx: z.RefinementCtx): void {
  const present = (['form', 'body', 'multipart'] as const).filter((key) => item[key] !== undefined);
  if (present.length > 1) {
    ctx.addIssue({
      code: 'custom',
      message: `at most one of form, body or multipart is allowed, got ${present.join(', ')}`,
      path: [present[1] as string],
    });
  }
}

interface ExpectationFields {
  expected?: StepExpectation;
  decisionListRef?: string;
  exceptionId?: string;
}

function checkExpectation(item: ExpectationFields, ctx: z.RefinementCtx): void {
  if ((item.expected === 'withheld') !== (item.decisionListRef !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'decisionListRef is required with expected: withheld and allowed only with it',
      path: ['decisionListRef'],
    });
  }
  if ((item.expected === 'halted') !== (item.exceptionId !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'exceptionId is required with expected: halted and allowed only with it',
      path: ['exceptionId'],
    });
  }
}

const candidateSchema = z
  .strictObject({
    method: httpMethod.default('GET'),
    route,
    headers: headerMap.optional(),
    form: formFields.optional(),
    body: z.json().optional(),
  })
  .superRefine(checkSingleBody);
/** An alternative request shape a step tries on capture until legacy answers as expected. */
export type Candidate = z.infer<typeof candidateSchema>;

/** One request of a scenario, sent identically on capture and replay. */
export const stepSchema = z
  .strictObject({
    name,
    method: httpMethod.default('GET'),
    route,
    as: z.string().min(1).optional(),
    auth: authMode.optional(),
    csrf: csrfMode.default('none'),
    csrfFrom: name.optional(),
    headers: headerMap.optional(),
    form: formFields.optional(),
    body: z.json().optional(),
    multipart: multipartSpec.optional(),
    extract: z.record(name, extraction).optional(),
    poll: pollSpec.optional(),
    settle: settleSpec.optional(),
    matrix: z.record(name, z.array(z.string()).min(1)).optional(),
    knownIssue: kebab.optional(),
    candidates: z.array(candidateSchema).min(1).optional(),
    compare: z.array(z.enum(COMPARE_KINDS)).optional(),
    expected: z.enum(STEP_EXPECTATIONS).optional(),
    decisionListRef: routeKey.optional(),
    exceptionId: exceptionId.optional(),
  })
  .superRefine((step, ctx) => {
    checkSingleBody(step, ctx);
    checkExpectation(step, ctx);
    if (step.csrfFrom !== undefined && step.csrf !== 'fetch-form') {
      ctx.addIssue({ code: 'custom', message: 'csrfFrom is allowed only with csrf: fetch-form', path: ['csrfFrom'] });
    }
    for (const [, variable] of JSON.stringify(step).matchAll(MATRIX_REF)) {
      if (step.matrix === undefined || !Object.hasOwn(step.matrix, variable as string)) {
        ctx.addIssue({ code: 'custom', message: `\${matrix.${variable}} has no matrix entry`, path: ['matrix'] });
      }
    }
  });
/** A validated scenario step. */
export type Step = z.infer<typeof stepSchema>;

const sessionSpec = z.strictObject({ login: sessionLogin, via: z.enum(SESSION_VIAS) });
/** A named session: its own cookie jar, logged in as `login` through `via`. */
export type SessionSpec = z.infer<typeof sessionSpec>;

const seedRefSchema = z
  .strictObject({
    as: name,
    source: z.enum(['dataset', 'reserved']),
    path: z.string().regex(/^[a-zA-Z]\w*(?:\.\w+)+$/, 'must be a dotted dataset path such as masa.users'),
    where: z.record(z.string().min(1), scalar).optional(),
    index: z.number().int().optional(),
  })
  .refine((ref) => (ref.source === 'reserved') === ref.path.startsWith('reserved.'), {
    message: 'reserved refs, and only they, read reserved.* paths',
    path: ['path'],
  });
/** A seeded row (or reserved scalar) a scenario binds as `${seed.<as>…}`; `index` counts from the end when negative. */
export type SeedRef = z.infer<typeof seedRefSchema>;

const rowSpec = z.strictObject({
  table: z.string().regex(/^(?:[a-zA-Z]\w*\.)?[a-zA-Z]\w*$/, 'must be a table or <schema>.<table>'),
  where: z
    .record(z.string().min(1), scalar)
    .refine((where) => Object.keys(where).length > 0, 'must bound the rows by at least one column'),
  minRows: z.number().int().positive().optional(),
});
/** Legacy table whose canonical rows within `where` are compared; a capture fails when legacy holds fewer than `minRows` there. */
export type RowSpec = z.infer<typeof rowSpec>;

const transitionSpec = z
  .strictObject({
    before: name,
    from: z.string().regex(/^v\d{4}$/),
    to: z.string().regex(/^v\d{4}$/),
  })
  .refine((t) => t.from !== t.to, { message: 'must differ from `from`', path: ['to'] });
/** Cut-over transition that happens before step `before`. */
export type TransitionSpec = z.infer<typeof transitionSpec>;

const faultSpec = z.strictObject({
  fault: kebab,
  ms: z.number().int().nonnegative().optional(),
  command: z.string().min(1).optional(),
});
/** Replay-only fault set before the first step and cleared afterwards. */
export type FaultSpec = z.infer<typeof faultSpec>;

const browserSpec = z.strictObject({ flow: kebab, console: z.enum(['no-new-errors']) });
/** Browser flow run by the Playwright interaction suite. */
export type BrowserSpec = z.infer<typeof browserSpec>;

const taskSpec = z.strictObject({ source: z.literal('scheduled-tasks'), prefix: z.string().min(1) });
/** Scheduled tasks whose names start with `prefix` are compared. */
export type TaskSpec = z.infer<typeof taskSpec>;

const overrideList = z.array(z.string().min(1)).min(1);
const normalisationOverrides = z
  .union([
    z.strictObject({
      dropPaths: overrideList.optional(),
      literalPaths: overrideList.optional(),
      extraTokenFields: overrideList.optional(),
      dropHeaders: overrideList.optional(),
      applyRules: overrideList.optional(),
      domExclude: overrideList.optional(),
      sortArrays: overrideList.optional(),
    }) satisfies z.ZodType<NormalisationOverrides>,
    // A bare list of rule ids is shorthand for applyRules.
    z
      .array(z.string().min(1))
      .transform((ids): NormalisationOverrides => (ids.length === 0 ? {} : { applyRules: ids })),
  ])
  .default(() => ({}));

function stepIndexByName(steps: readonly Step[]): Map<string, number> {
  return new Map(steps.map((step, index) => [step.name, index]));
}

/** One golden scenario: its sessions, seeded rows, ordered steps and what is compared. */
export const scenarioSchema = z
  .strictObject({
    id: z.string().regex(SCENARIO_ID_PATTERN, 'must match GS-<AREA>-NN or GS-<AREA>-RH-NN'),
    title: z.string().min(1),
    service: z.enum(SERVICES),
    role: z.string().min(1),
    purpose: z.string().min(1).optional(),
    sessions: z
      .record(name, sessionSpec)
      .refine((sessions) => Object.keys(sessions).length > 0, 'must declare at least one session'),
    seedRefs: z.array(seedRefSchema).default(() => []),
    steps: z.array(stepSchema),
    compare: compareList,
    normalisationOverrides,
    covers: z.array(routeKey),
    rows: z.array(rowSpec).min(1).optional(),
    tableVersion: tableVersion.default('v0002'),
    fixtures: z.literal('required').optional(),
    expected: z.enum(STEP_EXPECTATIONS).optional(),
    decisionListRef: routeKey.optional(),
    exceptionId: exceptionId.optional(),
    acrossTransition: z.array(transitionSpec).min(1).optional(),
    replayFaults: z.array(faultSpec).min(1).optional(),
    browser: browserSpec.optional(),
    tasks: taskSpec.optional(),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string, path: PropertyKey[]): void => ctx.addIssue({ code: 'custom', message, path });
    checkExpectation(s, ctx);
    if (s.steps.length === 0 && s.browser === undefined) issue('must have at least one step', ['steps']);
    const wanted: TableVersion = isRehearsalScenario(s.id) ? 'v0003' : 'v0002';
    if (s.tableVersion !== wanted) issue(`must be ${wanted} for ${s.id}`, ['tableVersion']);
    if (s.compare.includes('rows') !== (s.rows !== undefined)) issue('rows and compare: rows go together', ['rows']);
    if (s.compare.includes('tasks') !== (s.tasks !== undefined)) {
      issue('tasks and compare: tasks go together', ['tasks']);
    }

    const aliases = new Set<string>();
    s.seedRefs.forEach((ref, i) => {
      if (aliases.has(ref.as)) issue(`duplicate seed alias ${ref.as}`, ['seedRefs', i, 'as']);
      aliases.add(ref.as);
    });

    const indexOf = stepIndexByName(s.steps);
    const bindingRefs = (value: unknown, before: number, path: PropertyKey[]): void => {
      for (const [, head, binding] of JSON.stringify(value).matchAll(BINDING_REF)) {
        if (head === 'matrix') continue;
        if (head === 'seed') {
          if (!aliases.has(binding as string)) issue(`\${seed.${binding}} names no seedRefs alias`, path);
          continue;
        }
        const at = indexOf.get(head as string);
        const source = at !== undefined && at < before ? s.steps[at] : undefined;
        if (source === undefined) {
          issue(`\${${head}.${binding}} names no earlier step`, path);
        } else if (source.extract === undefined || !Object.hasOwn(source.extract, binding as string)) {
          issue(`\${${head}.${binding}} is not extracted by step ${head}`, path);
        }
      }
    };

    s.steps.forEach((step, i) => {
      if (indexOf.get(step.name) !== i) issue(`duplicate step name ${step.name}`, ['steps', i, 'name']);
      if (step.csrfFrom !== undefined) {
        const from = indexOf.get(step.csrfFrom);
        if (from === undefined || from >= i) {
          issue(`csrfFrom ${step.csrfFrom} names no earlier step`, ['steps', i, 'csrfFrom']);
        }
      }
      if (step.as !== undefined) {
        const variable = MATRIX_VALUE.exec(step.as)?.[1];
        const sessionNames = variable === undefined ? [step.as] : (step.matrix?.[variable] ?? []);
        for (const session of sessionNames) {
          if (!Object.hasOwn(s.sessions, session)) issue(`as ${session} names no session`, ['steps', i, 'as']);
        }
      }
      bindingRefs(step, i, ['steps', i]);
    });
    if (s.rows !== undefined) bindingRefs(s.rows, s.steps.length, ['rows']);
    s.acrossTransition?.forEach((t, i) => {
      if (!indexOf.has(t.before)) issue(`before ${t.before} names no step`, ['acrossTransition', i, 'before']);
    });
  });
/** A validated scenario, defaults applied. */
export type Scenario = z.infer<typeof scenarioSchema>;

const catalogueDefaults = z.strictObject({ tableVersion: tableVersion.optional(), compare: compareList.optional() });
const DEFAULTED_KEYS = ['tableVersion', 'compare'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Catalogue `defaults` fill the keys a scenario omits; they are validated with the document itself.
function withDefaults(doc: unknown): unknown {
  if (!isRecord(doc) || !isRecord(doc.defaults) || !Array.isArray(doc.scenarios)) return doc;
  const inherited: Record<string, unknown> = {};
  for (const key of DEFAULTED_KEYS) {
    if (doc.defaults[key] !== undefined) inherited[key] = doc.defaults[key];
  }
  return { ...doc, scenarios: doc.scenarios.map((s: unknown) => (isRecord(s) ? { ...inherited, ...s } : s)) };
}

/** The catalogue document: pinned source SHA and scenarios in capture order. */
export const catalogueSchema = z.preprocess(
  withDefaults,
  z
    .strictObject({
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase hex commit id'),
      version: z.literal(1).default(1),
      defaults: catalogueDefaults.optional(),
      scenarios: z.array(scenarioSchema).min(1),
    })
    .superRefine((doc, ctx) => {
      const seen = new Set<string>();
      doc.scenarios.forEach((s, i) => {
        if (seen.has(s.id)) {
          ctx.addIssue({ code: 'custom', message: `duplicate scenario id ${s.id}`, path: ['scenarios', i, 'id'] });
        }
        seen.add(s.id);
      });
    }),
);
/** A validated catalogue. */
export type Catalogue = z.infer<typeof catalogueSchema>;

function pointer(file: string, path: readonly PropertyKey[]): string {
  const segments = path.map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1'));
  return `${file}#/${segments.join('/')}`;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/**
 * Reads and validates the catalogue at `path`, keeping scenario order (capture order).
 * Throws `GoldenConfigError` when it cannot be read or parsed, fails the schema, or carries another source SHA.
 */
export async function loadCatalogue(path: string = CATALOGUE_PATH): Promise<Catalogue> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new GoldenConfigError(`catalogue ${path} cannot be read: ${(err as Error).message}`, { path, cause: err });
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new GoldenConfigError(`catalogue ${path} is not valid YAML: ${(err as Error).message}`, { path, cause: err });
  }
  const parsed = catalogueSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GoldenConfigError(`catalogue ${path}: ${describeIssues(parsed.error)}`, {
      path: pointer(path, parsed.error.issues[0]?.path ?? []),
      cause: parsed.error,
    });
  }
  const pinned = pinnedSha();
  if (parsed.data.sourceSha !== pinned) {
    throw new GoldenConfigError(
      `catalogue ${path}: sourceSha ${parsed.data.sourceSha} does not match the pinned source SHA ${pinned}`,
      { path: pointer(path, ['sourceSha']) },
    );
  }
  return parsed.data;
}

/** The scenario with `id`; throws `GoldenConfigError` when the catalogue has none. */
export function scenarioById(catalogue: Catalogue, id: string): Scenario {
  const scenario = catalogue.scenarios.find((s) => s.id === id);
  if (scenario === undefined) throw new GoldenConfigError(`catalogue has no scenario ${id}`);
  return scenario;
}

function uniqueRefs(scenario: Scenario, key: 'decisionListRef' | 'exceptionId'): string[] {
  const refs = [scenario[key], ...scenario.steps.map((step) => step[key])];
  return [...new Set(refs.filter((ref): ref is string => ref !== undefined))];
}

/** Decision-list route keys the scenario or its steps are withheld under, in declaration order. */
export function decisionRefs(scenario: Scenario): string[] {
  return uniqueRefs(scenario, 'decisionListRef');
}

/** Exceptions-list ids the scenario or its steps are halted under, in declaration order. */
export function exceptionRefs(scenario: Scenario): string[] {
  return uniqueRefs(scenario, 'exceptionId');
}

/** Legacy-fixture capability record written by `legacy-fixtures/load-fixtures.sh`. */
export const fixtureStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  checkedAt: z.string().min(1),
});
export type FixtureStatus = z.infer<typeof fixtureStatusSchema>;

/** Reads `<state>/fixtures.json`; a missing file reads as unavailable, an invalid one throws `GoldenConfigError`. */
export function readFixtureStatus(env: EnvLike = process.env): FixtureStatus {
  const file = join(stateDir(env), 'fixtures.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { available: false, reason: 'fixtures.json not found', checkedAt: new Date().toISOString() };
    }
    throw new GoldenConfigError(`fixture status ${file} cannot be read: ${(err as Error).message}`, {
      path: file,
      cause: err,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new GoldenConfigError(`fixture status ${file} is not valid JSON: ${(err as Error).message}`, {
      path: file,
      cause: err,
    });
  }
  const parsed = fixtureStatusSchema.safeParse(json);
  if (!parsed.success) {
    throw new GoldenConfigError(`fixture status ${file}: ${describeIssues(parsed.error)}`, {
      path: file,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** The skip reason for `scenario` under `status`, or `null` when it runs. */
export function skipReason(
  scenario: Pick<Scenario, 'fixtures'>,
  status: Pick<FixtureStatus, 'available'>,
): typeof FIXTURES_UNAVAILABLE | null {
  return scenario.fixtures === 'required' && !status.available ? FIXTURES_UNAVAILABLE : null;
}
