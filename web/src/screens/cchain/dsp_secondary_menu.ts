import { encodeHtml, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** The approval chain a cchain view loaded: its id and whether it is not yet saved. */
export interface CchainMenuChain {
  readonly chainId: string;
  readonly isNew: boolean;
}

/** CFML `listLast(list, ".")`: the last non-empty `.`-delimited item, `''` when there is none. */
function listLastDot(list: string): string {
  return list.split('.').filter((item) => item !== '').at(-1) ?? '';
}

/** A `btn` link whose label, unencoded as legacy emits it, is both its title and its text after the icon. */
function menuLink(rb: RbLookup, key: string, icon: string, href: string): SafeHtml {
  const label = raw(rb.rbKey(key));
  return html`<a class="btn" title="${label}" href="${raw(href)}"><i class="${icon}"></i> ${label}</a>`;
}

/** Renders the approval-chain secondary menu for the current cchain action; `chain` is required for pending/edit. */
export function renderCchainSecondaryMenu(req: AdminRequest, rb: RbLookup, chain?: CchainMenuChain): SafeHtml {
  const siteid = encodeUrl(req.rc.siteid ?? '');
  const backLink = (): SafeHtml =>
    menuLink(
      rb,
      'approvalchains.backtoapprovalchains',
      'mi-arrow-circle-left',
      `./?muraAction=cchain.list&siteid=${siteid}`,
    );

  let links: SafeHtml[] = [];
  switch (listLastDot(req.action)) {
    case 'pending':
      links = [
        backLink(),
        menuLink(
          rb,
          'approvalchains.vieweditform',
          'mi-pencil',
          `./?muraAction=cchain.edit&siteid=${siteid}&chainID=${encodeHtml(chain?.chainId)}`,
        ),
      ];
      break;
    case 'list':
      links = [
        menuLink(
          rb,
          'approvalchains.addapprovalchain',
          'mi-plus-circle',
          `./?muraAction=cchain.edit&chainID=&siteid=${siteid}`,
        ),
      ];
      break;
    case 'edit':
      links = [backLink()];
      // Legacy interpolates this chain id without encoding, unlike the pending case's edit link.
      if (chain !== undefined && !chain.isNew) {
        links.push(
          menuLink(
            rb,
            'approvalchains.pendingrequests',
            'mi-reorder',
            `./?muraAction=cchain.pending&siteid=${siteid}&chainID=${chain.chainId}`,
          ),
        );
      }
      break;
  }
  return html`<div class="nav-module-specific btn-group">${links}</div>`;
}
