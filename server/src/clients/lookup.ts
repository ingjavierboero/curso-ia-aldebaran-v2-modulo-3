import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { Db } from '../db/index.js';
import { clients } from '../db/schema.js';

/** Busca el cliente de req.params.id; si no existe responde 404 y devuelve undefined. */
export function findClient(db: Db, req: Request, res: Response) {
  const id = Number(req.params.id);
  const client =
    Number.isInteger(id) && id > 0
      ? db.select().from(clients).where(eq(clients.id, id)).get()
      : undefined;
  if (!client) res.status(404).json({ error: 'El cliente no existe.' });
  return client;
}
