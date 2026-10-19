import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { mockMailboxAttachments, mockMailboxEmails } from '../db/schema.js';
import type { IncomingEmail, Mailbox } from './types.js';

/**
 * Casilla simulada del modo mock (RF-203): los emails recibidos que cargó un usuario,
 * que se procesan en la siguiente revisión con las mismas reglas que los de Gmail.
 */
export class MockMailbox implements Mailbox {
  constructor(private readonly db: Db) {}

  async fetchSince(since: Date): Promise<IncomingEmail[]> {
    const emails = this.db
      .select()
      .from(mockMailboxEmails)
      .where(and(eq(mockMailboxEmails.direction, 'recibido'), gte(mockMailboxEmails.date, since)))
      .orderBy(asc(mockMailboxEmails.date), asc(mockMailboxEmails.id))
      .all();
    if (emails.length === 0) return [];

    const attachments = this.db
      .select()
      .from(mockMailboxAttachments)
      .where(inArray(mockMailboxAttachments.emailId, emails.map((e) => e.id)))
      .orderBy(asc(mockMailboxAttachments.id))
      .all();

    return emails.map((email) => ({
      messageId: email.messageId,
      ...parseAddress(email.from),
      subject: email.subject,
      text: email.text,
      date: email.date,
      attachments: attachments
        .filter((a) => a.emailId === email.id)
        .map((a) => ({ filename: a.filename, contentType: a.contentType, inline: a.inline, content: a.content })),
    }));
  }
}

/** "Nombre <dir@x.com>" → { from: "dir@x.com", fromName: "Nombre" }. */
export function parseAddress(value: string): { from: string; fromName: string | null } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { from: match[2]!.trim(), fromName: match[1]?.replace(/^"|"$/g, '') || null };
  return { from: value.trim(), fromName: null };
}
