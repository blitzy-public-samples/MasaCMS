/** The cUsers roster writes people withholds or refuses, through `app.inject` with the identity double over the recording database. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, cfUuid } from '@opt2/platform/legacy-compat';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { MODULE_008_ONLY, MODULE_USER_A, SITE_ADMIN_A, type TestActor } from '../helpers/fixtures.js';
import {
  GROUP,
  LEGACY_503,
  S2_TARGET,
  SITE,
  STORED_USER,
  UPDATE_ADDRESS,
  UPDATE_USER,
  accountSteps,
  addressForm,
  addressQuery,
  csrfContexts,
  editUserUrl,
  newIdentity,
  rendered,
  send,
  userForm,
  userQuery,
  without,
  type Post,
  type RouteResult,
} from '../helpers/roster-posts.js';

const EDIT_PROFILE_URL = adminUrl({ circuit: 'cEditProfile', action: 'edit' });

describe('cUsers roster writes people never executes', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp({ identity: newIdentity() });
  });

  afterAll(async () => {
    await testApp?.close();
  });

  beforeEach(() => {
    testApp.identity.clear();
    testApp.db.clear();
  });

  it.each<[string, Post]>([
    ['a photo upload', { fields: userForm('Update'), query: userQuery(STORED_USER), files: [{ field: 'newFile', filename: 'me.png' }] }],
    ['a new user with a photo', { fields: userForm('Add'), query: userQuery(''), files: [{ field: 'newFile', filename: 'me.jpg' }] }],
    ['a photo removal', { fields: userForm('Update', { removePhotoFile: 'true' }), query: userQuery(STORED_USER) }],
    ['a save naming neither a user nor a group', { fields: without(userForm('Update'), 'type'), query: userQuery(STORED_USER) }],
    ['a user delete', { fields: userForm('Delete'), query: userQuery(STORED_USER) }],
    ['the delete of an S2 user, which legacy voids for a caller without S2', { fields: userForm('Delete'), query: userQuery(S2_TARGET.userid) }],
    ['a group save', { fields: userForm('Update', { type: '1', groupname: 'Editors' }), query: userQuery(GROUP) }],
    ['a new group', { fields: userForm('Add', { type: '1', groupname: 'Editors' }), query: userQuery('') }],
    ['a group delete', { fields: userForm('Delete', { type: '1' }), query: userQuery(GROUP) }],
    ['extended attributes of a new user', { fields: userForm('Add', { extendSetID: cfUuid() }), query: userQuery('') }],
    ['extended attributes of an update', { fields: userForm('Update', { extendSetID: cfUuid() }), query: userQuery(STORED_USER) }],
  ])('answers %s with the legacy 503 before consuming the token', async (_name, post) => {
    const { status, body } = await send(testApp.app, UPDATE_USER, SITE_ADMIN_A, post);
    expect(status).toBe(503);
    expect(body).toMatchObject(LEGACY_503);
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['an address delete', addressForm('Delete', { addressID: cfUuid() })],
    ['extended attributes of an address', addressForm('Update', { addressID: cfUuid(), extendSetID: cfUuid() })],
    ['an address form holding an empty extended set', addressForm('Add', { extendSetID: '' })],
  ])('answers %s with the legacy 503 before consuming the token', async (_name, fields) => {
    const { status, body } = await send(testApp.app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields, query: addressQuery(STORED_USER) });
    expect(status).toBe(503);
    expect(body).toMatchObject(LEGACY_503);
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, string]>([
    ['a new user', ''],
    ['a new user under its generated id', cfUuid()],
    ['an update', STORED_USER],
  ])('fails %s whose token identity refuses as legacy fails on the unset user bean, writing nothing', async (_name, userid) => {
    testApp.identity.csrf.rejectAll();
    const { status } = await send(testApp.app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm(userid === STORED_USER ? 'Update' : 'Add'), query: userQuery(userid) });
    expect(status).toBe(500);
    expect(csrfContexts(testApp.identity)).toEqual([[userid, false]]);
    expect(accountSteps(testApp.identity)).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it('fails a user save without a token before asking identity', async () => {
    const { status } = await send(testApp.app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Update'), query: userQuery(STORED_USER), withoutToken: true });
    expect(status).toBe(500);
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, TestActor, string, string]>([
    ['the user edit screen', SITE_ADMIN_A, '', editUserUrl(STORED_USER, '')],
    ['the user edit screen of the group it came from', MODULE_USER_A, GROUP, editUserUrl(STORED_USER, GROUP)],
    ['the profile editor', SITE_ADMIN_A, 'editprofile', EDIT_PROFILE_URL],
    ['the profile editor, matched ignoring case', SITE_ADMIN_A, 'EditProfile', EDIT_PROFILE_URL],
  ])('writes no address under a refused token and still redirects to %s', async (_name, actor, routeid, expected) => {
    testApp.identity.csrf.rejectAll();
    const { status, body } = await send<RouteResult>(testApp.app, UPDATE_ADDRESS, actor, { fields: addressForm('Add'), query: addressQuery(STORED_USER, routeid) });
    expect(status).toBe(200);
    expect(body.written).toBe(false);
    expect(rendered(body.redirect)).toBe(expected);
    expect(csrfContexts(testApp.identity)).toEqual([[`updateaddress${STORED_USER}`, false]]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, string, Post]>([
    ['user', UPDATE_USER, { fields: userForm('Update'), query: userQuery(STORED_USER) }],
    ['address', UPDATE_ADDRESS, { fields: addressForm('Add'), query: addressQuery(STORED_USER) }],
  ])('refuses a %s save to a caller holding the Users module without Site Manager, before the token', async (_name, path, post) => {
    const { status } = await send(testApp.app, path, MODULE_008_ONLY, post);
    expect(status).toBe(403);
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['an empty action', addressForm('')],
    ['no action', without(addressForm(''), 'action')],
  ])('writes nothing for an address save with %s and still redirects', async (_name, fields) => {
    const { body } = await send<RouteResult>(testApp.app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields, query: addressQuery(STORED_USER) });
    expect(body).toEqual({ written: false, redirect: { action: 'cUsers.edituser', params: { siteid: SITE, userid: STORED_USER, routeid: '' } } });
    expect(csrfContexts(testApp.identity)).toEqual([[`updateaddress${STORED_USER}`, true]]);
    expect(testApp.db.writes()).toEqual([]);
  });
});
