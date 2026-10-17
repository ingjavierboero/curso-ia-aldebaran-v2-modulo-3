import { describe, expect, it } from 'vitest';
import { isValidCuit, normalizeCuit } from './cuit.js';

describe('isValidCuit (RF-39)', () => {
  it.each(['30711111111', '20111111112', '27000000006', '20000000001'])('acepta %s', (cuit) => {
    expect(isValidCuit(cuit)).toBe(true);
  });

  it('rechaza un dígito verificador incorrecto (AC-41)', () => {
    expect(isValidCuit('30711111118')).toBe(false);
  });

  it.each(['3071111111', '307111111111', '3071111111a', '', '30-71111111-1'])(
    'rechaza %s por formato',
    (cuit) => {
      expect(isValidCuit(cuit)).toBe(false);
    },
  );

  it('rechaza los CUIT cuyo cálculo da 10, que ARCA no emite', () => {
    // 20-00000001-?: suma 5*2 + 2*1 = 12 → 12 % 11 = 1 → 11 - 1 = 10.
    for (let d = 0; d <= 9; d++) {
      expect(isValidCuit(`2000000001${d}`)).toBe(false);
    }
  });
});

describe('normalizeCuit', () => {
  it('deja solo los dígitos (RF-125)', () => {
    expect(normalizeCuit('30-71111111-1')).toBe('30711111111');
    expect(normalizeCuit(' 30.71111111.1 ')).toBe('30711111111');
  });
});
