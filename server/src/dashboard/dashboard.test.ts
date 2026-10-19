import { afterEach, describe, expect, it } from 'vitest';
import { recordProcessError } from '../billing/process-errors.js';
import { MockClassifier } from '../classifier/mock.js';
import { clients, invoices, processErrors, receivedAttachments, receivedEmails } from '../db/schema.js';
import { MockMailer } from '../email/mock.js';
import { sendInvoiceEmail } from '../invoices/email.js';
import { processReceivedEmail } from '../payments/process-email.js';
import { startTestApp, type TestApp } from '../test/http.js';

let app: TestApp;
let now = new Date('2026-10-15T11:00:00-03:00');
afterEach(async () => {
  await app?.close();
});

async function start() {
  now = new Date('2026-10-15T11:00:00-03:00');
  app = await startTestApp({ now: () => now });
  return app.loginAs('admin');
}
const advance = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const CLIENT = { businessName: 'Los Andes SA', cuit: '30711111111', address: 'Calle 1', billingEmail: 'pagos@losandes.com', ivaCondition: 1 };
let seq = 1;
function invoice(clientId: number, cents: number, status: 'pendiente_pago' | 'revision_manual' | 'pago_recibido' | 'pagada') {
  return app.db.insert(invoices).values({
    clientId, period: '2026-10', status, voucherType: 11, pointOfSale: 9, number: seq++, cae: '1', caeDueDate: '2026-10-25',
    issueDate: '2026-10-15', serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-10-31',
    totalCents: cents, clientBusinessName: 'x', clientCuit: '1', clientIvaCondition: 1,
  }).returning().get();
}

/** Recibe un comprobante del cliente y lo procesa como el agente. */
async function receive(filename: string) {
  const email = app.db.insert(receivedEmails).values({
    messageId: `<${filename}@x>`, from: 'pagos@losandes.com', subject: 'Pago', text: '', receivedAt: now, ingestedAt: now,
  }).returning().get();
  app.db.insert(receivedAttachments).values({ emailId: email.id, filename, contentType: 'application/pdf', inline: false, valid: true, content: Buffer.from('%PDF') }).run();
  await processReceivedEmail({ db: app.db, now: () => now, classifier: new MockClassifier(), sleep: async () => {} }, email.id);
  return email.id;
}

describe('historial del cliente (RF-163)', () => {
  it('muestra cada evento en orden cronológico con su fecha y hora y el usuario o el agente (AC-170)', async () => {
    const admin = await start();
    const { client } = (await app.request('POST', '/api/clients', { cookie: admin, body: CLIENT })).body;
    advance(1);
    await app.request('PUT', `/api/clients/${client.id}`, { cookie: admin, body: { ...CLIENT, businessName: 'Los Andes SAU' } });
    advance(1);
    const { product } = (await app.request('POST', '/api/products', { cookie: admin, body: { name: 'ERP', priceCents: 1_500_050, currency: 'ARS' } })).body;
    await app.request('POST', `/api/clients/${client.id}/products`, { cookie: admin, body: { productIds: [product.id] } });
    advance(1);
    await app.billing.start('2026-10', null);
    const generated = app.db.select().from(invoices).get()!;
    advance(1);
    await sendInvoiceEmail({ db: app.db, mailer: new MockMailer(app.db, 'aldebaran-mock@gmail.com', () => now), issuerCuit: '20111111112', mockMode: true, now: () => now }, generated.id);
    advance(1);
    recordProcessError(app.db, { operation: 'envio_recordatorio', clientId: client.id, period: '2026-10', attempts: 4, lastError: 'SMTP' }, now);
    advance(1);
    await receive('pago_30711111111_15000.50.pdf');
    advance(1);
    await app.request('POST', `/api/invoices/${generated.id}/mark-paid`, { cookie: admin });
    advance(1);
    await app.request('POST', `/api/clients/${client.id}/deactivate`, { cookie: admin });
    advance(1);
    await app.request('POST', `/api/clients/${client.id}/reactivate`, { cookie: admin });

    // Un usuario Consulta ve el historial con los nombres de quienes actuaron (AC-12).
    const consulta = await app.loginAs('consulta');
    const { events } = (await app.request('GET', `/api/clients/${client.id}/history`, { cookie: consulta })).body;

    expect(events.map((e: any) => [e.type, e.userName ?? 'agente'])).toEqual([
      ['alta', 'Usuario admin'],
      ['modificacion', 'Usuario admin'],
      ['asignacion_producto', 'Usuario admin'],
      ['factura_generada', 'agente'],
      ['email_enviado', 'agente'],
      ['error_proceso', 'agente'],
      ['email_recibido', 'agente'],
      ['clasificacion_email', 'agente'],
      ['cambio_estado_factura', 'agente'],
      ['cambio_estado_factura', 'Usuario admin'],
      ['baja', 'Usuario admin'],
      ['reactivacion', 'Usuario admin'],
    ]);
    const times = events.map((e: any) => new Date(e.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('responde 404 para un cliente inexistente', async () => {
    const admin = await start();
    expect((await app.request('GET', '/api/clients/999/history', { cookie: admin })).status).toBe(404);
  });
});

describe('detalle de factura (RF-217)', () => {
  it('muestra sus datos, cuotas, cambios de estado con el agente y el usuario, y el email del comprobante (AC-239)', async () => {
    const admin = await start();
    const clientId = app.db.insert(clients).values(CLIENT).returning().get().id;
    const a = invoice(clientId, 1_000_000, 'pendiente_pago');
    advance(1);
    const emailId = await receive('pago_30711111111_400.pdf'); // parcial → Revisión manual
    advance(1);
    const editor = await app.loginAs('editor');
    await app.request('POST', `/api/invoices/${a.id}/mark-paid`, { cookie: editor });

    const consulta = await app.loginAs('consulta');
    const res = await app.request('GET', `/api/invoices/${a.id}`, { cookie: consulta });

    expect(res.status).toBe(200);
    expect(res.body.invoice).toMatchObject({ id: a.id, status: 'pagada', totalCents: 1_000_000 });
    expect(res.body.history.map((e: any) => [e.type, e.data.to, e.data.reason ?? null, e.userName])).toEqual([
      ['cambio_estado_factura', 'revision_manual', 'monto no coincide', null],
      ['cambio_estado_factura', 'pagada', null, 'Usuario editor'],
    ]);
    expect(res.body.emails).toMatchObject([{ id: emailId, attachments: [{ filename: 'pago_30711111111_400.pdf', classification: 'si', cuit: '30711111111', amount: '400' }] }]);
    expect((await app.request('GET', '/api/invoices/999', { cookie: admin })).status).toBe(404);
  });
});

describe('dashboard', () => {
  it('lista solo los clientes con deuda vigente, con su deuda total, cantidad de facturas adeudadas y si están en revisión (RF-153, AC-161)', async () => {
    await start();
    const andes = app.db.insert(clients).values(CLIENT).returning().get().id;
    const pampa = app.db.insert(clients).values({ ...CLIENT, businessName: 'Pampa SRL', cuit: '20111111112', billingEmail: 'p@p.com' }).returning().get().id;
    const sinDeuda = app.db.insert(clients).values({ ...CLIENT, businessName: 'Sin Deuda', cuit: '27000000006', billingEmail: 's@s.com' }).returning().get().id;
    invoice(andes, 1_000_000, 'pendiente_pago');
    invoice(andes, 1_200_000, 'pendiente_pago');
    invoice(pampa, 500_000, 'revision_manual');
    invoice(pampa, 300_000, 'pagada');
    invoice(sinDeuda, 999, 'pago_recibido');

    const { debtors } = (await app.request('GET', '/api/dashboard', { cookie: await app.loginAs('consulta') })).body;

    expect(debtors).toMatchObject([
      { businessName: 'Los Andes SA', debtCents: 2_200_000, owedCount: 2, inReview: false },
      { businessName: 'Pampa SRL', debtCents: 500_000, owedCount: 1, inReview: true },
    ]);
  });

  it('cuenta los errores de proceso Pendientes para el banner (RF-181, AC-192, AC-193)', async () => {
    const admin = await start();
    recordProcessError(app.db, { operation: 'revision_casilla', attempts: 1, lastError: 'IMAP' });
    recordProcessError(app.db, { operation: 'revision_casilla', attempts: 1, lastError: 'IMAP' });
    expect((await app.request('GET', '/api/dashboard', { cookie: admin })).body.pendingErrors).toBe(2);

    app.db.update(processErrors).set({ status: 'resuelto' }).run();
    expect((await app.request('GET', '/api/dashboard', { cookie: admin })).body.pendingErrors).toBe(0);
  });

  it('el listado de clientes muestra la deuda vigente total, también $0 (RF-158, AC-165)', async () => {
    const admin = await start();
    const andes = app.db.insert(clients).values(CLIENT).returning().get().id;
    app.db.insert(clients).values({ ...CLIENT, businessName: 'Inactivo', cuit: '20111111112', billingEmail: 'i@i.com', status: 'inactivo' }).run();
    invoice(andes, 1_000_000, 'pendiente_pago');
    invoice(andes, 1_200_000, 'revision_manual');

    const list = (await app.request('GET', '/api/clients', { cookie: admin })).body.clients;
    expect(list.map((c: any) => [c.businessName, c.status, c.debtCents])).toEqual([
      ['Inactivo', 'inactivo', 0],
      ['Los Andes SA', 'activo', 2_200_000],
    ]);
    expect((await app.request('GET', `/api/clients/${andes}`, { cookie: admin })).body.client.debtCents).toBe(2_200_000);
  });
});
