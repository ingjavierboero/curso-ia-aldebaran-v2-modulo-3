import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../db/index.js';
import { exchangeRates } from '../db/schema.js';
import { usdToArsCents } from '../domain/money.js';
import {
  DOLARHOY_TIMEOUT_MS,
  fetchBlueSellRate,
  parseArgentineAmount,
  parseBlueSellRate,
  RateReadError,
} from './dolarhoy.js';
import { resolveUsdRate } from './rates.js';

const HOME = readFileSync(new URL('./__fixtures__/dolarhoy-home.html', import.meta.url), 'utf8');

describe('parseBlueSellRate', () => {
  it('lee el blue venta de la tabla de cotizaciones, con decimales', () => {
    // En el recorte: tabla "Dólar Libre" venta 1.555,00 y recuadro "Venta $1.555".
    expect(parseBlueSellRate(HOME)).toBe(155_500);
  });

  it('usa el recuadro del blue si la tabla no está', () => {
    const withoutTable = HOME.replace(/<div class="tile cotizaciones_more">[\s\S]*$/, '');
    expect(parseBlueSellRate(withoutTable)).toBe(155_500);
  });

  it('no confunde el blue con otras cotizaciones de la tabla', () => {
    const html = HOME.replace('<div class="venta">1.555,00</div>', '<div class="venta">1.560,25</div>');
    expect(parseBlueSellRate(html)).toBe(156_025);
  });

  it('tira RateReadError si el formato cambió', () => {
    expect(() => parseBlueSellRate('<html><body>Mantenimiento</body></html>')).toThrow(RateReadError);
  });
});

describe('parseArgentineAmount', () => {
  it.each([
    ['1.555,00', 155_500],
    ['1.555,5', 155_550],
    ['1.555', 155_500],
    ['1555,50', 155_550],
    ['12.345.678,90', 1_234_567_890],
  ])('"%s" → %i centavos', (raw, cents) => {
    expect(parseArgentineAmount(raw)).toBe(cents);
  });

  it.each(['1,555.00', '1.555,505', '0', '0,00', 'abc', ''])('rechaza "%s"', (raw) => {
    expect(() => parseArgentineAmount(raw)).toThrow(RateReadError);
  });
});

describe('fetchBlueSellRate', () => {
  it('lee la cotización de la respuesta', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(HOME, { status: 200 }));
    expect(await fetchBlueSellRate(fetchMock)).toBe(155_500);
    expect(fetchMock).toHaveBeenCalledWith('https://dolarhoy.com/', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('falla con un HTTP de error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    await expect(fetchBlueSellRate(fetchMock)).rejects.toThrow(/HTTP 503/);
  });

  it('da la llamada por fallida a los 10 s (RNF-07, AC-228)', async () => {
    vi.useFakeTimers();
    try {
      // Un fetch que no responde nunca, salvo que se aborte su signal.
      const hanging = vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      );
      const result = fetchBlueSellRate(hanging as unknown as typeof fetch);
      const assertion = expect(result).rejects.toThrow('dolarhoy.com no respondió en 10 s.');

      await vi.advanceTimersByTimeAsync(DOLARHOY_TIMEOUT_MS - 1);
      expect(hanging).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveUsdRate', () => {
  let handle: DatabaseHandle;
  const now = () => new Date('2026-10-15T11:00:00-03:00');
  const failing = () => Promise.reject(new RateReadError('dolarhoy.com no respondió en 10 s.'));

  beforeEach(() => {
    handle = openDatabase(':memory:');
  });
  afterEach(() => handle.close());

  const insertRate = (rateCents: number, readAt: string) =>
    handle.db.insert(exchangeRates).values({ rateCents, source: 'dolarhoy.com', readAt: new Date(readAt) }).run();

  it('registra cada lectura con su valor, fuente y fecha (RF-65, AC-65)', async () => {
    const rate = await resolveUsdRate(handle.db, async () => 150_000, now);

    expect(rate).toMatchObject({ rateCents: 150_000, source: 'dolarhoy.com', fallback: false, readAt: now() });
    expect(handle.db.select().from(exchangeRates).all()).toMatchObject([
      { rateCents: 150_000, source: 'dolarhoy.com', readAt: now() },
    ]);
  });

  it('si no puede leer, usa la de fecha de lectura más reciente (RF-66, RF-67, AC-65)', async () => {
    // Cargadas fuera de orden a propósito: cuenta la fecha de lectura, no el orden de carga.
    insertRate(152_000, '2026-09-20T12:00:00-03:00');
    insertRate(149_000, '2026-08-15T12:00:00-03:00');
    insertRate(150_000, '2026-09-15T12:00:00-03:00');

    const rate = await resolveUsdRate(handle.db, failing, now);

    expect(rate).toMatchObject({ rateCents: 152_000, fallback: true, readError: 'dolarhoy.com no respondió en 10 s.' });
    expect(handle.db.select().from(exchangeRates).all()).toHaveLength(3);
  });

  it('sin ninguna cotización registrada y sin poder leer, devuelve null (RF-68)', async () => {
    expect(await resolveUsdRate(handle.db, failing, now)).toBeNull();
  });
});

describe('usdToArsCents (RF-63, RF-64)', () => {
  it('convierte con la cotización (AC-63)', () => {
    expect(usdToArsCents(10_000, 150_000)).toBe(15_000_000); // USD 100 × $1.500 = $150.000
  });

  it('redondea al centavo más cercano (AC-64)', () => {
    expect(usdToArsCents(1, 155_550)).toBe(1_556); // USD 0,01 × $1.555,50 = $15,555 → $15,56
    expect(usdToArsCents(1, 155_540)).toBe(1_555); // $15,554 → $15,55
  });

  it('no pierde precisión con montos grandes', () => {
    expect(usdToArsCents(99_999_999, 999_999_99)).toBe(99_999_998_000_000);
  });

  it('rechaza montos inválidos', () => {
    expect(() => usdToArsCents(1.5, 150_000)).toThrow(RangeError);
    expect(() => usdToArsCents(100, 0)).toThrow(RangeError);
  });
});
