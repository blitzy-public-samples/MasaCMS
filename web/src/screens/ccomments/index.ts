// The reproduced `ccomments` circuit for the screen registry (server-only).
import type { ScreenDefinition } from '../registry';
import {
  ccommentsApprove,
  ccommentsDelete,
  ccommentsMarkAsSpam,
  ccommentsPurgeDeletedComments,
  ccommentsUnapprove,
} from './actions';
import { ccommentsBulkEdit, ccommentsSingleEdit } from './ajax';
import { ccommentsDefault } from './default';
import { ccommentsLoadComments } from './loadcomments';
import { ccommentsLoadCommentsPage } from './loadcommentspage';

// `ajax` is only the view bulkEdit and singleEdit render; its own route key stays legacy in every cut-over version,
// so web registers no screen for it.
/** The carried ccomments actions: the Comments Manager, its list fragments, the edits and the moderation actions. */
export const ccommentsScreens: readonly ScreenDefinition[] = Object.freeze([
  ccommentsDefault,
  ccommentsLoadComments,
  ccommentsLoadCommentsPage,
  ccommentsBulkEdit,
  ccommentsSingleEdit,
  ccommentsApprove,
  ccommentsUnapprove,
  ccommentsDelete,
  ccommentsMarkAsSpam,
  ccommentsPurgeDeletedComments,
]);
