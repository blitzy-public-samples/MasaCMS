import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SERVICE_ACCOUNT_PREFIX, serviceAccountEmail } from '@opt2/platform/auth';
import { z } from '@opt2/platform/service-kit';
import { iamDbUser } from '@opt2/platform/tenancy';
import { CONFIG_PATH, packagePath } from './paths.js';

const PROJECTOR_DELAY_FAULT = 'projector-delay';

const text = () => z.string().min(1);
const positiveInt = () => z.number().int().positive();
const relativePath = () => text().refine((value) => !path.isAbsolute(value), 'must be relative to migration/');

// The cloud naming keys restate the platform's service-account naming, so they must equal it.
const probeEmail = serviceAccountEmail('probe', 'probe-project');
const IAM_USER_SUFFIX = probeEmail.slice(iamDbUser(probeEmail).length);
const platformNaming = (value: string) => z.literal(value, `must equal the platform value "${value}"`);

const ownerSchema = z
  .object({
    schema: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a lower-case PostgreSQL identifier'),
    package: relativePath(),
  })
  .strict();

const ownersShape = z
  .object({
    identity: ownerSchema,
    people: ownerSchema,
    'programs-sites': ownerSchema,
    'strategies-content': ownerSchema,
    communications: ownerSchema,
    reporting: ownerSchema,
    surveys: ownerSchema,
    timesheets: ownerSchema,
    finance: ownerSchema,
    'e-signature': ownerSchema,
    stub: ownerSchema,
    gateway: ownerSchema,
    migration: ownerSchema,
  })
  .strict();

const ownersSchema = ownersShape.superRefine((owners, ctx) => {
  const bySchema = new Map<string, string>();
  for (const [name, owner] of Object.entries(owners)) {
    const other = bySchema.get(owner.schema);
    if (other !== undefined) {
      ctx.addIssue({ code: 'custom', path: [name, 'schema'], message: `schema "${owner.schema}" is already owned by "${other}"` });
    }
    bySchema.set(owner.schema, name);
  }
});

// Fault names stay free-form strings: `faults/` checks them against its scripts, so this schema takes no side on spelling.
const faultSchema = z.object({ name: text(), defaultDelayMs: positiveInt().optional() }).strict();

const faultsSchema = z.array(faultSchema).superRefine((faults, ctx) => {
  const seen = new Set<string>();
  faults.forEach((fault, index) => {
    if (seen.has(fault.name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `duplicate fault "${fault.name}"` });
    seen.add(fault.name);
    if ((fault.name === PROJECTOR_DELAY_FAULT) !== (fault.defaultDelayMs !== undefined)) {
      ctx.addIssue({ code: 'custom', path: [index], message: `defaultDelayMs belongs to "${PROJECTOR_DELAY_FAULT}" only, and is required there` });
    }
  });
  if (!seen.has(PROJECTOR_DELAY_FAULT)) ctx.addIssue({ code: 'custom', message: `the "${PROJECTOR_DELAY_FAULT}" fault is missing` });
});

/** Schema of `migration/config/migration.config.json`: every key required, no unknown key at any level. */
export const migrationConfigSchema = z
  .object({
    sourceShaFile: relativePath(),
    ownershipFile: relativePath(),
    inventoryFile: relativePath(),
    cutoverDir: relativePath(),
    reportsDir: relativePath(),
    umbrellaSiteId: text(),
    backfill: z.object({ batchRows: positiveInt() }).strict(),
    snapshot: z.object({ databaseNamePattern: text(), backupFilePattern: text(), subdir: text() }).strict(),
    windows: z.object({ openBudgetMs: positiveInt(), importRetryMs: positiveInt(), gatewayLeaseMs: positiveInt() }).strict(),
    transition: z
      .object({ freezeAckTimeoutMs: positiveInt(), cfthreadWaitMs: positiveInt(), drainTimeoutMs: positiveInt() })
      .strict(),
    projection: z
      .object({ defaultAwaitTimeoutMs: positiveInt(), batchRows: positiveInt(), idlePollMs: positiveInt() })
      .strict(),
    background: z.object({ bridgePollMs: positiveInt(), tasksReconcileMs: positiveInt() }).strict(),
    startupGuard: z.object({ table: text(), predicateSql: text(), appreloadKey: text() }).strict(),
    fileStore: z
      .object({
        expected: text(),
        imageExtensions: z.array(text()).min(1),
        flvRenditionExt: text(),
        variants: z.array(z.string()).min(1),
        objectKeyPattern: text(),
        bucket: text(),
      })
      .strict(),
    faults: faultsSchema,
    reconciliationPoints: z.array(text()).min(1),
    rollbackSet: z.object({ routeKeys: z.array(text()).min(1), units: z.array(text()).min(1) }).strict(),
    owners: ownersSchema,
    dataOwners: z
      .array(ownersShape.keyof())
      .min(1)
      .refine((names) => new Set(names).size === names.length, 'must not repeat an owner'),
    cloud: z
      .object({
        iamUserSuffixTrim: platformNaming(IAM_USER_SUFFIX),
        serviceAccountPrefix: platformNaming(SERVICE_ACCOUNT_PREFIX),
        bootstrapAccount: text(),
        adminUser: text(),
      })
      .strict(),
  })
  .strict();

/** Parsed static orchestrator configuration. */
export type MigrationConfig = z.infer<typeof migrationConfigSchema>;

/** Name of one of the thirteen owners, in bootstrap order. */
export type OwnerName = keyof MigrationConfig['owners'];

/** One `owners` entry together with its owner name. */
export interface OwnerEntry {
  name: OwnerName;
  schema: string;
  package: string;
}

/** Absolute forms of the configured file and directory paths. */
export interface ResolvedPaths {
  sourcePin: string;
  tableOwnership: string;
  inventory: string;
  cutoverDir: string;
  groupsFile: string;
  reportsDir: string;
}

/** Configuration as returned by {@link loadConfig}. */
export type LoadedMigrationConfig = MigrationConfig & { paths: ResolvedPaths };

/** The configuration file is unreadable, not JSON, fails the schema, or names a path outside the repository. */
export class MigrationConfigError extends Error {
  override readonly name = 'MigrationConfigError';
  readonly configPath: string;
  /** One `key.path: message` line per problem. */
  readonly issues: string[];

  constructor(configPath: string, issues: string[], options?: ErrorOptions) {
    super([`invalid migration config ${configPath}`, ...issues.map((issue) => `  ${issue}`)].join('\n'), options);
    this.configPath = configPath;
    this.issues = issues;
  }
}

const loaded = new Map<string, LoadedMigrationConfig>();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function resolvePaths(config: MigrationConfig): ResolvedPaths {
  const cutoverDir = packagePath(config.cutoverDir);
  return {
    sourcePin: packagePath(config.sourceShaFile),
    tableOwnership: packagePath(config.ownershipFile),
    inventory: packagePath(config.inventoryFile),
    cutoverDir,
    groupsFile: path.join(cutoverDir, 'groups.json'),
    reportsDir: packagePath(config.reportsDir),
  };
}

function parseFile(file: string): LoadedMigrationConfig {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new MigrationConfigError(file, [`cannot be read as JSON: ${messageOf(error)}`], { cause: error });
  }
  const result = migrationConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new MigrationConfigError(file, issues, { cause: result.error });
  }
  let paths: ResolvedPaths;
  try {
    paths = resolvePaths(result.data);
  } catch (error) {
    throw new MigrationConfigError(file, [messageOf(error)], { cause: error });
  }
  return deepFreeze({ ...result.data, paths });
}

/**
 * Reads and validates the configuration once per file and returns the same frozen object on later calls.
 * @param opts.path a fixture to load instead of `config/migration.config.json`.
 * @throws MigrationConfigError naming the file and every problem found.
 */
export function loadConfig(opts: { path?: string } = {}): LoadedMigrationConfig {
  const file = path.resolve(opts.path ?? CONFIG_PATH);
  const cached = loaded.get(file);
  if (cached !== undefined) return cached;
  const config = parseFile(file);
  loaded.set(file, config);
  return config;
}

/** Reports directory: a non-empty `OPT2_REPORTS_DIR`, else the configured `reportsDir`. */
export function resolveReportsDir(config: Pick<LoadedMigrationConfig, 'paths'>, env: { OPT2_REPORTS_DIR?: string }): string {
  const override = env.OPT2_REPORTS_DIR;
  return override !== undefined && override !== '' ? override : config.paths.reportsDir;
}

function ownerEntries(config: Pick<MigrationConfig, 'owners'>): OwnerEntry[] {
  return (Object.keys(config.owners) as OwnerName[]).map((name) => ({ name, ...config.owners[name] }));
}

function unknownOwner(kind: 'name' | 'schema', value: string, config: Pick<MigrationConfig, 'owners'>): Error {
  const known = ownerEntries(config).map((owner) => (kind === 'name' ? owner.name : owner.schema));
  return new Error(`Unknown owner ${kind} "${value}"; known: ${known.join(', ')}`);
}

/** The owner registered under `name`; throws for a name that is not an owner. */
export function ownerByName(config: Pick<MigrationConfig, 'owners'>, name: string): OwnerEntry {
  const owner = ownerEntries(config).find((entry) => entry.name === name);
  if (owner === undefined) throw unknownOwner('name', name, config);
  return owner;
}

/** The owner of PostgreSQL schema `schema`; throws for a schema no owner holds. */
export function ownerBySchema(config: Pick<MigrationConfig, 'owners'>, schema: string): OwnerEntry {
  const owner = ownerEntries(config).find((entry) => entry.schema === schema);
  if (owner === undefined) throw unknownOwner('schema', schema, config);
  return owner;
}
