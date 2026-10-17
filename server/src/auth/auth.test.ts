import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { users } from '../db/schema.js';
import { startTestApp, type TestApp } from '../test/http.js';
import { hashPassword } from './password.js';

const ADMIN = { name: 'Javier', email: 'javier@aldebaran.com', password: '12345678' };
const HOUR = 60 * 60 * 1000;

let app: TestApp;

afterEach(async () => {
  await app?.close();
});

/** App con un reloj que el test puede adelantar. */
async function startWithClock() {
  let now = new Date('2026-10-16T12:00:00-03:00');
  app = await startTestApp({ now: () => now });
  return { advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function registerAdmin() {
  const res = await app.request('POST', '/api/auth/setup', { body: ADMIN });
  expect(res.status).toBe(201);
  return res.sessionCookie!;
}

async function login(email: string, password: string) {
  return app.request('POST', '/api/auth/login', { body: { email, password } });
}

describe('registro del primer Admin', () => {
  it('se ofrece mientras no hay usuarios y deja de ofrecerse después (RF-04)', async () => {
    app = await startTestApp();
    expect((await app.request('GET', '/api/app-info')).body.needsSetup).toBe(true);

    await registerAdmin();

    expect((await app.request('GET', '/api/app-info')).body.needsSetup).toBe(false);
  });

  it('rechaza 7 caracteres y con 8 crea un Admin Activo que puede iniciar sesión (AC-03)', async () => {
    app = await startTestApp();

    const short = await app.request('POST', '/api/auth/setup', { body: { ...ADMIN, password: '1234567' } });
    expect(short.status).toBe(400);
    expect(app.db.select().from(users).all()).toHaveLength(0);

    const res = await app.request('POST', '/api/auth/setup', { body: ADMIN });
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: 1, name: 'Javier', email: ADMIN.email, role: 'admin' });
    expect(res.sessionCookie).toBeDefined();

    const [user] = app.db.select().from(users).all();
    expect(user).toMatchObject({ role: 'admin', status: 'activo' });
    expect((await login(ADMIN.email, ADMIN.password)).status).toBe(200);
  });

  it('valida nombre y email', async () => {
    app = await startTestApp();
    expect((await app.request('POST', '/api/auth/setup', { body: { ...ADMIN, name: ' ' } })).status).toBe(400);
    expect((await app.request('POST', '/api/auth/setup', { body: { ...ADMIN, email: 'no-es-email' } })).status).toBe(400);
  });

  it('rechaza un segundo registro una vez que existe un usuario (RF-05, AC-212)', async () => {
    app = await startTestApp();
    await registerAdmin();

    const res = await app.request('POST', '/api/auth/setup', {
      body: { name: 'Otro', email: 'otro@aldebaran.com', password: '12345678' },
    });

    expect(res.status).toBe(403);
    expect(res.sessionCookie).toBeUndefined();
    expect(app.db.select().from(users).all()).toHaveLength(1);
  });

  it('dos registros simultáneos crean un solo usuario', async () => {
    app = await startTestApp();
    const results = await Promise.all([
      app.request('POST', '/api/auth/setup', { body: ADMIN }),
      app.request('POST', '/api/auth/setup', { body: { ...ADMIN, email: 'otro@aldebaran.com' } }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(app.db.select().from(users).all()).toHaveLength(1);
  });

  it('guarda la contraseña con bcrypt de costo 12, nunca en texto plano (RNF-09, AC-224)', async () => {
    app = await startTestApp();
    await registerAdmin();

    const [user] = app.db.select().from(users).all();
    expect(user?.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(user?.passwordHash).not.toContain(ADMIN.password);
  });
});

describe('inicio y cierre de sesión', () => {
  it('inicia sesión con email y contraseña, y rechaza una contraseña incorrecta (AC-01)', async () => {
    app = await startTestApp();
    await registerAdmin();

    const ok = await login(ADMIN.email, ADMIN.password);
    expect(ok.status).toBe(200);
    expect(ok.sessionCookie).toBeDefined();
    expect((await app.request('GET', '/api/auth/me', { cookie: ok.sessionCookie })).status).toBe(200);

    const wrong = await login(ADMIN.email, 'otra-clave');
    expect(wrong.status).toBe(401);
    expect(wrong.sessionCookie).toBeUndefined();
  });

  it('no distingue mayúsculas en el email', async () => {
    app = await startTestApp();
    await registerAdmin();
    expect((await login('Javier@Aldebaran.COM', ADMIN.password)).status).toBe(200);
  });

  it('responde igual para un email inexistente que para una contraseña incorrecta', async () => {
    app = await startTestApp();
    await registerAdmin();

    const unknown = await login('nadie@aldebaran.com', ADMIN.password);
    const wrong = await login(ADMIN.email, 'otra-clave');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('no permite iniciar sesión a un usuario Inactivo (RF-02)', async () => {
    app = await startTestApp();
    app.db
      .insert(users)
      .values({ name: 'Ex', email: 'ex@aldebaran.com', role: 'editor', status: 'inactivo', passwordHash: await hashPassword('12345678') })
      .run();

    expect((await login('ex@aldebaran.com', '12345678')).status).toBe(401);
  });

  it('cierra la sesión y rechaza las solicitudes posteriores con esa sesión (RF-03, AC-02)', async () => {
    app = await startTestApp();
    const cookie = await registerAdmin();

    expect((await app.request('POST', '/api/auth/logout', { cookie })).status).toBe(204);
    expect((await app.request('GET', '/api/auth/me', { cookie })).status).toBe(401);
  });

  it('invalida la sesión de un usuario que pasa a Inactivo', async () => {
    app = await startTestApp();
    const cookie = await registerAdmin();

    app.db.update(users).set({ status: 'inactivo' }).where(eq(users.email, ADMIN.email)).run();

    expect((await app.request('GET', '/api/auth/me', { cookie })).status).toBe(401);
  });
});

describe('control de acceso (RF-01, AC-211)', () => {
  it.each([
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/clientes'],
    ['POST', '/api/cualquier-cosa'],
  ])('%s %s sin sesión responde 401 sin datos', async (method, path) => {
    app = await startTestApp();
    await registerAdmin();

    const res = await app.request(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Tenés que iniciar sesión.' });
  });

  it('rechaza un token de sesión inventado', async () => {
    app = await startTestApp();
    await registerAdmin();
    expect((await app.request('GET', '/api/auth/me', { cookie: 'token-falso' })).status).toBe(401);
  });

  it('con sesión, una ruta inexistente responde 404', async () => {
    app = await startTestApp();
    const cookie = await registerAdmin();
    expect((await app.request('GET', '/api/no-existe', { cookie })).status).toBe(404);
  });

  it('/me devuelve el usuario sin el hash de la contraseña (RF-07, AC-05)', async () => {
    app = await startTestApp();
    const cookie = await registerAdmin();

    const res = await app.request('GET', '/api/auth/me', { cookie });
    expect(res.body).toEqual({ user: { id: 1, name: 'Javier', email: ADMIN.email, role: 'admin' } });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });
});

describe('expiración por inactividad (RNF-10)', () => {
  it('con última actividad hace 23 h, la acción se ejecuta (AC-223)', async () => {
    const clock = await startWithClock();
    const cookie = await registerAdmin();

    clock.advance(23 * HOUR);
    expect((await app.request('GET', '/api/auth/me', { cookie })).status).toBe(200);
  });

  it('cada acción renueva la inactividad', async () => {
    const clock = await startWithClock();
    const cookie = await registerAdmin();

    clock.advance(23 * HOUR);
    await app.request('GET', '/api/auth/me', { cookie });
    clock.advance(23 * HOUR);
    expect((await app.request('GET', '/api/auth/me', { cookie })).status).toBe(200);
  });

  it('tras 24 h sin actividad exige iniciar sesión de nuevo (AC-222)', async () => {
    const clock = await startWithClock();
    const cookie = await registerAdmin();

    clock.advance(24 * HOUR);
    expect((await app.request('GET', '/api/auth/me', { cookie })).status).toBe(401);

    // La sesión vencida no revive aunque se reintente.
    expect((await app.request('GET', '/api/auth/me', { cookie })).status).toBe(401);
  });
});
