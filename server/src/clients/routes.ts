import { and, asc, eq, ne, or, sql, type SQL } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { currentUser, requireRole } from '../auth/middleware.js';
import type { Db } from '../db/index.js';
import {
  ACTIVE_STATUSES,
  clientEvents,
  clients,
  IVA_CONDITION_CODES,
  type ClientEventType,
  type IvaCondition,
} from '../db/schema.js';
import { isValidCuit, normalizeCuit } from '../domain/cuit.js';
import { parseBody } from '../http/validation.js';

const clientSchema = z.object({
  businessName: z.string().trim().min(1, 'La razón social es obligatoria.'),
  cuit: z
    .string({ error: 'El CUIT es obligatorio.' })
    .transform(normalizeCuit)
    .refine((cuit) => cuit.length > 0, 'El CUIT es obligatorio.')
    .refine(isValidCuit, 'El CUIT no es válido: revisá los 11 dígitos y el dígito verificador.'),
  address: z
    .string({ error: 'El domicilio es obligatorio.' })
    .trim()
    .min(1, 'El domicilio es obligatorio.'),
  billingEmail: z
    .string({ error: 'El email de facturación es obligatorio.' })
    .trim()
    .min(1, 'El email de facturación es obligatorio.')
    .pipe(z.email('El email de facturación no es válido.')),
  ivaCondition: z
    .number({ error: 'La condición frente al IVA es obligatoria.' })
    .refine(
      (code): code is IvaCondition => IVA_CONDITION_CODES.includes(code as IvaCondition),
      'La condición frente al IVA no es válida.',
    ),
});
type ClientInput = z.infer<typeof clientSchema>;

const listQuerySchema = z.object({
  status: z.enum(ACTIVE_STATUSES).optional(),
  q: z.string().trim().optional(),
});

/** Campos que se comparan para registrar una modificación en el historial. */
const EDITABLE_FIELDS = ['businessName', 'cuit', 'address', 'billingEmail', 'ivaCondition'] as const;

const canEdit = requireRole('admin', 'editor');

export function clientRoutes(ctx: AppContext): Router {
  const router = Router();

  // RF-158, RF-169: listado con filtro por estado y búsqueda por razón social o CUIT.
  router.get('/', (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'Filtro inválido.' });
      return;
    }
    const { status, q } = query.data;

    const conditions: SQL[] = [];
    if (status) conditions.push(eq(clients.status, status));
    if (q) conditions.push(searchCondition(q));

    const rows = ctx.db
      .select()
      .from(clients)
      .where(and(...conditions))
      .orderBy(asc(sql`lower(${clients.businessName})`))
      .all();
    res.json({ clients: rows });
  });

  router.get('/:id', (req, res) => {
    const client = findClient(ctx.db, req, res);
    if (client) res.json({ client });
  });

  // RF-34: alta de un cliente, que queda Activo.
  router.post('/', canEdit, (req, res) => {
    const data = parseBody(clientSchema, req, res);
    if (!data || rejectDuplicates(ctx.db, data, res)) return;

    const user = currentUser(req);
    const client = ctx.db.transaction((tx) => {
      const created = tx.insert(clients).values({ ...data, status: 'activo' }).returning().get();
      recordEvent(tx, created.id, 'alta', user.id, null);
      return created;
    });
    res.status(201).json({ client });
  });

  // RF-35: modificación de razón social, CUIT, domicilio, email de facturación y condición frente al IVA.
  router.put('/:id', canEdit, (req, res) => {
    const existing = findClient(ctx.db, req, res);
    if (!existing) return;
    const data = parseBody(clientSchema, req, res);
    if (!data || rejectDuplicates(ctx.db, data, res, existing.id)) return;

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of EDITABLE_FIELDS) {
      if (existing[field] !== data[field]) changes[field] = { from: existing[field], to: data[field] };
    }
    if (Object.keys(changes).length === 0) {
      res.json({ client: existing });
      return;
    }

    const user = currentUser(req);
    const client = ctx.db.transaction((tx) => {
      const updated = tx.update(clients).set(data).where(eq(clients.id, existing.id)).returning().get();
      recordEvent(tx, existing.id, 'modificacion', user.id, { changes });
      return updated;
    });
    res.json({ client });
  });

  // RF-36: baja (pasa a Inactivo).
  router.post('/:id/deactivate', canEdit, (req, res) => {
    changeStatus(ctx, req, res, 'inactivo');
  });

  // RF-37: reactivación (vuelve a Activo).
  router.post('/:id/reactivate', canEdit, (req, res) => {
    changeStatus(ctx, req, res, 'activo');
  });

  return router;
}

/** Busca por razón social (sin distinguir mayúsculas) o por CUIT (solo sus dígitos). */
function searchCondition(q: string): SQL {
  const escaped = q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const byName = sql`lower(${clients.businessName}) like ${`%${escaped}%`} escape '\\'`;
  const digits = normalizeCuit(q);
  return digits ? or(byName, sql`${clients.cuit} like ${`%${digits}%`}`)! : byName;
}

function findClient(db: Db, req: Request, res: Response) {
  const id = Number(req.params.id);
  const client = Number.isInteger(id) && id > 0
    ? db.select().from(clients).where(eq(clients.id, id)).get()
    : undefined;
  if (!client) res.status(404).json({ error: 'El cliente no existe.' });
  return client;
}

/** RF-40, RF-41: responde 409 si el CUIT o el email ya los tiene otro cliente. */
function rejectDuplicates(db: Db, data: ClientInput, res: Response, excludeId?: number): boolean {
  const others = excludeId === undefined ? undefined : ne(clients.id, excludeId);

  const sameCuit = db.select({ id: clients.id }).from(clients)
    .where(and(eq(clients.cuit, data.cuit), others)).get();
  if (sameCuit) {
    res.status(409).json({ error: 'Ya existe otro cliente con ese CUIT.' });
    return true;
  }

  const sameEmail = db.select({ id: clients.id }).from(clients)
    .where(and(eq(sql`lower(${clients.billingEmail})`, data.billingEmail.toLowerCase()), others))
    .get();
  if (sameEmail) {
    res.status(409).json({ error: 'Ya existe otro cliente con ese email de facturación.' });
    return true;
  }
  return false;
}

function changeStatus(ctx: AppContext, req: Request, res: Response, status: 'activo' | 'inactivo') {
  const existing = findClient(ctx.db, req, res);
  if (!existing) return;
  if (existing.status === status) {
    const label = status === 'activo' ? 'Activo' : 'Inactivo';
    res.status(409).json({ error: `El cliente ya está ${label}.` });
    return;
  }

  const user = currentUser(req);
  const client = ctx.db.transaction((tx) => {
    const updated = tx.update(clients).set({ status }).where(eq(clients.id, existing.id)).returning().get();
    recordEvent(tx, existing.id, status === 'activo' ? 'reactivacion' : 'baja', user.id, null);
    return updated;
  });
  res.json({ client });
}

function recordEvent(
  db: Pick<Db, 'insert'>,
  clientId: number,
  type: ClientEventType,
  userId: number | null,
  data: Record<string, unknown> | null,
) {
  db.insert(clientEvents).values({ clientId, type, userId, data }).run();
}
