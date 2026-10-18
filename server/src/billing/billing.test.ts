import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockArcaClient } from '../arca/mock.js';
import { ArcaError, type ArcaClient, type VoucherRequest } from '../arca/types.js';
import { openDatabase, type DatabaseHandle, type Db } from '../db/index.js';
import {
  billingPeriods,
  clientEvents,
  clientProducts,
  clients,
  exchangeRates,
  invoiceAttempts,
  invoiceItems,
  invoices,
  mockArcaVouchers,
  processErrors,
  products,
  settings,
} from '../db/schema.js';
import { getSettings } from '../settings/settings.js';
import { argentinaDate, paymentDueDate, periodBounds } from './dates.js';
import { MISSING_EXCHANGE_RATE, MISSING_IVA_CONDITION, type Invoice } from './generate.js';
import { BillingPeriodError, runBillingProcess, type BillingDeps } from './process.js';

const OCT_15 = new Date('2026-10-15T11:00:00-03:00');
const MINUTE = 60_000;

/** ARCA simulado con fallas controlables por test. */
class TestArca implements ArcaClient {
  readonly inner: MockArcaClient;
  authorizeCalls: VoucherRequest[] = [];
  /** Cantidad de pedidos de CAE que van a fallar antes de que ARCA responda bien. */
  failNextAuthorize = 0;
  /** CUIT cuyos pedidos fallan siempre. */
  alwaysFailFor: string | null = null;
  /** ARCA autoriza pero la respuesta "no llega" (timeout) en el próximo pedido. */
  loseNextResponse = false;
  /** Demora de cada pedido de CAE, para probar la concurrencia. */
  delayMs = 0;

  constructor(db: Db) {
    this.inner = new MockArcaClient(db);
  }
  lastAuthorizedNumber(pos: number) {
    return this.inner.lastAuthorizedNumber(pos);
  }
  getVoucher(pos: number, number: number) {
    return this.inner.getVoucher(pos, number);
  }
  async authorize(request: VoucherRequest) {
    this.authorizeCalls.push(request);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.alwaysFailFor === request.receiverCuit || this.failNextAuthorize > 0) {
      this.failNextAuthorize = Math.max(0, this.failNextAuthorize - 1);
      throw new ArcaError('ARCA no respondió en 30 s (simulado).');
    }
    const voucher = await this.inner.authorize(request);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new ArcaError('ARCA no respondió en 30 s (simulado, pero autorizó).');
    }
    return voucher;
  }
}

let handle: DatabaseHandle;
let db: Db;
let arca: TestArca;
let now: Date;
let sleeps: number[];
let generated: Invoice[];
let readRate: () => Promise<number>;

beforeEach(() => {
  handle = openDatabase(':memory:');
  db = handle.db;
  arca = new TestArca(db);
  now = OCT_15;
  sleeps = [];
  generated = [];
  readRate = async () => 150_000;
});
afterEach(() => handle.close());

function deps(overrides: Partial<BillingDeps> = {}): BillingDeps {
  return {
    db,
    arca,
    readRate: () => readRate(),
    now: () => now,
    sleep: async (ms) => void sleeps.push(ms),
    onInvoiceGenerated: async (invoice) => void generated.push(invoice),
    ...overrides,
  };
}

const run = (period = '2026-10', extra: Partial<BillingDeps> = {}) => runBillingProcess(deps(extra), period);

let cuitSeq = 0;
function addClient(values: Partial<typeof clients.$inferInsert> = {}) {
  const n = cuitSeq++;
  return db
    .insert(clients)
    .values({
      businessName: `Cliente ${n}`,
      cuit: String(30_000_000_000 + n),
      address: 'San Martín 100, Mendoza',
      billingEmail: `cliente${n}@test.com`,
      ivaCondition: 6,
      ...values,
    })
    .returning()
    .get();
}
function addProduct(values: Partial<typeof products.$inferInsert> = {}) {
  return db
    .insert(products)
    .values({ name: 'ERP', priceCents: 1_500_000, currency: 'ARS', ...values })
    .returning()
    .get();
}
const assign = (clientId: number, productId: number) =>
  db.insert(clientProducts).values({ clientId, productId }).run();
const allInvoices = () => db.select().from(invoices).orderBy(asc(invoices.id)).all();
const pendingErrors = () => db.select().from(processErrors).where(eq(processErrors.status, 'pendiente')).all();
const setConfig = (values: Partial<typeof settings.$inferInsert>) => {
  getSettings(db);
  db.update(settings).set(values).where(eq(settings.id, 1)).run();
};

beforeEach(() => {
  cuitSeq = 0;
});

describe('fechas (RF-79 a RF-81, RNF-12)', () => {
  it('período de servicio del primer al último día del mes', () => {
    expect(periodBounds('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('vence el último día del mes, o el día de emisión si es posterior', () => {
    expect(paymentDueDate('2026-10', '2026-10-15')).toBe('2026-10-31');
    expect(paymentDueDate('2026-10', '2026-11-03')).toBe('2026-11-03');
  });

  it('usa la fecha de Argentina aunque en UTC ya sea el día siguiente (AC-229)', () => {
    expect(argentinaDate(new Date('2026-10-16T01:00:00Z'))).toBe('2026-10-15');
  });
});

describe('proceso de facturación', () => {
  it('factura a cada cliente Activo con productos Activos, en Pendiente de pago y con el detalle de cada cuota (RF-51, AC-51, AC-75)', async () => {
    const erp = addProduct({ name: 'ERP', priceCents: 1_500_000 });
    const crm = addProduct({ name: 'CRM', priceCents: 660_000 });
    const a = addClient({ businessName: 'Los Andes SA' });
    const b = addClient({ businessName: 'Pampa SRL' });
    assign(a.id, erp.id);
    assign(a.id, crm.id);
    assign(b.id, erp.id);

    const summary = await run();

    expect(summary).toEqual({ period: '2026-10', generated: 2, failed: 0, skipped: 0 });
    const [first, second] = allInvoices();
    expect(first).toMatchObject({
      clientId: a.id,
      period: '2026-10',
      status: 'pendiente_pago',
      voucherType: 11,
      pointOfSale: 1,
      issueDate: '2026-10-15',
      serviceFrom: '2026-10-01',
      serviceTo: '2026-10-31',
      paymentDueDate: '2026-10-31',
      totalCents: 2_160_000,
      clientBusinessName: 'Los Andes SA',
      clientCuit: a.cuit,
      clientAddress: 'San Martín 100, Mendoza',
      clientIvaCondition: 6,
      exchangeRateId: null,
    });
    expect(first!.cae).toMatch(/^\d{14}$/);
    expect(new Set([first!.number, second!.number])).toEqual(new Set([1, 2]));
    expect(db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, first!.id)).all()).toMatchObject([
      { description: 'ERP', currency: 'ARS', unitPriceCents: 1_500_000, amountCents: 1_500_000 },
      { description: 'CRM', currency: 'ARS', unitPriceCents: 660_000, amountCents: 660_000 },
    ]);
    expect(generated.map((i) => i.clientId).sort()).toEqual([a.id, b.id]);
  });

  it('registra la factura generada en el historial del cliente, originada por el agente', async () => {
    const c = addClient();
    assign(c.id, addProduct().id);
    await run();

    const events = db.select().from(clientEvents).where(eq(clientEvents.type, 'factura_generada')).all();
    expect(events).toMatchObject([{ clientId: c.id, userId: null, data: { number: 1, period: '2026-10', totalCents: 1_500_000 } }]);
  });

  it('no factura a clientes sin productos, con solo productos Inactivos o Inactivos (RF-94, RF-95, AC-85 a AC-87)', async () => {
    const inactiveProduct = addProduct({ status: 'inactivo' });
    addClient();
    const onlyInactive = addClient();
    assign(onlyInactive.id, inactiveProduct.id);
    const inactiveClient = addClient({ status: 'inactivo' });
    assign(inactiveClient.id, addProduct().id);

    expect(await run()).toMatchObject({ generated: 0, failed: 0 });
    expect(allInvoices()).toEqual([]);
    expect(generated).toEqual([]);
  });

  it('incluye solo los productos Activos asignados (AC-47)', async () => {
    const c = addClient();
    assign(c.id, addProduct({ name: 'ERP' }).id);
    assign(c.id, addProduct({ name: 'Viejo', status: 'inactivo' }).id);
    await run();

    expect(db.select().from(invoiceItems).all().map((i) => i.description)).toEqual(['ERP']);
  });

  it('no genera una segunda factura ni otro envío si el proceso se vuelve a ejecutar (RF-74, AC-72)', async () => {
    const c = addClient();
    assign(c.id, addProduct().id);
    await run();
    generated = [];

    expect(await run()).toMatchObject({ generated: 0, skipped: 1 });
    expect(allInvoices()).toHaveLength(1);
    expect(generated).toEqual([]);
  });

  it('retoma un proceso interrumpido y factura solo a los que faltaban (RF-53, AC-54)', async () => {
    const product = addProduct();
    const a = addClient();
    assign(a.id, product.id);
    await run();
    // El proceso "se cortó" antes de llegar al segundo cliente.
    db.update(billingPeriods).set({ finishedAt: null }).run();
    const b = addClient();
    assign(b.id, product.id);

    expect(await run()).toMatchObject({ generated: 1, skipped: 1 });
    expect(allInvoices().map((i) => i.clientId)).toEqual([a.id, b.id]);
  });

  it('marca el inicio y el fin del período (RF-61)', async () => {
    assign(addClient().id, addProduct().id);
    await runBillingProcess(deps(), '2026-10', null);

    expect(db.select().from(billingPeriods).get()).toMatchObject({
      period: '2026-10', startedAt: OCT_15, startedBy: null, finishedAt: OCT_15,
    });
  });

  it('no factura un período cancelado (RF-55, AC-55)', async () => {
    assign(addClient().id, addProduct().id);
    db.insert(billingPeriods).values({ period: '2026-10', cancelledAt: new Date('2026-10-10') }).run();

    await expect(run()).rejects.toBeInstanceOf(BillingPeriodError);
    expect(allInvoices()).toEqual([]);
  });

  it('emite en el punto de venta configurado (RF-72, AC-70, AC-71)', async () => {
    const product = addProduct();
    assign(addClient().id, product.id);
    setConfig({ pointOfSale: 3 });
    await run('2026-10');
    expect(allInvoices()[0]).toMatchObject({ pointOfSale: 3, number: 1 });

    setConfig({ pointOfSale: 5 });
    now = new Date('2026-11-15T11:00:00-03:00');
    await run('2026-11');
    expect(allInvoices()[1]).toMatchObject({ pointOfSale: 5, number: 1 });
  });

  it('numera correlativamente aunque facture a muchos clientes en paralelo', async () => {
    arca.delayMs = 2;
    const product = addProduct();
    for (let i = 0; i < 12; i++) assign(addClient().id, product.id);

    await run();

    expect(allInvoices().map((i) => i.number).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('las facturas emitidas conservan los datos del cliente y del producto al facturar (AC-36, AC-45, AC-46, AC-74)', async () => {
    const product = addProduct({ name: 'ERP', priceCents: 1_000_000 });
    const c = addClient({ businessName: 'Los Andes SA', ivaCondition: 6 });
    assign(c.id, product.id);
    await run('2026-10');

    db.update(clients).set({ businessName: 'Los Andes SAU', ivaCondition: 1 }).where(eq(clients.id, c.id)).run();
    db.update(products).set({ name: 'ERP Plus', priceCents: 2_000_000 }).where(eq(products.id, product.id)).run();
    now = new Date('2026-11-15T11:00:00-03:00');
    await run('2026-11');

    const [oct, nov] = allInvoices();
    expect(oct).toMatchObject({ clientBusinessName: 'Los Andes SA', clientIvaCondition: 6, totalCents: 1_000_000 });
    expect(nov).toMatchObject({ clientBusinessName: 'Los Andes SAU', clientIvaCondition: 1, totalCents: 2_000_000 });
    expect(arca.authorizeCalls.map((r) => r.receiverIvaCondition)).toEqual([6, 1]);
    const items = db.select().from(invoiceItems).orderBy(asc(invoiceItems.id)).all();
    expect(items.map((i) => i.description)).toEqual(['ERP', 'ERP Plus']);
  });

  it('en un reintento posterior al fin de mes, vence el día de emisión (AC-76)', async () => {
    assign(addClient().id, addProduct().id);
    now = new Date('2026-11-03T10:00:00-03:00');
    await run('2026-10');

    expect(allInvoices()[0]).toMatchObject({
      issueDate: '2026-11-03', serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-11-03',
    });
  });
});

describe('productos en dólares (RF-63 a RF-68)', () => {
  it('convierte con el dólar blue venta leído y lo registra en la factura (AC-63)', async () => {
    const c = addClient();
    assign(c.id, addProduct({ name: 'CRM', priceCents: 10_000, currency: 'USD' }).id);
    assign(c.id, addProduct({ name: 'ERP', priceCents: 1_500_000, currency: 'ARS' }).id);

    await run();

    const [invoice] = allInvoices();
    expect(invoice).toMatchObject({
      totalCents: 15_000_000 + 1_500_000,
      exchangeRateCents: 150_000,
      exchangeRateSource: 'dolarhoy.com',
      exchangeRateFallback: false,
    });
    expect(db.select().from(invoiceItems).all()).toMatchObject([
      { description: 'CRM', currency: 'USD', unitPriceCents: 10_000, amountCents: 15_000_000 },
      { description: 'ERP', currency: 'ARS', amountCents: 1_500_000 },
    ]);
  });

  it('lee la cotización una sola vez por corrida', async () => {
    const spy = vi.fn(async () => 150_000);
    readRate = spy;
    const usd = addProduct({ currency: 'USD', priceCents: 100 });
    for (let i = 0; i < 3; i++) assign(addClient().id, usd.id);

    await run();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(db.select().from(exchangeRates).all()).toHaveLength(1);
  });

  it('no lee la cotización si nadie tiene productos en dólares', async () => {
    const spy = vi.fn(async () => 150_000);
    readRate = spy;
    assign(addClient().id, addProduct().id);
    await run();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sin poder leer, usa la última registrada y lo marca en la factura (RF-67, AC-66)', async () => {
    readRate = async () => {
      throw new Error('dolarhoy.com no respondió en 10 s.');
    };
    db.insert(exchangeRates).values({ rateCents: 152_000, source: 'dolarhoy.com', readAt: new Date('2026-09-20') }).run();
    assign(addClient().id, addProduct({ currency: 'USD', priceCents: 100 }).id);

    await run();

    // USD 1,00 × $1.520 = $1.520,00
    expect(allInvoices()[0]).toMatchObject({ exchangeRateCents: 152_000, exchangeRateFallback: true, totalCents: 152_000 });
  });

  it('sin ninguna cotización, no factura a quien tiene dólares pero sí al resto (RF-68, AC-67, AC-68)', async () => {
    readRate = async () => {
      throw new Error('dolarhoy.com no respondió en 10 s.');
    };
    setConfig({ retryCount: 0 });
    const usdClient = addClient();
    assign(usdClient.id, addProduct({ currency: 'USD', priceCents: 100 }).id);
    const arsClient = addClient();
    assign(arsClient.id, addProduct().id);

    expect(await run()).toMatchObject({ generated: 1, failed: 1 });
    expect(allInvoices().map((i) => i.clientId)).toEqual([arsClient.id]);
    expect(generated.map((i) => i.clientId)).toEqual([arsClient.id]);
    expect(pendingErrors()).toMatchObject([
      { operation: 'generacion_factura', clientId: usdClient.id, period: '2026-10', attempts: 1, lastError: MISSING_EXCHANGE_RATE },
    ]);
  });
});

describe('fallas y reintentos (RF-171 a RF-174)', () => {
  it('sin condición frente al IVA no llama a ARCA y registra el error (RF-82, RF-83, AC-77)', async () => {
    setConfig({ retryCount: 0 });
    const c = addClient({ ivaCondition: null });
    assign(c.id, addProduct().id);

    await run();

    expect(arca.authorizeCalls).toEqual([]);
    expect(allInvoices()).toEqual([]);
    expect(pendingErrors()).toMatchObject([{ clientId: c.id, attempts: 1, lastError: MISSING_IVA_CONDITION }]);
  });

  it('reintenta a los 5 minutos y, si responde, no registra error (AC-178)', async () => {
    arca.failNextAuthorize = 1;
    assign(addClient().id, addProduct().id);

    expect(await run()).toMatchObject({ generated: 1, failed: 0 });
    expect(sleeps).toEqual([5 * MINUTE]);
    expect(pendingErrors()).toEqual([]);
  });

  it('con ARCA caído hace 4 intentos y registra el error con cliente, período, intentos y mensaje (AC-179)', async () => {
    arca.failNextAuthorize = 99;
    const c = addClient();
    assign(c.id, addProduct().id);

    expect(await run()).toMatchObject({ generated: 0, failed: 1 });
    expect(arca.authorizeCalls).toHaveLength(4);
    expect(sleeps).toEqual([5 * MINUTE, 5 * MINUTE, 5 * MINUTE]);
    expect(generated).toEqual([]);
    expect(pendingErrors()).toMatchObject([
      { operation: 'generacion_factura', clientId: c.id, period: '2026-10', attempts: 4, lastError: 'ARCA no respondió en 30 s (simulado).' },
    ]);
    const event = db.select().from(clientEvents).where(eq(clientEvents.type, 'error_proceso')).get();
    expect(event).toMatchObject({ clientId: c.id, userId: null, data: { operation: 'generacion_factura', attempts: 4 } });
  });

  it('respeta la cantidad de reintentos y la espera configuradas (AC-182, AC-184)', async () => {
    setConfig({ retryCount: 1, retryWaitMinutes: 10 });
    arca.failNextAuthorize = 99;
    assign(addClient().id, addProduct().id);

    await run();

    expect(arca.authorizeCalls).toHaveLength(2);
    expect(sleeps).toEqual([10 * MINUTE]);
  });

  it('los reintentos de un cliente no demoran la factura ni el envío de otro (RF-85, RF-87, AC-79)', async () => {
    const product = addProduct();
    const a = addClient();
    const b = addClient();
    assign(a.id, product.id);
    assign(b.id, product.id);
    arca.alwaysFailFor = a.cuit;

    // La espera del reintento de "A" no termina hasta que el test la libera.
    let releaseRetry!: () => void;
    const retryWait = new Promise<void>((resolve) => (releaseRetry = resolve));
    let aWaiting = false;
    const process = run('2026-10', {
      sleep: async () => {
        aWaiting = true;
        arca.alwaysFailFor = null;
        await retryWait;
      },
    });

    // Con "A" todavía esperando, "B" ya se facturó y se envió.
    await vi.waitFor(() => expect(generated.map((i) => i.clientId)).toEqual([b.id]));
    expect(aWaiting).toBe(true);
    releaseRetry();
    await process;

    expect(generated.map((i) => i.clientId)).toEqual([b.id, a.id]);
  });

  it('un error en el envío posterior no se toma como falla de generación (RF-86)', async () => {
    assign(addClient().id, addProduct().id);

    const summary = await run('2026-10', {
      onInvoiceGenerated: async () => {
        throw new Error('SMTP caído');
      },
    });

    expect(summary).toMatchObject({ generated: 1, failed: 0 });
    expect(arca.authorizeCalls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('si ARCA autorizó pero la respuesta no llegó, registra ese comprobante en vez de pedir otro (RF-75, RF-76, AC-73)', async () => {
    arca.loseNextResponse = true;
    const c = addClient();
    assign(c.id, addProduct().id);

    expect(await run()).toMatchObject({ generated: 1, failed: 0 });

    expect(arca.authorizeCalls).toHaveLength(1);
    const vouchers = db.select().from(mockArcaVouchers).all();
    expect(vouchers).toHaveLength(1);
    expect(allInvoices()).toMatchObject([{ number: vouchers[0]!.number, cae: vouchers[0]!.cae }]);
    expect(db.select().from(invoiceAttempts).all()).toEqual([]);
  });

  it('si el número pendiente lo usó otro comprobante, pide uno nuevo', async () => {
    const c = addClient();
    assign(c.id, addProduct().id);
    // Intento anterior colgado con el número 1, que en ARCA quedó para otro receptor.
    await arca.inner.authorize({
      pointOfSale: 1, number: 1, issueDate: '2026-10-14', serviceFrom: '2026-10-01', serviceTo: '2026-10-31',
      paymentDueDate: '2026-10-31', receiverCuit: '20111111112', receiverIvaCondition: 5, totalCents: 999,
    });
    db.insert(invoiceAttempts).values({
      clientId: c.id, period: '2026-10', pointOfSale: 1, pendingNumber: 1,
      payload: { items: [], totalCents: 1_500_000, rate: null }, updatedAt: OCT_15,
    }).run();

    await run();

    expect(allInvoices()).toMatchObject([{ clientId: c.id, number: 2 }]);
  });

  it('al retomar, no vuelve a intentar a quien ya tiene un error de generación Pendiente', async () => {
    setConfig({ retryCount: 0 });
    arca.failNextAuthorize = 1;
    const c = addClient();
    assign(c.id, addProduct().id);
    await run();
    db.update(billingPeriods).set({ finishedAt: null }).run();

    expect(await run()).toMatchObject({ generated: 0, failed: 0 });
    expect(pendingErrors()).toHaveLength(1);
    expect(db.select().from(processErrors).where(and(eq(processErrors.clientId, c.id))).all()).toHaveLength(1);
  });
});
