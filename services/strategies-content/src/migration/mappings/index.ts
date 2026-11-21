/** The strategies-content legacy↔target mappings and units handed to the migration handlers. */
import type { Mapping } from '@opt2/platform/migration-kit';
import { CONTENT_UNITS } from '../../repo/tables.js';
import { tcontentcategoriesMapping, tcontentcategoryassignMapping } from './categories.js';
import {
  tcontentMapping,
  tcontentrelatedMapping,
  tcontenttagsMapping,
  tcontentassignmentsMapping,
  tcontentfilenamearchiveMapping,
  tcontentsourcemapsMapping,
  tcontentremotepointerMapping,
  tcontentvariationtargetingMapping,
  tcontentdisplaytitleapprovalsMapping,
  tcontentpublicsubmissionapprovalsMapping,
} from './content.js';
import { tcontentobjectsMapping } from './objects.js';
import { tfilesMapping, tcontentfilemetadataMapping } from './files.js';
import { tcontentstatsMapping, tcontentratingsMapping } from './stats.js';
import { tcontentcommentsMapping, tcontentcommentcommentersMapping } from './comments.js';
import { tcontentfeedsMapping, tcontentfeeditemsMapping, tcontentfeedadvancedparamsMapping } from './feeds.js';
import {
  tapprovalchainsMapping,
  tapprovalmembershipsMapping,
  tapprovalassignmentsMapping,
  tapprovalrequestsMapping,
  tapprovalactionsMapping,
} from './approvals.js';
import {
  tchangesetsMapping,
  tchangesetrollbackMapping,
  tchangesetcategoryassignMapping,
  tchangesettagassignMapping,
} from './changesets.js';
import { tformresponsepacketsMapping, tformresponsequestionsMapping } from './forms.js';
import {
  tclassextendMapping,
  tclassextendsetsMapping,
  tclassextendattributesMapping,
  tclassextendrcsetsMapping,
  tclassextenddataMapping,
} from './extend.js';
import { ttrashMapping } from './trash.js';

export * from './categories.js';
export * from './content.js';
export * from './objects.js';
export * from './files.js';
export * from './stats.js';
export * from './comments.js';
export * from './feeds.js';
export * from './approvals.js';
export * from './changesets.js';
export * from './forms.js';
export * from './extend.js';
export * from './trash.js';

// content.file_object and the group, permission and membership projections have no legacy table, so none is mapped;
// decision-list tables (tremotepointer, trazunasettings, tcontenteventreminders, fb_*, tentity, plugins) are never built.
/** Every strategies-content mapping, parents before children so parent-derived tenants resolve. */
export const mappings: readonly Mapping[] = Object.freeze([
  tcontentcategoriesMapping,
  tcontentcategoryassignMapping,
  tcontentMapping,
  tcontentrelatedMapping,
  tcontenttagsMapping,
  tcontentassignmentsMapping,
  tcontentfilenamearchiveMapping,
  tcontentsourcemapsMapping,
  tcontentremotepointerMapping,
  tcontentvariationtargetingMapping,
  tcontentdisplaytitleapprovalsMapping,
  tcontentpublicsubmissionapprovalsMapping,
  tcontentobjectsMapping,
  tfilesMapping,
  tcontentfilemetadataMapping,
  tcontentstatsMapping,
  tcontentratingsMapping,
  tcontentcommentsMapping,
  tcontentcommentcommentersMapping,
  tcontentfeedsMapping,
  tcontentfeeditemsMapping,
  tcontentfeedadvancedparamsMapping,
  tapprovalchainsMapping,
  tapprovalmembershipsMapping,
  tapprovalassignmentsMapping,
  tapprovalrequestsMapping,
  tapprovalactionsMapping,
  tchangesetsMapping,
  tchangesetrollbackMapping,
  tchangesetcategoryassignMapping,
  tchangesettagassignMapping,
  tformresponsepacketsMapping,
  tformresponsequestionsMapping,
  tclassextendMapping,
  tclassextendsetsMapping,
  tclassextendattributesMapping,
  tclassextendrcsetsMapping,
  tclassextenddataMapping,
  ttrashMapping,
]);

/** Units of write authority the migration handlers gate, exactly `CONTENT_UNITS` in its order. */
export const units: readonly string[] = CONTENT_UNITS;
