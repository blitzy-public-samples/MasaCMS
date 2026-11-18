// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Opt2Module } from '../../registry';

/** Module title of each OPT-2 screen by module and screen slug: the text after `configTitle - ` in `<title>`. */
export const OPT2_SCREEN_TITLES: Readonly<Record<Opt2Module, Readonly<Record<string, string>>>> = Object.freeze({
  timesheets: Object.freeze({ sheets: 'Timesheets', sheet: 'Timesheet' }),
  finance: Object.freeze({ records: 'Finance Records', record: 'Finance Record' }),
  'e-signature': Object.freeze({
    requests: 'Signature Requests',
    request: 'Signature Request',
    audit: 'Audit Chain',
    verify: 'Verify Audit Chain',
  }),
  reporting: Object.freeze({ exports: 'Export Jobs' }),
  surveys: Object.freeze({ surveys: 'Surveys', schedule: 'Schedule', targets: 'Targets', responses: 'Responses' }),
  communications: Object.freeze({ templates: 'Templates', sends: 'Sends', 'delivery-status': 'Delivery Status' }),
});

/** Shell view of OPT-2 screen `module`/`screen`: `body`, the module marked in the nav and the screen's module title. */
export function opt2View(module: Opt2Module, body: SafeHtml, screen: string): ShellView {
  const moduleTitle = OPT2_SCREEN_TITLES[module][screen];
  return moduleTitle === undefined ? { body, opt2Module: module } : { body, opt2Module: module, moduleTitle };
}
