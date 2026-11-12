import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { isSupportedLocale, rbFor } from '@/lib/resource-bundles/rb';
import { renderEmailTab } from '@/screens/csettings/editsite/email';
import type { EditSiteBean, EditSiteModel } from '@/screens/csettings/editsite/model';
import { fragmentModel } from '../../helpers/dom-model';

// The installed `default` site as legacy reads it.
const BEAN: EditSiteBean = {
  siteID: 'default', site: 'Default', tagline: '', domain: 'localhost', domainAlias: '', enforcePrimaryDomain: 0,
  useSSL: 0, siteLocale: '', theme: 'default', pageLimit: 1000, nextN: 20, cache: 0, cacheFreeMemoryThreshold: 60,
  locking: 'none', commentApprovalDefault: 1, exportLocation: '', customTagGroups: '', enableLockdown: '',
  hasLockableNodes: 0, isRemote: 0, remoteContext: '', remotePort: 80, resourceDomain: '', resourceSSL: 0,
  reCAPTCHASiteKey: '', reCAPTCHASecret: '', reCAPTCHALanguage: 'en', contactName: '', contactAddress: '',
  contactCity: '', contactState: '', contactZip: '', contactPhone: '', contactEmail: '', publicUserPoolID: 'default',
  privateUserPoolID: 'default', displayPoolID: 'default', filePoolID: 'default', categoryPoolID: 'default',
  contentPoolID: 'default', extranet: 1, hasFeedManager: 1, dataCollection: 1, hasComments: 1, JSONApi: 1,
  emailBroadcaster: 1, emailBroadcasterLimit: 0, hasChangesets: 1, enforceChangesets: 0, showDashboard: 0,
  scaffolding: 0, contact: 'admin@example.com', mailServerIP: '', mailServerSMTPPort: '25', mailServerPOPPort: '110',
  mailServerUsername: '', mailServerPassword: '', mailServerTLS: 'false', mailServerSSL: 'false',
  useDefaultSMTPServer: 1, contentPendingScript: '', contentApprovalScript: '', contentRejectionScript: '',
  contentCanceledScript: '', sendAuthCodeScript: '', sendLoginScript: '', mailingListConfirmScript: '',
  accountActivationScript: '', reminderScript: '', smallImageHeight: '80', smallImageWidth: '80',
  mediumImageHeight: '180', mediumImageWidth: '180', largeImageHeight: 'AUTO', largeImageWidth: '600',
  placeholderImgID: '', extranetPublicReg: 0, loginURL: '?display=login', editProfileURL: '?display=editProfile',
  extranetPublicRegNotify: '', columnCount: 3, primaryColumn: 2, columnNames: 'Left Column^Main Content^Right Column',
};

const SCRIPTS = [
  'contentPendingScript',
  'contentApprovalScript',
  'contentRejectionScript',
  'contentCanceledScript',
  'sendAuthCodeScript',
  'sendLoginScript',
  'mailingListConfirmScript',
  'accountActivationScript',
  'reminderScript',
] as const;

/** Rendered markup of the Email tab for the default bean with `overrides`. */
function render(overrides: Partial<EditSiteBean> = {}): string {
  const m: EditSiteModel = {
    bean: { ...BEAN, ...overrides },
    config: {
      javaEnabled: true, lockableNodes: false, dataCollection: true, emailBroadcaster: true, postBundles: true,
      razuna: false, useLayoutManager: false,
    },
    rb: rbFor('en'),
    isSupportedLocale,
    isS2: true,
    requestSiteId: 'default',
    rcAction: '',
    compactDisplay: 'false',
    addSite: false,
    sessionSiteEmailBroadcaster: true,
    exportLocationExists: false,
    sites: [{ siteid: 'default', site: 'Default' }],
    themes: ['default'],
    hasNonThemeTemplates: false,
    supportedLocales: ['English (US)'],
    recaptchaLanguages: [],
    extendSets: [],
    pluginScriptTabs: [],
    placeholderFile: null,
    dateKeyFormat: 'MM/DD/YYYY',
    locale: 'en_US',
    localeHasDayParts: true,
    now: new Date('2026-06-30T00:00:00Z'),
    newCacheId: () => '00000000-0000-0000-0000000000000000',
  };
  const markup = renderEmailTab(m);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** `checked` flags of the radio inputs named `name`, in document order. */
function radios(markup: string, name: string): boolean[] {
  return fragmentModel(markup)
    .controls.filter((c) => c.name === name)
    .map((c) => c.checked);
}

describe('csettings.editsite Email tab', () => {
  it('renders the pane frame, labels, controls and button in legacy order', () => {
    const markup = render();
    expect(markup.startsWith('\t\t<div id="tabEmail" class="tab-pane">\n\t\t\t<div class="block block-bordered">')).toBe(true);
    expect(markup.endsWith('\t\t\t</div> \n\t\t</div> \n\t</div> ')).toBe(true);
    const model = fragmentModel(markup);
    expect(model.headings).toEqual(['Email']);
    expect(model.labels.filter((l) => l !== 'Yes' && l !== 'No')).toEqual([
      'Default "From" Email Address',
      'Mail Server IP/Host Name',
      'Mail Server SMTP Port',
      'Mail Server POP Port',
      'Mail Server Username',
      'Mail Server Password',
      'Use TLS',
      'Use SSL',
      'Use Default SMTP Server',
      'Content Pending Script',
      'Content Approval Script',
      'Content Rejection Script',
      'Content Canceled Script',
      'User Login Authorization Code Challenge Script',
      'User Login Info Request Script',
      'Mailing List Confirmation Script',
      'Account Activation Script',
      'Event Reminder Script',
    ]);
    expect(model.controls.map((c) => [c.name, c.type, c.value])).toEqual([
      ['contact', 'text', 'admin@example.com'],
      ['MailServerIP', 'text', ''],
      ['MailServerSMTPPort', 'text', '25'],
      ['MailServerPOPPort', 'text', '110'],
      ['MailServerUserName', 'text', ''],
      ['MailServerPassword', 'text', ''],
      ['mailServerTLS', 'radio', 'true'],
      ['mailServerTLS', 'radio', 'false'],
      ['mailServerSSL', 'radio', 'true'],
      ['mailServerSSL', 'radio', 'false'],
      ['useDefaultSMTPServer', 'radio', '1'],
      ['useDefaultSMTPServer', 'radio', '0'],
      ...SCRIPTS.map((name) => [name, 'textarea', '']),
    ]);
    expect(model.buttons).toEqual([{ text: 'Test Email Settings', type: 'button', hasOnclick: true }]);
    expect(markup).toContain('<p class="help-block">Available Dynamic Content: #returnURL# #contentName# #contentType#</p>');
    expect(markup).not.toContain('publicSubmissionApprovalScript');
    expect(markup).toContain('data-original-title="WARNING:">\n\t\t\t\t  \t<i class="mi-warning"></i></span></label>');
    expect(markup).toContain('value="admin&#x40;example.com" size="50" maxlength="50">');
  });

  it.each<[string, boolean, boolean]>([
    ['true', true, false],
    ['false', false, true],
    ['TRUE', true, false],
    ['yes', true, false],
    ['no', false, true],
    ['1', true, false],
    ['0', false, true],
    ['2', false, false],
    ['', false, false],
  ])('checks the TLS and SSL radios for %j as legacy eq does (Yes %s, No %s)', (value, yes, no) => {
    const markup = render({ mailServerTLS: value, mailServerSSL: value });
    expect(radios(markup, 'mailServerTLS')).toEqual([yes, no]);
    expect(radios(markup, 'mailServerSSL')).toEqual([yes, no]);
    expect(markup).toContain(`name="mailServerTLS" value="true" ${yes ? ' checked' : ''}>`);
  });

  it.each<[string | number, boolean]>([
    [1, true],
    ['1', true],
    [0, false],
    ['', false],
    ['2', false],
  ])('useDefaultSMTPServer %j selects Yes and disables the test button: %s', (value, useDefault) => {
    const markup = render({ useDefaultSMTPServer: value });
    expect(radios(markup, 'useDefaultSMTPServer')).toEqual([useDefault, !useDefault]);
    expect(markup).toContain(
      '<div class="mura-control-group">\n\t\t\t\t\n\t\t\t\t\n\n\t\t\t\t<button type="button" class="btn btn-secondary ' +
        `mura-primary" onclick="testEmail( event );" id="testEmailSettings" ${useDefault ? 'disabled' : ''}>`,
    );
  });

  it('encodes input values as html_attr and script bodies as html', () => {
    const value = `a "b" <c> & 'd'`;
    const script = '<p>Hi #firstName#,</p>\n<a href="#returnURL#">go</a> & done';
    const scripts = Object.fromEntries(SCRIPTS.map((name) => [name, `${name}: ${script}`]));
    const markup = render({
      contact: value,
      mailServerIP: value,
      mailServerSMTPPort: value,
      mailServerPOPPort: value,
      mailServerUsername: value,
      mailServerPassword: value,
      ...scripts,
    });
    expect(markup).toContain(
      'name="contact" type="text" value="a&#x20;&quot;b&quot;&#x20;&lt;c&gt;&#x20;&amp;&#x20;&#x27;d&#x27;" size="50"',
    );
    expect(markup).toContain(
      '<textarea rows="6" name="reminderScript">reminderScript&#x3a; &lt;p&gt;Hi &#x23;firstName&#x23;,' +
        '&lt;&#x2f;p&gt;&#xa;&lt;a href&#x3d;&quot;&#x23;returnURL&#x23;&quot;&gt;go&lt;&#x2f;a&gt; &amp; done</textarea>',
    );
    const controls = fragmentModel(markup).controls;
    expect(controls.filter((c) => c.tag === 'input' && c.type === 'text').map((c) => c.value)).toEqual(
      Array<string>(6).fill(value),
    );
    expect(controls.filter((c) => c.tag === 'textarea').map((c) => c.value)).toEqual(
      SCRIPTS.map((name) => `${name}: ${script}`),
    );
  });
});
