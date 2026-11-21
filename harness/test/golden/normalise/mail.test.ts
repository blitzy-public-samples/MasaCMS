import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CF_UUID_IN_TEXT, createIdOrdinals, ordinalFor } from '../../../src/golden/normalise/ids.js';
import { normaliseMail, type NormalisedMail } from '../../../src/golden/normalise/mail.js';
import { applyOverrides, loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import { collectMail, type MailMessage, type SideEffectDeps } from '../../../src/golden/side-effects.js';

type FetchLike = NonNullable<SideEffectDeps['fetch']>;

interface MailpitAddress {
  Name: string;
  Address: string;
}

interface MailpitSummary {
  ID: string;
  MessageID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Created: string;
  Snippet: string;
}

interface MailpitList {
  total: number;
  messages: MailpitSummary[];
}

/** A message detail as the fixture holds it; `Headers` is served from the detail's `/headers` route. */
interface MailpitDetail {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Text: string;
  HTML: string;
  Headers: Record<string, string[]>;
  [field: string]: unknown;
}

const MAILPIT = 'http://mailpit.fixture.test:8025';
// The fixture's reset link was rendered by the legacy instance on port 8080; replay arrives through the gateway.
const LEGACY_PORT = '8080';
const LEGACY_ORIGIN = `http://127.0.0.1:${LEGACY_PORT}`;
const GATEWAY_ORIGIN = 'http://127.0.0.1:8100';
const SITE_PATH_ID = '22222222-2222-2222-2222222222222222';
const USER_ID = '33333333-3333-3333-3333333333333333';
const RESET_LINK = `${LEGACY_ORIGIN}/index.cfm/${SITE_PATH_ID}/?userID=${USER_ID}`;
const FORGOT_TO = 'avery.member@example.test';
const FORGOT_SUBJECT = 'Masa CMS Account Information';
const TEMPLATE_SUBJECT = 'June programme update';
const DROPPED_HEADERS = ['Message-Id', 'Date', 'Received'];

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../fixtures/mail/${name}`, import.meta.url), 'utf8')) as T;
}

const LIST = fixture<MailpitList>('mailpit-list.json');
const FORGOT = fixture<MailpitDetail>('mailpit-message.json');

function summary(id: string): MailpitSummary {
  const found = LIST.messages.find((message) => message.ID === id);
  if (found === undefined) throw new Error(`mailpit-list.json holds no message ${id}`);
  return found;
}

/** Minimal detail of a list summary: its addresses and subject, the snippet as text and HTML body, and headers. */
function detailOf(message: MailpitSummary): MailpitDetail {
  return {
    ID: message.ID,
    From: message.From,
    To: message.To,
    Subject: message.Subject,
    Text: `${message.Snippet}\r\n`,
    HTML: `<html><body><p>${message.Snippet}</p></body></html>`,
    Headers: {
      Date: [new Date(message.Created).toUTCString()],
      'Message-Id': [`<${message.MessageID}>`],
      Received: [`from localhost by mailpit (Mailpit) with SMTP; ${new Date(message.Created).toUTCString()}`],
      Subject: [message.Subject],
    },
  };
}

const TEMPLATE = detailOf(summary('mpTemplateSend00000002'));

/** Scripted Mailpit serving `details` through the list, detail and headers routes; any other request rejects. */
function fakeMailpit(details: readonly MailpitDetail[]): FetchLike {
  const byId = new Map(details.map((detail) => [detail.ID, detail]));
  const listed = details.map((detail) => LIST.messages.find((m) => m.ID === detail.ID) ?? { ID: detail.ID });
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  return async (input, init) => {
    const url = new URL(input);
    const route = /^\/api\/v1\/message\/([^/]+)(\/headers)?$/.exec(url.pathname);
    const detail = route?.[1] === undefined ? undefined : byId.get(decodeURIComponent(route[1]));
    if ((init.method ?? 'GET') === 'GET' && url.origin === MAILPIT) {
      if (url.pathname === '/api/v1/messages') {
        const start = Number(url.searchParams.get('start'));
        const limit = Number(url.searchParams.get('limit'));
        return json({ ...LIST, total: listed.length, messages: listed.slice(start, start + limit) });
      }
      if (detail !== undefined) {
        const { Headers: headers, ...message } = detail;
        return json(route?.[2] === undefined ? message : headers);
      }
    }
    throw new Error(`unscripted request ${init.method ?? 'GET'} ${input}`);
  };
}

function collect(details: readonly MailpitDetail[]): Promise<MailMessage[]> {
  return collectMail({}, { fetch: fakeMailpit(details), config: { serviceUrls: {}, mailpitUrl: MAILPIT } });
}

/** `detail` with every occurrence of each `[from, to]` pair replaced, `Headers` included. */
function rewritten(detail: MailpitDetail, pairs: ReadonlyArray<readonly [string, string]>): MailpitDetail {
  const text = pairs.reduce((json, [from, to]) => json.replaceAll(from, to), JSON.stringify(detail));
  return JSON.parse(text) as MailpitDetail;
}

/** The same send as replay delivers it: fresh ids, the gateway origin and new transport headers. */
function replayOf(detail: MailpitDetail, n: number): MailpitDetail {
  const copy = rewritten(detail, [
    [SITE_PATH_ID, `AAAAAAA${n}-BBBB-CCCC-DDDDEEEEFFFF0000`],
    [USER_ID, `1234567${n}-89AB-CDEF-0123456789ABCDEF`],
    [LEGACY_ORIGIN, GATEWAY_ORIGIN],
  ]);
  return {
    ...copy,
    Headers: {
      ...copy.Headers,
      Date: [`Tue, 30 Jun 2026 11:4${n}:17 +0000 (UTC)`],
      'Message-Id': [`<replay-${n}.JavaMail.gateway@example.test>`],
      Received: [`from 10.0.0.${n} (gateway) by mailpit (Mailpit) with ESMTP for <${FORGOT_TO}>; Tue, 30 Jun 2026`],
    },
  };
}

function withMail(rules: NormaliseRules, mail: Partial<NormaliseRules['mail']>): NormaliseRules {
  return { ...rules, mail: { ...rules.mail, ...mail } };
}

const find = (mail: readonly NormalisedMail[], subject: string): NormalisedMail | undefined =>
  mail.find((m) => m.subject === subject);

let rules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: LEGACY_PORT });
});

describe('normaliseMail', () => {
  const NORMALISED_LINK = '<origin>/index.cfm/<id:1>/?userID=<id:2>';

  it('keeps recipients, sender, subject and both bodies of the forgot-password mail', async () => {
    const [forgot] = normaliseMail(await collect([FORGOT]), createIdOrdinals(), rules);

    expect(forgot).toStrictEqual({
      to: [FORGOT_TO],
      from: 'Masa CMS <no-reply@example.test>',
      subject: FORGOT_SUBJECT,
      text: FORGOT.Text.replaceAll('\r\n', '\n').trimEnd().replace(RESET_LINK, NORMALISED_LINK),
      htmlText: [
        'Dear Avery,',
        'We received a request to reset the password associated with this email address. If you made this request, please follow the instructions below.',
        '(If you did not request to have your password reset you can safely ignore this email.)',
        'Please click the link below to access your account and reset your password:',
        NORMALISED_LINK,
        "If clicking the link doesn't seem to work, you can copy and paste the link into your browser's address window, or retype it there. Once you have returned to Masa CMS, you can then access your account and reset your password.",
        'Thanks for using Masa CMS',
      ].join('\n'),
    });
  });

  it('drops the Message-ID, Date and Received headers', async () => {
    const collected = await collect([FORGOT, TEMPLATE]);
    for (const message of collected) {
      expect(Object.keys(message.headers)).toEqual(expect.arrayContaining(DROPPED_HEADERS));
    }

    const out = normaliseMail(collected, createIdOrdinals(), rules);

    const serialised = JSON.stringify(out);
    for (const name of DROPPED_HEADERS) {
      for (const value of [...(FORGOT.Headers[name] ?? []), ...(TEMPLATE.Headers[name] ?? [])]) {
        expect(serialised).not.toContain(value);
      }
    }
    expect(serialised).not.toMatch(/JavaMail|by mailpit|\+0000/);
    for (const mail of out) expect(mail).not.toHaveProperty('headers');
  });

  it('sorts the recipients of a message', async () => {
    const to = [
      { Name: '', Address: 'zed@example.test' },
      { Name: '', Address: 'amy@example.test' },
    ];
    const collected = await collect([{ ...FORGOT, To: to }]);
    expect(collected[0]?.to).toStrictEqual(['zed@example.test', 'amy@example.test']);

    const [mail] = normaliseMail(collected, createIdOrdinals(), rules);

    expect(mail?.to).toStrictEqual(['amy@example.test', 'zed@example.test']);
  });

  it.each([
    { label: 'LF line endings', body: (s: string) => s.replaceAll('\r\n', '\n') },
    { label: 'trailing whitespace before line ends', body: (s: string) => s.replaceAll('\r\n', ' \t\r\n') },
    { label: 'trailing blank lines', body: (s: string) => `${s}\r\n\r\n` },
  ])('normalises bodies with $label as the CRLF original', async ({ body }) => {
    const original = normaliseMail(await collect([FORGOT]), createIdOrdinals(), rules);
    const variant = normaliseMail(
      await collect([{ ...FORGOT, Text: body(FORGOT.Text), HTML: body(FORGOT.HTML) }]),
      createIdOrdinals(),
      rules,
    );

    expect(variant).toStrictEqual(original);
    expect(JSON.stringify(variant)).not.toContain('\\r');
  });

  it('turns the reset link ids into ordinals and its origin into the placeholder', async () => {
    const [forgot] = normaliseMail(await collect([FORGOT]), createIdOrdinals(), rules);

    for (const body of [forgot?.text ?? '', forgot?.htmlText ?? '']) {
      expect(body).toContain(NORMALISED_LINK);
      expect(body).not.toContain(LEGACY_ORIGIN);
      expect(body.match(CF_UUID_IN_TEXT)).toBeNull();
    }
  });

  it('continues id numbering from the steps, so the user id keeps its step ordinal', async () => {
    const state = createIdOrdinals();
    expect(ordinalFor(USER_ID, state, rules.ids)).toBe('<id:1>');

    const [forgot] = normaliseMail(await collect([FORGOT]), state, rules);

    expect(forgot?.text).toContain('<origin>/index.cfm/<id:2>/?userID=<id:1>');
    expect(state.next).toBe(3);
  });

  it.each([
    { label: 'arrival order', order: [0, 1, 2, 3] },
    { label: 'reversed', order: [3, 2, 1, 0] },
    { label: 'interleaved', order: [1, 3, 0, 2] },
    { label: 'duplicate first', order: [2, 0, 3, 1] },
  ])('orders messages and numbers their ids by content, not $label', async ({ order }) => {
    const casey = rewritten(replayOf(FORGOT, 7), [
      [FORGOT.ID, 'mpForgotMail0000000002'],
      [FORGOT_TO, 'casey.member@example.test'],
      ['Dear Avery', 'Dear Casey'],
    ]);
    const collected = await collect([FORGOT, casey, TEMPLATE, { ...FORGOT, ID: 'mpForgotMail0000000003' }]);
    const arrived = order.map((index) => collected[index] as MailMessage);

    const expected = normaliseMail(collected, createIdOrdinals(), rules);
    const out = normaliseMail(arrived, createIdOrdinals(), rules);

    expect(out).toStrictEqual(expected);
    expect(out.map((m) => m.to)).toStrictEqual([
      ['Blake Recipient <blake.recipient@example.test>'],
      [FORGOT_TO],
      [FORGOT_TO],
      ['casey.member@example.test'],
    ]);
    expect(out.map((m) => m.text.match(/<id:\d+>/g))).toStrictEqual([
      null,
      ['<id:1>', '<id:2>'],
      ['<id:1>', '<id:2>'],
      ['<id:3>', '<id:4>'],
    ]);
  });

  describe('golden against replay', () => {
    const golden = async (): Promise<NormalisedMail[]> =>
      normaliseMail(await collect([FORGOT, TEMPLATE]), createIdOrdinals(), rules);

    it('matches a replay that differs only in ids, origin and transport headers', async () => {
      const replay = normaliseMail(
        await collect([replayOf(FORGOT, 1), replayOf(TEMPLATE, 2)]),
        createIdOrdinals(),
        rules,
      );

      expect(replay).toStrictEqual(await golden());
    });

    it.each([
      { label: 'subject', change: { Subject: 'Masa CMS Account Update' } },
      { label: 'recipient', change: { To: [{ Name: '', Address: 'casey.member@example.test' }] } },
    ])('differs when the replay changes the $label', async ({ change }) => {
      const replay = normaliseMail(
        await collect([{ ...replayOf(FORGOT, 1), ...change }, replayOf(TEMPLATE, 2)]),
        createIdOrdinals(),
        rules,
      );

      expect(replay).not.toStrictEqual(await golden());
    });
  });

  it('returns no messages for an empty mailbox and leaves the state untouched', async () => {
    const state = createIdOrdinals();

    expect(normaliseMail(await collect([]), state, rules)).toStrictEqual([]);
    expect(state).toStrictEqual(createIdOrdinals());
  });

  it.each([
    { order: ['subject'], subjects: [TEMPLATE_SUBJECT, FORGOT_SUBJECT] },
    { order: ['To'], subjects: [TEMPLATE_SUBJECT, FORGOT_SUBJECT] },
    { order: ['from'], subjects: [FORGOT_SUBJECT, TEMPLATE_SUBJECT] },
    { order: ['text'], subjects: [FORGOT_SUBJECT, TEMPLATE_SUBJECT] },
    { order: ['htmlText'], subjects: [FORGOT_SUBJECT, TEMPLATE_SUBJECT] },
  ])('sorts by mail.order $order', async ({ order, subjects }) => {
    const out = normaliseMail(await collect([TEMPLATE, FORGOT]), createIdOrdinals(), withMail(rules, { order }));

    expect(out.map((m) => m.subject)).toStrictEqual(subjects);
  });

  it('rejects an unknown mail.order key', () => {
    expect(() => normaliseMail([], createIdOrdinals(), withMail(rules, { order: ['priority'] }))).toThrow(
      /mail\.order: unknown sort key priority; expected one of recipient, to, from, subject, text, htmltext/,
    );
  });

  it('compares a header mail.compare names, unless the rules or a scenario drop it', async () => {
    const compared = withMail(rules, { compare: [...rules.mail.compare, 'X-Mailer', 'date', 'X-Mailer'] });
    const collected = await collect([FORGOT, TEMPLATE]);

    const out = normaliseMail(collected, createIdOrdinals(), compared);

    expect(find(out, FORGOT_SUBJECT)?.headers).toStrictEqual({ 'X-Mailer': ['ColdFusion 2023 Application Server'] });
    expect(find(out, TEMPLATE_SUBJECT)?.headers).toStrictEqual({});

    const dropped = applyOverrides(compared, { dropHeaders: ['x-mailer'] }, 'GS-CM-01');
    for (const mail of normaliseMail(collected, createIdOrdinals(), dropped)) {
      expect(mail).not.toHaveProperty('headers');
    }
  });
});
