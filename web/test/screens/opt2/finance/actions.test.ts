// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// finance post actions: lifecycle transitions, edit, attachment upload and signed download, over finance's /v1 API.
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGate } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { ScreenRequestBody } from '@/screens/registry';
import {
  FINANCE_IDS,
  financeAttachmentSignedUrl,
  financeAttachmentUploaded,
  financeRecordDetail,
  financeTransitionIllegal,
  financeTransitionLegal,
} from '../../../fixtures/opt2/finance';
import { routeKey, type RecordedRequest } from '../../../helpers/fake-gateway';
import { makeScreenContext } from '../../../helpers/screen-context';
import {
  APPROVER,
  CSRF_HEADERS,
  NOACCESS,
  POSTED_CSRF,
  PREPARER,
  RECORD_ID,
  SITE,
  financeAction,
  financeCalls,
  financeError,
  financeGateway,
  financeRequest,
  rerendered,
  useFinanceEnv,
} from './support';

// The registry module loads every circuit; screen suites stand in for it with the shell hooks this page renders with.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const RECORD_PATH: `/${string}` = `/v1/finance/records/${RECORD_ID}`;
const ATTACHMENTS_PATH: `/${string}` = `${RECORD_PATH}/attachments`;
const DETAIL_LOCATION = `/opt2/admin/finance/record?siteid=${SITE}&id=${RECORD_ID}`;
const transitionPath = (action: string): `/${string}` => `${RECORD_PATH}/transitions/${action}`;
const transitionRoute = (action: string): string => routeKey('POST', 'finance', transitionPath(action));
const UPLOAD_ROUTE = routeKey('POST', 'finance', ATTACHMENTS_PATH);

/** The posted form of a finance action on the fixture record, CSRF pair included. */
const posted = (fields: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  id: RECORD_ID,
  ...POSTED_CSRF,
  ...fields,
});

/** Runs finance action `action` for a user holding `role`, over the fixture gateway with `overrides`. */
async function submit(
  action: string,
  role = PREPARER,
  fields: Readonly<Record<string, string>> = {},
  overrides = {},
  body?: ScreenRequestBody,
) {
  const gateway = financeGateway(overrides);
  const ctx = makeScreenContext({ req: financeRequest(role, posted(fields)), gateway, body });
  const result = await financeAction(action).submit(ctx);
  return { result, gateway };
}

/** A multipart upload body of `file` with the posted CSRF pair, as the handlers receive it. */
async function uploadBody(file: File): Promise<ScreenRequestBody> {
  const form = new FormData();
  for (const [name, value] of Object.entries(POSTED_CSRF)) form.append(name, value);
  form.append('file', file);
  const encoded = new Response(form);
  const contentType = encoded.headers.get('content-type');
  if (contentType === null) throw new TypeError('FormData encoded without a content type');
  return { contentType, body: await encoded.blob(), form };
}

describe('finance actions', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = useFinanceEnv();
  });
  afterEach(() => {
    restore();
  });

  describe('lifecycle transitions', () => {
    it.each([
      ['submit', PREPARER],
      ['resubmit', PREPARER],
      ['approve', APPROVER],
      ['reject', APPROVER],
    ])('posts %s with the posted CSRF pair as headers, then returns to the detail', async (action, role) => {
      const { result, gateway } = await submit(action, role, {}, {
        [transitionRoute(action)]: { status: 200, body: financeTransitionLegal },
      });

      expect(result).toEqual({ kind: 'location', location: DETAIL_LOCATION });
      expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([
        { service: 'finance', method: 'POST', path: transitionPath(action), headers: CSRF_HEADERS },
      ]);
    });

    it.each([
      ['an illegal transition (409)', 'submit', PREPARER, financeTransitionIllegal, 'illegalTransition'],
      [
        'a role the transition table refuses (403)',
        'approve',
        PREPARER,
        financeError(403, 'finance.records.approve', 'Insufficient Account Permissions'),
        'Insufficient Account Permissions',
      ],
      ['an unknown record (404)', 'reject', APPROVER, financeError(404, 'finance.records.reject', 'Not Found'), 'Not Found'],
    ])('re-renders the detail with finance alert for %s', async (_, action, role, reply, text) => {
      const { result, gateway } = await submit(action, role, {}, { [transitionRoute(action)]: reply });
      const { module, model } = rerendered(result);

      expect(module).toBe('finance');
      expect(model.alerts).toEqual([{ text, className: 'alert alert-error' }]);
      expect(model.headings[0]).toBe(financeRecordDetail.title);
      expect(financeCalls(gateway)).toEqual([`POST ${transitionPath(action)}`, `GET ${RECORD_PATH}`]);
    });

    it('answers finance 401 with the login redirect', async () => {
      const reply = financeError(401, 'finance.records.submit', 'Insufficient Account Permissions');

      await expect(submit('submit', PREPARER, {}, { [transitionRoute('submit')]: reply })).rejects.toBeInstanceOf(
        GatewayDenialError,
      );
    });

    it('propagates finance unavailability', async () => {
      const gateway = financeGateway();
      gateway.failWith();
      const ctx = makeScreenContext({ req: financeRequest(APPROVER, posted()), gateway });

      await expect(financeAction('approve').submit(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
    });
  });

  describe('edit', () => {
    const EDITED = { title: 'Consulting services Q2 & Q3', amount: '4200.5', period: '2026-07' };

    it('posts the edited fields as typed, the amount kept as decimal text', async () => {
      const legal = { status: 200, body: { data: { ...financeRecordDetail, amount: '4200.5000', version: 7 } } };
      const { result, gateway } = await submit('edit', PREPARER, EDITED, { [transitionRoute('edit')]: legal });

      expect(result).toEqual({ kind: 'location', location: DETAIL_LOCATION });
      expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([
        {
          service: 'finance',
          method: 'POST',
          path: transitionPath('edit'),
          json: EDITED,
          headers: CSRF_HEADERS,
        },
      ]);
    });

    it('re-renders the edit form with the posted values and finance alert when it refuses them', async () => {
      const invalid = { ...EDITED, amount: '12.34567' };
      const reply = financeError(400, 'finance.records.edit', 'Invalid parameters');
      const { result } = await submit('edit', PREPARER, invalid, { [transitionRoute('edit')]: reply });
      const { model } = rerendered(result);

      expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
      expect(
        model.controls.filter(({ name }) => ['title', 'amount', 'period'].includes(name)).map(({ value }) => value),
      ).toEqual([invalid.title, invalid.amount, invalid.period]);
    });

    it('sends empty fields for a post without them, for finance to refuse', async () => {
      const reply = financeError(400, 'finance.records.edit', 'Invalid parameters');
      const { gateway } = await submit('edit', PREPARER, {}, { [transitionRoute('edit')]: reply });

      expect(gateway.calls.find(({ path }) => path === transitionPath('edit'))?.json).toEqual({
        title: '',
        amount: '',
        period: '',
      });
    });
  });

  describe('upload', () => {
    it('relays the multipart body unchanged with the CSRF headers, then returns to the detail', async () => {
      let received: RecordedRequest | undefined;
      const body = await uploadBody(new File(['%PDF-1.7 receipt'], 'receipt-2026-06-30.pdf', { type: 'application/pdf' }));
      const route = (request: RecordedRequest) => {
        received = request;
        return { status: 200, body: { data: financeAttachmentUploaded } };
      };
      const { result } = await submit('upload', PREPARER, {}, { [UPLOAD_ROUTE]: route }, body);

      const sent = Buffer.from(await new Response(body.body.stream()).arrayBuffer());

      expect(result).toEqual({ kind: 'location', location: DETAIL_LOCATION });
      expect(received?.path).toBe(`/opt2/svc/finance${ATTACHMENTS_PATH}`);
      expect(received?.headers['content-type']).toBe(body.contentType);
      expect(received?.headers['content-length']).toBe(String(sent.length));
      expect(received?.headers['x-csrf_token']).toBe(CSRF_HEADERS['x-csrf_token']);
      expect(received?.headers['x-csrf_token_expires']).toBe(CSRF_HEADERS['x-csrf_token_expires']);
      expect(received?.bytes).toEqual(sent);
    });

    it('re-renders the detail with finance alert for a post without a body', async () => {
      const reply = financeError(400, 'finance.records.attachments', 'Invalid parameters');
      const { result, gateway } = await submit('upload', PREPARER, {}, { [UPLOAD_ROUTE]: reply });

      expect(rerendered(result).model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
      expect(gateway.calls.find(({ path }) => path === ATTACHMENTS_PATH)?.headers).toEqual(CSRF_HEADERS);
    });
  });

  describe('download', () => {
    it('sends the browser to a fresh signed URL without relaying the CSRF pair', async () => {
      const { result, gateway } = await submit('download', APPROVER, { aid: FINANCE_IDS.attachmentPdf });

      expect(result).toEqual({ kind: 'location', location: financeAttachmentSignedUrl.url });
      expect(gateway.calls.filter(({ service }) => service === 'finance')).toEqual([
        {
          service: 'finance',
          method: 'GET',
          path: `${ATTACHMENTS_PATH}/${FINANCE_IDS.attachmentPdf}/download-url`,
        },
      ]);
    });

    it('re-renders the detail with the not-found alert for an attachment finance does not know', async () => {
      const { result } = await submit('download', PREPARER, { aid: FINANCE_IDS.attachmentUploaded });

      expect(rerendered(result).model.alerts).toEqual([{ text: 'Not Found', className: 'alert alert-error' }]);
    });
  });

  describe('gates', () => {
    it.each([
      ['submit', PREPARER, { kind: 'allow' }],
      ['approve', PREPARER, { kind: 'allow' }],
      ['edit', APPROVER, { kind: 'allow' }],
      ['download', APPROVER, { kind: 'allow' }],
      ['upload', PREPARER, { kind: 'allow' }],
      ['upload', APPROVER, { kind: 'redirect', location: NOACCESS }],
      ['approve', Roles.reportingExporter, { kind: 'redirect', location: NOACCESS }],
      ['download', Roles.timesheetsEmployee, { kind: 'redirect', location: NOACCESS }],
    ])('decides %s for a %s by the roles finance requires of the route', async (action, role, decision) => {
      await expect(runGate(financeRequest(role, posted()), financeAction(action).gate)).resolves.toEqual(decision);
    });
  });
});
