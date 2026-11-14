/**
 * JSON API entities owned by strategies-content, as jsonApiUtility registers them
 * (core/mura/client/api/json/v1/jsonApiUtility.cfc:32-42, 69-105, 124-130, 225-273), with the primary key,
 * display name, declared properties, property hints and relations each bean's getProperties yields
 * (core/mura/bean/bean.cfc:620-1063).
 */
import {
  type ApiKeyHint,
  type ApiSerializerHint,
  CONTENTNAV_ENTITY,
  entityPropertyHint,
  REGISTERED_ENTITIES,
  VARIATION_ENTITY,
} from '@opt2/platform/legacy-compat';

/** Entity names in legacy casing. */
export type ContentEntityName =
  | typeof CONTENTNAV_ENTITY
  | 'content'
  | 'comment'
  | 'changeset'
  | 'feed'
  | 'category'
  | 'contentCategoryAssign'
  | 'file'
  | 'fileMetaData'
  | 'changesetCategoryAssignment'
  | 'stats'
  | typeof VARIATION_ENTITY;

/** Serializer hint registerEntity installs for a property datatype. */
export type EntityPropertyHint = Extract<ApiSerializerHint, 'integer' | 'float' | 'date'>;

/** A relationship entry of `application.objectMappings[entity].hasMany|hasOne`, as getLinks and expandEntity read it. */
export interface RelationProp {
  readonly name: string;
  readonly cfc: string;
  /** Key the related entity is loaded by. */
  readonly loadkey: string;
  /** This entity's column holding the related value; `primaryKey` means this entity's primary key. */
  readonly column: string;
}

/** Registration of one entity: `variables.config.entities[name]` plus bean metadata. */
export interface ContentEntityConfig {
  readonly name: ContentEntityName;
  readonly public: boolean;
  /** 35-character Masa module id. */
  readonly moduleId: string;
  /** Default field list in legacy order and case; absent means every value. */
  readonly fields?: readonly string[];
  readonly allowFieldSelect: boolean;
  /** Lower-cased, as findProperties reports it; empty when the bean declares none. */
  readonly primaryKey: string;
  readonly displayName: string;
  /** Hints for this entity's own properties, keyed by property name in declared case. */
  readonly hints: Readonly<Record<string, EntityPropertyHint>>;
  readonly hasMany: readonly RelationProp[];
  readonly hasOne: readonly RelationProp[];
  /** Lower-cased names of every property the bean's component chain declares (the keys of getProperties). */
  readonly declaredProperties: ReadonlySet<string>;
  /** Lower-cased declared properties findProperties skips: persistent=false without a cfc. */
  readonly nonPersistentProperties: ReadonlySet<string>;
}

/** What getEntityConfig answers for a name no entity is registered under. */
export interface UnregisteredEntityConfig {
  readonly public: false;
}

/** Property names one component declares, comma-separated; `nonPersistent` are persistent=false without a cfc. */
interface ComponentProperties {
  readonly persistent: string;
  readonly nonPersistent?: string;
}

interface EntityDefinition {
  readonly public: boolean;
  readonly moduleId: string;
  /** Legacy comma-separated field list. */
  readonly fields?: string;
  readonly primaryKey: string;
  readonly displayName: string;
  /** Property datatypes, as getProperties resolves them, for the properties that carry a hint. */
  readonly datatypes: Readonly<Record<string, string>>;
  readonly hasMany: readonly RelationProp[];
  readonly hasOne: readonly RelationProp[];
  /** Property declarations along the bean's extends chain, its own component first. */
  readonly properties: readonly ComponentProperties[];
}

const MODULE_CONTENT = '00000000000000000000000000000000000';
const MODULE_CATEGORIES = '00000000000000000000000000000000010';
const MODULE_FEEDS = '00000000000000000000000000000000011';
const MODULE_CHANGESETS = '00000000000000000000000000000000014';
const MODULE_COMMENTS = '00000000000000000000000000000000015';

// jsonApiUtility.cfc:39 and 77 (identical lists) and 83; each already contains `links`, so registerEntity appends nothing.
const CONTENT_FIELDS =
  'links,images,parentid,moduleid,path,contentid,contenthistid,changesetid,siteid,active,approved,title,menutitle,summary,tags,type,subtype,displayStart,displayStop,display,filename,url,assocurl,isNew,remoteid,remoteurl';
const COMMENT_FIELDS =
  'links,entered,isspam,flagcount,parentid,name,isapproved,kids,isdeleted,userid,subscribe,isnew,contentid,path,siteid,id,remoteid,contenthistid';

const rel = (name: string, cfc: string, loadkey: string, column: string): RelationProp =>
  Object.freeze({ name, cfc, loadkey, column });

const NUMERIC = 'numeric';
const DATETIME = 'datetime';

// bean.cfc:79-82.
const BEAN_PROPERTIES: readonly ComponentProperties[] = [
  { persistent: '', nonPersistent: 'errors,isNew,fromMuraCache,instanceID' },
];
// beanORM.cfc:79.
const BEAN_ORM_PROPERTIES: readonly ComponentProperties[] = [
  { persistent: '', nonPersistent: 'saveErrors' },
  ...BEAN_PROPERTIES,
];
// beanExtendable.cfc:80-86.
const BEAN_EXTENDABLE_PROPERTIES: readonly ComponentProperties[] = [
  { persistent: 'type,subType,siteID', nonPersistent: 'extendData,extendSetID,extendDataTable,extendAutoComplete' },
  ...BEAN_PROPERTIES,
];
// beanORMVersioned.cfc:78-80.
const BEAN_ORM_VERSIONED_PROPERTIES: readonly ComponentProperties[] = [
  { persistent: 'activeContent,content,site' },
  ...BEAN_ORM_PROPERTIES,
];
// beanFeed.cfc:78-90.
const BEAN_FEED_PROPERTIES: readonly ComponentProperties[] = [
  {
    persistent:
      'entityName,table,keyField,nextN,maxItems,siteID,contentpoolid,sortBy,sortDirection,orderby,additionalColumns,sortTable,pageIndex',
  },
  ...BEAN_PROPERTIES,
];

// contentBean.cfc:80-168.
const CONTENT_PROPERTIES: readonly ComponentProperties[] = [
  {
    persistent:
      'contentHistID,contentID,kids,parent,site,categoryAssignments,changeset,comments,stats,active,approved,orderno,metaDesc,metaKeyWords,displayStart,displayStop,body,title,menuTitle,URLTitle,HTMLTitle,filename,oldfilename,lastUpdate,display,type,newfile,lastUpdateBy,lastUpdateByID,summary,moduleID,isNav,restricted,target,restrictGroups,template,childTemplate,responseMessage,responseChart,responseSendTo,responseDisplayFields,moduleAssign,notes,inheritObjects,isFeature,releaseDate,nextN,sortBy,sortDirection,featureStart,featureStop,fileID,forceSSL,remoteURL,remoteID,remotePubDate,remoteSource,remoteSourceURL,credits,audience,searchExclude,displayTitle,path,tags,created,mobileExclude,changesetID,imageSize,imageHeight,imageWidth,expires,displayInterval,requestID',
    nonPersistent:
      'preserveID,isNew,isLocked,fileSize,fileExt,contentType,contentSubType,keyPoints,doCache,majorVersion,minorVersion,assocFilename,approvalStatus,approvalGroupID,approvalChainOverride,relatedContentSetData',
  },
  ...BEAN_EXTENDABLE_PROPERTIES,
];

// core/mura/content/contentBean.cfc:80-168 with beanExtendable and bean.
const CONTENT_DATATYPES: Readonly<Record<string, string>> = {
  active: NUMERIC,
  approved: NUMERIC,
  orderno: NUMERIC,
  displayStart: DATETIME,
  displayStop: DATETIME,
  lastUpdate: DATETIME,
  display: NUMERIC,
  isNav: NUMERIC,
  restricted: NUMERIC,
  responseChart: NUMERIC,
  isFeature: NUMERIC,
  isNew: NUMERIC,
  releaseDate: DATETIME,
  isLocked: NUMERIC,
  nextN: NUMERIC,
  featureStart: DATETIME,
  featureStop: DATETIME,
  forceSSL: NUMERIC,
  searchExclude: NUMERIC,
  displayTitle: NUMERIC,
  doCache: NUMERIC,
  created: DATETIME,
  mobileExclude: NUMERIC,
  majorVersion: NUMERIC,
  minorVersion: NUMERIC,
  expires: DATETIME,
};

const CONTENT_HAS_MANY: readonly RelationProp[] = [
  rel('kids', 'content', 'parentid', 'contentid'),
  rel('categoryAssignments', 'contentCategoryAssign', 'contenthistid', 'primaryKey'),
  rel('comments', 'comment', 'contentid', 'contentid'),
];

const CONTENT_HAS_ONE: readonly RelationProp[] = [
  rel('parent', 'content', 'parentid', 'parentid'),
  rel('site', 'site', 'siteID', 'siteID'),
  rel('changeset', 'changeset', 'changesetid', 'changesetid'),
  rel('stats', 'stats', 'contentid', 'contentid'),
];

// Display names are what findProperties reports on the legacy oracle: the entity name as is, never capitalised,
// and `content` for contentnav (served by the content bean) and for feed (feedBean.getEntityName returns its proxy name).
// Back-references other beans append (bean.cfc:1065-1086) are omitted where an own property of the same name is
// appended after them and so wins in getLinks and expandEntity; file's fileMetaData entry has no such own property.
const DEFINITIONS: Readonly<Record<ContentEntityName, EntityDefinition>> = {
  contentnav: {
    public: true,
    moduleId: MODULE_CONTENT,
    fields: CONTENT_FIELDS,
    primaryKey: 'contentid',
    displayName: 'content',
    datatypes: CONTENT_DATATYPES,
    hasMany: CONTENT_HAS_MANY,
    hasOne: CONTENT_HAS_ONE,
    properties: CONTENT_PROPERTIES,
  },
  content: {
    public: true,
    moduleId: MODULE_CONTENT,
    fields: CONTENT_FIELDS,
    primaryKey: 'contentid',
    displayName: 'content',
    datatypes: CONTENT_DATATYPES,
    hasMany: CONTENT_HAS_MANY,
    hasOne: CONTENT_HAS_ONE,
    properties: CONTENT_PROPERTIES,
  },
  // core/mura/content/contentCommentBean.cfc:77-97.
  comment: {
    public: true,
    moduleId: MODULE_COMMENTS,
    fields: COMMENT_FIELDS,
    primaryKey: 'commentid',
    displayName: 'comment',
    datatypes: {
      entered: DATETIME,
      subscribe: NUMERIC,
      isApproved: NUMERIC,
      isNew: NUMERIC,
      isSpam: NUMERIC,
      isDeleted: NUMERIC,
      flagCount: NUMERIC,
    },
    hasMany: [rel('kids', 'comment', 'parentid', 'primaryKey')],
    hasOne: [
      rel('content', 'content', 'contentid', 'contentid'),
      rel('parent', 'comment', 'parentid', 'parentid'),
      rel('site', 'site', 'siteID', 'siteID'),
    ],
    properties: [
      {
        persistent:
          'commentID,content,kids,parent,site,comments,url,name,email,entered,subscribe,isApproved,userID,path,remoteID,isSpam,isDeleted,flagCount',
        nonPersistent: 'isNew',
      },
      ...BEAN_PROPERTIES,
    ],
  },
  // core/mura/content/changeset/changesetBean.cfc:5-23.
  changeset: {
    public: false,
    moduleId: MODULE_CHANGESETS,
    primaryKey: 'changesetid',
    displayName: 'changeset',
    datatypes: {
      created: DATETIME,
      publishDate: DATETIME,
      published: NUMERIC,
      remotePubDate: DATETIME,
      lastUpdate: DATETIME,
      closeDate: DATETIME,
      isNew: NUMERIC,
    },
    hasMany: [
      rel('categoryAssignments', 'changesetCategoryAssignment', 'primaryKey', 'primaryKey'),
      rel('contentAssignments', 'content', 'primaryKey', 'primaryKey'),
    ],
    hasOne: [],
    properties: [
      {
        persistent:
          'changesetID,siteID,name,created,description,publishDate,published,remoteID,remoteSourceURL,remotePubDate,lastUpdate,lastUpdateBy,closeDate,categoryID,tags,categoryAssignments,contentAssignments',
        nonPersistent: 'isNew',
      },
      ...BEAN_PROPERTIES,
    ],
  },
  // core/mura/content/feed/feedBean.cfc:80-133 with beanFeed (pageIndex) and bean.
  feed: {
    public: false,
    moduleId: MODULE_FEEDS,
    primaryKey: 'feedid',
    displayName: 'content',
    datatypes: {
      dateCreated: DATETIME,
      lastUpdate: DATETIME,
      isActive: NUMERIC,
      showNavOnly: NUMERIC,
      showExcludeSearch: NUMERIC,
      isPublic: NUMERIC,
      isDefault: NUMERIC,
      maxItems: NUMERIC,
      allowHTML: NUMERIC,
      isFeaturesOnly: NUMERIC,
      restricted: NUMERIC,
      nextN: NUMERIC,
      displayName: NUMERIC,
      displayRatings: NUMERIC,
      displayComments: NUMERIC,
      displayKids: NUMERIC,
      isNew: NUMERIC,
      liveOnly: NUMERIC,
      autoimport: NUMERIC,
      isLocked: NUMERIC,
      useCategoryIntersect: NUMERIC,
      includeHomePage: NUMERIC,
      pageIndex: NUMERIC,
    },
    hasMany: [],
    hasOne: [rel('site', 'site', 'siteID', 'siteID')],
    properties: [
      {
        persistent:
          'feedID,site,dateCreated,lastUpdate,lastUpdateBy,name,altName,lang,isActive,showNavOnly,showExcludeSearch,isPublic,isDefault,description,contentID,categoryID,maxItems,allowHTML,isFeaturesOnly,featureType,restricted,restrictGroups,version,channelLink,authtype,type,sortBy,sortDirection,parentID,nextN,displayName,displayRatings,displayComments,displayKids,remoteID,remoteSourceURL,remotePubDAte,imageSize,imageHeight,imageWidth,displayList,liveOnly,entityName,viewalllabel,viewalllink,autoimport,isLocked,cssClass,useCategoryIntersect,altTable,contentpoolid,includeHomePage',
        nonPersistent: 'isNew,params',
      },
      ...BEAN_FEED_PROPERTIES,
    ],
  },
  // core/mura/category/categoryBean.cfc:80-104.
  category: {
    public: true,
    moduleId: MODULE_CATEGORIES,
    primaryKey: 'categoryid',
    displayName: 'category',
    datatypes: {
      dateCreated: DATETIME,
      lastUpdate: DATETIME,
      isInterestGroup: NUMERIC,
      isActive: NUMERIC,
      isOpen: NUMERIC,
      remotePubDate: DATETIME,
      isNew: NUMERIC,
      isFeatureable: NUMERIC,
    },
    hasMany: [
      rel('kids', 'category', 'parentid', 'primaryKey'),
      rel('contentAssignments', 'contentCategoryAssign', 'primaryKey', 'primaryKey'),
    ],
    hasOne: [rel('parent', 'category', 'categoryid', 'parentid'), rel('site', 'site', 'siteid', 'siteid')],
    properties: [
      {
        persistent:
          'categoryID,kids,parent,contentAssignments,site,dateCreated,lastUpdate,lastUpdateBy,name,isInterestGroup,isActive,isOpen,note,sortBy,sortDirection,restrictGroups,path,remoteID,remoteSourceURL,remotePubDate,URLtitle,filename,isFeatureable',
        nonPersistent: 'isNew',
      },
      ...BEAN_PROPERTIES,
    ],
  },
  // core/mura/content/contentCategoryAssignBean.cfc:79-91; `featureSop` is the bean's spelling.
  contentCategoryAssign: {
    public: true,
    moduleId: MODULE_CONTENT,
    primaryKey: '',
    displayName: 'contentCategoryAssign',
    datatypes: { isfeature: 'int', featureStart: DATETIME, featureSop: DATETIME, isNew: NUMERIC },
    hasMany: [rel('kids', 'category', 'parentid', 'categoryid')],
    hasOne: [
      rel('content', 'content', 'contenthistid', 'contenthistid'),
      rel('activeContent', 'content', 'contentid', 'contentid'),
      rel('category', 'category', 'categoryid', 'categoryid'),
      rel('parent', 'category', 'parentid', 'parentid'),
      rel('site', 'site', 'siteid', 'siteid'),
    ],
    // `parent` is persistent=false but related, so findProperties still lists it.
    properties: [
      {
        persistent: 'content,activeContent,category,parent,kids,site,isfeature,featureStart,featureSop',
        nonPersistent: 'categoryName,parentName,filename,path',
      },
      ...BEAN_ORM_PROPERTIES,
    ],
  },
  // core/mura/content/file/fileBean.cfc:3-33.
  file: {
    public: false,
    moduleId: MODULE_CONTENT,
    primaryKey: 'fileid',
    displayName: 'file',
    datatypes: { fileSize: 'int', created: DATETIME, deleted: 'int', remotePubDate: DATETIME, isNew: NUMERIC },
    // Appended by fileMetaData's many-to-one `file` property (bean.cfc:995).
    hasMany: [rel('fileMetaData', 'fileMetaData', 'fileid', 'fileid')],
    hasOne: [rel('content', 'content', 'contentid', 'contentid'), rel('site', 'site', 'siteid', 'siteid')],
    // The gps* declarations of fileBean.cfc:23-32 are commented out.
    properties: [
      {
        persistent:
          'fileid,content,site,filename,contentType,contentSubType,fileSize,fileExt,moduleid,created,deleted,caption,credits,alttext,remoteID,remoteURL,remotePubDate,remoteSource,remoteSourceURL,exif',
        nonPersistent: 'fileField',
      },
      ...BEAN_ORM_PROPERTIES,
    ],
  },
  // core/mura/content/contentFileMetaDataBean.cfc:84-111 with beanORMVersioned:78-80.
  fileMetaData: {
    public: false,
    moduleId: MODULE_CONTENT,
    primaryKey: 'metaid',
    displayName: 'fileMetaData',
    datatypes: { filesize: 'integer', created: DATETIME, remotePubDate: DATETIME, isNew: NUMERIC },
    hasMany: [],
    hasOne: [
      rel('file', 'file', 'fileid', 'fileid'),
      rel('activeContent', 'content', 'contentid', 'contentid'),
      rel('content', 'content', 'contenthistid', 'contenthistid'),
      rel('site', 'site', 'siteID', 'siteID'),
    ],
    // The gps* declarations of contentFileMetaDataBean.cfc:101-110 are commented out.
    properties: [
      {
        persistent: 'metaID,file,altText,caption,credits,remoteID,remoteURL,remotePubDate,remoteSource,remoteSourceURL,exif',
        nonPersistent: 'filename,filesize,contentType,contentSubType,fileExt,created,directImages',
      },
      ...BEAN_ORM_VERSIONED_PROPERTIES,
    ],
  },
  // core/mura/content/changeset/changesetCategoryAssignmentBean.cfc:4-7.
  changesetCategoryAssignment: {
    public: false,
    moduleId: MODULE_CONTENT,
    primaryKey: 'assignmentid',
    displayName: 'changesetCategoryAssignment',
    datatypes: { isNew: NUMERIC },
    hasMany: [],
    hasOne: [
      rel('changeset', 'changeset', 'changesetid', 'changesetid'),
      rel('site', 'site', 'siteid', 'siteid'),
      rel('category', 'category', 'categoryid', 'categoryid'),
    ],
    properties: [{ persistent: 'assignmentid,changeset,site,category' }, ...BEAN_ORM_PROPERTIES],
  },
  // core/mura/content/contentStatsBean.cfc:77-93.
  stats: {
    public: false,
    moduleId: MODULE_CONTENT,
    primaryKey: 'contentid',
    displayName: 'stats',
    datatypes: {
      views: NUMERIC,
      rating: NUMERIC,
      totalvotes: NUMERIC,
      upvotes: NUMERIC,
      downvotes: NUMERIC,
      comments: NUMERIC,
      disablecomments: NUMERIC,
      majorversion: NUMERIC,
      minorversion: NUMERIC,
      isNew: NUMERIC,
    },
    hasMany: [],
    hasOne: [rel('content', 'content', 'contentid', 'contentid'), rel('site', 'site', 'siteid', 'siteid')],
    // No `contentid` property: the primary key is the `content` relation's column.
    properties: [
      {
        persistent:
          'content,site,views,rating,totalvotes,upvotes,downvotes,comments,disablecomments,majorversion,minorversion,lockid,locktype',
      },
      ...BEAN_PROPERTIES,
    ],
  },
  // core/mura/content/contentVariationTargetingBean.cfc:82-86.
  variationTargeting: {
    public: false,
    moduleId: MODULE_CONTENT,
    primaryKey: 'targetingid',
    displayName: 'variationTargeting',
    datatypes: { isNew: NUMERIC },
    hasMany: [],
    hasOne: [rel('content', 'content', 'contentid', 'contentid'), rel('site', 'site', 'siteid', 'siteid')],
    properties: [{ persistent: 'targetingid,content,site,initjs,targetingjs' }, ...BEAN_ORM_PROPERTIES],
  },
};

function hintsOf(datatypes: Readonly<Record<string, string>>): Readonly<Record<string, EntityPropertyHint>> {
  const hints: Record<string, EntityPropertyHint> = {};
  for (const [property, datatype] of Object.entries(datatypes)) {
    const hint = entityPropertyHint(datatype);
    if (hint === 'integer' || hint === 'float' || hint === 'date') hints[property] = hint;
  }
  return Object.freeze(hints);
}

/** getProperties' names along a component chain, lower-cased, and the non-persistent ones; a name's first declaration wins. */
function declaredOf(
  chain: readonly ComponentProperties[],
): Pick<ContentEntityConfig, 'declaredProperties' | 'nonPersistentProperties'> {
  const declared = new Set<string>();
  const nonPersistent = new Set<string>();
  for (const component of chain) {
    const lists: [string, boolean][] = [
      [component.persistent, true],
      [component.nonPersistent ?? '', false],
    ];
    for (const [list, persistent] of lists) {
      for (const name of list.split(',').filter((item) => item !== '')) {
        const lower = name.toLowerCase();
        if (declared.has(lower)) continue;
        declared.add(lower);
        if (!persistent) nonPersistent.add(lower);
      }
    }
  }
  return { declaredProperties: declared, nonPersistentProperties: nonPersistent };
}

function configOf(name: ContentEntityName, def: EntityDefinition): ContentEntityConfig {
  return Object.freeze({
    name,
    public: def.public,
    moduleId: def.moduleId,
    ...(def.fields === undefined ? {} : { fields: Object.freeze(def.fields.split(',')) }),
    allowFieldSelect: true,
    primaryKey: def.primaryKey,
    displayName: def.displayName,
    hints: hintsOf(def.datatypes),
    hasMany: Object.freeze([...def.hasMany]),
    hasOne: Object.freeze([...def.hasOne]),
    ...declaredOf(def.properties),
  });
}

/** Every strategies-content entity registration, keyed by legacy name. */
export const CONTENT_ENTITIES: Readonly<Record<ContentEntityName, ContentEntityConfig>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(DEFINITIONS) as [ContentEntityName, EntityDefinition][]).map(([name, def]) => [
      name,
      configOf(name, def),
    ]),
  ) as Record<ContentEntityName, ContentEntityConfig>,
);

const NAMES_BY_LOWER: ReadonlyMap<string, ContentEntityName> = new Map(
  (Object.keys(CONTENT_ENTITIES) as ContentEntityName[]).map((name) => [name.toLowerCase(), name]),
);

/** Legacy name of a content entity, matched case-insensitively. */
function contentEntityName(name: string): ContentEntityName | undefined {
  return NAMES_BY_LOWER.get(name.toLowerCase());
}

// The config literal's contentnav, then init's unconditional registerEntity calls in order.
const REGISTRATION_ORDER: readonly ContentEntityName[] = Object.freeze([
  CONTENTNAV_ENTITY,
  ...REGISTERED_ENTITIES.map(contentEntityName).filter((name): name is ContentEntityName => name !== undefined),
]);

/** Registered content entities in legacy order; `variationTargeting` only when the `variations` setting is on. */
export function contentEntities(opts: { variations: boolean }): ContentEntityConfig[] {
  const names: readonly ContentEntityName[] = opts.variations
    ? [...REGISTRATION_ORDER, VARIATION_ENTITY]
    : REGISTRATION_ORDER;
  return names.map((name) => CONTENT_ENTITIES[name]);
}

const UNREGISTERED: UnregisteredEntityConfig = Object.freeze({ public: false });

/** getEntityConfig: the registration for `name` (any case), or `{ public: false }` for an unknown name. */
export function getContentEntityConfig(name: string): ContentEntityConfig | UnregisteredEntityConfig {
  const entity = contentEntityName(name);
  return entity === undefined ? UNREGISTERED : CONTENT_ENTITIES[entity];
}

/** Whether `name` (any case) is an entity strategies-content owns. */
export function isContentEntity(name: string): boolean {
  return contentEntityName(name) !== undefined;
}

/** Module-grant role for an entity: `m:` plus the last three digits of its module id. */
export function entityModuleRole(entity: ContentEntityName): `m:${string}` {
  return `m:${CONTENT_ENTITIES[entity].moduleId.slice(-3)}`;
}

// Legacy keeps one serializer per API utility and every registerEntity call adds its bean's hints to it, so a
// content entity is serialized with the hints of all of them (first definition wins). variationTargeting's only
// hint, isNew, is already content's, so the list is the same whether or not the variations setting is on.
const SHARED_SERIALIZER_HINTS: readonly ApiKeyHint[] = (() => {
  const seen = new Set<string>();
  const hints: ApiKeyHint[] = [];
  for (const entity of contentEntities({ variations: true })) {
    for (const [key, hint] of Object.entries(entity.hints)) {
      if (seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      hints.push(Object.freeze({ key, hint }));
    }
  }
  return Object.freeze(hints);
})();

/**
 * Entity property hints for `createApiSerializer` when serializing `name`: every content entity's, in registration
 * order; none for a name strategies-content does not own.
 */
export function entitySerializerHints(name: string): readonly ApiKeyHint[] {
  return isContentEntity(name) ? SHARED_SERIALIZER_HINTS : [];
}
