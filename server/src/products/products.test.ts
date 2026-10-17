import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientEvents, products } from '../db/schema.js';
import { startTestApp, type TestApp } from '../test/http.js';

const ERP = { name: 'ERP Mensual', priceCents: 1_500_050, currency: 'ARS' };
const CRM = { name: 'CRM', priceCents: 10_000, currency: 'USD' };
const CLIENT = {
  businessName: 'Los Andes SA',
  cuit: '30711111111',
  address: 'San Martín 100, Mendoza',
  billingEmail: 'pagos@losandes.com',
  ivaCondition: 1,
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

const req = (method: string, path: string, body?: unknown, cookie = admin) =>
  app.request(method, path, { body, cookie });
const createProduct = async (body: unknown, cookie = admin) => req('POST', '/api/products', body, cookie);
const allProducts = () => app.db.select().from(products).all();

describe('productos', () => {
  it.each(['admin', 'editor'] as const)(
    '%s da de alta un producto Activo con su precio y moneda (RF-42, RF-43, AC-43)',
    async (role) => {
      const cookie = await app.loginAs(role);
      const ars = await createProduct(ERP, cookie);
      const usd = await createProduct(CRM, cookie);

      expect(ars.status).toBe(201);
      expect(ars.body.product).toMatchObject({ ...ERP, status: 'activo' });
      expect(usd.body.product).toMatchObject({ ...CRM, status: 'activo' });
    },
  );

  it.each([0, -10_000])('rechaza el precio %s centavos, y acepta 1 centavo (RF-44, AC-44)', async (priceCents) => {
    expect((await createProduct({ ...ERP, priceCents })).status).toBe(400);
    expect(allProducts()).toHaveLength(0);
    expect((await createProduct({ ...ERP, priceCents: 1 })).status).toBe(201);
  });

  it('rechaza fracciones de centavo, monedas desconocidas y nombres vacíos', async () => {
    expect((await createProduct({ ...ERP, priceCents: 100.5 })).status).toBe(400);
    expect((await createProduct({ ...ERP, currency: 'EUR' })).status).toBe(400);
    expect((await createProduct({ ...ERP, name: '  ' })).status).toBe(400);
    expect(allProducts()).toHaveLength(0);
  });

  it('modifica nombre y precio; no permite dejar el precio en 0 (RF-45, RF-46, AC-44)', async () => {
    const { product } = (await createProduct(ERP)).body;

    const changed = await req('PUT', `/api/products/${product.id}`, { ...ERP, name: 'ERP Plus', priceCents: 2_000_000 });
    expect(changed.body.product).toMatchObject({ name: 'ERP Plus', priceCents: 2_000_000 });

    expect((await req('PUT', `/api/products/${product.id}`, { ...ERP, priceCents: 0 })).status).toBe(400);
    expect(allProducts()[0]).toMatchObject({ name: 'ERP Plus', priceCents: 2_000_000 });
  });

  it('desactiva y reactiva; el Inactivo sigue en el listado (RF-47, RF-48, AC-166)', async () => {
    const { product } = (await createProduct(CRM)).body;
    await createProduct(ERP);

    expect((await req('POST', `/api/products/${product.id}/deactivate`)).body.product.status).toBe('inactivo');
    expect((await req('POST', `/api/products/${product.id}/deactivate`)).status).toBe(409);

    const list = (await req('GET', '/api/products')).body.products;
    expect(list).toMatchObject([
      { name: 'CRM', priceCents: 10_000, currency: 'USD', status: 'inactivo' },
      { name: 'ERP Mensual', priceCents: 1_500_050, currency: 'ARS', status: 'activo' },
    ]);
    expect((await req('GET', '/api/products?status=activo')).body.products).toHaveLength(1);

    expect((await req('POST', `/api/products/${product.id}/reactivate`)).body.product.status).toBe('activo');
  });

  it('Consulta ve el listado pero no puede crear, modificar ni cambiar el estado (RF-13, AC-217)', async () => {
    const { product } = (await createProduct(ERP)).body;
    const consulta = await app.loginAs('consulta');

    expect((await req('GET', '/api/products', undefined, consulta)).body.products).toHaveLength(1);
    expect((await createProduct(CRM, consulta)).status).toBe(403);
    expect((await req('PUT', `/api/products/${product.id}`, { ...ERP, name: 'X' }, consulta)).status).toBe(403);
    expect((await req('POST', `/api/products/${product.id}/deactivate`, undefined, consulta)).status).toBe(403);
    expect(allProducts()).toMatchObject([{ name: 'ERP Mensual', status: 'activo' }]);
  });
});

describe('asignación de productos a clientes', () => {
  let clientId: number;
  let erpId: number;
  let crmId: number;

  beforeEach(async () => {
    clientId = (await req('POST', '/api/clients', CLIENT)).body.client.id;
    erpId = (await createProduct(ERP)).body.product.id;
    crmId = (await createProduct(CRM)).body.product.id;
  });

  const assigned = async (cookie = admin) =>
    (await req('GET', `/api/clients/${clientId}/products`, undefined, cookie)).body.products;

  it.each(['admin', 'editor'] as const)(
    '%s asigna varios productos Activos a un cliente (RF-49, AC-09, AC-49)',
    async (role) => {
      const cookie = await app.loginAs(role);
      const res = await req('POST', `/api/clients/${clientId}/products`, { productIds: [erpId, crmId] }, cookie);

      expect(res.status).toBe(200);
      expect(res.body.products.map((p: any) => p.name)).toEqual(['CRM', 'ERP Mensual']);
      expect(await assigned()).toHaveLength(2);
    },
  );

  it('ignora los productos que ya estaban asignados', async () => {
    await req('POST', `/api/clients/${clientId}/products`, { productIds: [erpId] });
    const res = await req('POST', `/api/clients/${clientId}/products`, { productIds: [erpId, crmId, crmId] });

    expect(res.body.products).toHaveLength(2);
    const events = app.db.select().from(clientEvents).all().filter((e) => e.type === 'asignacion_producto');
    expect(events).toHaveLength(2);
  });

  it('no permite asignar un producto Inactivo, y no asigna ninguno del pedido (AC-47)', async () => {
    await req('POST', `/api/products/${crmId}/deactivate`);

    const res = await req('POST', `/api/clients/${clientId}/products`, { productIds: [erpId, crmId] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/CRM/);
    expect(await assigned()).toEqual([]);
  });

  it('rechaza productos inexistentes y pedidos vacíos', async () => {
    expect((await req('POST', `/api/clients/${clientId}/products`, { productIds: [999] })).status).toBe(404);
    expect((await req('POST', `/api/clients/${clientId}/products`, { productIds: [] })).status).toBe(400);
    expect((await req('POST', '/api/clients/999/products', { productIds: [erpId] })).status).toBe(404);
  });

  it('desactivar un producto conserva la asignación, que vuelve a contar al reactivarlo (AC-47, AC-48)', async () => {
    await req('POST', `/api/clients/${clientId}/products`, { productIds: [erpId] });
    await req('POST', `/api/products/${erpId}/deactivate`);

    expect(await assigned()).toMatchObject([{ id: erpId, status: 'inactivo' }]);

    await req('POST', `/api/products/${erpId}/reactivate`);
    expect(await assigned()).toMatchObject([{ id: erpId, status: 'activo' }]);
  });

  it('desasigna un producto y deja el otro (RF-50, AC-50)', async () => {
    await req('POST', `/api/clients/${clientId}/products`, { productIds: [erpId, crmId] });

    const res = await req('DELETE', `/api/clients/${clientId}/products/${crmId}`);

    expect(res.status).toBe(200);
    expect(res.body.products.map((p: any) => p.name)).toEqual(['ERP Mensual']);
    expect((await req('DELETE', `/api/clients/${clientId}/products/${crmId}`)).status).toBe(404);
  });

  it('registra asignaciones y desasignaciones en el historial del cliente con el usuario', async () => {
    await req('POST', `/api/clients/${clientId}/products`, { productIds: [erpId] });
    await req('DELETE', `/api/clients/${clientId}/products/${erpId}`);

    const events = app.db.select().from(clientEvents).orderBy(asc(clientEvents.id)).all();
    expect(events.map((e) => e.type)).toEqual(['alta', 'asignacion_producto', 'desasignacion_producto']);
    expect(events[1]).toMatchObject({ userId: 1, data: { productId: erpId, productName: 'ERP Mensual' } });
  });

  it('Consulta ve los productos asignados pero no puede asignar ni desasignar (AC-217)', async () => {
    await req('POST', `/api/clients/${clientId}/products`, { productIds: [erpId] });
    const consulta = await app.loginAs('consulta');

    expect(await assigned(consulta)).toHaveLength(1);
    expect((await req('POST', `/api/clients/${clientId}/products`, { productIds: [crmId] }, consulta)).status).toBe(403);
    expect((await req('DELETE', `/api/clients/${clientId}/products/${erpId}`, undefined, consulta)).status).toBe(403);
    expect(await assigned()).toHaveLength(1);
  });
});
