import { normalizeCuit } from '../domain/cuit.js';
import type { EmailClassification } from './process-email.js';

/** Factura adeudada: Pendiente de pago o Revisión manual. */
export interface OwedInvoice {
  id: number;
  /** "YYYY-MM": determina la antigüedad. */
  period: string;
  totalCents: number;
  status: 'pendiente_pago' | 'revision_manual';
}

/** CUIT y monto extraídos de un comprobante (null si no se pudieron extraer). */
export interface Receipt {
  cuit: string | null;
  amount: string | null;
}

/** Motivos de la Revisión manual (RF-128 a RF-137). */
export const REVIEW_REASONS = {
  pendingReview: 'revisión manual pendiente',
  processingError: 'no se pudo procesar el comprobante',
  doubtful: 'clasificación dudosa',
  notExtracted: 'no se pudieron extraer el CUIT o el monto',
  cuitMismatch: 'CUIT no coincide',
  ambiguous: 'no se pudo determinar qué facturas cancela el pago',
  amountMismatch: 'monto no coincide',
} as const;
export type ReviewReason = (typeof REVIEW_REASONS)[keyof typeof REVIEW_REASONS];

export type Decision =
  /** RF-126, RF-127: ninguna factura cambia de estado. */
  | { action: 'none'; rule: 'RF-126' | 'RF-127' }
  /** Las facturas pasan a Revisión manual con el motivo de la regla. */
  | { action: 'review'; invoiceIds: number[]; reason: ReviewReason; rule: string }
  /** RF-134, RF-135: las facturas de la coincidencia pasan a Pago recibido. */
  | { action: 'payment_received'; invoiceIds: number[]; rule: 'RF-134' | 'RF-135' };

/**
 * Reglas RF-126 a RF-137 para un email con adjuntos de un cliente. Son excluyentes: a
 * cada email le corresponde exactamente una.
 */
export function decide(input: {
  classification: EmailClassification;
  /** Comprobantes del email (adjuntos clasificados como "si"). */
  receipts: Receipt[];
  clientCuit: string;
  owed: OwedInvoice[];
}): Decision {
  const { classification, receipts, owed } = input;
  const all = owed.map((i) => i.id);
  const review = (reason: ReviewReason, rule: string): Decision => ({ action: 'review', invoiceIds: all, reason, rule });

  if (classification === 'no') return { action: 'none', rule: 'RF-126' };
  if (owed.length === 0) return { action: 'none', rule: 'RF-127' };
  if (owed.some((i) => i.status === 'revision_manual')) return review(REVIEW_REASONS.pendingReview, 'RF-128');
  if (classification === 'erroneo') return review(REVIEW_REASONS.processingError, 'RF-130');
  if (classification === 'dudoso') return review(REVIEW_REASONS.doubtful, 'RF-131');

  if (receipts.some((r) => r.cuit === null || r.amount === null)) return review(REVIEW_REASONS.notExtracted, 'RF-132');
  const clientCuit = normalizeCuit(input.clientCuit);
  if (receipts.some((r) => normalizeCuit(r.cuit!) !== clientCuit)) return review(REVIEW_REASONS.cuitMismatch, 'RF-133');

  // Email validable.
  const matches = amountMatches(owed, receipts.map((r) => r.amount!));
  if (matches.length === 0) return review(REVIEW_REASONS.amountMismatch, 'RF-137');
  if (matches.length === 1) return { action: 'payment_received', invoiceIds: ids(matches[0]!), rule: 'RF-134' };
  const oldest = oldestCombination(matches);
  if (oldest) return { action: 'payment_received', invoiceIds: ids(oldest), rule: 'RF-135' };
  return review(REVIEW_REASONS.ambiguous, 'RF-136');
}

const ids = (match: OwedInvoice[]) => match.map((i) => i.id);

/**
 * RNF-13: monto en centavos, al centavo exacto. null si es igual o menor a cero o tiene
 * fracción de centavo ("15000.505"): ese email no tiene ninguna coincidencia.
 */
export function amountToCents(amount: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) return null;
  const decimals = match[2] ?? '';
  if (/[1-9]/.test(decimals.slice(2))) return null;
  const cents = Number(match[1]) * 100 + Number(decimals.slice(0, 2).padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

/**
 * Coincidencias de monto (definición del PRD), cada una como lista de facturas de la más
 * antigua a la más reciente:
 * - un comprobante: facturas, o combinaciones, cuyo total es exactamente su monto;
 * - varios: conjuntos que se pueden repartir entre los comprobantes (al menos una factura
 *   por comprobante, ninguna en dos, cada reparto suma exactamente su monto); dos repartos
 *   con el mismo conjunto son la misma coincidencia. Si no hay ninguna, valen las
 *   combinaciones cuyo total es la suma de los montos.
 */
export function amountMatches(owed: OwedInvoice[], amounts: string[]): OwedInvoice[][] {
  const cents = amounts.map(amountToCents);
  if (cents.length === 0 || cents.some((c) => c === null)) return [];
  const targets = cents as number[];
  const sorted = [...owed].sort(byAge);

  if (targets.length === 1) return subsetsWithSum(sorted, targets[0]!).map((mask) => fromMask(sorted, mask));

  const perReceipt = partitionMatches(sorted, targets);
  if (perReceipt.length > 0) return perReceipt.map((mask) => fromMask(sorted, mask));

  const total = targets.reduce((a, b) => a + b, 0);
  return subsetsWithSum(sorted, total).map((mask) => fromMask(sorted, mask));
}

/**
 * RF-135: entre varias coincidencias, se comparan sus facturas de la más antigua a la más
 * reciente y gana la que tiene la más antigua; si empatan, se compara la siguiente. La
 * comparación termina cuando alguna de las que se comparan se queda sin facturas. Si al
 * final no queda una sola, no hay combinación más antigua.
 */
export function oldestCombination(matches: OwedInvoice[][]): OwedInvoice[] | null {
  let candidates = matches.map((m) => [...m].sort(byAge));
  for (let k = 0; candidates.length > 1; k++) {
    if (candidates.some((c) => c.length <= k)) break;
    const oldestPeriod = candidates.map((c) => c[k]!.period).sort()[0]!;
    candidates = candidates.filter((c) => c[k]!.period === oldestPeriod);
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

/** Antigüedad por período; a igual período, por id (solo para un orden estable). */
function byAge(a: OwedInvoice, b: OwedInvoice): number {
  return a.period.localeCompare(b.period) || a.id - b.id;
}

/** Subconjuntos (como máscaras de bits sobre `invoices`) cuyo total es exactamente `target`. */
function subsetsWithSum(invoices: OwedInvoice[], target: number, allowed = (1n << BigInt(invoices.length)) - 1n): bigint[] {
  const result: bigint[] = [];
  const walk = (index: number, remaining: number, mask: bigint) => {
    if (remaining === 0 && mask !== 0n) {
      result.push(mask);
      return;
    }
    if (remaining < 0 || index >= invoices.length) return;
    const bit = 1n << BigInt(index);
    // Con la factura `index` (si está disponible) y sin ella.
    if (allowed & bit) walk(index + 1, remaining - invoices[index]!.totalCents, mask | bit);
    walk(index + 1, remaining, mask);
  };
  walk(0, target, 0n);
  return result;
}

/** Conjuntos de facturas repartibles entre los comprobantes (coincidencia por comprobante). */
function partitionMatches(invoices: OwedInvoice[], targets: number[]): bigint[] {
  const all = (1n << BigInt(invoices.length)) - 1n;
  const found = new Set<bigint>();
  const assign = (receipt: number, used: bigint) => {
    if (receipt === targets.length) {
      found.add(used);
      return;
    }
    for (const subset of subsetsWithSum(invoices, targets[receipt]!, all & ~used)) assign(receipt + 1, used | subset);
  };
  assign(0, 0n);
  return [...found];
}

function fromMask(invoices: OwedInvoice[], mask: bigint): OwedInvoice[] {
  return invoices.filter((_, i) => (mask >> BigInt(i)) & 1n);
}
