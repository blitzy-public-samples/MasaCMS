// Tenant isolation end to end through the gateway under cut-over table v0002, as real seeded logins of tenant-a,
// tenant-b and umbrella; writes ${OPT2_STATE_DIR}/results/e2e-isolation.json for the isolation report.
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, type TenantFixture } from '@opt2/platform/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { FIXTURES_UNAVAILABLE, type FixtureStatus } from '../../src/golden/catalogue.js';
import { loadSecretStore, loadSeedStore, type SecretStore, type SeedStore } from '../../src/golden/session.js';
import {
  ACTORS,
  ROUTE_FAMILIES,
  SURVEY_GRANT,
  TENANTS_BY_KEY,
  runGatewayIsolation,
  type ActorRef,
  type CaseKind,
  type GatewayIsolationResult,
  type IsolationCase,
  type ReservedIdentities,
  type TenantKey,
} from '../../src/isolation/gateway-matrix.js';
import { writeEndToEndResult } from '../../src/isolation/report.js';
import type { FetchLike } from '../../src/lib/http.js';
import { redactSecrets } from '../helpers/admin-login.js';
import { fixtureStatus, gatewayUrl, requireTableVersion } from '../helpers/stack.js';

const TABLE_VERSION = 'v0002';
const FIXTURE_ROUTE_PREFIX = '/legacy-fixtures/cfml/api.cfm/';

/** Longest run of the whole gateway matrix: serial logins and probes outlast the config's 5-minute hook bound. */
const MATRIX_TIMEOUT_MS = 30 * 60_000;

/** Header names that would assert tenant, caller or platform context instead of leaving it to the verified session. */
const ASSERTED_CONTEXT_HEADER = /^x-opt2-|^x-serverless-authorization$|tenant[-_]?id/i;

const READ_KINDS: ReadonlySet<CaseKind> = new Set(['read-list', 'read-by-id']);
const WRITE_KINDS: ReadonlySet<CaseKind> = new Set(['write-owner-site', 'write-site-mismatch', 'write-foreign-id']);
const SERVICE_OF = new Map(ROUTE_FAMILIES.map((family) => [family.id, family.service] as const));

/** A seeded account a case logs in as. */
interface ActorAccount {
  tenant: TenantKey;
  ref: ActorRef;
}

/** `fetch` that refuses to send any header asserting tenant, caller or platform context. */
const guardedFetch: FetchLike = async (input, init) => {
  const asserted = [...new Headers(init.headers).keys()].filter((name) => ASSERTED_CONTEXT_HEADER.test(name));
  if (asserted.length > 0) {
    throw new Error(`refused to send caller-asserted header(s) ${asserted.join(', ')} to ${new URL(input).pathname}`);
  }
  return fetch(input, init);
};

function siteOf(tenant: TenantKey): string {
  return TENANTS_BY_KEY[tenant].siteId;
}

function serviceOf(c: IsolationCase): string {
  const service = SERVICE_OF.get(c.family);
  if (service === undefined) throw new Error(`case ${c.id} names family ${c.family}, which no route family declares`);
  return service;
}

/** One line per case (id, actor site, family, route, status, result, reason), secrets redacted. */
function describeCases(cases: readonly IsolationCase[]): string {
  const lines = cases.map((c) => {
    const status = c.observed.status === undefined ? '-' : String(c.observed.status);
    const reason = c.reason === undefined ? '' : ` (${c.reason})`;
    return `${c.id} actor=${siteOf(c.actor)} family=${c.family} route=${c.route} status=${status} ${c.result}${reason}`;
  });
  return redactSecrets(lines.join('\n'));
}

/** Cross-tenant reads `c` adds to the matrix total: its leaked ids, or one for a pooled-read violation. */
function readsOf(c: IsolationCase): number {
  if (READ_KINDS.has(c.kind)) return c.observed.leakedIds ?? 0;
  return c.kind === 'pooled-read' && c.result === 'violation' ? 1 : 0;
}

/** Cross-tenant writes `c` adds to the matrix total: one for a write violation or an accepted ungranted response. */
function writesOf(c: IsolationCase): number {
  if (WRITE_KINDS.has(c.kind)) return c.result === 'violation' ? 1 : 0;
  return c.kind === 'survey-grant' && c.result === 'violation' && c.observed.effect === true ? 1 : 0;
}

/** `count` summed per owning service, with every route family's service listed. */
function perService(cases: readonly IsolationCase[], count: (c: IsolationCase) => number): Record<string, number> {
  const tally: Record<string, number> = Object.fromEntries(ROUTE_FAMILIES.map((family) => [family.service, 0]));
  for (const c of cases) {
    const service = serviceOf(c);
    tally[service] = (tally[service] ?? 0) + count(c);
  }
  return tally;
}

/** Seeded accounts case `c` logs in as: every family actor for a pooled read, all three respondents for the grant. */
function accountsOf(c: IsolationCase): ActorAccount[] {
  const actors = ACTORS[c.family];
  const accounts = (tenants: readonly TenantKey[], refs: Partial<Record<TenantKey, ActorRef>>): ActorAccount[] =>
    tenants.flatMap((tenant) => {
      const ref = refs[tenant];
      return ref === undefined ? [] : [{ tenant, ref }];
    });
  if (c.kind === 'pooled-read') return accounts(Object.keys(actors) as TenantKey[], actors);
  if (c.kind === 'survey-grant') {
    const { grantor, granted, ungranted, ungrantedRespondent } = SURVEY_GRANT;
    return [...accounts([grantor, granted], ACTORS.surveys), { tenant: ungranted, ref: ungrantedRespondent }];
  }
  return accounts([c.actor], actors);
}

/** Who a seeded account is. */
interface ActorIdentity {
  username: string;
  userId: string;
}

/** Username and seeded user id of `account`, from the credentials and dataset `up.sh` generated. */
function identityOf(account: ActorAccount, secrets: SecretStore, seed: SeedStore): ActorIdentity {
  const site = siteOf(account.tenant);
  const username = secrets.username(site, account.ref.role);
  const row = seed.select({ as: 'actor', source: 'dataset', path: 'masa.users', where: { username, siteID: site } });
  const userId = (row as { userID?: unknown }).userID;
  if (typeof userId !== 'string') {
    throw new Error(`seeded user ${username} of ${site} has no userID in the seed dataset`);
  }
  return { username, userId };
}

describe('tenant isolation through the gateway', () => {
  let fixtures: FixtureStatus;
  let result: GatewayIsolationResult;

  beforeAll(async () => {
    await requireTableVersion(TABLE_VERSION);
    fixtures = fixtureStatus();
    const baseUrl = gatewayUrl();
    result = await runGatewayIsolation({ baseUrl, fetch: guardedFetch, fixtures });
    await writeEndToEndResult(result, process.env, { baseUrl });
  }, MATRIX_TIMEOUT_MS);

  /** The run's case of the public-user-pool family with `kind`, from `actor` to `owner`. */
  function userPoolCase(kind: CaseKind, actor: TenantFixture, owner: TenantFixture): IsolationCase | undefined {
    const family = ROUTE_FAMILIES.find((candidate) => candidate.pooled === 'publicUserPool')?.id;
    return result.cases.find(
      (c) =>
        c.family === family && c.kind === kind && siteOf(c.actor) === actor.siteId && siteOf(c.owner) === owner.siteId,
    );
  }

  it('cross-tenant reads: zero per service through the gateway', () => {
    const offenders = result.cases.filter((c) => readsOf(c) > 0);
    const message = describeCases(offenders);
    expect(perService(result.cases, readsOf), message).toEqual(perService([], readsOf));
    expect(result.crossTenantReads, message).toBe(0);
  });

  it('cross-tenant writes: zero per service through the gateway', () => {
    const offenders = result.cases.filter((c) => writesOf(c) > 0);
    const message = describeCases(offenders);
    expect(perService(result.cases, writesOf), message).toEqual(perService([], writesOf));
    expect(result.crossTenantWrites, message).toBe(0);
  });

  it('multi-site survey responses are accepted only for granted tenants', () => {
    const grant = result.cases.filter((c) => c.kind === 'survey-grant');
    expect(grant.length, 'the matrix built no survey-grant case').toBeGreaterThan(0);
    if (fixtures.available) {
      expect(result.surveyGrantOnly, describeCases(grant)).toBe(true);
    } else {
      const ran = grant.filter((c) => c.result !== 'skipped' || c.reason !== FIXTURES_UNAVAILABLE);
      expect(ran.map((c) => c.id), describeCases(ran)).toEqual([]);
    }
    const disallowed = result.cases.filter(
      (c) =>
        c.result === 'skipped' &&
        (fixtures.available || c.reason !== FIXTURES_UNAVAILABLE || !c.route.startsWith(FIXTURE_ROUTE_PREFIX)),
    );
    expect(disallowed.map((c) => c.id), describeCases(disallowed)).toEqual([]);
  });

  it('pooled reads of tenant-a resolve to the umbrella public pool, invisible to tenant-b', () => {
    const pooled = userPoolCase('pooled-read', TENANT_A, TENANT_UMBRELLA);
    const direct = userPoolCase('read-by-id', TENANT_B, TENANT_UMBRELLA);
    const found = [pooled, direct].filter((c): c is IsolationCase => c !== undefined);
    expect(found.length, 'the matrix built no pooled-read or tenant-b by-id case of the user pool').toBe(2);
    expect(found.map((c) => c.result), describeCases(found)).toEqual(['pass', 'pass']);
  });

  it('no case is inconclusive and no actor is a reserved rehearsal identity', () => {
    const inconclusive = result.cases.filter((c) => c.result === 'inconclusive');
    expect(inconclusive.map((c) => c.id), describeCases(inconclusive)).toEqual([]);

    const secrets = loadSecretStore();
    const seed = loadSeedStore();
    // runGatewayIsolation has already parsed reserved.rehearsal into this shape.
    const reserved = seed.select({
      as: 'rehearsal',
      source: 'reserved',
      path: 'reserved.rehearsal',
    }) as ReservedIdentities;
    const persons = new Set(reserved.persons.map((person) => person.toUpperCase()));
    const usernames = new Set(reserved.usernames.map((username) => username.toLowerCase()));
    const identities = new Map<string, ActorIdentity>();
    for (const c of result.cases.filter((candidate) => candidate.result !== 'skipped')) {
      for (const account of accountsOf(c)) {
        const key = `${siteOf(account.tenant)}:${account.ref.role}`;
        if (!identities.has(key)) identities.set(key, identityOf(account, secrets, seed));
      }
    }
    expect(identities.size, 'no case logged in as a seeded actor').toBeGreaterThan(0);
    const reservedActors = [...identities]
      .filter(([, id]) => persons.has(id.userId.toUpperCase()) || usernames.has(id.username.toLowerCase()))
      .map(([key, id]) => `${key} ${id.username} ${id.userId}`);
    expect(reservedActors, `reserved rehearsal identities used as actors:\n${reservedActors.join('\n')}`).toEqual([]);
  });

  it('covers tenant A, tenant B and umbrella actors', () => {
    const sites = new Set(result.cases.filter((c) => c.result !== 'skipped').map((c) => siteOf(c.actor)));
    expect([...sites]).toEqual(expect.arrayContaining([TENANT_A.siteId, TENANT_B.siteId, TENANT_UMBRELLA.siteId]));
  });
});
