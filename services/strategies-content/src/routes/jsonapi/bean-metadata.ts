/** The content beans' cfproperty declarations, and getProperties and getValidations over them (bean.cfc:620-1266; beanORM.cfc:81-158). */
import { acfKeyOrder, cfEq, cfIsBoolean, cfIsNumeric, cfToBoolean, cfUuid } from '@opt2/platform/legacy-compat';
import { CfNumber, CfStruct, type CfValue } from './cfml-values.js';

/** A cfproperty attribute value as getMetaData reports it. */
type Attr = string | number | boolean;
/** One cfproperty: its name and attributes as declared. */
type PropertyDecl = readonly [name: string, attrs?: Readonly<Record<string, Attr>>];

/** One component of a bean's `extends` chain: its own properties, then its parent's. */
interface BeanClass {
  readonly props: readonly PropertyDecl[];
  readonly parent?: BeanClass;
  /** A beanORM bean, whose primary key is required (beanORM.cfc:151-158). */
  readonly orm?: boolean;
}

/** One entry of `application.objectMappings[entity].properties`, attribute names lower-cased. */
export type BeanProperty = ReadonlyMap<string, Attr>;

/** A bean's mapped properties and generated validations. */
export interface BeanModel {
  /** Properties by name, in assignment order. */
  readonly properties: ReadonlyMap<string, BeanProperty>;
  /** getValidations(): `{properties: {ruleKey: [rules]}}`. */
  readonly validations: CfStruct;
  hasProperty(name: string): boolean;
}

const T = 'true';
const F = 'false';
const ORDER_NO_ROOT = '00000000000000000000000000000000000';
const VARCHAR_255 = { type: 'varchar', length: 255 } as const;

const BEAN: BeanClass = {
  props: [
    ['errors', { type: 'struct', persistent: F, comparable: F }],
    ['isNew', { type: 'numeric', persistent: F, default: '1' }],
    ['fromMuraCache', { type: 'boolean', default: F, persistent: F, comparable: F }],
    ['instanceID', { type: 'string', persistent: F, comparable: F }],
  ],
};

const EXTENDABLE: BeanClass = {
  parent: BEAN,
  props: [
    ['extendData', { type: 'any', default: '', comparable: F, persistent: F }],
    ['extendSetID', { type: 'string', default: '', comparable: F, persistent: F }],
    ['extendDataTable', { type: 'string', default: 'tclassextenddata', required: T, comparable: F, persistent: F }],
    ['type', { type: 'string', default: 'Custom' }],
    ['subType', { type: 'string', default: 'Default' }],
    ['siteID', { type: 'string', default: '', required: T }],
    ['extendAutoComplete', { type: 'boolean', default: T, required: T, comparable: F, persistent: F }],
  ],
};

const ORM: BeanClass = { parent: BEAN, orm: true, props: [['saveErrors', { type: 'boolean', persistent: F, comparable: F, default: false }]] };

const ORM_VERSIONED: BeanClass = {
  parent: ORM,
  orm: true,
  props: [
    ['activeContent', { fieldtype: 'many-to-one', cfc: 'content', fkcolumn: 'contentid' }],
    ['content', { fieldtype: 'many-to-one', cfc: 'content', fkcolumn: 'contenthistid', comparable: false }],
    ['site', { fieldtype: 'one-to-one', cfc: 'site', fkcolumn: 'siteID' }],
  ],
};

const BEAN_FEED: BeanClass = {
  parent: BEAN,
  props: [
    ['entityName', { type: 'string', default: '' }],
    ['table', { type: 'string', default: '' }],
    ['keyField', { type: 'string', default: '' }],
    ['nextN', { type: 'numeric', default: '0', required: T }],
    ['maxItems', { type: 'numeric', default: '1000', required: T }],
    ['siteID', { type: 'string', default: '' }],
    ['contentpoolid', { type: 'string', default: '' }],
    ['sortBy', { type: 'string', default: '' }],
    ['sortDirection', { type: 'string', default: 'asc', required: T }],
    ['orderby', { type: 'string', default: '' }],
    ['additionalColumns', { type: 'string', default: '' }],
    ['sortTable', { type: 'string', default: '' }],
    ['pageIndex', { type: 'numeric', default: '1' }],
  ],
};

const s = (name: string, attrs: Readonly<Record<string, Attr>> = {}): PropertyDecl => [name, { type: 'string', default: '', ...attrs }];
const n = (name: string, value: string, attrs: Readonly<Record<string, Attr>> = {}): PropertyDecl => [name, { type: 'numeric', default: value, ...attrs }];
const d = (name: string, attrs: Readonly<Record<string, Attr>> = {}): PropertyDecl => [name, { type: 'date', default: '', ...attrs }];

/** contentBean.cfc:81-166. */
const CONTENT: BeanClass = {
  parent: EXTENDABLE,
  props: [
    s('contentHistID', { fieldtype: 'id', comparable: F }),
    s('contentID', { comparable: F }),
    ['kids', { fieldtype: 'one-to-many', cfc: 'content', nested: true, fkcolumn: 'contentid', orderby: 'created asc', cascade: 'delete' }],
    ['parent', { fieldtype: 'many-to-one', cfc: 'content', fkcolumn: 'parentid', required: T }],
    ['site', { fieldtype: 'many-to-one', cfc: 'site', fkcolumn: 'siteID', required: T }],
    ['categoryAssignments', { fieldtype: 'one-to-many', cfc: 'contentCategoryAssign', loadkey: 'contenthistid' }],
    ['changeset', { fieldtype: 'many-to-one', cfc: 'changeset', fkcolumn: 'changesetid' }],
    ['comments', { fieldtype: 'one-to-many', cfc: 'comment', fkcolumn: 'contentid' }],
    ['stats', { fieldtype: 'one-to-one', cfc: 'stats', fkcolumn: 'contentid' }],
    s('preserveID', { comparable: F, persistent: F }),
    n('active', '0', { comparable: F }),
    n('approved', '0', { comparable: F }),
    n('orderno', '0', { comparable: F }),
    s('metaDesc'),
    s('metaKeyWords'),
    d('displayStart'),
    d('displayStop'),
    s('body', { html: T }),
    s('title', { required: T }),
    s('menuTitle', { listview: true }),
    s('URLTitle'),
    s('HTMLTitle'),
    s('filename'),
    s('oldfilename'),
    d('lastUpdate', { comparable: F }),
    n('display', ''),
    s('type', { default: 'Page' }),
    s('newfile'),
    s('lastUpdateBy'),
    s('lastUpdateByID', { comparable: F }),
    s('summary', { html: T }),
    s('moduleID', { default: ORDER_NO_ROOT }),
    n('isNav', '1'),
    n('restricted', '0'),
    s('target', { default: '_self' }),
    s('restrictGroups'),
    s('template'),
    s('childTemplate'),
    s('responseMessage', { html: T }),
    n('responseChart', '0'),
    s('responseSendTo'),
    s('responseDisplayFields'),
    s('moduleAssign'),
    s('notes'),
    s('inheritObjects', { default: 'Inherit' }),
    n('isFeature', '0'),
    n('isNew', '1', { persistent: F }),
    d('releaseDate'),
    n('isLocked', '0', { persistent: F }),
    n('nextN', '10'),
    s('sortBy', { default: 'orderno' }),
    s('sortDirection', { default: 'asc' }),
    d('featureStart'),
    d('featureStop'),
    s('fileID'),
    ['fileSize', { type: 'any', default: '0', persistent: F }],
    s('fileExt', { persistent: F }),
    s('contentType', { persistent: F }),
    s('contentSubType', { persistent: F }),
    n('forceSSL', '0'),
    s('remoteURL'),
    s('remoteID'),
    s('remotePubDate'),
    s('remoteSource'),
    s('remoteSourceURL'),
    s('credits'),
    s('audience'),
    s('keyPoints', { persistent: F }),
    n('searchExclude', '0'),
    n('displayTitle', '1'),
    s('path'),
    s('tags'),
    n('doCache', '1', { persistent: F }),
    d('created'),
    n('mobileExclude', '0'),
    s('changesetID', { comparable: F }),
    s('imageSize', { default: 'small' }),
    s('imageHeight', { default: 'AUTO' }),
    s('imageWidth', { default: 'AUTO' }),
    n('majorVersion', '0', { persistent: F }),
    n('minorVersion', '0', { persistent: F }),
    d('expires'),
    s('assocFilename', { persistent: F }),
    ['displayInterval', { type: 'any', default: 'Daily' }],
    s('requestID', { comparable: F }),
    s('approvalStatus', { persistent: F }),
    s('approvalGroupID', { comparable: F, persistent: F }),
    ['approvalChainOverride', { type: 'boolean', default: F, comparable: F, persistent: F }],
    ['relatedContentSetData', { type: 'any', persistent: F }],
  ],
};

/** contentCommentBean.cfc:77-95. */
const COMMENT: BeanClass = {
  parent: BEAN,
  props: [
    s('commentID', { fieldType: 'id' }),
    ['content', { fieldtype: 'many-to-one', fkcolumn: 'contentid', cfc: 'content' }],
    ['kids', { fieldtype: 'one-to-many', cfc: 'comment', nested: T, orderby: 'created asc', cascade: 'delete' }],
    ['parent', { fieldtype: 'many-to-one', cfc: 'comment', fkcolumn: 'parentid' }],
    ['site', { fieldtype: 'many-to-one', cfc: 'site', fkcolumn: 'siteID' }],
    s('comments', { required: T }),
    s('url'),
    s('name'),
    ['email', { required: T, validate: 'email', default: '' }],
    d('entered'),
    n('subscribe', '0'),
    n('isApproved', '0'),
    s('userID'),
    s('path'),
    s('remoteID'),
    n('isNew', '1', { persistent: F }),
    n('isSpam', '0'),
    n('isDeleted', '0'),
    n('flagCount', '0'),
  ],
};

/** categoryBean.cfc:80-103. */
const CATEGORY: BeanClass = {
  parent: BEAN,
  props: [
    ['categoryID', { fieldtype: 'id' }],
    ['kids', { fieldtype: 'one-to-many', cfc: 'category', loadkey: 'parentid', nested: true, orderby: 'name asc', cascade: 'delete' }],
    ['parent', { fieldtype: 'many-to-one', cfc: 'category', fkcolumn: 'parentid', loadkey: 'categoryid', renderfield: 'name' }],
    ['contentAssignments', { fieldtype: 'one-to-many', cfc: 'contentCategoryAssign' }],
    ['site', { fieldtype: 'many-to-one', cfc: 'site', fkcolumn: 'siteid' }],
    d('dateCreated'),
    d('lastUpdate'),
    s('lastUpdateBy'),
    s('name', { required: T }),
    n('isInterestGroup', '1', { required: T }),
    n('isActive', '1', { required: T }),
    n('isOpen', '1'),
    s('note'),
    s('sortBy', { default: 'orderno', required: T }),
    s('sortDirection', { default: 'asc', required: T }),
    s('restrictGroups'),
    s('path'),
    s('remoteID'),
    s('remoteSourceURL'),
    d('remotePubDate'),
    s('URLtitle'),
    s('filename'),
    n('isNew', '1', { required: T, persistent: F }),
    n('isFeatureable', '1', { required: T }),
  ],
};

/** contentCategoryAssignBean.cfc:79-91. */
const CONTENT_CATEGORY_ASSIGN: BeanClass = {
  parent: ORM,
  orm: true,
  props: [
    ['content', { fieldtype: 'many-to-one', cfc: 'content', fkcolumn: 'contenthistid', loadkey: 'contenthistid' }],
    ['activeContent', { fieldtype: 'many-to-one', cfc: 'content', fkcolumn: 'contentid', loadkey: 'contentid' }],
    ['category', { fieldtype: 'many-to-one', cfc: 'category', fkcolumn: 'categoryid' }],
    ['parent', { fieldtype: 'many-to-one', cfc: 'category', fkcolumn: 'parentid', persistent: false }],
    ['kids', { fieldtype: 'one-to-many', cfc: 'category', fkcolumn: 'categoryid', loadkey: 'parentid', nested: true, orderby: 'name asc' }],
    ['site', { fieldtype: 'many-to-one', cfc: 'site', fkcolumn: 'siteid' }],
    ['isfeature', { datatype: 'int', default: 0 }],
    ['featureStart', { datatype: 'datetime' }],
    ['featureSop', { datatype: 'datetime' }],
    ['categoryName', { datatype: 'varchar', length: 250, persistent: false, default: '' }],
    ['parentName', { datatype: 'varchar', length: 250, persistent: false, default: '' }],
    ['filename', { datatype: 'varchar', length: 250, persistent: false, default: '' }],
    ['path', { datatype: 'varchar', length: 250, persistent: false, default: '' }],
  ],
};

/** fileBean.cfc:3-33, whose GPS properties are commented out. */
const FILE: BeanClass = {
  parent: ORM,
  orm: true,
  props: [
    ['fileid', { fieldtype: 'id' }],
    ['content', { fieldtype: 'one-to-one', fkcolumn: 'contentid', cfc: 'content', required: false, nullable: true }],
    ['site', { fieldtype: 'many-to-one', fkcolumn: 'siteid', cfc: 'site' }],
    ['filename', { datatype: 'varchar', length: 200 }],
    ['contentType', { datatype: 'varchar', length: 100 }],
    ['contentSubType', { datatype: 'varchar', length: 200 }],
    ['fileSize', { datatype: 'int', default: 0 }],
    ['fileExt', { datatype: 'varchar', length: 50 }],
    ['moduleid', { datatype: 'char', default: ORDER_NO_ROOT, length: 35 }],
    ['created', { datatype: 'datetime' }],
    ['deleted', { datatype: 'int', default: 0 }],
    ['caption', { datatype: 'text' }],
    ['credits', { datatype: 'varchar', length: 255 }],
    ['alttext', { datatype: 'varchar', length: 255 }],
    ['fileField', { default: 'newfile', persistent: false }],
    ['remoteID', { ...VARCHAR_255, fieldtype: 'index' }],
    ['remoteURL', VARCHAR_255],
    ['remotePubDate', { type: 'datetime' }],
    ['remoteSource', VARCHAR_255],
    ['remoteSourceURL', VARCHAR_255],
    ['exif', { datatype: 'text' }],
  ],
};

/** contentFileMetaDataBean.cfc:84-111. */
const FILE_META_DATA: BeanClass = {
  parent: ORM_VERSIONED,
  orm: true,
  props: [
    ['metaID', { fieldType: 'id' }],
    ['file', { fieldType: 'many-to-one', cfc: 'file', fkcolumn: 'fileid' }],
    ['altText', { dataType: 'varchar', length: '255' }],
    ['caption', { datatype: 'text' }],
    ['credits', { datatype: 'text' }],
    ['filename', { type: 'string', default: '', persistent: false }],
    ['filesize', { type: 'integer', default: '0', persistent: false }],
    ['contentType', { type: 'string', default: '', persistent: false }],
    ['contentSubType', { type: 'string', default: '', persistent: false }],
    ['fileExt', { type: 'string', default: '', persistent: false }],
    ['created', { type: 'datetime', persistent: false }],
    ['directImages', { type: 'boolean', default: true, persistent: false }],
    ['remoteID', { ...VARCHAR_255, fieldtype: 'index' }],
    ['remoteURL', VARCHAR_255],
    ['remotePubDate', { type: 'datetime' }],
    ['remoteSource', VARCHAR_255],
    ['remoteSourceURL', VARCHAR_255],
    ['exif', { datatype: 'text' }],
  ],
};

/** changesetBean.cfc:5-22. */
const CHANGESET: BeanClass = {
  parent: BEAN,
  props: [
    s('changesetID', { fieldtype: 'id', required: T }),
    s('siteID', { required: T }),
    s('name', { required: T }),
    d('created'),
    s('description'),
    d('publishDate'),
    n('published', '0', { required: T }),
    s('remoteID'),
    s('remoteSourceURL'),
    d('remotePubDate'),
    d('lastUpdate'),
    s('lastUpdateBy'),
    d('closeDate'),
    s('categoryID'),
    s('tags'),
    n('isNew', '1', { required: T, persistent: F }),
    ['categoryAssignments', { fieldtype: 'one-to-many', cfc: 'changesetCategoryAssignment' }],
    ['contentAssignments', { fieldtype: 'one-to-many', cfc: 'content' }],
  ],
};

/** changesetCategoryAssignmentBean.cfc:4-7. */
const CHANGESET_CATEGORY_ASSIGNMENT: BeanClass = {
  parent: ORM,
  orm: true,
  props: [
    ['assignmentid', { fieldtype: 'id' }],
    ['changeset', { fieldtype: 'many-to-one', cfc: 'changeset', fkcolumn: 'changesetid' }],
    ['site', { fieldtype: 'many-to-one', cfc: 'site', fkcolumn: 'siteid' }],
    ['category', { fieldtype: 'many-to-one', cfc: 'category', fkcolumn: 'categoryid' }],
  ],
};

/** feedBean.cfc:80-133. */
const FEED: BeanClass = {
  parent: BEAN_FEED,
  props: [
    s('feedID', { fieldtype: 'id' }),
    ['site', { fieldtype: 'many-to-one', cfc: 'site', fkcolumn: 'siteID' }],
    d('dateCreated'),
    d('lastUpdate'),
    s('lastUpdateBy'),
    s('name'),
    s('altName'),
    s('lang', { default: 'en-us', required: T }),
    n('isActive', '1', { required: T }),
    n('showNavOnly', '1', { required: T }),
    n('showExcludeSearch', '0', { required: T }),
    n('isPublic', '0', { required: T }),
    n('isDefault', '0', { required: T }),
    s('description'),
    s('contentID'),
    s('categoryID'),
    n('maxItems', '20', { required: T }),
    n('allowHTML', '1', { required: T }),
    n('isFeaturesOnly', '0', { required: T }),
    s('featureType', { default: 'either' }),
    n('restricted', '0', { required: T }),
    s('restrictGroups'),
    s('version', { default: 'RSS 2.0', required: T }),
    s('channelLink'),
    s('authtype', { default: 'DEFAULT' }),
    s('type', { default: 'local', required: T }),
    s('sortBy', { default: 'lastUpdate', required: F }),
    s('sortDirection', { default: 'desc', required: T }),
    s('parentID'),
    n('nextN', '20', { required: T }),
    n('displayName', '0', { required: T }),
    n('displayRatings', '0', { required: T }),
    n('displayComments', '0', { required: T }),
    n('displayKids', '0', { required: T }),
    n('isNew', '0', { required: T, persistent: F }),
    ['params', { type: 'query', default: '', persistent: F }],
    s('remoteID'),
    s('remoteSourceURL'),
    s('remotePubDAte'),
    s('imageSize', { default: 'small', required: T }),
    s('imageHeight', { default: 'AUTO', required: T }),
    s('imageWidth', { default: 'AUTO', required: T }),
    s('displayList', { default: 'Title,Date,Image,Summary,Tags,Credits', required: T }),
    n('liveOnly', '1', { required: T }),
    s('entityName', { default: 'content' }),
    s('viewalllabel'),
    s('viewalllink', { default: 'View All' }),
    n('autoimport', '0', { required: T }),
    n('isLocked', '0', { required: T }),
    s('cssClass'),
    n('useCategoryIntersect', '0'),
    s('altTable'),
    s('contentpoolid'),
    n('includeHomePage', '0'),
  ],
};

/** contentVariationTargetingBean.cfc:83-87. */
const VARIATION_TARGETING: BeanClass = {
  parent: ORM,
  orm: true,
  props: [
    ['targetingid', { fieldType: 'id' }],
    ['content', { fieldtype: 'one-to-one', cfc: 'content', fkcolumn: 'contentid' }],
    ['site', { fieldType: 'many-to-one', cfc: 'site', fkcolumn: 'siteid' }],
    ['initjs', { datatype: 'text' }],
    ['targetingjs', { datatype: 'text' }],
  ],
};

/** Rule types getValidations copies from a property's attributes (bean.cfc:1185). */
const BASIC_RULES = ['regex', 'minValue', 'maxValue', 'minLength', 'maxLength', 'minCollection', 'maxCollection', 'minList', 'maxList', 'inlist', 'method', 'lte', 'lt', 'gte', 'gt', 'eq', 'neq'] as const;

/** CFML truthiness of an attribute: `if (x)`. */
function truthy(value: Attr | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** An attribute as a CFML value. */
function cfAttr(value: Attr): CfValue {
  return typeof value === 'number' ? new CfNumber(String(value), value) : value;
}

/** setPropAsIDColumn (bean.cfc:1096-1116; beanORM.cfc:151-158). */
function setPropAsIdColumn(prop: Map<string, Attr>, primary: boolean, orm: boolean): void {
  prop.set('type', 'string');
  prop.set('default', '');
  const site = cfEq(String(prop.get('name')), 'site');
  prop.set('ormtype', site ? 'varchar' : 'char');
  prop.set('datatype', site ? 'varchar' : 'char');
  prop.set('length', site ? 25 : 35);
  if (primary && orm) {
    prop.set('required', true);
    prop.set('nullable', false);
  }
}

/** One property after getProperties' defaults (bean.cfc:815-1045). */
function mappedProperty(name: string, attrs: Readonly<Record<string, Attr>>, orm: boolean): Map<string, Attr> {
  const prop = new Map<string, Attr>(Object.entries(attrs).map(([key, value]) => [key.toLowerCase(), value]));
  prop.set('name', name);
  const param = (key: string, value: Attr): void => {
    if (!prop.has(key)) prop.set(key, value);
  };
  param('comparable', true);
  param('required', false);
  param('nullable', true);
  param('fieldtype', '');
  param('nested', 'false');
  param('html', 'false');
  if (truthy(prop.get('required'))) prop.set('nullable', false);
  if (truthy(prop.get('nullable'))) prop.set('required', false);
  if (cfEq(String(prop.get('fieldtype')), 'id')) setPropAsIdColumn(prop, true, orm);
  if (!prop.has('datatype')) {
    const ormtype = prop.get('ormtype');
    const type = prop.get('type');
    if (ormtype !== undefined) prop.set('datatype', ormtype);
    else if (type !== undefined) prop.set('datatype', type);
    else {
      prop.set('type', 'string');
      prop.set('datatype', 'varchar');
    }
  }
  if (['date', 'timetamp'].some((type) => cfEq(String(prop.get('datatype')), type))) prop.set('datatype', 'datetime');
  const relatesTo = prop.get('relatesto');
  if (relatesTo !== undefined) prop.set('cfc', relatesTo);
  if (prop.has('cfc')) {
    param('fkcolumn', 'primaryKey');
    prop.set('column', prop.get('fkcolumn') as Attr);
    param('loadkey', prop.get('fkcolumn') as Attr);
    if (truthy(prop.get('nested'))) prop.set('loadkey', 'parentid');
    param('cascade', 'none');
    param('persistent', true);
    if (cfEq(String(prop.get('column')), 'primarykey')) prop.set('persistent', false);
    else if (truthy(prop.get('persistent'))) setPropAsIdColumn(prop, false, orm);
  } else if (!prop.has('persistent')) {
    prop.set('persistent', true);
  }
  param('column', name);
  param('table', '');
  param('default', 'null');
  return prop;
}

/** getProperties: each class's properties from the bean's own to bean.cfc's, the first declaration of a name winning. */
function propertiesOf(cls: BeanClass): Map<string, BeanProperty> {
  const byLower = new Map<string, [string, Map<string, Attr>]>();
  const orm = cls.orm === true;
  for (let level: BeanClass | undefined = cls; level !== undefined; level = level.parent) {
    for (const [name, attrs = {}] of level.props) {
      if (!byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), [name, mappedProperty(name, attrs, orm)]);
    }
  }
  return new Map([...byLower.values()]);
}

/** getValidations over the properties struct, in its iteration order (bean.cfc:1188-1257). */
function validationsOf(properties: ReadonlyMap<string, BeanProperty>): CfStruct {
  const rules = new CfStruct();
  for (const name of acfKeyOrder([...properties.keys()].map((key) => ['set', key] as const))) {
    const prop = properties.get(name) as BeanProperty;
    if (!truthy(prop.get('persistent'))) continue;
    const ruleKey = prop.has('fkcolumn') ? String(prop.get('fkcolumn')) : name;
    const list: CfStruct[] = [];
    const add = (type: string, value: Attr): void => {
      const rule = new CfStruct();
      const message = prop.get('message');
      if (message !== undefined) rule.set('message', cfAttr(message));
      rule.set(type, cfAttr(value));
      list.push(rule);
    };
    const datatype = prop.get('datatype') as Attr;
    if (!cfEq(String(datatype), 'any')) add('datatype', datatype);
    if (truthy(prop.get('required'))) add('required', prop.get('required') as Attr);
    if (prop.has('format')) add('format', prop.get('format') as Attr);
    const length = prop.get('length');
    if (length !== undefined && cfIsNumeric(length)) add('maxLength', length);
    for (const type of BASIC_RULES) {
      const value = prop.get(type.toLowerCase());
      if (value !== undefined) add(type, value);
    }
    if (list.length > 0) rules.set(ruleKey, list);
  }
  const validations = new CfStruct();
  validations.set('properties', rules);
  return validations;
}

function modelOf(cls: BeanClass): BeanModel {
  const properties = propertiesOf(cls);
  const names = new Set<string>();
  for (const [name, prop] of properties) {
    names.add(name.toLowerCase());
    names.add(String(prop.get('column')).toLowerCase());
  }
  return { properties, validations: validationsOf(properties), hasProperty: (name) => names.has(name.toLowerCase()) };
}

/** The models of the beans `validate` reads, by entity name. */
export const BEAN_MODELS = Object.freeze({
  content: modelOf(CONTENT),
  comment: modelOf(COMMENT),
  category: modelOf(CATEGORY),
  contentCategoryAssign: modelOf(CONTENT_CATEGORY_ASSIGN),
  file: modelOf(FILE),
  fileMetaData: modelOf(FILE_META_DATA),
  changeset: modelOf(CHANGESET),
  changesetCategoryAssignment: modelOf(CHANGESET_CATEGORY_ASSIGNMENT),
  feed: modelOf(FEED),
  variationTargeting: modelOf(VARIATION_TARGETING),
});

export type ModelledEntity = keyof typeof BEAN_MODELS;

/** beanORM.init's instance values of a new bean (beanORM.cfc:87-144) over bean.cfc init's (bean.cfc:89-105); `now` for created dates. */
export function ormInitValues(model: BeanModel, now: CfValue): CfStruct {
  const instance = new CfStruct();
  instance.set('isNew', new CfNumber('1', 1));
  instance.set('errors', new CfStruct());
  instance.set('fromMuraCache', false);
  instance.set('instanceID', cfUuid());
  instance.set('addObjects', []);
  instance.set('removeObjects', []);
  for (const name of acfKeyOrder([...model.properties.keys()].map((key) => ['set', key] as const))) {
    if (instance.get(name) !== undefined) continue;
    const prop = model.properties.get(name) as BeanProperty;
    const column = String(prop.get('column'));
    const datatype = String(prop.get('datatype')).toLowerCase();
    const fallback = prop.get('default') as Attr;
    const dated = datatype === 'datetime' || datatype === 'timestamp';
    const createdColumn = ['created', 'lastupdate'].includes(column.toLowerCase());
    const type = String(prop.get('type') ?? '').toLowerCase();
    if (type === 'struct' || type === 'array') {
      instance.set(name, type === 'struct' ? new CfStruct() : []);
    } else if (truthy(prop.get('persistent'))) {
      if (cfEq(String(prop.get('fieldtype')), 'id')) instance.set(column, cfUuid());
      else if (createdColumn && ((dated && fallback === 'null') || fallback === 'now()' || fallback === 'now')) instance.set(column, now);
      else if (!dated) instance.set(column, fallback === 'null' ? '' : cfAttr(fallback));
    } else if (createdColumn && datatype === 'datetime' && fallback === 'null') {
      instance.set(column, now);
    } else {
      instance.set(column, fallback === 'null' ? '' : cfAttr(fallback));
    }
    if (instance.get(column) === undefined) instance.set(column, '');
  }
  return instance;
}
