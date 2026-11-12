import path from 'node:path';
import { baseEnvSchema, envPort, envUrl, loadEnv, optionalEnvString, requiredEnvString, z } from '@opt2/platform/service-kit';

const SQL_SERVER_TYPES = new Set(['mssql', 'sqlserver', 'microsoft sql server']);

const LOCAL_PUBSUB_KEYS = ['GOOGLE_CLOUD_PROJECT', 'PUBSUB_EMULATOR_HOST'] as const;

const absolutePath = () => z.string().refine((value) => path.isAbsolute(value), 'must be an absolute path');

/** Environment of the migration service and the `opt2-migrate` and `opt2-ops` CLIs; local mode requires the Pub/Sub project and emulator host. */
export const migrationEnvSchema = baseEnvSchema.extend({
  MURA_DBTYPE: optionalEnvString(),
  MURA_DBHOST: requiredEnvString(),
  MURA_DBPORT: requiredEnvString(envPort().default(1433)),
  MURA_DATABASE: requiredEnvString(),
  MURA_DBUSERNAME: requiredEnvString(),
  MURA_DBPASSWORD: requiredEnvString(),
  OPT2_MSSQL_TRUST_SERVER_CERT: requiredEnvString(
    z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  ),
  LEGACY_ORIGIN: envUrl(),
  // Masa takes appreloadkey from MURA_APPRELOADKEY when set (onApplicationStart_include.cfm:136-141), so a reload must too.
  MURA_APPRELOADKEY: optionalEnvString(),
  OPT2_BRIDGE_HMAC_KEY: requiredEnvString(),
  OPT2_LEGACY_RESTART_CMD: optionalEnvString(),
  OPT2_REPORTS_DIR: optionalEnvString(absolutePath()),
  OPT2_PRISTINE_DIR: optionalEnvString(absolutePath()),
}).superRefine((env, ctx) => {
  if (env.OPT2_ENV !== 'local') return;
  for (const key of LOCAL_PUBSUB_KEYS) {
    if (env[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'is required when OPT2_ENV=local' });
  }
});

/** Parsed migration environment. */
export type MigrationEnv = z.infer<typeof migrationEnvSchema>;

/** Parses `source`; throws `EnvValidationError` naming every invalid or missing variable, never its value. */
export function loadMigrationEnv(source: NodeJS.ProcessEnv = process.env): MigrationEnv {
  return loadEnv(migrationEnvSchema, source);
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
