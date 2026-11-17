/**
 * findProperties metadata of the strategies-content entities, each property's keys and the properties in legacy
 * iteration order (core/mura/client/api/json/v1/jsonApiUtility.cfc:1517-1618).
 */
import type { ContentEntityName } from './jsonapi-entities.js';

/** One property as applyPropertyFormat leaves it. */
export type PropertyFormat = Readonly<Record<string, unknown>>;

/** The findProperties metadata of one entity. */
export interface EntityProperties {
  /** The component's `table`, which findProperties reports to admins and super users. */
  readonly table: string;
  /** getBundleable: the attribute text when the component declares bundleable=true, else false. */
  readonly bundleable: false | 'true';
  /** getOrderBy: the component's `orderby`, '' without one. */
  readonly orderby: string;
  /** Every property findProperties lists without a `properties` list, by lower-cased name, in legacy order. */
  readonly formats: ReadonlyMap<string, PropertyFormat>;
}

type Struct = Record<string, unknown>;
type RelationType = 'many-to-one' | 'one-to-one' | 'one-to-many';

/** Attributes of a column property; `required` is the attribute text `required="true"`, which also clears nullable. */
interface ColumnOptions {
  readonly length?: string;
  readonly required?: boolean;
  readonly html?: boolean;
  readonly listview?: boolean;
  readonly index?: boolean;
  readonly default?: string;
}

/** Attributes of a relation property beyond its fieldtype, name and cfc. */
interface RelationOptions {
  readonly loadkey: string;
  readonly fkcolumn: string;
  readonly length: string;
  readonly datatype: string;
  readonly cascade?: string;
  readonly nullable?: true | 'true';
  readonly renderfield?: string;
  readonly orderby?: string;
  readonly default?: string;
}

/** A column property. */
function column(name: string, datatype: string, opts: ColumnOptions = {}): Struct {
  const required = opts.required === true;
  return {
    fieldtype: opts.index === true ? 'index' : '',
    ...(opts.length === undefined ? {} : { length: opts.length }),
    required: required ? 'true' : false,
    ...(opts.listview === true ? { listview: 'true' } : {}),
    html: opts.html === true ? 'true' : 'false',
    nullable: !required,
    name,
    datatype,
    default: opts.default ?? '',
  };
}

/** A string property; applyPropertyFormat gives a varchar without a length the length 50. */
function varchar(name: string, opts: ColumnOptions = {}): Struct {
  return column(name, 'varchar', { length: '50', ...opts });
}

/** A numeric or integer property. */
function int(name: string, defaultValue: string, opts: Pick<ColumnOptions, 'required'> = {}): Struct {
  return column(name, 'int', { ...opts, default: defaultValue });
}

/** A date or timestamp property. */
function datetime(name: string, defaultValue = ''): Struct {
  return column(name, 'datetime', { default: defaultValue });
}

/** A text property without a default, which getProperties reads as the text 'null'. */
function text(name: string): Struct {
  return column(name, 'text', { default: 'null' });
}

/** The fieldtype=id property; `required` is the attribute text on a bean, true as beanORM.cfc:151-158 sets it. */
function id(name: string, required: boolean | 'true'): Struct {
  return { fieldtype: 'id', length: '35', required, nullable: required === false, html: 'false', name, datatype: 'char', default: '' };
}

/** A relation property; its `cfc` is reported as `relatesto`. */
function relation(fieldtype: RelationType, name: string, relatesto: string, opts: RelationOptions): Struct {
  return {
    fieldtype,
    loadkey: opts.loadkey,
    length: opts.length,
    required: false,
    cascade: opts.cascade ?? 'none',
    nullable: opts.nullable ?? true,
    ...(opts.renderfield === undefined ? {} : { renderfield: opts.renderfield }),
    html: 'false',
    fkcolumn: opts.fkcolumn,
    name,
    datatype: opts.datatype,
    relatesto,
    ...(opts.orderby === undefined ? {} : { orderby: opts.orderby }),
    default: opts.default ?? '',
  };
}

/** A relation loaded by its own char(35) key column. */
function keyed(
  fieldtype: RelationType,
  name: string,
  relatesto: string,
  key: string,
  opts: Pick<RelationOptions, 'nullable'> = {},
): Struct {
  return relation(fieldtype, name, relatesto, { loadkey: key, fkcolumn: key, length: '35', datatype: 'char', ...opts });
}

/** A one-to-many relation, keyed by the bean's primary key unless `loadkey` says otherwise. */
function oneToMany(name: string, relatesto: string, opts: Partial<Pick<RelationOptions, 'loadkey' | 'cascade' | 'orderby'>> = {}): Struct {
  const { loadkey = 'primaryKey', ...rest } = opts;
  return relation('one-to-many', name, relatesto, { loadkey, fkcolumn: 'primaryKey', length: '50', datatype: 'varchar', default: 'null', ...rest });
}

/** The `site` relation over the varchar(25) site id column. */
function site(fieldtype: RelationType, key = 'siteid'): Struct {
  return relation(fieldtype, 'site', 'site', { loadkey: key, fkcolumn: key, length: '25', datatype: 'varchar' });
}

/** Entity metadata with its formats keyed by name. */
function entity(
  attributes: { table: string; bundleable?: 'true'; orderby?: string },
  formats: readonly Struct[],
): EntityProperties {
  return Object.freeze({
    table: attributes.table,
    bundleable: attributes.bundleable ?? false,
    orderby: attributes.orderby ?? '',
    formats: new Map(formats.map((format): [string, PropertyFormat] => [String(format['name']), Object.freeze(format)])),
  });
}

// contentBean.cfc:79-168 with beanExtendable.cfc:83-85; only the properties of the entity's `fields` list are listed.
const CONTENT = entity({ table: 'tcontent' }, [
  varchar('path'),
  varchar('menutitle', { listview: true }),
  varchar('type', { default: 'Page' }),
  varchar('subtype', { default: 'Default' }),
  varchar('remoteurl'),
  varchar('moduleid', { default: '00000000000000000000000000000000000' }),
  datetime('displaystop'),
  varchar('tags'),
  varchar('siteid', { required: true }),
  varchar('summary', { html: true }),
  datetime('displaystart'),
  int('active', '0'),
  int('display', ''),
  id('contenthistid', false),
  varchar('filename'),
  varchar('contentid'),
  varchar('changesetid'),
  varchar('remoteid'),
  varchar('title', { required: true }),
  int('approved', '0'),
]);

/** findProperties metadata by legacy entity name. */
export const ENTITY_PROPERTIES: Readonly<Record<ContentEntityName, EntityProperties>> = Object.freeze({
  contentnav: CONTENT,
  content: CONTENT,
  // contentCommentBean.cfc:76-97; only the properties of the entity's `fields` list are listed.
  comment: entity({ table: 'tcontentcomments', orderby: 'entered asc' }, [
    varchar('path'),
    int('flagcount', '0'),
    int('subscribe', '0'),
    int('isapproved', '0'),
    oneToMany('kids', 'comment', { loadkey: 'parentid', cascade: 'delete', orderby: 'created asc' }),
    varchar('name'),
    varchar('remoteid'),
    int('isdeleted', '0'),
    varchar('userid'),
    int('isspam', '0'),
    datetime('entered'),
  ]),
  // changesetBean.cfc:4-23.
  changeset: entity({ table: 'tchangesets' }, [
    id('changesetid', 'true'),
    datetime('publishdate'),
    oneToMany('categoryassignments', 'changesetCategoryAssignment'),
    varchar('categoryid'),
    varchar('siteid', { required: true }),
    oneToMany('contentassignments', 'content'),
    varchar('name', { required: true }),
    datetime('created'),
    varchar('remoteid'),
    datetime('lastupdate'),
    int('published', '0', { required: true }),
    varchar('remotesourceurl'),
    varchar('description'),
    datetime('remotepubdate'),
    varchar('lastupdateby'),
    datetime('closedate'),
    varchar('tags'),
  ]),
  // feedBean.cfc:79-133 with beanFeed.cfc:78-90.
  feed: entity({ table: 'tcontentfeeds' }, [
    int('displaykids', '0', { required: true }),
    varchar('viewalllink', { default: 'View All' }),
    int('displaycomments', '0', { required: true }),
    int('isfeaturesonly', '0', { required: true }),
    varchar('table'),
    datetime('lastupdate'),
    varchar('additionalcolumns'),
    int('allowhtml', '1', { required: true }),
    varchar('keyfield'),
    varchar('type', { required: true, default: 'local' }),
    int('displayname', '0', { required: true }),
    varchar('categoryid'),
    int('liveonly', '1', { required: true }),
    int('usecategoryintersect', '0'),
    int('isactive', '1', { required: true }),
    varchar('name'),
    varchar('contentpoolid'),
    int('islocked', '0', { required: true }),
    int('includehomepage', '0'),
    varchar('remotesourceurl'),
    varchar('remotepubdate'),
    int('ispublic', '0', { required: true }),
    varchar('restrictgroups'),
    varchar('lang', { required: true, default: 'en-us' }),
    int('restricted', '0', { required: true }),
    int('displayratings', '0', { required: true }),
    varchar('displaylist', { required: true, default: 'Title,Date,Image,Summary,Tags,Credits' }),
    int('nextn', '20', { required: true }),
    varchar('sorttable'),
    int('pageindex', '1'),
    int('isdefault', '0', { required: true }),
    varchar('description'),
    int('autoimport', '0', { required: true }),
    varchar('sortby', { default: 'lastUpdate' }),
    int('maxitems', '20', { required: true }),
    int('showexcludesearch', '0', { required: true }),
    varchar('imageheight', { required: true, default: 'AUTO' }),
    varchar('cssclass'),
    varchar('orderby'),
    varchar('sortdirection', { required: true, default: 'desc' }),
    varchar('alttable'),
    varchar('contentid'),
    site('many-to-one', 'siteID'),
    id('feedid', false),
    varchar('channellink'),
    varchar('siteid'),
    varchar('viewalllabel'),
    varchar('authtype', { default: 'DEFAULT' }),
    varchar('remoteid'),
    varchar('imagesize', { required: true, default: 'small' }),
    varchar('imagewidth', { required: true, default: 'AUTO' }),
    varchar('parentid'),
    int('shownavonly', '1', { required: true }),
    varchar('version', { required: true, default: 'RSS 2.0' }),
    varchar('featuretype', { default: 'either' }),
    varchar('lastupdateby'),
    varchar('altname'),
    datetime('datecreated'),
    varchar('entityname', { default: 'content' }),
  ]),
  // categoryBean.cfc:79-104.
  category: entity({ table: 'tcontentcategories' }, [
    varchar('path'),
    varchar('restrictgroups'),
    oneToMany('contentassignments', 'contentCategoryAssign'),
    oneToMany('kids', 'category', { loadkey: 'parentid', cascade: 'delete', orderby: 'name asc' }),
    int('isfeatureable', '1', { required: true }),
    datetime('lastupdate'),
    varchar('note'),
    relation('many-to-one', 'parent', 'category', { loadkey: 'categoryid', fkcolumn: 'parentid', length: '35', datatype: 'char', renderfield: 'name' }),
    varchar('sortby', { required: true, default: 'orderno' }),
    varchar('filename'),
    varchar('sortdirection', { required: true, default: 'asc' }),
    site('many-to-one'),
    id('categoryid', false),
    int('isactive', '1', { required: true }),
    varchar('name', { required: true }),
    varchar('remoteid'),
    varchar('remotesourceurl'),
    datetime('remotepubdate'),
    varchar('lastupdateby'),
    int('isopen', '1'),
    varchar('urltitle'),
    datetime('datecreated'),
    int('isinterestgroup', '1', { required: true }),
  ]),
  // contentCategoryAssignBean.cfc:77-91; `featureSop` is the bean's spelling.
  contentCategoryAssign: entity({ table: 'tcontentcategoryassign' }, [
    site('many-to-one'),
    datetime('featurestart', 'null'),
    relation('one-to-many', 'kids', 'category', { loadkey: 'parentid', fkcolumn: 'categoryid', length: '35', datatype: 'char', orderby: 'name asc' }),
    datetime('featuresop', 'null'),
    keyed('many-to-one', 'category', 'category', 'categoryid'),
    relation('many-to-one', 'parent', 'category', { loadkey: 'parentid', fkcolumn: 'parentid', length: '50', datatype: 'varchar', default: 'null' }),
    keyed('many-to-one', 'content', 'content', 'contenthistid'),
    keyed('many-to-one', 'activecontent', 'content', 'contentid'),
    int('isfeature', '0'),
  ]),
  // fileBean.cfc:1-33.
  file: entity({ table: 'tfiles' }, [
    varchar('contentsubtype', { length: '200', default: 'null' }),
    id('fileid', true),
    int('deleted', '0'),
    varchar('fileext', { default: 'null' }),
    datetime('created', 'null'),
    varchar('alttext', { length: '255', default: 'null' }),
    keyed('one-to-one', 'content', 'content', 'contentid', { nullable: 'true' }),
    varchar('filename', { length: '200', default: 'null' }),
    site('many-to-one'),
    int('filesize', '0'),
    varchar('credits', { length: '255', default: 'null' }),
    varchar('remoteurl', { length: '255', default: 'null' }),
    varchar('contenttype', { length: '100', default: 'null' }),
    column('moduleid', 'char', { length: '35', default: '00000000000000000000000000000000000' }),
    text('exif'),
    varchar('remoteid', { length: '255', index: true, default: 'null' }),
    varchar('remotesourceurl', { length: '255', default: 'null' }),
    varchar('remotesource', { length: '255', default: 'null' }),
    datetime('remotepubdate', 'null'),
    text('caption'),
  ]),
  // contentFileMetaDataBean.cfc:77-111 with beanORMVersioned.cfc:78-80.
  fileMetaData: entity({ table: 'tcontentfilemetadata', bundleable: 'true' }, [
    varchar('alttext', { length: '255', default: 'null' }),
    keyed('many-to-one', 'content', 'content', 'contenthistid'),
    keyed('many-to-one', 'file', 'file', 'fileid'),
    text('credits'),
    site('one-to-one', 'siteID'),
    varchar('remoteurl', { length: '255', default: 'null' }),
    text('exif'),
    varchar('remoteid', { length: '255', index: true, default: 'null' }),
    varchar('remotesourceurl', { length: '255', default: 'null' }),
    varchar('remotesource', { length: '255', default: 'null' }),
    datetime('remotepubdate', 'null'),
    id('metaid', true),
    keyed('many-to-one', 'activecontent', 'content', 'contentid'),
    text('caption'),
  ]),
  // changesetCategoryAssignmentBean.cfc:1-7.
  changesetCategoryAssignment: entity({ table: 'tchangesetcategoryassign', bundleable: 'true' }, [
    site('many-to-one'),
    keyed('many-to-one', 'category', 'category', 'categoryid'),
    keyed('many-to-one', 'changeset', 'changeset', 'changesetid'),
    id('assignmentid', true),
  ]),
  // contentStatsBean.cfc:76-93.
  stats: entity({ table: 'tcontentstats' }, [
    site('many-to-one'),
    int('downvotes', '0', { required: true }),
    int('totalvotes', '0', { required: true }),
    int('majorversion', '0', { required: true }),
    int('minorversion', '0', { required: true }),
    varchar('locktype', { required: true }),
    int('comments', '0', { required: true }),
    int('disablecomments', '0', { required: true }),
    varchar('lockid', { required: true }),
    int('views', '0', { required: true }),
    int('rating', '0', { required: true }),
    int('upvotes', '0', { required: true }),
    keyed('many-to-one', 'content', 'content', 'contentid'),
  ]),
  // contentVariationTargetingBean.cfc:76-86.
  variationTargeting: entity({ table: 'tcontentvariationtargeting', bundleable: 'true' }, [
    id('targetingid', true),
    site('many-to-one'),
    text('initjs'),
    text('targetingjs'),
    keyed('one-to-one', 'content', 'content', 'contentid'),
  ]),
});
