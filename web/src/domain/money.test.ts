import { describe, expect, it } from 'vitest';
import { formatMoney, toCents } from './money';

describe('formatMoney', () => {
  it('formatea pesos y dólares en formato argentino', () => {
    // Intl separa símbolo e importe con un espacio duro.
    expect(formatMoney(1_500_050, 'ARS').replace(/\s/g, ' ')).toBe('$ 15.000,50');
    expect(formatMoney(1, 'USD').replace(/\s/g, ' ')).toBe('US$ 0,01');
  });
});

describe('toCents', () => {
  it('convierte sin errores de punto flotante', () => {
    expect(toCents(15000.5)).toBe(1_500_050);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(1.005 + 0.004)).toBe(101);
    expect(toCents(19.99)).toBe(1999);
  });
});
