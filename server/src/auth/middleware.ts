import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '../app.js';
import { resolveSession, SESSION_COOKIE, type AuthUser } from './sessions.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Usuario autenticado; lo completa requireAuth. */
    user?: AuthUser;
  }
}

/** RF-01: rechaza cualquier request sin una sesión válida. */
export function requireAuth(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    const user = typeof token === 'string' ? resolveSession(ctx.db, token, ctx.now()) : null;

    if (!user) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(401).json({ error: 'Tenés que iniciar sesión.' });
      return;
    }

    req.user = user;
    next();
  };
}

/** Usuario autenticado de un request que ya pasó por requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new Error('currentUser usado en una ruta sin requireAuth');
  return req.user;
}
