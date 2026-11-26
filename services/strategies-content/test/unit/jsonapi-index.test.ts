/** The JSON API entity and method registries against jsonApiUtility.cfc's registrations (32-42, 69-106). */
import { describe, expect, it } from 'vitest';
import { contentEntities } from '../../src/legacy/jsonapi-entities.js';
import { categoryHandler, contentCategoryAssignHandler } from '../../src/routes/jsonapi/category.js';
import { changesetCategoryAssignmentHandler, changesetHandler } from '../../src/routes/jsonapi/changeset.js';
import { commentHandler } from '../../src/routes/jsonapi/comment.js';
import { contentHandler } from '../../src/routes/jsonapi/content.js';
import { feedHandler } from '../../src/routes/jsonapi/feed.js';
import { fileHandler, fileMetaDataHandler } from '../../src/routes/jsonapi/file.js';
import {
  CONTENT_ENTITY_HANDLERS,
  CONTENT_METHOD_HANDLERS,
  contentEntityHandlers,
  createJsonApiParams,
  lookupEntityHandler,
  type EntityHandler,
} from '../../src/routes/jsonapi/index.js';
import { CONTENT_METHODS } from '../../src/routes/jsonapi/methods.js';
import { statsHandler } from '../../src/routes/jsonapi/stats.js';
import { createJsonApiParams as typesCreateJsonApiParams } from '../../src/routes/jsonapi/types.js';
import { variationTargetingHandler } from '../../src/routes/jsonapi/variation-targeting.js';

const EXPECTED: ReadonlyArray<readonly [string, EntityHandler]> = [
  ['contentnav', contentHandler],
  ['content', contentHandler],
  ['comment', commentHandler],
  ['changeset', changesetHandler],
  ['feed', feedHandler],
  ['category', categoryHandler],
  ['contentCategoryAssign', contentCategoryAssignHandler],
  ['file', fileHandler],
  ['fileMetaData', fileMetaDataHandler],
  ['changesetCategoryAssignment', changesetCategoryAssignmentHandler],
  ['stats', statsHandler],
  ['variationTargeting', variationTargetingHandler],
];

describe('CONTENT_ENTITY_HANDLERS', () => {
  it('maps every content entity to its handler in legacy registration order', () => {
    expect(Object.entries(CONTENT_ENTITY_HANDLERS)).toEqual(EXPECTED);
    expect(Object.isFrozen(CONTENT_ENTITY_HANDLERS)).toBe(true);
  });

  it.each(EXPECTED)('serves %s through a handler for that entity', (name, handler) => {
    expect(handler.entity).toBe(name === 'contentnav' ? 'content' : name);
  });
});

describe('contentEntityHandlers', () => {
  it.each([false, true])('registers what contentEntities registers with variations=%s', (variations) => {
    expect(Object.keys(contentEntityHandlers({ variations }))).toEqual(
      contentEntities({ variations }).map(({ name }) => name),
    );
  });

  it('registers variationTargeting only when the variations setting is on', () => {
    expect(contentEntityHandlers({ variations: false })).not.toHaveProperty('variationTargeting');
    expect(contentEntityHandlers({ variations: true })).toEqual(Object.fromEntries(EXPECTED));
  });
});

describe('lookupEntityHandler', () => {
  it.each([
    ['ContentNav', false, contentHandler],
    ['CONTENT', false, contentHandler],
    ['Comment', false, commentHandler],
    ['filemetadata', false, fileMetaDataHandler],
    ['CHANGESETCATEGORYASSIGNMENT', false, changesetCategoryAssignmentHandler],
    ['contentcategoryassign', false, contentCategoryAssignHandler],
    ['VariationTargeting', true, variationTargetingHandler],
    ['variationtargeting', false, undefined],
  ] as const)('resolves %s with variations=%s', (name, variations, handler) => {
    expect(lookupEntityHandler(name, { variations })).toBe(handler);
  });

  it.each(['entity', 'site', 'user', 'group', 'address', 'contentnavs', 'contents', ''])(
    'registers no handler for %j',
    (name) => {
      expect(lookupEntityHandler(name, { variations: true })).toBeUndefined();
      expect(lookupEntityHandler(name, { variations: false })).toBeUndefined();
    },
  );
});

describe('CONTENT_METHOD_HANDLERS', () => {
  it('serves exactly the six public methods strategies-content carries', () => {
    expect(CONTENT_METHOD_HANDLERS).toBe(CONTENT_METHODS);
    expect(Object.keys(CONTENT_METHOD_HANDLERS)).toEqual([
      'findCrumbArray',
      'findVersionHistory',
      'findRelatedContent',
      'findCalendarItems',
      'getURLForImage',
      'submitForm',
    ]);
  });
});

describe('re-exports', () => {
  it('exposes the handler contract of ./types.js', () => {
    expect(createJsonApiParams).toBe(typesCreateJsonApiParams);
  });
});
