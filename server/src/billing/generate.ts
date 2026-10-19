import { and, eq } from 'drizzle-orm';
import type { ArcaClient, AuthorizedVoucher } from '../arca/index.js';
import { VOUCHER_TYPE_FACTURA_C } from '../arca/index.js';
import { recordClientEvent } from '../clients/events.js';
import type { Db } from '../db/index.js';
import {
  clientProducts,
  clients,
  invoiceAttempts,
  invoiceItems,
  invoices,
  products,
  type Currency,
} from '../db/schema.js';
import { usdToArsCents } from '../domain/money.js';
import type { ResolvedRate } from '../exchange/rates.js';
import { argentinaDate, paymentDueDate, periodBounds } from './dates.js';
import type { KeyedMutex } from './mutex.js';

export type Invoice = typeof invoices.$inferSelect;

/** Falla de generación que se reintenta y, si persiste, queda como error de proceso. */
export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingError';
  }
}

export const MISSING_IVA_CONDITION = 'el cliente no tiene cargada la condición frente al IVA';
export const MISSING_EXCHANGE_RATE =
  'no se pudo leer la cotización del dólar de dolarhoy.com y no hay ninguna cotización registrada';

export interface GenerateDeps {
  db: Db;
  arca: ArcaClient;
  now: () => Date;
  pointOfSale: number;
  /** Cotización para los ítems en dólares; null si no hay ninguna (RF-68). */
  getRate: () => Promise<ResolvedRate | null>;
  /** Serializa número + CAE por punto de venta. */
  arcaMutex: KeyedMutex;
}

interface AttemptItem {
  productId: number;
  description: string;
  currency: Currency;
  unitPriceCents: number;
  amountCents: number;
}

/** Lo que se le pidió a ARCA en un intento; se reusa para reconocer el comprobante (RF-76). */
interface AttemptPayload {
  items: AttemptItem[];
  totalCents: number;
  rate: Pick<ResolvedRate, 'id' | 'rateCents' | 'source' | 'readAt' | 'fallback'> | null;
}

export type GenerateResult =
  | { status: 'generated'; invoice: Invoice }
  | { status: 'already_invoiced'; invoice: Invoice }
  /** El cliente dejó de ser facturable entre intentos (baja, sin productos Activos). */
  | { status: 'not_billable' };

/**
 * Un intento de generar la factura del cliente para el período. Tira BillingError (o
 * ArcaError) si falla; el que llama decide si reintenta.
 */
export async function generateInvoice(deps: GenerateDeps, clientId: number, period: string): Promise<GenerateResult> {
  const { db } = deps;

  // RF-74: nunca más de una factura por cliente y período.
  const existing = findInvoice(db, clientId, period);
  if (existing) return { status: 'already_invoiced', invoice: existing };

  const client = db.select().from(clients).where(eq(clients.id, clientId)).get();
  // RF-95: un cliente Inactivo no se factura.
  if (!client || client.status !== 'activo') return { status: 'not_billable' };

  // RF-94: solo las cuotas de los productos Activos asignados.
  const assigned = db
    .select({ id: products.id, name: products.name, priceCents: products.priceCents, currency: products.currency })
    .from(clientProducts)
    .innerJoin(products, eq(products.id, clientProducts.productId))
    .where(and(eq(clientProducts.clientId, clientId), eq(products.status, 'activo')))
    .orderBy(products.id)
    .all();
  if (assigned.length === 0) return { status: 'not_billable' };

  // RF-82, RF-83: sin condición frente al IVA no se llama a ARCA.
  if (client.ivaCondition === null) throw new BillingError(MISSING_IVA_CONDITION);
  const ivaCondition = client.ivaCondition;

  let rate: ResolvedRate | null = null;
  if (assigned.some((p) => p.currency === 'USD')) {
    rate = await deps.getRate();
    // RF-68: sin cotización no se factura a quien tiene productos en dólares.
    if (!rate) throw new BillingError(MISSING_EXCHANGE_RATE);
  }

  const items: AttemptItem[] = assigned.map((p) => ({
    productId: p.id,
    description: p.name,
    currency: p.currency,
    unitPriceCents: p.priceCents,
    amountCents: p.currency === 'USD' ? usdToArsCents(p.priceCents, rate!.rateCents) : p.priceCents,
  }));
  const fresh: AttemptPayload = {
    items,
    totalCents: items.reduce((sum, i) => sum + i.amountCents, 0),
    rate: rate && { id: rate.id, rateCents: rate.rateCents, source: rate.source, readAt: rate.readAt, fallback: rate.fallback },
  };

  // RF-79: se emite el día en que se genera (hora de Argentina).
  const issueDate = argentinaDate(deps.now());
  const { from, to } = periodBounds(period);
  const dates = { issueDate, serviceFrom: from, serviceTo: to, paymentDueDate: paymentDueDate(period, issueDate) };

  return deps.arcaMutex.run(String(deps.pointOfSale), async () => {
    // Otra corrida pudo facturarlo mientras esperábamos el turno.
    const invoicedMeanwhile = findInvoice(db, clientId, period);
    if (invoicedMeanwhile) return { status: 'already_invoiced', invoice: invoicedMeanwhile };

    // RF-76: si un intento anterior quedó sin respuesta, ver si ARCA igual lo autorizó.
    const previous = db
      .select()
      .from(invoiceAttempts)
      .where(and(eq(invoiceAttempts.clientId, clientId), eq(invoiceAttempts.period, period)))
      .get();
    if (previous) {
      const payload = previous.payload as AttemptPayload;
      const voucher = await deps.arca.getVoucher(previous.pointOfSale, previous.pendingNumber);
      if (voucher && voucher.receiverCuit === client.cuit && voucher.totalCents === payload.totalCents) {
        const invoice = saveInvoice(db, deps.now(), client, ivaCondition, period, voucher, payload, {
          ...dates,
          issueDate: voucher.issueDate,
          paymentDueDate: paymentDueDate(period, voucher.issueDate),
        });
        return { status: 'generated', invoice };
      }
    }

    // RF-75: se registra el número antes de pedirlo, para reconocerlo si la respuesta se pierde.
    const number = (await deps.arca.lastAuthorizedNumber(deps.pointOfSale)) + 1;
    db.insert(invoiceAttempts)
      .values({ clientId, period, pointOfSale: deps.pointOfSale, pendingNumber: number, payload: fresh, updatedAt: deps.now() })
      .onConflictDoUpdate({
        target: [invoiceAttempts.clientId, invoiceAttempts.period],
        set: { pointOfSale: deps.pointOfSale, pendingNumber: number, payload: fresh, updatedAt: deps.now() },
      })
      .run();

    const voucher = await deps.arca.authorize({
      pointOfSale: deps.pointOfSale,
      number,
      ...dates,
      receiverCuit: client.cuit,
      receiverIvaCondition: ivaCondition,
      totalCents: fresh.totalCents,
    });
    return { status: 'generated', invoice: saveInvoice(db, deps.now(), client, ivaCondition, period, voucher, fresh, dates) };
  });
}

function findInvoice(db: Db, clientId: number, period: string): Invoice | undefined {
  return db
    .select()
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), eq(invoices.period, period)))
    .get();
}

/** Registra la factura autorizada, sus ítems y el evento del historial, y borra el intento. */
function saveInvoice(
  db: Db,
  at: Date,
  client: typeof clients.$inferSelect,
  ivaCondition: number,
  period: string,
  voucher: AuthorizedVoucher,
  payload: AttemptPayload,
  dates: { issueDate: string; serviceFrom: string; serviceTo: string; paymentDueDate: string },
): Invoice {
  return db.transaction((tx) => {
    const invoice = tx
      .insert(invoices)
      .values({
        clientId: client.id,
        period,
        status: 'pendiente_pago',
        voucherType: VOUCHER_TYPE_FACTURA_C,
        pointOfSale: voucher.pointOfSale,
        number: voucher.number,
        cae: voucher.cae,
        caeDueDate: voucher.caeDueDate,
        ...dates,
        totalCents: payload.totalCents,
        clientBusinessName: client.businessName,
        clientCuit: client.cuit,
        clientAddress: client.address,
        clientIvaCondition: ivaCondition,
        exchangeRateId: payload.rate?.id ?? null,
        exchangeRateCents: payload.rate?.rateCents ?? null,
        exchangeRateSource: payload.rate?.source ?? null,
        exchangeRateReadAt: payload.rate ? new Date(payload.rate.readAt) : null,
        exchangeRateFallback: payload.rate?.fallback ?? false,
      })
      .returning()
      .get();

    for (const item of payload.items) {
      tx.insert(invoiceItems).values({ invoiceId: invoice.id, ...item }).run();
    }
    tx.delete(invoiceAttempts)
      .where(and(eq(invoiceAttempts.clientId, client.id), eq(invoiceAttempts.period, period)))
      .run();
    recordClientEvent(tx, client.id, 'factura_generada', null, {
      invoiceId: invoice.id,
      pointOfSale: invoice.pointOfSale,
      number: invoice.number,
      period,
      totalCents: invoice.totalCents,
    }, at);
    return invoice;
  });
}
