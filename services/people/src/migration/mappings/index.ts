import type { Mapping } from '@opt2/platform/migration-kit';
import { personMapping } from './person.js';
import { addressMapping } from './address.js';
import { interestMapping } from './interest.js';
import { tagMapping } from './tag.js';
import { favoriteMapping } from './favorite.js';
import { extendSubtypeMapping } from './extend-subtype.js';
import { extendSetMapping } from './extend-set.js';
import { extendAttributeMapping } from './extend-attribute.js';
import { EXTEND_RCSET_MAPPINGS } from './extend-rcset.js';
import { classExtendDataMapping, extendDataMapping } from './extend-data.js';
import { personArchiveMapping } from './person-archive.js';
import { TRASH_MAPPINGS } from './trash.js';

export * from './person.js';
export * from './address.js';
export * from './interest.js';
export * from './tag.js';
export * from './favorite.js';
export * from './extend-subtype.js';
export * from './extend-set.js';
export * from './extend-attribute.js';
export * from './extend-rcset.js';
export * from './extend-data.js';
export * from './person-archive.js';
export * from './trash.js';

/** Every people legacy↔target mapping, parents before children. */
export const PEOPLE_MAPPINGS: readonly Mapping[] = Object.freeze([
  personMapping,
  addressMapping,
  interestMapping,
  tagMapping,
  favoriteMapping,
  extendSubtypeMapping,
  extendSetMapping,
  extendAttributeMapping,
  ...EXTEND_RCSET_MAPPINGS,
  extendDataMapping,
  classExtendDataMapping,
  personArchiveMapping,
  ...TRASH_MAPPINGS,
]);
