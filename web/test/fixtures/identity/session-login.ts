import type { components, paths } from '@/generated/clients/identity';
import type { LoginViewState } from '@/screens/clogin/main';

type CurrentSession = paths['/v1/sessions/current']['get']['responses'][200]['content']['application/json'];
type LoginOutcome = paths['/v1/sessions/login']['post']['responses'][200]['content']['application/json'];
type LogoutResult = paths['/v1/sessions/logout']['post']['responses'][200]['content']['application/json'];
type LoginMailResult = paths['/v1/login-mail']['post']['responses'][200]['content']['application/json'];
type SetCookie = components['headers']['SetCookie'];

const RETURN_URL = './?muraAction=cUsers.list&siteid=default';

export const SESSION_SET_COOKIES: readonly SetCookie[] = Object.freeze([
  'CFID=100001;expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;',
  'CFTOKEN=12345678;expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;',
  'JSESSIONID=fixture-jsessionid-0001;expires=Fri, 30-Jun-2056 12:00:00 GMT;path=/;HttpOnly;',
]);

export const LOGOUT_DELETE_COOKIES: readonly SetCookie[] = Object.freeze([
  'userHash=;expires=Tue, 30-Jun-2026 12:00:00 GMT;path=/;HttpOnly;',
  'userid=;expires=Tue, 30-Jun-2026 12:00:00 GMT;path=/;HttpOnly;',
]);

const NO_COOKIES: readonly SetCookie[] = Object.freeze([]);

// The session id is the JSESSIONID value of SESSION_SET_COOKIES: login keeps the session, as legacy never rotates it.
export const loginSessionAnonymous = Object.freeze({
  status: 200,
  body: Object.freeze({
    sessionId: 'fixture-jsessionid-0001',
    epoch: 0,
    user: Object.freeze({ isLoggedIn: false, userID: '' }),
    roles: [],
    mfaPending: false,
    blockLoginUntil: null,
  } satisfies CurrentSession),
});

export const loginSessionBlocked = Object.freeze({
  status: 200,
  body: Object.freeze({
    ...loginSessionAnonymous.body,
    blockLoginUntil: '2026-06-30T12:15:00.000',
  } satisfies CurrentSession),
});

// Identity answers no login page state, so these are the views loadLoginViewState builds from the sessions above and rc.
export const loginPageDefault = Object.freeze({
  mfa: false,
  mfaPerDevice: false,
  showAdminLoginHelp: true,
  rememberMeAvailable: true,
  oauth: Object.freeze({}),
  isBlocked: false,
  mfaPending: false,
  status: '',
  failedchallenge: '',
  authcode: '',
  returnURL: '',
  compactDisplay: 'false',
  rbCookie: '',
  loginMailSent: false,
} satisfies LoginViewState);

export const loginPageWithReturnUrl = Object.freeze({
  ...loginPageDefault,
  returnURL: RETURN_URL,
} satisfies LoginViewState);

export const loginPageFailed = Object.freeze({ ...loginPageDefault, status: 'failed' } satisfies LoginViewState);

export const loginPageDenied = Object.freeze({ ...loginPageDefault, status: 'denied' } satisfies LoginViewState);

export const loginPageFailedChallenge = Object.freeze({
  ...loginPageDefault,
  failedchallenge: 'true',
} satisfies LoginViewState);

export const loginPageBlocked = Object.freeze({ ...loginPageDefault, isBlocked: true } satisfies LoginViewState);

export const loginPageSendLogin = Object.freeze({
  ...loginPageDefault,
  status: 'sendLogin',
  loginMailSent: true,
} satisfies LoginViewState);

export const loginSuccessRedirect = Object.freeze({
  status: 200,
  body: Object.freeze({ outcome: 'success', location: RETURN_URL, epoch: 1 } satisfies LoginOutcome),
  setCookies: SESSION_SET_COOKIES,
});

export const loginSuccessDefault = Object.freeze({
  status: 200,
  body: Object.freeze({ outcome: 'success', location: './', epoch: 1 } satisfies LoginOutcome),
  setCookies: SESSION_SET_COOKIES,
});

export const loginFailureRedirect = Object.freeze({
  status: 200,
  body: Object.freeze({
    outcome: 'failed',
    location:
      './?muraAction=cLogin.main&display=login&status=failed&rememberMe=0&contentid=&LinkServID=' +
      '&returnURL=%2E%2F%3FmuraAction%3DcUsers%2Elist%26siteid%3Ddefault&compactDisplay=false',
    epoch: 0,
  } satisfies LoginOutcome),
  setCookies: NO_COOKIES,
});

export const loginCsrfFailureRedirect = Object.freeze({
  status: 200,
  body: Object.freeze({ outcome: 'csrf-invalid', location: './?muraAction=clogin.main', epoch: 0 } satisfies LoginOutcome),
  setCookies: NO_COOKIES,
});

// LogoutResult names the redirect action rather than a location; logout.ts builds the home.redirect target itself.
export const logoutAnswer = Object.freeze({
  status: 200,
  body: Object.freeze({
    redirect: Object.freeze({ action: 'home.redirect', params: Object.freeze({}) }),
  } satisfies LogoutResult),
  setCookies: LOGOUT_DELETE_COOKIES,
});

export const sendLoginFound = Object.freeze({
  status: 200,
  body: Object.freeze({ status: 'messagesent' } satisfies LoginMailResult),
});

export const sendLoginNotFound = Object.freeze({
  status: 200,
  body: Object.freeze({ status: 'messagesent' } satisfies LoginMailResult),
});
