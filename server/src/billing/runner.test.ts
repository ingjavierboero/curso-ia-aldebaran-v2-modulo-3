import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { billingPeriods, clientProducts, clients, invoices, products, settings, users } from '../db/schema.js';
import { getSettings } from '../settings/settings.js';
import { startTestApp, type TestApp } from '../test/http.js';
import { isBillingDue } from './dates.js';
import { BillingStateError } from './runner.js';

/** Hora de Argentina (UTC-3) expresada como Date. */
const ar = (dateTime: string) => new Date(`${dateTime}:00-03:00`);

let app: TestApp;
let now: Date;
afterEach(async () => {
  await app?.close();
});

async function start(at: string) {
  now = ar(at);
  app = await startTestApp({ now: () => now });
  return app;
}

let seq = 0;
function addBillableClient() {
  const n = seq++;
  const client = app.db.insert(clients).values({
    businessName: `Cliente ${n}`, cuit: String(30_000_000_000 + n), address: 'Calle 1',
    billingEmail: `c${n}@test.com`, ivaCondition: 6,
  }).returning().get();
  const product = app.db.insert(products).values({ name: 'ERP', priceCents: 100_000, currency: 'ARS' }).returning().get();
  app.db.insert(clientProducts).values({ clientId: client.id, productId: product.id }).run();
  return client;
}
const allInvoices = () => app.db.select().from(invoices).all();
/** Admin que cancela o reactiva directamente contra el runner. */
const adminId = () =>
  app.db.insert(users).values({ name: 'Admin', email: `admin${seq++}@test.com`, role: 'admin', passwordHash: 'x' }).returning().get().id;

/** Revisión del agente y espera a que termine la corrida que haya arrancado. */
async function tick() {
  app.billing.tick();
  await app.billing.whenIdle(app.billing.status().period);
}

describe('isBillingDue (RF-51, RF-52, RNF-12)', () => {
  it('es el día 15 desde la hora de facturación, y todo el resto del mes', () => {
    expect(isBillingDue(ar('2026-10-15T10:59'), '11:00')).toBe(false);
    expect(isBillingDue(ar('2026-10-15T11:00'), '11:00')).toBe(true);
    expect(isBillingDue(ar('2026-10-14T23:59'), '11:00')).toBe(false);
    expect(isBillingDue(ar('2026-10-31T00:01'), '11:00')).toBe(true);
    expect(isBillingDue(ar('2026-11-01T12:00'), '11:00')).toBe(false);
  });

  it('usa la hora de Argentina aunque el servidor esté en UTC (AC-229)', () => {
    expect(isBillingDue(new Date('2026-10-15T11:00:00Z'), '11:00')).toBe(false); // 08:00 en Argentina
    expect(isBillingDue(new Date('2026-10-15T14:00:00Z'), '11:00')).toBe(true); // 11:00 en Argentina
  });
});

describe('scheduler de facturación', () => {
  it('el día 15 factura a la hora de facturación, no antes (AC-51, AC-52)', async () => {
    await start('2026-10-15T10:59');
    addBillableClient();

    await tick();
    expect(allInvoices()).toEqual([]);

    now = ar('2026-10-15T11:00');
    await tick();
    expect(allInvoices()).toHaveLength(1);
    expect(app.billing.status()).toMatchObject({ state: 'realizada', startedBy: null });
  });

  it('respeta la hora de facturación configurada (AC-61)', async () => {
    await start('2026-10-15T11:00');
    getSettings(app.db);
    app.db.update(settings).set({ billingTime: '14:00' }).run();
    addBillableClient();

    await tick();
    expect(allInvoices()).toEqual([]);
    now = ar('2026-10-15T14:00');
    await tick();
    expect(allInvoices()).toHaveLength(1);
  });

  it('si el sistema estuvo apagado el 15, factura apenas vuelve en el mismo mes; en el mes siguiente ya no (RF-52, AC-53)', async () => {
    await start('2026-10-17T09:00');
    addBillableClient();
    await tick();
    expect(allInvoices().map((i) => i.period)).toEqual(['2026-10']);

    await app.close();
    await start('2026-11-01T09:00');
    addBillableClient();
    await tick();
    expect(allInvoices()).toEqual([]);
    expect(app.db.select().from(billingPeriods).all()).toEqual([]);
  });

  it('no vuelve a facturar un mes ya facturado (RF-59)', async () => {
    await start('2026-10-15T11:00');
    addBillableClient();
    await tick();
    addBillableClient();
    now = ar('2026-10-20T11:00');
    await tick();
    expect(allInvoices()).toHaveLength(1);
  });

  it('retoma un proceso interrumpido (RF-53, AC-54)', async () => {
    await start('2026-10-16T09:00');
    const a = addBillableClient();
    const b = addBillableClient();
    // Corrida anterior cortada: empezó, facturó a "a" (simulado) y nunca terminó.
    app.db.insert(billingPeriods).values({ period: '2026-10', startedAt: ar('2026-10-15T11:00') }).run();
    app.db.insert(invoices).values({
      // Otro punto de venta, para no chocar con la numeración del ARCA simulado.
      clientId: a.id, period: '2026-10', voucherType: 11, pointOfSale: 9, number: 1, cae: '1', caeDueDate: '2026-10-25',
      issueDate: '2026-10-15', serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-10-31',
      totalCents: 100_000, clientBusinessName: a.businessName, clientCuit: a.cuit, clientIvaCondition: 6,
    }).run();
    expect(app.billing.status().state).toBe('en_curso');

    await tick();

    expect(allInvoices().map((i) => i.clientId).sort()).toEqual([a.id, b.id]);
    expect(app.billing.status().state).toBe('realizada');
  });
});

describe('sin clientes facturables', () => {
  it('el scheduler no marca el mes: un cliente cargado después se factura igual', async () => {
    await start('2026-10-18T09:00');
    await tick();
    expect(app.billing.status().state).toBe('pendiente');

    addBillableClient();
    now = ar('2026-10-18T09:01');
    await tick();
    expect(allInvoices()).toHaveLength(1);
    expect(app.billing.status().state).toBe('realizada');
  });

  it('"Facturar ahora" avisa que no hay a quién facturar y no marca el mes', async () => {
    await start('2026-10-05T09:00');
    const admin = await app.loginAs('admin');

    const res = await app.request('POST', '/api/billing/run', { cookie: admin });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No hay clientes para facturar/);
    expect(app.billing.status().state).toBe('pendiente');
  });
});

describe('cancelar y reactivar (RF-54 a RF-57)', () => {
  it('un mes cancelado no se factura el 15 ni al volver el sistema (AC-55)', async () => {
    await start('2026-10-10T09:00');
    addBillableClient();
    app.billing.cancel(adminId());

    now = ar('2026-10-15T11:00');
    await tick();
    now = ar('2026-10-17T09:00');
    await tick();

    expect(allInvoices()).toEqual([]);
    expect(app.billing.status()).toMatchObject({ state: 'cancelada' });
  });

  it('no se puede cancelar un proceso ya iniciado (AC-56)', async () => {
    await start('2026-10-15T11:00');
    addBillableClient();
    await tick();
    expect(() => app.billing.cancel(1)).toThrow(BillingStateError);
  });

  it('al reactivar después de la hora del 15 factura en el momento (RF-57, AC-57)', async () => {
    await start('2026-10-10T09:00');
    addBillableClient();
    app.billing.cancel(adminId());

    now = ar('2026-10-20T10:00');
    app.billing.reactivate();
    await app.billing.whenIdle('2026-10');

    expect(allInvoices()).toHaveLength(1);
  });

  it('al reactivar antes del 15 espera al día 15', async () => {
    await start('2026-10-05T09:00');
    addBillableClient();
    app.billing.cancel(adminId());
    expect(app.billing.reactivate().state).toBe('pendiente');
    expect(allInvoices()).toEqual([]);
  });

  it('en el mes siguiente ya no se puede reactivar el mes cancelado (AC-57)', async () => {
    await start('2026-10-10T09:00');
    app.billing.cancel(adminId());
    now = ar('2026-11-01T09:00');
    expect(() => app.billing.reactivate()).toThrow(BillingStateError);
    expect(app.db.select().from(billingPeriods).where(eq(billingPeriods.period, '2026-10')).get()?.cancelledAt).not.toBeNull();
  });
});

describe('"Facturar ahora" (RF-58 a RF-61)', () => {
  it('factura el mes en curso con fecha de hoy y el 15 ya no vuelve a facturar (AC-58)', async () => {
    await start('2026-10-05T09:00');
    addBillableClient();
    const admin = await app.loginAs('admin');

    const res = await app.request('POST', '/api/billing/run', { cookie: admin });
    expect(res.status).toBe(202);
    await app.billing.whenIdle('2026-10');
    expect(allInvoices()).toMatchObject([{ period: '2026-10', issueDate: '2026-10-05' }]);
    expect(app.billing.status()).toMatchObject({ state: 'realizada', startedBy: expect.any(Number) });

    now = ar('2026-10-10T09:00');
    addBillableClient();
    now = ar('2026-10-15T11:00');
    await tick();
    expect(allInvoices()).toHaveLength(1);
  });

  it('se rechaza si el mes está cancelado, en curso o ya facturado, sin generar facturas (AC-59, AC-60)', async () => {
    await start('2026-10-05T09:00');
    addBillableClient();
    const admin = await app.loginAs('admin');

    app.billing.cancel(adminId());
    const cancelled = await app.request('POST', '/api/billing/run', { cookie: admin });
    expect(cancelled).toMatchObject({ status: 409, body: { error: 'La facturación del mes está cancelada.' } });
    expect(allInvoices()).toEqual([]);

    // En curso: empezó y todavía no terminó.
    app.billing.reactivate();
    app.db.update(billingPeriods).set({ startedAt: now }).run();
    const running = await app.request('POST', '/api/billing/run', { cookie: admin });
    expect(running).toMatchObject({ status: 409, body: { error: 'La facturación del mes está en curso.' } });

    app.db.update(billingPeriods).set({ finishedAt: now }).run();
    const done = await app.request('POST', '/api/billing/run', { cookie: admin });
    expect(done).toMatchObject({ status: 409, body: { error: 'La facturación del mes ya fue realizada.' } });
    expect(allInvoices()).toEqual([]);
  });

  it.each(['editor', 'consulta'] as const)(
    '%s ve el estado pero no puede facturar, cancelar ni reactivar (RF-10, AC-216)',
    async (role) => {
      await start('2026-10-05T09:00');
      addBillableClient();
      const cookie = await app.loginAs(role);

      expect((await app.request('GET', '/api/billing/current', { cookie })).body.billing).toMatchObject({ period: '2026-10', state: 'pendiente' });
      for (const action of ['run', 'cancel', 'reactivate']) {
        expect((await app.request('POST', `/api/billing/${action}`, { cookie })).status).toBe(403);
      }
      expect(allInvoices()).toEqual([]);
      expect(app.db.select().from(billingPeriods).all()).toEqual([]);
    },
  );

  it('un Admin cancela y reactiva por la API', async () => {
    await start('2026-10-05T09:00');
    const admin = await app.loginAs('admin');

    expect((await app.request('POST', '/api/billing/cancel', { cookie: admin })).body.billing.state).toBe('cancelada');
    expect((await app.request('POST', '/api/billing/cancel', { cookie: admin })).status).toBe(409);
    expect((await app.request('POST', '/api/billing/reactivate', { cookie: admin })).body.billing.state).toBe('pendiente');
  });
});

describe('listado de facturas (RF-160, RF-168)', () => {
  it('lista con sus datos y filtra por estado, cliente y período (AC-167, AC-175)', async () => {
    await start('2026-10-20T09:00');
    const admin = await app.loginAs('admin');
    const a = addBillableClient();
    const b = addBillableClient();
    const insert = (clientId: number, period: string, number: number, status: 'pendiente_pago' | 'pagada') =>
      app.db.insert(invoices).values({
        clientId, period, status, voucherType: 11, pointOfSale: 2, number, cae: '1', caeDueDate: '2026-10-25',
        issueDate: `${period}-15`, serviceFrom: `${period}-01`, serviceTo: `${period}-30`, paymentDueDate: `${period}-30`,
        totalCents: 100_000 * number, clientBusinessName: `Cliente ${clientId}`, clientCuit: '1', clientIvaCondition: 6,
      }).run();
    insert(a.id, '2026-09', 1, 'pagada');
    insert(a.id, '2026-10', 2, 'pendiente_pago');
    insert(b.id, '2026-10', 3, 'pendiente_pago');
    insert(b.id, '2026-09', 4, 'pendiente_pago');

    const all = (await app.request('GET', '/api/invoices', { cookie: admin })).body.invoices;
    expect(all).toHaveLength(4);
    expect(all[0]).toMatchObject({
      pointOfSale: 2, number: 3, clientBusinessName: `Cliente ${b.id}`, period: '2026-10',
      totalCents: 300_000, paymentDueDate: '2026-10-30', status: 'pendiente_pago',
    });

    const filtered = await app.request('GET', `/api/invoices?status=pendiente_pago&clientId=${a.id}&period=2026-10`, { cookie: admin });
    expect(filtered.body.invoices.map((i: any) => i.number)).toEqual([2]);

    const consulta = await app.loginAs('consulta');
    expect((await app.request('GET', '/api/invoices', { cookie: consulta })).body.invoices).toHaveLength(4);
    expect((await app.request('GET', '/api/invoices?status=borrada', { cookie: admin })).status).toBe(400);
  });
});
