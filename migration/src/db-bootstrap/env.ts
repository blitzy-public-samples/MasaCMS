import { baseEnvSchema, EnvValidationError, optionalEnvString, type z } from '@opt2/platform/service-kit';

/** Variables `opt2-db bootstrap` reads; `MURA_*` and service-runtime variables are not part of it. */
export const bootstrapEnvSchema = baseEnvSchema
  .pick({
    OPT2_ENV: true,
    PG_HOST: true,
    PG_PORT: true,
    PG_DATABASE: true,
    PG_USER: true,
    PG_PASSWORD: true,
    CLOUD_SQL_INSTANCE: true,
    GOOGLE_CLOUD_PROJECT: true,
    OPT2_STATE_DIR: true,
  })
  .extend({
    // Password of Cloud SQL's built-in `postgres` user. Blank counts as absent, as for every platform variable,
    // so a blank secret is reported by missingForTarget('cloud') rather than as a parse error.
    OPT2_CLOUDSQL_ADMIN_PASSWORD: optionalEnvString(),
  });

/** Parsed bootstrap variables. */
export type BootstrapEnv = z.infer<typeof bootstrapEnvSchema>;

/** Targets accepted by `--target`. */
export const BOOTSTRAP_TARGETS = ['local', 'cloud'] as const;

/** Where the bootstrap runs: local PostgreSQL or Cloud SQL. */
export type BootstrapTarget = (typeof BOOTSTRAP_TARGETS)[number];

const REQUIRED_BY_TARGET: Record<BootstrapTarget, readonly (keyof BootstrapEnv)[]> = {
  local: ['PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD', 'OPT2_STATE_DIR'],
  cloud: ['PG_DATABASE', 'CLOUD_SQL_INSTANCE', 'GOOGLE_CLOUD_PROJECT', 'OPT2_CLOUDSQL_ADMIN_PASSWORD'],
};

/**
 * Parses `source` against `bootstrapEnvSchema`; throws `EnvValidationError` naming each invalid variable.
 * Not `loadEnv`, which takes only full service schemas and adds service-runtime rules (OPT2_JWKS_URL, adapters).
 */
export function loadBootstrapEnv(source: NodeJS.ProcessEnv = process.env): BootstrapEnv {
  const result = bootstrapEnvSchema.safeParse(source, {
    error: (issue) => (issue.input === undefined ? 'is required' : undefined),
  });
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EnvValidationError(issues, 'db-bootstrap');
  }
  return Object.freeze(result.data);
}

/** Names (never values) of the variables `target` needs that `env` lacks, in a fixed order. */
export function missingForTarget(env: BootstrapEnv, target: BootstrapTarget): string[] {
  return REQUIRED_BY_TARGET[target].filter((name) => env[name] === undefined);
}
