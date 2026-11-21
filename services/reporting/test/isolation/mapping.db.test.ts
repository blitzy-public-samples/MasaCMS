// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The migration apply of export job output against a throwaway PostgreSQL `reporting` schema. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { defineMappingApplyCases } from '../helpers/mapping-apply-cases.js';

const PG_READY = await pgAvailable();

describe.skipIf(!PG_READY)('reporting mapping apply over PostgreSQL', () => {
  defineMappingApplyCases('pg');
});
