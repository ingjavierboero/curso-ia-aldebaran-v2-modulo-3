import { api } from './client';
import type { InvoiceStatus } from './invoices';

export interface ReceivedAttachment {
  id: number;
  emailId: number;
  filename: string;
  contentType: string;
  inline: boolean;
  valid: boolean;
  classification: 'si' | 'no' | 'dudoso' | null;
  cuit: string | null;
  amount: string | null;
  error: string | null;
}

export interface ReceivedEmail {
  id: number;
  from: string;
  fromName: string | null;
  subject: string;
  text: string;
  receivedAt: string;
  classification: 'si' | 'no' | 'dudoso' | 'erroneo' | null;
  attachments: ReceivedAttachment[];
}

export interface ReviewInvoice {
  id: number;
  clientId: number;
  clientName: string;
  clientCuit: string;
  period: string;
  pointOfSale: number;
  number: number;
  totalCents: number;
  paymentDueDate: string;
  status: Extract<InvoiceStatus, 'pago_recibido' | 'revision_manual'>;
  reviewReason: string | null;
  emails: ReceivedEmail[];
}

export type ProcessOperation = 'generacion_factura' | 'envio_factura' | 'envio_recordatorio' | 'revision_casilla';

export const OPERATION_LABELS: Record<ProcessOperation, string> = {
  generacion_factura: 'Generación de factura',
  envio_factura: 'Envío de factura',
  envio_recordatorio: 'Envío de recordatorio',
  revision_casilla: 'Revisión de la casilla',
};

export interface ProcessErrorRow {
  id: number;
  operation: ProcessOperation;
  clientId: number | null;
  clientName: string | null;
  period: string | null;
  invoiceId: number | null;
  invoicePointOfSale: number | null;
  invoiceNumber: number | null;
  attempts: number;
  lastError: string;
  createdAt: string;
}

export const listReviewInvoices = async () => (await api<{ invoices: ReviewInvoice[] }>('GET', '/review/invoices')).invoices;
export const listNotices = async () => (await api<{ notices: ReceivedEmail[] }>('GET', '/review/notices')).notices;
export const listProcessErrors = async () => (await api<{ errors: ProcessErrorRow[] }>('GET', '/review/errors')).errors;

export const receivedAttachmentUrl = (emailId: number, attachmentId: number) =>
  `/api/received-emails/${emailId}/attachments/${attachmentId}`;
