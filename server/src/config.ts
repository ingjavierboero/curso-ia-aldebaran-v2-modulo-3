import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidCuit } from './domain/cuit.js';

/** Zona horaria de todas las fechas y horarios del sistema (RNF-12). */
export const TIMEZONE = 'America/Argentina/Buenos_Aires';

/** Raíz del repo: las rutas relativas de las variables de entorno se toman desde acá. */
export const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

export const MOCK_DATABASE_PATH = 'data/aldebaran-mock.db';
export const DEFAULT_DATABASE_PATH = 'data/aldebaran.db';
export const MOCK_MAILBOX = 'aldebaran-mock@gmail.com';
export const MOCK_ARCA_CUIT = '20111111112';

const REQUIRED_OUTSIDE_MOCK = [
  'ANTHROPIC_API_KEY',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
  'ARCA_CUIT',
  'ARCA_CERT_PATH',
  'ARCA_KEY_PATH',
] as const;

export interface Config {
  mockMode: boolean;
  port: number;
  rootDir: string;
  /** Ruta absoluta de la base SQLite. */
  databasePath: string;
  schedulerEnabled: boolean;
  /** Casilla del sistema: GMAIL_USER, o la casilla simulada en modo mock (RF-195). */
  systemMailbox: string;
  emailRedirectTo: string | null;
  anthropicApiKey: string | null;
  gmail: { user: string; appPassword: string } | null;
  arca: {
    cuit: string;
    /** Rutas absolutas; null en modo mock. */
    certPath: string | null;
    keyPath: string | null;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Lee una variable; vacía o con solo espacios cuenta como no definida. */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(env: Env = process.env, rootDir: string = ROOT_DIR): Config {
  // RF-184: solo el valor exacto "true" activa el modo mock.
  const mockMode = env.MOCK_MODE === 'true';
  const resolveFromRoot = (p: string) => path.resolve(rootDir, p);
  const mockDatabasePath = resolveFromRoot(MOCK_DATABASE_PATH);

  const port = parsePort(read(env, 'PORT'));
  const emailRedirectTo = read(env, 'EMAIL_REDIRECT_TO') ?? null;
  const schedulerValue = read(env, 'SCHEDULER_ENABLED');

  if (mockMode) {
    const cuit = read(env, 'ARCA_CUIT') ?? MOCK_ARCA_CUIT;
    assertValidCuit(cuit);
    return {
      mockMode,
      port,
      rootDir,
      // RF-211: en modo mock siempre la base propia, sin mirar DATABASE_PATH.
      databasePath: mockDatabasePath,
      // RF-207: sin definir, los procesos automáticos corren.
      schedulerEnabled: schedulerValue === undefined ? true : schedulerValue === 'true',
      systemMailbox: MOCK_MAILBOX,
      emailRedirectTo,
      anthropicApiKey: null,
      gmail: null,
      arca: { cuit, certPath: null, keyPath: null },
    };
  }

  const missing = REQUIRED_OUTSIDE_MOCK.filter((name) => read(env, name) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(
      `Faltan variables de entorno obligatorias: ${missing.join(', ')}. ` +
        'Completalas en .env (ver .env.example) o usá MOCK_MODE=true.',
    );
  }

  const databasePath = resolveFromRoot(read(env, 'DATABASE_PATH') ?? DEFAULT_DATABASE_PATH);
  // RF-212, RF-213: fuera del modo mock nunca se toca la base mock. Se compara sin
  // distinguir mayúsculas porque en macOS y Windows el filesystem no las distingue.
  if (databasePath.toLowerCase() === mockDatabasePath.toLowerCase()) {
    throw new ConfigError(
      `DATABASE_PATH apunta a ${MOCK_DATABASE_PATH}, que es la base del modo mock. ` +
        'Usá otra ruta o activá MOCK_MODE=true.',
    );
  }

  const cuit = read(env, 'ARCA_CUIT')!;
  assertValidCuit(cuit);

  return {
    mockMode,
    port,
    rootDir,
    databasePath,
    schedulerEnabled: schedulerValue === 'true',
    systemMailbox: read(env, 'GMAIL_USER')!,
    emailRedirectTo,
    anthropicApiKey: read(env, 'ANTHROPIC_API_KEY')!,
    gmail: { user: read(env, 'GMAIL_USER')!, appPassword: read(env, 'GMAIL_APP_PASSWORD')! },
    arca: {
      cuit,
      certPath: resolveFromRoot(read(env, 'ARCA_CERT_PATH')!),
      keyPath: resolveFromRoot(read(env, 'ARCA_KEY_PATH')!),
    },
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT debe ser un entero entre 1 y 65535 (recibido: "${value}").`);
  }
  return port;
}

function assertValidCuit(cuit: string): void {
  if (!isValidCuit(cuit)) {
    throw new ConfigError(
      `ARCA_CUIT debe ser un CUIT válido de 11 dígitos, sin guiones (recibido: "${cuit}").`,
    );
  }
}
