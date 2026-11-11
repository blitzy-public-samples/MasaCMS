/** Owned tables of schema `programs_sites`, as the platform repository declares them. */
import type { CanonicalColumn, RepositoryRow, TableDefinition } from '@opt2/platform/migration-kit';

// programs_sites.trash is a unit because opt2/table-ownership.json assigns the tsettings extendObject share of ttrash here.
/** Units of write authority of schema `programs_sites`, as `opt2/table-ownership.json` names them, in declaration order. */
export const UNITS = [
  'programs_sites.site',
  'programs_sites.image_size',
  'programs_sites.directory',
  'programs_sites.system_object',
  'programs_sites.extend_subtype',
  'programs_sites.extend_set',
  'programs_sites.extend_attribute',
  'programs_sites.extend_rc_set',
  'programs_sites.extend_data',
  'programs_sites.trash',
] as const;

/** One programs-sites unit id. */
export type ProgramsSitesUnit = (typeof UNITS)[number];

/** A gated programs-sites table definition whose unit is `U`. */
export interface ProgramsSitesTableDefinition<U extends ProgramsSitesUnit = ProgramsSitesUnit> extends TableDefinition {
  unit: U;
}

const TENANT_ID: CanonicalColumn = { name: 'tenant_id', type: 's' };
const LEGACY_ROW_HASH: CanonicalColumn = { name: 'legacy_row_hash', type: 's' };
const OCCURRENCE: CanonicalColumn = { name: 'occurrence', type: 'i' };

/** `programs_sites.site`, from Masa `tsettings`, plus the target-only `row_version`. */
export const SITE: ProgramsSitesTableDefinition<'programs_sites.site'> = {
  table: 'site',
  columns: [
    TENANT_ID,
    { name: 'siteid', type: 's' },
    { name: 'site', type: 's' },
    { name: 'maxnestlevel', type: 'i' },
    { name: 'pagelimit', type: 'i' },
    { name: 'locking', type: 's' },
    { name: 'domain', type: 's' },
    { name: 'exportlocation', type: 's' },
    { name: 'filedir', type: 's' },
    { name: 'contact', type: 's' },
    { name: 'mailserverip', type: 's' },
    { name: 'mailserverusername', type: 's' },
    { name: 'mailserverpassword', type: 's' },
    { name: 'emailbroadcaster', type: 'i' },
    { name: 'extranet', type: 'i' },
    { name: 'extranetpublicreg', type: 'i' },
    { name: 'extranetpublicregnotify', type: 's' },
    { name: 'extranetssl', type: 'i' },
    { name: 'cache', type: 'i' },
    { name: 'viewdepth', type: 'i' },
    { name: 'nextn', type: 'i' },
    { name: 'datacollection', type: 'i' },
    { name: 'columncount', type: 'i' },
    { name: 'columnnames', type: 's' },
    { name: 'primarycolumn', type: 'i' },
    { name: 'publicsubmission', type: 'i' },
    { name: 'archivedate', type: 't' },
    { name: 'contactname', type: 's' },
    { name: 'contactaddress', type: 's' },
    { name: 'contactcity', type: 's' },
    { name: 'contactstate', type: 's' },
    { name: 'contactzip', type: 's' },
    { name: 'contactemail', type: 's' },
    { name: 'contactphone', type: 's' },
    { name: 'privateuserpoolid', type: 's' },
    { name: 'publicuserpoolid', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'emailbroadcasterlimit', type: 'i' },
    { name: 'feedmanager', type: 'i' },
    { name: 'displaypoolid', type: 's' },
    { name: 'gallerymainscaleby', type: 's' },
    { name: 'gallerymainscale', type: 'i' },
    { name: 'gallerysmallscaleby', type: 's' },
    { name: 'gallerysmallscale', type: 'i' },
    { name: 'gallerymediumscaleby', type: 's' },
    { name: 'gallerymediumscale', type: 'i' },
    { name: 'sendloginscript', type: 's' },
    { name: 'mailinglistconfirmscript', type: 's' },
    { name: 'publicsubmissionapprovalscript', type: 's' },
    { name: 'reminderscript', type: 's' },
    { name: 'loginurl', type: 's' },
    { name: 'editprofileurl', type: 's' },
    { name: 'commentapprovaldefault', type: 'i' },
    { name: 'deploy', type: 'i' },
    { name: 'lastdeployment', type: 't' },
    { name: 'accountactivationscript', type: 's' },
    { name: 'googleapikey', type: 's' },
    { name: 'usedefaultsmtpserver', type: 'i' },
    { name: 'theme', type: 's' },
    { name: 'mailserversmtpport', type: 's' },
    { name: 'mailserverpopport', type: 's' },
    { name: 'mailservertls', type: 's' },
    { name: 'mailserverssl', type: 's' },
    { name: 'sitelocale', type: 's' },
    { name: 'domainalias', type: 's' },
    { name: 'cachecapacity', type: 'i' },
    { name: 'cachefreememorythreshold', type: 'i' },
    { name: 'tagline', type: 's' },
    { name: 'haschangesets', type: 'i' },
    { name: 'baseid', type: 's' },
    { name: 'enforceprimarydomain', type: 'i' },
    { name: 'enforcechangesets', type: 'i' },
    { name: 'smallimageheight', type: 's' },
    { name: 'smallimagewidth', type: 's' },
    { name: 'mediumimageheight', type: 's' },
    { name: 'mediumimagewidth', type: 's' },
    { name: 'largeimageheight', type: 's' },
    { name: 'largeimagewidth', type: 's' },
    { name: 'contentapprovalscript', type: 's' },
    { name: 'contentrejectionscript', type: 's' },
    { name: 'hascomments', type: 'i' },
    { name: 'haslockablenodes', type: 'i' },
    { name: 'enablelockdown', type: 's' },
    { name: 'customtaggroups', type: 's' },
    { name: 'filepoolid', type: 's' },
    { name: 'categorypoolid', type: 's' },
    { name: 'contentpoolid', type: 's' },
    { name: 'sendauthcodescript', type: 's' },
    { name: 'recaptchasitekey', type: 's' },
    { name: 'recaptchasecret', type: 's' },
    { name: 'recaptchalanguage', type: 's' },
    { name: 'jsonapi', type: 'i' },
    { name: 'usessl', type: 'i' },
    { name: 'isremote', type: 'i' },
    { name: 'resourcessl', type: 'i' },
    { name: 'resourcedomain', type: 's' },
    { name: 'remoteport', type: 'i' },
    { name: 'remotecontext', type: 's' },
    { name: 'contentpendingscript', type: 's' },
    { name: 'contentcanceledscript', type: 's' },
    { name: 'showdashboard', type: 'i' },
    { name: 'placeholderimgid', type: 's' },
    { name: 'placeholderimgext', type: 's' },
    { name: 'scaffolding', type: 'i' },
    { name: 'row_version', type: 'i' },
  ],
  key: ['siteid'],
  unit: 'programs_sites.site',
};

/** `programs_sites.image_size`, from Masa `timagesizes`. */
export const IMAGE_SIZE: ProgramsSitesTableDefinition<'programs_sites.image_size'> = {
  table: 'image_size',
  columns: [
    TENANT_ID,
    { name: 'sizeid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'height', type: 's' },
    { name: 'width', type: 's' },
  ],
  key: ['sizeid'],
  unit: 'programs_sites.image_size',
};

/** `programs_sites.directory`, from Masa `tdirectories`. */
export const DIRECTORY: ProgramsSitesTableDefinition<'programs_sites.directory'> = {
  table: 'directory',
  columns: [
    TENANT_ID,
    { name: 'dirid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'subdir', type: 's' },
    { name: 'editfilename', type: 's' },
  ],
  key: ['dirid'],
  unit: 'programs_sites.directory',
};

/** `programs_sites.system_object`, from Masa `tsystemobjects`; keyless, rows matched as a multiset. */
export const SYSTEM_OBJECT: ProgramsSitesTableDefinition<'programs_sites.system_object'> = {
  table: 'system_object',
  columns: [
    TENANT_ID,
    { name: 'object', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'orderno', type: 'i' },
    LEGACY_ROW_HASH,
    OCCURRENCE,
  ],
  key: null,
  unit: 'programs_sites.system_object',
};

/** `programs_sites.extend_subtype`, the `baseTable = tsettings` rows of Masa `tclassextend`. */
export const EXTEND_SUBTYPE: ProgramsSitesTableDefinition<'programs_sites.extend_subtype'> = {
  table: 'extend_subtype',
  columns: [
    TENANT_ID,
    { name: 'subtypeid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'basetable', type: 's' },
    { name: 'basekeyfield', type: 's' },
    { name: 'datatable', type: 's' },
    { name: 'type', type: 's' },
    { name: 'subtype', type: 's' },
    { name: 'isactive', type: 'i' },
    { name: 'notes', type: 's' },
    { name: 'lastupdate', type: 't' },
    { name: 'datecreated', type: 't' },
    { name: 'lastupdateby', type: 's' },
    { name: 'hassummary', type: 'i' },
    { name: 'hasbody', type: 'i' },
    { name: 'description', type: 's' },
    { name: 'availablesubtypes', type: 's' },
    { name: 'iconclass', type: 's' },
    { name: 'hasassocfile', type: 'i' },
    { name: 'hasconfigurator', type: 'i' },
    { name: 'adminonly', type: 'i' },
  ],
  key: ['subtypeid'],
  unit: 'programs_sites.extend_subtype',
};

/** `programs_sites.extend_set`, the Masa `tclassextendsets` rows of site subtypes. */
export const EXTEND_SET: ProgramsSitesTableDefinition<'programs_sites.extend_set'> = {
  table: 'extend_set',
  columns: [
    TENANT_ID,
    { name: 'extendsetid', type: 's' },
    { name: 'subtypeid', type: 's' },
    { name: 'categoryid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'isactive', type: 'i' },
    { name: 'container', type: 's' },
  ],
  key: ['extendsetid'],
  unit: 'programs_sites.extend_set',
};

/** `programs_sites.extend_attribute`, the Masa `tclassextendattributes` rows of site extend sets. */
export const EXTEND_ATTRIBUTE: ProgramsSitesTableDefinition<'programs_sites.extend_attribute'> = {
  table: 'extend_attribute',
  columns: [
    TENANT_ID,
    { name: 'attributeid', type: 'i' },
    { name: 'extendsetid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'label', type: 's' },
    { name: 'hint', type: 's' },
    { name: 'type', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'isactive', type: 'i' },
    { name: 'required', type: 's' },
    { name: 'validation', type: 's' },
    { name: 'regex', type: 's' },
    { name: 'message', type: 's' },
    { name: 'defaultvalue', type: 's' },
    { name: 'optionlist', type: 's' },
    { name: 'optionlabellist', type: 's' },
    { name: 'adminonly', type: 'i' },
  ],
  key: ['attributeid'],
  unit: 'programs_sites.extend_attribute',
};

/** `programs_sites.extend_rc_set`, the Masa `tclassextendrcsets` rows of site subtypes. */
export const EXTEND_RC_SET: ProgramsSitesTableDefinition<'programs_sites.extend_rc_set'> = {
  table: 'extend_rc_set',
  columns: [
    TENANT_ID,
    { name: 'subtypeid', type: 's' },
    { name: 'availablesubtypes', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'entitytype', type: 's' },
    { name: 'name', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'relatedcontentsetid', type: 's' },
  ],
  key: ['relatedcontentsetid'],
  unit: 'programs_sites.extend_rc_set',
};

/** `programs_sites.extend_data`, the Masa `tclassextenddata` rows of site attributes. */
export const EXTEND_DATA: ProgramsSitesTableDefinition<'programs_sites.extend_data'> = {
  table: 'extend_data',
  columns: [
    TENANT_ID,
    { name: 'dataid', type: 'i' },
    { name: 'baseid', type: 's' },
    { name: 'attributeid', type: 'i' },
    { name: 'siteid', type: 's' },
    { name: 'attributevalue', type: 's' },
    { name: 'remoteid', type: 's' },
    { name: 'datetimevalue', type: 't' },
    { name: 'numericvalue', type: 'f' },
    { name: 'stringvalue', type: 's' },
  ],
  key: ['dataid'],
  unit: 'programs_sites.extend_data',
};

/** `programs_sites.trash`, the Masa `ttrash` rows of site extend objects; `objectstring` is byte-exact WDDX. */
export const TRASH: ProgramsSitesTableDefinition<'programs_sites.trash'> = {
  table: 'trash',
  columns: [
    TENANT_ID,
    { name: 'objectid', type: 's' },
    { name: 'parentid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'objectlabel', type: 's' },
    { name: 'objectclass', type: 's' },
    { name: 'objecttype', type: 's' },
    { name: 'objectsubtype', type: 's' },
    { name: 'objectstring', type: 's' },
    { name: 'deleteddate', type: 't' },
    { name: 'deletedby', type: 's' },
    { name: 'deleteid', type: 's' },
    { name: 'orderno', type: 'i' },
  ],
  key: ['objectid'],
  unit: 'programs_sites.trash',
};

/** `programs_sites.sitemonitor_state`, the site-monitor cursor; no unit, so it is never migrated, projected or gated. */
export const SITE_MONITOR_STATE: TableDefinition = {
  table: 'sitemonitor_state',
  columns: [
    TENANT_ID,
    { name: 'id', type: 'i' },
    { name: 'last_monitored', type: 't' },
    { name: 'updated_at', type: 't' },
  ],
  key: ['id'],
};

/** Table definitions position for position with the unit tuple `T`. */
type TablesForUnits<T extends readonly ProgramsSitesUnit[]> = { readonly [I in keyof T]: TableDefinition & { unit: T[I] } };

/** Every owned unit table, in `UNITS` order; the `tables` of the programs-sites repository. */
export const OWNED_TABLES: TablesForUnits<typeof UNITS> = [
  SITE,
  IMAGE_SIZE,
  DIRECTORY,
  SYSTEM_OBJECT,
  EXTEND_SUBTYPE,
  EXTEND_SET,
  EXTEND_ATTRIBUTE,
  EXTEND_RC_SET,
  EXTEND_DATA,
  TRASH,
];

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** Any owned row as pg returns it, keyed by column name. */
export type ProgramsSitesRow = Readonly<RepositoryRow>;

/** A `programs_sites.site` row as pg returns it; the int8 `row_version` arrives as a decimal string. */
export type SiteRow = ProgramsSitesRow & {
  tenant_id: string;
  siteid: string;
  orderno: number | null;
  deploy: number | null;
  lastdeployment: Date | null;
  baseid: string | null;
  row_version: string;
  publicuserpoolid: string | null;
  privateuserpoolid: string | null;
  displaypoolid: string | null;
  filepoolid: string | null;
  categorypoolid: string | null;
  contentpoolid: string | null;
};

/** A `programs_sites.image_size` row as pg returns it. */
export type ImageSizeRow = {
  tenant_id: string;
  sizeid: string;
  siteid: string | null;
  name: string | null;
  height: string | null;
  width: string | null;
};

/** A `programs_sites.extend_subtype` row as pg returns it. */
export type ExtendSubtypeRow = {
  tenant_id: string;
  subtypeid: string;
  siteid: string | null;
  basetable: string | null;
  basekeyfield: string | null;
  datatable: string | null;
  type: string | null;
  subtype: string | null;
  isactive: number | null;
  notes: string | null;
  lastupdate: Date | null;
  datecreated: Date | null;
  lastupdateby: string | null;
  hassummary: number | null;
  hasbody: number | null;
  description: string | null;
  availablesubtypes: string | null;
  iconclass: string | null;
  hasassocfile: number | null;
  hasconfigurator: number | null;
  adminonly: number | null;
};

/** A `programs_sites.extend_set` row as pg returns it. */
export type ExtendSetRow = {
  tenant_id: string;
  extendsetid: string;
  subtypeid: string | null;
  categoryid: string | null;
  siteid: string | null;
  name: string | null;
  orderno: number | null;
  isactive: number | null;
  container: string | null;
};

/** A `programs_sites.extend_attribute` row as pg returns it. */
export type ExtendAttributeRow = {
  tenant_id: string;
  attributeid: number;
  extendsetid: string | null;
  siteid: string | null;
  name: string | null;
  label: string | null;
  hint: string | null;
  type: string | null;
  orderno: number | null;
  isactive: number | null;
  required: string | null;
  validation: string | null;
  regex: string | null;
  message: string | null;
  defaultvalue: string | null;
  optionlist: string | null;
  optionlabellist: string | null;
  adminonly: number | null;
};

/** A `programs_sites.extend_rc_set` row as pg returns it. */
export type ExtendRcSetRow = {
  tenant_id: string;
  subtypeid: string | null;
  availablesubtypes: string | null;
  siteid: string | null;
  entitytype: string | null;
  name: string;
  orderno: number | null;
  relatedcontentsetid: string;
};

/** A `programs_sites.extend_data` row as pg returns it. */
export type ExtendDataRow = {
  tenant_id: string;
  dataid: number;
  baseid: string;
  attributeid: number;
  siteid: string | null;
  attributevalue: string | null;
  remoteid: string | null;
  datetimevalue: Date | null;
  numericvalue: number | null;
  stringvalue: string | null;
};

