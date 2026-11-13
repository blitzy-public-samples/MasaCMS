// The cform controller `before()` and the carried form-builder actions for the screen registry (server-only).
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { servesRequestedSite } from '@/lib/request-context';
import type {
  DownloadScreen,
  FragmentScreen,
  JsonScreen,
  PageControllerRedirect,
  PageScreen,
  ScreenContext,
  ScreenDefinition,
  SubmitResult,
} from '../registry';
import { exportForm } from './export';
import { getDataset } from './getdataset';
import { getDialog } from './getdialog';
import { getField } from './getfield';
import { getFieldTemplate } from './getfieldtemplate';
import { getFieldType } from './getfieldtype';
import { getForm } from './getform';
import { renderImportForm, submitImportForm } from './importform';

type ImportView = Extract<SubmitResult, { kind: 'render' }>['view'];

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const FORMS_MODULE_ID = '00000000000000000000000000000000004';

/** cform `before()`: S2, or Site Manager and Forms module access on `rc.siteid`; otherwise `secure()`. */
export const cformGate: ScreenGate = (req, { secure }) =>
  req.isS2 ||
  (servesRequestedSite(req) && req.modulePerm(SITE_MANAGER_MODULE_ID) && req.modulePerm(FORMS_MODULE_ID))
    ? ALLOW
    : secure();

const CFORM = { circuit: 'cform', owner: 'strategies-content', gate: cformGate } as const;

// The inventory records the six get* actions as page mode, but each view only includes html.cfm or json.cfm, which
// print rc.return and cfabort before any layout runs, so they are registered in the bare modes legacy answers in.
const getDialogScreen: FragmentScreen<undefined> = Object.freeze({
  ...CFORM,
  action: 'getdialog',
  mode: 'fragment',
  render: getDialog,
});

const getFieldTemplateScreen: FragmentScreen<undefined> = Object.freeze({
  ...CFORM,
  action: 'getfieldtemplate',
  mode: 'fragment',
  render: getFieldTemplate,
});

const getFormScreen: JsonScreen<undefined> = Object.freeze({ ...CFORM, action: 'getform', mode: 'json', json: getForm });

const getFieldScreen: JsonScreen<undefined> = Object.freeze({ ...CFORM, action: 'getfield', mode: 'json', json: getField });

const getFieldTypeScreen: JsonScreen<undefined> = Object.freeze({
  ...CFORM,
  action: 'getfieldtype',
  mode: 'json',
  json: getFieldType,
});

const getDatasetScreen: JsonScreen<undefined> = Object.freeze({
  ...CFORM,
  action: 'getdataset',
  mode: 'json',
  json: getDataset,
});

const exportScreen: DownloadScreen<undefined> = Object.freeze({
  ...CFORM,
  action: 'export',
  mode: 'download',
  download: exportForm,
});

/** The view importform()'s controller step left to render, so the page does not render it a second time. */
const importViews = new WeakMap<ScreenContext, ImportView>();

// Page-mode requests reach web without their form body, so the step falls through to the view unless a body with a
// formzip is delivered; submitImportForm owns that decision, as the controller's own form-scope test does.
/** importform()'s controller step: a completed import answers with its `location()`, anything else shows the view. */
async function importStep(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const outcome = await submitImportForm(ctx);
  if (outcome.kind === 'location' || outcome.kind === 'redirect') return outcome;
  if (outcome.kind === 'render') importViews.set(ctx, outcome.view);
  return undefined;
}

const importFormScreen: PageScreen<undefined> = Object.freeze({
  ...CFORM,
  action: 'importform',
  mode: 'page',
  redirect: importStep,
  render: async (ctx: ScreenContext): Promise<ImportView> =>
    importViews.get(ctx) ?? { body: await renderImportForm(ctx) },
});

/** The carried cform actions: the form-builder dialogs, templates and beans, the zip export and Import Form. */
export const cformScreens: readonly ScreenDefinition[] = Object.freeze([
  getDialogScreen,
  getFieldTemplateScreen,
  getFormScreen,
  getFieldScreen,
  getFieldTypeScreen,
  getDatasetScreen,
  exportScreen,
  importFormScreen,
]);
