import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientEvents, clients } from '../db/schema.js';
import { startTestApp, type TestApp } from '../test/http.js';

const LOS_ANDES = {
  businessName: 'Los Andes SA',
  cuit: '30711111111',
  address: 'Av. Siempre Viva 742, Mendoza',
  billingEmail: 'pagos@losandes.com',
  ivaCondition: 1,
};
const PAMPA = {
  businessName: 'Pampa SRL',
  cuit: '20111111112',
  address: 'Ruta 5 km 100, Santa Rosa, La Pampa',
  billingEmail: 'admin@pampa.com',
  ivaCondition: 6,
};

let app: TestApp;
let admin: string;

beforeEach(async () => {
  app = await startTestApp();
  admin = await app.loginAs('admin');
});

afterEach(async () => {
  await app.close();
});

const create = (body: unknown, cookie = admin) => app.request('POST', '/api/clients', { body, cookie });
const update = (id: number, body: unknown, cookie = admin) =>
  app.request('PUT', `/api/clients/${id}`, { body, cookie });
const list = (query = '', cookie = admin) => app.request('GET', `/api/clients${query}`, { cookie });
const allClients = () => app.db.select().from(clients).all();

/** Inserta un cliente directo en la base (para datos que la API no permite cargar). */
function insertClient(values: typeof clients.$inferInsert) {
  return app.db.insert(clients).values(values).returning().get();
}

describe('alta de clientes', () => {
  it.each(['admin', 'editor'] as const)(
    '%s da de alta un cliente que queda Activo y visible en el listado (AC-34, AC-08)',
    async (role) => {
      const cookie = await app.loginAs(role);
      const res = await create(LOS_ANDES, cookie);

      expect(res.status).toBe(201);
      expect(res.body.client).toMatchObject({ ...LOS_ANDES, status: 'activo' });
      expect((await list()).body.clients).toHaveLength(1);
    },
  );

  it.each(['businessName', 'cuit', 'address', 'billingEmail', 'ivaCondition'] as const)(
    'rechaza el alta sin %s (AC-34, AC-40)',
    async (field) => {
      const { [field]: _omitted, ...body } = LOS_ANDES;
      expect((await create(body)).status).toBe(400);
      expect((await create({ ...LOS_ANDES, [field]: '' })).status).toBe(400);
      expect(allClients()).toHaveLength(0);
    },
  );

  it.each([2, 3, 11, 0, 99])('rechaza la condición frente al IVA %s (RF-38, AC-40)', async (ivaCondition) => {
    expect((await create({ ...LOS_ANDES, ivaCondition })).status).toBe(400);
    expect(allClients()).toHaveLength(0);
  });

  it.each([1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16])('acepta la condición frente al IVA %s (RF-38)', async (ivaCondition) => {
    expect((await create({ ...LOS_ANDES, ivaCondition })).status).toBe(201);
  });

  it('rechaza un CUIT con dígito verificador inválido y acepta el válido (RF-39, AC-41)', async () => {
    const invalid = await create({ ...LOS_ANDES, cuit: '30711111118' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/CUIT/);
    expect(allClients()).toHaveLength(0);

    expect((await create(LOS_ANDES)).status).toBe(201);
  });

  it('guarda el CUIT solo con dígitos aunque se ingrese con guiones', async () => {
    const res = await create({ ...LOS_ANDES, cuit: '30-71111111-1' });
    expect(res.body.client.cuit).toBe('30711111111');
  });

  it('rechaza un email de facturación inválido', async () => {
    expect((await create({ ...LOS_ANDES, billingEmail: 'no-es-email' })).status).toBe(400);
  });

  it('rechaza un CUIT o un email (sin distinguir mayúsculas) que ya tiene otro cliente (RF-40, RF-41, AC-42)', async () => {
    insertClient({ ...LOS_ANDES, cuit: '30711111118' });

    const sameCuit = await create({ ...PAMPA, cuit: '30711111118' });
    // El CUIT del cliente existente no es válido, así que el alta ya falla por eso;
    // el chequeo de duplicado se prueba con un CUIT válido abajo.
    expect(sameCuit.status).toBe(400);

    const sameEmail = await create({ ...PAMPA, billingEmail: 'Pagos@LosAndes.com' });
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body.error).toMatch(/email/);

    insertClient({ ...PAMPA, billingEmail: 'otro@pampa.com' });
    const duplicateCuit = await create({ ...PAMPA, billingEmail: 'nuevo@pampa.com' });
    expect(duplicateCuit.status).toBe(409);
    expect(duplicateCuit.body.error).toMatch(/CUIT/);

    expect(allClients()).toHaveLength(2);
  });
});

describe('modificación de clientes (RF-35)', () => {
  it('modifica los cuatro datos y registra en el historial qué cambió', async () => {
    const { client } = (await create(LOS_ANDES)).body;

    const changed = {
      ...LOS_ANDES,
      businessName: 'Los Andes SAU',
      address: 'San Martín 100, Mendoza',
      billingEmail: 'cobranzas@losandes.com',
      ivaCondition: 6,
    };
    const res = await update(client.id, changed);

    expect(res.status).toBe(200);
    expect(res.body.client).toMatchObject(changed);

    const events = app.db.select().from(clientEvents).where(eq(clientEvents.clientId, client.id))
      .orderBy(asc(clientEvents.id)).all();
    expect(events.map((e) => e.type)).toEqual(['alta', 'modificacion']);
    expect(events[1]?.data).toEqual({
      changes: {
        businessName: { from: 'Los Andes SA', to: 'Los Andes SAU' },
        address: { from: 'Av. Siempre Viva 742, Mendoza', to: 'San Martín 100, Mendoza' },
        billingEmail: { from: 'pagos@losandes.com', to: 'cobranzas@losandes.com' },
        ivaCondition: { from: 1, to: 6 },
      },
    });
  });

  it('no registra una modificación si no cambió nada', async () => {
    const { client } = (await create(LOS_ANDES)).body;
    await update(client.id, LOS_ANDES);
    expect(app.db.select().from(clientEvents).all()).toHaveLength(1);
  });

  it('rechaza modificar a un CUIT inválido y nada cambia (AC-41)', async () => {
    const { client } = (await create(LOS_ANDES)).body;
    expect((await update(client.id, { ...LOS_ANDES, cuit: '30711111118' })).status).toBe(400);
    expect(allClients()[0]?.cuit).toBe('30711111111');
  });

  it('rechaza modificar a un CUIT o email de otro cliente, y permite mantener los propios (AC-42)', async () => {
    const andes = (await create(LOS_ANDES)).body.client;
    const pampa = (await create(PAMPA)).body.client;

    expect((await update(pampa.id, { ...PAMPA, cuit: LOS_ANDES.cuit })).status).toBe(409);
    expect((await update(pampa.id, { ...PAMPA, billingEmail: 'PAGOS@losandes.com' })).status).toBe(409);
    expect((await update(andes.id, { ...LOS_ANDES, billingEmail: 'Pagos@LosAndes.com' })).status).toBe(200);
    expect(app.db.select().from(clients).where(eq(clients.id, pampa.id)).get()).toMatchObject(PAMPA);
  });

  it('responde 404 para un cliente inexistente', async () => {
    expect((await update(999, LOS_ANDES)).status).toBe(404);
    expect((await app.request('GET', '/api/clients/abc', { cookie: admin })).status).toBe(404);
  });
});

describe('baja y reactivación', () => {
  it('da de baja: pasa a Inactivo y sigue en el listado (RF-36, AC-38)', async () => {
    const { client } = (await create(LOS_ANDES)).body;

    const res = await app.request('POST', `/api/clients/${client.id}/deactivate`, { cookie: admin });

    expect(res.status).toBe(200);
    expect(res.body.client.status).toBe('inactivo');
    expect((await list()).body.clients).toMatchObject([{ id: client.id, status: 'inactivo' }]);
  });

  it('reactiva un cliente Inactivo (RF-37) y registra baja y reactivación en el historial', async () => {
    const { client } = (await create(LOS_ANDES)).body;
    await app.request('POST', `/api/clients/${client.id}/deactivate`, { cookie: admin });

    const res = await app.request('POST', `/api/clients/${client.id}/reactivate`, { cookie: admin });

    expect(res.body.client.status).toBe('activo');
    const types = app.db.select().from(clientEvents).orderBy(asc(clientEvents.id)).all().map((e) => e.type);
    expect(types).toEqual(['alta', 'baja', 'reactivacion']);
  });

  it('rechaza dar de baja un cliente que ya está Inactivo', async () => {
    const { client } = (await create(LOS_ANDES)).body;
    await app.request('POST', `/api/clients/${client.id}/deactivate`, { cookie: admin });
    expect((await app.request('POST', `/api/clients/${client.id}/deactivate`, { cookie: admin })).status).toBe(409);
  });
});

describe('listado, filtro y búsqueda (RF-158, RF-169, AC-176)', () => {
  beforeEach(async () => {
    await create(LOS_ANDES);
    const pampa = (await create(PAMPA)).body.client;
    await app.request('POST', `/api/clients/${pampa.id}/deactivate`, { cookie: admin });
  });

  it('lista Activos e Inactivos con sus datos', async () => {
    const res = await list();
    expect(res.body.clients).toMatchObject([
      { ...LOS_ANDES, status: 'activo' },
      { ...PAMPA, status: 'inactivo' },
    ]);
  });

  it('filtra por estado', async () => {
    expect((await list('?status=inactivo')).body.clients.map((c: any) => c.businessName)).toEqual(['Pampa SRL']);
    expect((await list('?status=activo')).body.clients.map((c: any) => c.businessName)).toEqual(['Los Andes SA']);
  });

  it.each(['Andes', 'andes', '30711111111', '30-7111', '711111111'])(
    'busca "%s" y encuentra solo a Los Andes SA',
    async (q) => {
      const names = (await list(`?q=${encodeURIComponent(q)}`)).body.clients.map((c: any) => c.businessName);
      expect(names).toEqual(['Los Andes SA']);
    },
  );

  it('trata % y _ de la búsqueda como texto', async () => {
    expect((await list('?q=%25')).body.clients).toEqual([]);
    expect((await list('?q=_')).body.clients).toEqual([]);
  });

  it('rechaza un estado inválido', async () => {
    expect((await list('?status=borrado')).status).toBe(400);
  });
});

describe('permisos', () => {
  it('Consulta ve el listado y el detalle (RF-11, AC-11)', async () => {
    const { client } = (await create(LOS_ANDES)).body;
    const consulta = await app.loginAs('consulta');

    expect((await list('', consulta)).body.clients).toHaveLength(1);
    expect((await app.request('GET', `/api/clients/${client.id}`, { cookie: consulta })).status).toBe(200);
  });

  it('Consulta no puede crear, modificar, dar de baja ni reactivar, y nada cambia (RF-13, AC-217)', async () => {
    const { client } = (await create(LOS_ANDES)).body;
    const consulta = await app.loginAs('consulta');

    expect((await create(PAMPA, consulta)).status).toBe(403);
    expect((await update(client.id, { ...LOS_ANDES, businessName: 'X' }, consulta)).status).toBe(403);
    expect((await app.request('POST', `/api/clients/${client.id}/deactivate`, { cookie: consulta })).status).toBe(403);
    await app.request('POST', `/api/clients/${client.id}/deactivate`, { cookie: admin });
    expect((await app.request('POST', `/api/clients/${client.id}/reactivate`, { cookie: consulta })).status).toBe(403);

    expect(allClients()).toMatchObject([{ businessName: 'Los Andes SA', status: 'inactivo' }]);
  });

  it('sin sesión no devuelve datos (RF-01)', async () => {
    await create(LOS_ANDES);
    expect((await app.request('GET', '/api/clients')).status).toBe(401);
  });
});
