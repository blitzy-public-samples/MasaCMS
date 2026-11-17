// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** PostgreSQL gate of the timesheets suites that need a real server; importing it probes the `PG_*` server once. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';

const PG_AVAILABLE = await pgAvailable();

/** `describe` when the `PG_*` server accepts connections, skipped when PG_HOST is unset. */
export const describeWithPg = describe.skipIf(!PG_AVAILABLE);
