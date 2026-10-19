import { and, eq, exists, sql } from 'drizzle-orm';
import type { ArcaClient } from '../arca/index.js';
import type { Db } from '../db/index.js';
import { billingPeriods, clientProducts, clients, processErrors, products } from '../db/schema.js';
import { resolveUsdRate, type RateReader, type ResolvedRate } from '../exchange/rates.js';
import { getSettings } from '../settings/settings.js';
import { generateInvoice, type Invoice } from './generate.js';
import { arcaMutex } from './mutex.js';
import { recordProcessError } from './process-errors.js';

export interface BillingDeps {
  db: Db;
  arca: ArcaClient;
  readRate: RateReader;
  now: () => Date;
  /** Espera entre reintentos; inyectable para los tests. */
  sleep: (ms: number) => Promise<void>;
  /** Se llama con cada factura generada (el paso de envío por email se engancha acá). */
  onInvoiceGenerated?: (invoice: Invoice) => Promise<void>;
}

export interface BillingSummary {
  period: string;
  generated: number;
  failed: number;
  /** Ya facturados en una corrida anterior o que dejaron de ser facturables. */
  skipped: number;
}

export class BillingPeriodError extends Error {}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Proceso de facturación de un período (RF-51 a RF-53, RF-58, RF-59): factura a cada
 * cliente facturable que todavía no tenga la factura del período. Se puede volver a
 * ejecutar sin duplicar facturas, así que también sirve para retomar uno interrumpido.
 */
export async function runBillingProcess(
  deps: BillingDeps,
  period: string,
  startedBy: number | null = null,
): Promise<BillingSummary> {
  const { db, now } = deps;

  const state = db.select().from(billingPeriods).where(eq(billingPeriods.period, period)).get();
  // RF-55: un período cancelado no se factura.
  if (state?.cancelledAt) throw new BillingPeriodError(`La facturación del período ${period} está cancelada.`);
  if (!state) {
    db.insert(billingPeriods).values({ period, startedAt: now(), startedBy }).run();
  } else if (!state.startedAt) {
    db.update(billingPeriods).set({ startedAt: now(), startedBy }).where(eq(billingPeriods.period, period)).run();
  }

  const config = getSettings(db);
  const maxAttempts = 1 + config.retryCount;
  const waitMs = config.retryWaitMinutes * 60_000;

  // Una sola lectura de dolarhoy.com por corrida: todas las facturas usan la misma
  // cotización. Si no hay ninguna, se vuelve a intentar en el siguiente reintento.
  let rate: ResolvedRate | null = null;
  let pendingRate: Promise<ResolvedRate | null> | null = null;
  const getRate = async () => {
    if (rate) return rate;
    pendingRate ??= resolveUsdRate(db, deps.readRate, now).finally(() => (pendingRate = null));
    rate = await pendingRate;
    return rate;
  };

  const generateDeps = { db, arca: deps.arca, now, pointOfSale: config.pointOfSale, getRate, arcaMutex };
  const summary: BillingSummary = { period, generated: 0, failed: 0, skipped: 0 };

  // RF-85, RF-87: cada cliente sigue su propio ritmo; los reintentos de uno no demoran a otro.
  await Promise.all(
    billableClientIds(db, period).map(async (clientId) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let result: Awaited<ReturnType<typeof generateInvoice>>;
        try {
          result = await generateInvoice(generateDeps, clientId, period);
        } catch (error) {
          if (attempt < maxAttempts) {
            await deps.sleep(waitMs);
            continue;
          }
          // RF-174: agotados los reintentos, queda un error de proceso Pendiente.
          summary.failed++;
          recordProcessError(db, {
            operation: 'generacion_factura',
            clientId,
            period,
            attempts: attempt,
            lastError: error instanceof Error ? error.message : String(error),
          }, now());
          return;
        }

        if (result.status !== 'generated') {
          summary.skipped++;
          return;
        }
        summary.generated++;
        // RF-85, RF-86: el envío arranca apenas se genera y sus fallas no regeneran la factura.
        try {
          await deps.onInvoiceGenerated?.(result.invoice);
        } catch (error) {
          console.error(`Error después de generar la factura ${result.invoice.id}:`, error);
        }
        return;
      }
    }),
  );

  // RF-61: se intentó facturar a todos los clientes facturables.
  db.update(billingPeriods).set({ finishedAt: now() }).where(eq(billingPeriods.period, period)).run();
  return summary;
}

/**
 * RF-51, RF-94, RF-95: clientes Activos con al menos un producto Activo asignado. Deja
 * afuera los que ya tienen un error de generación Pendiente del período: se intentaron
 * en una corrida anterior y se reintentan a mano (RF-176).
 */
export function billableClientIds(db: Db, period: string): number[] {
  return db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.status, 'activo'),
        exists(
          db
            .select({ one: sql`1` })
            .from(clientProducts)
            .innerJoin(products, eq(products.id, clientProducts.productId))
            .where(and(eq(clientProducts.clientId, clients.id), eq(products.status, 'activo'))),
        ),
        sql`not exists (
          select 1 from ${processErrors}
          where ${processErrors.clientId} = ${clients.id}
            and ${processErrors.period} = ${period}
            and ${processErrors.operation} = 'generacion_factura'
            and ${processErrors.status} = 'pendiente'
        )`,
      ),
    )
    .orderBy(clients.id)
    .all()
    .map((row) => row.id);
}
