import { asc, eq, sql } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { requireRole } from '../auth/middleware.js';
import type { Db } from '../db/index.js';
import { ACTIVE_STATUSES, CURRENCIES, products } from '../db/schema.js';
import { parseBody } from '../http/validation.js';

const productSchema = z.object({
  name: z.string({ error: 'El nombre es obligatorio.' }).trim().min(1, 'El nombre es obligatorio.'),
  // RF-44, RNF-13: precio en centavos, entero y mayor a cero.
  priceCents: z
    .number({ error: 'El precio es obligatorio.' })
    .int('El precio no puede tener fracciones de centavo.')
    .positive('El precio debe ser mayor a cero.'),
  // RF-43: pesos o dólares.
  currency: z.enum(CURRENCIES, { error: 'La moneda debe ser ARS o USD.' }),
});

const listQuerySchema = z.object({ status: z.enum(ACTIVE_STATUSES).optional() });

const canEdit = requireRole('admin', 'editor');

export function productRoutes(ctx: AppContext): Router {
  const router = Router();

  // RF-159: listado de productos Activos e Inactivos.
  router.get('/', (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'Filtro inválido.' });
      return;
    }
    const rows = ctx.db
      .select()
      .from(products)
      .where(query.data.status ? eq(products.status, query.data.status) : undefined)
      .orderBy(asc(sql`lower(${products.name})`))
      .all();
    res.json({ products: rows });
  });

  // RF-42, RF-43: alta con nombre, precio y moneda; queda Activo.
  router.post('/', canEdit, (req, res) => {
    const data = parseBody(productSchema, req, res);
    if (!data) return;
    const product = ctx.db.insert(products).values({ ...data, status: 'activo' }).returning().get();
    res.status(201).json({ product });
  });

  // RF-45, RF-46: modificación del nombre, el precio y la moneda. Las facturas ya
  // emitidas guardan su propio detalle, así que no cambian.
  router.put('/:id', canEdit, (req, res) => {
    const existing = findProduct(ctx.db, req, res);
    if (!existing) return;
    const data = parseBody(productSchema, req, res);
    if (!data) return;
    const product = ctx.db.update(products).set(data).where(eq(products.id, existing.id)).returning().get();
    res.json({ product });
  });

  // RF-47: desactivación (pasa a Inactivo). Las asignaciones se conservan, pero un
  // producto Inactivo no se factura ni se puede asignar.
  router.post('/:id/deactivate', canEdit, (req, res) => {
    changeStatus(ctx, req, res, 'inactivo');
  });

  // RF-48: reactivación (vuelve a Activo).
  router.post('/:id/reactivate', canEdit, (req, res) => {
    changeStatus(ctx, req, res, 'activo');
  });

  return router;
}

function findProduct(db: Db, req: Request, res: Response) {
  const id = Number(req.params.id);
  const product =
    Number.isInteger(id) && id > 0
      ? db.select().from(products).where(eq(products.id, id)).get()
      : undefined;
  if (!product) res.status(404).json({ error: 'El producto no existe.' });
  return product;
}

function changeStatus(ctx: AppContext, req: Request, res: Response, status: 'activo' | 'inactivo') {
  const existing = findProduct(ctx.db, req, res);
  if (!existing) return;
  if (existing.status === status) {
    res.status(409).json({ error: `El producto ya está ${status === 'activo' ? 'Activo' : 'Inactivo'}.` });
    return;
  }
  const product = ctx.db.update(products).set({ status }).where(eq(products.id, existing.id)).returning().get();
  res.json({ product });
}
