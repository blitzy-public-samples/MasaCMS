// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_ROLES } from '@opt2/platform/auth';
import { loadConfig, type SeedConfig, type SiteKey } from '../src/config.js';
import { createRandom } from '../src/random.js';
import { createCalendar } from '../src/time.js';
import { sha256Hex } from '../src/bytes.js';
import { MASA_HOME_CONTENT_ID, MASA_DEFAULT_MODULE_ID, MASA_FORMS_MODULE_ID } from '../src/ids.js';
import { buildMasa, indexMasa, type ContentRow, type MasaData, type MasaIndex } from '../src/masa.js';

const CONFIG_PATH = fileURLToPath(new URL('../seed.config.json', import.meta.url));
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

let config: SeedConfig;
let masa: MasaData;
let index: MasaIndex;
const build = (c: SeedConfig): MasaData => buildMasa(c, createRandom(c.seed).fork('masa'), createCalendar(c.businessDate));

beforeAll(async () => {
  config = await loadConfig(CONFIG_PATH);
  masa = build(config);
  index = indexMasa(masa, config);
});

describe('masa counts', () => {
  it.each([
    ['umbrella', 0, 1000, 0, 100, 0, 0],
    ['tenant-a', 2000, 0, 50, 0, 5000, 1],
    ['tenant-b', 180, 20, 10, 10, 300, 1],
  ] as const)('%s: system %i members %i groups %i categories %i content %i forms %i', (site, sys, mem, groups, cats, content, forms) => {
    expect(index.systemUsers(site as SiteKey)).toHaveLength(sys);
    expect(index.members(site as SiteKey)).toHaveLength(mem);
    expect(index.groups(site as SiteKey)).toHaveLength(groups);
    expect(masa.categories.filter((c) => c.siteID === site)).toHaveLength(cats);
    expect(masa.content.filter((c) => c.siteID === site && c.moduleID === MASA_DEFAULT_MODULE_ID)).toHaveLength(content);
    expect(masa.content.filter((c) => c.siteID === site && c.moduleID === MASA_FORMS_MODULE_ID)).toHaveLength(forms);
  });
  it('totals and key order', () => {
    expect(Object.keys(masa)).toEqual(['sites', 'groups', 'users', 'memberships', 'categories', 'content', 'files', 'oauthClients']);
    expect(masa.users).toHaveLength(3200);
    expect(masa.files).toHaveLength(20);
    expect(masa.oauthClients).toHaveLength(1);
    expect(masa.sites.map((s) => [s.siteID, s.orderNo, s.domain, s.domainAlias, s.programId])).toEqual([
      ['umbrella', 2, 'umbrella.localhost', 'localhost', null],
      ['tenant-a', 3, 'tenant-a.localhost', 'localhost', 1],
      ['tenant-b', 4, 'tenant-b.localhost', 'localhost', 2],
    ]);
    const a = index.site('tenant-a');
    expect([a.publicUserPoolID, a.categoryPoolID, a.filePoolID, a.displayPoolID, a.privateUserPoolID, a.contentPoolID]).toEqual([
      'umbrella', 'umbrella', 'umbrella', 'umbrella', 'tenant-a', 'tenant-a',
    ]);
    expect(index.publicPoolMembers('tenant-a')).toHaveLength(1000);
  });
});

describe('masa users', () => {
  it('usernames and emails', () => {
    const names = masa.users.map((u) => u.username);
    expect(new Set(names).size).toBe(names.length);
    for (const u of masa.users) {
      expect(u.username).toMatch(/^[a-z0-9.]+$/);
      expect(u.email).toBe(`${u.username}@seed.opt2.test`);
      expect(['admin', 'qa_editor', ...config.reserved.rehearsal.usernames]).not.toContain(u.username);
      for (const f of ['fname', 'lname', 'company', 'jobTitle', 'mobilePhone'] as const) expect(u[f].length).toBeLessThanOrEqual(50);
      expect(u.website).toMatch(/^https:\/\/[a-z0-9-]+\.example\.test$/);
      expect(u).not.toHaveProperty('password');
      expect(u.created < u.lastUpdate).toBe(true);
      expect(u.lastUpdate < '2026-06-30T00:00:00.000').toBe(true);
      expect(u.created).toMatch(TS);
      expect(u.isPublic === 1 ? index.site(u.siteID).publicUserPoolID : index.site(u.siteID).privateUserPoolID).toBe(u.siteID);
    }
    for (const g of masa.groups) expect(g.email.endsWith('@seed.opt2.test')).toBe(true);
  });
  it('ids are unique CF UUIDs and reserved ids only on reserved persons', () => {
    const ids = [
      ...masa.groups.map((g) => g.groupID), ...masa.users.map((u) => u.userID), ...masa.categories.map((c) => c.categoryID),
      ...masa.content.flatMap((c) => [c.contentID, ...c.versions.map((v) => v.contentHistID)]),
      ...masa.files.map((f) => f.fileID), ...masa.oauthClients.map((o) => o.clientID),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(CF_UUID);
    const reserved = config.reserved.rehearsal.persons;
    expect(ids.filter((id) => reserved.includes(id)).sort()).toEqual([...reserved].sort());
  });
  it('reserved persons are tenant-a system users in the employee group only', () => {
    for (const id of config.reserved.rehearsal.persons) {
      const u = index.user(id);
      expect([u.siteID, u.isPublic]).toEqual(['tenant-a', 0]);
      expect(masa.memberships.filter((m) => m.userID === id).map((m) => m.groupname)).toEqual(['timesheets.employee']);
      expect(index.isReserved(id)).toBe(true);
    }
    const sys = index.systemUsers('tenant-a').map((u) => u.userID);
    expect(sys.slice(13, 23)).toEqual(config.reserved.rehearsal.persons);
    expect(index.actors('tenant-a', 'timesheets.employee')).toHaveLength(100);
    expect(index.actors('tenant-a', 'timesheets.employee').filter((id) => index.isReserved(id))).toHaveLength(10);
    for (const role of SYNTHETIC_ROLES.filter((r) => r !== 'timesheets.employee')) {
      expect(index.actors('tenant-a', role).some((id) => index.isReserved(id))).toBe(false);
    }
  });
});

describe('masa groups and memberships', () => {
  it.each([
    ['tenant-a', 100, 5],
    ['tenant-b', 20, 3],
  ] as const)('%s role groups and role users', (site, employees, others) => {
    const groups = index.groups(site).map((g) => g.groupname);
    expect(groups.slice(0, 10)).toEqual([...SYNTHETIC_ROLES]);
    expect(groups).not.toContain('Admin');
    expect(new Set(groups).size).toBe(groups.length);
    for (const role of SYNTHETIC_ROLES) {
      const members = index.membersOf(site, role);
      expect(members).toHaveLength(role === 'timesheets.employee' ? employees : others);
      const u = index.roleUser(site, role);
      expect(members).toContain(u.userID);
      expect(masa.memberships.filter((m) => m.userID === u.userID).map((m) => m.groupname)).toEqual([role]);
    }
    const nonEmployee = SYNTHETIC_ROLES.filter((r) => r !== 'timesheets.employee').flatMap((r) => index.membersOf(site, r));
    expect(new Set(nonEmployee).size).toBe(nonEmployee.length);
    const admin = index.roleUser(site, 'site-admin');
    expect(masa.memberships.filter((m) => m.userID === admin.userID)).toEqual([
      { userID: admin.userID, groupID: null, groupname: 'Admin', groupSiteID: site },
    ]);
    const plain = index.roleUser(site, 'system-user');
    expect(masa.memberships.some((m) => m.userID === plain.userID)).toBe(false);
    expect(index.systemUsers(site).map((u) => u.userID).indexOf(plain.userID)).toBe(11);
    for (const m of masa.memberships.filter((x) => x.groupSiteID === site && x.groupID !== null)) {
      expect(index.groups(site).find((g) => g.groupID === m.groupID)?.groupname).toBe(m.groupname);
    }
  });
  it('ordinary tenant-a users join at most two generic groups', () => {
    const generic = new Set(index.groups('tenant-a').slice(10).map((g) => g.groupname));
    const counts = new Map<string, number>();
    for (const m of masa.memberships) if (generic.has(m.groupname)) counts.set(m.userID, (counts.get(m.userID) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(counts.size).toBeGreaterThan(500);
    expect(masa.groups.filter((g) => g.groupname.length > 255)).toHaveLength(0);
  });
  it('member users, oauth account and lookup failures', () => {
    expect(index.memberUser('umbrella').userID).toBe(index.members('umbrella')[0]?.userID);
    expect(index.memberUser('tenant-b').isPublic).toBe(1);
    expect(() => index.memberUser('tenant-a')).toThrow(RangeError);
    expect(() => index.roleUser('umbrella', 'site-admin')).toThrow(RangeError);
    expect(() => index.roleUser('tenant-a', 'member')).toThrow(RangeError);
    expect(() => index.site('default' as SiteKey)).toThrow(RangeError);
    expect(() => index.user('nope')).toThrow(RangeError);
    expect(() => index.oauthAccount('tenant-b')).toThrow(RangeError);
    const client = masa.oauthClients[0]!;
    expect(client).toMatchObject({ siteID: 'tenant-a', name: 'OPT-2 Seed REST Client', grantType: 'client_credentials' });
    const account = index.oauthAccount('tenant-a');
    expect(account.userID).toBe(client.userID);
    expect([account.siteID, account.isPublic]).toEqual(['tenant-a', 0]);
    expect(masa.memberships.some((m) => m.userID === account.userID)).toBe(false);
    expect(index.systemUsers('tenant-a').indexOf(account)).toBe(12);
    expect(index.roleUser('tenant-a', 'system-user').userID).not.toBe(account.userID);
    expect(index.groups('umbrella')).toEqual([]);
    expect(index.membersOf('umbrella', 'x')).toEqual([]);
  });
});

describe('masa categories, content and files', () => {
  it('categories', () => {
    for (const site of ['umbrella', 'tenant-b'] as const) {
      const rows = masa.categories.filter((c) => c.siteID === site);
      expect(new Set(rows.map((c) => c.name)).size).toBe(rows.length);
      for (const c of rows) expect(c.name.length).toBeLessThanOrEqual(50);
    }
    const umbrella = masa.categories.filter((c) => c.siteID === 'umbrella');
    const tops = umbrella.filter((c) => c.parentID === null);
    expect(tops).toHaveLength(10);
    expect(umbrella.slice(10).every((c) => tops.some((t) => t.categoryID === c.parentID))).toBe(true);
    expect(umbrella.some((c) => c.isInterestGroup === 1)).toBe(true);
    expect(masa.categories.filter((c) => c.siteID === 'tenant-b').every((c) => c.parentID === null)).toBe(true);
  });
  it('content', () => {
    for (const site of ['tenant-a', 'tenant-b'] as const) {
      const rows = masa.content.filter((c) => c.siteID === site && c.moduleID === MASA_DEFAULT_MODULE_ID);
      const seen = new Set<string>([MASA_HOME_CONTENT_ID]);
      const folders = rows.filter((c) => c.type === 'Folder');
      expect(folders.length).toBe(Math.round(rows.length * 0.02));
      const pool = new Set(masa.categories.filter((c) => c.siteID === index.site(site).categoryPoolID).map((c) => c.categoryID));
      for (const c of rows) {
        expect(['Folder', 'Page']).toContain(c.type);
        expect(seen.has(c.parentID)).toBe(true);
        if (c.type === 'Folder') expect(c.parentID).toBe(MASA_HOME_CONTENT_ID);
        else expect(c.parentID === MASA_HOME_CONTENT_ID || folders.some((f) => f.contentID === c.parentID)).toBe(true);
        seen.add(c.contentID);
        expect(c.versions.length).toBeGreaterThanOrEqual(1);
        expect(c.versions.length).toBeLessThanOrEqual(3);
        const last = c.versions[c.versions.length - 1]!;
        expect([c.title, c.menuTitle, c.summary]).toEqual([last.title, last.title, last.summary]);
        expect(c.versions.map((v) => v.active)).toEqual(c.versions.map((_, i) => (i === c.versions.length - 1 ? 1 : 0)));
        for (let i = 1; i < c.versions.length; i += 1) expect(c.versions[i - 1]!.lastUpdate < c.versions[i]!.lastUpdate).toBe(true);
        for (const v of c.versions) {
          expect(v.title.length).toBeLessThanOrEqual(255);
          expect(v.body).toMatch(/^<p>.+<\/p>$/s);
          expect(v.approved).toBe(1);
        }
        expect(c.categoryIDs.length).toBeLessThanOrEqual(3);
        expect(new Set(c.categoryIDs).size).toBe(c.categoryIDs.length);
        for (const id of c.categoryIDs) expect(pool.has(id)).toBe(true);
        expect(c).not.toHaveProperty('responseMessage');
        expect(c).not.toHaveProperty('fieldIDs');
      }
      expect(rows.filter((c) => c.objects.length > 0 || c.formID !== undefined)).toEqual([rows[rows.length - 1]]);
    }
  });
  it.each(['tenant-a', 'tenant-b'] as const)('%s form and the page hosting it', (site) => {
    const rows = masa.content.filter((c) => c.siteID === site);
    const form = rows.find((c) => c.type === 'Form') as ContentRow;
    const host = rows[rows.length - 1] as ContentRow;
    expect(rows.indexOf(form)).toBe(rows.length - 2);
    expect(form).toMatchObject({
      moduleID: MASA_FORMS_MODULE_ID,
      parentID: MASA_FORMS_MODULE_ID,
      title: 'OPT-2 Seed Contact Form',
      menuTitle: 'OPT-2 Seed Contact Form',
      isNav: 1,
      objects: [],
      categoryIDs: [],
    });
    expect(form.responseMessage).toMatch(/^<p>.+<\/p>$/);
    expect(form).not.toHaveProperty('formID');
    expect(form.versions.map((v) => [v.title, v.approved, v.active])).toEqual([[form.title, 1, 1]]);
    const def = JSON.parse(form.versions[0]!.body) as {
      datasets: object;
      form: { formid: string; fields: Record<string, Record<string, unknown>>; pages: string[][]; fieldorder: unknown[]; formattributes: { muraormentities: number } };
    };
    expect(def.datasets).toEqual({});
    expect([def.form.fieldorder, def.form.formattributes.muraormentities]).toEqual([[], 0]);
    expect(def.form.pages).toHaveLength(1);
    expect(Object.keys(def.form.fields)).toEqual(def.form.pages[0]);
    expect(form.fieldIDs).toEqual(def.form.pages[0]);
    const fields = def.form.pages[0]!.map((id) => def.form.fields[id]!);
    expect(fields.map((f) => [f.name, f.isrequired, f.validatetype, (f.fieldtype as { fieldtype: string }).fieldtype])).toEqual([
      ['fullname', 1, '', 'textfield'],
      ['email', 1, 'email', 'textfield'],
      ['message', 0, '', 'textarea'],
    ]);
    for (const [id, f] of Object.entries(def.form.fields)) {
      expect([f.fieldid, f.formid, f.isactive, f.isdeleted]).toEqual([id, def.form.formid, 1, 0]);
      expect((f.fieldtype as { fieldtypeid: string }).fieldtypeid).toMatch(CF_UUID);
    }
    expect(host).toMatchObject({
      moduleID: MASA_DEFAULT_MODULE_ID,
      parentID: MASA_HOME_CONTENT_ID,
      type: 'Page',
      title: 'OPT-2 Seed Contact Page',
      formID: form.contentID,
      objects: [{ columnID: 2, object: 'form', objectID: form.contentID, name: form.title }],
    });
    expect(host.versions).toHaveLength(1);
    expect(form.versions[0]!.lastUpdate < host.versions[0]!.lastUpdate).toBe(true);
  });
  it('files', () => {
    const png = masa.files.filter((f) => f.fileExt === 'png');
    const pdf = masa.files.filter((f) => f.fileExt === 'pdf');
    expect([png.length, pdf.length]).toEqual([10, 10]);
    expect(png.map((f) => f.filename)).toEqual(Array.from({ length: 10 }, (_, i) => `seed-image-${String(i + 1).padStart(2, '0')}.png`));
    expect(pdf.map((f) => f.filename)).toEqual(Array.from({ length: 10 }, (_, i) => `seed-document-${String(i + 1).padStart(2, '0')}.pdf`));
    for (const f of masa.files) {
      const bytes = Buffer.from(f.bytes, 'base64');
      expect(f.fileSize).toBe(bytes.length);
      expect(f.sha256).toBe(sha256Hex(bytes));
      expect([f.siteID, f.moduleID]).toEqual(['umbrella', MASA_DEFAULT_MODULE_ID]);
      expect(f.contentType).toBe(f.fileExt === 'png' ? 'image' : 'application');
      expect(f.contentSubType).toBe(f.fileExt);
      expect(bytes.subarray(0, 4).toString('latin1')).toBe(f.fileExt === 'png' ? '\x89PNG' : '%PDF');
    }
  });
});

describe('masa determinism', () => {
  it('same config gives identical output; a reloaded dataset indexes identically', () => {
    const again = build(config);
    expect(JSON.stringify(again)).toBe(JSON.stringify(masa));
    const reloaded = indexMasa(JSON.parse(JSON.stringify(masa)) as MasaData, config);
    for (const site of ['tenant-a', 'tenant-b'] as const) {
      for (const role of [...SYNTHETIC_ROLES, 'site-admin', 'system-user']) {
        expect(reloaded.roleUser(site, role).userID).toBe(index.roleUser(site, role).userID);
      }
    }
    expect(reloaded.memberUser('umbrella').userID).toBe(index.memberUser('umbrella').userID);
  });
  it('a different seed changes the output', () => {
    expect(JSON.stringify(build({ ...config, seed: config.seed + 1 }).users[0])).not.toBe(JSON.stringify(masa.users[0]));
  });
  it('rejects a site too small for its fixed users', () => {
    const small = structuredClone(config);
    small.sites['tenant-b'].counts.systemUsers = 5;
    expect(() => build(small)).toThrow(RangeError);
    const fewGroups = structuredClone(config);
    fewGroups.sites['tenant-b'].counts.groups = 3;
    expect(() => build(fewGroups)).toThrow(RangeError);
  });
  it('rejects more versions per node than the history has minutes', () => {
    const over = structuredClone(config);
    over.sites['tenant-a'].counts.maxVersionsPerNode = config.historyDays * 1440 + 1;
    expect(() => build(over)).toThrow(RangeError);
    const full = structuredClone(config);
    full.historyDays = 1;
    for (const site of ['tenant-a', 'tenant-b'] as const) {
      Object.assign(full.sites[site].counts, { contentNodes: 2, maxVersionsPerNode: 1440 });
    }
    const { content } = build(full);
    expect(content.map((c) => c.type)).toEqual(['Page', 'Form', 'Page', 'Page', 'Form', 'Page']);
    for (const c of content) {
      expect(c.versions.length).toBeLessThanOrEqual(1440);
      for (let i = 1; i < c.versions.length; i += 1) expect(c.versions[i - 1]!.lastUpdate < c.versions[i]!.lastUpdate).toBe(true);
    }
  });
});
