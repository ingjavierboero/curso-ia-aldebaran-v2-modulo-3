import { describe, expect, it } from 'vitest';
import { formatCuit, isValidCuit } from './cuit';

describe('isValidCuit', () => {
  it('acepta CUIT válidos, con o sin guiones', () => {
    expect(isValidCuit('30711111111')).toBe(true);
    expect(isValidCuit('30-71111111-1')).toBe(true);
    expect(isValidCuit('20111111112')).toBe(true);
  });

  it('rechaza un dígito verificador incorrecto o una longitud distinta de 11', () => {
    expect(isValidCuit('30711111118')).toBe(false);
    expect(isValidCuit('3071111111')).toBe(false);
    expect(isValidCuit('')).toBe(false);
  });
});

describe('formatCuit', () => {
  it('agrega los guiones', () => {
    expect(formatCuit('30711111111')).toBe('30-71111111-1');
  });

  it('deja igual lo que no tiene 11 dígitos', () => {
    expect(formatCuit('123')).toBe('123');
  });
});
