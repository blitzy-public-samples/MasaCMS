import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';

const CUTOVER_FIELDS: ReadonlySet<string> = new Set(['cutoverDir', 'versionsDir', 'schemaFile', 'variantsFile', 'groupsFile']);

/** The paths that do not depend on the cut-over directory. */
function outsideCutover(paths: GatewayPaths): Record<string, string> {
  return Object.fromEntries(Object.entries(paths).filter(([field]) => !CUTOVER_FIELDS.has(field)));
}

describe('resolveGatewayPaths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('anchors the package root at gateway/ and the repository root at its parent', () => {
    const paths = resolveGatewayPaths({});
    expect(paths.packageRoot.endsWith(`${sep}gateway`)).toBe(true);
    expect(basename(paths.packageRoot)).toBe('gateway');
    expect(paths.repoRoot).toBe(dirname(paths.packageRoot));
    expect(paths.cutoverDir).toBe(join(paths.packageRoot, 'cutover'));
    for (const [field, value] of Object.entries(paths)) {
      expect(isAbsolute(value), field).toBe(true);
    }
  });

  it.each([
    ['inventoryFile', 'opt2/inventory/legacy-inventory.json'],
    ['tableOwnershipFile', 'opt2/table-ownership.json'],
    ['decisionListFile', 'opt2/decision-list.json'],
    ['exceptionsListFile', 'opt2/exceptions-list.json'],
    ['sourcePinFile', 'opt2/source-pin.json'],
    ['reconciliationDir', 'opt2/reports/reconciliation'],
  ] as const)('resolves %s to %s under the repository root', (field: keyof GatewayPaths, rel: string) => {
    const paths = resolveGatewayPaths({});
    expect(paths[field]).toBe(join(paths.repoRoot, ...rel.split('/')));
  });

  it.each(['inventoryFile', 'sourcePinFile', 'schemaFile', 'variantsFile'] as const)(
    'points %s at a file that exists in the checkout',
    (field) => {
      expect(existsSync(resolveGatewayPaths({})[field])).toBe(true);
    },
  );

  it.each([
    ['an absolute directory', '/tmp/x', '/tmp/x'],
    ['a relative directory against the working directory', 'rel/cutover', resolve('rel/cutover')],
    ['a trailing separator', '/tmp/x/', '/tmp/x'],
  ])('relocates only the cut-over files for OPT2_CUTOVER_DIR as %s', (_label, dir, expected) => {
    const defaults = resolveGatewayPaths({});
    const paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
    expect(paths.cutoverDir).toBe(expected);
    expect(paths.versionsDir).toBe(join(expected, 'versions'));
    expect(paths.schemaFile).toBe(join(expected, 'cutover-table.schema.json'));
    expect(paths.variantsFile).toBe(join(expected, 'variants.json'));
    expect(paths.groupsFile).toBe(join(expected, 'groups.json'));
    expect(outsideCutover(paths)).toEqual(outsideCutover(defaults));
  });

  it('treats an empty OPT2_CUTOVER_DIR as unset', () => {
    expect(resolveGatewayPaths({ OPT2_CUTOVER_DIR: '' })).toEqual(resolveGatewayPaths({}));
  });

  it('reads OPT2_CUTOVER_DIR from process.env by default', () => {
    vi.stubEnv('OPT2_CUTOVER_DIR', '/tmp/x');
    expect(resolveGatewayPaths().versionsDir).toBe('/tmp/x/versions');
  });
});
