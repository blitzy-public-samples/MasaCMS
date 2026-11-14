// The carried Site Manager (cArch) actions for the screen registry, each behind the controller before() (server-only).
import type { ScreenDefinition } from '../registry';
import { auditScreen } from './audit';
import { datamanagerScreen } from './datamanager';
import { draftScreen } from './draft';
import { editScreen } from './edit';
import { editliveScreen } from './editlive';
import { edittextScreen } from './edittext';
import { histScreen } from './hist';
import { imagedetailsScreen } from './imagedetails';
import { inlineWriteScreens } from './inline-writes';
import { listScreen } from './list';
import { lockcheckScreen } from './lockcheck';
import { lockfileScreen } from './lockfile';
import { multifileuploadScreen } from './multifileupload';
import { rawActionScreens } from './raw-actions';
import { relatedcontentScreen } from './relatedcontent';
import { searchScreen } from './search';
import { selectfieldsScreen } from './selectfields';
import { selectmediaScreen } from './selectmedia';
import { updateScreen } from './update';
import { variationtargetingScreen } from './variationtargeting';

export { carchContentNav } from './content-nav';
export { carchSecondaryMenu } from './secondary-menu';

// Every screen applies the `before()` defaults in its own first step. Legacy keeps the bundle-engine actions (export,
// import, exportcontent and exportcomponent legacy-served; importcontent and importcomponent withheld), emailTest, the
// display-object CFML of displayobjectmodal and frontendconfigurator, loadrepomanager's FW/1 viewNotFound page, the
// image-engine edits cropimage, flipimage and rotateimage (halted) and the withheld copy; the withheld or halted
// variants of update, multifileupload, updateobjectparams and variationtargeting are the registry's not-built list.
// dsp_nest, dsp_nextN, dsp_rendertabevents and objectclass/legacy are rendered by strategies-content and relayed raw.
/** The carried cArch actions: the Site Manager pages, the editor and its save, their fragments, JSON and downloads. */
export const carchScreens: readonly ScreenDefinition[] = Object.freeze([
  listScreen,
  searchScreen,
  draftScreen,
  editScreen,
  editliveScreen,
  edittextScreen,
  updateScreen,
  histScreen,
  auditScreen,
  lockcheckScreen,
  relatedcontentScreen,
  multifileuploadScreen,
  datamanagerScreen,
  imagedetailsScreen,
  selectfieldsScreen,
  selectmediaScreen,
  variationtargetingScreen,
  lockfileScreen,
  ...inlineWriteScreens,
  ...rawActionScreens,
]);
