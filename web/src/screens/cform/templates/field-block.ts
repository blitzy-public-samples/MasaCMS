import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Renders the form-builder `field-block` template (legacy `templates/field-block.cfm`) as untrimmed markup. */
export function fieldBlock(input: { readonly rb: RbLookup }): string {
  return (
    '\n' +
    '\t\t<li>\n' +
    '\t\t\t<ul class="mura-tb-nav-utility">\n' +
    `\t\t\t\t<li><div id="button-trash" title="${input.rb.rbKey('formbuilder.delete')}"></div></li>\n` +
    '\t\t\t</ul>\n' +
    '\t\t\t<div class="mura-tb-block">\n' +
    '\t\t\t\t<span></span>\n' +
    '\t\t\t</div>\n' +
    '\t\t</li>\n'
  );
}
