// The carried Site Manager (cArch) actions for the screen registry, each behind the controller before() (server-only).
import type { ScreenDefinition } from '../registry';
import { auditScreen } from './audit';
import { datamanagerScreen } from './datamanager';
import { draftScreen } from './draft';
import { editliveScreen } from './editlive';
import { edittextScreen } from './edittext';
import { histScreen } from './hist';
import { inlineWriteScreens } from './inline-writes';
import { listScreen } from './list';
import { lockcheckScreen } from './lockcheck';
import { lockfileScreen } from './lockfile';
import { rawActionScreens } from './raw-actions';
import { relatedcontentScreen } from './relatedcontent';
import { scaffoldScreen } from './scaffold';
import { selectfieldsScreen } from './selectfields';
import { selectmediaScreen } from './selectmedia';

export { carchContentNav } from './content-nav';
export { carchSecondaryMenu } from './secondary-menu';

/** Inline writes kept withheld on legacy: their content saves write the decision-list table tcontenteventreminders. */
const WITHHELD_INLINE_WRITES: ReadonlySet<string> = new Set(['savequickedit', 'updateobjectparams']);

// Every screen applies the `before()` defaults in its own first step. Legacy keeps the bundle-engine actions (export,
// import, exportcontent, exportcomponent and importcomponent legacy-served; importcontent withheld), emailTest, the
// display-object CFML of displayobjectmodal and frontendconfigurator, loadrepomanager's FW/1 viewNotFound page, the
// halted edit, cropimage, flipimage, rotateimage, search, multifileupload, imagedetails and loadsiteflat, and the
// withheld copy, update, updateobjectparams, savequickedit and variationtargeting; the withheld approve branch of
// approvalaction is the registry's not-built list. dsp_nest, dsp_nextN, dsp_rendertabevents and objectclass/legacy are
// rendered by strategies-content and relayed raw.
/** The carried cArch actions: the Site Manager pages, fragments, JSON, inline writes and downloads. */
export const carchScreens: readonly ScreenDefinition[] = Object.freeze([
  listScreen,
  draftScreen,
  editliveScreen,
  edittextScreen,
  histScreen,
  auditScreen,
  lockcheckScreen,
  relatedcontentScreen,
  datamanagerScreen,
  scaffoldScreen,
  selectfieldsScreen,
  selectmediaScreen,
  lockfileScreen,
  ...inlineWriteScreens.filter((def) => !WITHHELD_INLINE_WRITES.has(def.action)),
  ...rawActionScreens,
]);
