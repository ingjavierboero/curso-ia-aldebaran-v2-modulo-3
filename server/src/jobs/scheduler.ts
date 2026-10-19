import cron, { type ScheduledTask } from 'node-cron';
import type { BillingRunner } from '../billing/runner.js';
import { TIMEZONE } from '../config.js';

/**
 * Procesos automáticos del agente con node-cron, en hora de Argentina (RNF-12). Revisa
 * cada minuto si corresponde facturar; la hora configurable se evalúa en cada revisión,
 * así un cambio de configuración vale sin reiniciar (AC-61). Al arrancar revisa en el
 * momento, para facturar apenas el sistema vuelve a funcionar (RF-52, AC-53).
 */
export function startScheduler(billing: BillingRunner): { stop: () => void } {
  const tick = () => {
    try {
      billing.tick();
    } catch (error) {
      console.error('Error en la revisión del scheduler:', error);
    }
  };

  const tasks: ScheduledTask[] = [cron.schedule('* * * * *', tick, { timezone: TIMEZONE, name: 'facturacion', noOverlap: true })];
  tick();

  return {
    stop: () => {
      for (const task of tasks) void task.stop();
    },
  };
}
