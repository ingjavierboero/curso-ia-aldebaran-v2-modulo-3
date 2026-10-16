import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from './index.js';
import { sessions, users } from './schema.js';

const handles: DatabaseHandle[] = [];
const tempDirs: string[] = [];

function open(databasePath = ':memory:') {
  const handle = openDatabase(databasePath);
  handles.push(handle);
  return handle.db;
}

afterEach(() => {
  handles.splice(0).forEach((h) => h.close());
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const ana = { name: 'Ana', email: 'ana@empresa.com', role: 'admin', passwordHash: 'hash' } as const;

describe('openDatabase', () => {
  it('crea la carpeta de la base y aplica las migraciones', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aldebaran-db-'));
    tempDirs.push(dir);
    const databasePath = path.join(dir, 'data', 'test.db');

    const db = open(databasePath);

    expect(existsSync(databasePath)).toBe(true);
    expect(db.select().from(users).all()).toEqual([]);
  });

  it('es idempotente: reabrir una base ya migrada no falla ni pierde datos', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aldebaran-db-'));
    tempDirs.push(dir);
    const databasePath = path.join(dir, 'test.db');

    const first = openDatabase(databasePath);
    first.db.insert(users).values(ana).run();
    first.close();

    expect(open(databasePath).select().from(users).all()).toHaveLength(1);
  });

  it('guarda un usuario Activo por defecto con sus timestamps', () => {
    const db = open();
    const [user] = db.insert(users).values(ana).returning().all();

    expect(user).toMatchObject({ email: 'ana@empresa.com', role: 'admin', status: 'activo' });
    expect(user?.createdAt).toBeInstanceOf(Date);
  });

  it('no permite dos usuarios con el mismo email sin distinguir mayúsculas (RF-15)', () => {
    const db = open();
    db.insert(users).values(ana).run();

    expect(() => db.insert(users).values({ ...ana, email: 'Ana@Empresa.com' }).run()).toThrow(
      /UNIQUE/,
    );
  });

  it('rechaza perfiles y estados fuera de los valores permitidos', () => {
    const db = open();
    // @ts-expect-error: perfil inválido a propósito
    expect(() => db.insert(users).values({ ...ana, role: 'superadmin' }).run()).toThrow(/CHECK/);
    // @ts-expect-error: estado inválido a propósito
    expect(() => db.insert(users).values({ ...ana, status: 'borrado' }).run()).toThrow(/CHECK/);
  });

  it('aplica las foreign keys: no hay sesiones de usuarios inexistentes', () => {
    const db = open();
    expect(() => db.insert(sessions).values({ id: 'x', userId: 999 }).run()).toThrow(/FOREIGN KEY/);
  });
});
