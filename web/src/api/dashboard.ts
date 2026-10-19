import { api } from './client';
import type { ClientStatus } from './clients';

export interface Debtor {
  id: number;
  businessName: string;
  status: ClientStatus;
  debtCents: number;
  owedCount: number;
  /** Tiene al menos una factura en Revisión manual. */
  inReview: boolean;
  /** Vencimiento más antiguo entre las facturas adeudadas, "YYYY-MM-DD". */
  oldestDueDate: string;
}

export interface Dashboard {
  debtors: Debtor[];
  /** Errores de proceso Pendientes (RF-181). */
  pendingErrors: number;
}

export const getDashboard = () => api<Dashboard>('GET', '/dashboard');
