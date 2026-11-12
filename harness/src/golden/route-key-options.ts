// Route-key options the step runner and the coverage gate share, so recorded and covered keys are the dispatcher's.
import { readFileSync } from 'node:fs';
import type { RouteKeyOptions, VariantCondition, VariantDeclaration } from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';
import { routeKeyCaseOptions } from '@opt2/platform/testing';
import { GoldenConfigError } from './errors.js';
import { repoPath } from '../lib/paths.js';

/** Committed variant declarations the gateway dispatches by. */
export const VARIANTS_PATH: string = repoPath('gateway/cutover/variants.json');

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

/** The shared route-key case registries (sites, remote functions) with the committed variants. */
export function defaultRouteKeyOptions(): RouteKeyOptions {
  return { ...routeKeyCaseOptions, variants: readCommittedVariants() };
}
