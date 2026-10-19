// Revisa la casilla una vez a mano: lee los emails nuevos y los procesa. En modo mock
// usa la casilla simulada.   MOCK_MODE=true npm run mailbox:run
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT_DIR, TIMEZONE } from '../config.js';
import { openDatabase } from '../db/index.js';
import { createMailboxCheckDeps } from './deps.js';
import { runMailboxCheck } from './check.js';

process.env.TZ = TIMEZONE;
const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

try {
  const config = loadConfig();
  const { db, close } = openDatabase(config.databasePath);
  try {
    console.log(`Revisando la casilla ${config.systemMailbox} (${config.mockMode ? 'casilla simulada' : 'Gmail'})…`);
    console.log(`  base de datos: ${path.relative(ROOT_DIR, config.databasePath)}`);
    const result = await runMailboxCheck(createMailboxCheckDeps(config, db));
    console.log(`  ${result.ingested} emails nuevos.`);
    for (const { emailId, outcome } of result.outcomes) {
      const decision = outcome.kind === 'cliente' ? outcome.decision : null;
      const result = !decision
        ? ''
        : decision.action === 'none'
          ? ` → sin cambios (${decision.rule})`
          : decision.action === 'payment_received'
            ? ` → facturas ${decision.invoiceIds.join(', ')} a Pago recibido (${decision.rule})`
            : ` → facturas ${decision.invoiceIds.join(', ')} a Revisión manual: "${decision.reason}" (${decision.rule})`;
      const detail =
        outcome.kind === 'cliente'
          ? `del cliente ${outcome.clientId}, clasificación: ${outcome.classification ?? 'sin adjuntos válidos'}${result}`
          : outcome.kind === 'aviso'
            ? 'aviso (remitente desconocido)'
            : 'ya procesado';
      console.log(`  email ${emailId}: ${detail}`);
    }
  } finally {
    close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
