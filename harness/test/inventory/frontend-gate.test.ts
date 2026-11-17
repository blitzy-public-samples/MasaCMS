import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VariantCondition, VariantDeclaration } from '@opt2/platform/legacy-compat';
import { memorySourceTree, openSourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { ComponentIndex, SourceTree } from '../../src/inventory/closure.js';
import { extractEntities, ormEntityIndex } from '../../src/inventory/entities.js';
import {
  APP_START_PATH,
  ASYNC_OBJECT,
  EVENTS_HANDLER_PATH,
  FORM_TEMPLATE_PATH,
  MODULES_ROOT,
  REQUEST_START_PATH,
  ROOT_REQUEST,
  TRANSLATOR_DIR,
  extractFrontEnd,
  httpReachability,
  isHttpReachable,
} from '../../src/inventory/frontend.js';
import type {
  CsrfValidation,
  DoactionEvidence,
  FrontEndEntry,
  FrontEndExtraction,
  FrontEndWriterOverrides,
  HttpReachability,
  RenderEvidence,
  SessionEffects,
  SourceRef,
} from '../../src/inventory/frontend.js';
import { loadInventoryVariants, variantsFor } from '../../src/inventory/route-keys.js';
import { buildComponentIndex, extractAliases, extractServices } from '../../src/inventory/services.js';
import { assertOutsideRepo } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const DAO = 'core/mura/fixture/fixtureDAO.cfc';
const ENTITY = 'core/mura/fixture/fixtureBean.cfc';
const MURA_GUARD = 'core/mura/Application.cfc';
const HIDDEN_GUARD = 'core/modules/v1/hidden/ajax/Application.cfc';
const SERVER = ROOT_REQUEST.path;
const EVENTS = EVENTS_HANDLER_PATH;
const API = ASYNC_OBJECT.path;
const FORM = FORM_TEMPLATE_PATH;
const REQUEST_START = REQUEST_START_PATH;
const APP_START = APP_START_PATH;
const RATER_MANAGER = 'core/mura/content/rater/raterManager.cfc';
const SOAP_PROXY = 'core/mura/client/api/soap/v1/contentProxy.cfc';
const CORE_GUARD = 'core/Application.cfc';
const LOGIN = 'core/modules/v1/login/index.cfm';
const RATER = 'core/modules/v1/rater/index.cfm';
const MAILING = 'core/modules/v1/mailing_list/index.cfm';
const LINK = 'core/templates/link.cfm';
const REMINDER = 'core/modules/v1/event_reminder_form/index.cfm';
const RATE_AJAX = 'core/modules/v1/rater/ajax/saveRate.cfm';
const FAVORITE_AJAX = 'core/modules/v1/favorites/ajax/saveFavorite.cfm';
const FAVORITE_GUARD = 'core/modules/v1/favorites/ajax/Application.cfc';
const STATUS_GUARD = 'core/modules/v1/status/ajax/Application.cfc';
const PING_AJAX = 'core/modules/v1/status/ajax/ping.cfm';
const COMMENTS_PROXY = 'core/modules/v1/comments/ajax/commentsProxy.cfc';
const HIDDEN_PROXY = 'core/modules/v1/hidden/ajax/hiddenProxy.cfc';
const ADMIN_NAV = 'admin/common/layouts/includes/nav.cfm';

/** Committed fixtures by their place in the on-disk tree. */
const COPIED: Readonly<Record<string, string>> = {
  [DAO]: 'cfml/dao-writes.cfc',
  [ENTITY]: 'cfml/entity-with-bom.cfc',
  [MURA_GUARD]: 'Application.cfc',
  [HIDDEN_GUARD]: 'Application.cfc',
};

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function scriptCfc(...body: string[]): string {
  return lines('component extends="mura.cfobject" output="false" {', ...body, '}');
}

/** Files of the on-disk tree written inline, modelled on the legacy lines the front-end inventory reads. */
const INLINE: Readonly<Record<string, string>> = {
  [SERVER]: lines(
    '<cfcomponent extends="mura.cfobject" output="false">',
    '',
    '<cffunction name="handleRootRequest" output="false">',
    '\t<cfset var pageContent="">',
    '\t<cfset var path=cgi.path_info>',
    "\t<cfif listFindNoCase('_api,tasks',listFirst(path,'/'))>",
    '\t\t<cfreturn handleAPIRequest(path)>',
    '\t<cfelse>',
    '\t\t<cfset request.servletEvent.getValidator("standardWrongDomain").validate(request.servletEvent)>',
    '\t\t<cfset pageContent = parseURLRoot(path=path)>',
    '\t\t<cfreturn pageContent>',
    '\t</cfif>',
    '</cffunction>',
    '',
    '<cffunction name="handleAPIRequest" output="false">',
    '\t<cfargument name="path">',
    '\t<cfset getBean("fixtureDAO").deleteMembership(userid=url.userid, groupid=url.groupid)>',
    '\t<cfif request.servletEvent.validateCSRFTokens(context="api")></cfif>',
    '</cffunction>',
    '',
    '<cffunction name="parseURLRoot" output="false">',
    '\t<cfargument name="path">',
    '\t<cfset request.servletEvent.getValidator("standardTrackSession").validate(request.servletEvent)>',
    '\t<cfset request.servletEvent.getValidator("standardWrongDomain").validate(request.servletEvent)>',
    '\t<cfset request.servletEvent.getHandler("standardDoActions").handle(request.servletEvent)>',
    '\t<cfset request.servletEvent.getTranslator("standard#request.format#").translate(request.servletEvent)>',
    '\t<cfset request.servletEvent.getHandler("standardMissing").handle(request.servletEvent)>',
    '</cffunction>',
    '',
    '</cfcomponent>',
  ),
  [EVENTS]: lines(
    '<cfcomponent extends="mura.cfobject" output="false">',
    '',
    '<!--- VALIDATORS --->',
    '<cffunction name="standardWrongDomainValidator" output="false">',
    '\t<cfargument name="event" required="true">',
    '</cffunction>',
    '',
    '<cffunction name="standardTrackSessionValidator" output="false">',
    '\t<cfargument name="event" required="true">',
    "\t<cfset application.sessionTrackingManager.trackRequest(siteid=arguments.event.getValue('siteID'))>",
    '</cffunction>',
    '',
    '<cffunction name="standardPostLogoutHandler" output="false">',
    '\t<cfargument name="event" required="true">',
    '\t<cfloop from="1" to="2" index="i"></cfloop>',
    '</cffunction>',
    '',
    '<cffunction name="standardRequireLoginValidator" output="false">',
    '\t<cfargument name="event" required="true">',
    "\t<cfif arguments.event.getValue('doaction') eq 'login'>",
    "\t\t<cfset application.emailManager.track(arguments.event.getValue('emailID'))>",
    '\t</cfif>',
    '</cffunction>',
    '',
    '<cffunction name="standardDoActionsHandler" output="false">',
    '\t<cfargument name="event" required="true">',
    '\t<cfargument name="$" />',
    '\t<cfset var a=""/>',
    "\t<cfif arguments.event.getValue('doaction') neq ''>",
    "\t\t<cfloop list=\"#arguments.event.getValue('doaction')#\" index=\"a\">",
    "\t\t\t<cfset arguments.event.setValue('lastAction',a)>",
    '\t\t\t<cfset doAction(a,arguments.event,arguments.$)>',
    '\t\t</cfloop>',
    '\t</cfif>',
    '</cffunction>',
    '',
    '<cffunction name="doAction" output="false">',
    '\t<cfargument name="theaction" type="string" default="">',
    '\t<cfargument name="event" required="true">',
    '\t<cfargument name="$" />',
    '\t<cfswitch expression="#arguments.theaction#">',
    '\t\t<cfcase value="login">',
    "\t\t\t<cfif not arguments.$.getContentRenderer().validateCSRFTokens or arguments.$.validateCSRFTokens(context='login')>",
    "\t\t\t\t<cfset arguments.$.getBean('loginManager').login(arguments.$.event().getAllValues(),'')>",
    '\t\t\t</cfif>',
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="return">',
    "\t\t\t<cfset application.emailManager.track(arguments.event.getValue('emailID'))>",
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="logout">',
    '\t\t\t<cfset application.loginManager.logout()>',
    '\t\t\t<cfset arguments.event.getHandler("standardPostLogout").handle(arguments.event)>',
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="updateprofile">',
    "\t\t\t<cfif not arguments.$.getContentRenderer().validateCSRFTokens or arguments.$.validateCSRFTokens(context='editprofile')>",
    "\t\t\t\t<cfswitch expression=\"#arguments.event.getValue('addressAction')#\">",
    '\t\t\t\t\t<cfcase value="delete">',
    "\t\t\t\t\t\t<cfset application.userManager.deleteAddress(arguments.event.getValue('addressID'))>",
    '\t\t\t\t\t</cfcase>',
    '\t\t\t\t</cfswitch>',
    '\t\t\t\t<cfset application.userManager.update(arguments.event.getAllValues())>',
    '\t\t\t\t<cfset application.loginManager.loginByUserID(arguments.event.getAllValues())>',
    '\t\t\t</cfif>',
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="subscribe|masterSubscribe" delimiters="|">',
    "\t\t\t<cfif true or arguments.$.validateCSRFTokens(context='subscribe')>",
    '\t\t\t\t<cfset application.mailinglistManager.createMember(arguments.event.getAllValues())>',
    '\t\t\t</cfif>',
    '\t\t</cfcase>',
    '',
    '\t\t<!---',
    '\t\t<cfcase value="contactsend">',
    '\t\t\t<cfset getBean("mailer").send(arguments.event.getAllValues())>',
    '\t\t</cfcase>',
    '\t\t--->',
    '',
    '\t\t<cfcase value="setReminder">',
    "\t\t\t<cfset application.contentManager.setReminder(arguments.event.getValue('contentID'),arguments.event.getValue('siteID'))>",
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="fixtureAudit">',
    "\t\t\t<cfset application.userManager.update(arguments.event.getAllValues())>",
    "\t\t\t<cfset getBean('fixtureBean').set(arguments.event.getAllValues()).save()>",
    '\t\t</cfcase>',
    '',
    '\t\t<cfdefaultcase>',
    '\t\t</cfdefaultcase>',
    '\t</cfswitch>',
    '</cffunction>',
    '',
    '</cfcomponent>',
  ),
  'core/mura/Translator/standardHTMLTranslator.cfc': scriptCfc(
    '\tpublic void function translate(required any event) {',
    '\t\targuments.event.setValue("format", "html");',
    '\t}',
  ),
  'core/mura/Translator/standardJSONTranslator.cfc': scriptCfc('\tpublic void function render(required any event) {', '\t}'),
  'core/mura/login/loginManager.cfc': scriptCfc(
    '\tpublic boolean function login(required struct loginStruct, string sessionUserID="") {',
    "\t\treturn getBean('userUtility').loginByQuery(arguments.loginStruct);",
    '\t}',
    '',
    '\tpublic boolean function loginByUserID(required struct loginStruct) {',
    "\t\treturn getBean('userUtility').loginByUserID(arguments.loginStruct.userid);",
    '\t}',
    '',
    '\tpublic void function logout() {',
    "\t\tgetBean('userUtility').logout();",
    '\t}',
  ),
  'core/mura/user/userUtility.cfc': scriptCfc(
    '\t// called from remote proxies too',
    '\tpublic boolean function loginByQuery(required any rsUser) {',
    "\t\tgetBean('fixtureDAO').update(userid=arguments.rsUser.userid, name='lastLogin');",
    '\t\treturn true;',
    '\t}',
    '',
    '\tpublic boolean function loginByUserID(required string userid) {',
    '\t\treturn true;',
    '\t}',
    '',
    '\tpublic void function logout() {',
    '\t}',
  ),
  'core/mura/user/userManager.cfc': scriptCfc(
    '\tpublic any function update(required struct data) {',
    "\t\tif (arguments.data.removePhotoFile eq 'true') {",
    "\t\t\tgetBean('fileManager').deleteVersion(arguments.data.photoFileID);",
    '\t\t}',
    "\t\tgetBean('fixtureDAO').update(userid=arguments.data.userid, name=arguments.data.name);",
    '\t}',
    '',
    '\tpublic any function deleteAddress(required string addressid) {',
    "\t\tgetBean('fixtureDAO').deleteMembership(userid=arguments.addressid, groupid='');",
    '\t}',
  ),
  'core/mura/email/emailManager.cfc': scriptCfc(
    '\tpublic any function track(required string emailid) {',
    "\t\tgetBean('fixtureDAO').create({fixtureid=arguments.emailid, siteid='', name='return'});",
    '\t}',
  ),
  'core/mura/content/contentManager.cfc': scriptCfc(
    '\tpublic any function setReminder(required string contentid, required string siteid) {',
    "\t\tgetBean('fixtureDAO').create({fixtureid=arguments.contentid, siteid=arguments.siteid, name='reminder'});",
    '\t}',
    '',
    '\tpublic any function flagComment(required string commentid) {',
    "\t\tgetBean('fixtureDAO').update(userid=arguments.commentid, name='flagged');",
    '\t}',
  ),
  'core/mura/user/sessionTrackingManager.cfc': scriptCfc(
    '\tpublic any function trackRequest(required string siteid) {',
    "\t\tgetBean('fixtureDAO').trackAsync(siteid=arguments.siteid);",
    '\t\tthread action="run" name="trackSession" siteid=arguments.siteid {',
    '\t\t\tqueryExecute("INSERT INTO tfixturestats (statid, siteid) VALUES (:statid, :siteid)", {statid=createUUID(), siteid=attributes.siteid});',
    '\t\t}',
    '\t}',
  ),
  'core/mura/mailinglist/mailinglistManager.cfc': scriptCfc(
    '\tpublic any function createMember(required struct data) {',
    "\t\tgetBean('fixtureDAO').create(arguments.data);",
    '\t}',
    '',
    '\tpublic any function deleteMember(required struct data) {',
    "\t\tgetBean('fixtureDAO').deleteMembership(userid=arguments.data.userid, groupid=arguments.data.groupid);",
    '\t}',
    '',
    '\tpublic any function validateMember(required struct data) {',
    "\t\tgetBean('fixtureDAO').update(userid=arguments.data.userid, name='validated');",
    '\t}',
  ),
  [RATER_MANAGER]: scriptCfc(
    '\tpublic any function saveRate(required string contentid, required string siteid, required string userid, required numeric rate) {',
    "\t\tgetBean('fixtureDAO').create({fixtureid=arguments.contentid, siteid=arguments.siteid, name=arguments.rate});",
    '\t}',
  ),
  'core/mura/favorite/favoriteManager.cfc': scriptCfc(
    '\tpublic any function saveFavorite(required string userid, required string siteid) {',
    "\t\tgetBean('fixtureDAO').create({fixtureid=createUUID(), siteid=arguments.siteid, name=arguments.userid});",
    '\t}',
  ),
  'core/mura/datacollection/dataCollectionBean.cfc': scriptCfc(
    '\tpublic any function submit(required any $) {',
    "\t\tgetBean('fileManager').create(getValue('fileField'));",
    "\t\tgetBean('fixtureDAO').create(getAllValues());",
    '\t\treturn this;',
    '\t}',
    '',
    '\tpublic any function set(required struct data) {',
    '\t\treturn this;',
    '\t}',
  ),
  'core/mura/bean/beanORM.cfc': scriptCfc(
    '\tpublic any function set(required struct data) {',
    '\t\treturn this;',
    '\t}',
    '',
    '\tpublic any function save() {',
    '\t\treturn this;',
    '\t}',
  ),
  'core/mura/MuraScope.cfc': scriptCfc(
    '\tpublic any function init(string siteid="") {',
    '\t\treturn this;',
    '\t}',
    '',
    '\tpublic boolean function validateCSRFTokens(string context="") {',
    '\t\treturn getCurrentUser().validateCSRFTokens(context=arguments.context);',
    '\t}',
  ),
  'core/mura/content/file/fileManager.cfc': scriptCfc(
    '\tpublic any function create(required any fileObj) {',
    "\t\tgetBean('fileWriter').writeFile(file=arguments.fileObj, output='');",
    '\t}',
    '',
    '\tpublic any function deleteVersion(required string fileid) {',
    '\t}',
  ),
  'core/mura/fileWriter.cfc': scriptCfc('\tpublic void function writeFile(required any file, required any output) {', '\t}'),
  [API]: scriptCfc(
    '\tpublic any function processAsyncObject(required string siteid) {',
    "\t\tvar $=getBean('MuraScope').init(arguments.siteid);",
    '\t\tinclude "/muraWRM/core/modules/v1/form/index.cfm";',
    '\t}',
  ),
  [SOAP_PROXY]: scriptCfc(
    '\tremote any function read(required string contentid) {',
    "\t\treturn getBean('content').loadBy(contentid=arguments.contentid);",
    '\t}',
  ),
  [REQUEST_START]: lines(
    'param name="application.instanceID" default=createUUID();',
    'if ( isDefined("onApplicationStart") ) {',
    '\tif ( not application.appInitialized or structKeyExists(url,application.appReloadKey) ) {',
    "\t\tif ( !(isDefined('url.method') && url.method == 'processAsyncObject') ) {",
    '\t\t\tinclude "onApplicationStart_include.cfm";',
    '\t\t}',
    '\t}',
    '}',
  ),
  [APP_START]: lines(
    '<cfscript>',
    'param name="application.appReloadKey" default="appreload";',
    'application.appReloadKey = variables.iniProperties.appreloadkey;',
    'application.userManager.update({userid="", name=""});',
    '</cfscript>',
  ),
  'core/appcfc/onRequestStart_scriptProtect_method.cfm': lines(
    '<cfscript>',
    'boolean function onRequestStart() output=false {',
    '\tinclude "/muraWRM/core/appcfc/onRequestStart_include.cfm";',
    '\treturn true;',
    '}',
    '</cfscript>',
  ),
  [CORE_GUARD]: lines(
    'component output="false" {',
    '\tdepth=1;',
    '\tinclude "#repeatString(\'../\',depth)#core/appcfc/applicationSettings.cfm";',
    '\tpublic function onRequestStart() {',
    '\t\tif ( !(listFindNoCase("runner.cfm,",listLast(cgi.SCRIPT_NAME,"/"))) ) {',
    '\t\t\twriteOutput("Access Restricted.");',
    '\t\t\tabort;',
    '\t\t}',
    '\t\treturn true;',
    '\t}',
    '}',
  ),
  'core/tests/runner.cfm': lines('<cfoutput>runner</cfoutput>'),
  [FORM]: lines(
    '<cfset objectParams.render = "client" />',
    "<cfif not len($.event('saveform'))>",
    '\t<cfset objectParams.view = "form"/>',
    '</cfif>',
    "<cfif len($.event('saveform'))>",
    "\t<cfset $.event('fields','')>",
    "\t<cfset objectParams.errors=$.getBean('dataCollectionBean')",
    '\t\t.set($.event().getAllValues())',
    '\t\t.submit($).getErrors()>',
    '\t<cfif not structCount(objectParams.errors)>',
    '\t\t<cfset objectParams.responsemessage=$.renderEvent(eventName="onFormSubmitResponseRender")>',
    '\t</cfif>',
    '',
    '</cfif>',
  ),
  [LOGIN]: lines(
    '<form method="post">',
    '\t<input type="hidden" name="doaction" value="login">',
    '\t<input type="hidden" name="doaction" value="#variables.next#">',
    '</form>',
    "<cfset variables.isLogout = variables.$.event('doaction') eq 'logout'>",
    "<cfif variables.$.event('display') eq 'login' and variables.$.event('doaction') eq 'sendlogin'>",
    "\t<cfset application.emailManager.track(variables.$.event('email'))>",
    '</cfif>',
    "<cfif not(structIsEmpty(request.userBean.getErrors()) and request.doaction eq 'createprofile')>",
    '\t<cfoutput>profile</cfoutput>',
    '</cfif>',
  ),
  [RATER]: lines(
    "<cfif listFind(variables.$.event('doaction'),\"saveRate\") and variables.$.event('raterID') neq ''>",
    "\t<cfset application.raterManager.saveRate(variables.$.content('contentID'),variables.$.event('siteID'),variables.$.currentUser('userID'),variables.$.event('rate'))>",
    '</cfif>',
    "<input type=\"hidden\" name=\"loginURL\" value=\"#esapiEncode('url',variables.$.getCurrentURL(true,'doaction=saveRate&rate='))#\">",
    "<cfif variables.$.event('doaction') eq 'rateLater'></cfif>",
  ),
  [REMINDER]: lines(
    '<cffunction name="remind" output="false">',
    "\t<cfif listfind(variables.$.event('doaction'),\"setReminder\")>",
    "\t\t<cfset application.contentManager.setReminder(variables.$.content('contentID'),variables.$.event('siteID'))>",
    '\t</cfif>',
    '</cffunction>',
    '<input name="doaction" value="setReminder" type="hidden"/>',
  ),
  [MAILING]: lines(
    "<cfif variables.$.event('doaction') eq 'unsubscribe'>",
    '\t<cfset application.mailinglistManager.deleteMember(variables.$.event().getAllValues())>',
    "<cfelseif variables.$.event('doaction') eq 'subscribe' and variables.rslist.isPurge neq 1>",
    '\t<cfset application.mailinglistManager.createMember(variables.$.event().getAllValues())>',
    '</cfif>',
    '<cfscript>',
    "\tif ( 'validateMember' == $.event('doaction') ) {",
    '\t\tapplication.mailinglistManager.validateMember($.event().getAllValues());',
    '\t}',
    "\tif ( $.event('doaction') != 'unsubscribe' ) writeOutput('subscribed');",
    "\tif ( $.event('doaction') == 'confirmMember' ) application.mailinglistManager.validateMember($.event().getAllValues());",
    "\tisPurge = $.event('doaction') == 'purgeList';",
    '</cfscript>',
    "<cfif not ($.event('doaction') eq 'notAction')>",
    '\t<cfoutput>not</cfoutput>',
    '</cfif>',
  ),
  [LINK]: lines('<a href="./?doaction=linkOnly">link</a>'),
  'core/vendor/lib/sample.cfm': lines('<a href="./?doaction=vendorOnly">vendor</a>'),
  'core/modules/v1/rater/ajax/Application.cfc': lines(
    '<cfcomponent output="false">',
    '\t<cfset depth=5>',
    '\t<cfinclude template="#repeatString(\'../\',depth)#core/appcfc/applicationSettings.cfm">',
    '\t<cfinclude template="#repeatString(\'../\',depth)#core/appcfc/onRequestStart_scriptProtect_method.cfm">',
    '</cfcomponent>',
  ),
  [RATE_AJAX]: lines(
    '<cfsetting enablecfoutputonly="yes">',
    '<cfset myRate=application.raterManager.saveRate(form.contentID, form.siteID, form.userID, form.rate) />',
    '<cfoutput>#application.contentRenderer.jsonencode(application.raterManager.getAvgRating(form.contentID,form.siteid))#</cfoutput>',
  ),
  [FAVORITE_GUARD]: scriptCfc(
    '\tfunction onRequestStart() {',
    "\t\tif ( structKeyExists(session, 'mura') ) {",
    '\t\t\treturn true;',
    '\t\t} else {',
    '\t\t\tabort;',
    '\t\t}',
    '\t}',
  ),
  [FAVORITE_AJAX]: lines(
    '<cfset favorite = application.favoriteManager.saveFavorite(url.userID, url.siteid) />',
    '<cfsavecontent variable="contentLink">',
    "\t<cfoutput>#$.dspObject('favorites')#</cfoutput>",
    '</cfsavecontent>',
    '<cfoutput>#contentLink#</cfoutput>',
  ),
  [STATUS_GUARD]: lines(
    '<cfcomponent output="false">',
    '<cffunction name="onRequestStart" output="false">',
    "\t<cfif not listFindNoCase('ping.cfm', listLast(cgi.script_name, '/'))>",
    '\t\t<cfabort>',
    '\t</cfif>',
    '</cffunction>',
    '</cfcomponent>',
  ),
  [PING_AJAX]: lines('<cfoutput>pong</cfoutput>'),
  'core/modules/v1/status/ajax/secret.cfm': lines('<cfoutput>secret</cfoutput>'),
  [HIDDEN_PROXY]: scriptCfc(
    '\tremote any function ping() {',
    "\t\treturn 'pong';",
    '\t}',
  ),
  'core/modules/v1/hidden/ajax/hidden.cfm': lines('<cfoutput>hidden</cfoutput>'),
  'core/modules/v1/comments/index.cfm': lines('<cfoutput>#variables.commentsHtml#</cfoutput>'),
  'core/modules/v1/comments/ajax/Application.cfc': lines(
    '<cfcomponent output="false">',
    '\t<cfset depth=5>',
    '\t<cfinclude template="#repeatString(\'../\',depth)#core/appcfc/onRequestStart_scriptProtect_method.cfm">',
    '</cfcomponent>',
  ),
  [COMMENTS_PROXY]: lines(
    '<cfcomponent output="false">',
    '',
    '\t<cffunction name="get" access="remote" returnformat="plain">',
    '\t\t<cfargument name="commentID">',
    '\t\t<cfreturn application.contentRenderer.jsonencode(application.contentManager.getCommentBean().setCommentID(arguments.commentID).load().getAllValues())>',
    '\t</cffunction>',
    '',
    '\t<cffunction name="flag" access="remote" returnformat="plain">',
    '\t\t<cfargument name="commentID">',
    '\t\t<cfset var $=application.serviceFactory.getBean("MuraScope")>',
    '\t\t<cfif $.validateCSRFTokens(context=lcase(arguments.commentID))>',
    '\t\t\t<cfset application.contentManager.flagComment(arguments.commentID)>',
    '\t\t</cfif>',
    '\t</cffunction>',
    '',
    '\t<cffunction name="saveProfile" access="remote" returnformat="json">',
    '\t\t<cfargument name="userBean">',
    '\t\t<cfset var $=application.serviceFactory.getBean("MuraScope")>',
    '\t\t<cfif $.validateCSRFTokens(argumentCollection=arguments) and $.validateCSRFTokens()>',
    "\t\t\t<cfset getBean('fixtureDAO').refreshLogin(arguments.userBean)>",
    '\t\t</cfif>',
    '\t</cffunction>',
    '',
    '\t<cffunction name="renderCommentsPage" access="remote" returnformat="plain">',
    '\t\t<cfset var $=application.serviceFactory.getBean("MuraScope")>',
    '\t\t<cfset var renderer = $.getContentRenderer()>',
    '\t\t<cfset var link = application.contentRenderer.createHREF(filename="comments")>',
    '\t\t<cfsavecontent variable="returnStruct.htmloutput">',
    '\t\t\t<cfinclude template="../index.cfm">',
    '\t\t</cfsavecontent>',
    '\t\t<cfreturn returnStruct>',
    '\t</cffunction>',
    '',
    '\t<cffunction name="helper" access="public">',
    '\t</cffunction>',
    '',
    '</cfcomponent>',
  ),
  [ADMIN_NAV]: lines(
    '<ul>',
    '\t<li><a href="./?#esapiEncode(\'url\',application.appreloadkey)#&amp;reload=#esapiEncode(\'url\',application.appreloadkey)#">Reload</a></li>',
    '</ul>',
  ),
  'admin/common/layouts/includes/footer.cfm': lines('<p>#application.appreloadkey#</p>'),
};


/** Variant declarations of the extraction: the asynchronous form submission. */
const VARIANTS_FILE = {
  variants: [{ route: 'api:processasyncobject', variant: 'saveform', when: [{ param: 'saveform', nonEmpty: true }] }],
};

/** Lines of onRequestStart in the committed deny-all Application.cfc. */
const DENY_SPAN = '6-9';
const DENY = readFileSync(fixturePath('Application.cfc'), 'utf8');
const DAO_TEXT = readFileSync(fixturePath('cfml/dao-writes.cfc'), 'utf8');

let root = '';
let tree: SourceTree;
let index: ComponentIndex;
let variants: readonly VariantDeclaration[];
let extraction: FrontEndExtraction;

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

function inline(file: string): string {
  const text = INLINE[file];
  if (text === undefined) throw new Error(`no inline file ${file}`);
  return text;
}

/** 1-based line of the only occurrence of `needle` in the inline file `file`. */
function lineIn(file: string, needle: string): number {
  const text = inline(file);
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) throw new Error(`${JSON.stringify(needle)} is not unique in ${file}`);
  return text.slice(0, at).split('\n').length;
}

function src(file: string, from: number, to: number = from): SourceRef {
  return { path: file, lines: [from, to] };
}

/** Source from the line of `first` to the line of `last` in an inline file. */
function spanOf(file: string, first: string, last: string = first): SourceRef {
  return src(file, lineIn(file, first), lineIn(file, last));
}

/** Source of a tag function of an inline file through its closing tag. */
function functionSource(file: string, name: string): SourceRef {
  const text = inline(file);
  const open = `<cffunction name="${name}"`;
  const close = text.indexOf('</cffunction>', text.indexOf(open));
  return src(file, lineIn(file, open), text.slice(0, close).split('\n').length);
}

/** Source of the doAction case `<cfcase value="<value>"` through its own closing tag. */
function caseSource(value: string): SourceRef {
  const text = inline(EVENTS);
  const open = `\t\t<cfcase value="${value}"`;
  const close = text.indexOf('\n\t\t</cfcase>', text.indexOf(open));
  return src(EVENTS, lineIn(EVENTS, open), text.slice(0, close + 1).split('\n').length);
}

function entryOf(result: FrontEndExtraction, id: string): FrontEndEntry {
  const found = result.frontEnd.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no front-end entry ${id}`);
  return found;
}

function indexOf(source: SourceTree): ComponentIndex {
  return buildComponentIndex({
    services: extractServices(source),
    aliases: extractAliases(source),
    ormIndex: ormEntityIndex(extractEntities(source).entities),
    tree: source,
  });
}

/** Index without DI1 registrations, for trees the DI1 scan cannot read. */
function plainIndex(source: SourceTree): ComponentIndex {
  return {
    resolveBean: () => null,
    ormTable: () => null,
    parsed: (p) => (p.endsWith('.cfc') && source.exists(p) ? parseCfmlComponent(p, source.readText(p)) : null),
  };
}

function extractMemory(
  files: Readonly<Record<string, string>>,
  opts: { variants?: readonly VariantDeclaration[]; plain?: boolean } = {},
): Promise<FrontEndExtraction> {
  const source = memorySourceTree(files);
  return extractFrontEnd(source, {
    index: opts.plain === true ? plainIndex(source) : indexOf(source),
    routeKeyOptions: { variants: opts.variants ?? variants },
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-frontend-gate-'));
  const treeRoot = path.join(root, 'tree');
  for (const [rel, name] of Object.entries(COPIED)) {
    await mkdir(path.dirname(path.join(treeRoot, rel)), { recursive: true });
    await copyFile(fixturePath(name), path.join(treeRoot, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(treeRoot, rel)), { recursive: true });
    await writeFile(path.join(treeRoot, rel), text);
  }
  const variantsFile = path.join(root, 'variants.json');
  await writeFile(variantsFile, JSON.stringify({ sourceSha: pinnedSha(), ...VARIANTS_FILE }));
  variants = (await loadInventoryVariants(variantsFile)).variants;
  tree = openSourceTree(treeRoot);
  index = indexOf(tree);
  extraction = await extractFrontEnd(tree, { index, routeKeyOptions: { variants } });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('front-end inventory constants', () => {
  it('name the legacy sources the front-end entries are read from', () => {
    expect(ROOT_REQUEST).toEqual({ path: 'core/mura/content/contentServer.cfc', method: 'handleRootRequest' });
    expect(ASYNC_OBJECT).toEqual({ path: 'core/mura/client/api/json/v1/jsonApiUtility.cfc', method: 'processAsyncObject' });
    expect(Object.isFrozen(ROOT_REQUEST) && Object.isFrozen(ASYNC_OBJECT)).toBe(true);
    expect([EVENTS_HANDLER_PATH, TRANSLATOR_DIR, FORM_TEMPLATE_PATH, MODULES_ROOT, REQUEST_START_PATH, APP_START_PATH]).toEqual([
      'core/mura/Handler/standardEventsHandler.cfc',
      'core/mura/Translator',
      'core/modules/v1/form/index.cfm',
      'core/modules/v1',
      'core/appcfc/onRequestStart_include.cfm',
      'core/appcfc/onApplicationStart_include.cfm',
    ]);
  });
});

/** A doaction value with what its entry records; `how` is the form of its entry text. */
interface DoactionCase {
  value: string;
  evidence: DoactionEvidence;
  how: 'case' | 'commented' | 'read' | 'named';
  source: SourceRef;
  extraSources?: SourceRef[];
  writeSet?: string[];
  sessionEffects?: SessionEffects;
  csrf?: [string | null, CsrfValidation];
}

const LOGIN_CHECK = lineIn(EVENTS, "getValue('doaction') eq 'login'>");

const DOACTIONS: DoactionCase[] = [
  {
    value: 'login',
    evidence: 'handler-case',
    how: 'case',
    source: caseSource('login'),
    extraSources: [src(EVENTS, LOGIN_CHECK, LOGIN_CHECK + 1)],
    writeSet: ['tfixture'],
    sessionEffects: 'login',
    csrf: ['login', 'validates'],
  },
  {
    value: 'logout',
    evidence: 'handler-case',
    how: 'case',
    source: caseSource('logout'),
    extraSources: [spanOf(LOGIN, "eq 'logout'")],
    sessionEffects: 'logout',
  },
  {
    value: 'updateprofile',
    evidence: 'handler-case',
    how: 'case',
    source: caseSource('updateprofile'),
    writeSet: ['tfixture', 'tfixturemembers'],
    sessionEffects: 'login',
    csrf: ['editprofile', 'validates'],
  },
  {
    value: 'subscribe',
    evidence: 'handler-case',
    how: 'case',
    source: caseSource('subscribe|masterSubscribe'),
    extraSources: [spanOf(MAILING, "eq 'subscribe'", 'mailinglistManager.createMember')],
    writeSet: ['tfixture'],
    csrf: ['subscribe', 'bypassed'],
  },
  {
    value: 'masterSubscribe',
    evidence: 'handler-case',
    how: 'case',
    source: caseSource('subscribe|masterSubscribe'),
    writeSet: ['tfixture'],
    csrf: ['subscribe', 'bypassed'],
  },
  {
    value: 'setReminder',
    evidence: 'handler-case',
    how: 'case',
    source: caseSource('setReminder'),
    extraSources: [spanOf(REMINDER, 'listfind(', 'contentManager.setReminder')],
    writeSet: ['tfixture'],
  },
  { value: 'return', evidence: 'handler-case', how: 'case', source: caseSource('return'), writeSet: ['tfixture'] },
  { value: 'fixtureAudit', evidence: 'handler-case', how: 'case', source: caseSource('fixtureAudit'), writeSet: ['tfixture'] },
  { value: 'contactsend', evidence: 'handler-case', how: 'commented', source: spanOf(EVENTS, '\t\t<!---\n', '\t\t--->') },
  {
    value: 'saveRate',
    evidence: 'comparison',
    how: 'read',
    source: spanOf(RATER, 'listFind(', 'raterManager.saveRate'),
    writeSet: ['tfixture'],
  },
  {
    value: 'sendlogin',
    evidence: 'comparison',
    how: 'read',
    source: spanOf(LOGIN, "eq 'sendlogin'", 'track(variables'),
    writeSet: ['tfixture'],
  },
  {
    value: 'unsubscribe',
    evidence: 'comparison',
    how: 'read',
    source: spanOf(MAILING, "eq 'unsubscribe'", 'mailinglistManager.deleteMember'),
    extraSources: [spanOf(MAILING, "!= 'unsubscribe'")],
    writeSet: ['tfixturemembers'],
  },
  {
    value: 'validateMember',
    evidence: 'comparison',
    how: 'read',
    source: spanOf(MAILING, "'validateMember' ==", '\t\tapplication.mailinglistManager.validateMember'),
    writeSet: ['tfixture'],
  },
  { value: 'confirmMember', evidence: 'comparison', how: 'read', source: spanOf(MAILING, "'confirmMember'"), writeSet: ['tfixture'] },
  { value: 'rateLater', evidence: 'comparison', how: 'read', source: spanOf(RATER, "'rateLater'") },
  { value: 'createprofile', evidence: 'comparison', how: 'named', source: spanOf(LOGIN, "eq 'createprofile'", '<cfoutput>profile') },
  { value: 'notAction', evidence: 'comparison', how: 'named', source: spanOf(MAILING, "'notAction'", '<cfoutput>not') },
  { value: 'purgeList', evidence: 'comparison', how: 'named', source: spanOf(MAILING, "'purgeList'") },
  { value: 'linkOnly', evidence: 'link', how: 'named', source: src(LINK, 1) },
];

function doactionEntry(c: DoactionCase): string {
  if (c.how === 'case') return `doaction=${c.value}: standardEventsHandler.doAction case`;
  if (c.how === 'commented') return `doaction=${c.value}: doAction case commented out at the pin, so the value only renders the page`;
  return c.how === 'read'
    ? `doaction=${c.value}: read by ${c.source.path}; not a doAction case`
    : `doaction=${c.value}: named by ${c.source.path}; no code acts on it, so the page renders`;
}

interface RemoteCase {
  method: string;
  renders: Array<[RenderEvidence['marker'], string]>;
  writeSet?: string[];
  sessionEffects?: SessionEffects;
  csrf?: [string | null, CsrfValidation];
}

const REMOTES: RemoteCase[] = [
  { method: 'get', renders: [] },
  { method: 'flag', renders: [], writeSet: ['tfixture'], csrf: ['lcase(arguments.commentID)', 'validates'] },
  { method: 'saveProfile', renders: [], sessionEffects: 'relogin', csrf: [null, 'validates'] },
  {
    method: 'renderCommentsPage',
    renders: [
      ['content-renderer', '$.getContentRenderer()'],
      ['content-renderer', 'contentRenderer.createHREF'],
      ['saved-output', '<cfsavecontent'],
      ['include', '<cfinclude template="../index.cfm">'],
    ],
  },
];

interface AjaxCase {
  file: string;
  module: string;
  renders: Array<[RenderEvidence['marker'], string]>;
  writeSet: string[];
}

const AJAX: AjaxCase[] = [
  {
    file: FAVORITE_AJAX,
    module: 'favorites',
    renders: [
      ['saved-output', '<cfsavecontent'],
      ['display-object', '$.dspObject'],
    ],
    writeSet: ['tfixture'],
  },
  { file: RATE_AJAX, module: 'rater', renders: [], writeSet: ['tfixture'] },
  { file: PING_AJAX, module: 'status', renders: [], writeSet: [] },
];

describe('extractFrontEnd over the on-disk tree', () => {
  it('lists one entry per page render, doaction value, form submission, remote method, ajax template and reload, sorted by id', () => {
    expect(extraction.frontEnd.map((e) => e.id)).toEqual([
      'fe:appreload',
      'fe:cfm:/core/modules/v1/favorites/ajax/savefavorite.cfm',
      'fe:cfm:/core/modules/v1/rater/ajax/saverate.cfm',
      'fe:cfm:/core/modules/v1/status/ajax/ping.cfm',
      'fe:commentsproxy.flag',
      'fe:commentsproxy.get',
      'fe:commentsproxy.renderCommentsPage',
      'fe:commentsproxy.saveProfile',
      'fe:doaction=confirmMember',
      'fe:doaction=contactsend',
      'fe:doaction=createprofile',
      'fe:doaction=fixtureAudit',
      'fe:doaction=linkOnly',
      'fe:doaction=login',
      'fe:doaction=logout',
      'fe:doaction=masterSubscribe',
      'fe:doaction=notAction',
      'fe:doaction=purgeList',
      'fe:doaction=rateLater',
      'fe:doaction=return',
      'fe:doaction=saveRate',
      'fe:doaction=sendlogin',
      'fe:doaction=setReminder',
      'fe:doaction=subscribe',
      'fe:doaction=unsubscribe',
      'fe:doaction=updateprofile',
      'fe:doaction=validateMember',
      'fe:processasyncobject{saveform}',
      'fe:render',
      'fe:saveform',
    ]);
    expect(extraction.frontEnd.every((e) => e.trigger === 'request' && !e.unkeyed && e.routeKey !== null)).toBe(true);
  });

  it('keys the plain page render and walks the event methods it dispatches by name, leaving out its API branch', () => {
    const render = entryOf(extraction, 'fe:render');
    expect(render).toMatchObject({
      kind: 'page-render',
      name: 'render',
      entry: 'page render through handleRootRequest; the theme and display objects render in CFML',
      source: functionSource(SERVER, 'handleRootRequest'),
      extraSources: [],
      routeKey: 'page:render',
      predicate: null,
      doactionEvidence: null,
      reachable: true,
      rendersCfml: true,
      returnsDataOnly: false,
      writeSet: ['tfixturestats'],
      fileStoreWrite: false,
      sessionEffects: 'none',
      csrfContext: null,
      csrfValidation: 'none',
    });
    expect(render.closure.visited).toEqual([
      `${EVENTS}#standardDoActionsHandler`,
      `${EVENTS}#standardTrackSessionValidator`,
      `${EVENTS}#standardWrongDomainValidator`,
      'core/mura/Translator/standardHTMLTranslator.cfc#translate',
      `${SERVER}#handleRootRequest`,
      `${SERVER}#parseURLRoot`,
      `${DAO}#trackAsync`,
      'core/mura/user/sessionTrackingManager.cfc#trackRequest',
    ]);
    expect(render.closure.threads.map((t) => [t.component, t.name])).toEqual([
      [DAO, 'fixtureThread#createUUID()#'],
      ['core/mura/user/sessionTrackingManager.cfc', 'trackSession'],
    ]);
    expect(render.closure.unresolved).toEqual([
      {
        expr: "getHandler('standardMissing')",
        kind: 'method',
        source: spanOf(SERVER, 'getHandler("standardMissing")'),
        via: ['contentServer.handleRootRequest', 'contentServer.parseURLRoot'],
      },
    ]);
  });

  it.each(DOACTIONS)('classifies doaction=$value from its cases, comparisons and links', (c) => {
    const [csrfContext, csrfValidation] = c.csrf ?? [null, 'none'];
    expect(entryOf(extraction, `fe:doaction=${c.value}`)).toMatchObject({
      kind: 'doaction',
      name: c.value,
      entry: doactionEntry(c),
      source: c.source,
      extraSources: c.extraSources ?? [],
      routeKey: `page:${c.value.toLowerCase()}`,
      predicate: null,
      doactionEvidence: c.evidence,
      reachable: c.how !== 'commented',
      unreachableReason: c.how === 'commented' ? 'doAction case commented out at the pin' : null,
      rendersCfml: true,
      returnsDataOnly: false,
      renderEvidence: [],
      writeSet: c.writeSet ?? [],
      sessionEffects: c.sessionEffects ?? 'none',
      csrfContext,
      csrfValidation,
    });
  });

  it('keeps nested switch cases, interpolated hidden inputs and vendored links out of the doaction values', () => {
    const values = extraction.frontEnd.filter((e) => e.kind === 'doaction').map((e) => e.name);
    expect(values).toHaveLength(DOACTIONS.length);
    expect(values).not.toContain('delete');
    expect(values).not.toContain('vendorOnly');
    expect(values.some((v) => v.includes('#'))).toBe(false);
  });

  it('merges the closures of every acting branch of a value, keeping the guard of a write only a guarded branch reaches', () => {
    const login = entryOf(extraction, 'fe:doaction=login').closure;
    expect(login.writes.map((w) => [w.table, w.op, w.component, w.method, w.conditional])).toEqual([
      ['tfixture', 'insert', DAO, 'create', false],
      ['tfixture', 'update', DAO, 'update', true],
    ]);
    expect(login.conditionalWrites).toEqual([
      {
        table: 'tfixture',
        condition: "not arguments.$.getContentRenderer().validateCSRFTokens or arguments.$.validateCSRFTokens(context='login')",
        source: src(DAO, 20, 22),
        via: ['standardEventsHandler.doAction', 'loginManager.login', 'userUtility.loginByQuery', 'fixtureDAO.update'],
      },
    ]);
    expect(login.visited).toEqual([
      `${EVENTS}#doAction`,
      `${EVENTS}#standardRequireLoginValidator`,
      'core/mura/email/emailManager.cfc#track',
      `${DAO}#create`,
      `${DAO}#update`,
      'core/mura/login/loginManager.cfc#login',
      'core/mura/user/userUtility.cfc#loginByQuery',
    ]);
  });

  it('records the ORM saves and file-store calls a doaction case reaches', () => {
    const audit = entryOf(extraction, 'fe:doaction=fixtureAudit');
    expect(audit.closure.writes.map((w) => [w.table, w.op, w.component, w.method])).toEqual([
      ['tfixture', 'save', ENTITY, 'save'],
      ['tfixture', 'update', DAO, 'update'],
    ]);
    expect(audit.fileStoreWrite).toBe(true);
    expect(audit.closure.fileStoreEvidence).toEqual([
      {
        component: 'core/mura/content/file/fileManager.cfc',
        method: 'deleteVersion',
        source: src('core/mura/user/userManager.cfc', 4),
        conditional: true,
        via: ['standardEventsHandler.doAction', 'userManager.update', 'fileManager.deleteVersion'],
      },
    ]);
  });

  it('keys the saveform branch of the form display object rather than its negated test', () => {
    const form = entryOf(extraction, 'fe:saveform');
    expect(form).toMatchObject({
      kind: 'form-submission',
      name: 'saveform',
      entry: 'form display object submits through dataCollectionBean while the page renders (saveform)',
      source: spanOf(FORM, "<cfif len($.event('saveform'))>", '\t</cfif>'),
      routeKey: 'page:saveform',
      predicate: null,
      rendersCfml: true,
      returnsDataOnly: false,
      writeSet: ['tfixture'],
      fileStoreWrite: true,
      csrfValidation: 'none',
    });
    expect(form.closure.fileStoreEvidence.map((e) => [e.component, e.method, e.source, e.conditional])).toEqual([
      ['core/mura/content/file/fileManager.cfc', 'create', src('core/mura/datacollection/dataCollectionBean.cfc', 3), false],
      ['core/mura/fileWriter.cfc', 'writeFile', src('core/mura/content/file/fileManager.cfc', 3), false],
    ]);
  });

  it('keys processAsyncObject with its declared saveform variant and merges the form branch it renders', () => {
    const [declared] = variantsFor('api:processAsyncObject', variants);
    const asyncForm = entryOf(extraction, 'fe:processasyncobject{saveform}');
    expect(asyncForm).toMatchObject({
      kind: 'form-submission',
      name: 'processAsyncObject{saveform}',
      entry: 'processAsyncObject rendering the form display object with saveform',
      source: src(API, lineIn(API, 'function processAsyncObject'), lineIn(API, 'include "/muraWRM') + 1),
      routeKey: 'api:processasyncobject{saveform}',
      predicate: { variant: declared?.variant, when: declared?.when },
      writeSet: ['tfixture'],
      fileStoreWrite: true,
      rendersCfml: true,
    });
    expect(asyncForm.closure.visited).toEqual([
      `${FORM}#`,
      'core/mura/MuraScope.cfc#init',
      `${API}#processAsyncObject`,
      'core/mura/content/file/fileManager.cfc#create',
      'core/mura/datacollection/dataCollectionBean.cfc#set',
      'core/mura/datacollection/dataCollectionBean.cfc#submit',
      'core/mura/fileWriter.cfc#writeFile',
      `${DAO}#create`,
    ]);
  });

  it.each(REMOTES)('classifies remote method $method by its render evidence, writes, session effects and CSRF checks', (c) => {
    const [csrfContext, csrfValidation] = c.csrf ?? [null, 'none'];
    expect(entryOf(extraction, `fe:commentsproxy.${c.method}`)).toMatchObject({
      kind: 'remote-proxy',
      name: c.method,
      entry: `commentsProxy.${c.method} remote method`,
      source: functionSource(COMMENTS_PROXY, c.method),
      routeKey: `cfc:/${COMMENTS_PROXY.toLowerCase()}?method=${c.method.toLowerCase()}`,
      rendersCfml: c.renders.length > 0,
      returnsDataOnly: c.renders.length === 0,
      renderEvidence: c.renders.map(([marker, needle]) => ({ marker, source: spanOf(COMMENTS_PROXY, needle) })),
      writeSet: c.writeSet ?? [],
      sessionEffects: c.sessionEffects ?? 'none',
      csrfContext,
      csrfValidation,
    });
  });

  it('skips public methods and records remote methods behind an aborting Application.cfc as unreachable', () => {
    expect(extraction.frontEnd.filter((e) => e.kind === 'remote-proxy')).toHaveLength(REMOTES.length);
    expect(extraction.unreachableRemote).toEqual([
      { path: HIDDEN_PROXY, method: 'ping', line: 2, guard: `${HIDDEN_GUARD}:${DENY_SPAN}` },
      { path: SOAP_PROXY, method: 'read', line: 2, guard: `${MURA_GUARD}:${DENY_SPAN}` },
    ]);
  });

  it.each(AJAX)('keys the ajax template $file by its path and render evidence', (c) => {
    const name = path.posix.basename(c.file);
    expect(entryOf(extraction, `fe:cfm:/${c.file.toLowerCase()}`)).toMatchObject({
      kind: 'ajax-endpoint',
      name,
      entry: `${c.module} ajax endpoint ${name}`,
      source: src(c.file, 1, inline(c.file).split('\n').length - 1),
      routeKey: `cfm:/${c.file.toLowerCase()}`,
      unkeyed: false,
      rendersCfml: c.renders.length > 0,
      returnsDataOnly: c.renders.length === 0,
      renderEvidence: c.renders.map(([marker, needle]) => ({ marker, source: spanOf(c.file, needle) })),
      writeSet: c.writeSet,
      csrfValidation: 'none',
    });
  });

  it('leaves out the ajax templates their Application.cfc refuses', () => {
    expect(extraction.frontEnd.filter((e) => e.kind === 'ajax-endpoint').map((e) => e.name)).toEqual(AJAX.map((c) => path.posix.basename(c.file)));
  });

  it('keys the application reload by its reload-key guard, with the default key, the admin link and the start-up closure', () => {
    const include = lineIn(REQUEST_START, 'include "onApplicationStart_include.cfm"');
    const reload = entryOf(extraction, 'fe:appreload');
    expect(reload).toMatchObject({
      kind: 'reload',
      name: 'appreload',
      entry: 'application reload by ?<appreloadkey> (default appreload) or the Global Config reload link; start-up re-runs',
      source: src(REQUEST_START, lineIn(REQUEST_START, 'structKeyExists(url,application.appReloadKey)'), include + 2),
      extraSources: [src(ADMIN_NAV, 2), spanOf(APP_START, 'default="appreload"')],
      routeKey: 'reload:application',
      rendersCfml: true,
      returnsDataOnly: false,
      writeSet: ['tfixture'],
      fileStoreWrite: true,
      sessionEffects: 'none',
      csrfValidation: 'none',
    });
    expect(reload.closure.visited).toEqual([
      `${APP_START}#`,
      'core/mura/content/file/fileManager.cfc#deleteVersion',
      `${DAO}#update`,
      'core/mura/user/userManager.cfc#update',
    ]);
  });

  it('applies reviewed writer overrides to the closures of the entries reaching the overridden method', async () => {
    const overrides: FrontEndWriterOverrides = {
      sourceSha: pinnedSha(),
      writers: [
        {
          id: 'wov:fixture-ratings',
          tables: ['tcontentratings'],
          component: RATER_MANAGER,
          method: 'saveRate',
          op: 'insert',
          source: src(RATER_MANAGER, 2, 4),
          routeKeys: ['page:saverate'],
          keyScope: ['contentid'],
          trigger: 'request',
          sessionEffects: 'none',
          reason: 'The rater manager writes the rating row.',
        },
      ],
    };
    const result = await extractFrontEnd(tree, { index, overrides, routeKeyOptions: { variants } });
    for (const id of ['fe:doaction=saveRate', 'fe:cfm:/core/modules/v1/rater/ajax/saverate.cfm']) {
      expect(entryOf(result, id).writeSet).toEqual(['tcontentratings', 'tfixture']);
      expect(entryOf(result, id).closure.overrides).toEqual(['wov:fixture-ratings']);
    }
  });
});

const OPEN: HttpReachability = { reachable: true, guard: null, allow: null };

const ON_DISK_REACH: Array<[string, HttpReachability]> = [
  [ADMIN_NAV, OPEN],
  ['core/tests/runner.cfm', { reachable: true, guard: `${CORE_GUARD}:4-10`, allow: ['runner.cfm'] }],
  [LINK, { reachable: false, guard: `${CORE_GUARD}:4-10`, allow: ['runner.cfm'] }],
  [PING_AJAX, { reachable: true, guard: `${STATUS_GUARD}:2-6`, allow: ['ping.cfm'] }],
  ['core/modules/v1/status/ajax/secret.cfm', { reachable: false, guard: `${STATUS_GUARD}:2-6`, allow: ['ping.cfm'] }],
  [FAVORITE_AJAX, { reachable: true, guard: `${FAVORITE_GUARD}:2-8`, allow: null }],
  [COMMENTS_PROXY, OPEN],
  [RATE_AJAX, OPEN],
  [SOAP_PROXY, { reachable: false, guard: `${MURA_GUARD}:${DENY_SPAN}`, allow: [] }],
  ['core/modules/v1/hidden/ajax/hidden.cfm', { reachable: false, guard: `${HIDDEN_GUARD}:${DENY_SPAN}`, allow: [] }],
];

const GUARD_CFM = lines('<cfscript>', 'function onRequestStart() {', '\tabort;', '}', '</cfscript>');
const OPEN_CFM = lines('<cfscript>', 'function onRequestStart() {', '\treturn true;', '}', '</cfscript>');
const X_APP = 'core/x/Application.cfc';

interface GuardCase {
  name: string;
  files: Record<string, string>;
  rel: string;
  expected: HttpReachability;
}

const GUARD_CASES: GuardCase[] = [
  { name: 'no Application.cfc up to the root', files: { 'core/x/page.cfm': '' }, rel: 'core/x/page.cfm', expected: OPEN },
  {
    name: 'a root Application.cfc denying every request',
    files: { 'Application.cfc': DENY, 'core/x/page.cfm': '' },
    rel: 'core/x/page.cfm',
    expected: { reachable: false, guard: `Application.cfc:${DENY_SPAN}`, allow: [] },
  },
  { name: 'an Application.cfc declaring no component', files: { [X_APP]: lines('<cfset this.name = "x">') }, rel: 'core/x/page.cfm', expected: OPEN },
  {
    name: 'an Application.cfc without onRequestStart',
    files: { [X_APP]: lines('component {', '\tthis.name = "x";', '}') },
    rel: 'core/x/page.cfm',
    expected: OPEN,
  },
  {
    name: 'an onRequestStart included beside the functions, not inside one',
    files: {
      [X_APP]: lines('component {', '\tfunction onSessionStart() {', '\t\tinclude "open.cfm";', '\t}', '\tinclude "guard.cfm";', '}'),
      'core/x/guard.cfm': GUARD_CFM,
      'core/x/open.cfm': OPEN_CFM,
    },
    rel: 'core/x/page.cfm',
    expected: { reachable: false, guard: 'core/x/guard.cfm:2-4', allow: [] },
  },
  {
    name: 'an onRequestStart included through the /muraWRM mapping',
    files: { [X_APP]: lines('component {', '\tinclude "/muraWRM/core/appcfc/guard.cfm";', '}'), 'core/appcfc/guard.cfm': GUARD_CFM },
    rel: 'core/x/page.cfm',
    expected: { reachable: false, guard: 'core/appcfc/guard.cfm:2-4', allow: [] },
  },
  {
    name: 'an onRequestStart included by a literal climb',
    files: {
      [X_APP]: lines('<cfcomponent>', '\t<cfinclude template="#repeatString(\'../\',2)#core/appcfc/guard.cfm">', '</cfcomponent>'),
      'core/appcfc/guard.cfm': GUARD_CFM,
    },
    rel: 'core/x/page.cfm',
    expected: { reachable: false, guard: 'core/appcfc/guard.cfm:2-4', allow: [] },
  },
  {
    name: 'a climb by a depth no literal sets',
    files: {
      [X_APP]: lines('<cfcomponent>', '\t<cfinclude template="#repeatString(\'../\',variables.depth)#core/appcfc/guard.cfm">', '</cfcomponent>'),
      'core/appcfc/guard.cfm': GUARD_CFM,
    },
    rel: 'core/x/page.cfm',
    expected: OPEN,
  },
  {
    name: 'an interpolated include',
    files: { [X_APP]: lines('component {', '\tinclude "#variables.base#/guard.cfm";', '}'), 'core/x/guard.cfm': GUARD_CFM },
    rel: 'core/x/page.cfm',
    expected: OPEN,
  },
  {
    name: 'an include above the root',
    files: { [X_APP]: lines('component {', '\tinclude "../../../guard.cfm";', '}') },
    rel: 'core/x/page.cfm',
    expected: OPEN,
  },
  {
    name: 'an abort only inside a string literal',
    files: { [X_APP]: lines('component {', '\tfunction onRequestStart() {', '\t\twriteOutput("abort;");', '\t}', '}') },
    rel: 'core/x/page.cfm',
    expected: OPEN,
  },
  {
    name: 'an unconditional abort after an allow-listed one',
    files: {
      [X_APP]: lines(
        'component {',
        '\tfunction onRequestStart() {',
        '\t\tif (!(listFindNoCase("ping.cfm", listLast(cgi.script_name, "/")))) {',
        '\t\t\tabort;',
        '\t\t}',
        '\t\tabort;',
        '\t}',
        '}',
      ),
    },
    rel: 'core/x/ping.cfm',
    expected: { reachable: false, guard: `${X_APP}:2-7`, allow: [] },
  },
  {
    name: 'an allow-list beside an abort under another condition',
    files: {
      [X_APP]: lines(
        'component {',
        '\tfunction onRequestStart() {',
        '\t\tif (cgi.request_method == "TRACE") {',
        '\t\t\tabort;',
        '\t\t}',
        '\t\tif (not listFind("ping.cfm,status.cfm", listLast(cgi.script_name, "/"))) {',
        '\t\t\tabort;',
        '\t\t}',
        '\t}',
        '}',
      ),
    },
    rel: 'core/x/ping.cfm',
    expected: { reachable: true, guard: `${X_APP}:2-9`, allow: ['ping.cfm', 'status.cfm'] },
  },
  {
    name: 'a tag-syntax abort in a cfelse branch',
    files: {
      [X_APP]: lines(
        '<cfcomponent>',
        '<cffunction name="onRequestStart">',
        "\t<cfif cgi.remote_addr eq '127.0.0.1'>",
        '\t\t<cfreturn true>',
        '\t<cfelse>',
        '\t\t<cfabort>',
        '\t</cfif>',
        '</cffunction>',
        '</cfcomponent>',
      ),
    },
    rel: 'core/x/page.cfm',
    expected: { reachable: true, guard: `${X_APP}:2-8`, allow: null },
  },
];

describe('httpReachability and isHttpReachable', () => {
  it.each(ON_DISK_REACH)('decide %s by its nearest Application.cfc', (rel, expected) => {
    expect(httpReachability(tree, rel)).toEqual(expected);
    expect(isHttpReachable(tree, rel)).toBe(expected.reachable);
  });

  it.each(GUARD_CASES)('decide a file under $name', ({ files, rel, expected }) => {
    const source = memorySourceTree(files);
    expect(httpReachability(source, rel)).toEqual(expected);
    expect(isHttpReachable(source, rel)).toBe(expected.reachable);
  });
});

const EMPTY_CLOSURE = {
  tables: [],
  writes: [],
  conditionalWrites: [],
  fileStore: false,
  fileStoreEvidence: [],
  sessionEffects: 'none',
  threads: [],
  unresolved: [],
  overrides: [],
  visited: [],
};

const RELOAD_CASES: Array<{ name: string; text: string; lines: [number, number] }> = [
  {
    name: 'in tag syntax, by the include line',
    text: lines('<cfif structKeyExists(url, application.appReloadKey)>', '\t<cfinclude template="onApplicationStart_include.cfm">', '</cfif>'),
    lines: [2, 2],
  },
  {
    name: 'under nested reload-key guards, by the outermost guard',
    text: lines(
      'if (structKeyExists(url, application.appReloadKey)) {',
      "\tif (url[application.appReloadKey] != 'skip') {",
      '\t\tinclude "onApplicationStart_include.cfm";',
      '\t}',
      '}',
    ),
    lines: [1, 5],
  },
  {
    name: 'outside any reload-key guard, by the include line',
    text: lines('if (isDefined("onApplicationStart")) {', '\tinclude "onApplicationStart_include.cfm";', '}'),
    lines: [2, 2],
  },
];

describe('extractFrontEnd edge cases', () => {
  it('returns no entries for a tree without any front-end source', async () => {
    expect(await extractMemory({ [DAO]: DAO_TEXT })).toEqual({ frontEnd: [], unreachableRemote: [] });
  });

  it('skips a front controller without handleRootRequest, a form testing saveform only negated and start-up never re-run', async () => {
    const result = await extractMemory({
      [SERVER]: lines('<cfcomponent>', '<cffunction name="handleAPIRequest" output="false">', '</cffunction>', '</cfcomponent>'),
      [FORM]: lines("<cfif not len($.event('saveform'))>", '\t<cfset objectParams.view = "form"/>', '</cfif>'),
      [REQUEST_START]: lines('param name="application.instanceID" default=createUUID();'),
    });
    expect(result.frontEnd).toEqual([]);
  });

  it('ignores an events handler that declares no component', async () => {
    expect((await extractMemory({ [EVENTS]: lines('<cfset request.doaction = "noop">') }, { plain: true })).frontEnd).toEqual([]);
  });

  it.each(RELOAD_CASES)('keys a reload whose start-up include sits $name, with an empty closure without start-up', async (c) => {
    const result = await extractMemory({ [REQUEST_START]: c.text });
    expect(result.frontEnd).toHaveLength(1);
    expect(entryOf(result, 'fe:appreload')).toMatchObject({
      source: { path: REQUEST_START, lines: c.lines },
      extraSources: [],
      routeKey: 'reload:application',
      writeSet: [],
      closure: EMPTY_CLOSURE,
    });
  });

  it('reads the cases of a switch on the loop variable, of a function the loop passes it to by name, and component-level comparisons', async () => {
    const handler = lines(
      '<cfcomponent>',
      "<cfset variables.mode = url.doaction eq 'atComponent'>",
      '<cffunction name="standardDoActionsHandler" output="false">',
      '\t<cfargument name="event">',
      "\t<cfloop list=\"#arguments.event.getValue('doaction')#\" index=\"act\">",
      '\t\t<cfswitch expression="#act#">',
      '\t\t\t<cfcase value="inline"></cfcase>',
      '\t\t</cfswitch>',
      '\t\t<cfset dispatch(theaction=act)>',
      '\t</cfloop>',
      '</cffunction>',
      '<cffunction name="dispatch" output="false">',
      '\t<cfargument name="theaction">',
      '\t<cfswitch expression="#arguments.theaction#">',
      '\t\t<cfcase value="named"></cfcase>',
      '\t</cfswitch>',
      '</cffunction>',
      '</cfcomponent>',
    );
    const result = await extractMemory({ [EVENTS]: handler });
    expect(result.frontEnd.map((e) => [e.id, e.doactionEvidence, e.source.lines, e.entry])).toEqual([
      ['fe:doaction=atComponent', 'comparison', [2, 2], `doaction=atComponent: named by ${EVENTS}; no code acts on it, so the page renders`],
      ['fe:doaction=inline', 'handler-case', [7, 7], 'doaction=inline: standardEventsHandler.doAction case'],
      ['fe:doaction=named', 'handler-case', [15, 15], 'doaction=named: standardEventsHandler.doAction case'],
    ]);
  });

  it('reads doaction comparisons of a script-syntax events handler with the writes of their branch', async () => {
    const handler = scriptCfc(
      '\tpublic void function standardRequireLoginValidator(required any event) {',
      "\t\tif (arguments.event.getValue('doaction') == 'scripted') {",
      "\t\t\tgetBean('fixtureDAO').create({fixtureid='', siteid='', name='scripted'});",
      '\t\t}',
      '\t}',
    );
    const result = await extractMemory({ [DAO]: DAO_TEXT, [EVENTS]: handler });
    expect(entryOf(result, 'fe:doaction=scripted')).toMatchObject({
      doactionEvidence: 'comparison',
      entry: `doaction=scripted: read by ${EVENTS}; not a doAction case`,
      source: src(EVENTS, 3, 4),
      writeSet: ['tfixture'],
    });
  });

  it('reads CSRF contexts as written, through short-circuits and into the methods an entry calls', async () => {
    const result = await extractMemory({
      'core/modules/v1/csrf/ajax/csrfProxy.cfc': scriptCfc(
        "\tremote any function quoted() { return session.csrf.validateCSRFTokens(context='it''s'); }",
        '\tremote any function hashed() { return session.csrf.validateCSRFTokens(context="a##b"); }',
        '\tremote any function computed() { return session.csrf.validateCSRFTokens(context="#arguments.id#"); }',
        '\tremote any function spaced() { return session.csrf.validateCSRFTokens(context=arguments.a &   arguments.b); }',
        "\tremote any function mixed() { return true || !session.csrf.validateCSRFTokens(context='skipped') || session.csrf.validateCSRFTokens(context='live'); }",
        "\tremote any function bypassed() { return true or session.csrf.validateCSRFTokens(context='only'); }",
        '\tremote any function delegated() { return new mura.fixture.guardManager().check(); }',
        '\tremote any function unchecked() { return session.csrf.validateCSRFTokens(argumentCollection=arguments); }',
      ),
      'core/mura/fixture/guardManager.cfc': scriptCfc(
        "\tpublic boolean function check() { return session.csrf.validateCSRFTokens(context='delegated'); }",
      ),
    });
    expect(Object.fromEntries(result.frontEnd.map((e) => [e.name, [e.csrfContext, e.csrfValidation]]))).toEqual({
      quoted: ["it's", 'validates'],
      hashed: ['a#b', 'validates'],
      computed: ['"#arguments.id#"', 'validates'],
      spaced: ['arguments.a & arguments.b', 'validates'],
      mixed: ['live', 'validates'],
      bypassed: ['only', 'bypassed'],
      delegated: ['delegated', 'validates'],
      unchecked: [null, 'none'],
    });
  });

  it('rejects two front-end entries sharing an id', async () => {
    const proxy = scriptCfc('\tremote any function get() {', "\t\treturn '';", '\t}');
    await expect(
      extractMemory({ [COMMENTS_PROXY]: proxy, 'core/modules/v1/legacy/ajax/commentsProxy.cfc': proxy }),
    ).rejects.toThrow('two front-end entries share the id fe:commentsproxy.get');
  });

  it('rejects a JSON API whose processAsyncObject has no saveform variant', async () => {
    await expect(extractMemory({ [API]: inline(API) }, { variants: [] })).rejects.toThrow(
      'no variant of api:processasyncobject is declared with the saveform condition',
    );
  });

  it('records an ajax template whose route key cannot be computed as unkeyed and rejects any other entry that fails', async () => {
    const unusable = (route: string): VariantDeclaration[] => [{ route, variant: 'unusable', when: [{} as VariantCondition] }];
    const files = { [SERVER]: inline(SERVER), [RATE_AJAX]: inline(RATE_AJAX) };
    const result = await extractMemory(files, { variants: unusable(`cfm:/${RATE_AJAX.toLowerCase()}`) });
    expect(entryOf(result, `fe:cfm:/${RATE_AJAX.toLowerCase()}`)).toMatchObject({ routeKey: null, unkeyed: true });
    expect(entryOf(result, 'fe:render').routeKey).toBe('page:render');
    await expect(extractMemory(files, { variants: unusable('page:render') })).rejects.toThrow(TypeError);
  });
});
