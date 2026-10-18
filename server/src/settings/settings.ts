import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

export type Settings = typeof settings.$inferSelect;

/** Configuración vigente. La primera vez crea la fila con los valores por defecto del PRD. */
export function getSettings(db: Pick<Db, 'select' | 'insert'>): Settings {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (row) return row;
  return db.insert(settings).values({ id: 1 }).onConflictDoNothing().returning().get()
    ?? db.select().from(settings).where(eq(settings.id, 1)).get()!;
}
