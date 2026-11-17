/**
 * JSON API entity and method registries of strategies-content, as jsonApiUtility registers them
 * (core/mura/client/api/json/v1/jsonApiUtility.cfc:32-42, 69-106), plus the handler contract of this folder.
 */
import { contentEntities, type ContentEntityName } from '../../legacy/jsonapi-entities.js';
import { categoryHandler, contentCategoryAssignHandler } from './category.js';
import { changesetCategoryAssignmentHandler, changesetHandler } from './changeset.js';
import { commentHandler, commentRemoteFunctions } from './comment.js';
import { contentHandler } from './content.js';
import { feedHandler } from './feed.js';
import { fileHandler, fileMetaDataHandler } from './file.js';
import { CONTENT_METHODS } from './methods.js';
import { statsHandler } from './stats.js';
import type { EntityHandler, MethodHandler, RemoteFunctionFn } from './types.js';
import { variationTargetingHandler } from './variation-targeting.js';

export * from './types.js';

// Legacy registration order. `entity` (commented out at 102), `site`, `user`, `group` and `address` belong to no
// handler here: the gateway routes them to their owners.
const HANDLERS = Object.freeze({
  contentnav: contentHandler,
  content: contentHandler,
  comment: commentHandler,
  changeset: changesetHandler,
  feed: feedHandler,
  category: categoryHandler,
  contentCategoryAssign: contentCategoryAssignHandler,
  file: fileHandler,
  fileMetaData: fileMetaDataHandler,
  changesetCategoryAssignment: changesetCategoryAssignmentHandler,
  stats: statsHandler,
  variationTargeting: variationTargetingHandler,
} satisfies Record<ContentEntityName, EntityHandler>);

/** Every strategies-content entity handler by legacy entity name, `variationTargeting` included. */
export const CONTENT_ENTITY_HANDLERS: Readonly<Record<string, EntityHandler>> = HANDLERS;

/** Entity handlers legacy registers, in its order; `variationTargeting` only when the `variations` setting is on (104-106). */
export function contentEntityHandlers({ variations }: { variations: boolean }): Record<string, EntityHandler> {
  return Object.fromEntries(contentEntities({ variations }).map(({ name }) => [name, HANDLERS[name]]));
}

/** Lower-cased lookup over contentEntityHandlers for one `variations` setting. */
function lookupTable(variations: boolean): ReadonlyMap<string, EntityHandler> {
  return new Map(
    Object.entries(contentEntityHandlers({ variations })).map(([name, handler]) => [name.toLowerCase(), handler]),
  );
}

const LOOKUP_WITH_VARIATIONS = lookupTable(true);
const LOOKUP_WITHOUT_VARIATIONS = lookupTable(false);

/** The registered handler for `name` in any case, or undefined when strategies-content registers no such entity. */
export function lookupEntityHandler(name: string, opts: { variations: boolean }): EntityHandler | undefined {
  return (opts.variations ? LOOKUP_WITH_VARIATIONS : LOOKUP_WITHOUT_VARIATIONS).get(name.toLowerCase());
}

/** The public JSON API methods strategies-content serves, by legacy name. */
export const CONTENT_METHOD_HANDLERS: Readonly<Record<string, MethodHandler>> = CONTENT_METHODS;

/** The remote functions of each content entity bean, by legacy entity and function name; only contentCommentBean declares any. */
export const CONTENT_REMOTE_FUNCTIONS: Readonly<Record<string, Readonly<Record<string, RemoteFunctionFn>>>> = Object.freeze({
  comment: commentRemoteFunctions,
});
