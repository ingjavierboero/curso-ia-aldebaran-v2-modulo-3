// Clasifica un archivo local con Claude, sin tocar la base: para probar la clasificación
// con comprobantes reales.   npm run classify:check -- ruta/al/comprobante.pdf
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT_DIR } from '../config.js';
import { ClaudeClassifier } from './claude.js';
import { classifyWithRetries } from './retry.js';

const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const file = process.argv[2];

try {
  if (!file) throw new Error('Indicá el archivo: npm run classify:check -- ruta/al/comprobante.pdf');
  const config = loadConfig();
  if (config.mockMode || !config.anthropicApiKey) throw new Error('Con MOCK_MODE=true no se usa Claude. Corré el chequeo sin modo mock.');

  // La ruta es relativa a donde se corrió npm (INIT_CWD), no a server/.
  const fullPath = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const classifier = new ClaudeClassifier({ apiKey: config.anthropicApiKey, issuerCuit: config.arca.cuit });
  const started = Date.now();
  const result = await classifyWithRetries(
    classifier,
    { filename: path.basename(fullPath), contentType: 'application/octet-stream', content: readFileSync(fullPath), emailSubject: '', emailText: '' },
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
  console.log(`${path.basename(fullPath)} (${((Date.now() - started) / 1000).toFixed(1)} s):`);
  console.log(result.ok
    ? `  clasificación: ${result.classification}\n  CUIT del ordenante: ${result.cuit ?? '—'}\n  monto: ${result.amount ?? '—'}`
    : `  procesamiento erróneo después de ${result.attempts} intento(s): ${result.error}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
