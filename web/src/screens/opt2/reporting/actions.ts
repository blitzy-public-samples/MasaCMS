// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/reporting';
import type { Opt2ActionDefinition, ScreenContext, SubmitResult } from '../../registry';
import { opt2Gate, submitToService } from '../shared';
import { EXPORTER_ROLES, exportsBack, exportsBody, loadExports, type QueuePosted } from './exports';

type ExportFormat = components['schemas']['ExportFormat'];

/**
 * Queues an export of the posted definition, format and optional `asOf`, then returns to the list; reporting's 400 or
 * 404 re-renders the list with its alert and the posted values.
 */
export async function submitQueue(ctx: ScreenContext): Promise<SubmitResult> {
  const { definitionId = '', format = '', asOf = '' } = ctx.req.rc;
  const posted: QueuePosted = { definitionId, format, asOf };
  return submitToService(
    ctx,
    {
      service: 'reporting',
      call: (gateway, csrfHeaders) =>
        gateway.reporting.call('post', '/v1/reporting/exports', {
          // reporting answers a format outside the enum with invalidParameters, which re-renders the form.
          json: { definitionId, format: format as ExportFormat, ...(asOf === '' ? {} : { asOf }) },
          headers: csrfHeaders,
        }),
    },
    exportsBack(ctx),
    async (alert) => exportsBody(ctx, await loadExports(ctx), { alert, posted }),
  );
}

/**
 * Sends the browser to a fresh signed URL of the posted job's output, never reading the bytes itself; reporting's 404,
 * or its 409 for a job not done, re-renders the list with its alert.
 */
export async function submitDownload(ctx: ScreenContext): Promise<SubmitResult> {
  const id = ctx.req.rc.jobId ?? '';
  let signedUrl: string | undefined;
  const result = await submitToService(
    ctx,
    {
      service: 'reporting',
      // Issuing the URL is a read, so the posted CSRF pair is not sent.
      call: async (gateway) => {
        const response = await gateway.reporting.call('get', '/v1/reporting/exports/{id}/download-url', {
          params: { id },
        });
        if (response.ok) signedUrl = response.body.data.url;
        return response;
      },
    },
    exportsBack(ctx),
    async (alert) => exportsBody(ctx, await loadExports(ctx), { alert }),
  );
  // submitToService answers every refusal itself; a success returns to the list, which the signed URL replaces.
  return signedUrl === undefined ? result : { kind: 'location', location: signedUrl };
}

const REPORTING_ACTION = { module: 'reporting', roles: EXPORTER_ROLES, service: 'reporting' } as const;

/** `/opt2/admin-actions/reporting/queue`: queues an export job. */
export const queueAction: Opt2ActionDefinition = Object.freeze({
  ...REPORTING_ACTION,
  action: 'queue',
  gate: opt2Gate(EXPORTER_ROLES),
  submit: submitQueue,
});

/** `/opt2/admin-actions/reporting/download`: hands a done job's signed download URL to the browser. */
export const downloadAction: Opt2ActionDefinition = Object.freeze({
  ...REPORTING_ACTION,
  action: 'download',
  gate: opt2Gate(EXPORTER_ROLES),
  submit: submitDownload,
});
