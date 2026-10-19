import type { Db } from '../db/index.js';
import { clientEvents, type ClientEventType } from '../db/schema.js';

/**
 * Registra un evento en el historial del cliente (RF-163). userId es null cuando lo
 * originó el agente. Acepta una transacción para que el evento quede junto al cambio.
 */
export function recordClientEvent(
  db: Pick<Db, 'insert'>,
  clientId: number,
  type: ClientEventType,
  userId: number | null,
  data: Record<string, unknown> | null,
  /** Momento del evento; por defecto, ahora. */
  createdAt?: Date,
): void {
  db.insert(clientEvents).values({ clientId, type, userId, data, ...(createdAt ? { createdAt } : {}) }).run();
}
