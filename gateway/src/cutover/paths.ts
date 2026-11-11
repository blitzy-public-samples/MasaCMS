// Absolute locations of the cut-over files and the opt2 deliverables the gateway reads.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute paths of the gateway package, its cut-over files and the opt2 inputs they are built from. */
export interface GatewayPaths {
  packageRoot: string;
  repoRoot: string;
  cutoverDir: string;
  versionsDir: string;
  schemaFile: string;
  variantsFile: string;
  groupsFile: string;
  inventoryFile: string;
  tableOwnershipFile: string;
  decisionListFile: string;
  exceptionsListFile: string;
  sourcePinFile: string;
  reconciliationDir: string;
}

/** Resolves every gateway path; `OPT2_CUTOVER_DIR` relocates only the cut-over directory. */
export function resolveGatewayPaths(env: { OPT2_CUTOVER_DIR?: string } = process.env): GatewayPaths {
  // src/cutover/ and dist/cutover/ sit at the same depth, so this resolves to gateway/ from source and build alike.
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const repoRoot = resolve(packageRoot, '..');
  const cutoverDir = env.OPT2_CUTOVER_DIR ? resolve(env.OPT2_CUTOVER_DIR) : join(packageRoot, 'cutover');
  const opt2Dir = join(repoRoot, 'opt2');
  return {
    packageRoot,
    repoRoot,
    cutoverDir,
    versionsDir: join(cutoverDir, 'versions'),
    schemaFile: join(cutoverDir, 'cutover-table.schema.json'),
    variantsFile: join(cutoverDir, 'variants.json'),
    groupsFile: join(cutoverDir, 'groups.json'),
    inventoryFile: join(opt2Dir, 'inventory', 'legacy-inventory.json'),
    tableOwnershipFile: join(opt2Dir, 'table-ownership.json'),
    decisionListFile: join(opt2Dir, 'decision-list.json'),
    exceptionsListFile: join(opt2Dir, 'exceptions-list.json'),
    sourcePinFile: join(opt2Dir, 'source-pin.json'),
    reconciliationDir: join(opt2Dir, 'reports', 'reconciliation'),
  };
}
