import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { clientEvents, clients, receivedAttachments, receivedEmails } from '../db/schema.js';

/** Qué hizo el agente con un email recibido (para mostrarlo junto al email). */
export interface EmailProcessing {
  /** pendiente: todavía no pasó por una revisión de la casilla. */
  status: 'pendiente' | 'aviso' | 'procesado';
  clientId: number | null;
  clientName: string | null;
  processedAt: Date | null;
  /** RF-123; null si no tenía adjuntos válidos. */
  classification: 'si' | 'no' | 'dudoso' | 'erroneo' | null;
  validationResult: 'sin_cambios' | 'pago_recibido' | 'revision_manual' | null;
  validationRule: string | null;
  /** Facturas que cambiaron de estado por este email. */
  changes: { invoiceId: number; pointOfSale: number; number: number; to: string; reason: string | null }[];
  attachments: {
    filename: string;
    valid: boolean;
    classification: 'si' | 'no' | 'dudoso' | null;
    cuit: string | null;
    amount: string | null;
    error: string | null;
  }[];
}

/** Procesamiento de cada email recibido, por Message-ID (los no leídos todavía quedan "pendiente"). */
export function processingByMessageId(db: Db, messageIds: string[]): Map<string, EmailProcessing> {
  const result = new Map<string, EmailProcessing>();
  if (messageIds.length === 0) return result;

  const emails = db
    .select({
      id: receivedEmails.id,
      messageId: receivedEmails.messageId,
      clientId: receivedEmails.clientId,
      clientName: clients.businessName,
      notice: receivedEmails.notice,
      processedAt: receivedEmails.processedAt,
      classification: receivedEmails.classification,
      validationResult: receivedEmails.validationResult,
      validationRule: receivedEmails.validationRule,
    })
    .from(receivedEmails)
    .leftJoin(clients, eq(clients.id, receivedEmails.clientId))
    .where(inArray(receivedEmails.messageId, messageIds))
    .all();
  if (emails.length === 0) return result;
  const ids = emails.map((e) => e.id);

  const attachments = db
    .select()
    .from(receivedAttachments)
    .where(inArray(receivedAttachments.emailId, ids))
    .orderBy(asc(receivedAttachments.id))
    .all();
  const changes = db
    .select({ data: clientEvents.data, emailId: sql<number>`json_extract(${clientEvents.data}, '$.emailId')` })
    .from(clientEvents)
    .where(eq(clientEvents.type, 'cambio_estado_factura'))
    .orderBy(asc(clientEvents.id))
    .all()
    .filter((c) => ids.includes(c.emailId));

  for (const email of emails) {
    result.set(email.messageId, {
      status: !email.processedAt ? 'pendiente' : email.notice ? 'aviso' : 'procesado',
      clientId: email.clientId,
      clientName: email.clientName,
      processedAt: email.processedAt,
      classification: email.classification,
      validationResult: email.validationResult,
      validationRule: email.validationRule,
      changes: changes
        .filter((c) => c.emailId === email.id)
        .map((c) => {
          const d = c.data as { invoiceId: number; pointOfSale: number; number: number; to: string; reason: string | null };
          return { invoiceId: d.invoiceId, pointOfSale: d.pointOfSale, number: d.number, to: d.to, reason: d.reason };
        }),
      attachments: attachments
        .filter((a) => a.emailId === email.id)
        .map((a) => ({
          filename: a.filename,
          valid: a.valid,
          classification: a.classification,
          cuit: a.extractedCuit,
          amount: a.extractedAmount,
          error: a.processingError,
        })),
    });
  }
  return result;
}
