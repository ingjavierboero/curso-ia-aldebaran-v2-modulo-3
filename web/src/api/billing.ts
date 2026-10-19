import { api } from './client';

export type BillingState = 'pendiente' | 'cancelada' | 'en_curso' | 'realizada';

export interface BillingStatus {
  /** "YYYY-MM" */
  period: string;
  state: BillingState;
  /** Hora de facturación del día 15, "HH:MM". */
  billingTime: string;
  /** Ya pasó el día 15 a la hora de facturación. */
  due: boolean;
  /** Los procesos automáticos están activos (SCHEDULER_ENABLED). */
  schedulerEnabled: boolean;
  cancelledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  startedBy: number | null;
}

const call = async (method: string, path: string) => (await api<{ billing: BillingStatus }>(method, path)).billing;

export const getBillingStatus = () => call('GET', '/billing/current');
export const runBillingNow = () => call('POST', '/billing/run');
export const cancelBilling = () => call('POST', '/billing/cancel');
export const reactivateBilling = () => call('POST', '/billing/reactivate');
