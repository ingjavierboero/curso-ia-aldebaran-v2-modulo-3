import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { currentUser, requireRole } from '../auth/middleware.js';
import type { Db } from '../db/index.js';
import { clientProducts, products } from '../db/schema.js';
import { parseBody } from '../http/validation.js';
import { recordClientEvent } from './events.js';
import { findClient } from './lookup.js';

const assignSchema = z.object({
  productIds: z
    .array(z.number().int().positive(), { error: 'Elegí al menos un producto.' })
    .min(1, 'Elegí al menos un producto.'),
});

const canEdit = requireRole('admin', 'editor');

/** Productos asignados a un cliente. Se monta en /api/clients/:id/products. */
export function assignmentRoutes(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const client = findClient(ctx.db, req, res);
    if (client) res.json({ products: assignedProducts(ctx.db, client.id) });
  });

  // RF-49: asigna uno o varios productos Activos. Los que ya estaban asignados se ignoran.
  router.post('/', canEdit, (req, res) => {
    const client = findClient(ctx.db, req, res);
    if (!client) return;
    const data = parseBody(assignSchema, req, res);
    if (!data) return;

    const ids = [...new Set(data.productIds)];
    const found = ctx.db.select().from(products).where(inArray(products.id, ids)).all();
    if (found.length !== ids.length) {
      res.status(404).json({ error: 'Alguno de los productos no existe.' });
      return;
    }
    const inactive = found.filter((p) => p.status !== 'activo');
    if (inactive.length > 0) {
      res.status(409).json({
        error: `No se pueden asignar productos Inactivos: ${inactive.map((p) => p.name).join(', ')}.`,
      });
      return;
    }

    const already = new Set(assignedProducts(ctx.db, client.id).map((p) => p.id));
    const user = currentUser(req);
    ctx.db.transaction((tx) => {
      for (const product of found.filter((p) => !already.has(p.id))) {
        tx.insert(clientProducts).values({ clientId: client.id, productId: product.id }).run();
        recordClientEvent(tx, client.id, 'asignacion_producto', user.id, {
          productId: product.id,
          productName: product.name,
        });
      }
    });

    res.json({ products: assignedProducts(ctx.db, client.id) });
  });

  // RF-50: desasigna un producto del cliente.
  router.delete('/:productId', canEdit, (req, res) => {
    const client = findClient(ctx.db, req, res);
    if (!client) return;

    const productId = Number(req.params.productId);
    const assigned = assignedProducts(ctx.db, client.id).find((p) => p.id === productId);
    if (!assigned) {
      res.status(404).json({ error: 'El producto no está asignado a este cliente.' });
      return;
    }

    const user = currentUser(req);
    ctx.db.transaction((tx) => {
      tx.delete(clientProducts)
        .where(and(eq(clientProducts.clientId, client.id), eq(clientProducts.productId, productId)))
        .run();
      recordClientEvent(tx, client.id, 'desasignacion_producto', user.id, {
        productId,
        productName: assigned.name,
      });
    });

    res.json({ products: assignedProducts(ctx.db, client.id) });
  });

  return router;
}

/** Productos asignados al cliente, Activos e Inactivos, con la fecha de asignación. */
export function assignedProducts(db: Db, clientId: number) {
  return db
    .select({
      id: products.id,
      name: products.name,
      priceCents: products.priceCents,
      currency: products.currency,
      status: products.status,
      assignedAt: clientProducts.createdAt,
    })
    .from(clientProducts)
    .innerJoin(products, eq(products.id, clientProducts.productId))
    .where(eq(clientProducts.clientId, clientId))
    .orderBy(asc(sql`lower(${products.name})`))
    .all();
}
