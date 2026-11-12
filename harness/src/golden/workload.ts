// Deterministic legacy write workload of test-all stage 4, sent through the gateway while v0001 is active.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Roles, SYNTHETIC_ROLES } from '@opt2/platform/auth';
import { z } from '@opt2/platform/service-kit';
import {
  CATALOGUE_PATH,
  loadCatalogue,
  readFixtureStatus,
  stepSchema,
  type Scenario,
  type SessionSpec,
  type Step,
} from './catalogue.js';
import { GoldenConfigError } from './errors.js';
import {
  SEED_CONFIG_PATH,
  createScenarioContext,
  loadSecretStore,
  loadSeedStore,
  placeholderNames,
  secretValues,
  type ScenarioContextOptions,
  type ScenarioInput,
  type SecretStore,
  type SeedStore,
} from './session.js';
import { redact, runStep, type StepRecord, type StepRunOptions } from './steps.js';
import { isMainModule, parseFlags, runCli, type CliOutcome } from '../lib/cli.js';
import { stateDir, type EnvLike } from '../lib/paths.js';
import { readJson, stableStringify, writeJsonReport, type ReportOptions } from '../lib/report.js';

/** Scenario id the workload's context and step errors carry. */
export const WORKLOAD_ID = 'workload';

/** Rows the workload writes, per kind. */
export const WORKLOAD_COUNTS = Object.freeze({
  contentEdits: 5,
  contentCreates: 2,
  userEdits: 3,
  groupEdits: 1,
  timesheetSubmits: 3,
  financeEdits: 2,
});

/** Sites written: content, people and fixture edits in `tenant-a`; content creates and the site edit in `tenant-b`. */
export const WORKLOAD_SITES = Object.freeze({ edits: 'tenant-a', creates: 'tenant-b', settings: 'tenant-b' });

const ADMIN_SESSION = 'admin';
// The fixture API authorises by held role group, and the S2 admin holds none, so fixture writes run in sessions of the
// seeded role accounts: an employee submits days and a preparer edits records.
const EMPLOYEE_SESSION = 'employee';
const PREPARER_SESSION = 'preparer';
const MODULE_ID = '00000000000000000000000000000000000';
const HOME_ID = '00000000000000000000000000000000001';
const FIXTURE_API = '/legacy-fixtures/cfml/api.cfm';
const TITLE_MAX = 255;
/** Reserved `.test` domain of the addresses the workload writes; no mail is sent to them. */
const EMAIL_DOMAIN = 'workload.opt2.test';
// The seed creates one Masa group per synthetic role, named after it. They carry the fixture authorisation the
// synthetic scenarios log in with, so none is edited.
const ROLE_GROUPS: ReadonlySet<string> = new Set(SYNTHETIC_ROLES);
const DRAFT_DAY = 'DRAFT';
const IN_PROGRESS = 'IN-PROGRESS';
/** `user:<site>:<role>` placeholders and `seed:<site>:<role>` session logins, both naming a seeded role account. */
const ROLE_ACCOUNT = /^(?:user|seed):([^:${}]+):([^${}]+)$/;

/** Seed configuration fields the workload reads from `legacy-fixtures/seed/seed.config.json`. */
export interface WorkloadSeedConfig {
  seed: number;
  sites: Readonly<Record<string, { programId: number | null }>>;
  reserved: { rehearsal: { persons: readonly string[]; usernames: readonly string[] } };
}

/** Seeded Masa user (`tusers` Type 2). */
export interface WorkloadUser {
  userID: string;
  siteID: string;
  isPublic: number;
  username: string;
  fname: string;
  lname: string;
  email: string;
  subscribe: number;
}

/** Seeded Masa group (`tusers` Type 1). */
export interface WorkloadGroup {
  groupID: string;
  siteID: string;
  groupname: string;
}

/** Seeded group membership. */
export interface WorkloadMembership {
  userID: string;
  groupname: string;
  groupSiteID: string;
}

/** Seeded content node. */
export interface WorkloadContent {
  contentID: string;
  siteID: string;
  parentID: string;
  type: string;
  title: string;
  isNav: number;
}

/** Dataset fields the workload reads from `${OPT2_STATE_DIR}/seed/dataset.json`. */
export interface WorkloadDataset {
  masa: {
    users: readonly WorkloadUser[];
    groups: readonly WorkloadGroup[];
    memberships: readonly WorkloadMembership[];
    content: readonly WorkloadContent[];
  };
  /** Fixture tables by dataset key (`Program_<id>.<table>`); read only when the fixtures are available. */
  fixtures?: Readonly<Record<string, readonly unknown[]>>;
}

/** Inputs of {@link buildWorkloadPlan} besides the seed configuration and dataset. */
export interface WorkloadPlanOptions {
  /** Whether the legacy fixtures are loaded (`${OPT2_STATE_DIR}/fixtures.json`); without them none is written. */
  fixturesAvailable: boolean;
  /** Values held by rows the catalogue references ({@link catalogueSeedKeys}); a row keyed by any is not written. */
  excludedKeys?: ReadonlySet<string>;
  /** Admin username posted at login (default `admin`). */
  adminUsername?: string;
}

/**
 * Data predicate over a probe's extracted bindings; element fields match case-insensitively (ACF upper-cases keys).
 * `equals`: the binding is `value`. `some-equals`: an element of the array binding has `field` = `value`.
 * `keyed-not-equals`: the element of the array binding whose `key` is `id` has `field` other than `value`.
 */
export type WriteCheck =
  | { kind: 'equals'; binding: string; value: string }
  | { kind: 'some-equals'; binding: string; field: string; value: string }
  | { kind: 'keyed-not-equals'; binding: string; key: string; id: string; field: string; value: string };

/** A write of the plan: `check` holds of plan item `probe`'s response once it is applied; `skip` then stays unsent. */
export interface WorkloadWrite {
  name: string;
  probe: string;
  check: WriteCheck;
  skip: string[];
}

/** The ordered workload: catalogue-shaped steps sent in one scenario context, and the writes among them. */
export interface WorkloadPlan {
  seed: number;
  items: Step[];
  writes: WorkloadWrite[];
}

/**
 * Outcome of one plan item; `routeKey` and `status` are null when it threw before a response was recorded or was not
 * sent, `skipped` then saying why: its write was already applied, or could not be verified.
 */
export interface WorkloadItem {
  name: string;
  routeKey: string | null;
  status: number | null;
  skipped?: 'already-applied' | 'unverified';
}

/** An item that answered other than 2xx/3xx or threw, or a write left unsent because its probe could not tell. */
export interface WorkloadFailure extends WorkloadItem {
  reason: string;
}

/** Progress `workload.json` records: `running` while items are sent, then `complete`. */
export type WorkloadStatus = 'running' | 'complete';

/** How a run ended: `already-applied` when every write was found applied, so none was sent; else `complete`. */
export type WorkloadOutcome = 'complete' | 'already-applied';

/** Result of {@link runWorkload}; `report` is the written `workload.json`. */
export interface WorkloadRun {
  outcome: WorkloadOutcome;
  planDigest: string;
  items: WorkloadItem[];
  failures: WorkloadFailure[];
  /** Writes whose items were sent, and writes found already applied. */
  writes: { sent: number; alreadyApplied: number };
  report: string;
}

/** Injectable boundaries of {@link runWorkload} and {@link main}; each defaults to the real process and stores. */
export interface WorkloadDeps {
  env?: EnvLike;
  fetch?: ScenarioContextOptions['fetch'];
  secrets?: SecretStore;
  seed?: SeedStore;
  routeKeyOptions?: StepRunOptions['routeKeyOptions'];
  report?: ReportOptions;
}

/** Stores {@link catalogueSeedKeys} resolves seedRefs and role accounts with. */
export interface SeedKeyStores {
  seed: SeedStore;
  secrets: SecretStore;
  env?: EnvLike;
}

const timesheetRowSchema = z.object({ timesheet_id: z.string(), person_id: z.string(), siteID: z.string() });
const dayRowSchema = z.object({ day_id: z.string(), timesheet_id: z.string(), state: z.string() });
const financeRowSchema = z.object({
  record_id: z.string(),
  siteID: z.string(),
  state: z.string(),
  title: z.string(),
  amount: z.string(),
  period: z.string(),
});

/** Validates the seed configuration fields of {@link WorkloadSeedConfig}. */
export const workloadSeedConfigSchema = z.object({
  seed: z.number().int(),
  sites: z.record(z.string(), z.object({ programId: z.number().int().nullable() })),
  reserved: z.object({
    rehearsal: z.object({ persons: z.array(z.string()), usernames: z.array(z.string()) }),
  }),
});

/** Validates the dataset fields of {@link WorkloadDataset}; fixture rows are validated per table when planned. */
export const workloadDatasetSchema = z.object({
  masa: z.object({
    users: z.array(
      z.object({
        userID: z.string(),
        siteID: z.string(),
        isPublic: z.number().int(),
        username: z.string(),
        fname: z.string(),
        lname: z.string(),
        email: z.string(),
        subscribe: z.number().int(),
      }),
    ),
    groups: z.array(z.object({ groupID: z.string(), siteID: z.string(), groupname: z.string() })),
    memberships: z.array(z.object({ userID: z.string(), groupname: z.string(), groupSiteID: z.string() })),
    content: z.array(
      z.object({
        contentID: z.string(),
        siteID: z.string(),
        parentID: z.string(),
        type: z.string(),
        title: z.string(),
        isNav: z.number().int(),
      }),
    ),
  }),
  fixtures: z.record(z.string(), z.array(z.unknown())),
});

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** `${<step>.<binding>}` placeholder text. */
function bound(step: string, binding: string): string {
  return `\${${step}.${binding}}`;
}

/** Admin route `/admin/?muraAction=<action>&<name>=<value>…`; values are ids or placeholders, sent unencoded. */
function adminRoute(action: string, params: readonly (readonly [string, string])[] = []): string {
  return `/admin/?${[['muraAction', action] as const, ...params].map(([name, value]) => `${name}=${value}`).join('&')}`;
}

/** A catalogue step, validated and defaulted by the catalogue's own schema. */
function step(input: z.input<typeof stepSchema>): Step {
  return stepSchema.parse(input);
}

/** Plan items of one kind and the writes among them. */
interface PlanPart {
  items: Step[];
  writes: WorkloadWrite[];
}

/** Write `name`: item `probe`, whose response `check` shows it applied, then the items `sent` unless it is. */
function writePart(name: string, probe: Step, check: WriteCheck, sent: readonly Step[]): PlanPart {
  return { items: [probe, ...sent], writes: [{ name, probe: probe.name, check, skip: sent.map((item) => item.name) }] };
}

function joinParts(parts: readonly PlanPart[]): PlanPart {
  return { items: parts.flatMap((part) => part.items), writes: parts.flatMap((part) => part.writes) };
}

/**
 * `count` rows of `rows` sorted by `key`, taken consecutively (wrapping) from an offset fixed by `seed` and `label`.
 * Throws GoldenConfigError when fewer than `count` rows are eligible.
 */
function pick<T>(rows: readonly T[], key: (row: T) => string, count: number, seed: number, label: string): T[] {
  const sorted = [...rows].sort((a, b) => compareText(key(a), key(b)));
  if (sorted.length < count) {
    throw new GoldenConfigError(`workload needs ${count} ${label} rows; the dataset has ${sorted.length} eligible`);
  }
  const start = Number.parseInt(sha256Hex(`${seed}:${label}`).slice(0, 12), 16) % sorted.length;
  return Array.from({ length: count }, (_, i) => sorted[(start + i) % sorted.length] as T);
}

/** Rows of fixture table `key`, validated by `schema`; throws GoldenConfigError when absent or malformed. */
function fixtureRows<T>(dataset: WorkloadDataset, key: string, schema: z.ZodType<T>): T[] {
  const rows = dataset.fixtures?.[key];
  if (rows === undefined) throw new GoldenConfigError(`seed dataset has no fixture table ${key}`);
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) {
    throw new GoldenConfigError(`seed dataset fixture table ${key}: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Admin login as plan steps (login page, then its form posted), as GS-ID-01 logs in, so the step runner drives it. */
function loginItems(username: string): Step[] {
  return [
    step({ name: 'admin-login-form', method: 'GET', route: adminRoute('clogin.main'), as: ADMIN_SESSION }),
    step({
      name: 'admin-login',
      method: 'POST',
      route: '/admin/index.cfm',
      as: ADMIN_SESSION,
      csrf: 'fetch-form',
      csrfFrom: 'admin-login-form',
      form: {
        username,
        password: '${secret:admin}',
        muraAction: 'cLogin.login',
        isAdminLogin: 'true',
        returnUrl: '',
        compactDisplay: 'false',
      },
    }),
  ];
}

/** `cArch.update` fields every content save sends. */
function contentFields(site: string, title: string, body: string): Record<string, string> {
  return {
    muraAction: 'cArch.update',
    action: 'add',
    siteid: site,
    moduleid: MODULE_ID,
    type: 'Page',
    subtype: 'Default',
    title,
    menutitle: title,
    body,
    // approved=1 is a withheld variant (publish), so edits and creates save drafts, as GS-CO-01/02 do.
    approved: '0',
    display: '1',
  };
}

/**
 * Edit of an existing page unless a version in its history carries the edit's title: read its active version, open
 * it in the editor, save a draft with a new title and body.
 */
function contentEditItems(row: WorkloadContent, n: number): PlanPart {
  const base = `content-edit-${n}`;
  const site = row.siteID;
  const title = clip(`${row.title} (OPT-2 workload ${n})`, TITLE_MAX);
  const probe = step({
    name: `${base}-probe`,
    method: 'GET',
    route: `/_api/json/v1/${site}/content/${row.contentID}/history?itemsPerPage=*`,
    as: ADMIN_SESSION,
    extract: { items: { from: 'body', path: 'data.items' } },
  });
  return writePart(base, probe, { kind: 'some-equals', binding: 'items', field: 'title', value: title }, [
    step({
      name: `${base}-find`,
      method: 'GET',
      route: `/_api/json/v1/${site}/content/${row.contentID}`,
      as: ADMIN_SESSION,
      extract: { contenthistid: { from: 'body', path: 'data.contenthistid' } },
    }),
    step({
      name: `${base}-form`,
      method: 'GET',
      route: adminRoute('cArch.edit', [
        ['siteid', site],
        ['moduleid', MODULE_ID],
        ['topid', HOME_ID],
        ['contentid', row.contentID],
        ['contenthistid', bound(`${base}-find`, 'contenthistid')],
        ['parentid', row.parentID],
        ['type', 'Page'],
      ]),
      as: ADMIN_SESSION,
      extract: {
        contenthistid: { from: 'dom', selector: 'form#contentForm input[name=contenthistid]', attr: 'value' },
      },
    }),
    step({
      name: `${base}-save`,
      method: 'POST',
      route: adminRoute('cArch.update'),
      as: ADMIN_SESSION,
      csrf: 'fetch-form',
      csrfFrom: `${base}-form`,
      form: {
        ...contentFields(site, title, `<p>OPT-2 workload edit ${n}</p>`),
        contentid: row.contentID,
        contenthistid: bound(`${base}-form`, 'contenthistid'),
        parentid: row.parentID,
        isNav: String(row.isNav),
      },
    }),
  ]);
}

/**
 * New page under the home node of `site` unless a page of its title exists (drafts included, so `liveOnly=0`). Each
 * new-page form mints its own contentid and contenthistid, and `cArch.update` checks its CSRF token against that
 * contenthistid, so the save posts the ids of the form the tokens come from (its hidden fields) rather than ids bound
 * from an earlier fetch.
 */
function contentCreateItems(site: string, n: number): PlanPart {
  const base = `content-create-${n}`;
  const title = `OPT-2 Workload Page ${n}`;
  const probe = step({
    name: `${base}-probe`,
    method: 'GET',
    route: `/_api/json/v1/${site}/content/?title=${encodeURIComponent(title)}&liveOnly=0`,
    as: ADMIN_SESSION,
    extract: { items: { from: 'body', path: 'data.items' } },
  });
  return writePart(base, probe, { kind: 'some-equals', binding: 'items', field: 'title', value: title }, [
    step({
      name: `${base}-form`,
      method: 'GET',
      route: adminRoute('cArch.edit', [
        ['siteid', site],
        ['moduleid', MODULE_ID],
        ['parentid', HOME_ID],
        ['topid', HOME_ID],
        ['type', 'Page'],
        ['contentid', ''],
        ['contenthistid', ''],
      ]),
      as: ADMIN_SESSION,
    }),
    step({
      name: `${base}-save`,
      method: 'POST',
      route: adminRoute('cArch.update'),
      as: ADMIN_SESSION,
      csrf: 'fetch-form',
      csrfFrom: `${base}-form`,
      form: {
        ...contentFields(site, title, `<p>OPT-2 workload page ${n}</p>`),
        parentid: HOME_ID,
        isNav: '1',
      },
    }),
  ]);
}

/**
 * Roster edit of a system user without a photo (`cusers.update` type=2 action=Update) unless its form shows the
 * edit's job title, then a new address unless one of its name exists.
 */
function userEditItems(user: WorkloadUser, n: number): PlanPart {
  const base = `user-edit-${n}`;
  const site = user.siteID;
  const jobtitle = `OPT-2 Workload Analyst ${n}`;
  const addressName = `OPT-2 Workload Office ${n}`;
  const form = step({
    name: `${base}-form`,
    method: 'GET',
    route: adminRoute('cUsers.editUser', [
      ['siteid', site],
      ['userid', user.userID],
    ]),
    as: ADMIN_SESSION,
    extract: { jobtitle: { from: 'dom', selector: 'input[name=jobtitle]', attr: 'value' } },
  });
  const addressProbe = step({
    name: `${base}-address-probe`,
    method: 'GET',
    route: `/_api/json/v1/${site}/address/?userid=${user.userID}`,
    as: ADMIN_SESSION,
    extract: { items: { from: 'body', path: 'data.items' } },
  });
  const addressCheck: WriteCheck = { kind: 'some-equals', binding: 'items', field: 'addressname', value: addressName };
  return joinParts([
    writePart(base, form, { kind: 'equals', binding: 'jobtitle', value: jobtitle }, [
      step({
        name: `${base}-save`,
        method: 'POST',
        route: adminRoute('cUsers.update', [
          ['userid', user.userID],
          ['routeid', ''],
        ]),
        as: ADMIN_SESSION,
        csrf: 'fetch-form',
        csrfFrom: `${base}-form`,
        form: {
          type: '2',
          action: 'Update',
          siteid: site,
          isPublic: '0',
          fname: user.fname,
          lname: user.lname,
          email: user.email,
          usernameNoCache: user.username,
          InActive: '0',
          subscribe: String(user.subscribe),
          jobtitle,
          company: `OPT-2 Workload Company ${n}`,
        },
      }),
    ]),
    writePart(`${base}-address`, addressProbe, addressCheck, [
      step({
        name: `${base}-address-form`,
        method: 'GET',
        route: adminRoute('cUsers.editAddress', [
          ['siteid', site],
          ['userid', user.userID],
          ['addressid', ''],
          ['routeid', ''],
        ]),
        as: ADMIN_SESSION,
      }),
      step({
        name: `${base}-address-save`,
        method: 'POST',
        route: adminRoute('cUsers.updateAddress', [
          ['userid', user.userID],
          ['routeid', ''],
          ['siteid', site],
        ]),
        as: ADMIN_SESSION,
        csrf: 'fetch-form',
        csrfFrom: `${base}-address-form`,
        form: {
          action: 'Add',
          siteid: site,
          isPublic: '0',
          addressName,
          address1: `${n} Workload Way`,
          city: 'Sample City',
          state: 'NY',
          zip: `1010${n}`,
          country: 'USA',
        },
      }),
    ]),
  ]);
}

/** Group edit without a photo (`cusers.update` type=1 action=Update) unless its form shows the new group email. */
function groupEditItems(group: WorkloadGroup, n: number): PlanPart {
  const base = `group-edit-${n}`;
  const email = `opt2-workload-group-${n}@${EMAIL_DOMAIN}`;
  const form = step({
    name: `${base}-form`,
    method: 'GET',
    route: adminRoute('cUsers.editGroup', [
      ['siteid', group.siteID],
      ['userid', group.groupID],
    ]),
    as: ADMIN_SESSION,
    extract: { email: { from: 'dom', selector: 'input[name=email]', attr: 'value' } },
  });
  return writePart(base, form, { kind: 'equals', binding: 'email', value: email }, [
    step({
      name: `${base}-save`,
      method: 'POST',
      route: adminRoute('cUsers.update', [['userid', group.groupID]]),
      as: ADMIN_SESSION,
      csrf: 'fetch-form',
      csrfFrom: `${base}-form`,
      form: {
        type: '1',
        action: 'Update',
        siteid: group.siteID,
        isPublic: '0',
        groupname: group.groupname,
        email,
      },
    }),
  ]);
}

/** Site edit of a non-pool setting (`csettings.updateSite` action=Update): the contact address. */
function siteEditItems(site: string): PlanPart {
  const contact = `opt2-workload-site@${EMAIL_DOMAIN}`;
  const form = step({
    name: 'site-edit-form',
    method: 'GET',
    route: adminRoute('cSettings.editSite', [['siteid', site]]),
    as: ADMIN_SESSION,
    extract: { contact: { from: 'dom', selector: 'input[name=contact]', attr: 'value' } },
  });
  return writePart('site-edit', form, { kind: 'equals', binding: 'contact', value: contact }, [
    step({
      name: 'site-edit-save',
      method: 'POST',
      route: adminRoute('cSettings.updateSite'),
      as: ADMIN_SESSION,
      csrf: 'fetch-form',
      csrfFrom: 'site-edit-form',
      form: { siteid: site, action: 'Update', contact },
    }),
  ]);
}

/** JSON API login of the seeded `role` account of `site` into `session`, as the catalogue's jsonapi sessions log in. */
function roleLoginItem(name: string, session: string, site: string, role: string): Step {
  const user = `\${user:${site}:${role}}`;
  return step({
    name,
    method: 'POST',
    route: `/_api/json/v1/${site}/login`,
    as: session,
    csrf: 'json-api:login',
    form: { username: user, password: `\${secret:seed:${user}}` },
  });
}

/**
 * Fixture writes in the `Program_<id>` schema of the edit site: DRAFT day submits unless the day has left DRAFT, then
 * IN-PROGRESS record edits unless the record holds the edit's title.
 */
function fixtureItems(config: WorkloadSeedConfig, dataset: WorkloadDataset, keys: ReadonlySet<string>): PlanPart {
  const site = WORKLOAD_SITES.edits;
  const programId = config.sites[site]?.programId;
  if (programId === undefined || programId === null) {
    throw new GoldenConfigError(`seed config gives ${site} no programId`, { path: SEED_CONFIG_PATH });
  }
  const schema = `Program_${programId}`;
  const sheets = new Map(
    fixtureRows(dataset, `${schema}.timesheet`, timesheetRowSchema).map((row) => [row.timesheet_id, row] as const),
  );
  const days = fixtureRows(dataset, `${schema}.timesheet_day`, dayRowSchema).filter((day) => {
    const sheet = sheets.get(day.timesheet_id);
    return (
      sheet !== undefined &&
      sheet.siteID === site &&
      day.state === DRAFT_DAY &&
      ![day.day_id, day.timesheet_id, sheet.person_id].some((key) => keys.has(key))
    );
  });
  const records = fixtureRows(dataset, `${schema}.finance_record`, financeRowSchema).filter(
    (row) => row.siteID === site && row.state === IN_PROGRESS && !keys.has(row.record_id),
  );
  const submits = pick(days, (day) => day.day_id, WORKLOAD_COUNTS.timesheetSubmits, config.seed, 'timesheet-submit');
  const edits = pick(records, (row) => row.record_id, WORKLOAD_COUNTS.financeEdits, config.seed, 'finance-edit');
  const submitPart = (day: z.infer<typeof dayRowSchema>, n: number): PlanPart => {
    const name = `timesheet-submit-${n}`;
    const probe = step({
      name: `${name}-probe`,
      method: 'GET',
      route: `${FIXTURE_API}/timesheets/sheets/${day.timesheet_id}?siteid=${site}`,
      as: EMPLOYEE_SESSION,
      extract: { days: { from: 'body', path: 'data.days' } },
    });
    const check: WriteCheck = {
      kind: 'keyed-not-equals',
      binding: 'days',
      key: 'day_id',
      id: day.day_id,
      field: 'state',
      value: DRAFT_DAY,
    };
    return writePart(name, probe, check, [
      step({
        name,
        method: 'POST',
        route: `${FIXTURE_API}/timesheets/days/${day.day_id}/submit?siteid=${site}`,
        as: EMPLOYEE_SESSION,
        csrf: `json-api:${day.day_id}`,
      }),
    ]);
  };
  const editPart = (row: z.infer<typeof financeRowSchema>, n: number): PlanPart => {
    const name = `finance-edit-${n}`;
    const title = `OPT-2 workload edit ${n}`;
    const probe = step({
      name: `${name}-probe`,
      method: 'GET',
      route: `${FIXTURE_API}/finance/records/${row.record_id}?siteid=${site}`,
      as: PREPARER_SESSION,
      extract: { title: { from: 'body', path: 'data.title' } },
    });
    return writePart(name, probe, { kind: 'equals', binding: 'title', value: title }, [
      step({
        name,
        method: 'POST',
        route: `${FIXTURE_API}/finance/records/${row.record_id}/edit?siteid=${site}`,
        as: PREPARER_SESSION,
        csrf: `json-api:${row.record_id}`,
        body: { title, amount: row.amount, period: row.period },
      }),
    ]);
  };
  return joinParts([
    { items: [roleLoginItem('employee-login', EMPLOYEE_SESSION, site, Roles.timesheetsEmployee)], writes: [] },
    ...submits.map((day, i) => submitPart(day, i + 1)),
    { items: [roleLoginItem('preparer-login', PREPARER_SESSION, site, Roles.financePreparer)], writes: [] },
    ...edits.map((row, i) => editPart(row, i + 1)),
  ]);
}

/**
 * The workload for `config` and `dataset`: admin login, content edits and creates, user, group and site edits, and,
 * with the fixtures available, timesheet submits and finance edits, each write preceded by the probe that shows it
 * applied. Pure: equal inputs give an equal plan. Rows are chosen by sorted key from seed-derived offsets, never among
 * reserved rehearsal identities, `excludedKeys`, role groups or users holding memberships. Throws GoldenConfigError
 * when a kind has too few eligible rows.
 */
export function buildWorkloadPlan(
  config: WorkloadSeedConfig,
  dataset: WorkloadDataset,
  opts: WorkloadPlanOptions,
): WorkloadPlan {
  const { rehearsal } = config.reserved;
  const keys = new Set<string>([...(opts.excludedKeys ?? []), ...rehearsal.persons, ...rehearsal.usernames]);
  for (const user of dataset.masa.users) if (keys.has(user.username)) keys.add(user.userID);
  // cUsers.update replaces a user's memberships with the posted groupid list, which defaults to empty, so only users
  // without memberships are edited: the save then leaves tusersmemb as it was.
  const members = new Set(dataset.masa.memberships.map((m) => m.userID));
  const site = WORKLOAD_SITES.edits;
  const pages = dataset.masa.content.filter(
    (row) => row.siteID === site && row.type === 'Page' && !keys.has(row.contentID),
  );
  const users = dataset.masa.users.filter(
    (row) =>
      row.siteID === site &&
      row.isPublic === 0 &&
      !members.has(row.userID) &&
      !keys.has(row.userID) &&
      !keys.has(row.username),
  );
  const groups = dataset.masa.groups.filter(
    (row) =>
      row.siteID === site && !ROLE_GROUPS.has(row.groupname) && !keys.has(row.groupID) && !keys.has(row.groupname),
  );
  const { seed } = config;
  const { items, writes } = joinParts([
    { items: loginItems(opts.adminUsername ?? 'admin'), writes: [] },
    ...pick(pages, (row) => row.contentID, WORKLOAD_COUNTS.contentEdits, seed, 'content-edit').map((row, i) =>
      contentEditItems(row, i + 1),
    ),
    ...Array.from({ length: WORKLOAD_COUNTS.contentCreates }, (_, i) =>
      contentCreateItems(WORKLOAD_SITES.creates, i + 1),
    ),
    ...pick(users, (row) => row.userID, WORKLOAD_COUNTS.userEdits, seed, 'user-edit').map((row, i) =>
      userEditItems(row, i + 1),
    ),
    ...pick(groups, (row) => row.groupID, WORKLOAD_COUNTS.groupEdits, seed, 'group-edit').map((row, i) =>
      groupEditItems(row, i + 1),
    ),
    siteEditItems(WORKLOAD_SITES.settings),
    ...(opts.fixturesAvailable ? [fixtureItems(config, dataset, keys)] : []),
  ]);
  return { seed, items, writes };
}

/** Lowercase hex SHA-256 of the plan's items as stable JSON. */
export function planDigest(plan: Pick<WorkloadPlan, 'items'>): string {
  return sha256Hex(stableStringify(plan.items));
}

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/**
 * Every string held by a row (or reserved scalar) the scenarios' seedRefs select, plus the username of each seeded
 * role account they name (`${user:<site>:<role>}`, `seed:<site>:<role>` logins). Refs resolve as at capture, so an
 * unresolvable one throws GoldenConfigError or MissingSecretError.
 */
export function catalogueSeedKeys(
  scenarios: ReadonlyArray<ScenarioInput & Pick<Scenario, 'sessions'>>,
  stores: SeedKeyStores,
): Set<string> {
  const keys = new Set<string>();
  for (const scenario of scenarios) {
    const ctx = createScenarioContext(scenario, {
      origin: 'gateway',
      env: stores.env,
      seed: stores.seed,
      secrets: stores.secrets,
    });
    for (const row of ctx.seedRows.values()) collectStrings(row, keys);
    const logins = Object.values(scenario.sessions).map((spec) => spec.login);
    for (const name of [...placeholderNames(scenario), ...logins]) {
      const account = ROLE_ACCOUNT.exec(name);
      if (account !== null) keys.add(stores.secrets.username(account[1] as string, account[2] as string));
    }
  }
  return keys;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 400;
}

const UNVERIFIED = 'could not verify whether it is already applied, so it was not sent';

/** Records of one sent item, or the redacted text of the Error it threw. */
type Sent = StepRecord[] | string;

/** Failures of a sent item: the error it threw, else each record answered other than 2xx/3xx. */
function failuresOf(item: Step, sent: Sent): WorkloadFailure[] {
  if (typeof sent === 'string') return [{ name: item.name, routeKey: null, status: null, reason: sent }];
  return sent
    .filter((record) => !isSuccess(record.response.status))
    .map((record) => {
      const { status } = record.response;
      return { name: record.name, routeKey: record.routeKey, status, reason: `status ${status}` };
    });
}

/** Field `name` of a JSON object, matched exactly, then case-insensitively; undefined for anything else. */
function fieldOf(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined;
  const record = row as Record<string, unknown>;
  const lower = name.toLowerCase();
  const key = Object.hasOwn(record, name) ? name : Object.keys(record).find((field) => field.toLowerCase() === lower);
  return key === undefined ? undefined : record[key];
}

function scalarText(value: unknown): string | undefined {
  const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  return scalar ? String(value) : undefined;
}

/** Whether `check` holds of a probe's `extracted` bindings; undefined when a binding, element or field is missing. */
function holds(check: WriteCheck, extracted: Record<string, unknown>): boolean | undefined {
  const value = Object.hasOwn(extracted, check.binding) ? extracted[check.binding] : undefined;
  if (check.kind === 'equals') {
    const text = scalarText(value);
    return text === undefined ? undefined : text === check.value;
  }
  if (!Array.isArray(value)) return undefined;
  if (check.kind === 'some-equals') {
    const texts = value.map((row) => scalarText(fieldOf(row, check.field)));
    if (texts.includes(check.value)) return true;
    return texts.includes(undefined) ? undefined : false;
  }
  const text = scalarText(fieldOf(value.find((row) => scalarText(fieldOf(row, check.key)) === check.id), check.field));
  return text === undefined ? undefined : text !== check.value;
}

/** Whether probe `item`'s `sent` shows `write` applied, else why that cannot be told. */
function verdictOf(write: WorkloadWrite, item: Step, sent: Sent): boolean | string {
  const [failure] = failuresOf(item, sent);
  if (failure !== undefined) return failure.reason;
  const [record] = typeof sent === 'string' ? [] : sent;
  const applied = record === undefined || sent.length !== 1 ? undefined : holds(write.check, record.extracted);
  return applied ?? `binding ${write.check.binding} lacks what its ${write.check.kind} check reads`;
}

/** The one failure of a write its probe could not verify: the write, the probe's response and its cause. */
function unverifiedFailure(write: WorkloadWrite, sent: Sent, cause: string): WorkloadFailure {
  const record = typeof sent === 'string' ? undefined : sent[0];
  return {
    name: write.name,
    routeKey: record?.routeKey ?? null,
    status: record?.response.status ?? null,
    reason: `${UNVERIFIED} (${write.probe}: ${cause})`,
  };
}

/**
 * Sends the plan in order through the gateway in one scenario context (sessions named by the items' `as`, logged in
 * by the plan's own login items) with the shared step runner, rewriting `<state>/golden/workload.json` after each
 * item. After a write's probe, the write's items stay unsent when its check holds, and, as one failure naming the
 * write, when the probe fails or its check cannot be evaluated. Elsewhere a response other than 2xx/3xx, or a step
 * that throws, is a failure; the run continues. Throws GoldenConfigError, sending nothing, when a write's probe is
 * missing, shared, among any write's items, or after its own items.
 */
export async function runWorkload(plan: WorkloadPlan, deps: WorkloadDeps = {}): Promise<WorkloadRun> {
  const position = new Map(plan.items.map((item, index) => [item.name, index] as const));
  const skipped = new Set(plan.writes.flatMap((write) => write.skip));
  const probes = new Map(plan.writes.map((write) => [write.probe, write] as const));
  for (const write of plan.writes) {
    const at = position.get(write.probe);
    const ordered = at !== undefined && write.skip.every((name) => (position.get(name) ?? -1) > at);
    if (!ordered || skipped.has(write.probe) || probes.get(write.probe) !== write) {
      throw new GoldenConfigError(`workload write ${write.name} needs its own probe ${write.probe} before its items`);
    }
  }
  const env = deps.env ?? process.env;
  const names = [...new Set(plan.items.map((item) => item.as ?? ADMIN_SESSION))];
  const unauthenticated: SessionSpec = { login: 'none', via: 'admin' };
  const ctx = createScenarioContext(
    { id: WORKLOAD_ID, sessions: Object.fromEntries(names.map((name) => [name, unauthenticated])) },
    { origin: 'gateway', env, fetch: deps.fetch, secrets: deps.secrets, seed: deps.seed },
  );
  const scenario = { id: WORKLOAD_ID, steps: plan.items };
  const digest = planDigest(plan);
  const file = path.join(stateDir(env), 'golden', 'workload.json');
  const items: WorkloadItem[] = [];
  const failures: WorkloadFailure[] = [];
  const writes = { sent: 0, alreadyApplied: 0 };
  const withheld = new Map<string, NonNullable<WorkloadItem['skipped']>>();
  const journal = async (status: WorkloadStatus): Promise<string> =>
    (await writeJsonReport(file, { planDigest: digest, status, items, failures }, deps.report)).path;
  const send = async (index: number, item: Step): Promise<Sent> => {
    try {
      const records = await runStep(ctx, scenario, item, {
        mode: 'replay',
        index,
        fetch: deps.fetch,
        routeKeyOptions: deps.routeKeyOptions,
      });
      for (const record of records) {
        items.push({ name: record.name, routeKey: record.routeKey, status: record.response.status });
      }
      return records;
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      items.push({ name: item.name, routeKey: null, status: null });
      return redact(`${err.name}: ${err.message}`, secretValues(ctx));
    }
  };
  const handle = async (index: number, item: Step): Promise<void> => {
    const skip = withheld.get(item.name);
    if (skip !== undefined) {
      items.push({ name: item.name, routeKey: null, status: null, skipped: skip });
      return;
    }
    const sent = await send(index, item);
    const write = probes.get(item.name);
    if (write === undefined) {
      failures.push(...failuresOf(item, sent));
      return;
    }
    const verdict = verdictOf(write, item, sent);
    if (verdict === false) {
      writes.sent += 1;
      return;
    }
    if (verdict === true) writes.alreadyApplied += 1;
    else failures.push(unverifiedFailure(write, sent, verdict));
    for (const name of write.skip) withheld.set(name, verdict === true ? 'already-applied' : 'unverified');
  };

  for (const [index, item] of plan.items.entries()) {
    await handle(index, item);
    await journal('running');
  }
  const report = await journal('complete');
  const outcome: WorkloadOutcome = writes.alreadyApplied === plan.writes.length ? 'already-applied' : 'complete';
  return { outcome, planDigest: digest, items, failures, writes, report };
}

/** Input file locations of {@link loadWorkloadInputs}; each defaults to the committed or generated file. */
export interface WorkloadPaths {
  seedConfig?: string;
  dataset?: string;
  catalogue?: string;
}

/** Everything {@link buildWorkloadPlan} reads. */
export interface WorkloadInputs {
  config: WorkloadSeedConfig;
  dataset: WorkloadDataset;
  options: WorkloadPlanOptions;
}

/**
 * Reads the seed configuration, the generated dataset, the fixture status and the catalogue, and resolves the
 * catalogue's seeded references into the plan's excluded keys. The admin username is `MURA_ADMIN_USERNAME`, else
 * `admin`.
 */
export async function loadWorkloadInputs(stores: SeedKeyStores, paths: WorkloadPaths = {}): Promise<WorkloadInputs> {
  const env = stores.env ?? process.env;
  const [config, dataset, catalogue] = await Promise.all([
    readJson(paths.seedConfig ?? SEED_CONFIG_PATH, workloadSeedConfigSchema),
    readJson(paths.dataset ?? path.join(stateDir(env), 'seed', 'dataset.json'), workloadDatasetSchema),
    loadCatalogue(paths.catalogue ?? CATALOGUE_PATH),
  ]);
  const adminUsername = env.MURA_ADMIN_USERNAME;
  return {
    config,
    dataset,
    options: {
      fixturesAvailable: readFixtureStatus(env).available,
      excludedKeys: catalogueSeedKeys(catalogue.scenarios, stores),
      adminUsername: adminUsername === undefined || adminUsername === '' ? 'admin' : adminUsername,
    },
  };
}

const USAGE = 'usage: tsx src/golden/workload.ts';
const HELP = `${USAGE}

Sends the deterministic legacy write workload of test-all stage 4 through the gateway (OPT2_GATEWAY_URL, default
http://127.0.0.1:8100) while v0001 is active. Reads legacy-fixtures/seed/seed.config.json,
\${OPT2_STATE_DIR}/seed/dataset.json, \${OPT2_STATE_DIR}/fixtures.json and harness/golden/catalogue.yaml.
Writes \${OPT2_STATE_DIR}/golden/workload.json after each step; exits 1 when any step fails.
Each write is first checked against legacy and skipped when already applied, so reruns add nothing.`;

/** CLI entry: builds and runs the workload; exits 1 when any item failed. */
export async function main(argv: string[], deps: WorkloadDeps = {}): Promise<CliOutcome> {
  parseFlags(argv, { options: {}, usage: USAGE, help: HELP });
  const env = deps.env ?? process.env;
  const secrets = deps.secrets ?? loadSecretStore(env);
  const seed = deps.seed ?? loadSeedStore(env);
  const inputs = await loadWorkloadInputs({ env, secrets, seed });
  const plan = buildWorkloadPlan(inputs.config, inputs.dataset, inputs.options);
  const run = await runWorkload(plan, { ...deps, env, secrets, seed });
  for (const failure of run.failures) process.stderr.write(`${failure.name}: ${failure.reason}\n`);
  return {
    code: run.failures.length > 0 ? 1 : 0,
    summary: {
      outcome: run.outcome,
      items: run.items.length,
      failures: run.failures.length,
      writesSent: run.writes.sent,
      writesAlreadyApplied: run.writes.alreadyApplied,
      planDigest: run.planDigest,
      fixturesAvailable: inputs.options.fixturesAvailable,
      report: run.report,
    },
  };
}

if (isMainModule(import.meta.url)) void runCli(main);
