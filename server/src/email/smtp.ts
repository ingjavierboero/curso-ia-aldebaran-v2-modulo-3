import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { EmailError, type Mailer, type OutgoingEmail, type SentEmail } from './types.js';

/** RNF-07: el servidor de email se da por caído si no responde en 30 s. */
export const SMTP_TIMEOUT_MS = 30_000;

export interface SmtpOptions {
  user: string;
  appPassword: string;
  /** Solo desarrollo: manda todos los emails a esta casilla (EMAIL_REDIRECT_TO). */
  redirectTo: string | null;
}

/** Transporte SMTP de Gmail con contraseña de aplicación. */
export function gmailTransport({ user, appPassword }: SmtpOptions): Transporter {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass: appPassword },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

export class SmtpMailer implements Mailer {
  readonly from: string;

  constructor(
    private readonly options: SmtpOptions,
    private readonly transport: Pick<Transporter, 'sendMail'> = gmailTransport(options),
  ) {
    this.from = options.user;
  }

  async send(email: OutgoingEmail): Promise<SentEmail> {
    const { redirectTo } = this.options;
    const to = redirectTo ?? email.to;
    // Con EMAIL_REDIRECT_TO el asunto conserva a quién iba dirigido.
    const subject = redirectTo ? `[para ${email.to}] ${email.subject}` : email.subject;
    try {
      const info = await this.transport.sendMail({
        from: email.fromName ? { name: email.fromName, address: this.from } : this.from,
        to,
        subject,
        text: email.text,
        html: email.html,
        attachments: email.attachments,
      });
      return { messageId: info.messageId, to };
    } catch (error) {
      throw new EmailError(
        `No se pudo enviar el email a ${to}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
