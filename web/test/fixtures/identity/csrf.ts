import type { components } from '@/generated/clients/identity';

type IssuedCsrfToken = components['schemas']['CsrfTokenSet']['tokens'][number];

// The ids of USER_IDS.qaEditor (../session), GROUP_IDS.defaultEditor (./groups) and
// OAUTH_CLIENT_IDS.clientCredentials (./oauth-clients); this module imports no sibling fixture, so they must stay equal.
const QA_EDITOR_USER_ID = '5A000000-0000-0000-0000000000000002';
const EDITOR_GROUP_ID = '6A000000-0000-0000-0000000000000002';
const OAUTH_CLIENT_ID = '0A000000-0000-0000-0000000000000001';

const EXPIRES = '260630150000000';

export const CSRF_CONTEXTS = Object.freeze({
  login: 'login',
  updateCore: 'updatecore',
  editGroup: EDITOR_GROUP_ID,
  addToGroup: `${QA_EDITOR_USER_ID}${EDITOR_GROUP_ID}addtogroup`,
  cpermMain: '00000000000000000000000000000000001',
  cpermModule: '00000000000000000000000000000000008',
  cwebservice: OAUTH_CLIENT_ID,
} as const);

export const CSRF_LOGIN: Readonly<IssuedCsrfToken> = Object.freeze({
  context: CSRF_CONTEXTS.login,
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000001',
  csrf_token_expires: EXPIRES,
});

export const CSRF_UPDATECORE: Readonly<IssuedCsrfToken> = Object.freeze({
  context: CSRF_CONTEXTS.updateCore,
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000002',
  csrf_token_expires: EXPIRES,
});

export const CSRF_EDIT_GROUP: Readonly<IssuedCsrfToken> = Object.freeze({
  context: CSRF_CONTEXTS.editGroup,
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000003',
  csrf_token_expires: EXPIRES,
});

export const CSRF_ADD_TO_GROUP: Readonly<IssuedCsrfToken> = Object.freeze({
  context: CSRF_CONTEXTS.addToGroup,
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000004',
  csrf_token_expires: EXPIRES,
});

export const CSRF_CPERM_MAIN: Readonly<IssuedCsrfToken> = Object.freeze({
  context: CSRF_CONTEXTS.cpermMain,
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000005',
  csrf_token_expires: EXPIRES,
});

export const CSRF_CPERM_MODULE: Readonly<IssuedCsrfToken> = Object.freeze({
  context: CSRF_CONTEXTS.cpermModule,
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000006',
  csrf_token_expires: EXPIRES,
});

export const CSRF_CWEBSERVICE: Readonly<IssuedCsrfToken> = Object.freeze({
  context: CSRF_CONTEXTS.cwebservice,
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000007',
  csrf_token_expires: EXPIRES,
});

export const CSRF_BY_CONTEXT: Readonly<Record<string, Readonly<IssuedCsrfToken>>> = Object.freeze({
  [CSRF_CONTEXTS.login]: CSRF_LOGIN,
  [CSRF_CONTEXTS.updateCore]: CSRF_UPDATECORE,
  [CSRF_CONTEXTS.editGroup]: CSRF_EDIT_GROUP,
  [CSRF_CONTEXTS.addToGroup]: CSRF_ADD_TO_GROUP,
  [CSRF_CONTEXTS.cpermMain]: CSRF_CPERM_MAIN,
  [CSRF_CONTEXTS.cpermModule]: CSRF_CPERM_MODULE,
  [CSRF_CONTEXTS.cwebservice]: CSRF_CWEBSERVICE,
});
