import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordProcessError } from '../billing/process-errors.js';
import { MockClassifier } from '../classifier/mock.js';
import { clients, invoices, processErrors, receivedAttachments, receivedEmails } from '../db/schema.js';
import { processReceivedEmail } from '../payments/process-email.js';
import { startTestApp, type TestApp } from '../test/http.js';

let app: TestApp;
let cookie: string;
let seq = 1;

beforeEach(async () => {
  app = await startTestApp();
  cookie = await app.loginAs('admin');
  seq = 1;
});
afterEach(async () => {
  await app.close();
});

function client(name: string, cuit: string, email: string) {
  return app.db.insert(clients).values({ businessName: name, cuit, billingEmail: email, ivaCondition: 1 }).returning().get();
}
function invoice(clientId: number, period: string, pesos: number, status: 'pendiente_pago' | 'pagada' = 'pendiente_pago') {
  return app.db.insert(invoices).values({
    clientId, period, status, voucherType: 11, pointOfSale: 1, number: seq++, cae: '1', caeDueDate: `${period}-25`,
    issueDate: `${period}-15`, serviceFrom: `${period}-01`, serviceTo: `${period}-28`, paymentDueDate: `${period}-28`,
    totalCents: pesos * 100, clientBusinessName: 'x', clientCuit: '1', clientIvaCondition: 1,
  }).returning().get();
}
/** Recibe un email y lo procesa como el agente (clasificador del modo mock). */
async function receive(from: string, subject: string, filenames: string[]) {
  const email = app.db.insert(receivedEmails).values({
    messageId: `<${Math.random()}@x>`, from, subject, text: 'Adjunto', receivedAt: new Date('2026-10-20T15:00:00Z'), ingestedAt: new Date(),
  }).returning().get();
  for (const filename of filenames) {
    app.db.insert(receivedAttachments).values({ emailId: email.id, filename, contentType: 'application/pdf', inline: false, valid: true, content: Buffer.from(`%PDF ${filename}`) }).run();
  }
  await processReceivedEmail({ db: app.db, now: () => new Date(), classifier: new MockClassifier(), sleep: async () => {} }, email.id);
  return email.id;
}
const get = async (path: string, as = cookie) => (await app.request('GET', path, { cookie: as })).body;

describe('interfaz de revisión', () => {
  it('lista las facturas en Pago recibido y Revisión manual con su email, adjuntos, clasificación, CUIT, monto y motivo (RF-141, AC-144)', async () => {
    const andes = client('Los Andes SA', '30711111111', 'pagos@losandes.com');
    const pampa = client('Pampa SRL', '20111111112', 'admin@pampa.com');
    const paid = invoice(andes.id, '2026-10', 100);
    const partial = invoice(pampa.id, '2026-10', 500);
    invoice(andes.id, '2026-09', 999, 'pagada');
    invoice(pampa.id, '2026-09', 777); // Pendiente de pago: no aparece
    const okEmail = await receive('pagos@losandes.com', 'Pago', ['pago_30711111111_100.pdf', 'factura.pdf']);
    // Pampa: el pago parcial va a Revisión manual (la de septiembre también, es adeudada).
    const partialEmail = await receive('admin@pampa.com', 'Pago parcial', ['pago_20111111112_300.pdf']);

    const { invoices: list } = await get('/api/review/invoices');

    expect(list.map((i: any) => [i.clientName, i.number, i.status]).sort()).toEqual([
      ['Los Andes SA', paid.number, 'pago_recibido'],
      ['Pampa SRL', 4, 'revision_manual'],
      ['Pampa SRL', partial.number, 'revision_manual'],
    ].sort());
    const andesInvoice = list.find((i: any) => i.id === paid.id);
    expect(andesInvoice).toMatchObject({ reviewReason: null, totalCents: 10_000 });
    expect(andesInvoice.emails).toMatchObject([{
      id: okEmail, from: 'pagos@losandes.com', subject: 'Pago', classification: 'si',
      attachments: [
        { filename: 'pago_30711111111_100.pdf', classification: 'si', cuit: '30711111111', amount: '100', error: null },
        { filename: 'factura.pdf', classification: 'no', cuit: null, amount: null },
      ],
    }]);
    const pampaInvoice = list.find((i: any) => i.id === partial.id);
    expect(pampaInvoice).toMatchObject({ reviewReason: 'monto no coincide', emails: [{ id: partialEmail }] });
    expect(JSON.stringify(list)).not.toContain('"content"');
  });

  it('acumula los comprobantes de una revisión pendiente (RF-139)', async () => {
    const andes = client('Los Andes SA', '30711111111', 'pagos@losandes.com');
    const a = invoice(andes.id, '2026-10', 100);
    const first = await receive('pagos@losandes.com', 'Parcial', ['pago_30711111111_40.pdf']);
    const second = await receive('pagos@losandes.com', 'Resto', ['pago_30711111111_100.pdf']);

    const [item] = (await get('/api/review/invoices')).invoices;
    expect(item).toMatchObject({ id: a.id, reviewReason: 'revisión manual pendiente' });
    expect(item.emails.map((e: any) => e.id)).toEqual([first, second]);
  });

  it('lista los avisos Pendientes con remitente, asunto, fecha y adjuntos, y no los Revisados (RF-142, AC-145)', async () => {
    const pending = await receive('desconocido@otro.com', 'Hola', ['algo.pdf']);
    const reviewed = await receive('otro@otro.com', 'Viejo', []);
    app.db.update(receivedEmails).set({ notice: 'revisado' }).where(eq(receivedEmails.id, reviewed)).run();

    const { notices } = await get('/api/review/notices');

    expect(notices).toMatchObject([{
      id: pending, from: 'desconocido@otro.com', subject: 'Hola', receivedAt: '2026-10-20T15:00:00.000Z',
      attachments: [{ filename: 'algo.pdf', valid: true, classification: null }],
    }]);
  });

  it('lista los errores de proceso Pendientes con cliente, operación, período, intentos y último error (RF-175, AC-186)', async () => {
    const andes = client('Los Andes SA', '30711111111', 'pagos@losandes.com');
    recordProcessError(app.db, { operation: 'generacion_factura', clientId: andes.id, period: '2026-10', attempts: 4, lastError: 'ARCA no respondió en 30 s.' });
    const solved = recordProcessError(app.db, { operation: 'revision_casilla', attempts: 1, lastError: 'IMAP' });
    app.db.update(processErrors).set({ status: 'resuelto' }).where(eq(processErrors.id, solved.id)).run();

    const { errors } = await get('/api/review/errors');

    expect(errors).toMatchObject([{
      operation: 'generacion_factura', clientName: 'Los Andes SA', period: '2026-10', attempts: 4, lastError: 'ARCA no respondió en 30 s.',
    }]);
  });

  it.each(['editor', 'consulta'] as const)('%s también la ve (RF-09, RF-11, AC-07, AC-11)', async (role) => {
    const as = await app.loginAs(role);
    for (const path of ['/api/review/invoices', '/api/review/notices', '/api/review/errors']) {
      expect((await app.request('GET', path, { cookie: as })).status).toBe(200);
    }
  });

  it('descarga un adjunto de un email recibido', async () => {
    const id = await receive('desconocido@otro.com', 'Hola', ['algo.pdf']);
    const [attachment] = (await get('/api/review/notices')).notices[0].attachments;

    const res = await app.request('GET', `/api/received-emails/${id}/attachments/${attachment.id}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.raw.toString()).toBe('%PDF algo.pdf');
    expect((await app.request('GET', `/api/received-emails/${id + 1}/attachments/${attachment.id}`, { cookie })).status).toBe(404);
  });
});
