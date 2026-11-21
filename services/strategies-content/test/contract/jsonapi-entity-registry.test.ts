/** The JSON API entity registry against the `x-opt2-entity-access` table of contracts/openapi.yaml. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONTENT_ENTITY_HANDLERS, contentEntityHandlers } from '../../src/routes/jsonapi/index.js';

type EntityAccess = Record<string, { requiresConfig?: string }>;

const CONTRACT = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  'x-opt2-entity-access': EntityAccess;
};
const ACCESS = CONTRACT['x-opt2-entity-access'];

describe('x-opt2-entity-access', () => {
  it('declares exactly the registered entities', () => {
    expect(Object.keys(ACCESS).sort()).toEqual(Object.keys(CONTENT_ENTITY_HANDLERS).sort());
  });

  it('marks requiresConfig: variations on exactly the entities the variations setting gates', () => {
    const gated = Object.keys(CONTENT_ENTITY_HANDLERS).filter(
      (name) => !(name in contentEntityHandlers({ variations: false })),
    );
    const declared = Object.entries(ACCESS)
      .filter(([, access]) => access.requiresConfig === 'variations')
      .map(([name]) => name);
    expect(declared.sort()).toEqual(gated.sort());
  });
});
