/** `orphanArchiveProbe`: the stored fact the gateway needs to decide whether a legacy 404 render writes a `target`-authoritative unit. */
import { Roles, serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';

import type { components, paths } from '../generated/openapi.js';
import { ORPHAN_PROBE_MAX_FILENAME_LENGTH, ORPHAN_PROBE_MAX_FILENAMES } from '../windows/index.js';

type Schemas = components['schemas'];

/** The probe the route answers with; it throws a LegacyServiceUnavailableError when legacy cannot be read. */
export interface ProbeRouteDeps {
  orphanArchive: (filenames: readonly string[]) => Promise<boolean>;
}

const ORPHAN_ARCHIVE_PATH = '/internal/v1/probes/orphan-archive' satisfies keyof paths;

/** Operations this module registers: contract `path` and Fastify `url`. */
export const PROBE_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'orphanArchiveProbe', method: 'POST', path: ORPHAN_ARCHIVE_PATH, url: ORPHAN_ARCHIVE_PATH } as const),
]);

// The filenames come from any site's request paths, so no site the caller acts for is checked.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('gateway'), Roles.platformOperator]),
  siteCheck: false,
});

const bodySchema = z.strictObject({
  filenames: z.array(z.string().max(ORPHAN_PROBE_MAX_FILENAME_LENGTH)).min(1).max(ORPHAN_PROBE_MAX_FILENAMES),
}) satisfies z.ZodType<Schemas['OrphanArchiveProbeRequest']>;

/** Registers `orphanArchiveProbe`; an unreadable legacy database is the service-kit's legacy 503. */
export function registerProbeRoutes(app: FastifyInstance, deps: ProbeRouteDeps): void {
  app.post<{ Body: unknown; Reply: Schemas['OrphanArchiveProbeResponse'] }>(
    ORPHAN_ARCHIVE_PATH,
    { config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) throw new LegacyApiError('invalidParameters');
      return { orphan: await deps.orphanArchive(parsed.data.filenames) };
    },
  );
}
