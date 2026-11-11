// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { sha256Hex } from '../bytes.js';
import { SITE_ORDER, type SiteKey } from '../config.js';
import { FIXTURE_TABLE_SPECS, fixtureKey, type FixtureContext, type FixtureRow, type FixtureTables } from '../fixture-tables.js';
import { cfUuidFrom } from '../ids.js';
import type { SeedRandom } from '../random.js';

type SurveyStatus = 'DRAFT' | 'SCHEDULED' | 'LAUNCHED' | 'CLOSED';
type QuestionKind = 'rating' | 'choice' | 'text';

/** Wall-clock instant: minutes from local midnight of the business date, plus milliseconds. */
interface Instant {
  minute: number;
  ms: number;
}

/** A generated survey as its responses need it. */
interface SurveyPlan {
  surveyId: string;
  /** When the launch task ran; null unless LAUNCHED or CLOSED. */
  launched: Instant | null;
  questions: readonly QuestionKind[];
  targetsPartner: boolean;
}

type LaunchedPlan = SurveyPlan & { launched: Instant };

/** Users of one site who answer surveys, and how many responses each survey takes from them. */
interface ResponsePool {
  siteID: SiteKey;
  users: readonly string[];
  perSurvey: ReadonlyMap<LaunchedPlan, number>;
}

const MANAGER_ROLE = 'surveys.manager';
const TASK_PREFIX = 'opt2-survey-';
const MINUTES_PER_DAY = 1440;
// The first surveys of a site take each status once, responding ones first, so a small site can still take responses.
const BASE_STATUSES: readonly SurveyStatus[] = ['LAUNCHED', 'CLOSED', 'SCHEDULED', 'DRAFT'];
const STATUS_WEIGHTS: readonly (readonly [SurveyStatus, number])[] = [
  ['DRAFT', 2],
  ['SCHEDULED', 2],
  ['LAUNCHED', 4],
  ['CLOSED', 2],
];
const RESPONDING: readonly SurveyStatus[] = ['LAUNCHED', 'CLOSED'];
// A survey that gets a schedule is created at least this many days before the business date, leaving room for launch and responses.
const SCHEDULE_LEAD_DAYS = 30;
const MAX_SCHEDULE_DELAY_MINUTES = 3 * MINUTES_PER_DAY;
const MAX_LAUNCH_DELAY_DAYS = 14;
const MAX_REMINDERS = 3;
const MAX_REMINDER_GAP_DAYS = 7;
const MAX_TASK_DELAY_MINUTES = 2;
const MAX_OWN_TARGETS = 3;
const MAX_PARTNER_TARGETS = 2;
const PARTNER_TARGET_SHARE = 0.3;
const QUESTION_KINDS: readonly QuestionKind[] = ['rating', 'choice', 'text'];
const CHOICES: readonly string[] = ['Strongly agree', 'Agree', 'Neutral', 'Disagree', 'Strongly disagree'];

const SURVEY_SPECS = FIXTURE_TABLE_SPECS.filter((spec) => spec.module === 'surveys');

/** Row list of surveys table `table`; throws `RangeError` when the registry has no such table. */
function rowsOf(rows: ReadonlyMap<string, FixtureRow[]>, table: string): FixtureRow[] {
  const found = rows.get(table);
  if (found === undefined) throw new RangeError(`No surveys fixture table ${table}`);
  return found;
}

/** Instant at `minute` with milliseconds drawn from `rng`. */
function instant(rng: SeedRandom, minute: number): Instant {
  return { minute, ms: rng.int(0, 99) * 10 };
}

/** Sort order of instants, earliest first. */
function byInstant(a: Instant, b: Instant): number {
  return a.minute - b.minute || a.ms - b.ms;
}

/** Local `yyyy-MM-ddTHH:mm:ss.SSS` of `at`. */
function stamp(ctx: FixtureContext, at: Instant): string {
  return ctx.calendar.localTimestamp(0, at.minute, at.ms);
}

/** Group names of `siteID`, stored in its private user pool. */
function groupNames(ctx: FixtureContext, siteID: SiteKey): string[] {
  return ctx.index.groups(ctx.index.site(siteID).privateUserPoolID).map((group) => group.groupname);
}

/** System users of `siteID`'s private pool who may answer surveys: every one but the reserved rehearsal persons. */
function respondents(ctx: FixtureContext, siteID: SiteKey): string[] {
  return ctx.index
    .systemUsers(ctx.index.site(siteID).privateUserPoolID)
    .filter((user) => !ctx.index.isReserved(user.userID))
    .map((user) => user.userID);
}

/** First other site, in `SITE_ORDER`, with groups to target and users to respond; null when none has both. */
function partnerSite(ctx: FixtureContext, siteID: SiteKey): SiteKey | null {
  return (
    SITE_ORDER.find((other) => other !== siteID && groupNames(ctx, other).length > 0 && respondents(ctx, other).length > 0) ??
    null
  );
}

/** Compact JSON answers to `questions`, keyed `q1`, `q2`, ... */
function answersJson(rng: SeedRandom, questions: readonly QuestionKind[]): string {
  const answers: Record<string, string | number> = {};
  questions.forEach((kind, i) => {
    answers[`q${i + 1}`] = kind === 'rating' ? rng.int(1, 5) : kind === 'choice' ? rng.pick(CHOICES) : rng.faker.lorem.sentence();
  });
  return JSON.stringify(answers);
}

/** Spreads `total` responses over `plans` one random pick at a time. */
function allocate<T>(rng: SeedRandom, plans: readonly T[], total: number): Map<T, number> {
  const counts = new Map<T, number>();
  for (let i = 0; i < total; i += 1) {
    const plan = rng.pick(plans);
    counts.set(plan, (counts.get(plan) ?? 0) + 1);
  }
  return counts;
}

/** Surveys of one site with their schedules, reminders and targets, oldest first. */
function buildSurveys(
  ctx: FixtureContext,
  rng: SeedRandom,
  siteID: SiteKey,
  partner: SiteKey | null,
  rows: ReadonlyMap<string, FixtureRow[]>,
): SurveyPlan[] {
  const { counts } = ctx.config.sites[siteID];
  const creators = ctx.index.actors(siteID, MANAGER_ROLE);
  if (creators.length === 0) throw new RangeError(`Site ${siteID} has no ${MANAGER_ROLE} to create its surveys`);
  const ownGroups = groupNames(ctx, siteID);
  const partnerGroups = partner === null ? [] : groupNames(ctx, partner);
  const { historyDays } = ctx.config;

  const statuses = rng.shuffle(
    Array.from({ length: counts.surveys }, (_, i): SurveyStatus => BASE_STATUSES[i] ?? rng.weighted(STATUS_WEIGHTS)),
  );
  const surveys = statuses
    .map((status) => {
      const day =
        status === 'DRAFT' ? -rng.int(1, historyDays) : -rng.int(SCHEDULE_LEAD_DAYS, Math.max(SCHEDULE_LEAD_DAYS, historyDays));
      return { status, created: instant(rng, day * MINUTES_PER_DAY + rng.int(8 * 60, 18 * 60 - 1)) };
    })
    .sort((a, b) => byInstant(a.created, b.created));

  // BASE_STATUSES puts a LAUNCHED survey on every site with surveys, so a responding survey always exists.
  const forcedPartner = counts.multiSiteResponses > 0 ? surveys.findIndex((survey) => RESPONDING.includes(survey.status)) : -1;

  return surveys.map(({ status, created }, index): SurveyPlan => {
    const surveyId = cfUuidFrom(rng);
    const createdByID = rng.pick(creators);
    const title = `${rng.faker.company.catchPhrase()} survey`;
    const questions = Array.from({ length: rng.int(3, 6) }, () => rng.pick(QUESTION_KINDS));
    let launchAt: number | null = null;
    let launched: Instant | null = null;

    if (status !== 'DRAFT') {
      const scheduled = instant(rng, created.minute + rng.int(10, MAX_SCHEDULE_DELAY_MINUTES));
      const launchDay = Math.floor(scheduled.minute / MINUTES_PER_DAY) + rng.int(1, MAX_LAUNCH_DELAY_DAYS);
      launchAt = launchDay * MINUTES_PER_DAY + rng.int(8, 17) * 60;
      if (RESPONDING.includes(status)) launched = instant(rng, launchAt + rng.int(0, MAX_TASK_DELAY_MINUTES));
      // One token serves the launch task and every reminder task of a schedule.
      const taskTokenHash = sha256Hex(rng.bytes(32));
      rowsOf(rows, 'survey_schedule').push({
        schedule_id: cfUuidFrom(rng),
        survey_id: surveyId,
        launch_at: stamp(ctx, { minute: launchAt, ms: 0 }),
        schedule_version: 1,
        task_name: `${TASK_PREFIX}${surveyId}-launch`,
        task_token_hash: taskTokenHash,
        created: stamp(ctx, scheduled),
      });

      const reminderCount = rng.int(1, MAX_REMINDERS);
      let offset = 0;
      for (let n = 1; n <= reminderCount; n += 1) {
        offset += rng.int(1, MAX_REMINDER_GAP_DAYS) * MINUTES_PER_DAY;
        const remindAt = launchAt + offset;
        const sentMinute = remindAt + rng.int(0, MAX_TASK_DELAY_MINUTES);
        rowsOf(rows, 'survey_reminder').push({
          reminder_id: cfUuidFrom(rng),
          survey_id: surveyId,
          offset_minutes: offset,
          remind_at: stamp(ctx, { minute: remindAt, ms: 0 }),
          task_name: `${TASK_PREFIX}${surveyId}-reminder-${n}`,
          task_token_hash: taskTokenHash,
          sent_at: launched !== null && sentMinute < 0 ? stamp(ctx, instant(rng, sentMinute)) : null,
        });
      }
    }

    rowsOf(rows, 'survey').push({
      survey_id: surveyId,
      siteID,
      title,
      status,
      created: stamp(ctx, created),
      createdByID,
      // No surveys fixture route sets these, so seeded surveys leave them null as the oracle's own writes do.
      lastUpdate: null,
      lastUpdateByID: null,
      launched_at: launched === null ? null : stamp(ctx, launched),
    });

    const targets = rng
      .pickMany(ownGroups, rng.int(1, Math.min(MAX_OWN_TARGETS, ownGroups.length)))
      .map((name): [SiteKey, string] => [siteID, name]);
    let targetsPartner = false;
    if (partner !== null && (rng.bool(PARTNER_TARGET_SHARE) || index === forcedPartner)) {
      targetsPartner = true;
      const picked = rng.pickMany(partnerGroups, rng.int(1, Math.min(MAX_PARTNER_TARGETS, partnerGroups.length)));
      targets.push(...picked.map((name): [SiteKey, string] => [partner, name]));
    }
    // Targets precede the launch, so a targeted site can answer from the first response on.
    const targetBound = launchAt ?? 0;
    for (const [targetSite, groupName] of targets) {
      rowsOf(rows, 'survey_target').push({
        target_id: cfUuidFrom(rng),
        survey_id: surveyId,
        siteID: targetSite,
        group_name: groupName,
        created: stamp(ctx, instant(rng, rng.int(created.minute + 1, targetBound - 1))),
      });
    }

    return { surveyId, launched, questions, targetsPartner };
  });
}

/** Responses of one site's LAUNCHED and CLOSED surveys: own-site ones, then `multiSiteResponses` from `partner`. */
function buildResponses(
  ctx: FixtureContext,
  rng: SeedRandom,
  siteID: SiteKey,
  partner: SiteKey | null,
  plans: readonly SurveyPlan[],
  rows: ReadonlyMap<string, FixtureRow[]>,
): void {
  const { counts } = ctx.config.sites[siteID];
  const own = counts.surveyResponses - counts.multiSiteResponses;
  if (own < 0) {
    throw new RangeError(`Site ${siteID}: multiSiteResponses ${counts.multiSiteResponses} exceeds surveyResponses ${counts.surveyResponses}`);
  }
  if (counts.multiSiteResponses > 0 && partner === null) {
    throw new RangeError(`Site ${siteID} has multi-site responses but no other site to answer from`);
  }
  const responding = plans.filter((plan): plan is LaunchedPlan => plan.launched !== null);
  const pools: ResponsePool[] = [{ siteID, users: respondents(ctx, siteID), perSurvey: allocate(rng, responding, own) }];
  if (partner !== null) {
    const targeting = responding.filter((plan) => plan.targetsPartner);
    pools.push({ siteID: partner, users: respondents(ctx, partner), perSurvey: allocate(rng, targeting, counts.multiSiteResponses) });
  }

  for (const plan of responding) {
    const responses = pools
      .flatMap((pool) =>
        rng.pickMany(pool.users, pool.perSurvey.get(plan) ?? 0).map((userID) => ({
          respondentSiteID: pool.siteID,
          userID,
          responseId: cfUuidFrom(rng),
          created: instant(rng, rng.int(plan.launched.minute + 1, -1)),
          answers: answersJson(rng, plan.questions),
        })),
      )
      .sort((a, b) => byInstant(a.created, b.created));
    for (const response of responses) {
      rowsOf(rows, 'survey_response').push({
        response_id: response.responseId,
        survey_id: plan.surveyId,
        siteID,
        respondentSiteID: response.respondentSiteID,
        respondent_user_id: response.userID,
        answers: response.answers,
        created: stamp(ctx, response.created),
      });
    }
  }
}

/** Builds the `synthetic` surveys tables of the dataset, every site in `SITE_ORDER`; equal inputs yield identical rows. */
export function buildSurveyFixtures(ctx: FixtureContext): FixtureTables {
  const rows = new Map<string, FixtureRow[]>(SURVEY_SPECS.map((spec): [string, FixtureRow[]] => [spec.table, []]));
  for (const siteID of SITE_ORDER) {
    if (ctx.config.sites[siteID].counts.surveys === 0) continue;
    const rng = ctx.random.fork(`surveys/${siteID}`);
    const partner = partnerSite(ctx, siteID);
    const plans = buildSurveys(ctx, rng.fork('surveys'), siteID, partner, rows);
    buildResponses(ctx, rng.fork('responses'), siteID, partner, plans, rows);
  }
  return Object.fromEntries(SURVEY_SPECS.map((spec): [string, FixtureRow[]] => [fixtureKey(spec), rowsOf(rows, spec.table)]));
}
