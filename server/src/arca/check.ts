// Prueba la conexión con ARCA de homologación sin emitir comprobantes: pide el ticket
// a WSAA y consulta el último número de Factura C autorizado en un punto de venta.
//   npm run arca:check -- 3      (punto de venta; por defecto 1)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT_DIR } from '../config.js';
import { openDatabase } from '../db/index.js';
import { createArcaClient } from './index.js';

const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const pointOfSale = Number(process.argv[2] ?? 1);

try {
  const config = loadConfig();
  if (config.mockMode) throw new Error('Con MOCK_MODE=true no se usa ARCA. Corré el chequeo sin modo mock.');
  if (!Number.isInteger(pointOfSale) || pointOfSale < 1 || pointOfSale > 99_999) {
    throw new Error('El punto de venta debe ser un entero entre 1 y 99999.');
  }

  // La base guarda el ticket de WSAA para no pedir otro mientras siga vigente.
  const { db, close } = openDatabase(config.databasePath);
  try {
    const arca = createArcaClient(config, db);
    const last = await arca.lastAuthorizedNumber(pointOfSale);
    console.log(`ARCA homologación OK. CUIT ${config.arca.cuit}, punto de venta ${pointOfSale}:`);
    console.log(`  último número de Factura C autorizado: ${last}`);
  } finally {
    close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
