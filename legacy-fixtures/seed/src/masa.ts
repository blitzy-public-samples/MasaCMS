// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, SYNTHETIC_ROLES, type Role } from '@opt2/platform/auth';
import { pdfBytes, pngBytes, sha256Hex, toBase64 } from './bytes.js';
import { SITE_ORDER, roleGroupName, type SeedConfig, type SiteKey } from './config.js';
import { printable } from './errors.js';
import { MASA_DEFAULT_MODULE_ID, MASA_FORMS_MODULE_ID, MASA_HOME_CONTENT_ID, cfUuidFrom } from './ids.js';
import type { SeedRandom } from './random.js';
import type { Calendar } from './time.js';

/** Seeded Masa site with every pool resolved to a site id (`tsettings`). */
export interface SiteRow {
  siteID: SiteKey;
  site: string;
  domain: string;
  domainAlias: string;
  programId: number | null;
  orderNo: number;
  publicUserPoolID: SiteKey;
  privateUserPoolID: SiteKey;
  categoryPoolID: SiteKey;
  filePoolID: SiteKey;
  displayPoolID: SiteKey;
  contentPoolID: SiteKey;
}

/** Masa group (`tusers` Type 1) stored in a private user pool. */
export interface GroupRow {
  groupID: string;
  siteID: SiteKey;
  groupname: string;
  type: 1;
  isPublic: 0;
  perm: 0;
  subType: 'Default';
  email: string;
  created: string;
  lastUpdate: string;
}

/** Masa user (`tusers` Type 2); passwords exist only in the generated credentials. */
export interface UserRow {
  userID: string;
  siteID: SiteKey;
  type: 2;
  isPublic: 0 | 1;
  username: string;
  fname: string;
  lname: string;
  email: string;
  company: string;
  jobTitle: string;
  mobilePhone: string;
  website: string;
  subType: 'Default';
  s2: 0;
  inActive: 0;
  subscribe: 0 | 1;
  notes: string;
  created: string;
  lastUpdate: string;
  lastUpdateBy: 'System';
}

/** Group membership (`tusersmemb`); `groupID` is null for the `Admin` group Masa creates with the site. */
export interface MembershipRow {
  userID: string;
  groupID: string | null;
  groupname: string;
  groupSiteID: SiteKey;
}

/** Masa category (`tcontentcategories`) stored in a category pool site. */
export interface CategoryRow {
  categoryID: string;
  siteID: SiteKey;
  parentID: string | null;
  name: string;
  isInterestGroup: 0 | 1;
  isActive: 1;
  isOpen: 0 | 1;
  dateCreated: string;
  lastUpdate: string;
}

/** One saved version of a content node, oldest first. */
export interface ContentVersion {
  contentHistID: string;
  title: string;
  summary: string;
  body: string;
  lastUpdate: string;
  approved: 1;
  active: 0 | 1;
}

/** Display object placed on every version of a content node (`tcontentobjects`), in display order within its region. */
export interface ContentObjectRow {
  columnID: number;
  object: 'form';
  objectID: string;
  name: string;
}

/**
 * Masa content node (`tcontent`) whose title and summary are those of its active version: a site-tree Folder or Page,
 * or a form-builder Form of the Forms module, whose version bodies hold the form definition JSON.
 */
export interface ContentRow {
  contentID: string;
  siteID: SiteKey;
  moduleID: string;
  parentID: string;
  type: 'Folder' | 'Page' | 'Form';
  subType: 'Default';
  title: string;
  menuTitle: string;
  summary: string;
  isNav: 0 | 1;
  display: 1;
  categoryIDs: string[];
  objects: ContentObjectRow[];
  /** Page hosting a form only: the contentID of the Form its objects display. */
  formID?: string;
  /** Form only: the message shown after a successful submission. */
  responseMessage?: string;
  /** Form only: the ids of its definition's fields, in page order. */
  fieldIDs?: string[];
  versions: ContentVersion[];
}

/** Pooled Masa file (`tfiles`) with its bytes. */
export interface FileRow {
  fileID: string;
  siteID: 'umbrella';
  moduleID: string;
  filename: string;
  fileExt: string;
  contentType: string;
  contentSubType: string;
  fileSize: number;
  created: string;
  sha256: string;
  /** Standard base64 of the file content. */
  bytes: string;
}

/** Masa OAuth client (`toauthclients`); its secret exists only in the generated credentials. */
export interface OAuthClientRow {
  clientID: string;
  siteID: SiteKey;
  name: string;
  description: string;
  grantType: 'client_credentials';
  userID: string;
}

/** Masa part of the dataset, each array in load order. */
export interface MasaData {
  sites: SiteRow[];
  groups: GroupRow[];
  users: UserRow[];
  memberships: MembershipRow[];
  categories: CategoryRow[];
  content: ContentRow[];
  files: FileRow[];
  oauthClients: OAuthClientRow[];
}

/** Lookups over a `MasaData`, generated or read back from disk. */
export interface MasaIndex {
  /** Site row; throws `RangeError` for an unknown site. */
  site(siteID: SiteKey): SiteRow;
  /** User row; throws `RangeError` for an unknown user. */
  user(userID: string): UserRow;
  /** Users with `isPublic` 0 stored in `siteID`, in dataset order. */
  systemUsers(siteID: SiteKey): readonly UserRow[];
  /** Users with `isPublic` 1 stored in `siteID`, in dataset order. */
  members(siteID: SiteKey): readonly UserRow[];
  /** Members of the public user pool of `siteID`. */
  publicPoolMembers(siteID: SiteKey): readonly UserRow[];
  /** Groups stored in `siteID`. */
  groups(siteID: SiteKey): readonly GroupRow[];
  /** UserIDs of group `groupname` stored in `siteID`, in membership order. */
  membersOf(siteID: SiteKey, groupname: string): readonly string[];
  /** First private-pool user holding exactly the role's group, or no group for `system-user`; throws `RangeError` when absent. */
  roleUser(siteID: SiteKey, role: Role | 'site-admin' | 'system-user'): UserRow;
  /** First member stored in `siteID`; throws `RangeError` when none is. */
  memberUser(siteID: SiteKey): UserRow;
  /** UserIDs in the role's group of the site's private pool; reserved persons only for `timesheets.employee`. */
  actors(siteID: SiteKey, role: Role): readonly string[];
  /** Whether `userID` is a reserved rehearsal person. */
  isReserved(userID: string): boolean;
  /** Account connected to the site's first OAuth client; throws `RangeError` when the site has none. */
  oauthAccount(siteID: SiteKey): UserRow;
}

const MINUTES_PER_DAY = 1440;
const ADMIN_GROUP = 'Admin';
const SITE_ADMIN = 'site-admin';
const SYSTEM_USER = 'system-user';
const INSTALLED_USERNAMES: readonly string[] = ['admin', 'qa_editor'];
const OAUTH_CLIENT_NAME = 'OPT-2 Seed REST Client';
const OAUTH_CLIENT_DESCRIPTION = 'Seeded client_credentials client for the REST golden scenarios.';
/** Loopback host: parent of each seeded site's domain and its alias, so admin pages on it call Mura.js on their own origin. */
const LOOPBACK_HOST = 'localhost';
// Column widths of core/setup/db/mssql.sql.
const MAX = { site: 50, person: 50, wide: 255, title: 255, category: 50, filename: 200 } as const;
// Members of each role group other than `timesheets.employee`, whose size is `counts.timesheetEmployees`.
const ROLE_GROUP_SIZE: Readonly<Record<SiteKey, number>> = { umbrella: 0, 'tenant-a': 5, 'tenant-b': 3 };
const FOLDER_SHARE = 0.02;
const CATEGORIES_PER_TOP = 10;
const MAX_GENERIC_GROUPS_PER_USER = 2;
const MAX_CATEGORIES_PER_NODE = 3;
const FORM_TITLE = 'OPT-2 Seed Contact Form';
const FORM_HOST_TITLE = 'OPT-2 Seed Contact Page';
const FORM_RESPONSE_MESSAGE = '<p>Thank you, your message has been received.</p>';
// Every template of the installed default theme except blank.cfm renders region 2 below the body.
const FORM_COLUMN_ID = 2;
const FORM_SECTION_ID = '00000000-0000-0000-0000000000000000';
/** Fields of the seeded form in page order; `validatetype` takes the form builder's values. */
const FORM_FIELDS = [
  { name: 'fullname', label: 'Full Name', fieldtype: 'textfield', isrequired: 1, validatetype: '' },
  { name: 'email', label: 'Email', fieldtype: 'textfield', isrequired: 1, validatetype: 'email' },
  { name: 'message', label: 'Message', fieldtype: 'textarea', isrequired: 0, validatetype: '' },
] as const;

interface Build {
  config: SeedConfig;
  random: SeedRandom;
  calendar: Calendar;
  usedIds: Set<string>;
  usernames: Set<string>;
}

/** System users of one site by their fixed role in the generation order. */
interface SiteStaff {
  siteAdmin: UserRow;
  roleUsers: UserRow[];
  oauthAccounts: UserRow[];
  reserved: UserRow[];
  ordinary: UserRow[];
  all: UserRow[];
}

function fork(b: Build, siteID: SiteKey, part: string): SeedRandom {
  return b.random.fork(`masa/${siteID}/${part}`);
}

/** CF UUID from `rng`; throws when it repeats an id already generated or reserved. */
function newId(b: Build, rng: SeedRandom): string {
  const id = cfUuidFrom(rng);
  if (b.usedIds.has(id)) throw new Error(`Generated id ${id} is already in use`);
  b.usedIds.add(id);
  return id;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

/** `text` clipped to `max`, with ` 2`, ` 3`, ... appended until it is not in `taken`; records the result. */
function uniqueName(taken: Set<string>, text: string, max: number): string {
  const base = clip(text, max);
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${clip(base, max - String(n).length - 1)} ${n}`;
  taken.add(name);
  return name;
}

function asciiLower(text: string): string {
  return text.normalize('NFD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slug(text: string): string {
  return text
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Unused `<first>.<last>` username, numbered on a clash. */
function takeUsername(b: Build, fname: string, lname: string): string {
  const base = [asciiLower(fname), asciiLower(lname)].filter((part) => part.length > 0).join('.') || 'user';
  let name = base;
  for (let n = 2; b.usernames.has(name); n += 1) name = `${base}${n}`;
  b.usernames.add(name);
  return name;
}

/** `n` distinct ascending timestamps within the history window, all before the business date; `n` is at most the window's minutes. */
function instants(b: Build, rng: SeedRandom, n: number): string[] {
  const minutes = new Set<number>();
  while (minutes.size < n) {
    minutes.add(-rng.int(1, b.config.historyDays) * MINUTES_PER_DAY + rng.int(0, MINUTES_PER_DAY - 1));
  }
  return [...minutes]
    .sort((x, y) => x - y)
    .map((total) => {
      const day = Math.floor(total / MINUTES_PER_DAY);
      return b.calendar.localTimestamp(day, total - day * MINUTES_PER_DAY);
    });
}

function pair(b: Build, rng: SeedRandom): [string, string] {
  return instants(b, rng, 2) as [string, string];
}

function bit(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function buildSite(config: SeedConfig, siteID: SiteKey, position: number): SiteRow {
  const { site, programId, pools } = config.sites[siteID];
  return {
    siteID,
    site: clip(site, MAX.site),
    domain: `${siteID}.${LOOPBACK_HOST}`,
    domainAlias: LOOPBACK_HOST,
    programId,
    // The installed `default` site keeps orderNo 1.
    orderNo: position + 2,
    publicUserPoolID: pools.publicUserPoolID ?? siteID,
    privateUserPoolID: pools.privateUserPoolID ?? siteID,
    categoryPoolID: pools.categoryPoolID ?? siteID,
    filePoolID: pools.filePoolID ?? siteID,
    displayPoolID: pools.displayPoolID ?? siteID,
    contentPoolID: pools.contentPoolID ?? siteID,
  };
}

/** Role groups then uniquely named generic groups, never `Admin`, which Masa creates with the site. */
function buildGroups(b: Build, site: SiteRow): GroupRow[] {
  const count = b.config.sites[site.siteID].counts.groups;
  if (count === 0) return [];
  const roleNames = SYNTHETIC_ROLES.map((role) => roleGroupName(b.config, role));
  if (count < roleNames.length) {
    throw printable(new RangeError(`Site ${site.siteID} needs at least ${roleNames.length} groups for the role groups, got ${count}`));
  }
  const rng = fork(b, site.siteID, 'groups');
  const taken = new Set([ADMIN_GROUP, ...roleNames]);
  const names = [...roleNames];
  while (names.length < count) names.push(uniqueName(taken, `${rng.faker.commerce.department()} Team`, MAX.wide));
  return names.map((groupname) => {
    const [created, lastUpdate] = pair(b, rng);
    return {
      groupID: newId(b, rng),
      siteID: site.privateUserPoolID,
      groupname,
      type: 1,
      isPublic: 0,
      perm: 0,
      subType: 'Default',
      // The site in the slug keeps the same role group of two sites on distinct addresses.
      email: `${slug(`${site.siteID} ${groupname}`)}@${b.config.emailDomain}`,
      created,
      lastUpdate,
    };
  });
}

/** One Type 2 user stored in `siteID`; `userID` is drawn unless given. */
function buildUser(b: Build, rng: SeedRandom, siteID: SiteKey, isPublic: 0 | 1, userID?: string): UserRow {
  const { faker } = rng;
  const id = userID ?? newId(b, rng);
  const fname = clip(faker.person.firstName(), MAX.person);
  const lname = clip(faker.person.lastName(), MAX.person);
  const username = takeUsername(b, fname, lname);
  const [created, lastUpdate] = pair(b, rng);
  return {
    userID: id,
    siteID,
    type: 2,
    isPublic,
    username,
    fname,
    lname,
    email: `${username}@${b.config.emailDomain}`,
    company: clip(faker.company.name(), MAX.person),
    jobTitle: clip(faker.person.jobTitle(), MAX.person),
    mobilePhone: clip(faker.phone.number(), MAX.person),
    website: clip(`https://${faker.internet.domainWord()}.example.test`, MAX.wide),
    subType: 'Default',
    s2: 0,
    inActive: 0,
    subscribe: bit(rng.bool(0.3)),
    notes: faker.lorem.sentence(),
    created,
    lastUpdate,
    lastUpdateBy: 'System',
  };
}

/** Private-pool users of a site in their fixed order: site admin, role users, plain user, OAuth accounts, reserved, ordinary. */
function buildStaff(b: Build, site: SiteRow): SiteStaff | null {
  const counts = b.config.sites[site.siteID].counts;
  if (counts.systemUsers === 0) return null;
  const { rehearsal } = b.config.reserved;
  const reservedIds = rehearsal.site === site.siteID ? rehearsal.persons : [];
  const fixed = 2 + SYNTHETIC_ROLES.length + counts.oauthClients + reservedIds.length;
  if (counts.systemUsers < fixed) {
    throw printable(new RangeError(`Site ${site.siteID} needs at least ${fixed} system users, got ${counts.systemUsers}`));
  }
  const rng = fork(b, site.siteID, 'users');
  const pool = site.privateUserPoolID;
  const next = (userID?: string): UserRow => buildUser(b, rng, pool, 0, userID);
  const siteAdmin = next();
  const roleUsers = SYNTHETIC_ROLES.map(() => next());
  const plain = next();
  const oauthAccounts = Array.from({ length: counts.oauthClients }, () => next());
  const reserved = reservedIds.map((userID) => next(userID));
  const ordinary = Array.from({ length: counts.systemUsers - fixed }, () => next());
  return {
    siteAdmin,
    roleUsers,
    oauthAccounts,
    reserved,
    ordinary,
    all: [siteAdmin, ...roleUsers, plain, ...oauthAccounts, ...reserved, ...ordinary],
  };
}

/** Public-pool users counted for a site, stored in its public user pool. */
function buildMembers(b: Build, site: SiteRow): UserRow[] {
  const rng = fork(b, site.siteID, 'members');
  return Array.from({ length: b.config.sites[site.siteID].counts.members }, () =>
    buildUser(b, rng, site.publicUserPoolID, 1),
  );
}

/** Memberships of a site's staff in user order; ordinary members of different role groups never overlap. */
function buildMemberships(b: Build, site: SiteRow, staff: SiteStaff, groups: readonly GroupRow[]): MembershipRow[] {
  const rng = fork(b, site.siteID, 'memberships');
  const pool = site.privateUserPoolID;
  const counts = b.config.sites[site.siteID].counts;
  const joins = new Map<string, MembershipRow[]>(staff.all.map((user) => [user.userID, []]));
  const join = (user: UserRow, groupID: string | null, groupname: string): void => {
    (joins.get(user.userID) as MembershipRow[]).push({ userID: user.userID, groupID, groupname, groupSiteID: pool });
  };
  const byName = new Map(groups.map((group) => [group.groupname, group]));
  const roleNames = SYNTHETIC_ROLES.map((role) => roleGroupName(b.config, role));

  join(staff.siteAdmin, null, ADMIN_GROUP);
  const candidates = rng.shuffle(staff.ordinary);
  let cursor = 0;
  SYNTHETIC_ROLES.forEach((role, i) => {
    const group = byName.get(roleNames[i] as string);
    if (group === undefined) throw new RangeError(`Site ${site.siteID} has no group for role ${role}`);
    const employees = role === Roles.timesheetsEmployee;
    const fixed = [staff.roleUsers[i] as UserRow, ...(employees ? staff.reserved : [])];
    const size = employees ? counts.timesheetEmployees : ROLE_GROUP_SIZE[site.siteID];
    const extra = size - fixed.length;
    if (extra < 0 || cursor + extra > candidates.length) {
      throw printable(new RangeError(`Site ${site.siteID} cannot fill group ${group.groupname} with ${size} members`));
    }
    for (const user of [...fixed, ...candidates.slice(cursor, cursor + extra)]) join(user, group.groupID, group.groupname);
    cursor += extra;
  });

  const generic = groups.filter((group) => !roleNames.includes(group.groupname));
  for (const user of staff.ordinary) {
    const n = rng.int(0, Math.min(MAX_GENERIC_GROUPS_PER_USER, generic.length));
    for (const group of rng.pickMany(generic, n)) join(user, group.groupID, group.groupname);
  }
  return staff.all.flatMap((user) => joins.get(user.userID) as MembershipRow[]);
}

/** Categories counted for a site, stored in its category pool: top-level ones first, flat when there are few. */
function buildCategories(b: Build, site: SiteRow, existing: readonly CategoryRow[]): CategoryRow[] {
  const count = b.config.sites[site.siteID].counts.categories;
  if (count === 0) return [];
  const rng = fork(b, site.siteID, 'categories');
  const { faker } = rng;
  const siteID = site.categoryPoolID;
  const taken = new Set(existing.filter((row) => row.siteID === siteID).map((row) => row.name));
  const tops = count <= CATEGORIES_PER_TOP ? count : Math.ceil(count / CATEGORIES_PER_TOP);
  const topIDs: string[] = [];
  return Array.from({ length: count }, (_, i): CategoryRow => {
    const top = i < tops;
    const categoryID = newId(b, rng);
    const text = top
      ? faker.commerce.department()
      : `${faker.commerce.productAdjective()} ${faker.commerce.productMaterial()}`;
    const [dateCreated, lastUpdate] = pair(b, rng);
    const parentID = top ? null : rng.pick(topIDs);
    if (top) topIDs.push(categoryID);
    return {
      categoryID,
      siteID,
      parentID,
      name: uniqueName(taken, text, MAX.category),
      isInterestGroup: bit(rng.bool(0.3)),
      isActive: 1,
      isOpen: bit(rng.bool(0.5)),
      dateCreated,
      lastUpdate,
    };
  });
}

/**
 * Form-builder definition (a Form's `tcontent.body`) in the JSON the admin form builder saves: one page of fields,
 * each keyed by its id, with `muraormentities` off so Masa never generates `fb_*` entities for it; with its field ids.
 */
function formDefinition(b: Build, rng: SeedRandom): { body: string; fieldIDs: string[] } {
  const formid = newId(b, rng);
  const fields: Record<string, unknown> = {};
  const page: string[] = [];
  for (const field of FORM_FIELDS) {
    const fieldid = newId(b, rng);
    page.push(fieldid);
    fields[fieldid] = {
      fieldid,
      sectionid: FORM_SECTION_ID,
      validatemessage: '',
      fieldtype: {
        fieldtypeid: newId(b, rng),
        islong: bit(field.fieldtype === 'textarea'),
        datecreate: '',
        fieldtype: field.fieldtype,
        IsMultiSelect: 0,
        moduleid: '',
        datelastupdate: '',
        rblabel: '',
        displaytype: 'field',
        bean: '',
        isdata: 0,
        label: '',
      },
      relatedid: '',
      rblabel: '',
      value: '',
      config: {},
      isrequired: field.isrequired,
      label: field.label,
      type: 'COMMON',
      fieldtypeid: '',
      datecreate: '',
      cssstyle: '',
      datelastupdate: '',
      validateregex: '',
      isactive: 1,
      formid,
      name: field.name,
      placeholder: '',
      islocked: 0,
      validatetype: field.validatetype,
      datasetid: '',
      remoteid: '',
      tooltip: '',
      isdeleted: 0,
      orderno: 0,
      isentrytype: 'SINGLE',
      params: '',
    };
  }
  const body = JSON.stringify({
    datasets: {},
    form: {
      datecreate: '',
      fields,
      pages: [page],
      statuscode: 0,
      datelastupdate: '',
      formattributes: { muraormentities: 0 },
      siteid: '',
      formid,
      isactive: 0,
      name: '',
      config: {},
      notes: '',
      remoteid: '',
      iscurrent: 0,
      package: '',
      deletedfields: {},
      fieldorder: [],
    },
  });
  return { body, fieldIDs: page };
}

/** The site's Form, stored in the Forms module outside the site tree, and the Page under home that displays it in region 2. */
function buildForm(b: Build, site: SiteRow): [form: ContentRow, host: ContentRow] {
  const rng = fork(b, site.siteID, 'form');
  const { faker } = rng;
  const formID = newId(b, rng);
  const [formSaved, hostSaved] = pair(b, rng);
  const contentHistID = newId(b, rng);
  const definition = formDefinition(b, rng);
  const form: ContentRow = {
    contentID: formID,
    siteID: site.siteID,
    moduleID: MASA_FORMS_MODULE_ID,
    parentID: MASA_FORMS_MODULE_ID,
    type: 'Form',
    subType: 'Default',
    title: FORM_TITLE,
    menuTitle: FORM_TITLE,
    summary: '',
    isNav: 1,
    display: 1,
    categoryIDs: [],
    objects: [],
    responseMessage: FORM_RESPONSE_MESSAGE,
    fieldIDs: definition.fieldIDs,
    versions: [
      {
        contentHistID,
        title: FORM_TITLE,
        summary: '',
        body: definition.body,
        lastUpdate: formSaved,
        approved: 1,
        active: 1,
      },
    ],
  };
  const summary = `<p>${faker.lorem.sentence()}</p>`;
  const host: ContentRow = {
    contentID: newId(b, rng),
    siteID: site.siteID,
    moduleID: MASA_DEFAULT_MODULE_ID,
    parentID: MASA_HOME_CONTENT_ID,
    type: 'Page',
    subType: 'Default',
    title: FORM_HOST_TITLE,
    menuTitle: FORM_HOST_TITLE,
    summary,
    isNav: 1,
    display: 1,
    categoryIDs: [],
    objects: [{ columnID: FORM_COLUMN_ID, object: 'form', objectID: formID, name: FORM_TITLE }],
    formID,
    versions: [
      {
        contentHistID: newId(b, rng),
        title: FORM_HOST_TITLE,
        summary,
        body: `<p>${faker.lorem.paragraph()}</p>`,
        lastUpdate: hostSaved,
        approved: 1,
        active: 1,
      },
    ],
  };
  return [form, host];
}

/**
 * Content nodes counted for a site: folders under the home node first, then pages under home or a folder, then the page
 * hosting the site's form; the Form itself, a Forms-module item, precedes its host page and is not counted.
 */
function buildContent(b: Build, site: SiteRow, categories: readonly CategoryRow[]): ContentRow[] {
  const counts = b.config.sites[site.siteID].counts;
  if (counts.contentNodes === 0) return [];
  const slots = b.config.historyDays * MINUTES_PER_DAY;
  if (counts.maxVersionsPerNode > slots) {
    throw printable(
      new RangeError(
        `Site ${site.siteID} allows ${counts.maxVersionsPerNode} versions per node, but a ${b.config.historyDays}-day history has only ${slots} distinct minutes`,
      ),
    );
  }
  const rng = fork(b, site.siteID, 'content');
  const { faker } = rng;
  const pooled = categories.filter((row) => row.siteID === site.categoryPoolID).map((row) => row.categoryID);
  const folderCount = Math.round(counts.contentNodes * FOLDER_SHARE);
  const folders: string[] = [];
  const title = (type: ContentRow['type']): string =>
    clip(
      type === 'Folder'
        ? `${faker.commerce.department()} ${faker.lorem.word()}`
        : faker.lorem.sentence({ min: 2, max: 6 }).replace(/\.$/, ''),
      MAX.title,
    );

  const nodes = Array.from({ length: counts.contentNodes - 1 }, (_, i): ContentRow => {
    const type: ContentRow['type'] = i < folderCount ? 'Folder' : 'Page';
    const contentID = newId(b, rng);
    const parentID =
      type === 'Folder' || folders.length === 0 || rng.bool(0.2) ? MASA_HOME_CONTENT_ID : rng.pick(folders);
    const stamps = instants(b, rng, rng.int(1, Math.max(1, counts.maxVersionsPerNode)));
    let current = title(type);
    const versions = stamps.map((lastUpdate, v): ContentVersion => {
      if (v > 0 && rng.bool(0.3)) current = title(type);
      return {
        contentHistID: newId(b, rng),
        title: current,
        summary: `<p>${faker.lorem.sentence()}</p>`,
        body: Array.from({ length: rng.int(1, 3) }, () => `<p>${faker.lorem.paragraph()}</p>`).join('\n'),
        lastUpdate,
        approved: 1,
        active: bit(v === stamps.length - 1),
      };
    });
    const active = versions[versions.length - 1] as ContentVersion;
    if (type === 'Folder') folders.push(contentID);
    return {
      contentID,
      siteID: site.siteID,
      moduleID: MASA_DEFAULT_MODULE_ID,
      parentID,
      type,
      subType: 'Default',
      title: active.title,
      menuTitle: active.title,
      summary: active.summary,
      isNav: bit(rng.bool(0.8)),
      display: 1,
      categoryIDs: rng.pickMany(pooled, rng.int(0, Math.min(MAX_CATEGORIES_PER_NODE, pooled.length))),
      objects: [],
      versions,
    };
  });
  return [...nodes, ...buildForm(b, site)];
}

/** Pooled umbrella files: PNG images first, then PDF documents. */
function buildFiles(b: Build): FileRow[] {
  const count = b.config.sites.umbrella.counts.files;
  if (count === 0) return [];
  const rng = fork(b, 'umbrella', 'files');
  const images = Math.ceil(count / 2);
  return Array.from({ length: count }, (_, i): FileRow => {
    const image = i < images;
    const nn = String(image ? i + 1 : i - images + 1).padStart(2, '0');
    const fileID = newId(b, rng);
    const content = image
      ? pngBytes(rng, { width: rng.int(8, 32), height: rng.int(8, 32) })
      : pdfBytes(`Seed document ${nn}`, [rng.faker.lorem.sentence(), rng.faker.lorem.sentence()]);
    const [created] = instants(b, rng, 1) as [string];
    return {
      fileID,
      siteID: 'umbrella',
      moduleID: MASA_DEFAULT_MODULE_ID,
      filename: clip(image ? `seed-image-${nn}.png` : `seed-document-${nn}.pdf`, MAX.filename),
      fileExt: image ? 'png' : 'pdf',
      contentType: image ? 'image' : 'application',
      contentSubType: image ? 'png' : 'pdf',
      fileSize: content.length,
      created,
      sha256: sha256Hex(content),
      bytes: toBase64(content),
    };
  });
}

/** One `client_credentials` client per OAuth account of the site. */
function buildOAuthClients(b: Build, site: SiteRow, accounts: readonly UserRow[]): OAuthClientRow[] {
  if (accounts.length === 0) return [];
  const rng = fork(b, site.siteID, 'oauth');
  return accounts.map((account, i) => ({
    clientID: newId(b, rng),
    siteID: site.siteID,
    name: i === 0 ? OAUTH_CLIENT_NAME : `${OAUTH_CLIENT_NAME} ${i + 1}`,
    description: OAUTH_CLIENT_DESCRIPTION,
    grantType: 'client_credentials',
    userID: account.userID,
  }));
}

/** Generates the Masa part of the dataset; equal inputs yield identical output. */
export function buildMasa(config: SeedConfig, random: SeedRandom, calendar: Calendar): MasaData {
  const { rehearsal } = config.reserved;
  const b: Build = {
    config,
    random,
    calendar,
    usedIds: new Set(rehearsal.persons),
    usernames: new Set([...INSTALLED_USERNAMES, ...rehearsal.usernames]),
  };
  const sites = SITE_ORDER.map((siteID, i) => buildSite(config, siteID, i));
  const groups: GroupRow[] = [];
  const users: UserRow[] = [];
  const memberships: MembershipRow[] = [];
  const oauthClients: OAuthClientRow[] = [];
  for (const site of sites) {
    const siteGroups = buildGroups(b, site);
    groups.push(...siteGroups);
    const staff = buildStaff(b, site);
    if (staff !== null) {
      users.push(...staff.all);
      memberships.push(...buildMemberships(b, site, staff, siteGroups));
      oauthClients.push(...buildOAuthClients(b, site, staff.oauthAccounts));
    }
    users.push(...buildMembers(b, site));
  }
  const categories: CategoryRow[] = [];
  for (const site of sites) categories.push(...buildCategories(b, site, categories));
  const content = sites.flatMap((site) => buildContent(b, site, categories));
  const files = buildFiles(b);
  return { sites, groups, users, memberships, categories, content, files, oauthClients };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list === undefined) out.set(k, [row]);
    else list.push(row);
  }
  return out;
}

/** Indexes `masa`; `config` supplies the role group names and the reserved rehearsal persons. */
export function indexMasa(masa: MasaData, config: SeedConfig): MasaIndex {
  const none: readonly never[] = Object.freeze([]);
  const groupKey = (siteID: string, groupname: string): string => `${siteID}\u0000${groupname}`;
  const sites = new Map<string, SiteRow>(masa.sites.map((row) => [row.siteID, row]));
  const users = new Map(masa.users.map((row) => [row.userID, row]));
  const systemBySite = groupBy(
    masa.users.filter((row) => row.isPublic === 0),
    (row) => row.siteID,
  );
  const membersBySite = groupBy(
    masa.users.filter((row) => row.isPublic === 1),
    (row) => row.siteID,
  );
  const groupsBySite = groupBy(masa.groups, (row) => row.siteID);
  const groupMembers = new Map<string, readonly string[]>();
  for (const [key, rows] of groupBy(masa.memberships, (row) => groupKey(row.groupSiteID, row.groupname))) {
    groupMembers.set(key, rows.map((row) => row.userID));
  }
  const joins = groupBy(masa.memberships, (row) => row.userID);
  const oauthUsers = new Set(masa.oauthClients.map((row) => row.userID));
  const reserved = new Set(config.reserved.rehearsal.persons);

  const site = (siteID: SiteKey): SiteRow => {
    const row = sites.get(siteID);
    if (row === undefined) throw new RangeError(`Unknown seeded site: ${siteID}`);
    return row;
  };
  const user = (userID: string): UserRow => {
    const row = users.get(userID);
    if (row === undefined) throw new RangeError(`Unknown seeded user: ${userID}`);
    return row;
  };
  const systemUsers = (siteID: SiteKey): readonly UserRow[] => systemBySite.get(siteID) ?? none;
  const members = (siteID: SiteKey): readonly UserRow[] => membersBySite.get(siteID) ?? none;
  const membersOf = (siteID: SiteKey, groupname: string): readonly string[] =>
    groupMembers.get(groupKey(siteID, groupname)) ?? none;
  const groupFor = (role: Role): string => (role === SITE_ADMIN ? ADMIN_GROUP : roleGroupName(config, role));

  const roleUser = (siteID: SiteKey, role: Role): UserRow => {
    const pool = site(siteID).privateUserPoolID;
    const groupname = role === SYSTEM_USER ? null : groupFor(role);
    const found = systemUsers(pool).find((row) => {
      const held = joins.get(row.userID) ?? none;
      if (groupname === null) return held.length === 0 && !oauthUsers.has(row.userID);
      return held.length === 1 && held.every((m) => m.groupSiteID === pool && m.groupname === groupname);
    });
    if (found === undefined) throw new RangeError(`No ${role} user in site ${siteID}`);
    return found;
  };

  const memberUser = (siteID: SiteKey): UserRow => {
    const [first] = members(siteID);
    if (first === undefined) throw new RangeError(`No member stored in site ${siteID}`);
    return first;
  };

  const actors = (siteID: SiteKey, role: Role): readonly string[] => {
    const ids = membersOf(site(siteID).privateUserPoolID, groupFor(role));
    return role === Roles.timesheetsEmployee ? ids : ids.filter((id) => !reserved.has(id));
  };

  const oauthAccount = (siteID: SiteKey): UserRow => {
    const client = masa.oauthClients.find((row) => row.siteID === siteID);
    if (client === undefined) throw new RangeError(`No OAuth client in site ${siteID}`);
    return user(client.userID);
  };

  return Object.freeze({
    site,
    user,
    systemUsers,
    members,
    publicPoolMembers: (siteID: SiteKey): readonly UserRow[] => members(site(siteID).publicUserPoolID),
    groups: (siteID: SiteKey): readonly GroupRow[] => groupsBySite.get(siteID) ?? none,
    membersOf,
    roleUser,
    memberUser,
    actors,
    isReserved: (userID: string): boolean => reserved.has(userID),
    oauthAccount,
  });
}
