import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { MailboxError, type IncomingEmail, type Mailbox } from './types.js';

/** RNF-07: el servidor de email se da por caído si no responde en 30 s. */
export const IMAP_TIMEOUT_MS = 30_000;

export interface ImapOptions {
  user: string;
  appPassword: string;
}

/** Casilla del sistema en Gmail por IMAP, con contraseña de aplicación. */
export class ImapMailbox implements Mailbox {
  constructor(
    private readonly options: ImapOptions,
    private readonly createClient: () => ImapFlow = () => gmailClient(options),
  ) {}

  async fetchSince(since: Date): Promise<IncomingEmail[]> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        // IMAP busca por día; el filtro fino por hora se hace con la fecha de llegada.
        const uids = await client.search({ since }, { uid: true });
        if (!uids || uids.length === 0) return [];

        const emails: IncomingEmail[] = [];
        for await (const message of client.fetch(uids, { uid: true, internalDate: true, source: true }, { uid: true })) {
          const receivedAt = message.internalDate ? new Date(message.internalDate) : null;
          if (!receivedAt || receivedAt < since || !message.source) continue;
          emails.push(toIncoming(await simpleParser(message.source), receivedAt));
        }
        return emails;
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      throw new MailboxError(`No se pudo leer la casilla: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}

export function gmailClient({ user, appPassword }: ImapOptions): ImapFlow {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass: appPassword },
    logger: false,
    connectionTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: IMAP_TIMEOUT_MS,
  });
}

/** Convierte un mensaje MIME parseado en un email entrante. */
export function toIncoming(parsed: ParsedMail, receivedAt: Date): IncomingEmail {
  const sender = parsed.from?.value[0];
  return {
    // Sin Message-ID (raro) se arma uno estable con la fecha y el remitente.
    messageId: parsed.messageId ?? `<sin-id-${receivedAt.getTime()}-${sender?.address ?? 'desconocido'}>`,
    from: sender?.address ?? '',
    fromName: sender?.name || null,
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    date: receivedAt,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? 'adjunto',
      contentType: a.contentType,
      // mailparser marca "related" las imágenes referenciadas desde el HTML (cid:).
      inline: a.related === true,
      content: a.content,
    })),
  };
}
