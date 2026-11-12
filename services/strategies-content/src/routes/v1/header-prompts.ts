/** `getHeaderPrompts`: the header prompt counts of the full admin layout. */
import { AuthDenial, Roles, assertSiteMatches, type Opt2RouteConfig } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { loadHeaderPrompts, type HeaderPromptDeps, type HeaderPrompts } from '../../domain/header-prompts.js';

/** The domain collaborators the route reads through. */
export interface HeaderPromptRouteDeps {
  readonly domain: HeaderPromptDeps;
}

const HEADER_PROMPTS_PATH = '/v1/sites/:siteid/header-prompts';

// Every private admin user's full layout renders the header.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.s2, Roles.siteAdmin, Roles.systemUser]),
});

/** Registers `getHeaderPrompts`. */
export async function registerHeaderPromptRoutes(app: FastifyInstance, deps: HeaderPromptRouteDeps): Promise<void> {
  const { domain } = deps;

  app.get<{ Params: { siteid: string }; Reply: HeaderPrompts }>(
    HEADER_PROMPTS_PATH,
    { config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const claims = request.opt2Auth.user;
      if (claims === undefined) {
        throw AuthDenial.unauthenticated('missing-credential');
      }
      assertSiteMatches(request.params.siteid, claims);
      return loadHeaderPrompts(domain, claims);
    },
  );
}
