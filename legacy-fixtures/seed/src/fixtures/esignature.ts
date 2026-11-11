// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { pdfBytes, sha256Hex, toHex } from '../bytes.js';
import { SITE_ORDER, type SiteKey } from '../config.js';
import { fixtureKeys, specForKey, type FixtureContext, type FixtureRow, type FixtureTables } from '../fixture-tables.js';
import { cfUuidFrom } from '../ids.js';
import type { SeedRandom } from '../random.js';

const MODULE = 'esignature';
const SIGNER_ROLE = 'esignature.signer';
// Actions and details are those esignature.cfc appends on create (document SHA-256) and sign (typed name),
// so seeded chains read like chains the fixture endpoints write; detail is therefore plain text, not JSON.
const CREATED_ACTION = 'created';
const SIGNED_ACTION = 'signed';
const SIGNED_SHARE = 0.6;
const MINUTES_PER_DAY = 1440;
const WORKDAY_FIRST_MINUTE = 8 * 60;
const WORKDAY_LAST_MINUTE = 18 * 60 - 1;
const MIN_SIGN_DELAY_MINUTES = 5;
const MAX_SIGN_DELAY_MINUTES = 14 * MINUTES_PER_DAY;
const DOCUMENT_KINDS: readonly string[] = Object.freeze([
  'Service Agreement',
  'Engagement Letter',
  'Non-Disclosure Agreement',
  'Timesheet Attestation',
  'Expense Approval',
  'Policy Acknowledgement',
  'Consent Form',
  'Change Order',
]);

/** One generated request with the values its signature and audit entries reuse. */
interface DraftRequest {
  row: FixtureRow;
  requestId: string;
  created: string;
  creator: string;
  signer: string;
  documentSha256: string;
  signature: { signatureId: string; typedName: string; signedAt: string } | null;
}

/** Requests signed out of `count`; both states appear whenever `count` is at least 2. */
function signedCount(count: number): number {
  return Math.min(count - 1, Math.max(1, Math.round(count * SIGNED_SHARE)));
}

/** Full name as Masa's `userBean.getFullName()` renders it. */
function fullName(ctx: FixtureContext, userID: string): string {
  const user = ctx.index.user(userID);
  return `${user.fname} ${user.lname}`.trim();
}

/** Draws one request of `siteID` created before the business date, signed by its designated signer when `signed`. */
function draftRequest(ctx: FixtureContext, rng: SeedRandom, siteID: SiteKey, signers: readonly string[], signed: boolean): DraftRequest {
  const requestId = cfUuidFrom(rng);
  const signer = rng.pick(signers);
  const others = signers.filter((id) => id !== signer);
  const creator = others.length > 0 ? rng.pick(others) : signer;
  const day = rng.int(-ctx.config.historyDays, -1);
  const minute = rng.int(WORKDAY_FIRST_MINUTE, WORKDAY_LAST_MINUTE);
  const created = ctx.calendar.localTimestamp(day, minute, rng.int(0, 99) * 10);
  const kind = rng.pick(DOCUMENT_KINDS);
  const document = pdfBytes(kind, [`Reference ${requestId}`, `Requested ${created}`]);
  const documentSha256 = sha256Hex(document);

  let signature: DraftRequest['signature'] = null;
  if (signed) {
    // The latest signature lands one minute before business-date midnight at most.
    const latestDelay = Math.min(MAX_SIGN_DELAY_MINUTES, -(day * MINUTES_PER_DAY + minute) - 1);
    signature = {
      signatureId: cfUuidFrom(rng),
      typedName: fullName(ctx, signer),
      signedAt: ctx.calendar.addMinutes(created, rng.int(MIN_SIGN_DELAY_MINUTES, latestDelay)),
    };
  }

  const row: FixtureRow = {
    request_id: requestId,
    siteID,
    document_name: `${kind} ${requestId.slice(0, 8)}.pdf`,
    document_sha256: documentSha256,
    document: toHex(document),
    signer_user_id: signer,
    state: signed ? 'SIGNED' : 'PENDING',
    created,
    createdByID: creator,
  };
  return { row, requestId, created, creator, signer, documentSha256, signature };
}

/** Builds the e-signature fixture tables: requests, typed-name signatures and the audit-entry inputs of each request's chain. */
export function buildEsignatureFixtures(ctx: FixtureContext): FixtureTables {
  const tables: FixtureTables = Object.fromEntries(
    fixtureKeys(ctx.config)
      .filter((key) => specForKey(key).spec.module === MODULE)
      .map((key): [string, FixtureRow[]] => [key, []]),
  );
  const rowsOf = (table: string): FixtureRow[] => {
    const key = Object.keys(tables).find((candidate) => specForKey(candidate).spec.table === table);
    const rows = key === undefined ? undefined : tables[key];
    if (rows === undefined) throw new RangeError(`No ${MODULE} fixture table ${table} in the registry`);
    return rows;
  };
  const requests = rowsOf('signature_request');
  const signatures = rowsOf('signature');
  // Audit rows hold only the usp_audit_append inputs; seq and the chain hashes are assigned on load.
  const entries = rowsOf('audit_entry');

  for (const siteID of SITE_ORDER) {
    const count = ctx.config.sites[siteID].counts.signatureRequests;
    if (count === 0) continue;
    const signers = ctx.index.actors(siteID, SIGNER_ROLE);
    if (signers.length === 0) throw new RangeError(`No ${SIGNER_ROLE} actor in site ${siteID}`);
    const rng = ctx.random.fork(`${MODULE}/${siteID}`);
    const states = rng.shuffle(Array.from({ length: count }, (_, i) => i < signedCount(count)));
    const drafts = states
      .map((signed) => draftRequest(ctx, rng, siteID, signers, signed))
      .sort((a, b) => ctx.calendar.compareTimestamps(a.created, b.created) || (a.requestId < b.requestId ? -1 : 1));

    for (const draft of drafts) {
      requests.push(draft.row);
      entries.push({
        entry_id: cfUuidFrom(rng),
        request_id: draft.requestId,
        action: CREATED_ACTION,
        actor_user_id: draft.creator,
        detail: draft.documentSha256,
        at: draft.created,
      });
      if (draft.signature === null) continue;
      signatures.push({
        signature_id: draft.signature.signatureId,
        request_id: draft.requestId,
        typed_name: draft.signature.typedName,
        signer_user_id: draft.signer,
        signed_at: draft.signature.signedAt,
      });
      entries.push({
        entry_id: cfUuidFrom(rng),
        request_id: draft.requestId,
        action: SIGNED_ACTION,
        actor_user_id: draft.signer,
        detail: draft.signature.typedName,
        at: draft.signature.signedAt,
      });
    }
  }
  return tables;
}
