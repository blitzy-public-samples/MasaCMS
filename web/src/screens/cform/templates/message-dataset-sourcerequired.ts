import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Form-builder dialog `message-dataset-sourcerequired`: the "source required" label in a bare span. */
export function messageDatasetSourcerequired(input: { readonly rb: RbLookup }): string {
  return '<span>' + input.rb.rbKey('formbuilder.dataset.sourcerequired') + '</span>';
}
