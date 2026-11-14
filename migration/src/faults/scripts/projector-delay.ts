// Scripted fault projector-delay: arms or disarms the running migration service's sleep before each reverse-projector batch.
import { z } from '@opt2/platform/service-kit';

import { fail, pass, type FaultScript } from './types.js';

const FAULT = 'projector-delay';
const TOGGLED = 'toggled';

// An omitted delayMs stays absent on the wire, so the service applies its configured default.
const paramsSchema = z
  .object({
    action: z.enum(['set', 'clear']).default('set'),
    delayMs: z.number().int().min(0).optional(),
  })
  .strict();

/** Parameters of {@link projectorDelay}. */
export type ProjectorDelayParams = z.output<typeof paramsSchema>;

/** HTTP status of a refused fault call, when the error carries one. */
function statusOf(err: unknown): number | undefined {
  const { status } = (err ?? {}) as { status?: unknown };
  return typeof status === 'number' ? status : undefined;
}

/** Toggles the service's projector delay; asserts only that the service accepted the toggle. */
export const projectorDelay: FaultScript<ProjectorDelayParams> = {
  name: FAULT,
  reconciles: false,
  paramsSchema,
  async run(env, { action, delayMs }) {
    const details = { action, delayMs };
    try {
      if (action === 'set') await env.remote.set(FAULT, delayMs === undefined ? {} : { delayMs });
      else await env.remote.clear(FAULT);
      return { assertions: [pass(TOGGLED, details)], details };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { assertions: [fail(TOGGLED, { ...details, error, status: statusOf(err) })], details };
    }
  },
  // The delay stays armed until the caller runs this fault again with action 'clear'.
  resume: () => Promise.resolve({ steps: [], assertions: [] }),
};
