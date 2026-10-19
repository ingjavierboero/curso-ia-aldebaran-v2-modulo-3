import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../app.js';
import type { Db } from '../db/index.js';
import { clients, invoiceEmails, invoices, processErrors, receivedAttachments, receivedEmails } from '../db/schema.js';

/** Emails recibidos con sus adjuntos (sin el contenido) y el resultado de cada uno. */
function emailsWithAttachments(db: Db, emailIds: number[]) {
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

/** Interfaz de revisión (RF-141, RF-142, RF-175). Todos los perfiles la ven. */
export function reviewRoutes(ctx: AppContext): Router {
  const router = Router();

  /**
   * RF-141: facturas en Pago recibido o Revisión manual, con los emails asociados, sus
   * adjuntos, la clasificación del LLM de cada uno, el CUIT y el monto extraídos y el
   * motivo de la Revisión manual.
   */
  router.get('/invoices', (_req, res) => {
    const rows = ctx.db
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        clientName: clients.businessName,
        clientCuit: clients.cuit,
        period: invoices.period,
        pointOfSale: invoices.pointOfSale,
        number: invoices.number,
        totalCents: invoices.totalCents,
        paymentDueDate: invoices.paymentDueDate,
        status: invoices.status,
        reviewReason: invoices.reviewReason,
        updatedAt: invoices.updatedAt,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(inArray(invoices.status, ['pago_recibido', 'revision_manual']))
      .orderBy(asc(invoices.status), asc(clients.businessName), asc(invoices.period))
      .all();

    const links = rows.length
      ? ctx.db.select().from(invoiceEmails).where(inArray(invoiceEmails.invoiceId, rows.map((r) => r.id))).all()
      : [];
    const emails = emailsWithAttachments(ctx.db, [...new Set(links.map((l) => l.emailId))]);

    res.json({
      invoices: rows.map((invoice) => {
        const ids = new Set(links.filter((l) => l.invoiceId === invoice.id).map((l) => l.emailId));
        return { ...invoice, emails: emails.filter((e) => ids.has(e.id)) };
      }),
    });
  });

  // RF-142: avisos Pendientes con remitente, asunto, fecha y adjuntos.
  router.get('/notices', (_req, res) => {
    const ids = ctx.db
      .select({ id: receivedEmails.id })
      .from(receivedEmails)
      .where(eq(receivedEmails.notice, 'pendiente'))
      .orderBy(desc(receivedEmails.receivedAt))
      .all()
      .map((r) => r.id);
    res.json({ notices: emailsWithAttachments(ctx.db, ids).reverse() });
  });

  // RF-175: errores de proceso Pendientes con sus datos.
  router.get('/errors', (_req, res) => {
    const rows = ctx.db
      .select({
        id: processErrors.id,
        operation: processErrors.operation,
        clientId: processErrors.clientId,
        clientName: clients.businessName,
        period: processErrors.period,
        invoiceId: processErrors.invoiceId,
        invoicePointOfSale: invoices.pointOfSale,
        invoiceNumber: invoices.number,
        attempts: processErrors.attempts,
        lastError: processErrors.lastError,
        createdAt: processErrors.createdAt,
      })
      .from(processErrors)
      .leftJoin(clients, eq(clients.id, processErrors.clientId))
      .leftJoin(invoices, eq(invoices.id, processErrors.invoiceId))
      .where(eq(processErrors.status, 'pendiente'))
      .orderBy(desc(processErrors.createdAt))
      .all();
    res.json({ errors: rows });
  });

  return router;
}

/** Descarga de un adjunto de un email recibido (cualquier perfil, RF-141, RF-142). */
export function receivedEmailRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/:emailId/attachments/:attachmentId', (req, res) => {
    const attachment = ctx.db
      .select()
      .from(receivedAttachments)
      .where(and(eq(receivedAttachments.id, Number(req.params.attachmentId)), eq(receivedAttachments.emailId, Number(req.params.emailId))))
      .get();
    if (!attachment) {
      res.status(404).json({ error: 'El adjunto no existe.' });
      return;
    }
    res.type(attachment.contentType || 'application/octet-stream')
      .setHeader('content-disposition', `inline; filename="${encodeURIComponent(attachment.filename)}"`)
      .send(attachment.content);
  });
  return router;
}
