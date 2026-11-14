import type { components } from '@/generated/clients/identity';
import { USER_IDS } from '../session';

type OAuthClient = components['schemas']['OAuthClient'];
type OAuthClientListItem = components['schemas']['OAuthClientListItem'];
type OAuthClientDetail = components['schemas']['OAuthClientDetail'];
type LegacyErrors = components['schemas']['LegacyErrors'];

export const OAUTH_CLIENT_IDS = Object.freeze({
  clientCredentials: '0A000000-0000-0000-0000000000000001',
  basic: '0A000000-0000-0000-0000000000000002',
  authorizationCode: '0A000000-0000-0000-0000000000000003',
} as const);

const clientCredentialsClient: OAuthClient = Object.freeze({
  clientid: OAUTH_CLIENT_IDS.clientCredentials,
  clientsecret: 'fixture-secret-not-real-0001',
  siteid: 'default',
  userid: USER_IDS.admin,
  name: 'Fixture REST Client',
  description: 'Synthetic client for REST access with client credentials.',
  granttype: 'client_credentials',
  redirecturl: '',
  created: '2026-06-30T10:05:00.000',
  lastupdate: '2026-10-29T15:45:07.000',
  lastupdateby: 'Admin User',
  lastupdatebidy: '',
});

const basicClient: OAuthClient = Object.freeze({
  clientid: OAUTH_CLIENT_IDS.basic,
  clientsecret: 'fixture-secret-not-real-0002',
  siteid: 'default',
  userid: USER_IDS.qaEditor,
  name: 'Fixture Basic Client',
  description: null,
  granttype: 'basic',
  redirecturl: null,
  created: '2026-06-29T08:30:00.000',
  lastupdate: '2026-06-30T09:15:00.000',
  lastupdateby: 'Admin User',
  lastupdatebidy: '',
});

const authorizationCodeClient: OAuthClient = Object.freeze({
  clientid: OAUTH_CLIENT_IDS.authorizationCode,
  clientsecret: 'fixture-secret-not-real-0003',
  siteid: 'default',
  userid: null,
  name: 'Fixture Authorization Code Client',
  description: 'Synthetic client for the authorization code grant.',
  granttype: 'authorization_code',
  redirecturl: 'https://example.com/callback',
  created: '2026-06-28T14:00:00.000',
  lastupdate: '2026-06-29T16:40:12.000',
  lastupdateby: 'Admin User',
  lastupdatebidy: '',
});

export const oauthClients: readonly OAuthClient[] = Object.freeze([
  clientCredentialsClient,
  basicClient,
  authorizationCodeClient,
]);

/** The stored clients as identity's list answers them, each without its secret. */
export const oauthClientRows: readonly OAuthClientListItem[] = Object.freeze(
  oauthClients.map(({ clientsecret: _secret, ...row }) => Object.freeze(row)),
);

export const emptyOAuthClients: readonly OAuthClientListItem[] = Object.freeze([]);

export const existingClientEdit: OAuthClientDetail = Object.freeze({
  client: clientCredentialsClient,
  exists: true,
});

export const newClientEdit: OAuthClientDetail = Object.freeze({
  client: Object.freeze({
    clientid: '0A000000-0000-0000-0000000000000004',
    clientsecret: '',
    siteid: 'default',
    userid: '',
    name: '',
    description: '',
    granttype: 'basic',
    redirecturl: '',
    created: '2026-06-30T12:00:00.000',
    lastupdate: '2026-06-30T12:00:00.000',
    lastupdateby: 'Admin User',
    lastupdatebidy: '',
  } satisfies OAuthClient),
  exists: false,
});

export const saveErrors: LegacyErrors = Object.freeze({
  name: "The property named 'name' is not valid",
});
