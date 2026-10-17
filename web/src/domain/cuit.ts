const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Deja solo los dígitos: "30-71111111-1" → "30711111111". */
export function normalizeCuit(value: string): string {
  return value.replace(/\D/g, '');
}

/** Misma validación que el server (RF-39): 11 dígitos y dígito verificador módulo 11. */
export function isValidCuit(value: string): boolean {
  const cuit = normalizeCuit(value);
  if (cuit.length !== 11) return false;

  const digits = [...cuit].map(Number);
  const sum = WEIGHTS.reduce((acc, weight, i) => acc + weight * digits[i]!, 0);
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? 0 : remainder;

  return expected !== 10 && expected === digits[10];
}

/** "30711111111" → "30-71111111-1". Si no tiene 11 dígitos, lo devuelve igual. */
export function formatCuit(cuit: string): string {
  return /^\d{11}$/.test(cuit) ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}` : cuit;
}
