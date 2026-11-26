// A recording RelatedEntityReader for handler-level JSON API tests: each related read is recorded and answers a marker.
import { iteratorPage } from '../../src/legacy/jsonapi-serializers.js';
import type { RelatedEntityReader } from '../../src/routes/jsonapi/index.js';

type Struct = Record<string, unknown>;

/** One read a handler asked of the reader. */
export interface RelatedRead {
  read: 'findOne' | 'findQuery' | 'crumbs' | 'relatedContent';
  entityName: string;
  id?: string;
  expand: string;
  expanded: number;
  params?: Struct;
}

/** A reader whose findOne answers `{ related, id }`, findQuery `{ related, params }`, and crumbs and related content nothing. */
export function recordingRelatedReader(): { reader: RelatedEntityReader; reads: RelatedRead[] } {
  const reads: RelatedRead[] = [];
  const reader: RelatedEntityReader = {
    findOne(_call, entityName, id, finder) {
      reads.push({ read: 'findOne', entityName, id, expand: finder.expand, expanded: finder.expanded });
      return Promise.resolve({ related: entityName, id });
    },
    findQuery(_call, entityName, finder) {
      reads.push({ read: 'findQuery', entityName, expand: finder.expand, expanded: finder.expanded, params: { ...finder.params } });
      return Promise.resolve({ related: entityName, params: { ...finder.params } });
    },
    crumbs(_call, view) {
      reads.push({ read: 'crumbs', entityName: view.entityName, expand: '', expanded: 0 });
      return Promise.resolve({ items: [], page: iteratorPage({ recordCount: 0, maxRecordsPerPage: 0, entityName: view.entityName }) });
    },
    relatedContent(_call, view, opts) {
      reads.push({ read: 'relatedContent', entityName: view.entityName, expand: opts.expand, expanded: opts.expanded });
      return Promise.resolve([]);
    },
  };
  return { reader, reads };
}
