/** Route-boundary validation of the url and form params a legacy action merges into `rc`. */
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyRequest, type z } from '@opt2/platform/service-kit';

/** A route preHandler answering `invalidParameters` unless the merged params, names lower-cased, match `schema`. */
export function legacyParamsGuard(schema: z.ZodType): (request: FastifyRequest) => Promise<void> {
  return async function validateLegacyParams(request) {
    const params = Object.entries(legacyParamsOf(request)).map(([name, value]) => [name.toLowerCase(), value]);
    if (!schema.safeParse(Object.fromEntries(params)).success) throw new LegacyApiError('invalidParameters');
  };
}
