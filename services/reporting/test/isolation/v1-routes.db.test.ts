// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/reporting/exports`, the local export file route and the export source scope read through the full reporting app over a throwaway PostgreSQL `reporting` schema. */
import { describe } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { defineV1RouteCases } from '../helpers/v1-routes-cases.js';

const PG_READY = Boolean(process.env.PG_HOST) && (await pgAvailable());

defineV1RouteCases('pg', describe.skipIf(!PG_READY));
