import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler } from 'express';
import { requireAuth } from './auth/middleware.js';
import { authRoutes, hasUsers, publicAuthRoutes } from './auth/routes.js';
import { billingRoutes } from './billing/routes.js';
import type { BillingRunner } from './billing/runner.js';
import { clientRoutes } from './clients/routes.js';
import type { Db } from './db/index.js';
import { invoiceRoutes } from './invoices/routes.js';
import { mockMailboxRoutes } from './mailbox/mock-routes.js';
import { productRoutes } from './products/routes.js';
import { receivedEmailRoutes, reviewRoutes } from './review/routes.js';
import { settingsRoutes } from './settings/routes.js';

export interface AppContext {
  db: Db;
  /** Reloj inyectable para poder testear vencimientos. */
  now: () => Date;
  /** Cookies solo por HTTPS (producción). */
  secureCookies: boolean;
  mockMode: boolean;
  /** CUIT del emisor (ARCA_CUIT). */
  issuerCuit: string;
  /** Casilla del sistema (GMAIL_USER o la simulada en modo mock). */
  systemMailbox: string;
  billing: BillingRunner;
}

export interface AppOptions {
  db: Db;
  now?: () => Date;
  secureCookies?: boolean;
  mockMode?: boolean;
  issuerCuit?: string;
  systemMailbox?: string;
  billing: BillingRunner;
}

export function createApp(options: AppOptions) {
  const ctx: AppContext = {
    db: options.db,
    now: options.now ?? (() => new Date()),
    secureCookies: options.secureCookies ?? false,
    mockMode: options.mockMode ?? false,
    issuerCuit: options.issuerCuit ?? '20111111112',
    systemMailbox: options.systemMailbox ?? 'aldebaran-mock@gmail.com',
    billing: options.billing,
  };

  const app = express();
  // Los emails cargados en la casilla simulada traen sus adjuntos en base64.
  app.use(express.json({ limit: '25mb' }));
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
  app.use('/api/clients', clientRoutes(ctx));
  app.use('/api/products', productRoutes(ctx));
  app.use('/api/invoices', invoiceRoutes(ctx));
  app.use('/api/billing', billingRoutes(ctx));
  app.use('/api/mock-mailbox', mockMailboxRoutes(ctx));
  app.use('/api/review', reviewRoutes(ctx));
  app.use('/api/received-emails', receivedEmailRoutes(ctx));
  app.use('/api/settings', settingsRoutes(ctx));

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
