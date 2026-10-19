import cron, { type ScheduledTask } from 'node-cron';
import type { BillingRunner } from '../billing/runner.js';
import { TIMEZONE } from '../config.js';
import type { MailboxRunner } from '../payments/runner.js';

/**
 * Procesos automáticos del agente con node-cron, en hora de Argentina (RNF-12). Cada
 * minuto revisa si corresponde facturar y si corresponde revisar la casilla; los valores
 * configurables (hora de facturación, intervalo de la casilla) se leen en cada revisión,
 * así un cambio de configuración vale sin reiniciar (AC-61, AC-93). Al arrancar revisa en
 * el momento, para facturar y leer la casilla apenas el sistema vuelve (RF-52, AC-53).
 */
export function startScheduler(billing: BillingRunner, mailbox: MailboxRunner): { stop: () => void } {
  const safely = (name: string, job: () => void) => () => {
    try {
      job();
    } catch (error) {
      console.error(`Error en la revisión de ${name}:`, error);
    }
  };
  const billingTick = safely('facturación', () => billing.tick());
  const mailboxTick = safely('la casilla', () => mailbox.tick());

  const tasks: ScheduledTask[] = [
    cron.schedule('* * * * *', billingTick, { timezone: TIMEZONE, name: 'facturacion', noOverlap: true }),
    cron.schedule('* * * * *', mailboxTick, { timezone: TIMEZONE, name: 'casilla', noOverlap: true }),
  ];
  billingTick();
  mailboxTick();

  return {
    stop: () => {
      for (const task of tasks) void task.stop();
    },
  };
}
