// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Registry of the e-signature route modules: the fixture routes and the `/v1/esignature` routes. */
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { EsignatureDomainDeps } from '../domain/signing.js';
import type { PeopleClient } from '../legacy/people-client.js';
import type { EsignatureRepository } from '../repo/repository.js';
import { registerFixtureRoutes } from './fixture.js';
import { registerV1Routes } from './v1.js';

/** Runtime dependencies of every e-signature route module: the e-signature tenant database, repository, clock and people reader. */
export interface EsignatureDeps {
  db: TenantDb;
  repository: EsignatureRepository;
  clock: Clock;
  peopleClient: PeopleClient;
}

/** `true` only when `A` and `B` are assignable to each other. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Accepts only `true`, so a `false` argument fails `tsc`. */
type AssertTrue<T extends true> = T;

/** Fails `tsc` when `EsignatureDeps` drifts from the deps the route modules and domain functions take; checked though never referenced. */
type DepsMatchDomain = AssertTrue<MutuallyAssignable<EsignatureDeps, EsignatureDomainDeps & { db: TenantDb }>>;

/** Registers the fixture and `/v1` route plugins, each encapsulated so its own error handler covers only its routes. */
export async function registerRoutes(app: FastifyInstance, deps: EsignatureDeps): Promise<void> {
  await registerFixtureRoutes(app, deps);
  await registerV1Routes(app, deps);
}
