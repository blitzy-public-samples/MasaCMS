// Unit tests for the approval-chain secondary menu against cchain/dsp_secondary_menu.cfm.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeHtml, encodeUrl, isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { renderCchainSecondaryMenu, type CchainMenuChain } from '@/screens/cchain/dsp_secondary_menu';
import { makeAdminRequest } from '../../helpers/admin-request';

const here = import.meta.dirname ?? __dirname;
const MENU_CFM = path.resolve(here, '../../../../admin/core/views/cchain/dsp_secondary_menu.cfm');
const SITE_ID = 'tenant a&b';
const CHAIN_ID = 'D1000000-0000-0000-0000000000000001&x=<1>';
const SAVED: CchainMenuChain = { chainId: CHAIN_ID, isNew: false };
const UNSAVED: CchainMenuChain = { chainId: CHAIN_ID, isNew: true };

/** Answers markup that legacy emits unencoded for every key. */
const marked: RbLookup = {
  locale: 'en_US',
  rbKey: (key) => `<b>${key}</b> & "co"`,
  messageFormat: (pattern) => pattern,
};

/** The menu `dsp_secondary_menu.cfm` outputs for action item `item`, with whitespace between tags dropped. */
function legacyMenu(item: string, rb: RbLookup, siteId: string, chain?: CchainMenuChain): string {
  const source = readFileSync(MENU_CFM, 'utf8').replaceAll('\r\n', '\n');
  const body = source
    .slice(source.indexOf('<cfoutput>') + '<cfoutput>'.length, source.lastIndexOf('</cfoutput>'))
    .replace(/>\s+</g, '><')
    .trim();
  const cases = new Map(
    [...body.matchAll(/<cfcase value="(\w+)">(.*?)<\/cfcase>/gs)].map(([, value, block]) => [value, block]),
  );
  const block = (cases.get(item) ?? '').replace(/<cfif not chain\.getIsNew\(\)>(.*?)<\/cfif>/s, (_, inner: string) =>
    chain?.isNew === false ? inner : '',
  );
  return body
    .replace(/<cfset [^>]*>/, '')
    .replace(/<cfswitch [^>]*>.*<\/cfswitch>/s, () => block)
    .replace(/#application\.rbFactory\.getKeyValue\(session\.rb,'([^']+)'\)#/g, (_, key: string) => rb.rbKey(key))
    .replaceAll("#esapiEncode('url',rc.siteid)#", () => encodeUrl(siteId))
    .replaceAll("#esapiEncode('html',chain.getChainID())#", () => encodeHtml(chain?.chainId))
    .replaceAll('#chain.getChainID()#', () => chain?.chainId ?? '');
}

/** The port's menu markup on `cChain.<item>` for `siteId`. */
function portMenu(item: string, rb: RbLookup, siteId: string, chain?: CchainMenuChain): string {
  const req = makeAdminRequest({ circuit: 'cChain', item, rc: { siteid: siteId } }, 'admin');
  const markup = renderCchainSecondaryMenu(req, rb, chain);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

describe('renderCchainSecondaryMenu', () => {
  it.each<[string, string, CchainMenuChain | undefined]>([
    ['pending', 'pending', SAVED],
    ['list', 'list', undefined],
    ['edit of a saved chain', 'edit', SAVED],
    ['edit of a new chain', 'edit', UNSAVED],
    ['an action without a case', 'update', undefined],
    ['a mixed-case action', 'Pending', SAVED],
  ])('matches the legacy menu on %s', (_, item, chain) => {
    expect(portMenu(item, marked, SITE_ID, chain)).toBe(legacyMenu(item.toLowerCase(), marked, SITE_ID, chain));
  });

  it.each([
    [
      'list',
      undefined,
      '<a class="btn" title="Add Approval Chain" href="./?muraAction=cchain.edit&chainID=&siteid=default">' +
        '<i class="mi-plus-circle"></i> Add Approval Chain</a>',
    ],
    [
      'edit',
      UNSAVED,
      '<a class="btn" title="Back to Approval Chains" href="./?muraAction=cchain.list&siteid=default">' +
        '<i class="mi-arrow-circle-left"></i> Back to Approval Chains</a>',
    ],
  ])('renders the en_US %s menu the legacy server emits', (item, chain, link) => {
    expect(portMenu(item, rbFor('en_US'), 'default', chain)).toBe(
      `<div class="nav-module-specific btn-group">${link}</div>`,
    );
  });

  it('URL-encodes the site id and HTML-encodes the chain id only in the pending edit link', () => {
    expect(portMenu('pending', marked, SITE_ID, SAVED)).toContain(
      'href="./?muraAction=cchain.edit&siteid=tenant+a%26b' +
        '&chainID=D1000000-0000-0000-0000000000000001&amp;x&#x3d;&lt;1&gt;"',
    );
    expect(portMenu('edit', marked, SITE_ID, SAVED)).toContain(
      `href="./?muraAction=cchain.pending&siteid=tenant+a%26b&chainID=${CHAIN_ID}"`,
    );
  });
});
