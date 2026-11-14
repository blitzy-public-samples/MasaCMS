// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature's only route to person data: people's pool-user read, standing in for the fixture's `userManager.read`. */
import { LEGACY_ERROR_MAP } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import type { components } from '../generated/clients/people.js';

type Schemas = components['schemas'];
type PoolUser = Schemas['PoolUser'];
type ErrorEnvelope = Schemas['LegacyError'];

/** Callee name of people in `OPT2_SERVICE_URLS`. */
export const PEOPLE_SERVICE = 'people';

// People's `readPoolUser` operation.
const POOL_USER_PATH = '/internal/v1/users/pool-user';

/** The userBean facts e-signature reads, as people's pool-user read answers them. */
export interface PersonSummary {
  userId: string;
  siteId: string;
  type: number;
}

/** E-signature's reads of people. */
export interface PeopleClient {
  /** The user `userId` of site `siteId`'s public or private user pool; null for an empty id or one no pool user holds, throws when people denies or is unavailable. */
  readPerson(siteId: string, userId: string): Promise<PersonSummary | null>;
}

/** People refused the read; `type` is the legacy JSON API error type of its answer. */
export class PeopleReadDeniedError extends Error {
  override readonly name: string = 'PeopleReadDeniedError';

  constructor(
    readonly status: 401 | 403,
    readonly type: string,
  ) {
    super(`${PEOPLE_SERVICE} denied the user read (HTTP ${String(status)} ${type})`);
  }
}

const DEFAULT_DENIED_TYPE = 'authorization';

/** A response body as parsed JSON; text bodies are JSON-parsed. */
function bodyOf<T>(body: unknown): T {
  return (typeof body === 'string' ? JSON.parse(body) : body) as T;
}

/** The error type whose code and message the denial carries; the wire error names no type itself. */
function deniedType(body: unknown): string {
  const error = bodyOf<Partial<ErrorEnvelope> | undefined>(body)?.error;
  const match = Object.entries(LEGACY_ERROR_MAP).find(([, spec]) => spec.code === error?.code && spec.message === error?.message);
  return match?.[0] ?? DEFAULT_DENIED_TYPE;
}

/** A found pool user as a person summary. */
function personSummary(user: PoolUser): PersonSummary {
  return { userId: user.userid, siteId: user.siteid, type: user.type };
}

/** The legacy-shaped 503 for a gateway-class answer from people. */
function unavailable(status: number): ServiceUnavailableError {
  const cause = Object.assign(new Error(`${PEOPLE_SERVICE} user read answered HTTP ${String(status)}`), {
    code: `HTTP_${String(status)}`,
  });
  return new ServiceUnavailableError(PEOPLE_SERVICE, cause);
}

/** Creates e-signature's people client over its service client, which forwards the caller's user token. */
export function createPeopleClient({ client }: { client: ServiceClient }): PeopleClient {
  return {
    async readPerson(siteId, userId) {
      if (userId === '') return null;
      const response = await client.request<unknown>({
        service: PEOPLE_SERVICE,
        method: 'GET',
        path: POOL_USER_PATH,
        query: { siteid: siteId, userid: userId },
      });
      switch (response.status) {
        case 200:
          return personSummary(bodyOf<PoolUser>(response.body));
        case 404:
          return null;
        case 401:
        case 403:
          throw new PeopleReadDeniedError(response.status, deniedType(response.body));
        case 502:
        case 503:
        case 504:
          throw unavailable(response.status);
        default:
          throw new Error(`${PEOPLE_SERVICE} answered the user read with HTTP ${String(response.status)}`);
      }
    },
  };
}
