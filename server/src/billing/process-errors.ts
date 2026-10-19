import { recordClientEvent } from '../clients/events.js';
import type { Db } from '../db/index.js';
import { processErrors, type ProcessOperation } from '../db/schema.js';

/** RF-174: registra un error de proceso Pendiente y, si tiene cliente, lo suma a su historial. */
export function recordProcessError(
  db: Db,
  error: {
    operation: ProcessOperation;
    attempts: number;
    lastError: string;
    clientId?: number;
    period?: string;
    invoiceId?: number;
  },
  /** Momento del error; por defecto, ahora. */
  now?: Date,
) {
  return db.transaction((tx) => {
    const row = tx.insert(processErrors).values({ ...error, ...(now ? { createdAt: now } : {}) }).returning().get();
    if (error.clientId !== undefined) {
      recordClientEvent(tx, error.clientId, 'error_proceso', null, {
        processErrorId: row.id,
        operation: error.operation,
        period: error.period,
        invoiceId: error.invoiceId,
        attempts: error.attempts,
        lastError: error.lastError,
      }, now);
    }
    return row;
  });
}
