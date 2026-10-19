import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { processErrors } from '../db/schema.js';
import { resolveUsdRate, type ResolvedRate } from '../exchange/rates.js';
import { sendInvoiceEmail } from '../invoices/email.js';
import { getSettings } from '../settings/settings.js';
import type { OperationsDeps } from './deps.js';
import { generateInvoice } from './generate.js';
import { arcaMutex } from './mutex.js';
import { recordProcessError } from './process-errors.js';

export class ProcessErrorActionError extends Error {}

export interface RetryResult {
  ok: boolean;
  message: string;
}

function pendingError(db: Db, errorId: number) {
  const error = db.select().from(processErrors).where(eq(processErrors.id, errorId)).get();
  if (!error) throw new ProcessErrorActionError('El error de proceso no existe.');
  if (error.status !== 'pendiente') throw new ProcessErrorActionError('El error de proceso ya está Resuelto.');
  return error;
}

/** RF-180: un usuario marca un error de proceso como Resuelto sin reintentarlo (AC-191). */
export function resolveProcessError(db: Db, errorId: number, userId: number, now: Date) {
  pendingError(db, errorId);
  return db
    .update(processErrors)
    .set({ status: 'resuelto', resolvedAt: now, resolvedBy: userId })
    .where(eq(processErrors.id, errorId))
    .returning()
    .get();
}

/**
 * RF-176 a RF-179: reintento manual, con un único intento, de una generación de factura
 * (genera y, si se genera, la envía) o de un envío de factura (reenvía solo ese email).
 * Si sale bien, el error pasa a Resuelto; si no, sigue Pendiente con el nuevo mensaje
 * (AC-190). No se reintenta solo ni se registra un error nuevo por el reintento (RF-183).
 */
export async function retryProcessError(deps: OperationsDeps, errorId: number, userId: number): Promise<RetryResult> {
  const { db, now } = deps.billing;
  const error = pendingError(db, errorId);

  let message: string;
  try {
    if (error.operation === 'generacion_factura') {
      if (error.clientId === null || !error.period) throw new ProcessErrorActionError('El error no indica el cliente y el período.');
      message = await retryGeneration(deps, error.clientId, error.period);
    } else if (error.operation === 'envio_factura') {
      if (error.invoiceId === null) throw new ProcessErrorActionError('El error no indica la factura.');
      const sent = await sendInvoiceEmail(deps.invoiceEmail, error.invoiceId);
      message = sent ? 'Email de la factura reenviado.' : 'El cliente está Inactivo: no se le envían emails.';
    } else {
      throw new ProcessErrorActionError(
        error.operation === 'revision_casilla'
          ? 'La revisión de la casilla se reintenta sola en cada intervalo.'
          : 'Este error no se puede reintentar.',
      );
    }
  } catch (cause) {
    if (cause instanceof ProcessErrorActionError) throw cause;
    const lastError = cause instanceof Error ? cause.message : String(cause);
    db.update(processErrors).set({ attempts: error.attempts + 1, lastError }).where(eq(processErrors.id, errorId)).run();
    return { ok: false, message: lastError };
  }

  db.update(processErrors)
    .set({ status: 'resuelto', resolvedAt: now(), resolvedBy: userId, attempts: error.attempts + 1 })
    .where(eq(processErrors.id, errorId))
    .run();
  return { ok: true, message };
}

/** RF-177: genera la factura con un único intento y, si se genera, la envía por email. */
async function retryGeneration(deps: OperationsDeps, clientId: number, period: string): Promise<string> {
  const { db, arca, readRate, now } = deps.billing;
  let rate: ResolvedRate | null | undefined;
  const result = await generateInvoice(
    {
      db,
      arca,
      now,
      pointOfSale: getSettings(db).pointOfSale,
      getRate: async () => (rate === undefined ? (rate = await resolveUsdRate(db, readRate, now)) : rate),
      arcaMutex,
    },
    clientId,
    period,
  );
  if (result.status === 'not_billable') {
    return 'El cliente ya no es facturable (Inactivo o sin productos Activos): no se generó la factura.';
  }
  if (result.status === 'already_invoiced') return 'La factura ya estaba generada.';

  const invoice = result.invoice;
  try {
    await sendInvoiceEmail(deps.invoiceEmail, invoice.id);
    return `Factura ${invoice.pointOfSale}-${invoice.number} generada y enviada.`;
  } catch (cause) {
    // La factura ya existe: el envío fallido queda como su propio error, para reenviarlo.
    recordProcessError(db, {
      operation: 'envio_factura',
      clientId,
      period,
      invoiceId: invoice.id,
      attempts: 1,
      lastError: cause instanceof Error ? cause.message : String(cause),
    }, now());
    return `Factura ${invoice.pointOfSale}-${invoice.number} generada, pero no se pudo enviar el email: quedó un error de envío para reintentarlo.`;
  }
}
