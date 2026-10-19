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

const timeParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** RNF-12: hora actual en Argentina, "HH:MM". */
export function argentinaTime(now: Date): string {
  return timeParts.format(now);
}

/**
 * RF-51, RF-52: ya pasó (o es) el día 15 a la hora de facturación del mes en curso, en
 * hora de Argentina. Si el sistema estuvo apagado ese momento, sigue siendo cierto el
 * resto del mes, así que la facturación corre apenas vuelve.
 */
export function isBillingDue(now: Date, billingTime: string): boolean {
  const day = Number(argentinaDate(now).slice(8, 10));
  return day > 15 || (day === 15 && argentinaTime(now) >= billingTime);
}
