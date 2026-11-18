// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/reporting/exports`, `/v1/reporting/definitions`, the local export file route and the export source scope read through the full reporting app over a throwaway PostgreSQL `reporting` schema. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { defineV1RouteCases } from '../helpers/v1-routes-cases.js';

const PG_READY = await pgAvailable();

defineV1RouteCases('pg', describe.skipIf(!PG_READY));
