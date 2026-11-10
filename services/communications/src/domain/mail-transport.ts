// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import nodemailer from 'nodemailer';

/** A plain-text message ready for the SMTP relay. */
export interface OutgoingMail {
  /** Already-filtered comma-separated recipient list. */
  to: string;
  from: { name: string; address: string };
  subject: string;
  text: string;
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

/** Address of the SMTP relay. */
export interface CreateSmtpTransportOptions {
  host: string;
  port: number;
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

/** Plain-SMTP transport sending text-only mail the way Masa's mailer `sendText` does. */
export function createSmtpTransport(options: CreateSmtpTransportOptions): MailTransport {
  const transporter = nodemailer.createTransport({ host: options.host, port: options.port, secure: false });
  return {
    async send(mail) {
      const info = await transporter.sendMail({
        from: { name: mail.from.name, address: mail.from.address },
        to: mail.to,
        subject: mail.subject,
        text: cfTrim(mail.text),
        messageId: messageIdHeader(mail.messageId),
      });
      return { accepted: info.accepted };
    },
    async close() {
      transporter.close();
    },
  };
}
