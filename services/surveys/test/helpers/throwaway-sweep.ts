// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Drops throwaway schemas a timed-out hook never received; carries its own timeout because the hook timeout may be what expired. */
import { afterAll } from 'vitest';

// Imported after the tests: a setup-time import would load platform modules before the tests' vi.mock calls replace their dependencies.
afterAll(async () => (await import('@opt2/platform/testing')).dropThrowawaySchemas(), 120_000);
