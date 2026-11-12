// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_ID_DOMAIN,
  type OutgoingMail,
  SMTP_TIMEOUT_MS,
  cfTrim,
  createSmtpTransport,
  messageIdHeader,
  sendTextBody,
} from '../../src/domain/mail-transport.js';

const mailer = vi.hoisted(() => {
  const sendMail = vi.fn();
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close }));
  return { sendMail, close, createTransport };
});

vi.mock('nodemailer', () => ({ default: { createTransport: mailer.createTransport } }));

const MESSAGE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

const mail: OutgoingMail = {
  to: 'a@example.com,b@example.com',
  from: { name: 'Masa', address: 'noreply@opt2.local' },
  subject: 'Hello',
  text: '\n\t Body line\n\n',
  messageId: MESSAGE_ID,
};

const envelope = {
  from: { name: 'Masa', address: 'noreply@opt2.local' },
  to: 'a@example.com,b@example.com',
  subject: 'Hello',
  messageId: `<${MESSAGE_ID}@opt2.local>`,
};

/** Sends one mail through a fresh transport and returns the options nodemailer received. */
async function sentOptions(parts: Pick<OutgoingMail, 'text' | 'html'>): Promise<unknown> {
  mailer.sendMail.mockResolvedValueOnce({ accepted: ['a@example.com'] });
  await createSmtpTransport({ host: 'smtp.test', port: 2525 }).send({ ...mail, text: undefined, ...parts });
  return mailer.sendMail.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('message id', () => {
  it('uses the opt2.local domain', () => {
    expect(MESSAGE_ID_DOMAIN).toBe('opt2.local');
    expect(messageIdHeader(MESSAGE_ID)).toBe(`<${MESSAGE_ID}@opt2.local>`);
  });
});

describe('cfTrim', () => {
  it.each([
    ['\t\n\r\0 \u0001abc\u001f \u0020', 'abc'],
    ['a  b\tc\nd', 'a  b\tc\nd'],
    [' \t\r\n\0 ', ''],
    ['', ''],
    ['!x!', '!x!'],
    ['\u00a0x\u00a0', '\u00a0x\u00a0'],
  ])('trims %j to %j', (input, expected) => {
    expect(cfTrim(input)).toBe(expected);
  });
});

describe('sendTextBody', () => {
  it.each([
    ['  plain body\n\n', 'plain body '],
    ['trailing tab\t', 'trailing tab '],
    ['été', 'été '],
    ['', ' '],
  ])('delivers %j as %j', (input, expected) => {
    expect(sendTextBody(input)).toBe(expected);
  });
});

describe('createSmtpTransport', () => {
  const timeouts = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 };

  it('limits every SMTP wait to the fixture cfmail timeout of 10 s', () => {
    expect(SMTP_TIMEOUT_MS).toBe(10_000);
  });

  it('opens a plain SMTP transport without a credential', () => {
    createSmtpTransport({ host: 'smtp.test', port: 2525 });

    expect(mailer.createTransport).toHaveBeenCalledTimes(1);
    expect(mailer.createTransport.mock.calls[0]).toStrictEqual([
      { host: 'smtp.test', port: 2525, secure: false, ...timeouts },
    ]);
  });

  it.each([
    [587, false, true],
    [465, true, false],
  ])('authenticates on port %i with secure %s and requireTLS %s', (port, secure, requireTLS) => {
    createSmtpTransport({ host: 'relay.test', port, credential: JSON.stringify({ user: 'c45-user', pass: 'c45-pass' }) });

    expect(mailer.createTransport).toHaveBeenCalledTimes(1);
    expect(mailer.createTransport.mock.calls[0]).toStrictEqual([
      { host: 'relay.test', port, secure, requireTLS, auth: { user: 'c45-user', pass: 'c45-pass' }, ...timeouts },
    ]);
  });

  it.each(['not json', '[]', 'null', '42', '{"user":"u"}', '{"user":"","pass":"p"}', '{"user":"u","pass":7}'])(
    'rejects the malformed secret %j without echoing it',
    (credential) => {
      let failure: unknown;
      try {
        createSmtpTransport({ host: 'relay.test', port: 587, credential });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        'communications-smtp secret must be JSON {"user":"<non-empty string>","pass":"<non-empty string>"}',
      );
      expect((failure as Error).message).not.toContain(credential);
      expect((failure as Error).cause).toBeUndefined();
      expect(mailer.createTransport).not.toHaveBeenCalled();
    },
  );

  it('returns the accepted recipients of a send under the fixed Message-ID', async () => {
    mailer.sendMail.mockResolvedValueOnce({
      accepted: ['a@example.com'],
      rejected: ['b@example.com'],
      messageId: `<${MESSAGE_ID}@opt2.local>`,
      response: '250 OK',
    });
    const transport = createSmtpTransport({ host: 'smtp.test', port: 2525 });

    await expect(transport.send(mail)).resolves.toStrictEqual({ accepted: ['a@example.com'] });
  });

  it.each([
    ['text only, verbatim', { text: '\n\t Body line\n\n' }, { text: '\n\t Body line\n\n' }],
    ['html only', { html: '<p>Hi</p>' }, { html: '<p>Hi</p>' }],
    ['text and html', { text: 'Hi\n', html: '<p>Hi</p>\n' }, { text: 'Hi\n', html: '<p>Hi</p>\n' }],
    ['empty text with html', { text: '', html: '<p>Hi</p>' }, { html: '<p>Hi</p>' }],
    ['empty text and html', { text: '', html: '' }, {}],
    ['neither part', {}, {}],
  ])('sends %s', async (_case, parts, expectedParts) => {
    await expect(sentOptions(parts)).resolves.toStrictEqual({
      ...envelope,
      ...expectedParts,
      textEncoding: 'quoted-printable',
    });
  });

  it.each([
    ['plain body', undefined, 'quoted-printable'],
    ['0123456789'.repeat(20), undefined, 'quoted-printable'],
    ['été', undefined, 'base64'],
    ['日本語のテキスト abc', undefined, 'base64'],
    ['café au lait', undefined, 'quoted-printable'],
    ['x\u0001y', undefined, 'quoted-printable'],
    ['abé', undefined, 'base64'],
    [undefined, 'été', 'base64'],
    ['plain body', 'été', 'quoted-printable'],
  ])('encodes text %j with html %j as %s', async (text, html, expected) => {
    await expect(sentOptions({ text, html })).resolves.toMatchObject({ textEncoding: expected });
  });

  it('propagates a send failure', async () => {
    const failure = new Error('connection refused');
    mailer.sendMail.mockRejectedValueOnce(failure);

    await expect(createSmtpTransport({ host: 'smtp.test', port: 2525 }).send(mail)).rejects.toBe(failure);
  });

  it('closes the transporter', async () => {
    const transport = createSmtpTransport({ host: 'smtp.test', port: 2525 });

    await expect(transport.close()).resolves.toBeUndefined();
    expect(mailer.close).toHaveBeenCalledTimes(1);
  });
});
