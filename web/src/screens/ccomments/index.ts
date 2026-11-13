// The reproduced `ccomments` circuit for the screen registry (server-only).
import type { ScreenDefinition } from '../registry';
import {
  ccommentsApprove,
  ccommentsDelete,
  ccommentsMarkAsSpam,
  ccommentsPurgeDeletedComments,
  ccommentsUnapprove,
} from './actions';
import { ccommentsAjax, ccommentsBulkEdit, ccommentsSingleEdit } from './ajax';
import { ccommentsDefault } from './default';
import { ccommentsLoadComments } from './loadcomments';
import { ccommentsLoadCommentsPage } from './loadcommentspage';

/** The carried ccomments actions: the Comments Manager, its fragments, the edits and the moderation actions. */
export const ccommentsScreens: readonly ScreenDefinition[] = Object.freeze([
  ccommentsDefault,
  ccommentsLoadComments,
  ccommentsLoadCommentsPage,
  ccommentsAjax,
  ccommentsBulkEdit,
  ccommentsSingleEdit,
  ccommentsApprove,
  ccommentsUnapprove,
  ccommentsDelete,
  ccommentsMarkAsSpam,
  ccommentsPurgeDeletedComments,
]);
