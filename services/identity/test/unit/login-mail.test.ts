import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createOutbox } from '@opt2/platform/outbox';
import { tenantIdForSite, type QueryResultRow } from '@opt2/platform/tenancy';
import { TENANT_A, assertEventMatches, createCapturingPublisher, fixedClock, registryPayloads } from '@opt2/platform/testing';
import {
  EMAIL_PATTERN,
  renderLoginMailText,
  sendLoginByEmail,
  sendLoginByUser,
  type LoginMailDeps,
  type LoginMailGlobalSettings,
  type LoginMailRequest,
  type LoginMailSettingsSource,
  type LoginMailSiteSettings,
  type LoginMailUser,
} from '../../src/domain/login-mail.js';
import { LOGIN_MAIL_REQUESTED_TOPIC, createIdentityEvents, identityPayloadValidators, type LoginMailRequestedPayload } from '../../src/events/publish.js';
import { CREDENTIAL, REDIRECT, type RedirectRow } from '../../src/repo/tables.js';
import { createMemoryIdentityRepo, createRecordingDb, type IdentitySeed, type MemoryIdentityRepo, type RecordingDb } from '../helpers/memory-repo.js';
import { POOLED_MEMBER, SITE_ADMIN_A, accountRow, actorSeed, credentialRow, personContactRow } from '../helpers/rows.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const HOST = 'www.opt2.test:8080';
const SITE_A = TENANT_A.siteId;
const POOL_TENANT = POOLED_MEMBER.tenant.tenantId;
const FAST_BCRYPT: NonNullable<LoginMailDeps['password']> = { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 };
const STORED_HASH = SITE_ADMIN_A.credential.password ?? '';
const SILENT_LOGGER = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
const CONTRACT = JSON.parse(
  await readFile(new URL('../../contracts/events/identity.login-mail.requested.v1.json', import.meta.url), 'utf8'),
) as object;

const GLOBAL_SETTINGS: LoginMailGlobalSettings = {
  title: 'OPT-2 Masa',
  adminEmail: 'admin@global.opt2.test',
  adminSSL: false,
  adminDir: '/admin',
  serverPort: ':8888',
  context: '/g',
  autoresetpasswords: false,
  sendLoginBcc: 'audit@global.opt2.test',
};

const SITE_SETTINGS: LoginMailSiteSettings = {
  site: 'Tenant A Site',
  contact: 'contact@tenant-a.opt2.test',
  sendLoginScript: '',
  editProfileURL: '/profile/',
  extranetSSL: false,
  useSSL: false,
  serverPort: ':8443',
  context: '/ctx',
  extranetPublicRegNotify: '',
};

interface SettingsOverrides {
  global?: Partial<LoginMailGlobalSettings>;
  site?: Partial<LoginMailSiteSettings>;
}

/** Mail settings answering every site id with the same site, and stemming a return id as `/index.cfm/<siteId>/<id>/`. */
function fakeSettings(overrides: SettingsOverrides = {}): LoginMailSettingsSource {
  return {
    global: () => ({ ...GLOBAL_SETTINGS, ...overrides.global }),
    site: () => ({ ...SITE_SETTINGS, ...overrides.site }),
    urlStem: (siteId, filename) => `/index.cfm/${siteId}/${filename}/`,
  };
}

const REGISTRY_ROWS: readonly QueryResultRow[] = registryPayloads().map((site) => ({
  site_id: site.siteId,
  tenant_id: tenantIdForSite(site.siteId),
  public_user_pool_id: site.publicUserPoolId,
  private_user_pool_id: site.privateUserPoolId,
  public_user_pool_tenant: tenantIdForSite(site.publicUserPoolId ?? site.siteId),
  private_user_pool_tenant: tenantIdForSite(site.privateUserPoolId ?? site.siteId),
}));

function registryAnswer(sql: string, values: readonly unknown[]): QueryResultRow[] {
  const [first] = values;
  if (sql.includes('WHERE lower(site_id) = lower($1)')) {
    return REGISTRY_ROWS.filter((row) => String(row.site_id).toLowerCase() === String(first).toLowerCase());
  }
  if (sql.includes('WHERE tenant_id = $1')) return REGISTRY_ROWS.filter((row) => row.tenant_id === first);
  return [...REGISTRY_ROWS];
}

const NAMELESS_ACCOUNT = accountRow({ username: null });
const NAMELESS_EMAIL = 'nameless@tenant-a.opt2.test';

const SITE_ADMIN_USER: LoginMailUser = {
  userId: SITE_ADMIN_A.account.userid,
  siteId: SITE_ADMIN_A.siteId,
  username: SITE_ADMIN_A.account.username ?? '',
  fname: SITE_ADMIN_A.contact.fname ?? '',
  lname: SITE_ADMIN_A.contact.lname ?? '',
  email: SITE_ADMIN_A.contact.email ?? '',
};

function resetText(firstName: string, contactName: string, returnURL: string): string {
  return [
    `Dear ${firstName},`,
    '',
    'We received a request to reset the password associated with this',
    'email address. If you made this request, please follow the',
    'instructions below.',
    '',
    '(If you did not request to have your password reset you can safely',
    'ignore this email.)',
    '',
    'Please click the link below to access your account and reset your password:',
    '',
    returnURL,
    '',
    "If clicking the link doesn't seem to work, you can copy and paste the",
    "link into your browser's address window, or retype it there. Once you",
    `have returned to ${contactName}, you can then access your account and reset`,
    'your password.',
    '',
    `Thanks for using ${contactName}`,
  ].join('\n');
}

function autoresetText(firstName: string, username: string, password: string, contactEmail: string, contactName: string): string {
  return [
    `Dear ${firstName},`,
    '',
    'You have requested your login information be sent to you.',
    '',
    `Username: ${username}`,
    `Password: ${password}`,
    '',
    `Please contact ${contactEmail} if you`,
    'have any questions or comments on this process.',
    '',
    'Thank you,',
    '',
    `The ${contactName} staff`,
  ].join('\n');
}

function siteReturnURL(request: Pick<LoginMailRequest, 'returnId' | 'userId'>): string {
  return `http://www.opt2.test:8443/ctx/index.cfm/${SITE_A}/${request.returnId}/?userID=${request.userId}`;
}

function siteEditProfileURL(request: Pick<LoginMailRequest, 'returnId' | 'userId'>): string {
  return `http://www.opt2.test:8443/ctx/profile/?&returnID=${request.returnId}&returnUserID=${request.userId}`;
}

interface MailRow {
  tenantId: string;
  topic: string;
  kind: string;
  orderingKey: string;
  envelope: EventEnvelope<LoginMailRequestedPayload>;
  stored: string;
  storedWithoutText: string;
}

let db: RecordingDb;
let repo: MemoryIdentityRepo;

function createStore(extra: Pick<IdentitySeed, 'accounts' | 'credentials' | 'personContacts' | 'redirects'> = {}): MemoryIdentityRepo {
  const base = actorSeed(SITE_ADMIN_A, POOLED_MEMBER);
  return createMemoryIdentityRepo(
    {
      ...base,
      accounts: [...(base.accounts ?? []), ...(extra.accounts ?? [])],
      credentials: [...(base.credentials ?? []), ...(extra.credentials ?? [])],
      personContacts: [...(base.personContacts ?? []), ...(extra.personContacts ?? [])],
      redirects: extra.redirects ?? [],
    },
    { clock: CLOCK },
  );
}

function deps(settings: LoginMailSettingsSource = fakeSettings()): LoginMailDeps {
  return { db, repo, events: createIdentityEvents(repo), clock: CLOCK, settings, password: FAST_BCRYPT };
}

function mailRows(): MailRow[] {
  return db
    .writes()
    .filter((write) => write.verb === 'INSERT' && write.table === 'identity.outbox')
    .map(({ values }) => {
      const [tenantId, , topic, kind, orderingKey, stored] = values;
      const envelope = assertEventMatches(undefined, CONTRACT, JSON.parse(String(stored))) as EventEnvelope<LoginMailRequestedPayload>;
      const { text: _text, ...fields } = envelope.payload;
      return {
        tenantId: String(tenantId),
        topic: String(topic),
        kind: String(kind),
        orderingKey: String(orderingKey),
        envelope,
        stored: JSON.stringify(values),
        storedWithoutText: JSON.stringify([...values.filter((_value, index) => index !== 5), { ...envelope, payload: fields }]),
      };
    });
}

function single<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

function onlyMail(): MailRow {
  return single(mailRows());
}

function redirectsOf(tenantId: string, userId: string): RedirectRow[] {
  return repo.rows(REDIRECT.table, tenantId).filter((row) => row.userid === userId);
}

function byUserIdKey(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

beforeEach(() => {
  db = createRecordingDb();
  db.respond(/FROM identity\.tenant_registry\b/, registryAnswer);
  repo = createStore();
  createOutbox({ service: 'identity', db, publisher: createCapturingPublisher(), logger: SILENT_LOGGER, clock: CLOCK, payloadValidators: identityPayloadValidators });
});

describe('login mail text', () => {
  it('mails the legacy password-reset text from the site when autoresetpasswords is off, leaving the credential alone', async () => {
    const request = await sendLoginByUser(deps(), { user: SITE_ADMIN_USER, siteId: SITE_A, httpHost: HOST });

    const { messageId, returnId } = request;
    expect(request).toEqual({ userId: SITE_ADMIN_USER.userId, tenantId: TENANT_A.tenantId, messageId, returnId });
    expect(onlyMail().envelope.payload).toEqual({
      messageId,
      userId: SITE_ADMIN_USER.userId,
      returnId,
      siteId: SITE_A,
      to: SITE_ADMIN_USER.email,
      from: 'Tenant A Site',
      subject: 'Tenant A Site Account Information',
      text: resetText('Site', 'Tenant A Site', siteReturnURL(request)),
      bcc: '',
      kind: 'send-login',
    });
    expect(repo.writes().filter((write) => write.table === CREDENTIAL.table)).toEqual([]);
  });

  it('mails the legacy Username and Password text with autoresetpasswords, storing only the bcrypt hash of the new password', async () => {
    const request = single(
      await sendLoginByEmail(deps(fakeSettings({ global: { autoresetpasswords: true } })), { email: SITE_ADMIN_USER.email, siteId: SITE_A, httpHost: HOST }),
    );

    const row = onlyMail();
    const { text } = row.envelope.payload;
    const plain = /^Password: (.*)$/m.exec(text)?.[1] ?? '';
    expect(plain).toMatch(/^[a-zA-Z0-9]{12}$/);
    expect(text).toBe(autoresetText('Site', 'site_admin_a', plain, 'contact@tenant-a.opt2.test', 'Tenant A Site'));
    const credential = single(repo.rows(CREDENTIAL.table, TENANT_A.tenantId).filter((stored) => stored.userid === request.userId));
    const newHash = credential.password ?? '';
    expect(newHash).toMatch(/^\$2a\$04\$/);
    expect(await bcrypt.compare(plain, newHash)).toBe(true);
    expect(credential.passwordcreated).toEqual(NOW);
    expect(repo.writes().filter((write) => write.table === CREDENTIAL.table)).toEqual([
      expect.objectContaining({
        tenantId: TENANT_A.tenantId,
        op: 'update',
        key: { userid: SITE_ADMIN_USER.userId },
        before: expect.objectContaining({ password: STORED_HASH }),
        after: expect.objectContaining({ password: newHash, passwordcreated: NOW }),
      }),
    ]);
    expect(row.stored).not.toContain(newHash);
    expect(row.stored).not.toContain(STORED_HASH);
    expect(row.storedWithoutText).not.toContain(plain);
  });

  it('renders a site sendLoginScript, replacing each placeholder as written and keeping all other text', async () => {
    // ACF replaceList matches case-sensitively; its sixth argument keeps the empty password as a list element.
    const sendLoginScript = 'Hi #firstName# #lastName# (#username#/#password#) ask #contactEmail# at #contactName#: #returnURL# #FIRSTNAME# #firstname# 100%^';

    const request = single(
      await sendLoginByEmail(deps(fakeSettings({ site: { sendLoginScript } })), { email: SITE_ADMIN_USER.email, siteId: SITE_A, httpHost: HOST }),
    );

    const row = onlyMail();
    expect(row.envelope.payload.text).toBe(
      `Hi Site Admin (site_admin_a/) ask contact@tenant-a.opt2.test at Tenant A Site: ${siteReturnURL(request)} #FIRSTNAME# #firstname# 100%^`,
    );
    expect(row.stored).not.toContain(STORED_HASH);
    expect(row.stored).not.toContain(SITE_ADMIN_A.plainPassword);
  });

  it.each([
    {
      label: 'from the site with a site id',
      siteId: SITE_A,
      settings: {},
      from: 'Tenant A Site',
      contactEmail: 'contact@tenant-a.opt2.test',
      returnURL: (r: LoginMailRequest) => siteReturnURL(r),
      editProfileURL: (r: LoginMailRequest) => siteEditProfileURL(r),
    },
    {
      label: 'over https for an SSL site, keeping an absolute edit-profile URL',
      siteId: SITE_A,
      settings: { site: { useSSL: true, editProfileURL: 'HTTPS://profile.opt2.test/edit?step=1' } },
      from: 'Tenant A Site',
      contactEmail: 'contact@tenant-a.opt2.test',
      returnURL: (r: LoginMailRequest) => `https://www.opt2.test:8443/ctx/index.cfm/${SITE_A}/${r.returnId}/?userID=${r.userId}`,
      editProfileURL: (r: LoginMailRequest) => `HTTPS://profile.opt2.test/edit?step=1&returnID=${r.returnId}&returnUserID=${r.userId}`,
    },
    {
      label: 'from the global title and admin email without a site id, through the admin edit-profile action',
      siteId: '',
      settings: {},
      from: 'OPT-2 Masa',
      contactEmail: 'admin@global.opt2.test',
      returnURL: (r: LoginMailRequest) => `http://www.opt2.test:8888/g/index.cfm/default/${r.returnId}/?userID=${r.userId}`,
      editProfileURL: (r: LoginMailRequest) =>
        `http://www.opt2.test:8888/g/admin/?muraAction=cEditProfile.edit&siteID=${SITE_A}&returnID=${r.returnId}&returnUserID=${r.userId}`,
    },
    {
      label: 'over https with adminSSL and no site id',
      siteId: '',
      settings: { global: { adminSSL: true, adminDir: '/manage' } },
      from: 'OPT-2 Masa',
      contactEmail: 'admin@global.opt2.test',
      returnURL: (r: LoginMailRequest) => `https://www.opt2.test:8888/g/index.cfm/default/${r.returnId}/?userID=${r.userId}`,
      editProfileURL: (r: LoginMailRequest) =>
        `https://www.opt2.test:8888/g/manage/?muraAction=cEditProfile.edit&siteID=${SITE_A}&returnID=${r.returnId}&returnUserID=${r.userId}`,
    },
  ])('addresses the mail and builds its links $label', async (row) => {
    const message = '#contactEmail#|#contactName#|#returnURL#';

    const request = await sendLoginByUser(deps(fakeSettings(row.settings)), { user: SITE_ADMIN_USER, siteId: row.siteId, httpHost: HOST, message });

    expect(onlyMail().envelope.payload).toMatchObject({
      siteId: row.siteId,
      from: row.from,
      subject: `${row.from} Account Information`,
      text: renderLoginMailText({
        sendLoginScript: message,
        autoresetpasswords: false,
        firstName: 'Site',
        lastName: 'Admin',
        username: 'site_admin_a',
        password: '',
        contactEmail: row.contactEmail,
        contactName: row.from,
        returnURL: row.returnURL(request),
      }),
    });
    expect(redirectsOf(TENANT_A.tenantId, SITE_ADMIN_USER.userId).map((redirect) => redirect.url)).toEqual([row.editProfileURL(request)]);
  });
});

describe('login mail redirects', () => {
  it("keeps one redirect per user: each send deletes the user's earlier rows, leaving other users' rows", async () => {
    const redirect = (userid: string, url: string): RedirectRow => ({ tenant_id: TENANT_A.tenantId, redirectid: cfUuid(), url, created: NOW, userid, siteid: SITE_A });
    const stale = redirect(SITE_ADMIN_USER.userId, 'http://www.opt2.test/stale');
    const other = redirect(cfUuid(), 'http://www.opt2.test/other');
    repo = createStore({ redirects: [stale, other] });

    const first = await sendLoginByUser(deps(), { user: SITE_ADMIN_USER, siteId: SITE_A, httpHost: HOST });
    const second = await sendLoginByUser(deps(), { user: SITE_ADMIN_USER, siteId: SITE_A, httpHost: HOST });

    expect(second.returnId).not.toBe(first.returnId);
    expect(redirectsOf(TENANT_A.tenantId, SITE_ADMIN_USER.userId)).toEqual([
      { tenant_id: TENANT_A.tenantId, redirectid: second.returnId, url: siteEditProfileURL(second), created: NOW, userid: SITE_ADMIN_USER.userId, siteid: SITE_A },
    ]);
    expect(redirectsOf(TENANT_A.tenantId, other.userid ?? '')).toEqual([other]);
    expect(repo.writes().filter((write) => write.table === REDIRECT.table).map((write) => [write.op, write.key.redirectid])).toEqual([
      ['delete', stale.redirectid],
      ['insert', first.returnId],
      ['delete', first.returnId],
      ['insert', second.returnId],
    ]);
    expect(mailRows().map((row) => row.envelope.payload.returnId)).toEqual([first.returnId, second.returnId]);
  });
});

describe('login mail outbox request', () => {
  it.each([
    ['sendLoginByEmail', 'forgot-password', () => sendLoginByEmail(deps(), { email: SITE_ADMIN_USER.email, siteId: SITE_A, httpHost: HOST })],
    ['sendLoginByUser', 'send-login', async () => [await sendLoginByUser(deps(), { user: SITE_ADMIN_USER, siteId: SITE_A, httpHost: HOST })]],
  ] as const)('%s writes one %s process row on the login-mail topic, valid against its contract and holding no password', async (_entry, kind, send) => {
    const request = single(await send());

    const row = onlyMail();
    expect(row).toMatchObject({ tenantId: TENANT_A.tenantId, topic: LOGIN_MAIL_REQUESTED_TOPIC, kind: 'process', orderingKey: SITE_ADMIN_USER.userId });
    expect(row.envelope).toMatchObject({
      aggregateType: 'user',
      aggregateId: SITE_ADMIN_USER.userId,
      tenantId: TENANT_A.tenantId,
      payload: { kind, userId: SITE_ADMIN_USER.userId, messageId: request.messageId, returnId: request.returnId },
    });
    expect(row.stored).not.toContain(STORED_HASH);
    expect(row.stored).not.toContain(SITE_ADMIN_A.plainPassword);
  });
});

describe('sendLoginByEmail lookup', () => {
  it('finds the account through its person_contact email whatever the casing, and mails the address as typed', async () => {
    const typed = `  ${SITE_ADMIN_USER.email.toUpperCase()} `;

    const requests = await sendLoginByEmail(deps(), { email: typed, siteId: SITE_A, httpHost: HOST });

    const request = single(requests);
    expect(request).toMatchObject({ userId: SITE_ADMIN_USER.userId, tenantId: TENANT_A.tenantId });
    expect(onlyMail().envelope.payload).toMatchObject({ to: typed, from: 'Tenant A Site', bcc: 'audit@global.opt2.test', kind: 'forgot-password' });
    expect(redirectsOf(TENANT_A.tenantId, SITE_ADMIN_USER.userId).map((redirect) => redirect.redirectid)).toEqual([request.returnId]);
  });

  it.each([
    ["a public member through the site's public user pool, in the pool's tenant", POOLED_MEMBER.contact.email ?? '', SITE_A, [[POOLED_MEMBER.account.userid, POOL_TENANT]]],
    ['a private-pool user without a site id, in its own tenant', SITE_ADMIN_USER.email, '', [[SITE_ADMIN_USER.userId, TENANT_A.tenantId]]],
    ['no public member without a site id, which searches isPublic=0 only', POOLED_MEMBER.contact.email ?? '', '', []],
  ] as const)('mails %s', async (_case, email, siteId, expected) => {
    const requests = await sendLoginByEmail(deps(), { email, siteId, httpHost: HOST });

    expect(requests.map((request) => [request.userId, request.tenantId])).toEqual(expected);
    expect(mailRows().map((row) => [row.envelope.payload.userId, row.tenantId])).toEqual(expected);
  });

  it.each([
    ['an address failing EMAIL_PATTERN', SITE_ADMIN_USER.email.replace('@', '.'), false, {}],
    ['an address no person_contact row holds', 'nobody@tenant-a.opt2.test', true, {}],
    [
      'an account without a username, which legacy skips',
      NAMELESS_EMAIL,
      true,
      { accounts: [NAMELESS_ACCOUNT], personContacts: [personContactRow({ user_id: NAMELESS_ACCOUNT.userid, email: NAMELESS_EMAIL })] },
    ],
  ] as const)('answers no request and writes nothing for %s', async (_case, email, matchesPattern, seed) => {
    repo = createStore(seed);

    expect(await sendLoginByEmail(deps(), { email, siteId: SITE_A, httpHost: HOST })).toEqual([]);

    expect(EMAIL_PATTERN.test(email)).toBe(matchesPattern);
    expect(repo.writes()).toEqual([]);
    expect(db.writes()).toEqual([]);
  });

  it('mails every account sharing the address, each with its own redirect and request, in user id order', async () => {
    const shared = 'shared@tenant-a.opt2.test';
    const accounts = [accountRow(), accountRow(), accountRow()];
    repo = createStore({
      accounts,
      credentials: accounts.map((account) => credentialRow({ userid: account.userid })),
      personContacts: accounts.map((account) => personContactRow({ user_id: account.userid, email: shared })),
    });
    const ordered = accounts.map((account) => account.userid).sort(byUserIdKey);

    const requests = await sendLoginByEmail(deps(), { email: shared, siteId: SITE_A, httpHost: HOST });

    expect(requests.map((request) => request.userId)).toEqual(ordered);
    expect(mailRows().map((row) => [row.envelope.payload.userId, row.envelope.payload.to])).toEqual(ordered.map((userId) => [userId, shared]));
    for (const request of requests) {
      expect(redirectsOf(TENANT_A.tenantId, request.userId).map((redirect) => redirect.url)).toEqual([siteEditProfileURL(request)]);
    }
  });
});
