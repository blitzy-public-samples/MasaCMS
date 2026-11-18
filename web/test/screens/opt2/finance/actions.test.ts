// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// finance post actions: lifecycle transitions, edit, attachment upload and signed download, over finance's /v1 API.
import * as cheerio from 'cheerio';
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGate } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { ScreenRequestBody, SubmitResult } from '@/screens/registry';
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

/** The body markup of a re-rendering outcome; throws for any other outcome. */
function markupOf(result: SubmitResult): string {
  if (result.kind !== 'render') throw new Error(`Expected a re-render, got ${result.kind}`);
  return toString(result.view.body);
}

/** The ids of the controls `$` autofocuses, in document order. */
const focusedIds = ($: cheerio.CheerioAPI): Array<string | undefined> =>
  $('[autofocus]')
    .toArray()
    .map((el) => $(el).attr('id'));

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
      expect(model.headings.slice(0, 2)).toEqual(['Finance Record', 'Version History']);
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

    const INVALID = financeError(400, 'finance.records.edit', 'Invalid parameters');
    const AMOUNT_MESSAGE = 'Enter a number with up to 15 digits before the decimal point and up to 4 after it.';

    /** The re-rendered detail of an edit of `fields` refused with `reply`. */
    async function refusedEdit(fields: Readonly<Record<string, string>>, reply = INVALID) {
      const { result } = await submit('edit', PREPARER, { ...EDITED, ...fields }, { [transitionRoute('edit')]: reply });
      return cheerio.load(markupOf(result), null, false);
    }

    /** The marked fields of an edit of `fields` refused with `reply`: name, message, described-by and focus, in order. */
    async function markedFields(fields: Readonly<Record<string, string>>, reply = INVALID) {
      const $ = await refusedEdit(fields, reply);
      expect($('[autofocus]')).toHaveLength(1);
      return $('div.mura-control-group.has-error')
        .toArray()
        .map((group) => {
          const input = $(group).find('input');
          const message = $(group).children('label').next('p.help-block');
          expect(input.attr('aria-invalid')).toBe('true');
          expect(message.attr('id')).toBe(`${input.attr('id')}-error`);
          return [input.attr('name'), message.text(), input.attr('aria-describedby'), input.attr('autofocus') !== undefined];
        });
    }

    it.each<[string, Readonly<Record<string, string>>, unknown[][]]>([
      ['an empty title', { title: '' }, [['title', 'Enter a title that is not blank.', 'title-error', true]]],
      ['a title of spaces and controls', { title: ' \t\u0000 ' }, [['title', 'Enter a title that is not blank.', 'title-error', true]]],
      ['a 256-character title', { title: 't'.repeat(256) }, [['title', 'Enter at most 255 characters.', 'title-error', true]]],
      [
        'a title holding NUL, which PostgreSQL text cannot store',
        { title: 'Q2\u0000travel' },
        [['title', 'Enter a title without NUL (U+0000) characters.', 'title-error', true]],
      ],
      ...['abc', '', '12.345678', '1234567890123456', '1,5', '1e3', '+5'].map(
        (amount): [string, Readonly<Record<string, string>>, unknown[][]] => [
          `the amount ${JSON.stringify(amount)}`,
          { amount },
          [['amount', AMOUNT_MESSAGE, 'amount-error amount-hint', true]],
        ],
      ),
      ...['bad', '2026-13', '2026-6', ' 2026-06'].map((period): [string, Readonly<Record<string, string>>, unknown[][]] => [
        `the period ${JSON.stringify(period)}`,
        { period },
        [['period', 'Enter a month as YYYY-MM, for example 2026-06.', 'period-error', true]],
      ]),
      [
        'every field, the first one focused',
        { title: '', amount: 'abc', period: 'bad' },
        [
          ['title', 'Enter a title that is not blank.', 'title-error', true],
          ['amount', AMOUNT_MESSAGE, 'amount-error amount-hint', false],
          ['period', 'Enter a month as YYYY-MM, for example 2026-06.', 'period-error', false],
        ],
      ],
    ])('marks %s beside its field on the invalidParameters refusal', async (_, fields, expected) => {
      expect(await markedFields(fields)).toEqual(expected);
    });

    it.each<[string, Readonly<Record<string, string>>]>([
      ['the numeric(19,4) maximum', { amount: '999999999999999.9999' }],
      ['a padded negative amount of four decimals', { amount: ' \t-0.1234\n' }],
      ['a 255-character title', { title: 't'.repeat(255) }],
    ])('marks the amount with the period-total limit for %s, which no field rule refuses', async (_, fields) => {
      expect(await markedFields(fields)).toEqual([
        [
          'amount',
          "Finance refused this amount. A period's positive amounts, and its negative amounts, may each total at most " +
            '999999999999999.9999.',
          'amount-error amount-hint',
          true,
        ],
      ]);
    });

    const VALUELESS_REFUSALS: ReadonlyArray<readonly [string, typeof INVALID]> = [
      ['a CSRF refusal', financeError(400, 'finance.records.edit', 'Invalid CSRF tokens')],
      ['a role refusal (403)', financeError(403, 'finance.records.edit', 'Insufficient Account Permissions')],
      ['an unknown record (404)', financeError(404, 'finance.records.edit', 'Not Found')],
      ['an illegal edit (409)', financeTransitionIllegal],
    ];
    const EDIT_VALUES: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
      ['invalid values', { title: '', amount: 'abc' }],
      ['valid values', {}],
    ];

    it.each(
      VALUELESS_REFUSALS.flatMap(([refusal, reply]) =>
        EDIT_VALUES.map(([values, fields]) => [`${refusal} of ${values}`, fields, reply] as const),
      ),
    )('marks no field on %s, which says nothing of the values, and focuses the title', async (_, fields, reply) => {
      const $ = await refusedEdit(fields, reply);
      expect($('.has-error')).toHaveLength(0);
      expect($('[aria-invalid]')).toHaveLength(0);
      expect(focusedIds($)).toEqual(['title']);
    });

    it('explains the amount format and the period totals in a standing hint', async () => {
      const { result } = await submit('edit', PREPARER, EDITED, { [transitionRoute('edit')]: INVALID });
      const $ = cheerio.load(markupOf(result), null, false);
      expect($('#amount').next().is('div.help-block-inline#amount-hint')).toBe(true);
      expect($('#amount-hint').text()).toContain('999999999999999.9999');
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

  describe('malformed ids', () => {
    const MALFORMED = ['..', '../x', '../../x', 'abc'];

    it.each(
      ['submit', 'approve', 'edit', 'upload', 'download'].flatMap((action) =>
        MALFORMED.map((id) => ({ action, id, aid: FINANCE_IDS.attachmentPdf })),
      ),
    )('re-renders $action for the id $id with the invalid-parameters alert, asking finance nothing', async ({ action, id, aid }) => {
      const { result, gateway } = await submit(action, PREPARER, { id, aid, title: 'T', amount: '1', period: '2026-07' });
      const { module, model } = rerendered(result);

      expect(module).toBe('finance');
      expect(model.headings).toEqual(['Finance Record']);
      expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
      expect(financeCalls(gateway)).toEqual([]);
    });

    it.each(MALFORMED)('re-renders the detail for the attachment id %j, reading the record only', async (aid) => {
      const { result, gateway } = await submit('download', APPROVER, { aid });
      const { model } = rerendered(result);

      expect(model.headings.slice(0, 2)).toEqual(['Finance Record', 'Version History']);
      expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
      expect(financeCalls(gateway)).toEqual([`GET ${RECORD_PATH}`]);
    });
  });

  describe('refusal alert placement', () => {
    const FIELDS = { title: 'Consulting services Q2', amount: '4200.5', period: '2026-07' };

    it.each([
      ['edit', 'form[name="form1"]', transitionRoute('edit'), 'Invalid CSRF tokens', 'Edit Record', 'title'],
      ['upload', 'form[enctype="multipart/form-data"]', UPLOAD_ROUTE, 'Invalid parameters', 'Upload Attachment', 'file'],
    ])(
      'shows a refused %s alert just before its form, under the form heading, its first control focused',
      async (action, form, route, message, heading, focused) => {
        const reply = financeError(400, `finance.records.${action}`, message);
        const { result } = await submit(action, PREPARER, FIELDS, { [route]: reply });
        const $ = cheerio.load(markupOf(result), null, false);

        const alert = $(form).prev();
        expect(alert.is('div.alert.alert-error') && alert.text()).toBe(message);
        expect(alert.prev().is('h2') && alert.prev().text()).toBe(heading);
        expect($('.alert')).toHaveLength(1);
        expect($('.has-error')).toHaveLength(0);
        expect(focusedIds($)).toEqual([focused]);
        expect($(form).find(`#${focused}`)).toHaveLength(1);
      },
    );

    it.each([
      ['a refused transition', 'submit', PREPARER, financeTransitionIllegal],
      [
        'an edit refused to an approver, who has no edit form',
        'edit',
        APPROVER,
        financeError(403, 'finance.records.edit', 'Insufficient Account Permissions'),
      ],
    ])('leads the detail with the alert of %s, focusing nothing', async (_, action, role, reply) => {
      const { result } = await submit(action, role, FIELDS, { [transitionRoute(action)]: reply });
      const $ = cheerio.load(markupOf(result), null, false);

      expect($('div.mura-header').next().find('.block-content').children().first().is('div.alert.alert-error')).toBe(true);
      expect($('.alert')).toHaveLength(1);
      expect(focusedIds($)).toEqual([]);
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
