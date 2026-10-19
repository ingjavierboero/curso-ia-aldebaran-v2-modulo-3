import { asc, eq, sql } from 'drizzle-orm';
import { recordClientEvent } from '../clients/events.js';
import type { Db } from '../db/index.js';
import { clients, receivedAttachments, receivedEmails } from '../db/schema.js';

export interface EmailProcessingDeps {
  db: Db;
  now: () => Date;
}

export type EmailOutcome =
  /** RF-113: el remitente no es un cliente; queda como aviso Pendiente. */
  | { kind: 'aviso' }
  | { kind: 'cliente'; clientId: number }
  /** Ya se había procesado (por ejemplo, en una revisión anterior). */
  | { kind: 'ya_procesado' };

/**
 * Procesa un email recibido:
 * 1. identifica al cliente por su email de facturación, sin distinguir mayúsculas e
 *    incluyendo a los Inactivos (RF-111, RF-112, RF-118); si no hay, queda como aviso
 *    Pendiente y no se sigue (RF-113);
 * 2. lo registra en el historial del cliente (RF-114).
 * La clasificación y la validación del pago se suman en los pasos siguientes.
 */
export async function processReceivedEmail(deps: EmailProcessingDeps, emailId: number): Promise<EmailOutcome> {
  const { db } = deps;
  const email = db.select().from(receivedEmails).where(eq(receivedEmails.id, emailId)).get();
  if (!email) throw new Error(`El email ${emailId} no existe.`);
  if (email.processedAt) return { kind: 'ya_procesado' };

  const client = db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(sql`lower(${clients.billingEmail})`, email.from.toLowerCase()))
    .get();

  if (!client) {
    db.update(receivedEmails).set({ notice: 'pendiente', processedAt: deps.now() }).where(eq(receivedEmails.id, emailId)).run();
    return { kind: 'aviso' };
  }

  const attachments = db
    .select({ filename: receivedAttachments.filename, valid: receivedAttachments.valid })
    .from(receivedAttachments)
    .where(eq(receivedAttachments.emailId, emailId))
    .orderBy(asc(receivedAttachments.id))
    .all();

  db.transaction((tx) => {
    tx.update(receivedEmails).set({ clientId: client.id, processedAt: deps.now() }).where(eq(receivedEmails.id, emailId)).run();
    // AC-104: fecha, asunto y adjuntos del email en el historial del cliente.
    recordClientEvent(tx, client.id, 'email_recibido', null, {
      emailId,
      from: email.from,
      subject: email.subject,
      receivedAt: email.receivedAt.toISOString(),
      attachments: attachments.map((a) => ({ filename: a.filename, valid: a.valid })),
    });
  });
  return { kind: 'cliente', clientId: client.id };
}
