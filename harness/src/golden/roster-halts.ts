// Halted people roster operations: read from people's operator route and recorded as halted exceptions entries.
import { z } from '@opt2/platform/service-kit';
import { EXCEPTIONS_LIST_PATH, appendExceptionEntry, type AppendExceptionOptions } from './capture.js';
import { ROSTER_HALT_ID_PREFIX, haltEvidence, type ExceptionEntry } from './errors.js';
import { serviceUrl, type SideEffectConfig } from './side-effects.js';
import { createHttpSession, type FetchLike } from '../lib/http.js';
import { createHarnessInvoker, type HarnessInvoker } from '../lib/invocation.js';
import type { EnvLike } from '../lib/paths.js';
import { readJson } from '../lib/report.js';

/** People `listHaltedRosterOperationsPage` route. */
export const HALTED_ROSTER_PATH = '/internal/v2/roster-operations/halted';

const ROSTER_KINDS = ['admin-add', 'admin-update', 'profile-update'] as const;

/** Kind of the carried entry point that ran a roster operation. */
export type RosterKind = (typeof ROSTER_KINDS)[number];

const ROSTER_STATES = ['started', 'people-committed', 'done', 'rolled-back', 'halted'] as const;

/** Route key, then the further keys, of the carried entry point each roster operation kind runs. */
export const ROSTER_ROUTE_KEYS: Readonly<Record<RosterKind, readonly [string, ...string[]]>> = Object.freeze({
  'admin-add': ['admin:cusers.update{type=2,action=add}'],
  'admin-update': ['admin:cusers.update{type=2,action=update}'],
  'profile-update': ['admin:ceditprofile.update'],
});

const haltedRosterSchema = z.looseObject({
  operations: z.array(
    z.looseObject({
      operationId: z.string().regex(/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/, 'must be a CF UUID'),
      tenantId: z.string().min(1),
      userId: z.string().min(1),
      kind: z.enum(ROSTER_KINDS),
      state: z.enum(ROSTER_STATES),
      startedAt: z.string().min(1),
      haltedAt: z.string().min(1),
      identityUnreachableSince: z.string().min(1).nullable(),
      units: z.array(z.string().min(1)),
    }),
  ),
  next: z.string().min(1).nullable(),
});

/** One roster operation people lists as once halted, in its current `state`. */
export type HaltedRosterOperation = z.infer<typeof haltedRosterSchema>['operations'][number];

/** Collaborators of {@link haltedRosterOperations}; absent ones come from the environment. */
export interface RosterHaltDeps {
  /** `OPT2_SERVICE_URLS`, which must name people. */
  config: SideEffectConfig;
  env?: EnvLike;
  fetch?: FetchLike;
  /** Operator invocation credentials; else the local `operator` invoker. */
  invoker?: HarnessInvoker;
}

const listedIdsSchema = z.looseObject({ entries: z.array(z.looseObject({ id: z.string() })) });

/**
 * Every roster operation people lists as once halted, resolved or not, oldest first, following `next` page by page
 * until it is null; throws GoldenConfigError when `OPT2_SERVICE_URLS` names no people URL, and an Error when people
 * answers other than 200 with its contract's body or repeats the cursor it was sent.
 */
export async function haltedRosterOperations(deps: RosterHaltDeps): Promise<HaltedRosterOperation[]> {
  const base = serviceUrl(deps.config, 'people');
  const invoker = deps.invoker ?? (await createHarnessInvoker({ caller: 'operator', env: deps.env ?? process.env }));
  const headers = await invoker.headersFor({ callee: 'people', url: `${base}${HALTED_ROSTER_PATH}` });
  const s = createHttpSession({ baseUrl: base, fetch: deps.fetch });
  const operations: HaltedRosterOperation[] = [];
  let after: string | null = null;
  do {
    const query = after === null ? undefined : { after };
    const result = await s.request({ method: 'GET', path: HALTED_ROSTER_PATH, query, headers, followRedirects: false });
    if (result.status !== 200) throw new Error(`people listHaltedRosterOperationsPage answered ${result.status}`);
    const parsed = haltedRosterSchema.safeParse(result.json());
    if (!parsed.success) {
      throw new Error(`people listHaltedRosterOperationsPage is not a HaltedRosterOperationsPage: ${z.prettifyError(parsed.error)}`);
    }
    if (parsed.data.next !== null && parsed.data.next === after) {
      throw new Error('people listHaltedRosterOperationsPage answered the cursor it was sent as its next cursor');
    }
    operations.push(...parsed.data.operations);
    after = parsed.data.next;
  } while (after !== null);
  return operations;
}

/** Exceptions-list id of `operation`: `EX-ROSTER-HALT-<operationId>`, upper-cased like every list id. */
export function rosterHaltId(operation: Pick<HaltedRosterOperation, 'operationId'>): string {
  return `${ROSTER_HALT_ID_PREFIX}${operation.operationId.toUpperCase()}`;
}

/** Halted `preserve` entry of `operation`, under the scenario whose replay first found it listed. */
export function rosterHaltEntry(operation: HaltedRosterOperation, scenarioId: string, sourceSha: string): ExceptionEntry {
  const [routeKey, ...appliesTo] = ROSTER_ROUTE_KEYS[operation.kind];
  const { operationId, kind, userId, tenantId, state } = operation;
  const since = operation.identityUnreachableSince === null ? '' : ` since ${operation.identityUnreachableSince}`;
  const resolved = state === 'halted' ? '' : ` An operator had already resolved it to ${state} when replay recorded it.`;
  return {
    id: rosterHaltId(operation),
    scenario: scenarioId,
    routeKey,
    ...(appliesTo.length === 0 ? {} : { appliesTo }),
    difference:
      `Roster operation ${operationId} (${kind}, started ${operation.startedAt}) of user ${userId} in tenant ${tenantId} ` +
      `halted at ${operation.haltedAt}: recovery could not reach identity${since}. While it is halted the user stays ` +
      `closed on people and identity, so every read or write of it answers the legacy-shaped 503.`,
    decision: 'preserve',
    reason:
      `Identity stayed unreachable for more than 5 minutes, so recovery stopped and an operator resolves the operation ` +
      `with \`opt2-people resolve-operation ${operationId} --to rolled-back|done\`.${resolved}`,
    status: 'halted',
    evidence: haltEvidence(scenarioId),
    sourceSha,
  };
}

/** Appends the halted entry of each of `operations` the exceptions list lacks, never rewriting a listed one; returns the ids. */
export async function recordRosterHalts(
  operations: readonly HaltedRosterOperation[],
  scenarioId: string,
  sourceSha: string,
  opts: AppendExceptionOptions,
): Promise<string[]> {
  if (operations.length === 0) return [];
  const { entries } = await readJson(opts.path ?? EXCEPTIONS_LIST_PATH, listedIdsSchema);
  const listed = new Set(entries.map((entry) => entry.id));
  const ids: string[] = [];
  for (const operation of operations) {
    const id = rosterHaltId(operation);
    if (!listed.has(id)) await appendExceptionEntry(rosterHaltEntry(operation, scenarioId, sourceSha), opts);
    listed.add(id);
    ids.push(id);
  }
  return ids;
}
