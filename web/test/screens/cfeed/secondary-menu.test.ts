// The collections secondary menu's list links against cfeed/dsp_secondary_menu.cfm, by the site rc.siteid names.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { toString } from '@/lib/html';
import { cfeedSecondaryMenu } from '@/screens/cfeed/secondary-menu';
import { makeAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomLink } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';

const COLLECTIONS_MODULE_ID = '00000000000000000000000000000000011';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const LIST = { circuit: 'cFeed', item: 'list' } as const;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The list menu's links on `siteid`: both Add links, then Permissions when `permissions`. */
function listLinks(siteid: string, permissions: boolean): DomLink[] {
  const add = (type: string, text: string): DomLink => ({
    href: `./?muraAction=cfeed.edit&feedID=&siteid=${siteid}&type=${type}`,
    text,
  });
  const module = COLLECTIONS_MODULE_ID;
  const perm: DomLink = {
    href: `./?muraAction=cperm.module&contentid=${module}&moduleid=${module}&siteid=${siteid}`,
    text: 'Permissions',
  };
  return [add('Local', 'Add Local Index'), add('Remote', 'Add Remote Feed'), ...(permissions ? [perm] : [])];
}

describe('cfeedSecondaryMenu Permissions on list', () => {
  it.each(REQUESTED_SITE_CASES)('links Permissions for $who only when it administers that site', (testCase) => {
    const markup = toString(cfeedSecondaryMenu(testCase.request(LIST)));

    expect(fragmentModel(markup).links).toEqual(listLinks(testCase.siteid, testCase.administers));
  });

  it('leaves Permissions out for Collections plus Site Manager module access, which legacy does not check', () => {
    const roles = [Roles.systemUser, moduleRole(COLLECTIONS_MODULE_ID), moduleRole(SITE_MANAGER_MODULE_ID)];
    const markup = toString(cfeedSecondaryMenu(makeAdminRequest({ ...LIST, user: { roles } }, 'qaEditor')));

    expect(fragmentModel(markup).links).toEqual(listLinks('default', false));
  });
});
