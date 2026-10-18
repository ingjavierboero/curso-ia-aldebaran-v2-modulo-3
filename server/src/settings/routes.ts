import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { requireRole } from '../auth/middleware.js';
import { settings } from '../db/schema.js';
import { parseBody } from '../http/validation.js';
import { getSettings, type Settings } from './settings.js';

/** RF-62, RF-152: "HH:MM" entre 00:00 y 23:39 (AC-62 y AC-160 rechazan 23:40). */
const time = (label: string) =>
  z
    .string({ error: `La ${label} es obligatoria.` })
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, `La ${label} debe tener el formato HH:MM.`)
    .refine((value) => value <= '23:39', `La ${label} debe estar entre 00:00 y 23:39.`);

const integer = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label} es obligatorio.` })
    .int(`${label} debe ser un número entero.`)
    .min(min, `${label} debe estar entre ${min} y ${max}.`)
    .max(max, `${label} debe estar entre ${min} y ${max}.`);

/** Texto opcional: vacío se guarda como null. */
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value ? value : null));

const settingsSchema = z.object({
  mailboxIntervalMinutes: integer('El intervalo de revisión de la casilla', 5, 60), // RF-100
  billingTime: time('hora de facturación'), // RF-62
  reminderTime: time('hora de recordatorios'), // RF-152
  retryCount: integer('La cantidad de reintentos', 0, 10), // RF-172
  retryWaitMinutes: integer('La espera entre reintentos', 1, 60), // RF-173
  pointOfSale: integer('El punto de venta', 1, 99_999), // RF-73
  // RF-91: datos de la empresa emisora.
  issuerBusinessName: optionalText,
  issuerAddress: optionalText,
  issuerIvaCondition: optionalText,
  issuerGrossIncomeNumber: optionalText,
  issuerActivityStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha de inicio de actividades debe tener el formato AAAA-MM-DD.')
    .nullish()
    .or(z.literal(''))
    .transform((value) => (value ? value : null)),
});

/** Lo que ve la web: la configuración más los datos que vienen del entorno. */
function present(ctx: AppContext, row: Settings) {
  const { id: _id, ...rest } = row;
  return { ...rest, issuerCuit: ctx.issuerCuit, mockMode: ctx.mockMode };
}

export function settingsRoutes(ctx: AppContext): Router {
  const router = Router();

  // Todos los perfiles ven la configuración (RF-06, RF-09, RF-11).
  router.get('/', (_req, res) => {
    res.json({ settings: present(ctx, getSettings(ctx.db)) });
  });

  // RF-10, RF-13: solo un Admin la modifica (AC-215). Se guarda todo o nada.
  router.put('/', requireRole('admin'), (req, res) => {
    const data = parseBody(settingsSchema, req, res);
    if (!data) return;
    getSettings(ctx.db);
    const row = ctx.db.update(settings).set(data).where(eq(settings.id, 1)).returning().get();
    res.json({ settings: present(ctx, row) });
  });

  return router;
}
