// cform.getdialog: the form-builder dialog markup html.cfm prints as the whole body (server-only).
import { HTML_CONTENT_TYPE } from '@/lib/responses';
import type { RawBody, ScreenContext } from '../registry';
import { renderNamedTemplate } from './getfieldtemplate';

/** The dialog template `rc.dialog` names, as legacy's bare `text/html` body. */
export async function getDialog(ctx: ScreenContext): Promise<RawBody> {
  const dialog = ctx.req.rc.dialog;
  if (dialog === undefined) throw new TypeError('Element DIALOG is undefined in RC.');
  return { status: 200, contentType: HTML_CONTENT_TYPE, body: await renderNamedTemplate(ctx, dialog) };
}
