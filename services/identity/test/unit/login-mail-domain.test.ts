/** Forgot-password and send-login mail against legacy userUtility's templates and a throwaway `identity` schema: texts, URLs, redirects, outbox requests and lookup by email. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTopicSchema, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { tenantIdForSite, withMetadata, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { assertEventMatches, createCapturingPublisher, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  OperationBlockedError,
  USER_CLOSED_WAIT_MS,
  abortAccountOperation,
  commitAccountOperation,
  finishAccountOperation,
  prepareAccountOperation,
  type AccountChange,
  type AccountOperationDeps,
} from '../../src/domain/account-operations.js';
import {
  DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS,
  EMAIL_PATTERN,
  legacyUrlStem,
  renderLoginMailText,
  sendLoginByEmail,
  sendLoginByUser,
  type LoginMailDeps,
  type LoginMailGlobalSettings,
  type LoginMailSettingsSource,
  type LoginMailSiteSettings,
  type LoginMailTextValues,
  type LoginMailUser,
  type SendLoginByUserInput,
  type UrlStemOptions,
} from '../../src/domain/login-mail.js';
import { createIdentityEvents, identityPayloadValidators, LOGIN_MAIL_REQUESTED_TOPIC, type LoginMailRequestedPayload } from '../../src/events/publish.js';
import { hashNewPassword, verifyLegacyPassword, type LegacyPasswordConfig } from '../../src/legacy/hash.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type RedirectRow } from '../../src/repo/tables.js';

const LEGACY_ROOT = new URL('../../../../', import.meta.url);
const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const PASSWORD_CREATED = new Date(2026, 5, 1, 9, 15, 0, 0);
const SITE_A = 'tenant-a';
const SITE_B = 'tenant-b';
const UMBRELLA = 'umbrella';
const DEFAULT = 'default';
const REGISTERED_SITES = [DEFAULT, SITE_A, SITE_B, UMBRELLA] as const;
/** The administrator whose token a roster update of another user carries. */
const ADMIN_ACTOR = 'ADDE0000-0000-0000-0000000000000001';
const HOST = 'www.example.test:8080';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const ALL_PLACEHOLDERS = '#firstName#|#lastName#|#username#|#password#|#contactEmail#|#contactName#|#returnURL#';
const FAST_PASSWORD: LegacyPasswordConfig = { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 };
const STEM_OPTIONS: UrlStemOptions = { siteIdInUrls: true, indexFileInUrls: true, hashUrls: false };
const LOGIN_MAIL_SCHEMA = readTopicSchema(new URL(`../../contracts/events/${LOGIN_MAIL_REQUESTED_TOPIC}.json`, import.meta.url));

/** The value of `key` in a properties-style legacy file. */
function legacyProperty(path: string, key: string): string {
  const line = readFileSync(new URL(path, LEGACY_ROOT), 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}=`));
  if (line === undefined) throw new Error(`${path} has no ${key}`);
  return line.slice(key.length + 1);
}

/** The three `<cfoutput>` bodies of userUtility.sendLogin, in source order. */
function legacySendLoginTemplates(): { script: string; autoreset: string; reset: string } {
  const source = readFileSync(new URL('core/mura/user/userUtility.cfc', LEGACY_ROOT), 'utf8');
  const start = source.indexOf('<cffunction name="sendLogin"');
  const body = source.slice(start, source.indexOf('</cffunction>', start));
  const outputs = [...body.matchAll(/<cfoutput>([\s\S]*?)<\/cfoutput>/g)].map((match) => match[1] ?? '');
  if (start < 0 || outputs.length !== 3) throw new Error(`sendLogin has ${outputs.length} cfoutput blocks`);
  const [script = '', autoreset = '', reset = ''] = outputs;
  return { script, autoreset, reset };
}

const LEGACY_TEMPLATES = legacySendLoginTemplates();

/** CFML `#name#` evaluation of a template over sendLogin's local variables, whose names are case-insensitive. */
function renderLegacy(template: string, v: LoginMailTextValues): string {
  const variables = new Map<string, string>([
    ['sendloginscript', v.sendLoginScript],
    ['firstname', v.firstName],
    ['lastname', v.lastName],
    ['username', v.username],
    ['password', v.password],
    ['contactemail', v.contactEmail],
    ['contactname', v.contactName],
    ['returnurl', v.returnURL],
  ]);
  return template.replace(/#(\w+)#/g, (_match, name: string) => {
    const value = variables.get(name.toLowerCase());
    if (value === undefined) throw new Error(`sendLogin template names unknown variable ${name}`);
    return value;
  });
}

const TEXT_VALUES: LoginMailTextValues = {
  sendLoginScript: '',
  autoresetpasswords: false,
  firstName: 'Fiona',
  lastName: 'Lund',
  username: 'fiona',
  password: 'Pw1',
  contactEmail: 'contact@example.test',
  contactName: 'Example Site',
  returnURL: 'http://www.example.test/index.cfm/default/R/?userID=U',
};

describe('renderLoginMailText', () => {
  it('keeps the mail text of a custom script to the script itself', () => {
    expect(LEGACY_TEMPLATES.script).toBe('#sendLoginScript#');
  });

  it.each([
    ['the password-reset link without autoresetpasswords', false, LEGACY_TEMPLATES.reset],
    ['the Username and Password lines with autoresetpasswords', true, LEGACY_TEMPLATES.autoreset],
  ])('renders %s exactly as the legacy template', (_case, autoresetpasswords, template) => {
    const values = { ...TEXT_VALUES, autoresetpasswords };

    expect(renderLoginMailText(values)).toBe(renderLegacy(template, values));
  });

  it.each([
    ['every placeholder in list order', ALL_PLACEHOLDERS, {}, 'Fiona|Lund|fiona|Pw1|contact@example.test|Example Site|http://www.example.test/index.cfm/default/R/?userID=U'],
    ['placeholders case-sensitively, leaving other casings as typed', 'Hi #firstName# #FIRSTNAME# #firstname#', {}, 'Hi Fiona #FIRSTNAME# #firstname#'],
    ['a value holding ^, which shifts the later values', '#firstName#|#lastName#|#username#|#password#', { firstName: 'A^x' }, 'A|x|Lund|fiona'],
    ['a value naming a later placeholder, which is replaced in turn', '#firstName#|#lastName#', { firstName: '#lastName#' }, 'Lund|Lund'],
    ['a value naming an earlier placeholder, which stays', '#firstName#|#lastName#', { lastName: '#firstName#' }, 'Fiona|#firstName#'],
    ['empty values', '#firstName#|#lastName#|#username#', { firstName: '', lastName: '' }, '||fiona'],
    ['the script in preference to the autoreset text', 'Login: #username# / #password#', { autoresetpasswords: true }, 'Login: fiona / Pw1'],
  ] as const)('replaces %s as ACF replaceList does', (_case, sendLoginScript, overrides, expected) => {
    expect(renderLoginMailText({ ...TEXT_VALUES, ...overrides, sendLoginScript })).toBe(expected);
  });
});

describe('legacyUrlStem', () => {
  it.each([
    ['abc', STEM_OPTIONS, '/index.cfm/tenant-a/abc/'],
    ['/abc/', STEM_OPTIONS, '/index.cfm/tenant-a/abc/'],
    ['abc', { ...STEM_OPTIONS, indexFileInUrls: false }, '/tenant-a/abc/'],
    ['abc', { ...STEM_OPTIONS, hashUrls: true }, '/index.cfm/tenant-a/#/abc'],
    ['abc', { ...STEM_OPTIONS, siteIdInUrls: false }, '/index.cfm/abc/'],
    ['abc', { siteIdInUrls: false, indexFileInUrls: false, hashUrls: true }, '/#/abc'],
    ['', { ...STEM_OPTIONS, siteIdInUrls: false }, '/'],
    ['', STEM_OPTIONS, '/index.cfm/tenant-a/'],
    ['', { ...STEM_OPTIONS, indexFileInUrls: false }, '/tenant-a/'],
    ['abc', { ...STEM_OPTIONS, legacyIndexFileLocation: true, siteAssetPath: '/sites' }, '/sites/tenant-a/index.cfm/abc/'],
    ['', { ...STEM_OPTIONS, legacyIndexFileLocation: true, siteAssetPath: '/sites' }, '/sites/tenant-a/'],
    ['abc', { ...STEM_OPTIONS, legacyIndexFileLocation: true }, '/tenant-a/index.cfm/abc/'],
  ] as const)('stems %j with %j as contentServer.getURLStem does', (filename, opts, expected) => {
    expect(legacyUrlStem(SITE_A, filename, opts)).toBe(expected);
  });
});

describe('login mail settings', () => {
  it.each([
    ['fiona@example.test', true],
    ['Fiona.Lund@Example.TEST', true],
    ['fiona@example.test> trailing text', true],
    ['fiona@example.c', false],
    ["o'hara@example.test", false],
    ['fiona.example.test', false],
    ['fiona@@example.test', false],
  ] as const)('matches %j against the forgot-password address check: %s', (address, matches) => {
    expect(EMAIL_PATTERN.test(address)).toBe(matches);
  });

  it('defaults the global mail settings to the Masa settings template and configBean', () => {
    const template = 'core/templates/settings.template.cfm';
    expect(DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS).toEqual({
      title: legacyProperty(template, 'title'),
      adminEmail: legacyProperty(template, 'adminemail'),
      adminSSL: legacyProperty(template, 'adminssl') === 'true',
      adminDir: legacyProperty(template, 'admindir'),
      serverPort: '',
      context: legacyProperty(template, 'context'),
      autoresetpasswords: legacyProperty(template, 'autoresetpasswords') === 'true',
      sendLoginBcc: '',
    });
    expect(Object.isFrozen(DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS)).toBe(true);
  });
});

/** Site mail settings the fake `getSite` answers, by stored site id. */
const SITE_SETTINGS: Readonly<Record<string, LoginMailSiteSettings>> = {
  [DEFAULT]: {
    site: 'Default Site',
    contact: 'contact@default.example.test',
    sendLoginScript: '',
    editProfileURL: '/edit-profile/',
    extranetSSL: false,
    useSSL: false,
    serverPort: ':8444',
    context: '/dctx',
    extranetPublicRegNotify: 'notify@default.example.test',
  },
  [SITE_A]: {
    site: 'Tenant A Site',
    contact: 'contact@tenant-a.example.test',
    sendLoginScript: '',
    editProfileURL: '/profile/',
    extranetSSL: false,
    useSSL: false,
    serverPort: ':8443',
    context: '/ctx',
    extranetPublicRegNotify: 'notify@tenant-a.example.test',
  },
};

const GLOBAL_SETTINGS: LoginMailGlobalSettings = {
  ...DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS,
  title: 'Global Title',
  adminEmail: 'admin@example.test',
  serverPort: ':8081',
  context: '/g',
};

/** The stored id `getSite` resolves `siteId` to: a known site case-insensitively, else the default site. */
function storedSiteId(siteId: string): string {
  const key = siteId.toLowerCase();
  return key in SITE_SETTINGS ? key : DEFAULT;
}

function settingsSource(global: Partial<LoginMailGlobalSettings> = {}, sites: Readonly<Record<string, Partial<LoginMailSiteSettings>>> = {}): LoginMailSettingsSource {
  return {
    global: () => ({ ...GLOBAL_SETTINGS, ...global }),
    site: (siteId) => {
      const stored = storedSiteId(siteId);
      const base = SITE_SETTINGS[stored];
      if (base === undefined) throw new Error(`no settings for ${stored}`);
      return { ...base, ...sites[stored] };
    },
    urlStem: (siteId, filename) => legacyUrlStem(storedSiteId(siteId), filename, STEM_OPTIONS),
  };
}

const available = await pgAvailable();

describe.skipIf(!available)('login mail against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let seededHash: string;
  let seq = 0;
  const clock = fixedClock(NOW);
  const capture = createCapturingPublisher();
  const noSleep = (): Promise<void> => Promise.resolve();

  function id(prefix: string): string {
    seq += 1;
    return `${prefix}0000000-0000-0000-${String(seq).padStart(16, '0')}`;
  }

  function deps(settings: LoginMailSettingsSource = settingsSource(), overrides: Partial<LoginMailDeps> = {}): LoginMailDeps {
    return { db: handle.app, repo, events: createIdentityEvents(repo), clock, settings, password: FAST_PASSWORD, sleep: noSleep, ...overrides };
  }

  function operationDeps(): AccountOperationDeps {
    return { db: handle.app, repo, events: createIdentityEvents(repo), clock, settings: { ...DEFAULT_ACCOUNT_SETTINGS, password: FAST_PASSWORD }, sleep: noSleep };
  }

  function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(site), fn);
  }

  async function registerSite(site: string, privatePool: string, publicPool: string): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), NOW],
      ),
    );
  }

  interface SeedOptions {
    site?: string;
    email?: string;
    username?: string;
    ispublic?: number;
    inactive?: number;
  }

  async function seedUser(opts: SeedOptions = {}): Promise<LoginMailUser> {
    const userId = id('A');
    const siteId = opts.site ?? SITE_A;
    const username = opts.username ?? `user-${seq}`;
    const user: LoginMailUser = { userId, siteId, username, fname: `Fiona${seq}`, lname: 'Lund', email: opts.email ?? `user-${seq}@example.test` };
    await gated(siteId, async (tx) => {
      await repo.insertAccount(tx, {
        userid: userId, username, type: 2, s2: 0, perm: 0, inactive: opts.inactive ?? 0, ispublic: opts.ispublic ?? 0, siteid: siteId, remoteid: '', tablist: '',
      });
      await repo.writeCredential(tx, userId, { password: seededHash, passwordcreated: PASSWORD_CREATED });
      await repo.upsertPersonContact(tx, {
        user_id: userId, site_id: siteId, email: user.email, fname: user.fname, lname: user.lname, company: null, subtype: null, aggregate_version: 1,
      });
    });
    return user;
  }

  interface MailRow {
    topic: string;
    kind: string;
    ordering_key: string;
    envelope: EventEnvelope<LoginMailRequestedPayload>;
    raw: string;
  }

  async function mailRows(user: Pick<LoginMailUser, 'userId' | 'siteId'>): Promise<MailRow[]> {
    return withTenant(handle.app, tenantIdForSite(user.siteId), async (tx) => {
      const { rows } = await tx.query<MailRow>(
        `SELECT topic, kind, ordering_key, envelope, row_to_json(o)::text AS raw FROM ${handle.schema}.outbox o` +
          " WHERE topic = $1 AND envelope->>'aggregateId' = $2 ORDER BY seq",
        [LOGIN_MAIL_REQUESTED_TOPIC, user.userId],
      );
      return rows;
    });
  }

  /** The single login-mail outbox row of `user`, checked against the platform envelope and the topic's payload contract. */
  async function onlyMail(user: Pick<LoginMailUser, 'userId' | 'siteId'>): Promise<MailRow> {
    const rows = await mailRows(user);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error(`no login mail for ${user.userId}`);
    assertEventMatches(undefined, LOGIN_MAIL_SCHEMA, row.envelope);
    expect(row).toMatchObject({ topic: LOGIN_MAIL_REQUESTED_TOPIC, kind: 'process', ordering_key: user.userId });
    expect(row.envelope).toMatchObject({ aggregateType: 'user', aggregateId: user.userId, tenantId: tenantIdForSite(user.siteId) });
    expect(row.raw).not.toContain(seededHash);
    expect(row.raw).not.toContain('$2a$');
    return row;
  }

  async function redirectsOf(user: Pick<LoginMailUser, 'userId' | 'siteId'>): Promise<Array<Omit<RedirectRow, 'tenant_id'>>> {
    return withTenant(handle.app, tenantIdForSite(user.siteId), async (tx) => {
      const { rows } = await tx.query<Omit<RedirectRow, 'tenant_id'>>(
        `SELECT redirectid, url, created, userid, siteid FROM ${handle.schema}.redirect WHERE userid = $1 ORDER BY redirectid`,
        [user.userId],
      );
      return rows;
    });
  }

  /** Outbox and redirect row counts over every registered tenant. */
  async function writtenRows(): Promise<{ outbox: number; redirects: number }> {
    let outbox = 0;
    let redirects = 0;
    for (const site of REGISTERED_SITES) {
      await withTenant(handle.app, tenantIdForSite(site), async (tx) => {
        const { rows } = await tx.query<{ outbox: string; redirects: string }>(
          `SELECT (SELECT count(*) FROM ${handle.schema}.outbox) AS outbox, (SELECT count(*) FROM ${handle.schema}.redirect) AS redirects`,
        );
        outbox += Number(rows[0]?.outbox ?? 0);
        redirects += Number(rows[0]?.redirects ?? 0);
      });
    }
    return { outbox, redirects };
  }

  function byUserInput(user: LoginMailUser, overrides: Partial<SendLoginByUserInput> = {}): SendLoginByUserInput {
    return { user, siteId: user.siteId, httpHost: HOST, ...overrides };
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'identity', db: handle.app, publisher: capture, logger, clock, payloadValidators: identityPayloadValidators });
    await registerSite(DEFAULT, DEFAULT, DEFAULT);
    await registerSite(SITE_A, SITE_A, UMBRELLA);
    await registerSite(SITE_B, SITE_B, SITE_B);
    await registerSite(UMBRELLA, UMBRELLA, UMBRELLA);
    const hash = await hashNewPassword('Seeded-Secret1', FAST_PASSWORD);
    if (hash === null) throw new Error('no seeded hash');
    seededHash = hash;
  });

  afterAll(async () => {
    await handle?.drop();
  });

  describe('sendLoginByUser', () => {
    it('requests the password-reset mail in the site tenant with its redirect, never carrying the stored password', async () => {
      const user = await seedUser();

      const request = await sendLoginByUser(deps(), byUserInput(user));

      const { messageId, returnId } = request;
      expect(request).toEqual({ userId: user.userId, tenantId: tenantIdForSite(SITE_A), messageId, returnId });
      expect(messageId).toMatch(CF_UUID);
      expect(returnId).toMatch(CF_UUID);
      expect(messageId).not.toBe(returnId);
      const returnURL = `http://www.example.test:8443/ctx/index.cfm/tenant-a/${returnId}/?userID=${user.userId}`;
      const row = await onlyMail(user);
      expect(row.envelope.payload).toEqual({
        messageId,
        userId: user.userId,
        returnId,
        siteId: SITE_A,
        to: user.email,
        from: 'Tenant A Site',
        subject: 'Tenant A Site Account Information',
        text: renderLegacy(LEGACY_TEMPLATES.reset, { ...TEXT_VALUES, firstName: user.fname, contactName: 'Tenant A Site', returnURL }),
        bcc: '',
        kind: 'send-login',
      });
      expect(await redirectsOf(user)).toEqual([
        {
          redirectid: returnId,
          url: `http://www.example.test:8443/ctx/profile/?&returnID=${returnId}&returnUserID=${user.userId}`,
          created: NOW,
          userid: user.userId,
          siteid: SITE_A,
        },
      ]);
      expect(await gated(SITE_A, (tx) => repo.readCredential(tx, user.userId))).toMatchObject({ password: seededHash, passwordcreated: PASSWORD_CREATED });
    });

    it.each([
      {
        label: 'a site over http',
        siteId: SITE_A, host: HOST, global: {}, site: {}, subject: undefined,
        from: 'Tenant A Site', subjectSent: 'Tenant A Site Account Information', contact: 'contact@tenant-a.example.test',
        returnURL: (r: string, u: string) => `http://www.example.test:8443/ctx/index.cfm/tenant-a/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) => `http://www.example.test:8443/ctx/profile/?&returnID=${r}&returnUserID=${u}`,
      },
      {
        label: 'a site with useSSL and an absolute edit-profile URL',
        siteId: SITE_A, host: HOST, global: {}, site: { useSSL: true, editProfileURL: 'HTTPS://profile.example.test/edit?step=1' }, subject: 'Your login',
        from: 'Tenant A Site', subjectSent: 'Your login', contact: 'contact@tenant-a.example.test',
        returnURL: (r: string, u: string) => `https://www.example.test:8443/ctx/index.cfm/tenant-a/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) => `HTTPS://profile.example.test/edit?step=1&returnID=${r}&returnUserID=${u}`,
      },
      {
        label: 'a site with extranetSSL',
        siteId: SITE_A, host: HOST, global: {}, site: { extranetSSL: true }, subject: '',
        from: 'Tenant A Site', subjectSent: 'Tenant A Site Account Information', contact: 'contact@tenant-a.example.test',
        returnURL: (r: string, u: string) => `https://www.example.test:8443/ctx/index.cfm/tenant-a/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) => `https://www.example.test:8443/ctx/profile/?&returnID=${r}&returnUserID=${u}`,
      },
      {
        label: 'an unknown site, which getSite answers with the default site',
        siteId: 'nowhere', host: HOST, global: {}, site: {}, subject: undefined,
        from: 'Default Site', subjectSent: 'Default Site Account Information', contact: 'contact@default.example.test',
        returnURL: (r: string, u: string) => `http://www.example.test:8444/dctx/index.cfm/default/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) => `http://www.example.test:8444/dctx/edit-profile/?&returnID=${r}&returnUserID=${u}`,
      },
      {
        label: 'no site, with the global settings and the default site stem',
        siteId: '', host: HOST, global: {}, site: {}, subject: undefined,
        from: 'Global Title', subjectSent: 'Global Title Account Information', contact: 'admin@example.test',
        returnURL: (r: string, u: string) => `http://www.example.test:8081/g/index.cfm/default/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) =>
          `http://www.example.test:8081/g/admin/?muraAction=cEditProfile.edit&siteID=tenant-a&returnID=${r}&returnUserID=${u}`,
      },
      {
        label: 'no site with adminSSL',
        siteId: '', host: HOST, global: { adminSSL: true, adminDir: '/manage' }, site: {}, subject: undefined,
        from: 'Global Title', subjectSent: 'Global Title Account Information', contact: 'admin@example.test',
        returnURL: (r: string, u: string) => `https://www.example.test:8081/g/index.cfm/default/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) =>
          `https://www.example.test:8081/g/manage/?muraAction=cEditProfile.edit&siteID=tenant-a&returnID=${r}&returnUserID=${u}`,
      },
      {
        label: 'a scheme-relative base, which sanitizeHref makes relative',
        siteId: SITE_A, host: '', global: {}, site: { serverPort: '', context: '//evil.test' }, subject: undefined,
        from: 'Tenant A Site', subjectSent: 'Tenant A Site Account Information', contact: 'contact@tenant-a.example.test',
        returnURL: (r: string, u: string) => `http:///evil.test/index.cfm/tenant-a/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) => `http:///evil.test/profile/?&returnID=${r}&returnUserID=${u}`,
      },
      {
        label: 'a bare // base',
        siteId: SITE_A, host: '', global: {}, site: { serverPort: '', context: '//' }, subject: undefined,
        from: 'Tenant A Site', subjectSent: 'Tenant A Site Account Information', contact: 'contact@tenant-a.example.test',
        returnURL: (r: string, u: string) => `http:////index.cfm/tenant-a/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) => `http:////profile/?&returnID=${r}&returnUserID=${u}`,
      },
      {
        label: 'no Host header and an empty base',
        siteId: SITE_A, host: '', global: {}, site: { serverPort: '', context: '' }, subject: undefined,
        from: 'Tenant A Site', subjectSent: 'Tenant A Site Account Information', contact: 'contact@tenant-a.example.test',
        returnURL: (r: string, u: string) => `http:///index.cfm/tenant-a/${r}/?userID=${u}`,
        editProfileURL: (r: string, u: string) => `http:///profile/?&returnID=${r}&returnUserID=${u}`,
      },
    ])('builds the sender, contact, return and edit-profile URLs for $label', async (row) => {
      const user = await seedUser();
      const settings = settingsSource(row.global, { [storedSiteId(row.siteId)]: row.site });

      const { returnId } = await sendLoginByUser(
        deps(settings),
        byUserInput(user, { siteId: row.siteId, httpHost: row.host, subject: row.subject, message: ALL_PLACEHOLDERS }),
      );

      const returnURL = row.returnURL(returnId, user.userId);
      const { payload } = (await onlyMail(user)).envelope;
      expect(payload).toMatchObject({ siteId: row.siteId, from: row.from, subject: row.subjectSent });
      expect(payload.text).toBe(`${user.fname}|${user.lname}|${user.username}||${row.contact}|${row.from}|${returnURL}`);
      expect((await redirectsOf(user)).map((redirect) => redirect.url)).toEqual([row.editProfileURL(returnId, user.userId)]);
    });

    it.each([
      ['the request message over the site script', 'Message for #username#', 'Site script for #username#', (u: LoginMailUser) => `Message for ${u.username}`],
      ['the site script without a request message', '', 'Site script for #username# #password#', (u: LoginMailUser) => `Site script for ${u.username} Typed-Pass1`],
      ['the request message without a site script', '#firstName# #lastName#', '', (u: LoginMailUser) => `${u.fname} ${u.lname}`],
    ])('renders %s', async (_case, message, sendLoginScript, expected) => {
      const user = await seedUser();

      await sendLoginByUser(deps(settingsSource({}, { [SITE_A]: { sendLoginScript } })), byUserInput({ ...user, password: 'Typed-Pass1' }, { message }));

      expect((await onlyMail(user)).envelope.payload.text).toBe(expected(user));
    });

    it.each([
      ['the site notify list for a public registration', SITE_A, true, {}, 'notify@tenant-a.example.test'],
      ["the default site's notify list without a site", '', true, {}, 'notify@default.example.test'],
      ['nothing when the site notify list is empty', SITE_A, true, { [SITE_A]: { extranetPublicRegNotify: '' } }, ''],
      ['nothing outside a public registration', SITE_A, false, {}, ''],
    ] as const)('copies %s into bcc', async (_case, siteId, isPublicReg, sites, bcc) => {
      const user = await seedUser();

      await sendLoginByUser(deps(settingsSource({}, sites)), byUserInput(user, { siteId, isPublicReg }));

      expect((await onlyMail(user)).envelope.payload.bcc).toBe(bcc);
    });

    it('stores a new random password with autoresetpasswords and mails it in the legacy text, without its hash', async () => {
      const user = await seedUser();

      const { returnId } = await sendLoginByUser(deps(settingsSource({ autoresetpasswords: true })), byUserInput({ ...user, password: 'ignored-plain' }));

      const credential = await gated(SITE_A, (tx) => repo.readCredential(tx, user.userId));
      expect(credential?.passwordcreated).toEqual(NOW);
      const row = await onlyMail(user);
      const plain = /^Password: (.*)$/m.exec(row.envelope.payload.text)?.[1] ?? '';
      expect(plain).toMatch(/^[a-zA-Z0-9]{12}$/);
      expect(await verifyLegacyPassword(plain, credential?.password, FAST_PASSWORD)).toEqual({ match: true, needsUpgrade: false });
      expect(row.raw).not.toContain(credential?.password ?? 'missing');
      expect(row.envelope.payload.text).toBe(
        renderLegacy(LEGACY_TEMPLATES.autoreset, {
          ...TEXT_VALUES,
          firstName: user.fname,
          username: user.username,
          password: plain,
          contactEmail: 'contact@tenant-a.example.test',
          contactName: 'Tenant A Site',
          returnURL: `http://www.example.test:8443/ctx/index.cfm/tenant-a/${returnId}/?userID=${user.userId}`,
        }),
      );
    });

    it("keeps one redirect per user, deleting the user's earlier ones and no one else's", async () => {
      const user = await seedUser();
      const other = await seedUser();
      const otherRedirect = await gated(SITE_A, async (tx) => {
        await repo.insertRedirect(tx, { userid: user.userId, siteid: SITE_A, url: 'http://www.example.test/old-1' });
        await repo.insertRedirect(tx, { userid: user.userId, siteid: SITE_A, url: 'http://www.example.test/old-2' });
        return repo.insertRedirect(tx, { userid: other.userId, siteid: SITE_A, url: 'http://www.example.test/other' });
      });

      const first = await sendLoginByUser(deps(), byUserInput(user));
      expect((await redirectsOf(user)).map((redirect) => redirect.redirectid)).toEqual([first.returnId]);
      const second = await sendLoginByUser(deps(), byUserInput(user));

      expect(second.returnId).not.toBe(first.returnId);
      expect((await redirectsOf(user)).map((redirect) => redirect.redirectid)).toEqual([second.returnId]);
      expect(await redirectsOf(other)).toEqual([expect.objectContaining({ redirectid: otherRedirect.redirectid, url: 'http://www.example.test/other' })]);
      expect((await mailRows(user)).map((row) => row.envelope.payload.returnId)).toEqual([first.returnId, second.returnId]);
    });

    it.each([
      ['ends during the first wait, then resets and mails', true],
      ['outlasts the wait, answering the legacy 503 with nothing written', false],
    ] as const)('holds the mail of a user an open account operation keeps closed: one that %s', async (_case, ends) => {
      const user = await seedUser();
      const operationId = id('C');
      const change: AccountChange = { username: user.username, password: '', s2: 0, perm: 0, inActive: 0, isPublic: 0, remoteID: '', groupIds: null };
      const prepared = await prepareAccountOperation(operationDeps(), {
        operationId, kind: 'update', userId: user.userId, requestSiteId: SITE_A, actorUserId: ADMIN_ACTOR, siteId: SITE_A, actorIsSuperUser: false, change,
      });
      expect(prepared.outcome).toBe('prepared');
      const sleeps: number[] = [];
      const sleep = async (ms: number): Promise<void> => {
        sleeps.push(ms);
        if (ends && sleeps.length === 1) expect((await abortAccountOperation(operationDeps(), operationId)).outcome).toBe('stepped');
      };

      const outcome = await sendLoginByUser(deps(settingsSource({ autoresetpasswords: true }), { sleep }), byUserInput(user)).catch((err: unknown) => err);

      const credential = await gated(SITE_A, (tx) => repo.readCredential(tx, user.userId));
      if (ends) {
        expect(outcome).toMatchObject({ userId: user.userId, tenantId: tenantIdForSite(SITE_A) });
        expect(sleeps).toHaveLength(1);
        expect(credential?.passwordcreated).toEqual(NOW);
        expect(await mailRows(user)).toHaveLength(1);
      } else {
        expect(outcome).toBeInstanceOf(OperationBlockedError);
        expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(USER_CLOSED_WAIT_MS);
        expect(credential).toMatchObject({ password: seededHash, passwordcreated: PASSWORD_CREATED });
        expect(await mailRows(user)).toEqual([]);
        expect(await redirectsOf(user)).toEqual([]);
      }
    });
  });

  describe('sendLoginByEmail', () => {
    it('finds the contact case-insensitively from the trimmed address and requests a forgot-password mail to the address as given', async () => {
      const user = await seedUser({ email: `Mixed.Case-${seq + 1}@Example.Test` });
      const typed = `  ${user.email.toLowerCase()} `;

      const requests = await sendLoginByEmail(deps(settingsSource({ sendLoginBcc: 'audit@example.test' })), { email: typed, siteId: SITE_A, httpHost: HOST });

      const [request] = requests;
      expect(requests).toEqual([{ userId: user.userId, tenantId: tenantIdForSite(SITE_A), messageId: request?.messageId, returnId: request?.returnId }]);
      expect(request?.returnId).toMatch(CF_UUID);
      const returnURL = `http://www.example.test:8443/ctx/index.cfm/tenant-a/${request?.returnId}/?userID=${user.userId}`;
      expect((await onlyMail(user)).envelope.payload).toEqual({
        messageId: request?.messageId,
        userId: user.userId,
        returnId: request?.returnId,
        siteId: SITE_A,
        to: typed,
        from: 'Tenant A Site',
        subject: 'Tenant A Site Account Information',
        text: renderLegacy(LEGACY_TEMPLATES.reset, { ...TEXT_VALUES, firstName: user.fname, contactName: 'Tenant A Site', returnURL }),
        bcc: 'audit@example.test',
        kind: 'forgot-password',
      });
      expect(await redirectsOf(user)).toEqual([
        expect.objectContaining({ redirectid: request?.returnId, url: `http://www.example.test:8443/ctx/profile/?&returnID=${request?.returnId}&returnUserID=${user.userId}` }),
      ]);
    });

    it.each([
      ['a site: its private pool at isPublic=0 and its public pool at isPublic=1', SITE_A, ['aPrivate', 'umbrellaPublic']],
      ['a site id in another case', 'TENANT-A', ['aPrivate', 'umbrellaPublic']],
      ['no site: isPublic=0 in every tenant', '', ['defaultPrivate', 'aPrivate', 'bPrivate', 'umbrellaPrivate']],
      ['an unknown site, through the default site pools', 'nowhere', ['defaultPrivate']],
    ] as const)('mails every account getUserByEmail finds for %s', async (_case, siteId, expected) => {
      const email = `pooled-${seq + 1}@example.test`;
      const accounts = {
        defaultPrivate: await seedUser({ site: DEFAULT, email }),
        aPrivate: await seedUser({ site: SITE_A, email }),
        aPublic: await seedUser({ site: SITE_A, email, ispublic: 1 }),
        bPrivate: await seedUser({ site: SITE_B, email }),
        umbrellaPrivate: await seedUser({ site: UMBRELLA, email }),
        umbrellaPublic: await seedUser({ site: UMBRELLA, email, ispublic: 1 }),
      };

      const requests = await sendLoginByEmail(deps(), { email, siteId, httpHost: HOST });

      expect(requests.map((request) => [request.userId, request.tenantId])).toEqual(
        expected.map((name) => [accounts[name].userId, tenantIdForSite(accounts[name].siteId)]),
      );
      for (const [name, account] of Object.entries(accounts)) {
        const mailed = (expected as readonly string[]).includes(name);
        expect((await mailRows(account)).length).toBe(mailed ? 1 : 0);
        expect((await redirectsOf(account)).length).toBe(mailed ? 1 : 0);
      }
    });

    it('gives each account sharing an address its own reset password and mail, in user id order', async () => {
      const email = `shared-${seq + 1}@example.test`;
      const first = await seedUser({ email });
      const second = await seedUser({ email });

      const requests = await sendLoginByEmail(deps(settingsSource({ autoresetpasswords: true })), { email, siteId: SITE_A, httpHost: HOST });

      expect(requests.map((request) => request.userId)).toEqual([first.userId, second.userId]);
      const passwords: string[] = [];
      for (const user of [first, second]) {
        const { payload } = (await onlyMail(user)).envelope;
        expect(payload).toMatchObject({ to: email, kind: 'forgot-password' });
        expect(payload.text).toContain(`Username: ${user.username}\n`);
        const plain = /^Password: (.*)$/m.exec(payload.text)?.[1] ?? '';
        const credential = await gated(SITE_A, (tx) => repo.readCredential(tx, user.userId));
        expect((await verifyLegacyPassword(plain, credential?.password, FAST_PASSWORD)).match).toBe(true);
        passwords.push(plain);
      }
      expect(passwords[0]).not.toBe(passwords[1]);
    });

    it('mails a contact whose stored address ends in a space once, from the address typed without it', async () => {
      const user = await seedUser({ email: `Trailing-${seq + 1}@Example.test ` });
      const typed = user.email.trimEnd().toLowerCase();

      const requests = await sendLoginByEmail(deps(), { email: typed, siteId: SITE_A, httpHost: HOST });

      expect(requests.map((request) => request.userId)).toEqual([user.userId]);
      expect((await onlyMail(user)).envelope.payload).toMatchObject({ to: typed, kind: 'forgot-password' });
    });

    it('looks the address up once per pool and once per recipient, reading no account by id', async () => {
      const email = `batched-${seq + 1}@example.test`;
      const users = [await seedUser({ email }), await seedUser({ email }), await seedUser({ email })];
      const lookups: Array<[string, string | undefined]> = [];
      let byId = 0;
      const counted: IdentityRepository = {
        ...repo,
        findAccountsByEmail: (tx, address, userId) => {
          lookups.push([tx.tenantId, userId]);
          return repo.findAccountsByEmail(tx, address, userId);
        },
        findAccountById: (...args) => {
          byId += 1;
          return repo.findAccountById(...args);
        },
      };

      const requests = await sendLoginByEmail(deps(settingsSource(), { repo: counted }), { email, siteId: SITE_A, httpHost: HOST });

      expect(requests.map((request) => request.userId)).toEqual(users.map((user) => user.userId));
      for (const user of users) await onlyMail(user);
      expect(lookups).toEqual([
        [tenantIdForSite(SITE_A), undefined],
        [tenantIdForSite(UMBRELLA), undefined],
        ...users.map((user) => [tenantIdForSite(SITE_A), user.userId]),
      ]);
      expect(byId).toBe(0);
    });

    it.each([
      ['an address failing the legacy address check, though a contact has it', 'quiet.example.test', 'quiet.example.test', {}, SITE_A],
      ['an address no contact has', 'quiet@example.test', 'nobody@example.test', {}, SITE_A],
      ['an inactive account', 'quiet@example.test', 'quiet@example.test', { inactive: 1 }, SITE_A],
      ['an account without a username', 'quiet@example.test', 'quiet@example.test', { username: '' }, SITE_A],
      ['a public account looked up without a site', 'quiet@example.test', 'quiet@example.test', { site: UMBRELLA, ispublic: 1 }, ''],
    ] as const)('writes nothing for %s', async (_case, contactEmail, typedEmail, seed, siteId) => {
      const run = `${seq + 1}-`;
      await seedUser({ email: `${run}${contactEmail}`, ...seed });
      const before = await writtenRows();

      expect(await sendLoginByEmail(deps(), { email: `${run}${typedEmail}`, siteId, httpHost: HOST })).toEqual([]);

      expect(await writtenRows()).toEqual(before);
    });

    it.each([
      ['deactivates the account, which is then not mailed', { inActive: 1 }, []],
      ['renames the account, which is mailed under its new name', { username: 'renamed-during-wait' }, ['renamed-during-wait']],
    ] as const)('re-reads the account after an operation that %s', async (_case, change, names) => {
      const user = await seedUser({ email: `waited-${seq + 1}@example.test` });
      const operationId = id('C');
      const accountChange: AccountChange = {
        username: user.username, password: '', s2: 0, perm: 0, inActive: 0, isPublic: 0, remoteID: '', groupIds: null, ...change,
      };
      const prepared = await prepareAccountOperation(operationDeps(), {
        operationId, kind: 'update', userId: user.userId, requestSiteId: SITE_A, actorUserId: ADMIN_ACTOR, siteId: SITE_A, actorIsSuperUser: false, change: accountChange,
      });
      expect(prepared.outcome).toBe('prepared');
      const sleeps: number[] = [];
      const finishOnFirstPoll = async (ms: number): Promise<void> => {
        sleeps.push(ms);
        if (sleeps.length > 1) return;
        expect((await commitAccountOperation(operationDeps(), operationId)).outcome).toBe('committed');
        expect((await finishAccountOperation(operationDeps(), operationId)).outcome).toBe('stepped');
      };

      const requests = await sendLoginByEmail(deps(settingsSource(), { sleep: finishOnFirstPoll }), {
        email: user.email, siteId: SITE_A, httpHost: HOST, message: '#username#',
      });

      expect(sleeps).toHaveLength(1);
      expect(requests.map((request) => request.userId)).toEqual(names.map(() => user.userId));
      const rows = await mailRows(user);
      expect(rows.map((row) => row.envelope.payload.text)).toEqual(names);
    });
  });
});
