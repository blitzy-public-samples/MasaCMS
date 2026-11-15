// Route-key options the step runner and the coverage gate share, so recorded and covered keys are the dispatcher's.
import { readFileSync } from 'node:fs';
import {
  entityRemoteFunctionsFromKeys,
  type RouteKeyOptions,
  type VariantCondition,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';
import { routeKeyCaseOptions } from '@opt2/platform/testing';
import { GoldenConfigError } from './errors.js';
import { repoPath } from '../lib/paths.js';

/** Committed variant declarations the gateway dispatches by. */
export const VARIANTS_PATH: string = repoPath('gateway/cutover/variants.json');

/** Committed legacy inventory: the admin controllers and the remote-function routes the gateway keys by. */
export const INVENTORY_PATH: string = repoPath('opt2/inventory/legacy-inventory.json');

const inventoryRoutesSchema = z.object({
  routes: z.array(z.object({ kind: z.string(), routeKey: z.string().nullable() })),
});

let committedRemoteFunctions: Readonly<Record<string, readonly string[]>> | undefined;

/** Remote functions by entity from the inventory's API entity-method routes, as the gateway's loader derives them. */
function readCommittedRemoteFunctions(): Readonly<Record<string, readonly string[]>> {
  if (committedRemoteFunctions === undefined) {
    const parsed = inventoryRoutesSchema.safeParse(JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')));
    if (!parsed.success) {
      throw new GoldenConfigError(`${INVENTORY_PATH}: ${z.prettifyError(parsed.error)}`, { path: INVENTORY_PATH });
    }
    committedRemoteFunctions = entityRemoteFunctionsFromKeys(
      parsed.data.routes.flatMap((route) =>
        route.kind === 'api-entity-method' && route.routeKey !== null ? [route.routeKey] : [],
      ),
    );
  }
  return committedRemoteFunctions;
}

const variantsFileSchema = z.object({
  variants: z.array(
    z.object({
      route: z.string().min(1),
      variant: z.string().min(1),
      when: z.array(
        z.custom<VariantCondition>(
          (c) => typeof c === 'object' && c !== null && !Array.isArray(c),
          'must be a condition',
        ),
      ),
    }),
  ),
});

let committedVariants: readonly VariantDeclaration[] | undefined;

function readCommittedVariants(): readonly VariantDeclaration[] {
  if (committedVariants === undefined) {
    const parsed = variantsFileSchema.safeParse(JSON.parse(readFileSync(VARIANTS_PATH, 'utf8')));
    if (!parsed.success) {
      throw new GoldenConfigError(`${VARIANTS_PATH}: ${z.prettifyError(parsed.error)}`, { path: VARIANTS_PATH });
    }
    committedVariants = parsed.data.variants;
  }
  return committedVariants;
}

/** The shared route-key case sites with the committed inventory's remote functions and the committed variants. */
export function defaultRouteKeyOptions(): RouteKeyOptions {
  return { ...routeKeyCaseOptions, entityRemoteFunctions: readCommittedRemoteFunctions(), variants: readCommittedVariants() };
}
