const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Deja solo los dígitos: "30-71111111-1" → "30711111111" (RF-125). */
export function normalizeCuit(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * RF-39: valida que el CUIT tenga 11 dígitos y un dígito verificador correcto
 * (módulo 11). Si el cálculo da 10, ARCA no emite ese CUIT, así que es inválido.
 */
export function isValidCuit(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;

  const digits = [...cuit].map(Number);
  const sum = WEIGHTS.reduce((acc, weight, i) => acc + weight * digits[i]!, 0);
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? 0 : remainder;

  return expected !== 10 && expected === digits[10];
}
