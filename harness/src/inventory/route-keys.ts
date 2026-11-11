import {
  normaliseRouteKey,
  routeKeyForEntryPoint,
  routeKeyForRequest,
  type RouteEntryPoint,
  type RouteKeyOptions,
  type RouteKeyRequest,
  type RouteKeyResult,
  type VariantCondition,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';
import { repoPath } from '../lib/paths.js';
import { pinnedSha } from '../lib/pin.js';
import { readJson } from '../lib/report.js';

/** Default location of the committed variant declarations. */
export const VARIANTS_PATH: string = repoPath('gateway/cutover/variants.json');

/** Site ids of the archive's default install, the only sites static extraction knows; live mode passes `siteExists`. */
export const STATIC_SITE_IDS: readonly string[] = Object.freeze(['default']);

/** An inventoried entry point, in the platform's entry-point input shape. */
export type InventoryEntryPoint = RouteEntryPoint;

/** A validated variants file. */
export interface InventoryVariants {
  sourceSha: string;
  variants: readonly VariantDeclaration[];
}

const paramName = z.string().min(1);

const variantCondition: z.ZodType<VariantCondition> = z.lazy(() =>
  z.union(
    [
      z.strictObject({ param: paramName, equals: z.string() }),
      z.strictObject({ param: paramName, in: z.array(z.string()) }),
      z.strictObject({ param: paramName, nonEmpty: z.literal(true) }),
      z.strictObject({ param: paramName, truthy: z.literal(true) }),
      z.strictObject({ multipartExtensionIn: z.array(z.string().min(1)) }),
      z.strictObject({ anyOf: z.array(variantCondition) }),
      z.strictObject({ not: variantCondition }),
    ],
    {
      error:
        'must be exactly one of {param, equals}, {param, in}, {param, nonEmpty: true}, {param, truthy: true}, ' +
        '{multipartExtensionIn}, {anyOf} or {not}',
    },
  ),
);

const variantsFileSchema = z.object({
  sourceSha: z.string(),
  variants: z.array(
    z.strictObject({ route: z.string().min(1), variant: z.string().min(1), when: z.array(variantCondition) }),
  ),
});

const loaded = new Map<string, Promise<InventoryVariants>>();

async function readVariants(file: string): Promise<InventoryVariants> {
  const parsed = await readJson(file, variantsFileSchema);
  const sha = pinnedSha();
  if (parsed.sourceSha !== sha) {
    throw new Error(`${file}: sourceSha ${JSON.stringify(parsed.sourceSha)} differs from the pinned SHA ${sha}`);
  }
  return parsed;
}

/** Reads and validates a variants file stamped with the pinned SHA; memoised per resolved path, failures re-read. */
export function loadInventoryVariants(path: string = VARIANTS_PATH): Promise<InventoryVariants> {
  const file = repoPath(path);
  let pending = loaded.get(file);
  if (pending === undefined) {
    pending = readVariants(file);
    loaded.set(file, pending);
    pending.catch(() => loaded.delete(file));
  }
  return pending;
}

/** Declarations of `baseKey`'s variants, in file order. */
export function variantsFor(baseKey: string, variants: readonly VariantDeclaration[]): VariantDeclaration[] {
  const key = normaliseRouteKey(baseKey);
  return variants.filter((v) => normaliseRouteKey(v.route) === key);
}

function isStaticSite(siteId: string): boolean {
  return STATIC_SITE_IDS.includes(siteId.toLowerCase());
}

// readJson is async, so keying awaits the memoised committed variants unless `opts` supplies its own.
async function keyOptions(opts: RouteKeyOptions): Promise<RouteKeyOptions> {
  const variants = opts.variants ?? (await loadInventoryVariants()).variants;
  return { ...opts, siteExists: opts.siteExists ?? isStaticSite, variants };
}

/** Platform route key of an inventoried entry point, defaulting to the committed variants and the static sites. */
export async function inventoryRouteKey(
  entry: InventoryEntryPoint,
  opts: RouteKeyOptions = {},
): Promise<RouteKeyResult> {
  return routeKeyForEntryPoint(entry, await keyOptions(opts));
}

/** Platform route key of a recorded request sample, defaulting to the committed variants and the static sites. */
export async function inventoryRouteKeyForRequest(
  req: RouteKeyRequest,
  opts: RouteKeyOptions = {},
): Promise<RouteKeyResult> {
  return routeKeyForRequest(req, await keyOptions(opts));
}

/** Canonical form of an authored route key, as the platform compares keys. */
export function normaliseInventoryKey(key: string): string {
  return normaliseRouteKey(key);
}
