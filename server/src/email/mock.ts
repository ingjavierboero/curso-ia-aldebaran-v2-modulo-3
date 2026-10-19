import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { mockMailboxAttachments, mockMailboxEmails } from '../db/schema.js';
import type { Mailer, OutgoingEmail, SentEmail } from './types.js';

/**
 * Envío del modo mock: no se conecta a Gmail (RF-194) y guarda cada email enviado en la
 * casilla simulada con su destinatario, asunto, cuerpo, adjuntos y fecha (RF-196).
 */
export class MockMailer implements Mailer {
  constructor(
    private readonly db: Db,
    readonly from: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(email: OutgoingEmail): Promise<SentEmail> {
    const messageId = `<${randomUUID()}@aldebaran-mock>`;
    this.db.transaction((tx) => {
      const row = tx
        .insert(mockMailboxEmails)
        .values({
          direction: 'enviado',
          messageId,
          from: email.fromName ? `${email.fromName} <${this.from}>` : this.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html ?? null,
          date: this.now(),
        })
        .returning({ id: mockMailboxEmails.id })
        .get();
      for (const attachment of email.attachments ?? []) {
        tx.insert(mockMailboxAttachments).values({ emailId: row.id, ...attachment }).run();
      }
    });
    return { messageId, to: email.to };
  }
}
