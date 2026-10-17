import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler } from 'express';
import { requireAuth } from './auth/middleware.js';
import { authRoutes, hasUsers, publicAuthRoutes } from './auth/routes.js';
import type { Db } from './db/index.js';

export interface AppContext {
  db: Db;
  /** Reloj inyectable para poder testear vencimientos. */
  now: () => Date;
  /** Cookies solo por HTTPS (producción). */
  secureCookies: boolean;
  mockMode: boolean;
}

export interface AppOptions {
  db: Db;
  now?: () => Date;
  secureCookies?: boolean;
  mockMode?: boolean;
}

export function createApp(options: AppOptions) {
  const ctx: AppContext = {
    db: options.db,
    now: options.now ?? (() => new Date()),
    secureCookies: options.secureCookies ?? false,
    mockMode: options.mockMode ?? false,
  };

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // --- Rutas públicas (RF-01) ---
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  // Lo que la web necesita antes de iniciar sesión: el indicador de modo mock
  // (RF-209) y si tiene que mostrar el registro del primer Admin (RF-04).
  app.get('/api/app-info', (_req, res) => {
    res.json({ mockMode: ctx.mockMode, needsSetup: !hasUsers(ctx) });
  });
  app.use('/api/auth', publicAuthRoutes(ctx));

  // --- A partir de acá, todo exige sesión ---
  app.use('/api', requireAuth(ctx));
  app.use('/api/auth', authRoutes(ctx));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'No encontrado.' });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    // Body con JSON mal formado.
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'El cuerpo de la solicitud no es JSON válido.' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  };
  app.use(errorHandler);

  return app;
}
