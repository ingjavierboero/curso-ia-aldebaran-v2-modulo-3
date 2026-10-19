import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockClassifier } from '../classifier/mock.js';
import { openDatabase, type DatabaseHandle, type Db } from '../db/index.js';
import { clientEvents, clients, invoiceEmails, invoices, receivedAttachments, receivedEmails } from '../db/schema.js';
import { processReceivedEmail } from './process-email.js';

let handle: DatabaseHandle;
let db: Db;
let clientId: number;
let seq = 1;

beforeEach(() => {
  handle = openDatabase(':memory:');
  db = handle.db;
  seq = 1;
  clientId = db.insert(clients).values({
    businessName: 'Los Andes SA', cuit: '30711111111', billingEmail: 'pagos@losandes.com', ivaCondition: 1,
  }).returning().get().id;
});
afterEach(() => handle.close());

function invoice(period: string, pesos: number, status: 'pendiente_pago' | 'revision_manual' | 'pago_recibido' | 'pagada' = 'pendiente_pago', reviewReason: string | null = null) {
  return db.insert(invoices).values({
    clientId, period, status, reviewReason, voucherType: 11, pointOfSale: 1, number: seq++, cae: '1', caeDueDate: `${period}-25`,
    issueDate: `${period}-15`, serviceFrom: `${period}-01`, serviceTo: `${period}-28`, paymentDueDate: `${period}-28`,
    totalCents: Math.round(pesos * 100), clientBusinessName: 'Los Andes SA', clientCuit: '30711111111', clientIvaCondition: 1,
  }).returning().get();
}

/** Recibe un email del cliente con esos adjuntos y lo procesa con el clasificador del modo mock. */
async function receive(...filenames: string[]) {
  const email = db.insert(receivedEmails).values({
    messageId: `<${Math.random()}@x>`, from: 'pagos@losandes.com', subject: 'Pago', text: '', receivedAt: new Date(), ingestedAt: new Date(),
  }).returning().get();
  for (const filename of filenames) {
    db.insert(receivedAttachments).values({ emailId: email.id, filename, contentType: 'application/pdf', inline: false, valid: true, content: Buffer.from('%PDF') }).run();
  }
  return { emailId: email.id, outcome: await processReceivedEmail({ db, now: () => new Date(), classifier: new MockClassifier(), sleep: async () => {} }, email.id) };
}
const state = (id: number) => db.select({ status: invoices.status, reason: invoices.reviewReason }).from(invoices).where(eq(invoices.id, id)).get();
const linkedEmails = (invoiceId: number) =>
  db.select().from(invoiceEmails).where(eq(invoiceEmails.invoiceId, invoiceId)).orderBy(asc(invoiceEmails.emailId)).all().map((l) => l.emailId);

describe('validación del pago contra las facturas', () => {
  it('modo mock: comprobante exacto → Pago recibido, nunca Pagada (RF-134, AC-197)', async () => {
    const a = invoice('2026-10', 15_000.5);
    const { emailId } = await receive('pago_30711111111_15000.50.pdf');

    expect(state(a.id)).toEqual({ status: 'pago_recibido', reason: null });
    expect(linkedEmails(a.id)).toEqual([emailId]);
    expect(db.select().from(receivedEmails).get()).toMatchObject({ validationResult: 'pago_recibido', validationRule: 'RF-134' });
  });

  it.each([
    ['PAGO_x_15000.50.PDF', 'no se pudieron extraer el CUIT o el monto'],
    ['pago_30711111111_x.png', 'no se pudieron extraer el CUIT o el monto'],
    ['dudoso_transferencia.jpg', 'clasificación dudosa'],
    ['error_1.pdf', 'no se pudo procesar el comprobante'],
  ])('modo mock: %s → Revisión manual con "%s" (AC-198, AC-199)', async (filename, reason) => {
    const a = invoice('2026-09', 10_000);
    const b = invoice('2026-10', 15_000.5);
    await receive(filename);
    expect([state(a.id), state(b.id)]).toEqual([{ status: 'revision_manual', reason }, { status: 'revision_manual', reason }]);
  });

  it('modo mock: un adjunto que no es comprobante no cambia nada (RF-126, AC-199, AC-119)', async () => {
    const a = invoice('2026-10', 100);
    const { outcome } = await receive('factura_proveedor.pdf');
    expect(outcome).toMatchObject({ classification: 'no', decision: { action: 'none', rule: 'RF-126' } });
    expect(state(a.id)).toEqual({ status: 'pendiente_pago', reason: null });
  });

  it('un cliente Inactivo con el monto exacto también pasa a Pago recibido (RF-118, AC-108)', async () => {
    db.update(clients).set({ status: 'inactivo' }).run();
    const a = invoice('2026-10', 100);
    await receive('pago_30711111111_100.pdf');
    expect(state(a.id)!.status).toBe('pago_recibido');
  });

  it('las facturas Pagadas o en Pago recibido no cuentan como deuda (RF-127)', async () => {
    const paid = invoice('2026-09', 100, 'pagada');
    const received = invoice('2026-10', 100, 'pago_recibido');
    const { outcome } = await receive('pago_30711111111_100.pdf');
    expect(outcome).toMatchObject({ decision: { action: 'none', rule: 'RF-127' } });
    expect([state(paid.id)!.status, state(received.id)!.status]).toEqual(['pagada', 'pago_recibido']);
  });

  it('cliente en revisión: el motivo nuevo reemplaza al anterior y ninguna pasa a Pago recibido (RF-128, RF-129, AC-122)', async () => {
    const inReview = invoice('2026-09', 150, 'revision_manual', 'monto no coincide');
    const pending = invoice('2026-10', 200);
    await receive('pago_30711111111_200.pdf');
    expect([state(inReview.id), state(pending.id)]).toEqual([
      { status: 'revision_manual', reason: 'revisión manual pendiente' },
      { status: 'revision_manual', reason: 'revisión manual pendiente' },
    ]);
  });

  it('el email nuevo se asocia a la revisión pendiente: quedan los dos comprobantes (RF-139, AC-124)', async () => {
    const a = invoice('2026-10', 100);
    const first = await receive('pago_30711111111_40.pdf'); // parcial → Revisión manual
    const second = await receive('pago_30711111111_60.pdf');
    expect(linkedEmails(a.id)).toEqual([first.emailId, second.emailId]);
  });

  it('una factura devuelta a Pendiente de pago se valida con un comprobante nuevo (AC-152)', async () => {
    const a = invoice('2026-10', 100, 'pago_recibido');
    db.update(invoices).set({ status: 'pendiente_pago' }).where(eq(invoices.id, a.id)).run(); // la devolvió un usuario
    await receive('pago_30711111111_100.pdf');
    expect(state(a.id)!.status).toBe('pago_recibido');
  });

  it('registra cada cambio de estado en el historial del cliente (RF-57)', async () => {
    const a = invoice('2026-10', 100);
    const { emailId } = await receive('pago_30711111111_100.pdf');
    const event = db.select().from(clientEvents).where(eq(clientEvents.type, 'cambio_estado_factura')).get();
    expect(event).toMatchObject({
      clientId, userId: null,
      data: { invoiceId: a.id, number: a.number, from: 'pendiente_pago', to: 'pago_recibido', reason: null, rule: 'RF-134', emailId },
    });
  });

  it('sin adjuntos válidos no toca ninguna factura (RF-115)', async () => {
    const a = invoice('2026-10', 100);
    const { outcome } = await receive();
    expect(outcome).toMatchObject({ classification: null, decision: null });
    expect(state(a.id)!.status).toBe('pendiente_pago');
  });
});
