// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { csvBytes, pdfBytes, pngBytes, sha256Hex, toHex } from '../bytes.js';
import { siteForProgram, type SiteKey } from '../config.js';
import {
  FIXTURE_TABLE_SPECS,
  fixtureKey,
  fixtureKeys,
  specForKey,
  type FixtureContext,
  type FixtureRow,
  type FixtureTableSpec,
  type FixtureTables,
} from '../fixture-tables.js';
import { cfUuidFrom } from '../ids.js';
import { formatUnits, fromCents } from '../money.js';
import type { SeedRandom } from '../random.js';

type FinanceState = 'IN-PROGRESS' | 'SUBMITTED' | 'RE-SUBMITTED' | 'APPROVED' | 'REJECTED';
type FinanceAction = 'submit' | 'approve' | 'reject' | 'resubmit' | 'edit';
type FinanceRole = 'finance.preparer' | 'finance.approver';

/** One legal lifecycle step; `to: null` keeps the state and only adds a version. */
interface FinanceStep {
  from: readonly FinanceState[];
  action: FinanceAction;
  role: FinanceRole;
  to: FinanceState | null;
}

const PREPARER: FinanceRole = 'finance.preparer';
const APPROVER: FinanceRole = 'finance.approver';
const INITIAL_STATE: FinanceState = 'IN-PROGRESS';
const CREATE_ACTION = 'create';

/** Finance lifecycle as `usp_finance_transition` enforces it; APPROVED is terminal. */
const LIFECYCLE: readonly FinanceStep[] = Object.freeze([
  { from: ['IN-PROGRESS'], action: 'submit', role: PREPARER, to: 'SUBMITTED' },
  { from: ['SUBMITTED', 'RE-SUBMITTED'], action: 'approve', role: APPROVER, to: 'APPROVED' },
  { from: ['SUBMITTED', 'RE-SUBMITTED'], action: 'reject', role: APPROVER, to: 'REJECTED' },
  { from: ['REJECTED'], action: 'resubmit', role: PREPARER, to: 'RE-SUBMITTED' },
  { from: ['IN-PROGRESS', 'REJECTED'], action: 'edit', role: PREPARER, to: null },
]);

// The first records of each program take these final states, so every program holds all five.
const FORCED_FINAL_STATES: readonly FinanceState[] = ['IN-PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RE-SUBMITTED'];
const FINAL_STATE_WEIGHTS: readonly (readonly [FinanceState, number])[] = [
  ['IN-PROGRESS', 15],
  ['SUBMITTED', 15],
  ['APPROVED', 40],
  ['REJECTED', 15],
  ['RE-SUBMITTED', 15],
];
const EDIT_WEIGHTS = [[0, 70], [1, 22], [2, 8]] as const;
const CYCLE_WEIGHTS = [[0, 75], [1, 20], [2, 5]] as const;
const EXTRA_RESUBMIT_CYCLE_WEIGHTS = [[0, 80], [1, 20]] as const;
const EDIT_FIELDS = ['title', 'amount', 'period'] as const;
const TITLE_KINDS = ['Invoice', 'Expense claim', 'Purchase order', 'Reimbursement', 'Vendor payment', 'Budget transfer'] as const;

const MINUTES_PER_DAY = 1440;
const WINDOW_OPENS = 8 * 60;
const WINDOW_CLOSES = 18 * 60;
const MIN_GAP_MINUTES = 30;
const MAX_GAP_MINUTES = 3 * MINUTES_PER_DAY;
const PERIOD_LAG_DAYS = 31;
const MIN_CENTS = 2_500;
const MAX_CENTS = 2_500_000;

/** Registry spec of finance table `table`; throws when the registry has none. */
function financeSpec(table: string): FixtureTableSpec {
  const found = FIXTURE_TABLE_SPECS.find((entry) => entry.module === 'finance' && entry.table === table);
  if (found === undefined) throw new Error(`Fixture registry has no finance table ${table}`);
  return found;
}

const SPECS = Object.freeze({
  record: financeSpec('finance_record'),
  version: financeSpec('finance_record_version'),
  attachment: financeSpec('finance_attachment'),
});

/** Field values a version row snapshots. */
interface Snapshot {
  state: FinanceState;
  title: string;
  cents: number;
  period: string;
}

/** Per-program generation inputs; window bounds are minutes from local midnight of the business date. */
interface ProgramBuild {
  ctx: FixtureContext;
  siteID: SiteKey;
  preparers: readonly string[];
  approvers: readonly string[];
  windowStart: number;
  windowEnd: number;
  /** `yyyy-MM` months of the history window, ascending. */
  months: readonly string[];
}

/** A generated record with the facts its attachment needs. */
interface BuiltRecord {
  recordId: string;
  owner: string;
  createdMinute: number;
  final: Snapshot;
  record: FixtureRow;
  versions: FixtureRow[];
}

/** Rows of one program per finance table. */
interface ProgramRows {
  records: FixtureRow[];
  versions: FixtureRow[];
  attachments: FixtureRow[];
}

/** Role and resulting state of `action` from `state`; throws on a step the lifecycle does not allow. */
function step(state: FinanceState, action: FinanceAction): { role: FinanceRole; to: FinanceState } {
  const rule = LIFECYCLE.find((entry) => entry.action === action && entry.from.includes(state));
  if (rule === undefined) throw new Error(`Illegal finance step: ${action} from ${state}`);
  return { role: rule.role, to: rule.to ?? state };
}

/** Actions after `create` that end in `final`; `withEdit` puts at least one edit before the first submit. */
function planActions(rng: SeedRandom, final: FinanceState, withEdit: boolean): FinanceAction[] {
  const edits = (min: number): FinanceAction[] =>
    Array.from({ length: Math.max(min, rng.weighted(EDIT_WEIGHTS)) }, (): FinanceAction => 'edit');
  const actions = edits(withEdit ? 1 : 0);
  if (final === 'IN-PROGRESS') return actions;
  actions.push('submit');
  if (final === 'SUBMITTED') return actions;
  const cycles = final === 'RE-SUBMITTED' ? 1 + rng.weighted(EXTRA_RESUBMIT_CYCLE_WEIGHTS) : rng.weighted(CYCLE_WEIGHTS);
  for (let cycle = 0; cycle < cycles; cycle += 1) actions.push('reject', ...edits(0), 'resubmit');
  if (final === 'APPROVED') actions.push('approve');
  if (final === 'REJECTED') actions.push('reject', ...edits(0));
  return actions;
}

function money(cents: number): string {
  return formatUnits(fromCents(cents));
}

function drawCents(rng: SeedRandom): number {
  return rng.int(MIN_CENTS, MAX_CENTS);
}

function drawTitle(rng: SeedRandom): string {
  return `${rng.pick(TITLE_KINDS)} - ${rng.faker.commerce.productName()}`;
}

function dayOf(minute: number): number {
  return Math.floor(minute / MINUTES_PER_DAY);
}

function monthOf(b: ProgramBuild, day: number): string {
  return b.ctx.calendar.localDate(day).slice(0, 7);
}

/** Datetime value `minute` minutes from local midnight of the business date, with drawn milliseconds. */
function stamp(b: ProgramBuild, rng: SeedRandom, minute: number): string {
  return b.ctx.calendar.localTimestamp(0, minute, rng.int(0, 99) * 10);
}

/** Snapshot after an edit at `minute` that changes one of title, amount or period. */
function edited(b: ProgramBuild, rng: SeedRandom, current: Snapshot, minute: number): Snapshot {
  const field = rng.pick(EDIT_FIELDS);
  if (field === 'period') {
    const latest = monthOf(b, dayOf(minute));
    const others = b.months.filter((month) => month <= latest && month !== current.period);
    if (others.length > 0) return { ...current, period: rng.pick(others) };
  }
  if (field === 'title') {
    const title = drawTitle(rng);
    return { ...current, title: title === current.title ? `${title} (revised)` : title };
  }
  const cents = drawCents(rng);
  return { ...current, cents: cents === current.cents ? cents + 100 : cents };
}

function versionRow(rng: SeedRandom, recordId: string, version: number, snap: Snapshot, action: string, actor: string, created: string): FixtureRow {
  return {
    version_id: cfUuidFrom(rng),
    record_id: recordId,
    version,
    state: snap.state,
    title: snap.title,
    amount: money(snap.cents),
    period: snap.period,
    action,
    actor_user_id: actor,
    created,
  };
}

/** Record `index` with its version rows, as `usp_finance_create` and `usp_finance_transition` would write them. */
function buildRecord(b: ProgramBuild, rng: SeedRandom, index: number): BuiltRecord {
  const forced = FORCED_FINAL_STATES[index];
  const final = forced ?? rng.weighted(FINAL_STATE_WEIGHTS);
  const actions = planActions(rng, final, forced !== undefined);
  // Gaps shrink for short windows, so every version and a later attachment fit before the window closes.
  const span = b.windowEnd - b.windowStart - MIN_GAP_MINUTES;
  const maxGap = Math.min(MAX_GAP_MINUTES, Math.floor(span / Math.max(actions.length, 1)));
  const createdMinute = rng.int(b.windowStart, b.windowEnd - actions.length * maxGap - MIN_GAP_MINUTES);
  const createdDay = dayOf(createdMinute);
  const recordId = cfUuidFrom(rng);
  const owner = rng.pick(b.preparers);
  const periodDay = rng.int(Math.max(-b.ctx.config.historyDays, createdDay - PERIOD_LAG_DAYS), createdDay);
  let snap: Snapshot = { state: INITIAL_STATE, title: drawTitle(rng), cents: drawCents(rng), period: monthOf(b, periodDay) };
  const created = stamp(b, rng, createdMinute);
  const versions = [versionRow(rng, recordId, 1, snap, CREATE_ACTION, owner, created)];
  let lastUpdate: string | null = null;
  let lastUpdateByID: string | null = null;
  let minute = createdMinute;
  for (const action of actions) {
    minute += rng.int(MIN_GAP_MINUTES, maxGap);
    const { role, to } = step(snap.state, action);
    const actor = role === PREPARER ? owner : rng.pick(b.approvers);
    snap = { ...(action === 'edit' ? edited(b, rng, snap, minute) : snap), state: to };
    lastUpdate = stamp(b, rng, minute);
    lastUpdateByID = actor;
    versions.push(versionRow(rng, recordId, versions.length + 1, snap, action, actor, lastUpdate));
  }
  if (snap.state !== final) throw new Error(`Finance plan for record ${recordId} ends in ${snap.state}, not ${final}`);
  const record: FixtureRow = {
    record_id: recordId,
    siteID: b.siteID,
    title: snap.title,
    amount: money(snap.cents),
    period: snap.period,
    state: snap.state,
    version: versions.length,
    created,
    createdByID: owner,
    lastUpdate,
    lastUpdateByID,
  };
  return { recordId, owner, createdMinute, final: snap, record, versions };
}

/** Attachment file shape: content type, file-name stem and extension, and a byte renderer. */
interface AttachmentKind {
  contentType: string;
  stem: string;
  extension: string;
  render(rng: SeedRandom, record: BuiltRecord, ordinal: number): Buffer;
}

const ATTACHMENT_KINDS: readonly AttachmentKind[] = Object.freeze([
  {
    contentType: 'application/pdf',
    stem: 'invoice',
    extension: 'pdf',
    render: (_rng: SeedRandom, record: BuiltRecord, ordinal: number): Buffer =>
      pdfBytes(`Invoice ${ordinal}`, [
        `Record ${record.recordId}`,
        `Period ${record.final.period}`,
        `Amount ${money(record.final.cents)}`,
      ]),
  },
  {
    contentType: 'image/png',
    stem: 'receipt',
    extension: 'png',
    render: (rng: SeedRandom): Buffer => pngBytes(rng, { width: rng.int(8, 32), height: rng.int(8, 32) }),
  },
  {
    contentType: 'text/csv',
    stem: 'ledger',
    extension: 'csv',
    render: (rng: SeedRandom): Buffer =>
      csvBytes([
        ['line', 'description', 'amount'],
        ...Array.from({ length: rng.int(2, 5) }, (_, i) => [i + 1, rng.faker.commerce.productName(), money(drawCents(rng))]),
      ]),
  },
]);

/** One attachment per distinct drawn record, in record order, cycling PDF, PNG and CSV. */
function buildAttachments(b: ProgramBuild, rng: SeedRandom, records: readonly BuiltRecord[]): FixtureRow[] {
  const picked = new Set(rng.pickMany(records, b.ctx.config.sites[b.siteID].counts.financeAttachments));
  const rows: FixtureRow[] = [];
  for (const record of records) {
    if (!picked.has(record)) continue;
    const ordinal = rows.length + 1;
    const kind = ATTACHMENT_KINDS[rows.length % ATTACHMENT_KINDS.length] as AttachmentKind;
    const attachmentId = cfUuidFrom(rng);
    const bytes = kind.render(rng, record, ordinal);
    const created = stamp(b, rng, rng.int(record.createdMinute + MIN_GAP_MINUTES, b.windowEnd));
    rows.push({
      attachment_id: attachmentId,
      record_id: record.recordId,
      file_name: `${kind.stem}-${String(ordinal).padStart(4, '0')}.${kind.extension}`,
      content_type: kind.contentType,
      size_bytes: bytes.length,
      sha256: sha256Hex(bytes),
      content: toHex(bytes),
      created,
      createdByID: record.owner,
    });
  }
  return rows;
}

/** Months of the history window, which ends the day before the business date. */
function windowMonths(ctx: FixtureContext): string[] {
  const months: string[] = [];
  for (let day = -ctx.config.historyDays; day <= -1; day += 1) {
    const month = ctx.calendar.localDate(day).slice(0, 7);
    if (months.at(-1) !== month) months.push(month);
  }
  return months;
}

/** Finance rows of the program schema mapped to `siteID`. */
function buildProgram(ctx: FixtureContext, siteID: SiteKey): ProgramRows {
  const rng = ctx.random.fork(`finance/${siteID}`);
  const b: ProgramBuild = {
    ctx,
    siteID,
    preparers: ctx.index.actors(siteID, PREPARER),
    approvers: ctx.index.actors(siteID, APPROVER),
    windowStart: -ctx.config.historyDays * MINUTES_PER_DAY + WINDOW_OPENS,
    windowEnd: -MINUTES_PER_DAY + WINDOW_CLOSES,
    months: windowMonths(ctx),
  };
  const recordRng = rng.fork('records');
  const built = Array.from({ length: ctx.config.sites[siteID].counts.financeRecords }, (_, i) => buildRecord(b, recordRng, i));
  return {
    records: built.map((entry) => entry.record),
    versions: built.flatMap((entry) => entry.versions),
    attachments: buildAttachments(b, rng.fork('attachments'), built),
  };
}

/** Finance fixture rows of every program schema, keyed by registry dataset key; equal contexts yield identical rows. */
export function buildFinanceFixtures(ctx: FixtureContext): FixtureTables {
  const tables: FixtureTables = {};
  const programs: number[] = [];
  for (const key of fixtureKeys(ctx.config)) {
    const { spec, programId } = specForKey(key);
    if (spec.module !== 'finance') continue;
    tables[key] = [];
    if (programId !== null && !programs.includes(programId)) programs.push(programId);
  }
  for (const programId of programs) {
    const rows = buildProgram(ctx, siteForProgram(ctx.config, programId));
    tables[fixtureKey(SPECS.record, programId)] = rows.records;
    tables[fixtureKey(SPECS.version, programId)] = rows.versions;
    tables[fixtureKey(SPECS.attachment, programId)] = rows.attachments;
  }
  return tables;
}
