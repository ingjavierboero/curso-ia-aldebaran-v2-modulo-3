// Lee en vivo el dólar blue venta de dolarhoy.com, sin tocar la base. Sirve para
// detectar si el sitio cambió su formato: npm run exchange:check
import { fetchBlueSellRate } from './dolarhoy.js';

try {
  const cents = await fetchBlueSellRate();
  const pesos = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(cents / 100);
  console.log(`Dólar blue venta en dolarhoy.com: ${pesos}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
