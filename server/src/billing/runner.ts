import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { billingPeriods } from '../db/schema.js';
import { getSettings } from '../settings/settings.js';
import { currentPeriod, isBillingDue } from './dates.js';
import { billableClientIds, runBillingProcess, type BillingDeps, type BillingSummary } from './process.js';

/** RF-60, RF-61: estado de la facturación de un período. */
export type BillingState = 'pendiente' | 'cancelada' | 'en_curso' | 'realizada';

export interface BillingStatus {
  period: string;
  state: BillingState;
  /** Hora de facturación del día 15, "HH:MM". */
  billingTime: string;
  /** Ya pasó el día 15 a la hora de facturación (RF-57). */
  due: boolean;
  /** Los procesos automáticos están activos (SCHEDULER_ENABLED). */
  schedulerEnabled: boolean;
  cancelledAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Usuario que ejecutó "Facturar ahora"; null si lo inició el agente o no empezó. */
  startedBy: number | null;
}

export class BillingStateError extends Error {}

/**
 * Corre el proceso de facturación de a una corrida por período, en segundo plano, y
 * resuelve el estado de cada período. Lo usan "Facturar ahora" y el scheduler.
 */
export class BillingRunner {
  private readonly running = new Map<string, Promise<BillingSummary>>();

  constructor(
    private readonly db: Db,
    private readonly makeDeps: () => BillingDeps,
    readonly now: () => Date = () => new Date(),
    private readonly schedulerEnabled = false,
  ) {}

  isRunning(period: string): boolean {
    return this.running.has(period);
  }

  /** Corrida en curso del período, si hay (para esperarla en los tests). */
  whenIdle(period: string): Promise<BillingSummary | undefined> {
    return this.running.get(period) ?? Promise.resolve(undefined);
  }

  status(period: string = currentPeriod(this.now())): BillingStatus {
    const row = this.db.select().from(billingPeriods).where(eq(billingPeriods.period, period)).get();
    const { billingTime } = getSettings(this.db);
    let state: BillingState = 'pendiente';
    if (row?.cancelledAt) state = 'cancelada';
    else if (this.isRunning(period) || (row?.startedAt && !row.finishedAt)) state = 'en_curso';
    else if (row?.finishedAt) state = 'realizada';
    return {
      period,
      state,
      billingTime,
      due: period === currentPeriod(this.now()) && isBillingDue(this.now(), billingTime),
      schedulerEnabled: this.schedulerEnabled,
      cancelledAt: row?.cancelledAt ?? null,
      startedAt: row?.startedAt ?? null,
      finishedAt: row?.finishedAt ?? null,
      startedBy: row?.startedBy ?? null,
    };
  }

  /**
   * Arranca (o retoma) el proceso del período sin esperar a que termine. Si ya está
   * corriendo, devuelve esa misma corrida.
   */
  start(period: string, startedBy: number | null): Promise<BillingSummary> {
    const current = this.running.get(period);
    if (current) return current;

    const run = runBillingProcess(this.makeDeps(), period, startedBy).finally(() => this.running.delete(period));
    this.running.set(period, run);
    run.catch((error) => console.error(`Falló el proceso de facturación de ${period}:`, error));
    return run;
  }

  /** RF-58 a RF-61: "Facturar ahora" del mes en curso, con las mismas reglas que el día 15. */
  runNow(userId: number): BillingStatus {
    const status = this.status();
    if (status.state === 'cancelada') throw new BillingStateError('La facturación del mes está cancelada.');
    if (status.state === 'en_curso') throw new BillingStateError('La facturación del mes está en curso.');
    if (status.state === 'realizada') throw new BillingStateError('La facturación del mes ya fue realizada.');
    // Una corrida sin nadie a quien facturar dejaría el mes marcado como facturado.
    if (!this.hasBillableClients(status.period)) {
      throw new BillingStateError('No hay clientes para facturar: ninguno está Activo con productos Activos asignados.');
    }
    void this.start(status.period, userId);
    return this.status();
  }

  /** RF-54: cancelar la facturación del mes en curso mientras no haya empezado. */
  cancel(userId: number): BillingStatus {
    const status = this.status();
    if (status.state === 'cancelada') throw new BillingStateError('La facturación del mes ya está cancelada.');
    if (status.state !== 'pendiente') {
      throw new BillingStateError('No se puede cancelar: el proceso de facturación del mes ya empezó.');
    }
    this.db
      .insert(billingPeriods)
      .values({ period: status.period, cancelledAt: this.now(), cancelledBy: userId })
      .onConflictDoUpdate({ target: billingPeriods.period, set: { cancelledAt: this.now(), cancelledBy: userId } })
      .run();
    return this.status();
  }

  /**
   * RF-56, RF-57: reactivar la facturación del mes en curso (un mes anterior ya no se
   * puede: esto opera siempre sobre el mes en curso). Si ya pasó la hora del día 15,
   * factura en el momento.
   */
  reactivate(): BillingStatus {
    const status = this.status();
    if (status.state !== 'cancelada') throw new BillingStateError('La facturación del mes no está cancelada.');
    this.db
      .update(billingPeriods)
      .set({ cancelledAt: null, cancelledBy: null })
      .where(eq(billingPeriods.period, status.period))
      .run();
    if (status.due && this.hasBillableClients(status.period)) void this.start(status.period, null);
    return this.status();
  }

  /** Si no hay clientes facturables, la corrida no arranca: el mes no queda marcado. */
  private hasBillableClients(period: string): boolean {
    return billableClientIds(this.db, period).length > 0;
  }

  /**
   * Revisión del agente (cada minuto): factura el mes en curso si ya llegó el día 15 a la
   * hora de facturación y no se hizo, no se canceló ni se ejecutó con "Facturar ahora"
   * (RF-51, RF-52, RF-55, RF-59); y retoma un proceso interrumpido (RF-53). Sin clientes
   * facturables no arranca, así un cliente cargado más tarde ese mes igual se factura.
   */
  tick(): void {
    const status = this.status();
    if (status.state === 'pendiente' && status.due && this.hasBillableClients(status.period)) {
      void this.start(status.period, null);
    }
    else if (status.state === 'en_curso' && !this.isRunning(status.period)) void this.start(status.period, null);
  }
}
