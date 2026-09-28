import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { DomainError } from '../lib/errors.ts';
import type { MailSettings } from './settings.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

export type TransportFactory = (options: SmtpOptions) => Pick<Transporter, 'sendMail'>;

const defaultFactory: TransportFactory = (options) => nodemailer.createTransport(options);

export function buildSmtpOptions(settings: MailSettings, password: string | null): SmtpOptions {
  if (!settings.host) throw new DomainError('invalid', 'No SMTP host is configured.');
  if (settings.username && !password) {
    throw new DomainError('invalid', 'An SMTP username is configured, but no password.');
  }
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.security === 'tls',
    requireTLS: settings.security === 'starttls',
    ...(settings.username && password ? { auth: { user: settings.username, pass: password } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

export async function sendMail(
  settings: MailSettings,
  password: string | null,
  message: MailMessage,
  createTransport: TransportFactory = defaultFactory,
): Promise<{ message_id: string | null }> {
  if (!settings.from_email) throw new DomainError('invalid', 'No sender address is configured.');
  const transport = createTransport(buildSmtpOptions(settings, password));

  try {
    const info = await transport.sendMail({
      from: settings.from_name
        ? { name: settings.from_name, address: settings.from_email }
        : settings.from_email,
      replyTo: settings.reply_to ?? undefined,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { message_id: typeof info?.messageId === 'string' ? info.messageId : null };
  } catch (err) {
    // The SMTP server's answer helps with setup and contains no secrets.
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw new DomainError('invalid', `The mail server rejected the message: ${reason}`);
  }
}
