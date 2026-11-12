// The `clogin.main` admin login page: the controller's private-session redirect, its page state and the view (server-only).
import { cfEq } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, html, raw, type SafeHtml } from '@/lib/html';
import { assetUrl, fw1RedirectTarget } from '@/lib/urls';
import type { PageScreen, ScreenContext } from '../registry';

type Rc = ScreenContext['req']['rc'];

/** CSRF context of the login and MFA challenge forms. */
const LOGIN_CSRF_CONTEXT = 'login';

/** OAuth providers the login form offers, in the order legacy renders their buttons. */
export type LoginOAuthProvider = 'google' | 'facebook' | 'github' | 'azuread';

/** configBean values the login view reads. */
export interface LoginConfig {
  readonly mfa: boolean;
  readonly mfaPerDevice: boolean;
  readonly showAdminLoginHelp: boolean;
  /** `len(configBean.getEncryptionKey())`. */
  readonly rememberMeAvailable: boolean;
  /** Enabled providers (`enableOauth`) with the auth URL identity generated for the session. */
  readonly oauth: Readonly<Partial<Record<LoginOAuthProvider, string>>>;
}

// Identity's contract carries no login configuration, so web renders the settings-template values; start-up always
// generates an encryption key, so remember-me is always offered.
/** The Masa defaults of every {@link LoginConfig} value. */
export const MASA_LOGIN_CONFIG: LoginConfig = Object.freeze({
  mfa: false,
  mfaPerDevice: false,
  showAdminLoginHelp: true,
  rememberMeAvailable: true,
  oauth: Object.freeze({}),
});

/** Everything the login view renders from the session, the configuration and `rc`. */
export interface LoginViewState extends LoginConfig {
  /** `session.blockLoginUntil` is a date after now. */
  readonly isBlocked: boolean;
  /** `isdefined('session.mfa')`: an MFA challenge awaits its code. */
  readonly mfaPending: boolean;
  readonly status: string;
  readonly failedchallenge: string;
  readonly authcode: string;
  readonly returnURL: string;
  readonly compactDisplay: string;
  /** `cookie.rb` as the view reads it, after the request set-up wrote `rc.rb` into it. */
  readonly rbCookie: string;
  /** The view requested the forgot-password mail for `rc.email`. */
  readonly loginMailSent: boolean;
}

/** `rc[name]` matched case-insensitively, as a CFML struct reads it. */
const rcGet = (rc: Rc, name: string): string | undefined =>
  rc[name] ?? Object.entries(rc).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

/** `rc[name]`, or the `''` that clogin `before()` and `$.event()` give an absent key. */
const rcValue = (rc: Rc, name: string): string => rcGet(rc, name) ?? '';

/** The challenge form replaces the credentials form while a challenge is pending and `rc.status` asks for it. */
const isChallenge = (state: Pick<LoginViewState, 'status' | 'mfaPending'>): boolean =>
  cfEq(state.status, 'challenge') && state.mfaPending;

/** `session.blockLoginUntil gt now()`; a LocalTimestamp has no offset, so it parses as the server's local time. */
const isBlockedAt = (blockLoginUntil: string | null, now: Date): boolean =>
  blockLoginUntil !== null && new Date(blockLoginUntil).getTime() > now.getTime();

/**
 * The login page state for `ctx`, sending the forgot-password mail when the view would (main.cfm:309-310).
 * @throws TypeError When the mail is due but `rc.email` is absent, as legacy fails on the undefined element.
 */
export async function loadLoginViewState(
  ctx: ScreenContext,
  config: LoginConfig = MASA_LOGIN_CONFIG,
): Promise<LoginViewState> {
  const { rc } = ctx.req;
  const [current] = await Promise.all([ctx.gateway.identity.currentSession(), ctx.csrf.tokens(LOGIN_CSRF_CONTEXT)]);
  const session = okBody(current, 'identity', 'getCurrentSession');
  const status = rcValue(rc, 'status');
  const isBlocked = isBlockedAt(session.blockLoginUntil, ctx.now);
  const loginMailSent =
    !isBlocked &&
    !isChallenge({ status, mfaPending: session.mfaPending }) &&
    config.showAdminLoginHelp &&
    cfEq(status, 'sendLogin');
  if (loginMailSent) {
    const email = rcGet(rc, 'email');
    if (email === undefined) throw new TypeError('Element EMAIL is undefined in RC.');
    okBody(
      await ctx.gateway.identity.call('post', '/v1/login-mail', { json: { email, siteid: '' } }),
      'identity',
      'requestLoginMail',
    );
  }
  const rcRb = rcValue(rc, 'rb');
  return {
    ...config,
    isBlocked,
    mfaPending: session.mfaPending,
    status,
    failedchallenge: rcValue(rc, 'failedchallenge'),
    authcode: rcValue(rc, 'authcode'),
    returnURL: rcValue(rc, 'returnURL'),
    compactDisplay: rcGet(rc, 'compactDisplay') ?? 'false',
    rbCookie: rcRb !== '' ? rcRb : (ctx.req.cookies.get('rb') ?? ''),
    loginMailSent,
  };
}

type Label = (key: string) => SafeHtml;

/** The alert text of the first failure that applies, or `''`. */
function errorMessage(state: LoginViewState, rbKey: (key: string) => string): string {
  if (state.isBlocked) return rbKey('blocked');
  if (cfEq(state.status, 'denied')) return rbKey('denied');
  if (cfEq(state.status, 'failed')) return rbKey('failed');
  if (cfEq(state.failedchallenge, 'true')) return rbKey('incorrectauthorizationcode');
  return '';
}

/** The `focusblockheader` saved content that opens both panels. */
function focusBlockHeader(): SafeHtml {
  const logo = assetUrl(`${legacySettings().adminDir}/assets/images/masa-logo-black@2x.png`);
  return html`
  <div class="focus-block-header">
  \t<img src="${raw(logo)}" class="mura-logo">
  </div><!-- /focus-block-header -->
`;
}

/** The MFA authorization-code form; the `onAdminMFAChallengeRender` plugin event has no target runtime, so it renders. */
function challengeForm(ctx: ScreenContext, state: LoginViewState, label: Label): SafeHtml {
  const newDevice =
    state.mfaPerDevice && state.authcode === ''
      ? html`\t\t\t\t\t\t\t<div class="alert alert-error"><span>${label('newdevice')}</span></div>\n`
      : '';
  const codeError =
    state.authcode !== ''
      ? html`\t\t\t\t\t\t\t<div class="alert alert-error"><span>${label('authcodeerror')}</span></div>\n`
      : '';
  const rememberDevice = state.mfaPerDevice
    ? html`\t\t\t\t\t\t\t\t\t<input type="hidden" name="rememberdevice" value="1"/>\n`
    : '';
  const placeholder = raw(encodeHtmlAttr(ctx.rb.rbKey('login.authorizationcode')));
  return html`${newDevice}${codeError}\t\t\t\t\t\t\t<form novalidate="novalidate" id="loginForm" name="frmLogin" method="post" action="index.cfm" onsubmit="return submitForm(this);">

\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t  \t\t\t<label>${label('enteremailedauthcode')}</label>
\t\t\t\t\t\t\t\t<div class="input-prepend">
\t\t\t\t\t\t\t\t  \t<span class="add-on"><i class="mi-envelope"></i></span><input autocomplete="off" id="authcode" name="authcode" type="text" placeholder="${placeholder}" />
\t\t\t\t\t\t\t\t</div>
${rememberDevice}\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t<div class="mura-focus-actions">
\t\t\t\t\t\t\t\t<input type="submit" class="btn" value="${label('submit')}" />
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t<input type="hidden" name="muraAction" value="cLogin.login">
\t\t\t\t\t\t\t<input type="hidden" name="status" value="challenge">
\t\t\t\t\t\t\t<input type="hidden" name="attemptChallenge" value="true">
\t\t\t\t\t\t\t<input type="hidden" name="isadminlogin" value="true">
\t\t\t\t\t\t\t${ctx.csrf.render(LOGIN_CSRF_CONTEXT, 'form')}
\t\t\t\t\t\t\t</form>
`;
}

/** Provider buttons in legacy order: provider, button class, icon class and label key. */
const OAUTH_BUTTONS: ReadonlyArray<readonly [LoginOAuthProvider, string, string, string]> = [
  ['google', 'ggl', 'mi-google', 'loginwithgoogle'],
  ['facebook', 'fb', 'mi-facebook', 'loginwithfacebook'],
  ['github', 'gh', 'mi-github', 'loginwithgithub'],
  ['azuread', 'az', 'mi-windows', 'loginwithazuread'],
];

/** The OAuth wrapper with one button per enabled provider; empty when none is enabled. */
function oauthButtons(state: LoginViewState, label: Label): SafeHtml | '' {
  const buttons = OAUTH_BUTTONS.flatMap(([provider, css, icon, key]) => {
    const authUrl = state.oauth[provider];
    if (authUrl === undefined) return [];
    return html`\t\t\t\t\t\t\t\t<a href="${raw(authUrl)}" title="${label(key)}" class="mura-login-auth-btn ${css}">
\t\t\t\t\t\t\t\t\t<i class="${icon}"></i>
\t\t\t\t\t\t\t\t\t<span>${label(key)}</span>
\t\t\t\t\t\t\t\t</a>
`;
  });
  if (buttons.length === 0) return '';
  return html`\t\t\t\t\t\t\t\t<div class="mura-login-auth-wrapper">
${buttons}\t\t\t\t\t\t<div class="text-divider"><span>${label('or')}</span></div>
\t\t\t\t\t\t<h3 class="center mura-login-auth-heading">${label('loginwithcredentials')}</h3>
\t\t\t\t\t\t</div>
`;
}

/** Locale options after English, which is never marked selected; labels are legacy markup. */
const RB_OPTIONS: ReadonlyArray<readonly [value: string, label: string]> = [
  ['da', 'Danish'],
  ['de', 'Deutsch'],
  ['nl', 'Dutch'],
  ['fil', 'Filipino'],
  ['fr', 'Fran&ccedil;ais'],
  ['hu', 'Hungarian'],
  ['id', 'Indonesian'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['ru', 'Русский'],
  ['es', 'Spanish'],
];

/** The language group with `select name="rb"`, the option matching the `rb` cookie selected. */
function languageGroup(rbCookie: string): SafeHtml {
  const options = RB_OPTIONS.map(
    ([value, text]) =>
      html`\t\t\t\t\t\t\t\t\t\t<option value="${value}"${cfEq(rbCookie, value) ? raw(' selected') : ''}>${raw(text)}</option>\n`,
  );
  return html`\t\t\t\t\t\t\t\t<div class="mura-control-group half">
\t\t\t\t\t\t\t\t\t<label></label>
\t\t\t\t\t\t\t\t  <select name="rb">
\t\t\t\t\t\t\t\t\t\t<option value="en_US">English</option>
${options}\t\t\t\t\t\t\t\t\t</select>
\t\t\t\t\t\t\t\t</div>
`;
}

/** The remember-me switch, offered when MFA is off and an encryption key exists. */
function rememberMe(state: LoginViewState, label: Label): SafeHtml | '' {
  if (state.mfa || !state.rememberMeAvailable) return '';
  return html`\t\t\t\t\t\t\t\t\t<div class="mura-control-group half" id="remember-me">
\t\t\t\t\t\t\t\t\t  <label class="css-input switch switch-sm switch-primary">
\t\t\t\t\t\t\t\t\t\t  <input type="checkbox" id="rememberMe" name="rememberMe" value="1" ><span></span> ${label('rememberme')}
\t\t\t\t\t\t\t\t\t  </label>
\t\t\t\t\t\t\t\t\t</div>
`;
}

/** The forgot-password form of the password panel, with the sent-mail response when the view sent it. */
function sendLoginForm(state: LoginViewState, label: Label, rbKey: (key: string) => string): SafeHtml {
  const alertClass = state.loginMailSent ? 'alert alert-error' : '';
  const response = state.loginMailSent ? raw(encodeHtml(rbKey('messagesent'))) : label('enteremail');
  return html`\t\t\t\t\t\t\t<form novalidate="novalidate" id="sendLogin" name="sendLogin" method="post" action="./?muraAction=cLogin.main" onsubmit="return submitForm(this);">

\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t\t<h2>${label('forgetpassword')}</h2>
\t\t\t\t\t\t\t\t\t<p id="pw-response" class="${alertClass} clear-both"> ${response} </p>
\t\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t\t\t\t<label>${label('emailaddress')}</label>
\t\t\t\t\t\t\t\t\t\t<input id="email" name="email" type="text" autofocus="autofocus">
\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t<div class="mura-focus-actions">
\t\t\t\t\t\t\t \t<input type="submit" class="btn" value="${label('submit')}" />
\t\t\t\t\t\t\t </div>
\t\t\t\t\t\t\t<input type="hidden" name="status" value="sendlogin" />
\t\t\t\t\t\t\t<input name="returnURL" type="hidden" value="${raw(encodeHtmlAttr(state.returnURL))}">
\t\t\t\t\t\t\t<input type="hidden" name="isAdminLogin" value="true">
\t\t\t\t\t\t\t<input type="hidden" name="compactDisplay" value="${raw(encodeHtmlAttr(state.compactDisplay))}">
\t\t\t\t\t\t   </form>

\t\t\t\t\t\t<div id="login-link">
\t\t\t\t\t\t\t <label><a href="#" onclick="return false;">Return to login</a></label>
\t\t\t\t\t\t</div>
`;
}

/** The credentials form, then the end of the login panel and the start of the password panel. */
function credentialsForms(ctx: ScreenContext, state: LoginViewState, label: Label, rbKey: (key: string) => string): SafeHtml {
  const sendLogin = cfEq(state.status, 'sendLogin');
  const pwLink = state.showAdminLoginHelp
    ? html`\t\t\t\t\t\t\t<div id="pw-link">
\t\t\t\t\t\t\t\t<label><a href="#" onclick="return false;">${label('forgetpassword')}</a></label>
\t\t\t\t\t\t\t</div>
`
    : '';
  return html`\t\t\t\t\t\t<form novalidate="novalidate" id="loginForm" name="frmLogin" method="post" action="index.cfm" onsubmit="return submitForm(this);">
${oauthButtons(state, label)}
\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t<label>
\t\t\t\t\t\t\t\t${label('username')}
\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t\t\t<input id="username" name="username" type="text" autofocus="autofocus">
\t\t\t\t\t\t\t</div>

\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t\t<label>${label('password')}</label>
\t\t\t\t\t\t\t\t<input id="password" type="password" name="password" autocomplete="off">
\t\t\t\t\t  \t</div>

${rememberMe(state, label)}${languageGroup(state.rbCookie)}
\t\t\t\t\t\t\t<div class="mura-focus-actions">
\t\t\t\t\t\t\t\t<button type="submit"> ${label('login')}</button>
\t\t\t\t\t\t\t</div>

\t\t\t\t\t\t\t<input name="returnUrl" type="hidden" value="${raw(encodeHtmlAttr(state.returnURL))}">
\t\t\t\t\t\t\t<input type="hidden" name="muraAction" value="cLogin.login">
\t\t\t\t\t\t\t<input type="hidden" name="isAdminLogin" value="true">
\t\t\t\t\t\t\t<input type="hidden" name="compactDisplay" value="${raw(encodeHtmlAttr(state.compactDisplay))}">
\t\t\t\t\t\t\t${ctx.csrf.render(LOGIN_CSRF_CONTEXT, 'form')}
\t\t\t\t\t\t</form>

${pwLink}
\t\t\t\t</div><!-- /block-content -->
\t\t\t</div><!-- /mura-focus-block -->

\t\t<div class="block mura-focus-block animated" id="mura-password-panel" ${sendLogin ? '' : raw('style="display:none;"')}>

\t\t\t${focusBlockHeader()}

\t  \t  <div class="block-content">

${state.showAdminLoginHelp ? sendLoginForm(state, label, rbKey) : ''}`;
}

/** The view's closing script; the compact layout first sizes the front-end proxy frame. */
function loginScript(state: LoginViewState, rbKey: (key: string) => string): SafeHtml {
  const compactSizing = cfEq(state.compactDisplay, 'true')
    ? raw(`\tif (top.location != self.location) {
\t\tif(jQuery("#ProxyIFrame").length){
\t\t\tjQuery("#ProxyIFrame").load(
\t\t\t\tfunction(){
\t\t\t\t\tfrontEndProxy.post({cmd:'setWidth',width:400});
\t\t\t\t}
\t\t\t);
\t\t} else {
\t\t\tfrontEndProxy.post({cmd:'setWidth',width:400});
\t\t}
\t}
`)
    : '';
  return html`<script type="text/javascript">
jQuery(document).ready(function(){
${compactSizing}

\tjQuery('#pw-link a').click(function(){
\t\tjQuery('#mura-login-panel').removeClass('flipInY').addClass('flipOutY').hide();
\t\tjQuery('#mura-password-panel').removeClass('flipOutY').show().addClass('flipInY');
\t\tdocument.getElementById('email').focus();
\t});
\tjQuery('#login-link a').click(function(){
\t\tjQuery('#mura-password-panel').removeClass('flipInY').addClass('flipOutY').hide();
\t\tjQuery('#pw-response').removeClass('alert').removeClass('alert-error').html('${raw(encodeHtmlAttr(rbKey('enteremail')))}');
\t\tjQuery('#mura-login-panel').removeClass('flipOutY').show().addClass('flipInY');
\t\tdocument.getElementById('username').focus();
\t});

});
</script>`;
}

/** The `clogin/main.cfm` view markup for `state`; CSRF tokens of context `login` must have been fetched. */
export function renderLoginView(ctx: ScreenContext, state: LoginViewState): SafeHtml {
  const rbKey = (key: string): string => ctx.rb.rbKey(`login.${key}`);
  const label: Label = (key) => raw(rbKey(key));
  const message = errorMessage(state, rbKey);
  const alert =
    message === ''
      ? ''
      : html`\t\t\t\t\t<div class="alert alert-error">
\t\t\t\t\t\t<span>${raw(message)}</span>
\t\t\t\t\t</div>
`;
  let form: SafeHtml | '' = '';
  if (!state.isBlocked) {
    form = isChallenge(state) ? challengeForm(ctx, state, label) : credentialsForms(ctx, state, label, rbKey);
  }
  return html`<div id="mura-login">

\t<div class="block mura-focus-block animated" ${cfEq(state.status, 'sendLogin') ? raw('style="display:none;"') : ''} id="mura-login-panel">

\t\t${focusBlockHeader()}

\t\t<div class="block-content">

${alert}
\t\t\t\t<!-- mura-primary-login-token -->

${form}
\t\t\t</div><!-- /block-content -->
\t\t</div><!-- /mura-focus-block -->

</div><!-- /mura-login -->


${loginScript(state, rbKey)}`;
}

/** `clogin.main`: the login page, or `home.redirect` for a session already logged in to a private user pool. */
export const cloginMainScreen: PageScreen<LoginViewState> = {
  circuit: 'clogin',
  action: 'main',
  owner: 'identity',
  mode: 'page',
  // clogin before() only sets rc defaults; this is main()'s redirect, which FW/1 runs before the view as the pipeline
  // runs a screen gate.
  gate: (req) =>
    req.session.s2IsPrivate
      ? { kind: 'redirect', location: fw1RedirectTarget({ action: 'home.redirect', path: './', ses: req.ses }) }
      : { kind: 'allow' },
  load: (ctx) => loadLoginViewState(ctx),
  render: (ctx, state) => ({ body: renderLoginView(ctx, state) }),
};
