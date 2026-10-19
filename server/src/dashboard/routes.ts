import { asc, count, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../app.js';
import { clients, invoices, processErrors } from '../db/schema.js';

/** Dashboard principal (RF-153, RF-181). Todos los perfiles lo ven. */
export function dashboardRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    // RF-153: clientes con deuda vigente, con su deuda total, cantidad de facturas
    // adeudadas y si están en revisión (al menos una factura en Revisión manual).
    const debtors = ctx.db
      .select({
        id: clients.id,
        businessName: clients.businessName,
        status: clients.status,
        debtCents: sql<number>`sum(${invoices.totalCents})`,
        owedCount: count(invoices.id),
        inReview: sql<number>`max(${invoices.status} = 'revision_manual')`,
        oldestDueDate: sql<string>`min(${invoices.paymentDueDate})`,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(inArray(invoices.status, ['pendiente_pago', 'revision_manual']))
      .groupBy(clients.id)
      .orderBy(asc(sql`lower(${clients.businessName})`))
      .all()
      .map((d) => ({ ...d, inReview: d.inReview === 1 }));

    // RF-181: banner de errores mientras haya errores de proceso Pendientes.
    const [errors] = ctx.db.select({ total: count() }).from(processErrors).where(eq(processErrors.status, 'pendiente')).all();

    res.json({ debtors, pendingErrors: errors?.total ?? 0 });
  });

  return router;
}
