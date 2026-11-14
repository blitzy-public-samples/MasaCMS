// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** PostgreSQL gate of the timesheets suites that need a real server; importing it probes the `PG_*` server once. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';

// pgAvailable rejects on partial settings, so a host missing any of them skips instead of probing.
const PG_CONFIGURED = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'].every((name) => Boolean(process.env[name]));
const PG_AVAILABLE = PG_CONFIGURED && (await pgAvailable());

/** `describe` when the `PG_*` server accepts connections, else skipped, so PostgreSQL suites report skipped without one. */
export const describeWithPg = describe.skipIf(!PG_AVAILABLE);
