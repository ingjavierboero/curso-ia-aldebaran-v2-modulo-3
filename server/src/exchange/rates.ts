import { desc } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { exchangeRates } from '../db/schema.js';
import { DOLARHOY_SOURCE } from './dolarhoy.js';

/** Lee la cotización vigente en centavos; tira si no puede leerla. */
export type RateReader = () => Promise<number>;

export interface ResolvedRate {
  /** Id del registro en exchange_rates. */
  id: number;
  rateCents: number;
  source: string;
  readAt: Date;
  /** true si no se pudo leer y se usa la última registrada (RF-67, banner de RF-69). */
  fallback: boolean;
  /** Motivo por el que no se pudo leer, cuando fallback es true. */
  readError?: string;
}

/**
 * Cotización para facturar en pesos un producto en dólares:
 * - lee dolarhoy.com y registra la lectura (RF-63, RF-65);
 * - si no puede, usa la de fecha de lectura más reciente (RF-66, RF-67);
 * - si no hay ninguna registrada, devuelve null: no se pueden facturar clientes con
 *   productos en dólares (RF-68).
 */
export async function resolveUsdRate(db: Db, read: RateReader, now: () => Date): Promise<ResolvedRate | null> {
  try {
    const rateCents = await read();
    const row = db
      .insert(exchangeRates)
      .values({ rateCents, source: DOLARHOY_SOURCE, readAt: now() })
      .returning()
      .get();
    return { ...row, fallback: false };
  } catch (error) {
    const last = db.select().from(exchangeRates).orderBy(desc(exchangeRates.readAt), desc(exchangeRates.id)).get();
    if (!last) return null;
    return { ...last, fallback: true, readError: error instanceof Error ? error.message : String(error) };
  }
}
