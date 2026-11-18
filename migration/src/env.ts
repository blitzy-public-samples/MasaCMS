import path from 'node:path';
import {
  baseEnvSchema,
  checkProcessEnv,
  envPort,
  envUrl,
  loadEnv,
  optionalEnvString,
  processEnvSchema,
  requiredEnvString,
  z,
  type LoadedEnv,
} from '@opt2/platform/service-kit';

const SERVICE_NAME = 'migration';

/** Services the migration service calls: the gateway and every data owner of `config/migration.config.json`. */
const SERVER_CALLEES = [
  'gateway',
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

const SQL_SERVER_TYPES = new Set(['mssql', 'sqlserver', 'microsoft sql server']);

const LOCAL_PUBSUB_KEYS = ['GOOGLE_CLOUD_PROJECT', 'PUBSUB_EMULATOR_HOST'] as const;

const absolutePath = () => z.string().refine((value) => path.isAbsolute(value), 'must be an absolute path');

/**
 * Environment of the migration service and the `opt2-migrate` and `opt2-ops` CLIs, which all open the `migration` schema pool;
 * local mode requires the Pub/Sub project and emulator host.
 */
export const migrationEnvSchema = baseEnvSchema.extend({
  MURA_DBTYPE: optionalEnvString(),
  MURA_DBHOST: requiredEnvString(),
  MURA_DBPORT: requiredEnvString(envPort().default(1433)),
  MURA_DATABASE: requiredEnvString(),
  MURA_DBUSERNAME: requiredEnvString(),
  MURA_DBPASSWORD: requiredEnvString(),
  // Unset trusts SQL Server's self-signed certificate only when OPT2_ENV=local; the cloud verifies it.
  OPT2_MSSQL_TRUST_SERVER_CERT: optionalEnvString(z.enum(['true', 'false']).transform((value) => value === 'true')),
  LEGACY_ORIGIN: envUrl(),
  // Masa takes appreloadkey from MURA_APPRELOADKEY when set (onApplicationStart_include.cfm:136-141), so a reload must too.
  MURA_APPRELOADKEY: optionalEnvString(),
  OPT2_BRIDGE_HMAC_KEY: requiredEnvString(),
  OPT2_LEGACY_RESTART_CMD: optionalEnvString(),
  OPT2_REPORTS_DIR: optionalEnvString(absolutePath()),
  OPT2_PRISTINE_DIR: optionalEnvString(absolutePath()),
  // The gateway's cut-over directory, so a transition reads the versions the gateway serves.
  OPT2_CUTOVER_DIR: optionalEnvString(absolutePath()),
}).superRefine((env, ctx) => {
  if (env.OPT2_ENV === 'cloud' && env.OPT2_MSSQL_TRUST_SERVER_CERT === true) {
    ctx.addIssue({ code: 'custom', path: ['OPT2_MSSQL_TRUST_SERVER_CERT'], message: 'must be false or unset when OPT2_ENV=cloud' });
  }
  if (env.OPT2_ENV !== 'local') return;
  for (const key of LOCAL_PUBSUB_KEYS) {
    if (env[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'is required when OPT2_ENV=local' });
  }
}).superRefine(
  // The service and the CLIs both open the pool; the CLIs run under any service name, so the name given is accepted.
  (env, ctx) => checkProcessEnv(env, ctx, { service: env.OPT2_SERVICE_NAME, database: true }),
  { when: () => true },
);

/** Parsed migration environment as `loadEnv` returns it, the adapter modes resolved, so it is a service-kit `BaseEnv`. */
export type MigrationEnv = LoadedEnv<typeof migrationEnvSchema>;

/** Parses `source`; throws `EnvValidationError` naming every invalid or missing variable, never its value. */
export function loadMigrationEnv(source: NodeJS.ProcessEnv = process.env): MigrationEnv {
  return loadEnv(migrationEnvSchema, source);
}

/** Environment of the migration service: {@link migrationEnvSchema} under its own service name, with the URL of every service it calls. */
export const migrationServerEnvSchema = processEnvSchema(migrationEnvSchema, {
  service: SERVICE_NAME,
  callees: SERVER_CALLEES,
  database: true,
});

/** Parses `source` as the migration service's environment; throws `EnvValidationError` naming every invalid or missing variable, never its value. */
export function loadMigrationServerEnv(source: NodeJS.ProcessEnv = process.env): MigrationEnv {
  return loadEnv(migrationServerEnvSchema, source);
}

/** Raised when the legacy database is not SQL Server. */
export class UnsupportedLegacyDatabaseError extends Error {
  override readonly name = 'UnsupportedLegacyDatabaseError';
  readonly dbType: string;

  constructor(dbType: string) {
    super(
      `MURA_DBTYPE=${dbType} is not supported: SQL Server is the only supported legacy source. ` +
        'A MySQL fallback is a baseline deviation, so migration stages stop.',
    );
    this.dbType = dbType;
  }
}

/** Throws `UnsupportedLegacyDatabaseError` unless `MURA_DBTYPE` is unset or names SQL Server. */
export function assertSqlServerSource(env: Pick<MigrationEnv, 'MURA_DBTYPE'>): void {
  const dbType = env.MURA_DBTYPE;
  if (dbType !== undefined && !SQL_SERVER_TYPES.has(dbType.trim().toLowerCase())) {
    throw new UnsupportedLegacyDatabaseError(dbType);
  }
}
