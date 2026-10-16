import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const ROOT = path.resolve('/repo');

const REAL_ENV = {
  ANTHROPIC_API_KEY: 'sk-test',
  GMAIL_USER: 'aldebaran@gmail.com',
  GMAIL_APP_PASSWORD: 'app-password',
  ARCA_CUIT: '30711111111',
  ARCA_CERT_PATH: 'certs/arca.crt',
  ARCA_KEY_PATH: 'certs/arca.key',
};

describe('loadConfig en modo mock', () => {
  it('arranca con MOCK_MODE como única variable (RF-205, RF-206, RF-207)', () => {
    const config = loadConfig({ MOCK_MODE: 'true' }, ROOT);

    expect(config.mockMode).toBe(true);
    expect(config.databasePath).toBe(path.join(ROOT, 'data/aldebaran-mock.db'));
    expect(config.arca.cuit).toBe('20111111112');
    expect(config.schedulerEnabled).toBe(true);
    expect(config.systemMailbox).toBe('aldebaran-mock@gmail.com');
    expect(config.port).toBe(3000);
    expect(config.anthropicApiKey).toBeNull();
    expect(config.gmail).toBeNull();
  });

  it('ignora DATABASE_PATH y usa siempre la base mock (RF-211, AC-209)', () => {
    const config = loadConfig({ MOCK_MODE: 'true', DATABASE_PATH: 'data/aldebaran.db' }, ROOT);
    expect(config.databasePath).toBe(path.join(ROOT, 'data/aldebaran-mock.db'));
  });

  it('usa ARCA_CUIT cuando está definida (AC-205)', () => {
    const config = loadConfig({ MOCK_MODE: 'true', ARCA_CUIT: '30711111111' }, ROOT);
    expect(config.arca.cuit).toBe('30711111111');
  });

  it('respeta SCHEDULER_ENABLED cuando está definida', () => {
    expect(loadConfig({ MOCK_MODE: 'true', SCHEDULER_ENABLED: 'false' }, ROOT).schedulerEnabled).toBe(false);
    expect(loadConfig({ MOCK_MODE: 'true', SCHEDULER_ENABLED: 'true' }, ROOT).schedulerEnabled).toBe(true);
  });

  it('usa la casilla simulada aunque GMAIL_USER esté definida (RF-195)', () => {
    const config = loadConfig({ MOCK_MODE: 'true', GMAIL_USER: 'real@gmail.com' }, ROOT);
    expect(config.systemMailbox).toBe('aldebaran-mock@gmail.com');
    expect(config.gmail).toBeNull();
  });
});

describe('loadConfig fuera del modo mock', () => {
  it.each([undefined, 'false', 'TRUE', '1', ''])('MOCK_MODE=%s no activa el modo mock (RF-184)', (value) => {
    const config = loadConfig({ ...REAL_ENV, MOCK_MODE: value }, ROOT);
    expect(config.mockMode).toBe(false);
  });

  it('resuelve las rutas relativas desde la raíz del repo y usa los valores por defecto', () => {
    const config = loadConfig(REAL_ENV, ROOT);

    expect(config.databasePath).toBe(path.join(ROOT, 'data/aldebaran.db'));
    expect(config.arca.certPath).toBe(path.join(ROOT, 'certs/arca.crt'));
    expect(config.arca.keyPath).toBe(path.join(ROOT, 'certs/arca.key'));
    expect(config.schedulerEnabled).toBe(false);
    expect(config.systemMailbox).toBe('aldebaran@gmail.com');
    expect(config.anthropicApiKey).toBe('sk-test');
    expect(config.gmail).toEqual({ user: 'aldebaran@gmail.com', appPassword: 'app-password' });
  });

  it('activa los procesos automáticos solo con SCHEDULER_ENABLED=true', () => {
    expect(loadConfig({ ...REAL_ENV, SCHEDULER_ENABLED: 'true' }, ROOT).schedulerEnabled).toBe(true);
    expect(loadConfig({ ...REAL_ENV, SCHEDULER_ENABLED: 'yes' }, ROOT).schedulerEnabled).toBe(false);
  });

  it('informa todas las variables obligatorias que faltan, tratando las vacías como faltantes', () => {
    const env = { ...REAL_ENV, GMAIL_APP_PASSWORD: '  ', ARCA_KEY_PATH: undefined };
    expect(() => loadConfig(env, ROOT)).toThrow(ConfigError);
    expect(() => loadConfig(env, ROOT)).toThrow(/GMAIL_APP_PASSWORD, ARCA_KEY_PATH/);
  });

  it.each([
    'data/aldebaran-mock.db',
    './data/../data/aldebaran-mock.db',
    'Data/Aldebaran-Mock.db',
    path.join(ROOT, 'data/aldebaran-mock.db'),
  ])('no arranca si DATABASE_PATH apunta a la base mock: %s (RF-213, AC-210)', (databasePath) => {
    expect(() => loadConfig({ ...REAL_ENV, DATABASE_PATH: databasePath }, ROOT)).toThrow(
      /base del modo mock/,
    );
  });

  it('acepta otra DATABASE_PATH', () => {
    const config = loadConfig({ ...REAL_ENV, DATABASE_PATH: '/var/lib/aldebaran.db' }, ROOT);
    expect(config.databasePath).toBe(path.resolve('/var/lib/aldebaran.db'));
  });
});

describe('validaciones comunes', () => {
  it.each(['0', '65536', 'abc', '3000.5'])('rechaza PORT=%s', (port) => {
    expect(() => loadConfig({ MOCK_MODE: 'true', PORT: port }, ROOT)).toThrow(/PORT/);
  });

  it('acepta un PORT válido', () => {
    expect(loadConfig({ MOCK_MODE: 'true', PORT: '8080' }, ROOT).port).toBe(8080);
  });

  it.each(['30-71111111-1', '3071111111', 'abcdefghijk'])('rechaza ARCA_CUIT=%s', (cuit) => {
    expect(() => loadConfig({ ...REAL_ENV, ARCA_CUIT: cuit }, ROOT)).toThrow(/ARCA_CUIT/);
    expect(() => loadConfig({ MOCK_MODE: 'true', ARCA_CUIT: cuit }, ROOT)).toThrow(/ARCA_CUIT/);
  });
});
