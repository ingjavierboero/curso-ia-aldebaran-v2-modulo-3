import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../app.js';
import { currentUser, requireRole } from '../auth/middleware.js';
import { ProcessErrorActionError, resolveProcessError, retryProcessError } from '../billing/retry-error.js';
import type { Db } from '../db/index.js';
import { z } from 'zod';
import { emailsWithAttachments } from './emails.js';
import { clientEvents, clients, invoiceEmails, invoices, processErrors, receivedAttachments, receivedEmails, users } from '../db/schema.js';

const resolvedQuerySchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Interfaz de revisión (RF-141, RF-142, RF-175, RF-216). Todos los perfiles la ven. */
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

  /**
   * RF-216: decisiones de los usuarios sobre pagos informados (facturas que pasaron de
   * Pago recibido o Revisión manual a Pagada o Pendiente de pago), de la más reciente a
   * la más antigua, con los emails que la factura tenía asociados al momento de decidir.
   */
  router.get('/resolved', (req, res) => {
    const query = resolvedQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'Filtro inválido.' });
      return;
    }
    const { clientId, from, to } = query.data;
    const conditions: SQL[] = [
      eq(clientEvents.type, 'cambio_estado_factura'),
      isNotNull(clientEvents.userId),
      sql`json_extract(${clientEvents.data}, '$.from') in ('pago_recibido', 'revision_manual')`,
      sql`json_extract(${clientEvents.data}, '$.to') in ('pagada', 'pendiente_pago')`,
    ];
    if (clientId) conditions.push(eq(clientEvents.clientId, clientId));
    // Días completos en hora de Argentina (sin horario de verano: siempre -03:00).
    if (from) conditions.push(gte(clientEvents.createdAt, new Date(`${from}T00:00:00-03:00`)));
    if (to) conditions.push(lt(clientEvents.createdAt, new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 86_400_000)));

    const decisions = ctx.db
      .select({
        id: clientEvents.id,
        decidedAt: clientEvents.createdAt,
        data: clientEvents.data,
        userName: users.name,
        clientId: clientEvents.clientId,
        clientName: clients.businessName,
      })
      .from(clientEvents)
      .innerJoin(clients, eq(clients.id, clientEvents.clientId))
      .leftJoin(users, eq(users.id, clientEvents.userId))
      .where(and(...conditions))
      .orderBy(desc(clientEvents.createdAt), desc(clientEvents.id))
      .limit(500)
      .all();

    const invoiceIds = [...new Set(decisions.map((d) => (d.data as { invoiceId: number }).invoiceId))];
    const invoiceRows = invoiceIds.length
      ? ctx.db
          .select({ id: invoices.id, period: invoices.period, pointOfSale: invoices.pointOfSale, number: invoices.number, totalCents: invoices.totalCents, status: invoices.status })
          .from(invoices)
          .where(inArray(invoices.id, invoiceIds))
          .all()
      : [];
    const links = invoiceIds.length ? ctx.db.select().from(invoiceEmails).where(inArray(invoiceEmails.invoiceId, invoiceIds)).all() : [];
    const emails = emailsWithAttachments(ctx.db, [...new Set(links.map((l) => l.emailId))]);

    res.json({
      resolved: decisions.map((d) => {
        const data = d.data as { invoiceId: number; from: string; to: string; previousReason?: string | null };
        const invoice = invoiceRows.find((i) => i.id === data.invoiceId);
        const linked = new Set(links.filter((l) => l.invoiceId === data.invoiceId).map((l) => l.emailId));
        return {
          id: d.id,
          decidedAt: d.decidedAt,
          decision: data.to,
          previousStatus: data.from,
          previousReason: data.previousReason ?? null,
          userName: d.userName,
          clientId: d.clientId,
          clientName: d.clientName,
          invoice,
          // Los comprobantes que había hasta la decisión, no los que llegaron después.
          emails: emails.filter((e) => linked.has(e.id) && e.receivedAt <= d.decidedAt),
        };
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

  const canEdit = requireRole('admin', 'editor');

  // RF-148: un Admin o Editor marca un aviso como Revisado, con quién lo hizo (AC-153).
  router.post('/notices/:id/reviewed', canEdit, (req, res) => {
    const notice = ctx.db
      .update(receivedEmails)
      .set({ notice: 'revisado', noticeReviewedAt: ctx.now(), noticeReviewedBy: currentUser(req).id })
      .where(and(eq(receivedEmails.id, Number(req.params.id)), eq(receivedEmails.notice, 'pendiente')))
      .returning({ id: receivedEmails.id })
      .get();
    if (!notice) {
      res.status(404).json({ error: 'El aviso no existe o ya está Revisado.' });
      return;
    }
    res.json({ notice });
  });

  // RF-180: marcar un error de proceso como Resuelto sin reintentarlo (AC-191).
  router.post('/errors/:id/resolve', canEdit, (req, res) => {
    try {
      res.json({ error: resolveProcessError(ctx.db, Number(req.params.id), currentUser(req).id, ctx.now()) });
    } catch (error) {
      if (!(error instanceof ProcessErrorActionError)) throw error;
      res.status(409).json({ error: error.message });
    }
  });

  // RF-176 a RF-179: reintento manual con un único intento.
  router.post('/errors/:id/retry', canEdit, async (req, res) => {
    try {
      const result = await retryProcessError(ctx.operations(), Number(req.params.id), currentUser(req).id);
      // RF-182: si falla, el usuario ve el error; el error de proceso sigue Pendiente.
      res.status(result.ok ? 200 : 502).json(result.ok ? { message: result.message } : { error: result.message });
    } catch (error) {
      if (!(error instanceof ProcessErrorActionError)) throw error;
      res.status(409).json({ error: error.message });
    }
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
