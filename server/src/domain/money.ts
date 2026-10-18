/**
 * RF-63, RF-64: convierte una cuota en centavos de dólar a centavos de peso con la
 * cotización (pesos por dólar, en centavos), redondeando al centavo más cercano.
 * Es la única operación del sistema que redondea (RNF-13). Usa solo enteros para no
 * arrastrar errores de punto flotante.
 */
export function usdToArsCents(usdCents: number, rateCents: number): number {
  if (!Number.isInteger(usdCents) || !Number.isInteger(rateCents) || usdCents < 0 || rateCents <= 0) {
    throw new RangeError('Montos inválidos para convertir a pesos.');
  }
  // usdCents × rateCents está en centavos² → dividir por 100, redondeando la mitad hacia arriba.
  const product = BigInt(usdCents) * BigInt(rateCents);
  return Number((product + 50n) / 100n);
}
