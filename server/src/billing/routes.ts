import { Router, type Response } from 'express';
import type { AppContext } from '../app.js';
import { currentUser, requireRole } from '../auth/middleware.js';
import { BillingStateError, type BillingStatus } from './runner.js';

const adminOnly = requireRole('admin');

/** Facturación del mes en curso: estado, "Facturar ahora", cancelar y reactivar. */
export function billingRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/current', (_req, res) => {
    res.json({ billing: ctx.billing.status() });
  });

  // RF-58, RF-60, RF-61: solo un Admin, y rechazado si está cancelado, en curso o hecho (AC-59, AC-60).
  router.post('/run', adminOnly, (req, res) => {
    respond(res, 202, () => ctx.billing.runNow(currentUser(req).id));
  });

  // RF-54: solo mientras el proceso del mes no haya empezado (AC-56).
  router.post('/cancel', adminOnly, (req, res) => {
    respond(res, 200, () => ctx.billing.cancel(currentUser(req).id));
  });

  // RF-56, RF-57.
  router.post('/reactivate', adminOnly, (_req, res) => {
    respond(res, 200, () => ctx.billing.reactivate());
  });

  return router;
}

function respond(res: Response, status: number, action: () => BillingStatus) {
  try {
    res.status(status).json({ billing: action() });
  } catch (error) {
    if (!(error instanceof BillingStateError)) throw error;
    res.status(409).json({ error: error.message });
  }
}
