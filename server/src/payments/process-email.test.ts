import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle, type Db } from '../db/index.js';
import { clientEvents, clients, invoices, receivedAttachments, receivedEmails } from '../db/schema.js';
import type { IncomingEmail, Mailbox } from '../mailbox/index.js';
import { runMailboxCheck } from './check.js';
import { MockClassifier } from '../classifier/mock.js';
import { processReceivedEmail } from './process-email.js';

let handle: DatabaseHandle;
let db: Db;
const now = new Date('2026-10-20T12:00:00-03:00');

beforeEach(() => {
  handle = openDatabase(':memory:');
  db = handle.db;
});
afterEach(() => handle.close());

function addClient(values: Partial<typeof clients.$inferInsert> = {}) {
  return db.insert(clients).values({
    businessName: 'Los Andes SA', cuit: '30711111111', address: 'Calle 1',
    billingEmail: 'pagos@losandes.com', ivaCondition: 1, ...values,
  }).returning().get();
}
function addEmail(from: string, attachments: { filename: string; valid: boolean }[] = []) {
  const email = db.insert(receivedEmails).values({
    messageId: `<${Math.random()}@x>`, from: from.toLowerCase(), fromName: null, subject: 'Pago de octubre',
    text: '', receivedAt: new Date('2026-10-20T11:00:00-03:00'), ingestedAt: now,
  }).returning().get();
  for (const a of attachments) {
    db.insert(receivedAttachments).values({ emailId: email.id, ...a, contentType: 'application/pdf', inline: false, content: Buffer.from('x') }).run();
  }
  return email;
}
const deps = () => ({ db, now: () => now, classifier: new MockClassifier(), sleep: async () => {} });
const process = (emailId: number) => processReceivedEmail(deps(), emailId);
const getEmail = (id: number) => db.select().from(receivedEmails).where(eq(receivedEmails.id, id)).get()!;

describe('identificación del remitente', () => {
  it('un remitente que no es cliente queda como aviso Pendiente, sin cliente (RF-113, AC-102)', async () => {
    addClient();
    const email = addEmail('desconocido@otro.com', [{ filename: 'pago.pdf', valid: true }]);

    expect(await process(email.id)).toEqual({ kind: 'aviso' });
    expect(getEmail(email.id)).toMatchObject({ clientId: null, notice: 'pendiente', processedAt: now });
    expect(db.select().from(clientEvents).all()).toEqual([]);
  });

  it('reconoce al cliente sin distinguir mayúsculas y no lo registra como aviso (RF-112, AC-103)', async () => {
    const client = addClient({ billingEmail: 'pagos@losandes.com' });
    const email = addEmail('Pagos@LosAndes.com');

    expect(await process(email.id)).toEqual({ kind: 'cliente', clientId: client.id, classification: null, decision: null });
    expect(getEmail(email.id)).toMatchObject({ clientId: client.id, notice: null });
  });

  it('registra el email en el historial del cliente con fecha, asunto y adjuntos (RF-114, AC-104)', async () => {
    const client = addClient();
    const email = addEmail('pagos@losandes.com', [{ filename: 'pago.pdf', valid: true }, { filename: 'logo.png', valid: false }]);

    await process(email.id);

    const event = db.select().from(clientEvents).where(eq(clientEvents.type, 'email_recibido')).get();
    expect(event).toMatchObject({
      clientId: client.id,
      userId: null,
      data: {
        emailId: email.id,
        subject: 'Pago de octubre',
        receivedAt: '2026-10-20T14:00:00.000Z',
        attachments: [{ filename: 'pago.pdf', valid: true }, { filename: 'logo.png', valid: false }],
      },
    });
  });

  it('procesa igual los emails de un cliente Inactivo (RF-118)', async () => {
    const client = addClient({ status: 'inactivo' });
    expect(await process(addEmail('pagos@losandes.com').id)).toMatchObject({ kind: 'cliente', clientId: client.id });
  });

  it('tras cambiar el email de facturación, la dirección anterior ya no se reconoce (AC-35)', async () => {
    const client = addClient();
    db.update(clients).set({ billingEmail: 'cobranzas@losandes.com' }).where(eq(clients.id, client.id)).run();

    expect(await process(addEmail('pagos@losandes.com').id)).toEqual({ kind: 'aviso' });
    expect(await process(addEmail('cobranzas@losandes.com').id)).toMatchObject({ kind: 'cliente', clientId: client.id });
  });

  it('no procesa dos veces el mismo email', async () => {
    addClient();
    const email = addEmail('pagos@losandes.com');
    await process(email.id);

    expect(await process(email.id)).toEqual({ kind: 'ya_procesado' });
    expect(db.select().from(clientEvents).all().filter((e) => e.type === 'email_recibido')).toHaveLength(1);
  });
});

describe('revisión de la casilla', () => {
  it('lee los emails nuevos y procesa también los que quedaron sin procesar', async () => {
    const client = addClient();
    db.insert(invoices).values({
      clientId: client.id, period: '2026-10', voucherType: 11, pointOfSale: 1, number: 1, cae: '1', caeDueDate: '2026-10-25',
      issueDate: '2026-10-15', serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-10-31',
      totalCents: 100, clientBusinessName: 'x', clientCuit: '1', clientIvaCondition: 1,
    }).run();
    // Quedó registrado pero sin procesar (por ejemplo, se cortó el sistema).
    const leftover = addEmail('pagos@losandes.com');
    const inbox: IncomingEmail[] = [{
      messageId: '<nuevo@x>', from: 'otro@x.com', fromName: null, subject: 'Hola', text: '',
      date: new Date('2026-10-19T10:00:00-03:00'), attachments: [],
    }];
    const mailbox: Mailbox = { fetchSince: async (since) => inbox.filter((e) => e.date >= since) };

    const result = await runMailboxCheck({ ...deps(), mailbox, systemMailbox: 'aldebaran@gmail.com' });

    expect(result.ingested).toBe(1);
    expect(result.outcomes.map((o) => o.outcome.kind).sort()).toEqual(['aviso', 'cliente']);
    expect(getEmail(leftover.id).clientId).toBe(client.id);
  });
});
