import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadConfig, ROOT_DIR, TIMEZONE } from './config.js';
import { openDatabase } from './db/index.js';

// RNF-12: todas las fechas del proceso se rigen por la hora de Argentina.
process.env.TZ = TIMEZONE;

// Las variables ya definidas en el entorno tienen prioridad sobre las de .env.
const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`No se puede arrancar Aldebaran: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

// Abre la base y aplica las migraciones pendientes antes de aceptar requests.
const database = openDatabase(config.databasePath);

const server = createApp().listen(config.port, () => {
  const mode = config.mockMode ? 'modo mock: ARCA, LLM y email simulados' : 'modo real';
  console.log(`Aldebaran server escuchando en http://localhost:${config.port} (${mode})`);
  console.log(`Base de datos: ${path.relative(ROOT_DIR, config.databasePath)}`);
  console.log(`Procesos automáticos: ${config.schedulerEnabled ? 'activados' : 'desactivados'}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
