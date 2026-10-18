import { timeoutSignal } from '../http/timeout.js';

export const DOLARHOY_SOURCE = 'dolarhoy.com';
const DOLARHOY_URL = 'https://dolarhoy.com/';

/** RNF-07: dolarhoy.com se da por caído si no responde en 10 s. */
export const DOLARHOY_TIMEOUT_MS = 10_000;

export class RateReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateReadError';
  }
}

/**
 * Busca la cotización del dólar blue venta en la home de dolarhoy.com y la devuelve
 * en centavos. Primero en la tabla de cotizaciones, que trae decimales ("Dólar Libre":
 * venta 1.555,00); si no está, en el recuadro destacado del blue ("Venta $1.555").
 * Si el formato cambió y no la encuentra, tira RateReadError (RF-67).
 */
export function parseBlueSellRate(html: string): number {
  const table =
    /href="\/cotizaciondolarblue"\s*>\s*<div class="title">[^<]*<\/div>\s*<div class="compra">[^<]*<\/div>\s*<div class="venta">\s*([\d.,]+)\s*<\/div>/i.exec(
      html,
    );
  const tile =
    /class="titleText"\s+href="\/cotizaciondolarblue"[\s\S]{0,2000}?<div class="venta">\s*<div class="label">[^<]*<\/div>\s*<div class="val">\s*\$?\s*([\d.,]+)\s*<\/div>/i.exec(
      html,
    );

  const raw = table?.[1] ?? tile?.[1];
  if (!raw) throw new RateReadError('No se encontró la cotización del dólar blue en dolarhoy.com.');
  return parseArgentineAmount(raw);
}

/** "1.555,50" → 155550 centavos. Sin redondeos: más de 2 decimales es un error. */
export function parseArgentineAmount(raw: string): number {
  const match = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/.exec(raw.trim());
  if (!match) throw new RateReadError(`Cotización con formato inesperado: "${raw}".`);
  const pesos = Number(match[1]!.replace(/\./g, ''));
  const cents = Number((match[2] ?? '0').padEnd(2, '0'));
  const total = pesos * 100 + cents;
  if (total <= 0) throw new RateReadError(`Cotización inválida: "${raw}".`);
  return total;
}

/** RF-63: lee el dólar blue venta de dolarhoy.com, en centavos de peso. */
export async function fetchBlueSellRate(fetchImpl: typeof fetch = fetch): Promise<number> {
  let res: Response;
  try {
    res = await fetchImpl(DOLARHOY_URL, {
      signal: timeoutSignal(DOLARHOY_TIMEOUT_MS),
      headers: { 'user-agent': 'Mozilla/5.0 (Aldebaran)', accept: 'text/html' },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new RateReadError(
      timedOut
        ? `dolarhoy.com no respondió en ${DOLARHOY_TIMEOUT_MS / 1000} s.`
        : `No se pudo conectar con dolarhoy.com: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!res.ok) throw new RateReadError(`dolarhoy.com respondió HTTP ${res.status}.`);
  return parseBlueSellRate(await res.text());
}
