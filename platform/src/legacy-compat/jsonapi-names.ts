/** Names the Masa JSON API resolves while dispatching a request (jsonApiUtility.cfc `processRequest`). */

/** Methods callable through the JSON API, in legacy order (`publicMethods`, jsonApiUtility.cfc:34). */
export const PUBLIC_METHODS: readonly string[] = Object.freeze([
  'undeclareEntity',
  'declareEntity',
  'checkSchema',
  'findOne',
  'findMany',
  'findAll',
  'findPermissions',
  'findProperties',
  'findNew',
  'findQuery',
  'save',
  'delete',
  'findCrumbArray',
  'generateCSRFTokens',
  'validateEmail',
  'login',
  'logout',
  'submitForm',
  'findCalendarItems',
  'validate',
  'processAsyncObject',
  'findRelatedContent',
  'getURLForImage',
  'findVersionHistory',
  'findCurrentUser',
  'swagger',
]);

/** Functions declared in jsonApiUtility.cfc, in file order; `submitForm` is public but never declared. */
export const DEFINED_FUNCTIONS: readonly string[] = Object.freeze([
  'init',
  'getSerializer',
  'getConfig',
  'setConfig',
  'getEntityConfig',
  'registerMethod',
  'registerDisplayObject',
  'declareEntity',
  'undeclareEntity',
  'checkSchema',
  'registerEntity',
  'registerLinkMethod',
  'formatArray',
  'packageIteratorArray',
  'processRequest',
  'doubleCheckEntityName',
  'doubleCheckEntityMethod',
  'serializeResponse',
  'getApiVersion',
  'applyPropertyFormat',
  'findProperties',
  'getParamsWithOutMethod',
  'parseParamsFromPath',
  'getRelationship',
  'isValidRequest',
  'AllowAccess',
  'AllowAction',
  'validateEmail',
  'login',
  'logout',
  'findCalendarItems',
  'save',
  'getFilteredValues',
  'findPermissions',
  'findCurrentUser',
  'findOne',
  'findNew',
  'expandEntity',
  'getPrimaryEntityStruct',
  'findAll',
  'findMany',
  'findQuery',
  'iteratorToArray',
  'setFeedProps',
  'setIteratorProps',
  'findCrumbArray',
  'findVersionHistory',
  'delete',
  'getEndPoint',
  'getLinks',
  'findRelatedContent',
  'applyRemoteFormat',
  'getCustomImageSizeIterator',
  'setImageURLs',
  'lockdownValidations',
  'validate',
  'filterAsyncFeedParams',
  'processAsyncObject',
  'checkForChangesetRequest',
  'generateCSRFTokens',
  'getURLForImage',
  'getSwaggerPropertyDataType',
  'getSwaggerEntityParams',
  'getSwaggerEntityProps',
  'swagger',
  'isAggregateQuery',
  'getOAuthTokenInfo',
]);

// cfobject.cfc:89-474; backport/acf.cfm:2,6; backport/esapiencode.cfm:1, which ACF 2023 includes.
// isDefined resolves every one of them, so a path segment naming one is a method, not an entity.
/** Functions jsonApiUtility inherits from `mura.cfobject` and its ACF backport includes. */
export const INHERITED_FUNCTIONS: readonly string[] = Object.freeze([
  'init',
  'setValue',
  'set',
  'getValue',
  'get',
  'valueExists',
  'removeValue',
  'isORM',
  'getConfigBean',
  'getServiceFactory',
  'getBean',
  'getEntity',
  'getPluginManager',
  'getEventManager',
  'getCurrentUser',
  'getPlugin',
  'injectMethod',
  'inject',
  'deleteMethod',
  'getAsJSON',
  'getAsStruct',
  'initTracePoint',
  'commitTracePoint',
  'invokeMethod',
  'hasCustomDatasource',
  'getQueryAttrs',
  'getQueryService',
  'getHTTPService',
  'getHTTPAttrs',
  'convertTimezone',
  'getJavaTimezone',
  'getSession',
  'mixin',
  'getFeed',
  'parseDateArg',
  'logError',
  'parseXML',
  'esapiEncode',
]);

/** Entity-generic methods; their route key keeps the addressed entity. */
export const GENERIC_METHODS: readonly string[] = Object.freeze([
  'save',
  'delete',
  'findOne',
  'findMany',
  'findAll',
  'findNew',
  'findQuery',
  'findProperties',
  'findPermissions',
  'validate',
]);

/** Entities `init` registers unconditionally, in registration order (jsonApiUtility.cfc:69-99). */
export const REGISTERED_ENTITIES: readonly string[] = Object.freeze([
  'site',
  'content',
  'comment',
  'user',
  'group',
  'address',
  'changeset',
  'feed',
  'category',
  'contentCategoryAssign',
  'file',
  'fileMetaData',
  'changesetCategoryAssignment',
  'stats',
]);

/** Entity registered only when config `variations` is true (jsonApiUtility.cfc:102-104). */
export const VARIATION_ENTITY = 'variationTargeting';

/** Config-only entity that the API serves as `content` (jsonApiUtility.cfc:36, 963-966). */
export const CONTENTNAV_ENTITY = 'contentnav';

/** Primary keys hard-coded by entity name; other entities take theirs from the bean (jsonApiUtility.cfc:1205-1222). */
export const ENTITY_PRIMARY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  content: 'contentid',
  group: 'userid',
  user: 'userid',
  feed: 'feedid',
  stats: 'contentid',
  contentCategoryAssign: 'notvalid',
  entityname: 'notvalid',
});

/** Local and argument names of `processRequest`, grouped by the condition that declares them. */
export interface ProcessRequestLocals {
  /** Declared on every request before method resolution (jsonApiUtility.cfc:368-401). */
  readonly always: readonly string[];
  /** Declared only when an `Origin` header is present (jsonApiUtility.cfc:382-388). */
  readonly withOrigin: readonly string[];
  /** Declared only in REST mode (jsonApiUtility.cfc:448-449). */
  readonly restMode: readonly string[];
  /** Declared only in REST mode with an `Authorization` header (jsonApiUtility.cfc:453-455). */
  readonly restAuthorization: readonly string[];
  /** Declared after the direct-method checks, so visible only to the entity-route check (jsonApiUtility.cfc:913, 923). */
  readonly entityPhase: readonly string[];
}

// REST credential-flow locals (rsuser, tokenInfoRequest, token, oauthclient, clientAccount;
// jsonApiUtility.cfc:472-765) depend on stored credentials and token data, so they are not modelled.
/** `processRequest` locals that `isDefined` resolves during method resolution. */
export const PROCESS_REQUEST_LOCALS: ProcessRequestLocals = Object.freeze({
  always: Object.freeze([
    'path',
    'responseObject',
    'params',
    'result',
    'headers',
    'paramsArray',
    'pathInfo',
    'httpRequestData',
    'method',
    'apiEnabled',
    'sessionData',
  ]),
  withOrigin: Object.freeze(['origin', 'originDomain', 'domain']),
  restMode: Object.freeze(['isBasicAuth', 'isBasicAuthDirect']),
  restAuthorization: Object.freeze(['tokentype', 'tokenvalue']),
  entityPhase: Object.freeze(['siteManager']),
});

// jsonApiUtility.cfc:5-46,1406; cfobject.cfc:85 (backportdir). `images` (jsonApiUtility.cfc:3577) is
// set lazily by the first image serialisation, so it is runtime state and not listed.
/** Instance variables of a jsonApiUtility, set in `init`, the component body or the inherited cfobject body. */
export const COMPONENT_VARIABLES: readonly string[] = Object.freeze([
  'siteid',
  'useDataNamespaceForAPI',
  'endpoint',
  'config',
  'userUtility',
  'serializer',
  'entityChecks',
  'backportdir',
]);

// Probed on the legacy oracle: `thread` is undefined outside a thread; `super` resolves in any component.
/** Scope names that `isDefined` reports as defined inside a component method on ACF 2023. */
export const CFML_SCOPE_NAMES: readonly string[] = Object.freeze([
  'application',
  'arguments',
  'cffile',
  'cfthread',
  'cgi',
  'client',
  'cookie',
  'form',
  'local',
  'request',
  'server',
  'session',
  'super',
  'this',
  'url',
  'variables',
]);

/** Request facts that change which names `isDefined` resolves inside `processRequest`. */
export interface ApiNameContext {
  /** The request carries an `Origin` header (jsonApiUtility.cfc:382). */
  hasOrigin?: boolean;
  /** REST mode: `request.muraSessionManagement` is false (jsonApiUtility.cfc:422). */
  restMode?: boolean;
  /** REST mode request carrying an `Authorization` header (jsonApiUtility.cfc:453). */
  hasAuthorization?: boolean;
  /** The entity-route check at jsonApiUtility.cfc:923 rather than the direct-method checks (856-889). */
  entityPhase?: boolean;
  /** Plugin names injected through `registerMethod` or `registerLinkMethod` (pluginConfig.cfc:323). */
  registeredMethods?: Iterable<string>;
}

const lowerSet = (...lists: readonly (readonly string[])[]): ReadonlySet<string> =>
  new Set(lists.flat().map((name) => name.toLowerCase()));

const ALWAYS_DEFINED = lowerSet(
  DEFINED_FUNCTIONS,
  INHERITED_FUNCTIONS,
  COMPONENT_VARIABLES,
  CFML_SCOPE_NAMES,
  PROCESS_REQUEST_LOCALS.always,
);
const ORIGIN_LOCALS = lowerSet(PROCESS_REQUEST_LOCALS.withOrigin);
const REST_LOCALS = lowerSet(PROCESS_REQUEST_LOCALS.restMode);
const REST_AUTHORIZATION_LOCALS = lowerSet(PROCESS_REQUEST_LOCALS.restAuthorization);
const ENTITY_PHASE_LOCALS = lowerSet(PROCESS_REQUEST_LOCALS.entityPhase);
const PUBLIC_METHOD_SET = lowerSet(PUBLIC_METHODS);
const GENERIC_METHOD_SET = lowerSet(GENERIC_METHODS);

const CANONICAL_NAMES: ReadonlyMap<string, string> = (() => {
  const names = new Map<string, string>();
  for (const name of [...PUBLIC_METHODS, ...DEFINED_FUNCTIONS, ...INHERITED_FUNCTIONS]) {
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  }
  return names;
})();

const DECIMAL_DIGIT = /^\p{Nd}$/u;
const IDENTIFIER_CHAR = /^[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Sc}\p{Cf}]$/u;

/** Java `isJavaIdentifierPart`: identifier classes plus the ignorable control ranges. */
function isIdentifierPart(ch: string): boolean {
  return (
    ch <= '\u0008' || (ch >= '\u000e' && ch <= '\u001b') || (ch >= '\u007f' && ch <= '\u009f') || IDENTIFIER_CHAR.test(ch)
  );
}

function includesNoCase(names: Iterable<string> | undefined, key: string): boolean {
  if (names === undefined) return false;
  for (const name of names) {
    if (name.toLowerCase() === key) return true;
  }
  return false;
}

// ACF also accepts dot-separated names ('a.b'). A dotted name resolves only through a scope-qualified
// lookup a request-derived key cannot see, so it is rejected here; such requests then key to an
// unmatched entity route (served by legacy) or to the same invalidMethodCall error.
/** CFML `isValid('variableName', s)` for an undotted name: identifier characters, not starting with a digit. */
export function isValidVariableName(s: string): boolean {
  let first = true;
  for (const ch of s) {
    if ((first && DECIMAL_DIGIT.test(ch)) || !isIdentifierPart(ch)) return false;
    first = false;
  }
  return !first;
}

// Masa sets `this.searchImplicitScopes=false` (applicationSettings.cfm:193), so request parameters,
// cookies and CGI variables never make a bare name defined; only functions, variables, locals and scopes do.
/** Whether CFML `isDefined(name)` is true for a bare name inside `processRequest`. */
export function isDefinedApiName(name: string, ctx: ApiNameContext = {}): boolean {
  if (!isValidVariableName(name)) return false;
  const key = name.toLowerCase();
  return (
    ALWAYS_DEFINED.has(key) ||
    (ctx.hasOrigin === true && ORIGIN_LOCALS.has(key)) ||
    (ctx.restMode === true && REST_LOCALS.has(key)) ||
    (ctx.restMode === true && ctx.hasAuthorization === true && REST_AUTHORIZATION_LOCALS.has(key)) ||
    (ctx.entityPhase === true && ENTITY_PHASE_LOCALS.has(key)) ||
    includesNoCase(ctx.registeredMethods, key)
  );
}

/** Whether `name` is in `publicMethods` plus plugin-registered methods (`listFindNoCase`, jsonApiUtility.cfc:879). */
export function isPublicMethod(name: string, registeredMethods?: Iterable<string>): boolean {
  const key = name.toLowerCase();
  return PUBLIC_METHOD_SET.has(key) || includesNoCase(registeredMethods, key);
}

/** Whether `name` is an entity-generic method, case-insensitively. */
export function isGenericMethod(name: string): boolean {
  return GENERIC_METHOD_SET.has(name.toLowerCase());
}

/** The legacy spelling of a known method name (`findone` -> `findOne`); unknown names are returned unchanged. */
export function canonicalMethodName(name: string): string {
  return CANONICAL_NAMES.get(name.toLowerCase()) ?? name;
}
