import { TIMEZONE } from '../config.js';

const dateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** RNF-12: fecha de hoy en Argentina, "YYYY-MM-DD", sin importar la zona del servidor. */
export function argentinaDate(now: Date): string {
  return dateParts.format(now);
}

/** Período ("YYYY-MM") del mes en curso en Argentina. */
export function currentPeriod(now: Date): string {
  return argentinaDate(now).slice(0, 7);
}

/** RF-80: primer y último día del mes del período. */
export function periodBounds(period: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new RangeError(`Período inválido: ${period}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * RF-81: vence el último día del mes del período o, si la factura se genera después de
 * ese día (por ejemplo, en un reintento manual), el mismo día de emisión.
 */
export function paymentDueDate(period: string, issueDate: string): string {
  const { to } = periodBounds(period);
  return issueDate > to ? issueDate : to;
}
