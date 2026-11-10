// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readFile } from 'node:fs/promises';
import { SYNTHETIC_ROLES, type Role } from '@opt2/platform/auth';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';

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
  systemUsers: number;
  groups: number;
  categories: number;
  files: number;
  contentNodes: number;
  /** Upper bound of versions drawn per content node. */
  maxVersionsPerNode: number;
  timesheetDays: number;
  daysPerTimesheet: number;
  /** Members of the site's `timesheets.employee` group, each with their own sheets. */
  timesheetEmployees: number;
  financeRecords: number;
  financeAttachments: number;
  surveys: number;
  surveyResponses: number;
  /** Responses, among `surveyResponses`, given from another site. */
  multiSiteResponses: number;
  exportDefinitions: number;
  exportJobs: number;
  messageTemplates: number;
  messages: number;
  signatureRequests: number;
  oauthClients: number;
}

/** One seeded site as configured, with every count resolved. */
export interface SiteConfig {
  siteID: SiteKey;
  /** Display name (`tsettings.Site`). */
  site: string;
  /** Fixture `Program_<id>` schema of the site, as in `synthetic.program_site`. */
  programId: number | null;
  pools: SitePools;
  counts: SiteCounts;
}

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
  /** Masa group name granting each synthetic role. */
  roleGroups: Readonly<Record<Role, string>>;
  sites: Readonly<Record<SiteKey, SiteConfig>>;
  reserved: { rehearsal: RehearsalReserve };
}

const ZERO_COUNTS: SiteCounts = {
  members: 0,
  systemUsers: 0,
  groups: 0,
  categories: 0,
  files: 0,
  contentNodes: 0,
  maxVersionsPerNode: 0,
  timesheetDays: 0,
  daysPerTimesheet: 0,
  timesheetEmployees: 0,
  financeRecords: 0,
  financeAttachments: 0,
  surveys: 0,
  surveyResponses: 0,
  multiSiteResponses: 0,
  exportDefinitions: 0,
  exportJobs: 0,
  messageTemplates: 0,
  messages: 0,
  signatureRequests: 0,
  oauthClients: 0,
};

const DEFAULT_COUNTS: Readonly<Record<SiteKey, Partial<SiteCounts>>> = {
  umbrella: { members: 1000, categories: 100, files: 20 },
  'tenant-a': {
    systemUsers: 2000,
    groups: 50,
    contentNodes: 5000,
    maxVersionsPerNode: 3,
    timesheetDays: 20000,
    daysPerTimesheet: 20,
    timesheetEmployees: 100,
    financeRecords: 3000,
    financeAttachments: 300,
    surveys: 40,
    surveyResponses: 500,
    multiSiteResponses: 50,
    exportJobs: 200,
    messageTemplates: 10,
    messages: 200,
    signatureRequests: 100,
  },
  'tenant-b': {
    systemUsers: 180,
    members: 20,
    groups: 10,
    categories: 10,
    contentNodes: 300,
    maxVersionsPerNode: 3,
    timesheetDays: 2000,
    daysPerTimesheet: 20,
    timesheetEmployees: 20,
    financeRecords: 300,
    financeAttachments: 30,
    surveys: 5,
    surveyResponses: 0,
    exportJobs: 10,
    messageTemplates: 3,
    messages: 20,
    signatureRequests: 10,
  },
};

const INSTALLED_USERNAMES: readonly string[] = ['admin', 'qa_editor'];
const USERNAME = /^[a-z0-9._-]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Counts from the file, then the site's defaults, then 0. */
function resolveCounts(site: SiteKey, counts: Partial<SiteCounts>): SiteCounts {
  return { ...ZERO_COUNTS, ...DEFAULT_COUNTS[site], ...counts };
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const countSchema = z.int().nonnegative().optional();
const countsSchema = z.strictObject(
  Object.fromEntries(Object.keys(ZERO_COUNTS).map((key) => [key, countSchema])) as Record<keyof SiteCounts, typeof countSchema>,
);

const siteKeySchema = z.literal(SITE_ORDER);
const poolsSchema = z.strictObject({
  publicUserPoolID: siteKeySchema.optional(),
  privateUserPoolID: siteKeySchema.optional(),
  categoryPoolID: siteKeySchema.optional(),
  filePoolID: siteKeySchema.optional(),
  displayPoolID: siteKeySchema.optional(),
  contentPoolID: siteKeySchema.optional(),
});

function siteSchema(siteID: SiteKey, programId: z.ZodType<number | null>) {
  return z
    .strictObject({ site: z.string().min(1), programId, pools: poolsSchema, counts: countsSchema })
    .transform(
      (raw): SiteConfig => ({
        siteID,
        site: raw.site,
        programId: raw.programId,
        pools: raw.pools,
        counts: resolveCounts(siteID, raw.counts),
      }),
    );
}

// The file lists group names; role-map.json grants each listed group the synthetic role of the same name.
const roleGroupsSchema = z
  .array(
    z.string().refine((name) => SYNTHETIC_ROLES.includes(name), {
      error: (issue) => `unknown synthetic role group ${JSON.stringify(issue.input)}`,
    }),
  )
  .refine((names) => isUnique(names) && SYNTHETIC_ROLES.every((role) => names.includes(role)), {
    error: `must list each of ${SYNTHETIC_ROLES.join(', ')} exactly once`,
  })
  .transform((): Readonly<Record<Role, string>> => Object.freeze(Object.fromEntries(SYNTHETIC_ROLES.map((role) => [role, role]))));

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
    roleGroups: roleGroupsSchema,
    sites: z.strictObject({
      umbrella: siteSchema('umbrella', z.null()),
      'tenant-a': siteSchema('tenant-a', z.literal(1)),
      'tenant-b': siteSchema('tenant-b', z.literal(2)),
    }),
    reserved: z.strictObject({ rehearsal: rehearsalSchema }),
  })
  .transform(
    (raw): SeedConfig => ({
      seed: raw.seed,
      businessDate: raw.businessDate,
      chunkRows: raw.chunkRows,
      historyDays: raw.historyDays,
      emailDomain: raw.emailDomain,
      roleGroups: raw.roleGroups,
      sites: raw.sites,
      reserved: raw.reserved,
    }),
  );

/** Validates a parsed `seed.config.json` value and resolves its counts; throws `ZodError` naming each offending key. */
export function parseConfig(value: unknown): SeedConfig {
  return seedConfigSchema.parse(value);
}

/** Reads, parses and validates the seed configuration file at `path`. */
export async function loadConfig(path: string): Promise<SeedConfig> {
  return parseConfig(JSON.parse(await readFile(path, 'utf8')));
}

/** Site whose fixture schema is `Program_<programId>`; throws `RangeError` when none is. */
export function siteForProgram(config: SeedConfig, programId: number): SiteKey {
  const site = SITE_ORDER.find((key) => config.sites[key].programId === programId);
  if (site === undefined) throw new RangeError(`No seeded site has programId ${programId}`);
  return site;
}

/** Fixture program id of `site`; throws `RangeError` for a site without one (umbrella). */
export function programIdForSite(config: SeedConfig, site: SiteKey): number {
  const { programId } = config.sites[site];
  if (programId === null) throw new RangeError(`Site ${site} has no programId`);
  return programId;
}

/** Masa group name granting `role`; throws `RangeError` for a role that is not synthetic. */
export function roleGroupName(config: SeedConfig, role: Role): string {
  const name = Object.hasOwn(config.roleGroups, role) ? config.roleGroups[role] : undefined;
  if (name === undefined) throw new RangeError(`Not a synthetic role: ${role}`);
  return name;
}
