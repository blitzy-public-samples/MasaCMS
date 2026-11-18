import {
  ADMIN_HOME_ACTION,
  IMAGE_UPLOAD_CONDITION,
  PHOTO_CONDITION,
  SAVEFORM_CONDITION,
  SESSION_MANAGED_CONDITION,
  SHARED_ID_SORT_CONDITIONS,
  STARTUP_SITE_CONDITION,
  type RouteKeyOptions,
  type RouteKeyRequest,
  type VariantCondition,
  type VariantDeclaration,
} from '../legacy-compat/index.js';

/** One conflicting request of the shared route-key table and the key legacy dispatch implies for it. */
export interface RouteKeyConflictCase {
  readonly name: string;
  /** Legacy `path:lines` the expected key is derived from. */
  readonly source: string;
  readonly request: RouteKeyRequest;
  readonly expectedKey: string;
}

const ID = 'A1B2C3D4-E5F6-7890-ABCDEF1234567890';
const JSON_API = 'core/mura/client/api/json/v1/jsonApiUtility.cfc';
const CONTENT_SERVER = 'core/mura/content/contentServer.cfc';
const ADMIN_APP = 'admin/Application.cfc';
const FW1 = 'admin/framework.cfc';
const CUSERS = 'admin/core/controllers/cusers.cfc';
const CARCH_LIST = 'admin/core/views/carch/list.cfm';
const USER_MANAGER = 'core/mura/user/userManager.cfc';
const FILE_DAO = 'core/mura/content/file/fileDAO.cfc';
const EVENTS_HANDLER = 'core/mura/Handler/standardEventsHandler.cfc';
const SERVLET_EVENT = 'core/mura/servletEvent.cfc';
const FIXTURE_API = 'legacy-fixtures/cfml/api.cfm';
const FIXTURE_AUTH = 'legacy-fixtures/cfml/lib/auth.cfc';
const APP_SETTINGS = 'core/appcfc/applicationSettings.cfm';
const EVENT = 'core/mura/event.cfc';
const REQUEST_START = 'core/appcfc/onRequestStart_include.cfm';
const API_ROOT = '/_api/json/v1/default';
const TARGETING = '_api/rest/v1/default/variationTargeting';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const MULTIPART_TYPE = 'multipart/form-data; boundary=opt2-route-key-case';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function eq(param: string, equals: string): VariantCondition {
  return { param, equals };
}

function nonEmpty(param: string): VariantCondition {
  return { param, nonEmpty: true };
}

function truthy(param: string): VariantCondition {
  return { param, truthy: true };
}

/** structKeyExists over the merged params, empty value included (userManager.cfc:888,930). */
function present(param: string): VariantCondition {
  return { anyOf: [nonEmpty(param), eq(param, '')] };
}

function variant(route: string, name: string, ...when: VariantCondition[]): VariantDeclaration {
  return { route, variant: name, when };
}

/** Request parts beyond method and path; `files` are multipart parts as [field, filename]. */
interface RequestParts {
  query?: Record<string, string>;
  form?: Record<string, string>;
  jsonBody?: unknown;
  headers?: Record<string, string>;
  files?: readonly (readonly [field: string, filename: string])[];
}

function request(method: string, path: string, parts: RequestParts = {}): RouteKeyRequest {
  const { query = {}, form, jsonBody, headers = {}, files } = parts;
  const contentType = files !== undefined ? MULTIPART_TYPE : form !== undefined ? FORM_TYPE : undefined;
  const req: RouteKeyRequest = {
    method,
    path,
    query,
    headers: contentType === undefined ? { ...headers } : { 'Content-Type': contentType, ...headers },
  };
  if (form !== undefined) req.form = form;
  if (jsonBody !== undefined) req.jsonBody = jsonBody;
  if (files !== undefined) req.multipartFileNames = files.map(([field, filename]) => ({ field, filename }));
  return req;
}

function conflict(name: string, source: string, req: RouteKeyRequest, expectedKey: string): RouteKeyConflictCase {
  return { name, source, request: req, expectedKey };
}

const BUNDLE_CONDITION: VariantCondition = { anyOf: [nonEmpty('bundleFile'), nonEmpty('serverBundlePath')] };

/** The inventory's variants as gateway/cutover/variants.json declares them: by precedence, then route and variant. */
export const routeKeyCaseVariants: readonly VariantDeclaration[] = deepFreeze([
  variant('rest:address.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:category.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:category.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:changeset.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:changeset.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:changesetcategoryassignment.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:changesetcategoryassignment.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:comment.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:comment.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:comment.~delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:comment.~flag', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:comment.~markasspam', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:comment.~undelete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:comment.~unmarkasspam', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:content.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:content.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:contentcategoryassign.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:contentcategoryassign.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:contentnav.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:contentnav.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:feed.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:feed.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:file.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:file.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:filemetadata.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:filemetadata.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:group.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:login', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:oauth', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:oauth2', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:stats.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:stats.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:tokeninfo', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:user.save', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:variationtargeting.delete', 'session', SESSION_MANAGED_CONDITION),
  variant('rest:variationtargeting.save', 'session', SESSION_MANAGED_CONDITION),
  variant('admin:carch.multifileupload', 'upload=image', IMAGE_UPLOAD_CONDITION),
  variant('admin:carch.update', 'upload=image', IMAGE_UPLOAD_CONDITION),
  variant('admin:ceditprofile.update', 'photo', PHOTO_CONDITION),
  variant('admin:csettings.updatesite', 'bundle', BUNDLE_CONDITION),
  variant('admin:cusers.update', 'photo', PHOTO_CONDITION),
  variant('api:file.save', 'upload=image', IMAGE_UPLOAD_CONDITION),
  variant('api:group.save', 'photo', PHOTO_CONDITION),
  variant('api:site.save', 'bundle', BUNDLE_CONDITION),
  variant('api:user.save', 'photo', PHOTO_CONDITION),
  variant('rest:file.save', 'upload=image', IMAGE_UPLOAD_CONDITION),
  variant('rest:group.save', 'photo', PHOTO_CONDITION),
  variant('rest:site.save', 'bundle', BUNDLE_CONDITION),
  variant('rest:user.save', 'photo', PHOTO_CONDITION),
  variant(
    'admin:cusers.update',
    'type=2,action=add,extdata',
    eq('type', '2'),
    eq('action', 'Add'),
    nonEmpty('extendSetID'),
  ),
  variant(
    'admin:cusers.update',
    'type=2,action=update,extdata',
    eq('type', '2'),
    eq('action', 'Update'),
    nonEmpty('extendSetID'),
  ),
  variant('admin:carch.list', 'sharedid', ...SHARED_ID_SORT_CONDITIONS),
  variant('admin:cusers.update', 'type=1,action=delete', eq('type', '1'), eq('action', 'Delete')),
  variant('admin:cusers.update', 'type=1,extdata', eq('type', '1'), nonEmpty('extendSetID')),
  variant('admin:cusers.update', 'type=2,action=add', eq('type', '2'), eq('action', 'Add')),
  variant('admin:cusers.update', 'type=2,action=delete', eq('type', '2'), eq('action', 'Delete')),
  variant('admin:cusers.update', 'type=2,action=update', eq('type', '2'), eq('action', 'Update')),
  variant('admin:carch.approvalaction', 'action=approve', eq('action', 'approve')),
  variant('admin:carch.update', 'approved=1', truthy('approved')),
  variant('admin:carch.update', 'notify', nonEmpty('notify')),
  variant('admin:carch.updateobjectparams', 'approved=1', truthy('approved')),
  variant('admin:carch.variationtargeting', 'notify', nonEmpty('notify')),
  variant('admin:ceditprofile.update', 'extdata', nonEmpty('extendSetID')),
  variant('admin:clogin.login', 'status=sendlogin', eq('status', 'sendLogin')),
  variant('admin:clogin.main', 'status=sendlogin', eq('status', 'sendLogin')),
  variant('admin:csettings.updatesite', 'action=add', eq('action', 'Add')),
  variant('admin:csettings.updatesite', 'action=delete', eq('action', 'Delete')),
  variant('admin:csettings.updatesite', 'action=update', eq('action', 'Update')),
  variant('admin:cusers.update', 'type=1', eq('type', '1')),
  variant('admin:cusers.updateaddress', 'action=delete', eq('action', 'Delete')),
  variant('admin:cusers.updateaddress', 'extdata', present('extendSetID')),
  variant('api:address.save', 'extdata', present('extendSetID')),
  variant('api:content.save', 'approved=1', truthy('approved')),
  variant('api:content.save', 'notify', nonEmpty('notify')),
  variant('api:contentnav.save', 'approved=1', truthy('approved')),
  variant('api:contentnav.save', 'notify', nonEmpty('notify')),
  variant('api:group.save', 'extdata', nonEmpty('extendSetID')),
  variant('api:processasyncobject', 'saveform', SAVEFORM_CONDITION),
  variant('api:user.save', 'extdata', nonEmpty('extendSetID')),
  variant('rest:address.save', 'extdata', present('extendSetID')),
  variant('rest:content.save', 'approved=1', truthy('approved')),
  variant('rest:content.save', 'notify', nonEmpty('notify')),
  variant('rest:contentnav.save', 'approved=1', truthy('approved')),
  variant('rest:contentnav.save', 'notify', nonEmpty('notify')),
  variant('rest:group.save', 'extdata', nonEmpty('extendSetID')),
  variant('rest:processasyncobject', 'saveform', SAVEFORM_CONDITION),
  variant('rest:user.save', 'extdata', nonEmpty('extendSetID')),
  variant('rest:address.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:category.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:category.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:changeset.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:changeset.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:changesetcategoryassignment.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:changesetcategoryassignment.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:comment.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:comment.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:comment.~delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:comment.~flag', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:comment.~markasspam', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:comment.~undelete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:comment.~unmarkasspam', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:content.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:content.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:contentcategoryassign.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:contentcategoryassign.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:contentnav.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:contentnav.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:feed.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:feed.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:file.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:file.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:filemetadata.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:filemetadata.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:group.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:login', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:oauth', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:oauth2', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:stats.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:stats.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:tokeninfo', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:user.save', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:variationtargeting.delete', 'siteid', STARTUP_SITE_CONDITION),
  variant('rest:variationtargeting.save', 'siteid', STARTUP_SITE_CONDITION),
]);

/** Site ids the case options treat as registered (settingsManager.siteExists). */
export const routeKeyCaseSiteIds: readonly string[] = Object.freeze(['default', 'tenant-a', 'tenant-b', 'umbrella']);

const SITE_IDS: ReadonlySet<string> = new Set(routeKeyCaseSiteIds);

/** Options every suite passes alongside `routeKeyConflictCases`. */
export const routeKeyCaseOptions: RouteKeyOptions = deepFreeze({
  // structKeyExists over the site registry is case-insensitive (settingsManager.cfc:568-572).
  siteExists: (siteId: string): boolean => SITE_IDS.has(siteId.toLowerCase()),
  variants: routeKeyCaseVariants,
  // userBean's one `remote` function, registered at runtime (bean.cfc:777-791).
  entityRemoteFunctions: { user: ['pollState'] },
});

/** The shared table of conflicting route-key inputs; every expected key is derived from the cited legacy lines. */
export const routeKeyConflictCases: readonly RouteKeyConflictCase[] = deepFreeze([
  conflict(
    'api-form-method-overwrites-query-method',
    `${JSON_API}:405-406`,
    request('POST', `${API_ROOT}/`, { query: { method: 'logout' }, form: { method: 'login' } }),
    'api:login',
  ),
  conflict(
    'api-json-body-method-overwrites-form-and-query',
    `${JSON_API}:405-412`,
    request('POST', `${API_ROOT}/`, {
      query: { method: 'logout' },
      form: { method: 'login' },
      jsonBody: { method: 'generateCSRFTokens' },
      headers: { 'Content-Type': 'application/json' },
    }),
    'api:generatecsrftokens',
  ),
  conflict(
    'api-non-json-content-type-ignores-body',
    `${JSON_API}:408-412`,
    request('POST', `${API_ROOT}/`, {
      query: { method: 'logout' },
      form: { method: 'login' },
      jsonBody: { method: 'generateCSRFTokens' },
      headers: { 'Content-Type': 'text/plain' },
    }),
    'api:login',
  ),
  conflict(
    'api-segment-after-site-names-method',
    `${JSON_API}:856-861`,
    request('GET', `${API_ROOT}/findCurrentUser`),
    'api:findcurrentuser',
  ),
  conflict(
    'api-first-segment-names-method',
    `${CONTENT_SERVER}:611-621; ${JSON_API}:863-864`,
    request('GET', '/_api/json/v1/login'),
    'api:login',
  ),
  conflict(
    'api-method-param-wins-over-path-method',
    `${JSON_API}:856,869-876`,
    request('GET', `${API_ROOT}/logout`, { query: { method: 'login' } }),
    'api:login',
  ),
  // Not `api:user.save`: the rewritten path `default/user/save` keeps verb GET and `save` is no remote function,
  // so legacy answers invalidMethodCall. The next case shows the dotted entity winning over the path entity.
  conflict(
    'api-dotted-generic-method-overrides-path-entity-into-invalid-call',
    `${JSON_API}:399,953-960,1194,1277-1281,1444-1466`,
    request('POST', `${API_ROOT}/content/`, { form: { method: 'user.save' } }),
    'api:!invalidmethodcall',
  ),
  conflict(
    'api-dotted-remote-method-overrides-path-entity',
    `${JSON_API}:953-960,1165-1171; core/mura/user/userBean.cfc:826`,
    request('POST', `${API_ROOT}/content/`, { form: { method: 'user.pollState' } }),
    'api:user.~pollstate',
  ),
  conflict(
    'api-generic-save-keeps-user-entity',
    `${JSON_API}:949,1196-1201,1296-1299`,
    request('POST', `${API_ROOT}/user/`),
    'api:user.save',
  ),
  conflict(
    'api-generic-save-keeps-content-entity',
    `${JSON_API}:949,1196-1201,1296-1299`,
    request('POST', `${API_ROOT}/content/`),
    'api:content.save',
  ),
  conflict(
    'api-generic-method-param-with-entityname',
    `${JSON_API}:869-899`,
    request('POST', `${API_ROOT}/`, { form: { method: 'save', entityname: 'user' } }),
    'api:user.save',
  ),
  conflict(
    'api-entity-id-path-finds-one',
    `${JSON_API}:1003-1004,1156-1161,1264-1266`,
    request('GET', `${API_ROOT}/content/${ID}`),
    'api:content.findone',
  ),
  conflict(
    'api-method-override-header-deletes',
    `${JSON_API}:1156-1161,1303-1305`,
    request('POST', `${API_ROOT}/user/${ID}`, { headers: { 'X-HTTP-Method-Override': 'DELETE' } }),
    'api:user.delete',
  ),
  conflict(
    'api-empty-method-override-runs-no-operation',
    `${JSON_API}:1156-1161,1243-1305`,
    request('POST', `${API_ROOT}/user/${ID}`, { headers: { 'X-HTTP-Method-Override': '' } }),
    'api:user.http-',
  ),
  conflict(
    'api-index-cfm-prefix-stripped',
    `${CONTENT_SERVER}:150-152,783-784`,
    request('GET', `/index.cfm${API_ROOT}/content/${ID}`),
    'api:content.findone',
  ),
  conflict(
    'feed-legacy-tasks-path',
    `${CONTENT_SERVER}:637-647`,
    request('GET', '/tasks/feed/', { query: { feedid: ID, siteid: 'default' } }),
    'feed:v1',
  ),
  conflict(
    'feed-api-path',
    `${CONTENT_SERVER}:637-647`,
    request('GET', '/_api/feed/v1/', { query: { feedid: ID, siteid: 'default' } }),
    'feed:v1',
  ),
  conflict(
    'render-legacy-tasks-path-small',
    `${CONTENT_SERVER}:655-662`,
    request('GET', '/tasks/render/small/', { query: { fileid: ID } }),
    'render:small',
  ),
  conflict(
    'render-api-path-small',
    `${CONTENT_SERVER}:655-662`,
    request('GET', '/_api/render/small/', { query: { fileid: ID } }),
    'render:small',
  ),
  conflict(
    'render-size-param-overrides-path-segment',
    `${CONTENT_SERVER}:655-668`,
    request('GET', '/_api/render/file/', { query: { fileid: ID, size: 'medium' } }),
    'render:medium',
  ),
  conflict(
    'sitemonitor-behind-index-cfm',
    `${CONTENT_SERVER}:669,783-784`,
    request('GET', '/index.cfm/_api/sitemonitor/'),
    'sitemonitor:run',
  ),
  conflict(
    'admin-url-fuseaction-overwrites-url-muraaction',
    `${ADMIN_APP}:165-167; ${FW1}:618,626`,
    request('GET', '/admin/', { query: { muraAction: 'cUsers.list', fuseaction: 'cPerm.main' } }),
    'admin:cperm.main',
  ),
  conflict(
    'admin-form-fuseaction-overwrites-url-muraaction',
    `${ADMIN_APP}:161-163; ${FW1}:618-619`,
    request('POST', '/admin/', { query: { muraAction: 'cUsers.list' }, form: { fuseaction: 'cSettings.editSite' } }),
    'admin:csettings.editsite',
  ),
  conflict(
    'admin-form-muraaction-overwrites-url-fuseaction',
    `${ADMIN_APP}:161-167; ${FW1}:618-619`,
    request('POST', '/admin/', { query: { fuseaction: 'cPerm.main' }, form: { muraAction: 'cUsers.listUsers' } }),
    'admin:cusers.listusers',
  ),
  conflict(
    'admin-url-action-overwrites-path-action',
    `${FW1}:595,607-618`,
    request('GET', '/admin/index.cfm/cusers/list', { query: { muraAction: 'cSettings.list' } }),
    'admin:csettings.list',
  ),
  conflict(
    'admin-form-values-overwrite-path-pairs',
    `${FW1}:607-619; ${CUSERS}:317-326`,
    request('POST', '/admin/index.cfm/cusers/update/type/1/action/Update', { form: { type: '2', action: 'Add' } }),
    'admin:cusers.update{type=2,action=add}',
  ),
  conflict(
    'admin-missing-action-is-home-redirect',
    `${ADMIN_APP}:151; ${FW1}:621-626`,
    request('GET', '/admin/'),
    `admin:${ADMIN_HOME_ACTION}`,
  ),
  conflict(
    'admin-index-cfm-missing-action-is-home-redirect',
    `${ADMIN_APP}:151; ${FW1}:594-597,621-626`,
    request('GET', '/admin/index.cfm'),
    `admin:${ADMIN_HOME_ACTION}`,
  ),
  conflict(
    'admin-cusers-update-group-variant',
    `${CUSERS}:317-326`,
    request('POST', '/admin/', { query: { muraAction: 'cUsers.update' }, form: { type: '1', action: 'Update' } }),
    'admin:cusers.update{type=1}',
  ),
  conflict(
    'admin-cusers-update-user-add-variant',
    `${CUSERS}:317-326`,
    request('POST', '/admin/', { query: { muraAction: 'cUsers.update' }, form: { type: '2', action: 'Add' } }),
    'admin:cusers.update{type=2,action=add}',
  ),
  conflict(
    'admin-cusers-update-user-update-variant',
    `${CUSERS}:317-320`,
    request('POST', '/admin/', { query: { muraAction: 'cUsers.update' }, form: { type: '2', action: 'Update' } }),
    'admin:cusers.update{type=2,action=update}',
  ),
  conflict(
    'admin-cusers-update-user-delete-variant',
    `${CUSERS}:317-323`,
    request('POST', '/admin/', { query: { muraAction: 'cUsers.update' }, form: { type: '2', action: 'Delete' } }),
    'admin:cusers.update{type=2,action=delete}',
  ),
  conflict(
    'admin-cusers-update-new-photo-outranks-type',
    `${USER_MANAGER}:495-497,650-651`,
    request('POST', '/admin/', {
      query: { muraAction: 'cUsers.update' },
      form: { type: '2', action: 'Update' },
      files: [['newFile', 'me.png']],
    }),
    'admin:cusers.update{photo}',
  ),
  conflict(
    'admin-cusers-update-remove-photo-outranks-type',
    `${USER_MANAGER}:499-502`,
    request('POST', '/admin/', {
      query: { muraAction: 'cUsers.update' },
      form: { type: '2', action: 'Update', removePhotoFile: 'true' },
    }),
    'admin:cusers.update{photo}',
  ),
  conflict(
    'admin-cusers-update-remove-photo-false-keeps-type',
    `${USER_MANAGER}:499-502`,
    request('POST', '/admin/', {
      query: { muraAction: 'cUsers.update' },
      form: { type: '2', action: 'Update', removePhotoFile: 'false' },
    }),
    'admin:cusers.update{type=2,action=update}',
  ),
  conflict(
    'admin-cusers-update-unknown-type-has-no-variant',
    `${CUSERS}:317-326`,
    request('POST', '/admin/', { query: { muraAction: 'cUsers.update' }, form: { type: '3', action: 'Update' } }),
    'admin:cusers.update',
  ),
  conflict(
    'admin-csettings-updatesite-update-variant',
    'admin/core/controllers/csettings.cfc:170-210',
    request('POST', '/admin/', { query: { muraAction: 'cSettings.updateSite' }, form: { action: 'Update' } }),
    'admin:csettings.updatesite{action=update}',
  ),
  conflict(
    'admin-carch-update-image-upload-uppercase-extension',
    `${FILE_DAO}:159-179`,
    request('POST', '/admin/', { query: { muraAction: 'cArch.update' }, files: [['newfile', 'photo.JPG']] }),
    'admin:carch.update{upload=image}',
  ),
  conflict(
    'admin-carch-update-document-upload-has-no-variant',
    `${FILE_DAO}:159-179`,
    request('POST', '/admin/', { query: { muraAction: 'cArch.update' }, files: [['newfile', 'report.pdf']] }),
    'admin:carch.update',
  ),
  conflict(
    'admin-carch-update-flv-upload-is-image-variant',
    `${FILE_DAO}:174-179`,
    request('POST', '/admin/', { query: { muraAction: 'cArch.update' }, files: [['newfile', 'clip.flv']] }),
    'admin:carch.update{upload=image}',
  ),
  conflict(
    'admin-carch-list-sort-of-home-is-shared-id-variant',
    `${CARCH_LIST}:590-615`,
    request('POST', '/admin/', {
      query: { muraAction: 'cArch.list', siteid: 'tenant-a', topid: '00000000000000000000000000000000001' },
      form: { orderperm: 'editor', sorted: 'true', orderid: `${ID},${ID.toLowerCase()}` },
    }),
    'admin:carch.list{sharedid}',
  ),
  conflict(
    'admin-carch-list-orderid-list-item-is-shared-id-variant',
    `${CARCH_LIST}:604-611`,
    request('POST', '/admin/', {
      query: { muraAction: 'cArch.list', siteid: 'tenant-a', topid: ID },
      form: { orderperm: 'editor', orderid: `${ID},00000000000000000000000000000000099 ` },
    }),
    'admin:carch.list{sharedid}',
  ),
  conflict(
    'admin-carch-list-folder-sort-has-no-variant',
    `${CARCH_LIST}:590-615`,
    request('POST', '/admin/', {
      query: { muraAction: 'cArch.list', siteid: 'tenant-a', topid: ID },
      form: { orderperm: 'editor', sorted: 'true', orderid: ID },
    }),
    'admin:carch.list',
  ),
  conflict(
    'admin-ceditprofile-update-photo-variant',
    `${USER_MANAGER}:495-497`,
    request('POST', '/admin/', { query: { muraAction: 'cEditProfile.update' }, files: [['newFile', 'me.png']] }),
    'admin:ceditprofile.update{photo}',
  ),
  conflict(
    'api-process-async-object-saveform-variant',
    'core/modules/v1/form/index.cfm:114',
    request('POST', `${API_ROOT}/`, { form: { method: 'processAsyncObject', saveform: 'true' } }),
    'api:processasyncobject{saveform}',
  ),
  conflict(
    'api-process-async-object-without-saveform',
    `${JSON_API}:869-899`,
    request('POST', `${API_ROOT}/`, { form: { method: 'processAsyncObject' } }),
    'api:processasyncobject',
  ),
  conflict(
    'api-user-save-photo-variant',
    `${JSON_API}:1296-1299; ${USER_MANAGER}:650-651`,
    request('POST', `${API_ROOT}/user/`, { files: [['newFile', 'me.png']] }),
    'api:user.save{photo}',
  ),
  conflict(
    'api-file-segment-names-the-file-scope-not-the-entity',
    `${JSON_API}:856-861,869-881`,
    request('GET', `/_api/json/v1/umbrella/file/${ID}`),
    'api:!invalidmethodcall',
  ),
  conflict(
    'api-file-segment-after-non-variable-site-id-is-the-entity',
    `${JSON_API}:857,922-950`,
    request('GET', `/_api/json/v1/tenant-a/file/${ID}`),
    'api:file.findone',
  ),
  conflict(
    'api-method-param-wins-over-file-scope-segment',
    `${JSON_API}:856,869-899`,
    request('POST', '/_api/json/v1/umbrella/file/', { form: { method: 'save', entityname: 'file' } }),
    'api:file.save',
  ),
  conflict(
    'rest-form-entityname-file-image-upload-variant',
    `${JSON_API}:949,1196-1201,1296-1299; ${FILE_DAO}:159-179`,
    request('POST', '/_api/rest/v1/tenant-a/', { form: { entityname: 'file' }, files: [['newfile', 'photo.png']] }),
    'rest:file.save{upload=image}',
  ),
  conflict(
    'rest-upper-case-index-cfm-keeps-session-management',
    `${APP_SETTINGS}:179; ${CONTENT_SERVER}:150-151; ${JSON_API}:422,1980`,
    request('POST', `/INDEX.CFM/${TARGETING}`),
    'rest:variationtargeting.save{session}',
  ),
  conflict(
    'rest-title-case-index-cfm-delete-keeps-session-management',
    `${APP_SETTINGS}:179; ${CONTENT_SERVER}:150-151; ${JSON_API}:422,3326`,
    request('DELETE', `/Index.cfm/${TARGETING}/${ID}`),
    'rest:variationtargeting.delete{session}',
  ),
  conflict(
    'rest-upper-case-extension-index-cfm-keeps-session-management',
    `${APP_SETTINGS}:179; ${CONTENT_SERVER}:150-151`,
    request('POST', `/index.CFM/${TARGETING}`),
    'rest:variationtargeting.save{session}',
  ),
  conflict(
    'rest-double-encoded-api-segment-keeps-session-management',
    `${APP_SETTINGS}:179; ${CONTENT_SERVER}:167`,
    request('POST', '/%255Fapi/rest/v1/default/variationTargeting'),
    'rest:variationtargeting.save{session}',
  ),
  conflict(
    'rest-form-siteid-names-the-start-up-site',
    `${EVENT}:86-97; ${REQUEST_START}:331`,
    request('POST', `/${TARGETING}`, { form: { siteid: 'default' } }),
    'rest:variationtargeting.save{siteid}',
  ),
  conflict(
    'rest-url-siteid-names-the-start-up-site',
    `${EVENT}:86-97; ${REQUEST_START}:331`,
    request('DELETE', `/${TARGETING}/${ID}`, { query: { siteid: 'default' } }),
    'rest:variationtargeting.delete{siteid}',
  ),
  conflict(
    'rest-empty-form-siteid-keeps-the-url-one-out-of-start-up',
    `${EVENT}:86-89,96; ${JSON_API}:912-919`,
    request('POST', `/${TARGETING}`, { query: { siteid: 'default' }, form: { siteid: '' } }),
    'rest:!invalidparameters',
  ),
  conflict(
    'rest-json-body-siteid-is-no-start-up-scope',
    `${EVENT}:86-89`,
    request('POST', `/${TARGETING}`, { jsonBody: { siteid: 'default' }, headers: { 'Content-Type': 'application/json' } }),
    'rest:variationtargeting.save',
  ),
  conflict(
    'rest-session-managed-siteid-keeps-session-management',
    `${APP_SETTINGS}:179; ${EVENT}:86-97`,
    request('POST', `/INDEX.CFM/${TARGETING}`, { form: { siteid: 'default' } }),
    'rest:variationtargeting.save{session}',
  ),
  conflict(
    'rest-lower-case-index-cfm-is-sessionless',
    `${APP_SETTINGS}:179; ${CONTENT_SERVER}:783-784`,
    request('POST', `/index.cfm/${TARGETING}`),
    'rest:variationtargeting.save',
  ),
  conflict(
    'rest-bare-path-is-sessionless',
    `${APP_SETTINGS}:179`,
    request('POST', `/${TARGETING}`),
    'rest:variationtargeting.save',
  ),
  conflict(
    'rest-upper-case-api-path-is-sessionless',
    `${APP_SETTINGS}:179`,
    request('DELETE', `/_API/REST/v1/default/variationTargeting/${ID}`),
    'rest:variationtargeting.delete',
  ),
  conflict(
    'json-upper-case-index-cfm-has-no-session-variant',
    `${APP_SETTINGS}:179; ${CONTENT_SERVER}:150-151`,
    request('POST', '/INDEX.CFM/_api/json/v1/default/variationTargeting'),
    'api:variationtargeting.save',
  ),
  conflict(
    'ajax-upper-case-index-cfm-has-no-session-variant',
    `${APP_SETTINGS}:179; ${CONTENT_SERVER}:150-151`,
    request('DELETE', `/INDEX.CFM/_api/ajax/v1/default/variationTargeting/${ID}`),
    'api:variationtargeting.delete',
  ),
  conflict(
    'page-single-doaction',
    `${EVENTS_HANDLER}:527-530`,
    request('POST', '/default/', { form: { doaction: 'login' } }),
    'page:login',
  ),
  conflict(
    'page-doaction-list-logout-then-login',
    `${EVENTS_HANDLER}:527-530`,
    request('POST', '/default/', { form: { doaction: 'logout,login' } }),
    'page:logout,login',
  ),
  conflict(
    'page-doaction-list-login-then-logout',
    `${EVENTS_HANDLER}:527-530`,
    request('POST', '/default/', { form: { doaction: 'login,logout' } }),
    'page:login,logout',
  ),
  conflict(
    'page-url-doaction-wins-over-form',
    `${SERVLET_EVENT}:85-86`,
    request('POST', '/default/', { query: { doaction: 'logout' }, form: { doaction: 'login' } }),
    'page:logout',
  ),
  conflict(
    'page-doaction-with-saveform',
    `${EVENTS_HANDLER}:527-530; core/modules/v1/form/index.cfm:114`,
    request('POST', '/default/', { form: { doaction: 'login', saveform: 'true' } }),
    'page:login+saveform',
  ),
  conflict(
    'page-plain-render',
    `${CONTENT_SERVER}:779-799`,
    request('GET', '/default/about/'),
    'page:render',
  ),
  conflict(
    'fixture-archive-post',
    `${FIXTURE_API}:37-55`,
    request('POST', `/legacy-fixtures/cfml/api.cfm/people/persons/${ID}/archive`),
    'fixture:people/persons/{id}/archive@post',
  ),
  conflict(
    'fixture-method-override-header',
    `${FIXTURE_API}:21-22`,
    request('POST', `/legacy-fixtures/cfml/api.cfm/people/persons/${ID}/archive`, {
      headers: { 'X-HTTP-Method-Override': 'GET' },
    }),
    'fixture:people/persons/{id}/archive@get',
  ),
  conflict(
    'fixture-empty-method-override-keeps-request-method',
    `${FIXTURE_API}:16,21-23`,
    request('POST', `/legacy-fixtures/cfml/api.cfm/people/persons/${ID}/archive`, {
      headers: { 'X-HTTP-Method-Override': '' },
    }),
    'fixture:people/persons/{id}/archive@post',
  ),
  conflict(
    'fixture-query-siteid',
    `${FIXTURE_API}:24; ${FIXTURE_AUTH}:27-34`,
    request('POST', `/legacy-fixtures/cfml/api.cfm/people/persons/${ID}/archive`, { query: { siteid: 'tenant-a' } }),
    'fixture:people/persons/{id}/archive@post',
  ),
  conflict(
    'fixture-form-siteid-overwrites-query',
    `${FIXTURE_API}:24-25; ${FIXTURE_AUTH}:27-34`,
    request('POST', `/legacy-fixtures/cfml/api.cfm/people/persons/${ID}/archive`, {
      query: { siteid: 'tenant-b' },
      form: { siteid: 'tenant-a', effectiveFrom: '2026-05-13' },
    }),
    'fixture:people/persons/{id}/archive@post',
  ),
  conflict(
    'fixture-json-body-siteid-overwrites-form',
    `${FIXTURE_API}:24-34; ${FIXTURE_AUTH}:27-34`,
    request('POST', `/legacy-fixtures/cfml/api.cfm/people/persons/${ID}/archive`, {
      form: { siteid: 'tenant-b' },
      jsonBody: { siteid: 'tenant-a' },
      headers: { 'Content-Type': 'application/json' },
    }),
    'fixture:people/persons/{id}/archive@post',
  ),
  conflict(
    'fixture-doubled-slash-before-prefix',
    `${FIXTURE_API}:37-42`,
    request('POST', '//legacy-fixtures/cfml/api.cfm/finance/records', { query: { siteid: 'tenant-a' } }),
    'fixture:finance/records@post',
  ),
  conflict(
    'fixture-doubled-slash-inside-prefix',
    `${FIXTURE_API}:37-42`,
    request('POST', '/legacy-fixtures//cfml/api.cfm/finance/records', { query: { siteid: 'tenant-a' } }),
    'fixture:finance/records@post',
  ),
  conflict(
    'fixture-upper-case-module',
    `${FIXTURE_API}:37-41`,
    request('GET', '/legacy-fixtures/cfml/api.cfm/FINANCE/records'),
    'fixture:finance/records@get',
  ),
  conflict(
    'fixture-encoded-slash',
    `${FIXTURE_API}:37-41`,
    request('GET', '/legacy-fixtures/cfml/api.cfm/finance%2Frecords'),
    'fixture:finance/records@get',
  ),
  conflict(
    'fixture-upper-case-directory-is-a-page',
    `${CONTENT_SERVER}:779-799`,
    request('GET', '/LEGACY-FIXTURES/cfml/api.cfm/finance/records'),
    'page:render',
  ),
  conflict(
    'fixture-upper-case-script-is-a-page',
    `${CONTENT_SERVER}:779-799`,
    request('GET', '/legacy-fixtures/cfml/API.CFM/finance/records'),
    'page:render',
  ),
  conflict(
    'opt2-stub-namespace',
    'services/stub (OPT-2 namespace; no legacy route)',
    request('GET', '/opt2/stub/notes'),
    'opt2:/opt2/stub/notes',
  ),
  conflict(
    'synthetic-v1-namespace-form-siteid-overwrites-query',
    'services/finance/contracts/openapi.yaml (synthetic /v1/ namespace; no legacy route)',
    request('POST', `/v1/finance/records/${ID}/transitions/edit`, { query: { siteid: 'tenant-b' }, form: { siteid: 'tenant-a' } }),
    `opt2:/v1/finance/records/${ID.toLowerCase()}/transitions/edit`,
  ),
  conflict(
    'cfc-proxy-remote-method',
    'core/modules/v1/comments/ajax/commentsProxy.cfc:88-114',
    request('POST', '/core/modules/v1/comments/ajax/commentsProxy.cfc', { query: { method: 'get' } }),
    'cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=get',
  ),
]);
