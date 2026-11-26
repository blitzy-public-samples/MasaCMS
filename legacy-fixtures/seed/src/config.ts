// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readFile } from 'node:fs/promises';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';
import { parseJson, printable } from './errors.js';

/** Id of a seeded Masa site; the installed `default` site is never generated. */
export type SiteKey = 'umbrella' | 'tenant-a' | 'tenant-b';

/** Order in which sites are generated and written. */
export const SITE_ORDER: readonly SiteKey[] = Object.freeze(['umbrella', 'tenant-a', 'tenant-b'] as const);

/** Masa pool settings as site ids; an omitted pool is the site's own id. */
export interface SitePools {
  publicUserPoolID?: SiteKey;
  privateUserPoolID?: SiteKey;
  categoryPoolID?: SiteKey;
  filePoolID?: SiteKey;
  displayPoolID?: SiteKey;
  contentPoolID?: SiteKey;
}

/** Rows generated for one site. */
export interface SiteCounts {
  members: number;
  /** System-user slots; ten are retired and generate no row. */
  systemUsers: number;
  /** Group slots; ten are retired and generate no row. */
  groups: number;
  categories: number;
  files: number;
  contentNodes: number;
  /** Upper bound of versions drawn per content node. */
  maxVersionsPerNode: number;
  oauthClients: number;
}

/** One seeded site as configured, with every count resolved. */
export interface SiteConfig {
  siteID: SiteKey;
  /** Display name (`tsettings.Site`). */
  site: string;
  pools: SitePools;
  counts: SiteCounts;
  /** `tsettings.PageLimit`; null keeps Masa's default, {@link MASA_DEFAULT_PAGE_LIMIT}. */
  pageLimit: number | null;
}

/** Page limit of a Masa site that sets none [core/mura/settings/settingsBean.cfc:83]. */
export const MASA_DEFAULT_PAGE_LIMIT = 1000;

/** Largest `tsettings.PageLimit` (SQL Server `int`). */
const MAX_PAGE_LIMIT = 2_147_483_647;

/** Identities only the rollback rehearsal scenarios may touch. */
export interface RehearsalReserve {
  site: SiteKey;
  /** `UserID`s of seeded persons. */
  persons: readonly string[];
  /** Usernames no seeded user takes, left for the rehearsal's creates. */
  usernames: readonly string[];
}

/** Validated seed configuration. */
export interface SeedConfig {
  seed: number;
  /** `yyyy-MM-dd`; the `asOf` date of the dataset. */
  businessDate: string;
  chunkRows: number;
  historyDays: number;
  emailDomain: string;
  sites: Readonly<Record<SiteKey, SiteConfig>>;
  reserved: { rehearsal: RehearsalReserve };
  /** Names of the passwords golden scenarios post for accounts they create (`${secret:generated:<name>}`). */
  scenarioPasswords: readonly string[];
}

/** Scenario password names a golden scenario posts; other `scenarioPasswords` entries are ignored. */
const SCENARIO_PASSWORD_NAMES: readonly string[] = Object.freeze(['gs-id-09', 'gs-pe-01', 'gs-pe-rh-01']);

/** Count keys seed.config.json still carries for retired modules; accepted and ignored. */
const RETIRED_COUNT_KEYS: readonly string[] = Object.freeze([
  'timesheetDays',
  'daysPerTimesheet',
  'timesheetEmployees',
  'financeRecords',
  'financeAttachments',
  'surveys',
  'surveyResponses',
  'multiSiteResponses',
  'exportDefinitions',
  'exportJobs',
  'messageTemplates',
  'messages',
  'signatureRequests',
]);

const ZERO_COUNTS: SiteCounts = {
  members: 0,
  systemUsers: 0,
  groups: 0,
  categories: 0,
  files: 0,
  contentNodes: 0,
  maxVersionsPerNode: 0,
  oauthClients: 0,
};

const DEFAULT_COUNTS: Readonly<Record<SiteKey, Partial<SiteCounts>>> = {
  umbrella: { members: 1000, categories: 100, files: 20 },
  'tenant-a': { systemUsers: 2000, groups: 50, contentNodes: 5000, maxVersionsPerNode: 3 },
  'tenant-b': { systemUsers: 180, members: 20, groups: 10, categories: 10, contentNodes: 300, maxVersionsPerNode: 3 },
};

const INSTALLED_USERNAMES: readonly string[] = ['admin', 'qa_editor'];
const USERNAME = /^[a-z0-9._-]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Counts from the file, then the site's defaults, then 0; retired keys are dropped. */
function resolveCounts(site: SiteKey, counts: Partial<SiteCounts>): SiteCounts {
  const resolved: SiteCounts = { ...ZERO_COUNTS, ...DEFAULT_COUNTS[site] };
  for (const key of Object.keys(ZERO_COUNTS) as (keyof SiteCounts)[]) resolved[key] = counts[key] ?? resolved[key];
  return resolved;
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const countSchema = z.int().nonnegative().optional();
const countsSchema = z.strictObject({
  ...(Object.fromEntries(Object.keys(ZERO_COUNTS).map((key) => [key, countSchema])) as Record<keyof SiteCounts, typeof countSchema>),
  ...Object.fromEntries(RETIRED_COUNT_KEYS.map((key) => [key, z.unknown().optional()])),
});

const siteKeySchema = z.literal(SITE_ORDER);
const poolsSchema = z.strictObject({
  publicUserPoolID: siteKeySchema.optional(),
  privateUserPoolID: siteKeySchema.optional(),
  categoryPoolID: siteKeySchema.optional(),
  filePoolID: siteKeySchema.optional(),
  displayPoolID: siteKeySchema.optional(),
  contentPoolID: siteKeySchema.optional(),
});

// Masa shows the new-content and upload forms only while the site's pages number fewer than its page limit.
function siteSchema(siteID: SiteKey) {
  return z
    .strictObject({
      site: z.string().min(1),
      // Retired fixture program id; accepted and ignored.
      programId: z.unknown().optional(),
      pools: poolsSchema,
      counts: countsSchema,
      pageLimit: z.int().positive().max(MAX_PAGE_LIMIT).optional(),
    })
    .transform(
      (raw): SiteConfig => ({
        siteID,
        site: raw.site,
        pools: raw.pools,
        counts: resolveCounts(siteID, raw.counts),
        pageLimit: raw.pageLimit ?? null,
      }),
    )
    .refine((site) => site.counts.contentNodes < (site.pageLimit ?? MASA_DEFAULT_PAGE_LIMIT), {
      path: ['pageLimit'],
      error: (issue) => {
        const site = issue.input as SiteConfig;
        return `must exceed the site's ${site.counts.contentNodes} content nodes (Masa's default is ${MASA_DEFAULT_PAGE_LIMIT})`;
      },
    });
}

const rehearsalSchema = z.strictObject({
  site: z.literal('tenant-a'),
  persons: z
    .array(z.string().refine(isCfUuid, { error: (issue) => `not a CF UUID: ${JSON.stringify(issue.input)}` }))
    .length(10)
    .refine(isUnique, { error: 'must be unique' }),
  usernames: z
    .array(
      z
        .string()
        .regex(USERNAME, { error: 'must be lower-case ASCII ([a-z0-9._-])' })
        .refine((name) => !INSTALLED_USERNAMES.includes(name), {
          error: (issue) => `${JSON.stringify(issue.input)} is an installed Masa account`,
        }),
    )
    .length(10)
    .refine(isUnique, { error: 'must be unique' }),
});

/** Schema of `seed.config.json`; its output is the resolved `SeedConfig`. */
export const seedConfigSchema = z
  .strictObject({
    $comment: z.string().optional(),
    seed: z.int(),
    businessDate: z.iso.date(),
    chunkRows: z.int().positive(),
    historyDays: z.int().positive(),
    emailDomain: z.string().regex(DOMAIN, { error: 'must be a lower-case domain name' }),
    // Retired role group names; accepted and ignored.
    roleGroups: z.unknown().optional(),
    sites: z.strictObject({
      umbrella: siteSchema('umbrella'),
      'tenant-a': siteSchema('tenant-a'),
      'tenant-b': siteSchema('tenant-b'),
    }),
    reserved: z.strictObject({ rehearsal: rehearsalSchema }),
    scenarioPasswords: z.array(z.string().min(1)).refine(isUnique, { error: 'must be unique' }).default([]),
  })
  .transform(
    (raw): SeedConfig => ({
      seed: raw.seed,
      businessDate: raw.businessDate,
      chunkRows: raw.chunkRows,
      historyDays: raw.historyDays,
      emailDomain: raw.emailDomain,
      sites: raw.sites,
      reserved: raw.reserved,
      scenarioPasswords: raw.scenarioPasswords.filter((name) => SCENARIO_PASSWORD_NAMES.includes(name)),
    }),
  );

/** Validates a parsed `seed.config.json` value and resolves its counts; throws `ZodError` naming each offending key. */
export function parseConfig(value: unknown): SeedConfig {
  return seedConfigSchema.parse(value);
}

/** Reads, parses and validates the seed configuration file at `path`; malformed JSON or a rejected key throws a usage error naming the file and each key. */
export async function loadConfig(path: string): Promise<SeedConfig> {
  const parsed = seedConfigSchema.safeParse(parseJson(await readFile(path, 'utf8'), path, { usage: true }));
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(top level)'}: ${issue.message}`);
  throw printable(new Error(`${path} is not a valid seed configuration: ${issues.join('; ')}`, { cause: parsed.error }), { usage: true });
}
