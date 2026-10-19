export interface IncomingAttachment {
  filename: string;
  contentType: string;
  /** Imagen embebida en el cuerpo del mensaje, como el logo de una firma (RF-116). */
  inline: boolean;
  content: Buffer;
}

export interface IncomingEmail {
  messageId: string;
  /** Dirección del remitente. */
  from: string;
  fromName: string | null;
  subject: string;
  text: string;
  /** Momento en que llegó a la casilla. */
  date: Date;
  attachments: IncomingAttachment[];
}

/** Lectura de la casilla del sistema: Gmail por IMAP, o la casilla simulada en modo mock. */
export interface Mailbox {
  /** Emails recibidos desde `since` (inclusive). Tira MailboxError si no puede leer. */
  fetchSince(since: Date): Promise<IncomingEmail[]>;
}

export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxError';
  }
}
