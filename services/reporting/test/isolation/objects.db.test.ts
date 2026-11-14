// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job object manifest against a throwaway PostgreSQL `reporting` schema and local storage, alone and through the migration export endpoint. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { defineObjectManifestCases } from '../helpers/objects-cases.js';

// An unset PG_HOST skips the suite without probing the server.
const PG_READY = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!PG_READY)('reporting object manifest over PostgreSQL', () => {
  defineObjectManifestCases('pg');
});
