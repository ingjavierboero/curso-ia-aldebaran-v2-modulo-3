// Corre el proceso de facturación de un período a mano, contra la base configurada
// (en modo mock, data/aldebaran-mock.db y ARCA simulado). Hasta que exista el botón
// "Facturar ahora":   MOCK_MODE=true npm run billing:run -- 2026-10
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT_DIR, TIMEZONE } from '../config.js';
import { openDatabase } from '../db/index.js';
import { currentPeriod } from './dates.js';
import { createBillingDeps } from './deps.js';
import { defaultSleep, runBillingProcess } from './process.js';

process.env.TZ = TIMEZONE;
const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const now = () => new Date();
const period = process.argv[2] ?? currentPeriod(now());

try {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('El período tiene que tener el formato YYYY-MM.');
  const config = loadConfig();
  const { db, close } = openDatabase(config.databasePath);
  try {
    console.log(`Facturando ${period} (${config.mockMode ? 'modo mock, ARCA simulado' : 'ARCA homologación'})…`);
    console.log(`  base de datos: ${path.relative(ROOT_DIR, config.databasePath)}`);
    const summary = await runBillingProcess(
      createBillingDeps(config, db, {
        now,
        sleep: (ms) => {
          console.log(`  reintento en ${ms / 60_000} min…`);
          return defaultSleep(ms);
        },
        afterInvoice: (invoice) => {
          const total = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(invoice.totalCents / 100);
          console.log(`  factura ${invoice.pointOfSale}-${invoice.number} → ${invoice.clientBusinessName}: ${total}`);
        },
      }),
      period,
    );
    console.log(`Listo: ${summary.generated} generadas, ${summary.failed} con error, ${summary.skipped} ya facturadas.`);
    if (summary.generated + summary.failed + summary.skipped === 0) {
      console.log(
        '  No hay clientes facturables (Activos con algún producto Activo asignado) en esta base.' +
          (config.mockMode ? '' : ' ¿Quisiste usar el modo mock? MOCK_MODE=true npm run billing:run'),
      );
    }
  } finally {
    close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
