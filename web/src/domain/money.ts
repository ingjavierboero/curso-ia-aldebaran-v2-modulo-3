export type Currency = 'ARS' | 'USD';

export const CURRENCY_LABELS: Record<Currency, string> = {
  ARS: 'Pesos (ARS)',
  USD: 'Dólares (USD)',
};

const formatters: Record<Currency, Intl.NumberFormat> = {
  ARS: new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }),
  USD: new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD' }),
};

/** 1500050 centavos en ARS → "$ 15.000,50". */
export function formatMoney(cents: number, currency: Currency): string {
  return formatters[currency].format(cents / 100);
}

/**
 * Pasa un importe con hasta 2 decimales a centavos enteros (RNF-13). Redondea para
 * absorber el error de punto flotante (15000.5 * 100 = 1500049.9999…).
 */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}
