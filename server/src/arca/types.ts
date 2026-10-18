/** RF-71: todas las facturas son Factura C (código 11 de ARCA). */
export const VOUCHER_TYPE_FACTURA_C = 11;
/** Concepto 2: servicios (exige período de servicio y vencimiento del pago). */
export const CONCEPT_SERVICES = 2;
/** Tipo de documento 80: CUIT. */
export const DOC_TYPE_CUIT = 80;

/** Datos de una Factura C para pedir su CAE. Fechas en YYYY-MM-DD. */
export interface VoucherRequest {
  pointOfSale: number;
  number: number;
  issueDate: string;
  serviceFrom: string;
  serviceTo: string;
  paymentDueDate: string;
  receiverCuit: string;
  /** RF-77: condición frente al IVA del receptor al momento de facturar. */
  receiverIvaCondition: number;
  totalCents: number;
}

/** Comprobante autorizado por ARCA. */
export interface AuthorizedVoucher {
  pointOfSale: number;
  number: number;
  cae: string;
  /** YYYY-MM-DD */
  caeDueDate: string;
  issueDate: string;
  receiverCuit: string;
  totalCents: number;
}

/**
 * Lo que la facturación necesita de ARCA. Hay una implementación real (WSFEv1 de
 * homologación) y una simulada para el modo mock (RF-185, RF-186).
 */
export interface ArcaClient {
  /** Último número de Factura C autorizado en el punto de venta (0 si no hay). */
  lastAuthorizedNumber(pointOfSale: number): Promise<number>;
  /** Comprobante ya autorizado con ese número, o null (para RF-76). */
  getVoucher(pointOfSale: number, number: number): Promise<AuthorizedVoucher | null>;
  /** Pide el CAE. Tira ArcaError si ARCA lo rechaza o no responde. */
  authorize(request: VoucherRequest): Promise<AuthorizedVoucher>;
}

export class ArcaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArcaError';
  }
}

/** "2026-10-15" → "20261015". */
export function toArcaDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ArcaError(`Fecha inválida: ${date}`);
  return date.replaceAll('-', '');
}

/** "20261015" → "2026-10-15". */
export function fromArcaDate(date: string): string {
  if (!/^\d{8}$/.test(date)) throw new ArcaError(`Fecha de ARCA inválida: ${date}`);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/** 1500050 → "15000.50". */
export function toArcaAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "15000.5" → 1500050. */
export function fromArcaAmount(amount: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new ArcaError(`Importe de ARCA inválido: ${amount}`);
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
