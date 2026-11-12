import type { Mapping } from '@opt2/platform/migration-kit';
import {
  tusersCredentialMapping,
  tusersGroupAccountMapping,
  tusersLoginStateMapping,
  tusersUserAccountMapping,
} from './tusers.js';
import { tpermissionsMapping, tusersmembMapping } from './memberships.js';
import {
  tclassextenddatauseractivityGroupMapping,
  tuseraddressesGroupMapping,
  tusersfavoritesGroupMapping,
  tusersinterestsGroupMapping,
  tuserstagsGroupMapping,
} from './group-children.js';
import {
  toauthclientsMapping,
  toauthtokensMapping,
  tredirectsMapping,
  ttrashGroupMapping,
  tuserdeviceMapping,
  tuserremotesessionsMapping,
  tuserstrikesMapping,
} from './auth-records.js';

export {
  tusersCredentialMapping,
  tusersGroupAccountMapping,
  tusersLoginStateMapping,
  tusersUserAccountMapping,
} from './tusers.js';
export { tpermissionsMapping, tusersmembMapping } from './memberships.js';
export {
  tclassextenddatauseractivityGroupMapping,
  tuseraddressesGroupMapping,
  tusersfavoritesGroupMapping,
  tusersinterestsGroupMapping,
  tuserstagsGroupMapping,
} from './group-children.js';
export {
  toauthclientsMapping,
  toauthtokensMapping,
  tredirectsMapping,
  ttrashGroupMapping,
  tuserdeviceMapping,
  tuserremotesessionsMapping,
  tuserstrikesMapping,
} from './auth-records.js';

/** Identity's legacy↔target mappings in dependency order, one per unit in `IDENTITY_UNITS` order. */
export const mappings: readonly Mapping[] = Object.freeze([
  tusersGroupAccountMapping,
  tusersUserAccountMapping,
  tusersCredentialMapping,
  tusersLoginStateMapping,
  tusersmembMapping,
  tpermissionsMapping,
  tuseraddressesGroupMapping,
  tusersinterestsGroupMapping,
  tuserstagsGroupMapping,
  tusersfavoritesGroupMapping,
  tclassextenddatauseractivityGroupMapping,
  tuserstrikesMapping,
  tuserremotesessionsMapping,
  tuserdeviceMapping,
  tredirectsMapping,
  toauthclientsMapping,
  toauthtokensMapping,
  ttrashGroupMapping,
]);
