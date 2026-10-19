import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockArcaClient } from '../arca/mock.js';
import { runBillingProcess } from '../billing/process.js';
import { loadConfig } from '../config.js';
import { openDatabase, type DatabaseHandle, type Db } from '../db/index.js';
import {
  clientEvents,
  clientProducts,
  clients,
  invoices,
  mockMailboxAttachments,
  mockMailboxEmails,
  processErrors,
  products,
  settings,
} from '../db/schema.js';
import { createMailer, EmailError, type Mailer, type OutgoingEmail } from '../email/index.js';
import { MockMailer } from '../email/mock.js';
import { SMTP_TIMEOUT_MS, SmtpMailer, gmailTransport } from '../email/smtp.js';
import { getSettings } from '../settings/settings.js';
import { buildInvoiceEmail, deliverInvoiceEmail, emailSenderName, sendInvoiceEmail } from './email.js';
import { HOMOLOGATION_NOTICE, MOCK_NOTICE } from './pdf.js';

let handle: DatabaseHandle;
let db: Db;
let numberSeq = 1;
beforeEach(() => {
  handle = openDatabase(':memory:');
  db = handle.db;
  numberSeq = 1;
});
afterEach(() => handle.close());

function addClient(values: Partial<typeof clients.$inferInsert> = {}) {
  return db.insert(clients).values({
    businessName: 'Los Andes SA', cuit: '30711111111', address: 'San Martín 100',
    billingEmail: 'pagos@losandes.com', ivaCondition: 1, ...values,
  }).returning().get();
}
function addInvoice(clientId: number, values: Partial<typeof invoices.$inferInsert> = {}) {
  return db.insert(invoices).values({
    clientId, period: '2026-10', voucherType: 11, pointOfSale: 1, number: numberSeq++,
    cae: '76421234567890', caeDueDate: '2026-10-25', issueDate: '2026-10-15',
    serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-10-31',
    totalCents: 20_160_000, clientBusinessName: 'Los Andes SA', clientCuit: '30711111111',
    clientAddress: 'San Martín 100', clientIvaCondition: 1, ...values,
  }).returning().get();
}
const mockMailer = () => new MockMailer(db, 'aldebaran-mock@gmail.com', () => new Date('2026-10-15T14:00:00Z'));
const sentEmails = () => db.select().from(mockMailboxEmails).all();

describe('contenido del email de la factura', () => {
  it('informa la factura, la deuda total con facturas anteriores y pide el comprobante (RF-88, RF-89, AC-81)', () => {
    const client = addClient();
    const september = addInvoice(client.id, {
      period: '2026-09', totalCents: 1_500_000, status: 'revision_manual', paymentDueDate: '2026-09-30', number: 7,
    });
    const october = addInvoice(client.id, { totalCents: 20_160_000, number: 12 });

    const { subject, text, html } = buildInvoiceEmail(october, [september, october], { senderName: 'Aldebaran SAS', mockMode: false });

    expect(subject).toBe('Factura C 00001-00000012 - octubre de 2026');
    for (const fragment of [
      'Hola, Los Andes SA:', 'Tenés una deuda pendiente.',
      'Factura: C 00001-00000012', 'Período: octubre de 2026', 'Importe: $ 201.600,00', 'Vencimiento: 31/10/2026',
      'Tu deuda pendiente total es de $ 216.600,00, e incluye una factura anterior además de esta:',
      'Factura 00001-00000007 de septiembre de 2026: $ 15.000,00, vencimiento 30/09/2026',
      'respondé este email adjuntando el comprobante de pago',
      'Aldebaran SAS',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
    expect(html).toContain('$ 216.600,00');
    expect(html).toContain('adjuntando el comprobante de pago');
  });

  it('sin facturas anteriores, la deuda total es la de la factura', () => {
    const client = addClient();
    const invoice = addInvoice(client.id);
    const { text } = buildInvoiceEmail(invoice, [invoice], { senderName: 'Aldebaran', mockMode: false });
    expect(text).toContain('Tu deuda pendiente total es de $ 201.600,00.');
    expect(text).not.toContain('anterior');
  });

  it('indica homologación o modo mock (RF-90, RF-210, AC-82, AC-207)', () => {
    const invoice = addInvoice(addClient().id);
    const homo = buildInvoiceEmail(invoice, [invoice], { senderName: 'Aldebaran', mockMode: false });
    const mock = buildInvoiceEmail(invoice, [invoice], { senderName: 'Aldebaran', mockMode: true });
    expect(homo.text).toContain(HOMOLOGATION_NOTICE);
    expect(homo.html).toContain(HOMOLOGATION_NOTICE);
    expect(mock.text).toContain(MOCK_NOTICE);
  });

  it('escapa el HTML de los datos del cliente', () => {
    const invoice = addInvoice(addClient().id, { clientBusinessName: 'A & B <SA>' });
    expect(buildInvoiceEmail(invoice, [invoice], { senderName: 'Aldebaran', mockMode: false }).html).toContain('A &amp; B &lt;SA&gt;');
  });
});

describe('remitente y firma (RF-215)', () => {
  it('usa el nombre de fantasía; si no hay, la razón social; si no, "Aldebaran"', () => {
    expect(emailSenderName({ issuerTradeName: 'Estudio Molina', issuerBusinessName: 'Molina Hernando Agustina Maria' })).toBe('Estudio Molina');
    expect(emailSenderName({ issuerTradeName: null, issuerBusinessName: 'Molina Hernando Agustina Maria' })).toBe('Molina Hernando Agustina Maria');
    expect(emailSenderName({ issuerTradeName: null, issuerBusinessName: null })).toBe('Aldebaran');
  });

  it('el remitente y la firma muestran el nombre de fantasía, y el PDF la razón social (AC-237)', async () => {
    getSettings(db);
    db.update(settings).set({ issuerBusinessName: 'Molina Hernando Agustina Maria', issuerTradeName: 'Estudio Molina' }).run();
    const invoice = addInvoice(addClient().id);

    await sendInvoiceEmail({ db, mailer: mockMailer(), issuerCuit: '20111111112', mockMode: true }, invoice.id);

    const [email] = sentEmails();
    expect(email!.from).toBe('Estudio Molina <aldebaran-mock@gmail.com>');
    expect(email!.text).toMatch(/Saludos,\nEstudio Molina\n/);
    const pdf = db.select().from(mockMailboxAttachments).get()!.content.toString('latin1');
    expect(pdf).not.toContain('Estudio Molina');
  });

  it('por SMTP manda el nombre como remitente visible', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc>' });
    const mailer = new SmtpMailer({ user: 'aldebaran@gmail.com', appPassword: 'x', redirectTo: null }, { sendMail });
    await mailer.send({ fromName: 'Estudio Molina', to: 'a@b.com', subject: 's', text: 't' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: { name: 'Estudio Molina', address: 'aldebaran@gmail.com' } }));
  });
});

describe('envío del email de la factura', () => {
  it('en modo mock queda en la casilla simulada con el PDF adjunto, sin Gmail (RF-84, RF-196, AC-200)', async () => {
    const invoice = addInvoice(addClient().id);

    expect(await sendInvoiceEmail({ db, mailer: mockMailer(), issuerCuit: '20111111112', mockMode: true }, invoice.id)).toBe(true);

    const [email] = sentEmails();
    expect(email).toMatchObject({
      direction: 'enviado', from: 'Aldebaran <aldebaran-mock@gmail.com>', to: 'pagos@losandes.com',
      subject: 'Factura C 00001-00000001 - octubre de 2026', date: new Date('2026-10-15T14:00:00Z'),
    });
    expect(email!.text).toContain(MOCK_NOTICE);
    const [attachment] = db.select().from(mockMailboxAttachments).all();
    expect(attachment).toMatchObject({ filename: 'factura-c-00001-00000001.pdf', contentType: 'application/pdf' });
    expect(attachment!.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('va al email de facturación actual del cliente (AC-35)', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id);
    db.update(clients).set({ billingEmail: 'cobranzas@losandes.com' }).where(eq(clients.id, client.id)).run();

    await sendInvoiceEmail({ db, mailer: mockMailer(), issuerCuit: '20111111112', mockMode: true }, invoice.id);

    expect(sentEmails()[0]!.to).toBe('cobranzas@losandes.com');
  });

  it('registra el envío en el historial del cliente con fecha y destinatario (AC-78)', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id);
    await sendInvoiceEmail({ db, mailer: mockMailer(), issuerCuit: '20111111112', mockMode: true }, invoice.id);

    const event = db.select().from(clientEvents).where(eq(clientEvents.type, 'email_enviado')).get();
    expect(event).toMatchObject({ clientId: client.id, userId: null, data: { kind: 'factura', invoiceId: invoice.id, to: 'pagos@losandes.com' } });
    expect(event!.createdAt).toBeInstanceOf(Date);
  });

  it('no envía nada a un cliente Inactivo (RF-96)', async () => {
    const invoice = addInvoice(addClient({ status: 'inactivo' }).id);
    expect(await sendInvoiceEmail({ db, mailer: mockMailer(), issuerCuit: '20111111112', mockMode: true }, invoice.id)).toBe(false);
    expect(sentEmails()).toEqual([]);
  });
});

describe('reintentos del envío (RF-86, RF-171, RF-174)', () => {
  /** Mailer que falla las primeras `failures` veces. */
  function flakyMailer(failures: number) {
    const inner = mockMailer();
    const send = vi.fn(async (email: OutgoingEmail) => {
      if (send.mock.calls.length <= failures) throw new EmailError('SMTP rechazó el envío (simulado).');
      return inner.send(email);
    });
    return { from: inner.from, send } satisfies Mailer;
  }

  it('reintenta sin generar otra factura y, si el segundo envío sale, no registra error (AC-80)', async () => {
    const invoice = addInvoice(addClient().id);
    const mailer = flakyMailer(1);
    const sleeps: number[] = [];

    await deliverInvoiceEmail({ db, mailer, issuerCuit: '20111111112', mockMode: true, sleep: async (ms) => void sleeps.push(ms) }, invoice);

    expect(mailer.send).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([5 * 60_000]);
    expect(sentEmails()).toHaveLength(1);
    expect(db.select().from(invoices).all()).toHaveLength(1);
    expect(db.select().from(processErrors).all()).toEqual([]);
  });

  it('con el servidor rechazando todo hace 4 intentos y registra el error "envío de factura" (AC-180)', async () => {
    const client = addClient();
    const invoice = addInvoice(client.id);
    const mailer = flakyMailer(99);

    await deliverInvoiceEmail({ db, mailer, issuerCuit: '20111111112', mockMode: true, sleep: async () => {} }, invoice);

    expect(mailer.send).toHaveBeenCalledTimes(4);
    expect(db.select().from(invoices).get()!.status).toBe('pendiente_pago');
    expect(db.select().from(processErrors).all()).toMatchObject([{
      operation: 'envio_factura', status: 'pendiente', clientId: client.id, invoiceId: invoice.id,
      period: '2026-10', attempts: 4, lastError: 'SMTP rechazó el envío (simulado).',
    }]);
  });

  it('respeta la cantidad de reintentos configurada (AC-182)', async () => {
    getSettings(db);
    db.update(settings).set({ retryCount: 0 }).run();
    const mailer = flakyMailer(99);

    await deliverInvoiceEmail({ db, mailer, issuerCuit: '20111111112', mockMode: true, sleep: async () => {} }, addInvoice(addClient().id));

    expect(mailer.send).toHaveBeenCalledTimes(1);
  });
});

describe('integración con el proceso de facturación', () => {
  it('en modo mock, cada factura generada sale por email con su PDF (RF-84, RF-85)', async () => {
    const client = addClient();
    const product = db.insert(products).values({ name: 'ERP', priceCents: 1_500_000, currency: 'ARS' }).returning().get();
    db.insert(clientProducts).values({ clientId: client.id, productId: product.id }).run();
    const mailer = mockMailer();

    await runBillingProcess({
      db, arca: new MockArcaClient(db), readRate: async () => 150_000, now: () => new Date('2026-10-15T14:00:00Z'),
      sleep: async () => {},
      onInvoiceGenerated: (invoice) =>
        deliverInvoiceEmail({ db, mailer, issuerCuit: '20111111112', mockMode: true, sleep: async () => {} }, invoice),
    }, '2026-10');

    expect(sentEmails()).toMatchObject([{ to: 'pagos@losandes.com', subject: 'Factura C 00001-00000001 - octubre de 2026' }]);
    expect(db.select().from(mockMailboxAttachments).all()).toHaveLength(1);
  });
});

describe('SMTP (Gmail)', () => {
  const email: OutgoingEmail = {
    to: 'pagos@losandes.com', subject: 'Factura C 00001-00000001', text: 'hola', html: '<p>hola</p>',
    attachments: [{ filename: 'f.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-') }],
  };

  it('envía desde la casilla del sistema con el adjunto', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@gmail.com>' });
    const mailer = new SmtpMailer({ user: 'aldebaran@gmail.com', appPassword: 'x', redirectTo: null }, { sendMail });

    expect(await mailer.send(email)).toEqual({ messageId: '<abc@gmail.com>', to: 'pagos@losandes.com' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'aldebaran@gmail.com', to: 'pagos@losandes.com', subject: 'Factura C 00001-00000001', attachments: email.attachments,
    }));
  });

  it('con EMAIL_REDIRECT_TO manda todo a esa casilla y aclara el destinatario original', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc>' });
    const mailer = new SmtpMailer({ user: 'aldebaran@gmail.com', appPassword: 'x', redirectTo: 'yo@test.com' }, { sendMail });

    await mailer.send(email);

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'yo@test.com', subject: '[para pagos@losandes.com] Factura C 00001-00000001',
    }));
  });

  it('informa el error del servidor', async () => {
    const mailer = new SmtpMailer({ user: 'a@gmail.com', appPassword: 'x', redirectTo: null }, {
      sendMail: vi.fn().mockRejectedValue(new Error('Invalid login')),
    });
    await expect(mailer.send(email)).rejects.toThrow('No se pudo enviar el email a pagos@losandes.com: Invalid login');
  });

  it('usa Gmail con la contraseña de aplicación y 30 s de timeout (RNF-07, RNF-11, AC-227)', () => {
    const transport = gmailTransport({ user: 'aldebaran@gmail.com', appPassword: 'clave-app', redirectTo: null });
    const options = (transport as unknown as { options: Record<string, unknown> }).options;
    expect(options).toMatchObject({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: 'aldebaran@gmail.com', pass: 'clave-app' },
      connectionTimeout: SMTP_TIMEOUT_MS, greetingTimeout: SMTP_TIMEOUT_MS, socketTimeout: SMTP_TIMEOUT_MS,
    });
    expect(SMTP_TIMEOUT_MS).toBe(30_000);
  });

  it('createMailer usa la casilla simulada en modo mock y Gmail fuera de él (RF-194, RF-195)', () => {
    const mock = createMailer(loadConfig({ MOCK_MODE: 'true' }), db);
    expect(mock).toBeInstanceOf(MockMailer);
    expect(mock.from).toBe('aldebaran-mock@gmail.com');

    const real = createMailer(loadConfig({
      ANTHROPIC_API_KEY: 'x', GMAIL_USER: 'aldebaran@gmail.com', GMAIL_APP_PASSWORD: 'x',
      ARCA_CUIT: '30711111111', ARCA_CERT_PATH: 'c', ARCA_KEY_PATH: 'k',
    }), db);
    expect(real).toBeInstanceOf(SmtpMailer);
    expect(real.from).toBe('aldebaran@gmail.com');
  });
});
