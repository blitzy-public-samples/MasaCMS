// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job moves against stored rows and failed jobs through the runner, over a throwaway PostgreSQL `reporting` schema. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { defineJobStateCases } from '../helpers/job-state-cases.js';

// An unset PG_HOST skips the suite without probing the server.
const PG_READY = Boolean(process.env.PG_HOST) && (await pgAvailable());

defineJobStateCases('pg', describe.skipIf(!PG_READY));
