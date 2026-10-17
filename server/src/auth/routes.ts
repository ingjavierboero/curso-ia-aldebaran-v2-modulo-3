import { count, eq, sql } from 'drizzle-orm';
import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { users } from '../db/schema.js';
import { parseBody } from '../http/validation.js';
import { currentUser } from './middleware.js';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from './password.js';
import { createSession, deleteSession, SESSION_COOKIE } from './sessions.js';

const email = z.string().trim().pipe(z.email('El email no es válido.'));

const setupSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio.'),
  email,
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`),
});

const loginSchema = z.object({
  email: z.string().trim().min(1, 'El email es obligatorio.'),
  password: z.string().min(1, 'La contraseña es obligatoria.'),
});

const INVALID_CREDENTIALS = 'Email o contraseña incorrectos.';

export function hasUsers(ctx: AppContext): boolean {
  const [row] = ctx.db.select({ total: count() }).from(users).all();
  return (row?.total ?? 0) > 0;
}

/** Rutas que no exigen sesión (RF-01). */
export function publicAuthRoutes(ctx: AppContext): Router {
  const router = Router();

  const cookieOptions: CookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.secureCookies,
    path: '/',
  };
  const startSession = (res: Response, userId: number) => {
    res.cookie(SESSION_COOKIE, createSession(ctx.db, userId, ctx.now()), cookieOptions);
  };

  // RF-04, RF-05: registro del primer Admin, solo con la base sin usuarios.
  router.post('/setup', async (req, res) => {
    const data = parseBody(setupSchema, req, res);
    if (!data) return;
    if (hasUsers(ctx)) {
      res.status(403).json({ error: 'El sistema ya tiene usuarios registrados.' });
      return;
    }

    const passwordHash = await hashPassword(data.password);
    // El chequeo se repite dentro de la transacción porque el hash es asíncrono y
    // otro registro pudo completarse mientras tanto.
    const user = ctx.db.transaction((tx) => {
      const [row] = tx.select({ total: count() }).from(users).all();
      if ((row?.total ?? 0) > 0) return null;
      return tx
        .insert(users)
        .values({ name: data.name, email: data.email, role: 'admin', status: 'activo', passwordHash })
        .returning({ id: users.id, name: users.name, email: users.email, role: users.role })
        .get();
    });

    if (!user) {
      res.status(403).json({ error: 'El sistema ya tiene usuarios registrados.' });
      return;
    }

    startSession(res, user.id);
    res.status(201).json({ user });
  });

  // RF-02: inicio de sesión de un usuario Activo con email y contraseña.
  router.post('/login', async (req, res) => {
    const data = parseBody(loginSchema, req, res);
    if (!data) return;

    const user = ctx.db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, data.email.toLowerCase()))
      .get();

    const passwordOk = await verifyPassword(data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordOk || user.status !== 'activo') {
      res.status(401).json({ error: INVALID_CREDENTIALS });
      return;
    }

    startSession(res, user.id);
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });

  return router;
}

/** Rutas de auth que exigen sesión. */
export function authRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/me', (req, res) => {
    res.json({ user: currentUser(req) });
  });

  // RF-03: cierre de sesión; la sesión queda invalidada en el server.
  router.post('/logout', (req, res) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') deleteSession(ctx.db, token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  return router;
}
