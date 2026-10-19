import { eq } from 'drizzle-orm';
import { recordClientEvent } from '../clients/events.js';
import type { Db } from '../db/index.js';
import { invoices, type InvoiceStatus } from '../db/schema.js';

export class InvoiceActionError extends Error {}

/** Desde qué estados se puede hacer cada acción de un usuario. */
const ALLOWED: Record<'pagada' | 'pendiente_pago', InvoiceStatus[]> = {
  // RF-143, RF-145 (interfaz de revisión) y RF-147 (listado de facturas).
  pagada: ['pago_recibido', 'revision_manual', 'pendiente_pago'],
  // RF-144, RF-146.
  pendiente_pago: ['pago_recibido', 'revision_manual'],
};

/**
 * Un usuario pasa una factura a Pagada o la devuelve a Pendiente de pago. Al salir de
 * Revisión manual deja de tener motivo (RF-140). Queda en el historial del cliente con el
 * usuario (AC-150).
 */
export function changeInvoiceStatus(db: Db, invoiceId: number, to: 'pagada' | 'pendiente_pago', userId: number, now: Date) {
  return db.transaction((tx) => {
    const invoice = tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    if (!invoice) throw new InvoiceActionError('La factura no existe.');
    if (!ALLOWED[to].includes(invoice.status)) {
      throw new InvoiceActionError(
        to === 'pagada'
          ? 'La factura ya está Pagada.'
          : 'Solo se puede devolver a Pendiente de pago una factura en Pago recibido o Revisión manual.',
      );
    }
    const updated = tx.update(invoices).set({ status: to, reviewReason: null }).where(eq(invoices.id, invoiceId)).returning().get();
    recordClientEvent(tx, invoice.clientId, 'cambio_estado_factura', userId, {
      invoiceId,
      pointOfSale: invoice.pointOfSale,
      number: invoice.number,
      period: invoice.period,
      from: invoice.status,
      to,
      reason: null,
      // RF-216: el motivo que tenía, que la factura deja de mostrar (RF-140).
      previousReason: invoice.reviewReason,
    }, now);
    return updated;
  });
}
