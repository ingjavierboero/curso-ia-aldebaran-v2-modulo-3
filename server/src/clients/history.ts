import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { clientEvents, users } from '../db/schema.js';

export interface HistoryEvent {
  id: number;
  type: string;
  data: Record<string, unknown> | null;
  createdAt: Date;
  /** Usuario que lo originó; null si lo originó el agente. */
  userId: number | null;
  userName: string | null;
}

const columns = {
  id: clientEvents.id,
  type: clientEvents.type,
  data: clientEvents.data,
  createdAt: clientEvents.createdAt,
  userId: clientEvents.userId,
  userName: users.name,
};

/**
 * RF-163: historial del cliente en orden cronológico, con el usuario que originó cada
 * evento. El nombre del usuario lo ven todos los perfiles (definición de "Datos de usuarios").
 */
export function clientHistory(db: Db, clientId: number): HistoryEvent[] {
  return db
    .select(columns)
    .from(clientEvents)
    .leftJoin(users, eq(users.id, clientEvents.userId))
    .where(eq(clientEvents.clientId, clientId))
    .orderBy(asc(clientEvents.createdAt), asc(clientEvents.id))
    .all();
}

/** RF-217: eventos de una factura (generación, envíos, cambios de estado y errores). */
export function invoiceHistory(db: Db, invoiceId: number): HistoryEvent[] {
  return db
    .select(columns)
    .from(clientEvents)
    .leftJoin(users, eq(users.id, clientEvents.userId))
    .where(sql`json_extract(${clientEvents.data}, '$.invoiceId') = ${invoiceId}`)
    .orderBy(asc(clientEvents.createdAt), asc(clientEvents.id))
    .all();
}
