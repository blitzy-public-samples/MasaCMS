// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import nodemailer from 'nodemailer';

/** A message with a text and/or an HTML part, ready for the SMTP relay. */
export interface OutgoingMail {
  /** Already-filtered comma-separated recipient list. */
  to: string;
  from: { name: string; address: string };
  subject: string;
  /** text/plain part, sent byte for byte; empty or absent sends no text part. */
  text?: string;
  /** text/html part, sent byte for byte; empty or absent sends no HTML part. */
  html?: string;
  /** CF UUID of the communications.message row, without brackets or domain. */
  messageId: string;
}

/** Recipients the relay accepted. */
export interface SendResult {
  accepted: string[];
}

/** Port through which the service sends every mail. */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<SendResult>;
  close(): Promise<void>;
}

/** Address of the SMTP relay and, for an authenticating relay, its credential. */
export interface CreateSmtpTransportOptions {
  host: string;
  port: number;
  /** The `communications-smtp` secret value, JSON `{"user":"…","pass":"…"}`; absent for local Mailpit. */
  credential?: string;
}

/** Domain part of every Message-ID the service and the legacy fixture assign. */
export const MESSAGE_ID_DOMAIN = 'opt2.local';

/** Message-ID header value for a message id. */
export function messageIdHeader(messageId: string): string {
  return `<${messageId}@${MESSAGE_ID_DOMAIN}>`;
}

/** ColdFusion `trim`: strips leading and trailing characters at or below U+0020. */
export function cfTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

/** Body Masa's mailer `sendText` delivers: the CF-trimmed text plus the one space its cfmail tag adds. */
export function sendTextBody(text: string): string {
  return `${cfTrim(text)} `;
}

/** Transfer encoding JavaMail picks for a body: base64 when non-ASCII bytes are at least as many as ASCII ones. */
function javaMailTextEncoding(body: string): 'base64' | 'quoted-printable' {
  let ascii = 0;
  let nonAscii = 0;
  for (const b of Buffer.from(body, 'utf8')) {
    if (b >= 0x7f || (b < 0x20 && b !== 0x0d && b !== 0x0a && b !== 0x09)) nonAscii++;
    else ascii++;
  }
  return nonAscii > 0 && nonAscii >= ascii ? 'base64' : 'quoted-printable';
}

const CREDENTIAL_FORMAT_ERROR =
  'communications-smtp secret must be JSON {"user":"<non-empty string>","pass":"<non-empty string>"}';

/** SMTP AUTH user and password from the `communications-smtp` secret; throws a message without the value. */
function parseCredential(credential: string): { user: string; pass: string } {
  let value: unknown;
  try {
    value = JSON.parse(credential);
  } catch {
    throw new Error(CREDENTIAL_FORMAT_ERROR);
  }
  const { user, pass } = (value ?? {}) as { user?: unknown; pass?: unknown };
  if (typeof user !== 'string' || !user || typeof pass !== 'string' || !pass) throw new Error(CREDENTIAL_FORMAT_ERROR);
  return { user, pass };
}

/** SMTP transport sending parts verbatim; with a credential it authenticates over TLS (465) or required STARTTLS. */
export function createSmtpTransport(options: CreateSmtpTransportOptions): MailTransport {
  const { host, port, credential } = options;
  const auth = credential === undefined ? undefined : parseCredential(credential);
  const transporter = nodemailer.createTransport(
    auth ? { host, port, secure: port === 465, requireTLS: port !== 465, auth } : { host, port, secure: false },
  );
  return {
    async send(mail) {
      const info = await transporter.sendMail({
        from: { name: mail.from.name, address: mail.from.address },
        to: mail.to,
        subject: mail.subject,
        ...(mail.text ? { text: mail.text } : {}),
        ...(mail.html ? { html: mail.html } : {}),
        textEncoding: javaMailTextEncoding(mail.text || mail.html || ''),
        messageId: messageIdHeader(mail.messageId),
      });
      return { accepted: info.accepted };
    },
    async close() {
      transporter.close();
    },
  };
}
