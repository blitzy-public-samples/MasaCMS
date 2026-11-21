import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Form-builder `message-delete-row` dialog body: the row-delete confirmation label. */
export function messageDeleteRow(input: { readonly rb: RbLookup }): string {
  return '<span>' + input.rb.rbKey('formbuilder.dataset.rowdeleteconfirm') + '</span>';
}
