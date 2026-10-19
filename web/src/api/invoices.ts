import { api } from './client';

export type InvoiceStatus = 'pendiente_pago' | 'pago_recibido' | 'revision_manual' | 'pagada';

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  pendiente_pago: 'Pendiente de pago',
  pago_recibido: 'Pago recibido',
  revision_manual: 'Revisión manual',
  pagada: 'Pagada',
};

export const INVOICE_STATUS_COLORS: Record<InvoiceStatus, string> = {
  pendiente_pago: 'gold',
  pago_recibido: 'blue',
  revision_manual: 'volcano',
  pagada: 'green',
};

export interface InvoiceRow {
  id: number;
  clientId: number;
  clientBusinessName: string;
  /** "YYYY-MM" */
  period: string;
  pointOfSale: number;
  number: number;
  issueDate: string;
  paymentDueDate: string;
  totalCents: number;
  status: InvoiceStatus;
  reviewReason: string | null;
}

export interface InvoiceFilters {
  status?: InvoiceStatus;
  clientId?: number;
  period?: string;
}

export async function listInvoices(filters: InvoiceFilters = {}): Promise<InvoiceRow[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.clientId) params.set('clientId', String(filters.clientId));
  if (filters.period) params.set('period', filters.period);
  const query = params.size > 0 ? `?${params}` : '';
  return (await api<{ invoices: InvoiceRow[] }>('GET', `/invoices${query}`)).invoices;
}

/** URL del PDF; la sesión viaja en la cookie. */
export const invoicePdfUrl = (id: number) => `/api/invoices/${id}/pdf`;

/** "00003-00000042". */
export const formatVoucherNumber = (pointOfSale: number, number: number) =>
  `${String(pointOfSale).padStart(5, '0')}-${String(number).padStart(8, '0')}`;

/** RF-143 a RF-147: un Admin o Editor pasa la factura a Pagada. */
export async function markInvoicePaid(id: number): Promise<void> {
  await api('POST', `/invoices/${id}/mark-paid`);
}

/** RF-144, RF-146: un Admin o Editor la devuelve a Pendiente de pago. */
export async function returnInvoiceToPending(id: number): Promise<void> {
  await api('POST', `/invoices/${id}/return-to-pending`);
}
