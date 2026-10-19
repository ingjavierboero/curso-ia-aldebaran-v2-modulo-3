import { describe, expect, it } from 'vitest';
import { amountMatches, amountToCents, decide, oldestCombination, REVIEW_REASONS, type OwedInvoice, type Receipt } from './validation.js';

const CUIT = '30711111111';
let nextId = 1;
const inv = (period: string, pesos: number, status: OwedInvoice['status'] = 'pendiente_pago'): OwedInvoice => ({
  id: nextId++, period, totalCents: Math.round(pesos * 100), status,
});
const receipt = (amount: string | null, cuit: string | null = CUIT): Receipt => ({ cuit, amount });
const validable = (owed: OwedInvoice[], ...receipts: Receipt[]) =>
  decide({ classification: 'si', receipts, clientCuit: CUIT, owed });

describe('reglas excluyentes (RF-126 a RF-133)', () => {
  it('"no": ninguna factura cambia (RF-126, AC-119)', () => {
    expect(decide({ classification: 'no', receipts: [], clientCuit: CUIT, owed: [inv('2026-10', 100)] }))
      .toEqual({ action: 'none', rule: 'RF-126' });
  });

  it.each(['si', 'dudoso', 'erroneo'] as const)('"%s" sin deuda vigente: ninguna factura cambia (RF-127, AC-120, AC-121)', (classification) => {
    expect(decide({ classification, receipts: [receipt('100')], clientCuit: CUIT, owed: [] })).toEqual({ action: 'none', rule: 'RF-127' });
  });

  it.each(['si', 'dudoso', 'erroneo'] as const)(
    'cliente en revisión: todas sus adeudadas a Revisión manual con "revisión manual pendiente", aunque el monto coincida (RF-128, AC-122, AC-123)',
    (classification) => {
      const inReview = inv('2026-09', 150, 'revision_manual');
      const pending = inv('2026-10', 200);
      expect(decide({ classification, receipts: [receipt('200')], clientCuit: CUIT, owed: [inReview, pending] })).toEqual({
        action: 'review', invoiceIds: [inReview.id, pending.id], reason: 'revisión manual pendiente', rule: 'RF-128',
      });
    },
  );

  it('procesamiento erróneo: "no se pudo procesar el comprobante" (RF-130, AC-125)', () => {
    const a = inv('2026-10', 100);
    expect(decide({ classification: 'erroneo', receipts: [], clientCuit: CUIT, owed: [a] }))
      .toMatchObject({ action: 'review', invoiceIds: [a.id], reason: REVIEW_REASONS.processingError });
  });

  it('dudoso: "clasificación dudosa", aunque otro adjunto sea un comprobante exacto (RF-131, AC-126, AC-127)', () => {
    const a = inv('2026-10', 10_000);
    expect(decide({ classification: 'dudoso', receipts: [receipt('10000')], clientCuit: CUIT, owed: [a] }))
      .toMatchObject({ action: 'review', reason: 'clasificación dudosa' });
  });

  it.each([
    ['sin CUIT', receipt('100', null)],
    ['sin monto', receipt(null)],
  ])('comprobante %s: "no se pudieron extraer el CUIT o el monto" (RF-132, AC-128, AC-129)', (_label, r) => {
    expect(validable([inv('2026-10', 100)], r)).toMatchObject({ action: 'review', reason: 'no se pudieron extraer el CUIT o el monto' });
  });

  it('CUIT distinto: "CUIT no coincide" (RF-133, AC-130, AC-37)', () => {
    expect(validable([inv('2026-10', 100)], receipt('100', '20111111112'))).toMatchObject({ action: 'review', reason: 'CUIT no coincide' });
  });

  it('con un comprobante del cliente y otro de otro CUIT, ninguno valida (AC-131)', () => {
    const a = inv('2026-10', 100);
    const b = inv('2026-10', 200);
    expect(validable([a, b], receipt('100'), receipt('200', '20111111112'))).toEqual({
      action: 'review', invoiceIds: [a.id, b.id], reason: 'CUIT no coincide', rule: 'RF-133',
    });
  });

  it('compara solo los dígitos del CUIT (RF-125, AC-132)', () => {
    const a = inv('2026-10', 100);
    expect(decide({ classification: 'si', receipts: [receipt('100', '30-71111111-8')], clientCuit: '30711111118', owed: [a] }))
      .toEqual({ action: 'payment_received', invoiceIds: [a.id], rule: 'RF-134' });
  });
});

describe('coincidencia de monto (RF-134 a RF-137)', () => {
  it('monto exacto de la única factura: Pago recibido (AC-133, AC-197)', () => {
    const a = inv('2026-10', 15_000.5);
    expect(validable([a], receipt('15000.50'))).toEqual({ action: 'payment_received', invoiceIds: [a.id], rule: 'RF-134' });
  });

  it('A + C cuando ninguna otra combinación suma ese monto (AC-134)', () => {
    const a = inv('2026-08', 100);
    const b = inv('2026-09', 250);
    const c = inv('2026-10', 400);
    expect(validable([a, b, c], receipt('500'))).toMatchObject({ action: 'payment_received', invoiceIds: [a.id, c.id] });
  });

  it('el total de todas las adeudadas (AC-135)', () => {
    const owed = [inv('2026-08', 100), inv('2026-09', 250), inv('2026-10', 400)];
    expect(validable(owed, receipt('750'))).toMatchObject({ action: 'payment_received', invoiceIds: owed.map((i) => i.id) });
  });

  it('dos comprobantes: prima la coincidencia por comprobante sobre la suma (AC-137)', () => {
    const a = inv('2026-01', 100);
    const b = inv('2026-02', 200);
    const c = inv('2026-03', 300);
    expect(validable([a, b, c], receipt('100'), receipt('200'))).toEqual({ action: 'payment_received', invoiceIds: [a.id, b.id], rule: 'RF-134' });
  });

  it('dos comprobantes sin coincidencia por comprobante: vale la suma (AC-138)', () => {
    const a = inv('2026-10', 300);
    expect(validable([a], receipt('100'), receipt('200'))).toEqual({ action: 'payment_received', invoiceIds: [a.id], rule: 'RF-134' });
  });

  it('dos repartos con el mismo conjunto de facturas son la misma coincidencia', () => {
    // A=100, B=100 con comprobantes de 100 y 100: {A→1, B→2} y {B→1, A→2} son la misma.
    const a = inv('2026-09', 100);
    const b = inv('2026-10', 100);
    expect(amountMatches([a, b], ['100', '100'])).toHaveLength(1);
  });

  it('igual monto en distintos meses: paga la más antigua (RF-135, AC-139)', () => {
    const oct = inv('2026-10', 100);
    const sep = inv('2026-09', 100);
    expect(validable([oct, sep], receipt('100'))).toEqual({ action: 'payment_received', invoiceIds: [sep.id], rule: 'RF-135' });
  });

  it('enero + abril gana a febrero + marzo (RF-135, AC-140)', () => {
    const jan = inv('2026-01', 100);
    const feb = inv('2026-02', 200);
    const mar = inv('2026-03', 300);
    const apr = inv('2026-04', 400);
    expect(validable([jan, feb, mar, apr], receipt('500'))).toMatchObject({ action: 'payment_received', invoiceIds: [jan.id, apr.id] });
  });

  it('dos del mismo período y monto: no se puede determinar (RF-136, AC-141)', () => {
    const owed = [inv('2026-10', 100), inv('2026-10', 100)];
    expect(validable(owed, receipt('100'))).toMatchObject({ action: 'review', reason: 'no se pudo determinar qué facturas cancela el pago', rule: 'RF-136' });
  });

  it('A (ene $300) contra B (ene $100) + C (feb $200): A se queda sin facturas para comparar (RF-136, AC-142)', () => {
    const a = inv('2026-01', 300);
    const b = inv('2026-01', 100);
    const c = inv('2026-02', 200);
    expect(validable([a, b, c], receipt('300'))).toEqual({
      action: 'review', invoiceIds: [a.id, b.id, c.id], reason: 'no se pudo determinar qué facturas cancela el pago', rule: 'RF-136',
    });
  });

  it('pago parcial: "monto no coincide" (RF-137, AC-143)', () => {
    expect(validable([inv('2026-10', 1000)], receipt('400'))).toMatchObject({ action: 'review', reason: 'monto no coincide', rule: 'RF-137' });
  });

  it('se evalúa al centavo exacto, sin redondeos (RNF-13, AC-230)', () => {
    expect(validable([inv('2026-10', 15_000)], receipt('15000.01'))).toMatchObject({ action: 'review', reason: 'monto no coincide' });
  });

  it.each(['0', '0.00', '15000.505'])('el monto %s no coincide con nada (RNF-13, AC-231)', (amount) => {
    expect(validable([inv('2026-10', 15_000.5)], receipt(amount))).toMatchObject({ action: 'review', reason: 'monto no coincide' });
  });
});

describe('auxiliares', () => {
  it.each([
    ['15000.50', 1_500_050],
    ['15000.5', 1_500_050],
    ['15000', 1_500_000],
    ['15000.500', 1_500_050],
    ['15000.505', null],
    ['0', null],
    ['-5', null],
    ['abc', null],
  ])('amountToCents(%s) = %s', (amount, cents) => {
    expect(amountToCents(amount)).toBe(cents);
  });

  it('oldestCombination sin coincidencias únicas devuelve null', () => {
    expect(oldestCombination([[inv('2026-10', 1)], [inv('2026-10', 1)]])).toBeNull();
  });

  it('resuelve 20 facturas adeudadas en un tiempo razonable', () => {
    const owed = Array.from({ length: 20 }, (_, i) => inv(`2025-${String((i % 12) + 1).padStart(2, '0')}`, 1000 + i * 37));
    const started = Date.now();
    validable(owed, receipt(String(owed.slice(0, 3).reduce((s, i) => s + i.totalCents, 0) / 100)));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
