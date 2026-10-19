export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingEmail {
  /** Nombre que ve el destinatario como remitente (RF-215). */
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
}

export interface SentEmail {
  messageId: string;
  /** Destinatario real (puede diferir de `to` con EMAIL_REDIRECT_TO). */
  to: string;
}

/** Envío de emails: Gmail por SMTP, o la casilla simulada en modo mock (RF-194, RF-196). */
export interface Mailer {
  /** Casilla del sistema, remitente de todos los emails. */
  readonly from: string;
  /** Tira EmailError si el servidor rechaza el envío o no responde. */
  send(email: OutgoingEmail): Promise<SentEmail>;
}

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailError';
  }
}
