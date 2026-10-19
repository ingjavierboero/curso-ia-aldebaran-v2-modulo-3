import { and, eq } from 'drizzle-orm';
import { recordProcessError } from '../billing/process-errors.js';
import type { Db } from '../db/index.js';
import { processErrors } from '../db/schema.js';
import { getSettings } from '../settings/settings.js';
import { runMailboxCheck, type MailboxCheckDeps, type MailboxCheckResult } from './check.js';

/**
 * Revisión periódica de la casilla (RF-99 a RF-106). La llama el scheduler cada minuto;
 * decide si corresponde revisar y registra o resuelve el error de proceso de la casilla.
 */
export class MailboxRunner {
  private running: Promise<MailboxCheckResult | null> | null = null;
  /** Inicio de la última revisión (exitosa o no): el intervalo se cuenta desde acá (RF-101). */
  private lastStartedAt: Date | null = null;

  constructor(
    private readonly db: Db,
    private readonly makeDeps: () => MailboxCheckDeps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  isRunning(): boolean {
    return this.running !== null;
  }

  /** Revisión en curso, si hay (para esperarla en los tests). */
  whenIdle(): Promise<MailboxCheckResult | null> {
    return this.running ?? Promise.resolve(null);
  }

  /**
   * RF-99 a RF-102: revisa si nunca revisó o si ya pasó el intervalo configurado desde el
   * inicio de la anterior. Si la anterior sigue en curso, espera a que termine: la próxima
   * revisión del scheduler (al minuto siguiente) arranca la que corresponda.
   */
  tick(): void {
    if (this.running) return;
    const intervalMs = getSettings(this.db).mailboxIntervalMinutes * 60_000;
    if (this.lastStartedAt && this.now().getTime() - this.lastStartedAt.getTime() < intervalMs) return;
    void this.check();
  }

  /** Una revisión ahora (si no hay otra en curso). Nunca tira: los errores quedan registrados. */
  check(): Promise<MailboxCheckResult | null> {
    if (this.running) return this.running;
    this.lastStartedAt = this.now();
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<MailboxCheckResult | null> {
    try {
      const result = await runMailboxCheck(this.makeDeps());
      this.resolvePendingError();
      return result;
    } catch (error) {
      this.recordError(error);
      return null;
    }
  }

  /** RF-103: un único error de proceso Pendiente de revisión de la casilla. */
  private recordError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const pending = this.pendingError();
    if (pending) {
      // Ya hay uno: se actualizan los intentos y el último mensaje, sin crear otro.
      this.db
        .update(processErrors)
        .set({ attempts: pending.attempts + 1, lastError: message })
        .where(eq(processErrors.id, pending.id))
        .run();
      return;
    }
    recordProcessError(this.db, { operation: 'revision_casilla', attempts: 1, lastError: message }, this.now());
  }

  /** RF-106: cuando la casilla vuelve a estar disponible, el error pasa a Resuelto. */
  private resolvePendingError(): void {
    const pending = this.pendingError();
    if (!pending) return;
    this.db.update(processErrors).set({ status: 'resuelto', resolvedAt: this.now() }).where(eq(processErrors.id, pending.id)).run();
  }

  private pendingError() {
    return this.db
      .select()
      .from(processErrors)
      .where(and(eq(processErrors.operation, 'revision_casilla'), eq(processErrors.status, 'pendiente')))
      .get();
  }
}
