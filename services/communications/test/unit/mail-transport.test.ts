// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_ID_DOMAIN, cfTrim, createSmtpTransport, messageIdHeader } from '../../src/domain/mail-transport.js';

const mailer = vi.hoisted(() => {
  const sendMail = vi.fn();
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close }));
  return { sendMail, close, createTransport };
});

vi.mock('nodemailer', () => ({ default: { createTransport: mailer.createTransport } }));

const MESSAGE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

const mail = {
  to: 'a@example.com,b@example.com',
  from: { name: 'Masa', address: 'noreply@opt2.local' },
  subject: 'Hello',
  text: '\n\t Body line\n\n',
  messageId: MESSAGE_ID,
};

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

describe('createSmtpTransport', () => {
  it('opens a plain SMTP transport', () => {
    createSmtpTransport({ host: 'smtp.test', port: 2525 });

    expect(mailer.createTransport).toHaveBeenCalledTimes(1);
    expect(mailer.createTransport).toHaveBeenCalledWith({ host: 'smtp.test', port: 2525, secure: false });
  });

  it('sends trimmed text under the fixed Message-ID', async () => {
    mailer.sendMail.mockResolvedValueOnce({
      accepted: ['a@example.com'],
      rejected: ['b@example.com'],
      messageId: `<${MESSAGE_ID}@opt2.local>`,
      response: '250 OK',
    });
    const transport = createSmtpTransport({ host: 'smtp.test', port: 2525 });

    await expect(transport.send(mail)).resolves.toEqual({ accepted: ['a@example.com'] });
    expect(mailer.sendMail).toHaveBeenCalledWith({
      from: { name: 'Masa', address: 'noreply@opt2.local' },
      to: 'a@example.com,b@example.com',
      subject: 'Hello',
      text: 'Body line',
      messageId: `<${MESSAGE_ID}@opt2.local>`,
    });
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
