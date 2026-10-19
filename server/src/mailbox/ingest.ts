import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { invoices, mailboxState, receivedAttachments, receivedEmails } from '../db/schema.js';
import { isValidAttachment } from './attachments.js';
import type { Mailbox } from './types.js';

export interface IngestDeps {
  db: Db;
  mailbox: Mailbox;
  /** Casilla del sistema: sus propios emails no se procesan (RF-110). */
  systemMailbox: string;
  now: () => Date;
}

export interface IngestResult {
  /** Ids de los emails nuevos registrados. */
  emailIds: number[];
  /** Desde cuándo se leyó la casilla; null si todavía no hay facturas. */
  since: Date | null;
}

/**
 * Lee la casilla y registra los emails nuevos con sus adjuntos:
 * - la primera vez, desde el día de la primera factura emitida; después, desde el inicio
 *   de la revisión anterior (RF-107, RF-108);
 * - cada email una sola vez, por su Message-ID, aunque se vuelva a leer (RF-109);
 * - ignora los que manda la propia casilla del sistema (RF-110).
 * Si la lectura falla, tira y no avanza la marca de la última revisión, así la siguiente
 * vuelve a leer los emails llegados durante la falla (RF-105).
 */
export async function ingestNewEmails(deps: IngestDeps): Promise<IngestResult> {
  const { db } = deps;
  const startedAt = deps.now();
  const since = readSince(db);
  if (!since) return { emailIds: [], since: null };

  const fetched = await deps.mailbox.fetchSince(since);

  const own = deps.systemMailbox.toLowerCase();
  const candidates = fetched.filter((e) => e.from.toLowerCase() !== own);
  const known = new Set(
    candidates.length === 0
      ? []
      : db
          .select({ messageId: receivedEmails.messageId })
          .from(receivedEmails)
          .where(inArray(receivedEmails.messageId, candidates.map((e) => e.messageId)))
          .all()
          .map((r) => r.messageId),
  );

  const emailIds: number[] = [];
  db.transaction((tx) => {
    for (const email of candidates) {
      if (known.has(email.messageId)) continue;
      known.add(email.messageId);
      const row = tx
        .insert(receivedEmails)
        .values({
          messageId: email.messageId,
          from: email.from.toLowerCase(),
          fromName: email.fromName,
          subject: email.subject,
          text: email.text,
          receivedAt: email.date,
          ingestedAt: deps.now(),
        })
        .returning({ id: receivedEmails.id })
        .get();
      for (const attachment of email.attachments) {
        tx.insert(receivedAttachments)
          .values({ emailId: row.id, ...attachment, valid: isValidAttachment(attachment) })
          .run();
      }
      emailIds.push(row.id);
    }
    tx.insert(mailboxState)
      .values({ id: 1, lastCheckStartedAt: startedAt })
      .onConflictDoUpdate({ target: mailboxState.id, set: { lastCheckStartedAt: startedAt } })
      .run();
  });

  return { emailIds, since };
}

/** Desde cuándo leer: inicio de la revisión anterior o, la primera vez, el día de la primera factura. */
function readSince(db: Db): Date | null {
  const state = db.select().from(mailboxState).where(eq(mailboxState.id, 1)).get();
  if (state?.lastCheckStartedAt) return state.lastCheckStartedAt;

  const first = db.select({ issueDate: invoices.issueDate }).from(invoices).orderBy(asc(invoices.issueDate)).get();
  return first ? startOfArgentinaDay(first.issueDate) : null;
}

/** "2026-10-15" → 15/10/2026 00:00 en Argentina (sin horario de verano: siempre -03:00). */
function startOfArgentinaDay(date: string): Date {
  return new Date(`${date}T00:00:00-03:00`);
}
