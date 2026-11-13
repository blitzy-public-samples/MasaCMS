// Parent Category options of `ccategory/dsp_parents.cfm`, the edit form's `parentID` select (server-only).
import { cfEq } from '@/lib/cfml';
import { html, raw, type SafeHtml } from '@/lib/html';
import type { CategoryNode } from './dsp-nest';

/** Attributes of `<cf_dsp_parents>`. */
export interface CategoryParentsInput {
  readonly nodes: readonly CategoryNode[];
  /** `rc.categoryID`: that category and its descendants are left out. */
  readonly categoryID: string;
  /** `rc.parentID`: the option selected. */
  readonly actualParentID: string;
  /** 1 at the top; each level indents its names by one more `&nbsp;&nbsp;`. */
  readonly nestLevel: number;
}

/**
 * One option per category of `nodes` other than `categoryID`, each followed by the options of its children.
 * ACF whitespace management prints the tag's whitespace-only lines as nothing.
 */
export function renderCategoryParents(input: CategoryParentsInput): SafeHtml {
  const { categoryID, actualParentID, nestLevel } = input;
  const indent = raw('&nbsp;&nbsp;'.repeat(nestLevel));
  return html`${input.nodes
    .filter((node) => !cfEq(node.categoryID, categoryID))
    .map(
      // Legacy writes the id unencoded.
      (node) => html`
<option value="${raw(node.categoryID)}" ${cfEq(node.categoryID, actualParentID) && raw('selected')}>${indent}${node.name}</option>
${renderCategoryParents({ ...input, nodes: node.children, nestLevel: nestLevel + 1 })}`,
    )}`;
}
