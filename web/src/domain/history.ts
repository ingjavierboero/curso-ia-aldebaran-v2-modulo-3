import { IVA_CONDITIONS } from '../api/clients';
import { formatVoucherNumber, INVOICE_STATUS_LABELS, type InvoiceStatus } from '../api/invoices';
import { OPERATION_LABELS, type ProcessOperation } from '../api/review';
import dayjs from 'dayjs';
import { formatMoney } from './money';

export interface HistoryEvent {
  id: number;
  type: string;
  data: Record<string, unknown> | null;
  createdAt: string;
  userId: number | null;
  userName: string | null;
}

export interface EventDescription {
  title: string;
  /** Líneas de detalle. */
  details: string[];
  /** Color del punto en la línea de tiempo. */
  color: 'blue' | 'green' | 'red' | 'gray' | 'orange';
}

const FIELD_LABELS: Record<string, string> = {
  businessName: 'Razón social',
  cuit: 'CUIT',
  address: 'Domicilio',
  billingEmail: 'Email de facturación',
  ivaCondition: 'Condición frente al IVA',
};
const CLASSIFICATIONS: Record<string, string> = {
  si: 'comprobante ("si")',
  no: 'no es comprobante ("no")',
  dudoso: 'dudoso',
  erroneo: 'procesamiento erróneo',
};

const period = (p: unknown) => (typeof p === 'string' ? dayjs(`${p}-01`).format('MMMM YYYY') : '—');
const str = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const fieldValue = (field: string, v: unknown) => (field === 'ivaCondition' && typeof v === 'number' ? IVA_CONDITIONS[v] ?? str(v) : str(v));
const statusLabel = (s: unknown) => INVOICE_STATUS_LABELS[s as InvoiceStatus] ?? str(s);
const voucher = (d: Record<string, unknown>) =>
  typeof d.pointOfSale === 'number' && typeof d.number === 'number' ? `C ${formatVoucherNumber(d.pointOfSale, d.number)}` : '';

/** Texto de cada evento del historial (RF-163, RF-217). */
export function describeEvent(event: HistoryEvent): EventDescription {
  const d = event.data ?? {};
  switch (event.type) {
    case 'alta':
      return { title: 'Alta del cliente', details: [], color: 'green' };
    case 'modificacion': {
      const changes = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      return {
        title: 'Modificación de datos',
        details: Object.entries(changes).map(([f, c]) => `${FIELD_LABELS[f] ?? f}: ${fieldValue(f, c.from)} → ${fieldValue(f, c.to)}`),
        color: 'blue',
      };
    }
    case 'baja':
      return { title: 'Baja del cliente', details: [], color: 'red' };
    case 'reactivacion':
      return { title: 'Reactivación del cliente', details: [], color: 'green' };
    case 'asignacion_producto':
      return { title: `Producto asignado: ${str(d.productName)}`, details: [], color: 'blue' };
    case 'desasignacion_producto':
      return { title: `Producto desasignado: ${str(d.productName)}`, details: [], color: 'gray' };
    case 'factura_generada':
      return {
        title: `Factura ${voucher(d)} generada`,
        details: [`Período ${period(d.period)} · ${typeof d.totalCents === 'number' ? formatMoney(d.totalCents, 'ARS') : ''}`],
        color: 'blue',
      };
    case 'email_enviado':
      return {
        title: d.kind === 'factura' ? 'Email de la factura enviado' : 'Email enviado',
        details: [`A ${str(d.to)}: "${str(d.subject)}"`],
        color: 'blue',
      };
    case 'email_recibido': {
      const attachments = (d.attachments ?? []) as { filename: string; valid: boolean }[];
      return {
        title: `Email recibido: "${str(d.subject)}"`,
        details: attachments.length
          ? [`Adjuntos: ${attachments.map((a) => (a.valid ? a.filename : `${a.filename} (no se procesa)`)).join(', ')}`]
          : ['Sin adjuntos'],
        color: 'gray',
      };
    }
    case 'clasificacion_email': {
      const attachments = (d.attachments ?? []) as { filename: string; classification?: string; cuit?: string | null; amount?: string | null; error?: string }[];
      return {
        title: `Email clasificado: ${CLASSIFICATIONS[String(d.classification)] ?? str(d.classification)}`,
        details: attachments.map((a) =>
          a.error
            ? `${a.filename}: erróneo (${a.error})`
            : a.classification === 'si'
              ? `${a.filename}: comprobante · CUIT ${a.cuit ?? 'no extraído'} · monto ${a.amount ?? 'no extraído'}`
              : `${a.filename}: ${a.classification}`,
        ),
        color: d.classification === 'erroneo' ? 'red' : d.classification === 'dudoso' ? 'orange' : 'gray',
      };
    }
    case 'cambio_estado_factura': {
      const details: string[] = [];
      if (d.reason) details.push(`Motivo: ${str(d.reason)}`);
      if (d.previousReason) details.push(`Tenía el motivo: ${str(d.previousReason)}`);
      if (d.rule) details.push(`Regla ${str(d.rule)}`);
      return {
        title: `Factura ${voucher(d)}: ${statusLabel(d.from)} → ${statusLabel(d.to)}`,
        details,
        color: d.to === 'pagada' ? 'green' : d.to === 'revision_manual' ? 'orange' : 'blue',
      };
    }
    case 'error_proceso':
      return {
        title: `Error de proceso: ${OPERATION_LABELS[d.operation as ProcessOperation] ?? str(d.operation)}`,
        details: [`${str(d.lastError)} (${str(d.attempts)} intentos)`],
        color: 'red',
      };
    default:
      return { title: event.type, details: [], color: 'gray' };
  }
}
