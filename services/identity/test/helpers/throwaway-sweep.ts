/** Drops throwaway schemas a timed-out hook never received; carries its own timeout because the hook timeout may be what expired. */
import { dropThrowawaySchemas } from '@opt2/platform/testing';
import { afterAll } from 'vitest';

afterAll(() => dropThrowawaySchemas(), 120_000);
