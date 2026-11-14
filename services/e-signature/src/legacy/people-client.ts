// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature's only route to person data: people's JSON API `user` read, standing in for the fixture's `userManager.read`. */
import { LEGACY_ERROR_MAP, cfIsNumeric, cfToNumber } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import type { components } from '../generated/clients/people.js';

type Schemas = components['schemas'];
type UserEntity = Schemas['UserEntity'];
type UserEnvelope = Schemas['LegacyEnvelope'] & { data: UserEntity };
type ErrorEnvelope = Schemas['LegacyError'];

/** Callee name of people in `OPT2_SERVICE_URLS`. */
export const PEOPLE_SERVICE = 'people';

/** The userBean facts e-signature reads, as people's JSON API serializes them. */
export interface PersonSummary {
  userId: string;
  siteId: string;
  type: number;
  fname: string;
  lname: string;
  email: string;
  inactive: number;
}

/** E-signature's reads of people. */
export interface PeopleClient {
  /** The user `userId` read in site `siteId`; null for an empty id or an unknown user, throws when people denies or is unavailable. */
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

/** A residual difference between people's `user` read and the fixture's `userManager.read`. */
export interface PeopleReadGap {
  readonly id: string;
  readonly description: string;
}

/** Where people's `user` read answers differently from `userManager.read` (userManager.cfc:125-195). */
export const PEOPLE_READ_GAPS: readonly PeopleReadGap[] = Object.freeze([
  Object.freeze({
    id: 'cross-permission',
    description:
      "People's JSON API answers 401 authorization for another user's record to a caller without the Users module (m:008, s2 or site-admin); the fixture reads any user.",
  }),
  Object.freeze({
    id: 'cross-site',
    description:
      "People resolves the user within the requested site's user pools only; userManager.read reads by userid across every site.",
  }),
]);

const DEFAULT_DENIED_TYPE = 'authorization';
const GROUP_TYPE = 1;
const USER_TYPE = 2;
// userBean defaults InActive to 0 (userBean.cfc:153); the JSON API serializes a NULL column as ''.
const DEFAULT_INACTIVE = 0;
const NEW_BEAN_FLAGS: readonly unknown[] = [1, '1', true];

/** A response body as a parsed envelope; text bodies are JSON-parsed. */
function envelopeOf<T>(body: unknown): T {
  return (typeof body === 'string' ? JSON.parse(body) : body) as T;
}

/** The error type whose code and message the denial carries; the wire error names no type itself. */
function deniedType(body: unknown): string {
  const error = envelopeOf<Partial<ErrorEnvelope> | undefined>(body)?.error;
  const match = Object.entries(LEGACY_ERROR_MAP).find(([, spec]) => spec.code === error?.code && spec.message === error?.message);
  return match?.[0] ?? DEFAULT_DENIED_TYPE;
}

/** userBean.setType's decoding of the serialized `type`: a number as is, `group` 1, any other text 2 (userBean.cfc:753-765). */
function userType(serialized: unknown): number {
  if (cfIsNumeric(serialized)) return cfToNumber(serialized);
  return String(serialized).toLowerCase() === 'group' ? GROUP_TYPE : USER_TYPE;
}

/** A found user as a person summary; a new bean (`isnew` 1) is null, as `getIsNew()` marks a missing user. */
function personSummary(entity: UserEntity): PersonSummary | null {
  if (NEW_BEAN_FLAGS.includes(entity.isnew)) return null;
  return {
    userId: entity.userid ?? '',
    siteId: entity.siteid ?? '',
    type: userType(entity.type),
    fname: entity.fname ?? '',
    lname: entity.lname ?? '',
    email: entity.email ?? '',
    inactive: typeof entity.inactive === 'number' ? entity.inactive : DEFAULT_INACTIVE,
  };
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
        path: `/_api/json/v1/${encodeURIComponent(siteId)}/user/${encodeURIComponent(userId)}`,
      });
      switch (response.status) {
        case 200:
          return personSummary(envelopeOf<UserEnvelope>(response.body).data);
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
