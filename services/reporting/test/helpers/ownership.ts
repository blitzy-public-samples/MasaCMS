// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Readers of the `opt2/table-ownership.json` row predicates of reporting's split targets. */

const CLASS_MAP_PREDICATE = /^classMap owner = (\S+)$/;
const IN_PREDICATE = /^\w+ in \((.+)\)$/;

/** Values a split target's row predicate selects: its class-map owner, or its `in (...)` list in predicate order. */
export function predicateValues(unit: string, rowPredicate: string | null): string[] {
  const predicate = rowPredicate ?? '';
  const owner = CLASS_MAP_PREDICATE.exec(predicate)?.[1];
  if (owner !== undefined) return [owner];
  const list = IN_PREDICATE.exec(predicate)?.[1];
  if (list === undefined) throw new Error(`${unit}: row predicate ${JSON.stringify(rowPredicate)} selects no values`);
  return list.split(',').map((value) => value.trim().replace(/^'(.*)'$/, '$1'));
}

/** Key `mappingCoverage` files a target under: `<table>`, or `<table>{<by>=<values>}` for a split table. */
export function coverageKeyOf(table: { table: string; split?: { by: string } }, target: { unit: string; rowPredicate: string | null }): string {
  if (table.split === undefined) return table.table;
  return `${table.table}{${table.split.by}=${predicateValues(target.unit, target.rowPredicate).join(',')}}`;
}
