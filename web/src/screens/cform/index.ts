// The cform controller `before()` and the carried form-builder actions for the screen registry (server-only).
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { servesRequestedSite } from '@/lib/request-context';
import type { DownloadScreen, FragmentScreen, JsonScreen, RedirectScreen, ScreenDefinition } from '../registry';
import { exportForm } from './export';
import { getDataset } from './getdataset';
import { getDialog } from './getdialog';
import { getField } from './getfield';
import { getFieldTemplate } from './getfieldtemplate';
import { getFieldType } from './getfieldtype';
import { getForm } from './getform';
import { submitImportForm } from './importform';

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

// The get* views print rc.return through html.cfm (fragment) or json.cfm (json) and abort before any layout.
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

const importFormScreen: RedirectScreen = Object.freeze({
  ...CFORM,
  action: 'importform',
  mode: 'redirect',
  submit: submitImportForm,
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
