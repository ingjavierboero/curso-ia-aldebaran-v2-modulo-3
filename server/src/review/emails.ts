import { asc, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { receivedAttachments, receivedEmails } from '../db/schema.js';

/** Emails recibidos con sus adjuntos (sin el contenido) y el resultado de cada uno. */
export function emailsWithAttachments(db: Db, emailIds: number[]) {
  if (emailIds.length === 0) return [];
  const emails = db
    .select({
      id: receivedEmails.id,
      from: receivedEmails.from,
      fromName: receivedEmails.fromName,
      subject: receivedEmails.subject,
      text: receivedEmails.text,
      receivedAt: receivedEmails.receivedAt,
      classification: receivedEmails.classification,
    })
    .from(receivedEmails)
    .where(inArray(receivedEmails.id, emailIds))
    .orderBy(asc(receivedEmails.receivedAt), asc(receivedEmails.id))
    .all();
  const attachments = db
    .select({
      id: receivedAttachments.id,
      emailId: receivedAttachments.emailId,
      filename: receivedAttachments.filename,
      contentType: receivedAttachments.contentType,
      inline: receivedAttachments.inline,
      valid: receivedAttachments.valid,
      classification: receivedAttachments.classification,
      cuit: receivedAttachments.extractedCuit,
      amount: receivedAttachments.extractedAmount,
      error: receivedAttachments.processingError,
    })
    .from(receivedAttachments)
    .where(inArray(receivedAttachments.emailId, emailIds))
    .orderBy(asc(receivedAttachments.id))
    .all();
  return emails.map((e) => ({ ...e, attachments: attachments.filter((a) => a.emailId === e.id) }));
}
