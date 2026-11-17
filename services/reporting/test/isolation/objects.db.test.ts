// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job object manifest against a throwaway PostgreSQL `reporting` schema and local storage, alone and through the migration export endpoint. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { defineObjectManifestCases } from '../helpers/objects-cases.js';

const PG_READY = await pgAvailable();

describe.skipIf(!PG_READY)('reporting object manifest over PostgreSQL', () => {
  defineObjectManifestCases('pg');
});
