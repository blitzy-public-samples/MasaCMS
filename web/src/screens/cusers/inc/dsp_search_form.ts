// User search form of `cusers/inc/dsp_search_form.cfm`, included by the users header and the search view (server-only).
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { CusersRc } from '../gate';

/** Inputs of {@link renderSearchForm}; `search` is the request's `search` value, `''` when it sent none. */
export type SearchFormArgs = {
  readonly rc: Pick<CusersRc, 'siteid' | 'ispublic'>;
  readonly search: string;
  readonly rb: RbLookup;
};

/** The include's output with its surrounding line breaks; labels and the advanced-search URL are raw, as in legacy. */
export function renderSearchForm({ rc, search, rb }: SearchFormArgs): SafeHtml {
  const label = (key: string): SafeHtml => raw(rb.rbKey(key));
  const advanced = label('user.advanced');
  return html`
  <form class="form-inline" novalidate="novalidate" action="" method="get" name="form1" id="siteSearch">
    <div class="mura-search">
      <span class="mura-input-set">
      <input id="search" name="search" type="text" value="${search}" placeholder="${label('user.searchforusers')}" />
      <button type="button" class="btn" onclick="submitForm(document.forms.form1);">
        <i class="mi-search"></i>
      </button>
    </span>
      <button type="button" class="btn" onclick="actionModal();window.location='./?muraAction=cUsers.advancedSearch&amp;ispublic=${raw(encodeUrl(rc.ispublic))}&amp;siteid=${raw(encodeUrl(rc.siteid))}&amp;newSearch=true'" value="${advanced}">
        ${advanced}
      </button>
      <input type="hidden" name="siteid" value="${rc.siteid}" />
      <input type="hidden" name="ispublic" value="${rc.ispublic}" />
      <input type="hidden" name="muraAction" value="cUsers.search" />
    </div>
  </form>
`;
}
