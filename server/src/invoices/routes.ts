import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { currentUser, requireRole } from '../auth/middleware.js';
import { invoiceHistory } from '../clients/history.js';
import { invoiceEmails } from '../db/schema.js';
import { emailsWithAttachments } from '../review/emails.js';
import { changeInvoiceStatus, InvoiceActionError } from './actions.js';
import { INVOICE_STATUSES, invoiceItems, invoices } from '../db/schema.js';
import { getSettings } from '../settings/settings.js';
import { formatVoucherNumber, renderInvoicePdf } from './pdf.js';

const listQuerySchema = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export function invoiceRoutes(ctx: AppContext): Router {
  const router = Router();

  // RF-160, RF-168: listado con filtros por estado, cliente y período.
  router.get('/', (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'Filtro inválido.' });
      return;
    }
    const { status, clientId, period } = query.data;
    const conditions: SQL[] = [];
    if (status) conditions.push(eq(invoices.status, status));
    if (clientId) conditions.push(eq(invoices.clientId, clientId));
    if (period) conditions.push(eq(invoices.period, period));

    const rows = ctx.db
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        clientBusinessName: invoices.clientBusinessName,
        period: invoices.period,
        pointOfSale: invoices.pointOfSale,
        number: invoices.number,
        issueDate: invoices.issueDate,
        paymentDueDate: invoices.paymentDueDate,
        totalCents: invoices.totalCents,
        status: invoices.status,
        reviewReason: invoices.reviewReason,
      })
      .from(invoices)
      .where(and(...conditions))
      .orderBy(desc(invoices.period), desc(invoices.pointOfSale), desc(invoices.number))
      .all();
    res.json({ invoices: rows });
  });

  // RF-217: detalle de la factura con sus cuotas, sus cambios de estado y sus emails.
  router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const invoice = Number.isInteger(id) && id > 0 ? ctx.db.select().from(invoices).where(eq(invoices.id, id)).get() : undefined;
    if (!invoice) {
      res.status(404).json({ error: 'La factura no existe.' });
      return;
    }
    const items = ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(asc(invoiceItems.id)).all();
    const emailIds = ctx.db.select({ id: invoiceEmails.emailId }).from(invoiceEmails).where(eq(invoiceEmails.invoiceId, id)).all().map((r) => r.id);
    res.json({ invoice, items, history: invoiceHistory(ctx.db, id), emails: emailsWithAttachments(ctx.db, emailIds) });
  });

  // RF-143, RF-145, RF-147: un Admin o Editor pasa una factura a Pagada.
  // RF-144, RF-146: o la devuelve a Pendiente de pago.
  for (const [path, to] of [['mark-paid', 'pagada'], ['return-to-pending', 'pendiente_pago']] as const) {
    router.post(`/:id/${path}`, requireRole('admin', 'editor'), (req, res) => {
      try {
        res.json({ invoice: changeInvoiceStatus(ctx.db, Number(req.params.id), to, currentUser(req).id, ctx.now()) });
      } catch (error) {
        if (!(error instanceof InvoiceActionError)) throw error;
        res.status(error.message === 'La factura no existe.' ? 404 : 409).json({ error: error.message });
      }
    });
  }

  // RF-162: cualquier perfil descarga el PDF de una factura emitida.
  router.get('/:id/pdf', async (req, res) => {
    const id = Number(req.params.id);
    const invoice = Number.isInteger(id) && id > 0
      ? ctx.db.select().from(invoices).where(eq(invoices.id, id)).get()
      : undefined;
    if (!invoice) {
      res.status(404).json({ error: 'La factura no existe.' });
      return;
    }

    const items = ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(asc(invoiceItems.id)).all();
    const pdf = await renderInvoicePdf(invoice, items, {
      issuerCuit: ctx.issuerCuit,
      settings: getSettings(ctx.db),
      mockMode: ctx.mockMode,
    });

    const filename = `factura-c-${formatVoucherNumber(invoice.pointOfSale, invoice.number)}.pdf`;
    res.type('application/pdf').setHeader('content-disposition', `inline; filename="${filename}"`).send(pdf);
  });

  return router;
}
