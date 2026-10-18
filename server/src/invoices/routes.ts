import { asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../app.js';
import { invoiceItems, invoices } from '../db/schema.js';
import { getSettings } from '../settings/settings.js';
import { formatVoucherNumber, renderInvoicePdf } from './pdf.js';

export function invoiceRoutes(ctx: AppContext): Router {
  const router = Router();

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
