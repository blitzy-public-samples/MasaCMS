// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The migration apply of export job output against a throwaway PostgreSQL `reporting` schema. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { defineMappingApplyCases } from '../helpers/mapping-apply-cases.js';

// An unset PG_HOST skips the suite without probing the server.
const PG_READY = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!PG_READY)('reporting mapping apply over PostgreSQL', () => {
  defineMappingApplyCases('pg');
});
