/** `projectionAwait`: answers once the reverse projector has applied target write positions in legacy. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { formatWritePosition, parseWritePosition } from '@opt2/platform/migration-kit';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';

import type { components, paths } from '../generated/openapi.js';
import type { AwaitProjectionRequest, Projector } from '../reverse/index.js';

type OwnerName = components['schemas']['OwnerName'];
type ProjectionAwaitResponse = components['schemas']['ProjectionAwaitResponse'];

/** The projector barrier and the await budget used when a request names none. */
export interface ProjectionRouteDeps {
  projector: Pick<Projector, 'awaitProjection'>;
  /** Config `projection.defaultAwaitTimeoutMs`. */
  defaultTimeoutMs: number;
}

const AWAIT_PATH = '/internal/v1/projection/await' satisfies keyof paths;

/** Operations this module registers: contract `path` and Fastify `url`. */
export const PROJECTION_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'projectionAwait', method: 'POST', path: AWAIT_PATH, url: AWAIT_PATH } as const),
]);

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('gateway')]),
});

// The mapped type stops compiling when the contract's OwnerName enum gains or loses a member.
const OWNER_NAMES: { readonly [K in OwnerName]: K } = Object.freeze({
  identity: 'identity',
  people: 'people',
  'programs-sites': 'programs-sites',
  'strategies-content': 'strategies-content',
  communications: 'communications',
  reporting: 'reporting',
  surveys: 'surveys',
  timesheets: 'timesheets',
  finance: 'finance',
  'e-signature': 'e-signature',
  stub: 'stub',
});

const ownerName = z.enum(OWNER_NAMES);
const xidString = z.string().regex(/^[0-9]{1,20}$/);
const timeoutMs = z.int().min(1).max(30_000).optional();

// ProjectionAwaitRequest: exactly one of the two strict forms.
const bodySchema = z.union([
  z.strictObject({
    positions: z.partialRecord(ownerName, xidString).refine((positions) => Object.keys(positions).length > 0),
    timeoutMs,
  }),
  z.strictObject({
    owners: z
      .array(ownerName)
      .min(1)
      .refine((owners) => new Set(owners).size === owners.length),
    timeoutMs,
  }),
]);

/** The awaiter request for a contract body, the configured budget standing in for an omitted `timeoutMs`; anything else is the legacy 400. */
function awaitRequestOf(body: unknown, defaultTimeoutMs: number): AwaitProjectionRequest {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw new LegacyApiError('invalidParameters');
  const budget = parsed.data.timeoutMs ?? defaultTimeoutMs;
  if ('owners' in parsed.data) return { owners: parsed.data.owners, timeoutMs: budget };
  // The schema admits only contract owners and xids, so the shared write-position codec cannot reject them.
  return { positions: parseWritePosition(formatWritePosition(parsed.data.positions)), timeoutMs: budget };
}

/** Registers `projectionAwait`; a budget that passes, or an owner that cannot be read, is the legacy 503. */
export function registerProjectionRoutes(app: FastifyInstance, deps: ProjectionRouteDeps): void {
  app.post<{ Body: unknown; Reply: ProjectionAwaitResponse }>(AWAIT_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    // ProjectionTimeoutError and owner unavailability are LegacyServiceUnavailableErrors: the service-kit error
    // handler answers them with the JSON API `server_error` 503 and logs the pending positions, so none is caught here.
    const result = await deps.projector.awaitProjection(awaitRequestOf(request.body, deps.defaultTimeoutMs));
    // The contract's ProjectionAwaitResponse admits no `waitedMs`, so the awaiter's timing is not answered.
    return { applied: true, positions: Object.fromEntries(result.positions) };
  });
}
