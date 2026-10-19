import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle, type Db } from '../db/index.js';
import { invoices, mailboxState, mockMailboxEmails, receivedAttachments, receivedEmails } from '../db/schema.js';
import { startTestApp, type TestApp } from '../test/http.js';
import { attachmentType, isValidAttachment } from './attachments.js';
import { gmailClient, IMAP_TIMEOUT_MS, ImapMailbox, toIncoming } from './imap.js';
import { ingestNewEmails } from './ingest.js';
import { MockMailbox, parseAddress } from './mock.js';
import { MailboxError, type IncomingEmail, type Mailbox } from './types.js';

const PDF = Buffer.from('%PDF-1.4 comprobante');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('adjuntos válidos (RF-115 a RF-117)', () => {
  it('solo imágenes JPEG, PNG, GIF, WebP y PDF que no estén embebidas', () => {
    expect(isValidAttachment({ filename: 'c.pdf', contentType: 'application/pdf', inline: false })).toBe(true);
    expect(isValidAttachment({ filename: 'c.png', contentType: 'image/png', inline: false })).toBe(true);
    expect(isValidAttachment({ filename: 'c.webp', contentType: 'image/webp', inline: false })).toBe(true);
    expect(isValidAttachment({ filename: 'logo.png', contentType: 'image/png', inline: true })).toBe(false); // AC-106
    expect(isValidAttachment({
      filename: 'c.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false,
    })).toBe(false); // AC-107
    expect(isValidAttachment({ filename: 'c.txt', contentType: 'text/plain', inline: false })).toBe(false);
  });

  it('deduce el tipo por la extensión cuando llega como application/octet-stream', () => {
    expect(attachmentType({ filename: 'Comprobante.PDF', contentType: 'application/octet-stream' })).toBe('application/pdf');
    expect(isValidAttachment({ filename: 'foto.jpg', contentType: 'application/octet-stream', inline: false })).toBe(true);
    expect(isValidAttachment({ filename: 'algo.zip', contentType: 'application/octet-stream', inline: false })).toBe(false);
  });
});

describe('parseo de emails reales (MIME)', () => {
  async function compose(options: ConstructorParameters<typeof MailComposer>[0]) {
    const raw = await new MailComposer(options).compile().build();
    return toIncoming(await simpleParser(raw), new Date('2026-10-20T15:00:00Z'));
  }

  it('distingue el adjunto PDF de la imagen embebida en la firma y del .docx (AC-106, AC-107)', async () => {
    const email = await compose({
      from: '"Los Andes SA" <Pagos@LosAndes.com>',
      to: 'aldebaran@gmail.com',
      subject: 'Pago de octubre',
      messageId: '<pago-1@losandes.com>',
      text: 'Adjunto el comprobante.',
      html: '<p>Adjunto el comprobante.</p><img src="cid:logo@firma">',
      attachments: [
        { filename: 'comprobante.pdf', content: PDF, contentType: 'application/pdf' },
        { filename: 'logo.png', content: PNG, contentType: 'image/png', cid: 'logo@firma' },
        { filename: 'notas.docx', content: Buffer.from('docx'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ],
    });

    expect(email).toMatchObject({
      // nodemailer normaliza el dominio; al registrar el email se pasa todo a minúsculas.
      messageId: '<pago-1@losandes.com>', from: 'Pagos@losandes.com', fromName: 'Los Andes SA',
      subject: 'Pago de octubre', date: new Date('2026-10-20T15:00:00Z'),
    });
    expect(email.text.trim()).toBe('Adjunto el comprobante.');
    // El orden en el MIME depende del cliente de email: se compara por nombre.
    const byName = Object.fromEntries(email.attachments.map((a) => [a.filename, [a.inline, isValidAttachment(a)]]));
    expect(byName).toEqual({
      'comprobante.pdf': [false, true],
      'logo.png': [true, false],
      'notas.docx': [false, false],
    });
    expect(email.attachments.find((a) => a.filename === 'comprobante.pdf')!.content.equals(PDF)).toBe(true);
  });
});

describe('IMAP (Gmail)', () => {
  /** Cliente IMAP falso con mensajes en crudo y su fecha de llegada. */
  function fakeClient(messages: { raw: Buffer; internalDate: Date }[], options: { failOn?: 'connect' } = {}) {
    const client = {
      connect: vi.fn(async () => {
        if (options.failOn === 'connect') throw new Error('Connection timeout');
      }),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      search: vi.fn(async () => messages.map((_, i) => i + 1)),
      fetch: vi.fn(async function* () {
        for (const [i, m] of messages.entries()) yield { uid: i + 1, internalDate: m.internalDate, source: m.raw };
      }),
      logout: vi.fn(async () => {}),
      close: vi.fn(),
    };
    return client;
  }
  const raw = (subject: string) =>
    new MailComposer({ from: 'pagos@losandes.com', to: 'a@gmail.com', subject, text: 'x', messageId: `<${subject}@x>` }).compile().build();

  it('devuelve los emails llegados desde la fecha pedida, aunque IMAP busque por día', async () => {
    const client = fakeClient([
      { raw: await raw('antes'), internalDate: new Date('2026-10-20T09:00:00-03:00') },
      { raw: await raw('despues'), internalDate: new Date('2026-10-20T11:00:00-03:00') },
    ]);
    const mailbox = new ImapMailbox({ user: 'a@gmail.com', appPassword: 'x' }, () => client as never);

    const emails = await mailbox.fetchSince(new Date('2026-10-20T10:00:00-03:00'));

    expect(emails.map((e) => e.subject)).toEqual(['despues']);
    expect(client.logout).toHaveBeenCalled();
  });

  it('informa si no puede conectarse', async () => {
    const mailbox = new ImapMailbox({ user: 'a@gmail.com', appPassword: 'x' }, () => fakeClient([], { failOn: 'connect' }) as never);
    await expect(mailbox.fetchSince(new Date())).rejects.toThrow(new MailboxError('No se pudo leer la casilla: Connection timeout'));
  });

  it('usa Gmail con la contraseña de aplicación y 30 s de timeout (RNF-07, AC-227)', () => {
    const client = gmailClient({ user: 'aldebaran@gmail.com', appPassword: 'clave-app' }) as unknown as { options: Record<string, unknown> };
    expect(client.options).toMatchObject({
      host: 'imap.gmail.com', port: 993, secure: true, auth: { user: 'aldebaran@gmail.com', pass: 'clave-app' },
      connectionTimeout: IMAP_TIMEOUT_MS, greetingTimeout: IMAP_TIMEOUT_MS, socketTimeout: IMAP_TIMEOUT_MS,
    });
  });
});

describe('ingreso de emails nuevos', () => {
  let handle: DatabaseHandle;
  let db: Db;
  let inbox: IncomingEmail[];
  let now: Date;
  const mailbox: Mailbox = { fetchSince: async (since) => inbox.filter((e) => e.date >= since) };

  beforeEach(() => {
    handle = openDatabase(':memory:');
    db = handle.db;
    inbox = [];
    now = new Date('2026-10-20T12:00:00-03:00');
  });
  afterEach(() => handle.close());

  const ingest = (mb: Mailbox = mailbox) =>
    ingestNewEmails({ db, mailbox: mb, systemMailbox: 'Aldebaran@Gmail.com', now: () => now });
  const email = (id: string, date: string, extra: Partial<IncomingEmail> = {}): IncomingEmail => ({
    messageId: `<${id}@x>`, from: 'Pagos@LosAndes.com', fromName: null, subject: id, text: '',
    date: new Date(date), attachments: [], ...extra,
  });
  function firstInvoice(issueDate: string) {
    db.insert(invoices).values({
      clientId: 1, period: issueDate.slice(0, 7), voucherType: 11, pointOfSale: 1, number: 1, cae: '1',
      caeDueDate: issueDate, issueDate, serviceFrom: issueDate, serviceTo: issueDate, paymentDueDate: issueDate,
      totalCents: 100, clientBusinessName: 'x', clientCuit: '1', clientIvaCondition: 1,
    }).run();
  }
  const stored = () => db.select().from(receivedEmails).all().map((e) => e.subject);

  beforeEach(() => {
    db.run(`insert into clients (id, business_name, cuit, billing_email, iva_condition, status, created_at, updated_at)
      values (1, 'Los Andes', '30711111111', 'pagos@losandes.com', 1, 'activo', 0, 0)`);
  });

  it('sin facturas emitidas no procesa nada', async () => {
    inbox = [email('a', '2026-10-19T10:00:00-03:00')];
    expect(await ingest()).toEqual({ emailIds: [], since: null });
  });

  it('la primera vez lee desde el día de la primera factura; después, desde la revisión anterior (RF-107, RF-108, AC-99)', async () => {
    firstInvoice('2026-10-15');
    inbox = [email('antes', '2026-10-14T23:00:00-03:00'), email('mismo-dia', '2026-10-15T08:00:00-03:00'), email('despues', '2026-10-18T10:00:00-03:00')];

    const first = await ingest();
    expect(first.since).toEqual(new Date('2026-10-15T00:00:00-03:00'));
    expect(stored()).toEqual(['mismo-dia', 'despues']);

    inbox.push(email('nuevo', '2026-10-20T12:05:00-03:00'));
    now = new Date('2026-10-20T12:15:00-03:00');
    const second = await ingest();
    expect(second.since).toEqual(new Date('2026-10-20T12:00:00-03:00'));
    expect(stored()).toEqual(['mismo-dia', 'despues', 'nuevo']);
  });

  it('registra cada email una sola vez, aunque se vuelva a leer (RF-109, AC-100)', async () => {
    firstInvoice('2026-10-15');
    inbox = [email('a', '2026-10-20T11:59:00-03:00')];
    await ingest();
    db.delete(mailboxState).run(); // fuerza a releer todo
    expect((await ingest()).emailIds).toEqual([]);
    expect(stored()).toEqual(['a']);
  });

  it('ignora los emails de la propia casilla, sin distinguir mayúsculas (RF-110, AC-101)', async () => {
    firstInvoice('2026-10-15');
    inbox = [email('propio', '2026-10-16T10:00:00-03:00', { from: 'aldebaran@gmail.com' }), email('cliente', '2026-10-16T10:00:00-03:00')];
    await ingest();
    expect(stored()).toEqual(['cliente']);
  });

  it('guarda los adjuntos marcando cuáles son válidos y el remitente en minúsculas (RF-112)', async () => {
    firstInvoice('2026-10-15');
    inbox = [email('a', '2026-10-16T10:00:00-03:00', {
      attachments: [
        { filename: 'c.pdf', contentType: 'application/pdf', inline: false, content: PDF },
        { filename: 'logo.png', contentType: 'image/png', inline: true, content: PNG },
      ],
    })];
    await ingest();
    expect(db.select().from(receivedEmails).get()!.from).toBe('pagos@losandes.com');
    expect(db.select().from(receivedAttachments).all().map((a) => [a.filename, a.valid])).toEqual([['c.pdf', true], ['logo.png', false]]);
  });

  it('si la casilla falla no avanza la marca, y al volver procesa los emails llegados durante la falla (RF-104, RF-105, AC-98)', async () => {
    firstInvoice('2026-10-15');
    await ingest(); // revisión de las 12:00
    const failing: Mailbox = { fetchSince: async () => { throw new MailboxError('IMAP sin respuesta'); } };

    inbox = [email('durante-1', '2026-10-20T12:05:00-03:00'), email('durante-2', '2026-10-20T12:20:00-03:00')];
    now = new Date('2026-10-20T12:15:00-03:00');
    await expect(ingest(failing)).rejects.toThrow('IMAP sin respuesta');
    now = new Date('2026-10-20T12:30:00-03:00');
    await expect(ingest(failing)).rejects.toThrow();

    now = new Date('2026-10-20T12:45:00-03:00');
    await ingest();
    expect(stored()).toEqual(['durante-1', 'durante-2']);
  });

  it('con la casilla simulada lee los recibidos cargados, no los enviados (RF-203)', async () => {
    firstInvoice('2026-10-15');
    const add = (direction: 'enviado' | 'recibido', from: string, subject: string) =>
      db.insert(mockMailboxEmails).values({
        direction, messageId: `<${subject}@mock>`, from, to: 'x', subject, text: '', date: new Date('2026-10-19T10:00:00-03:00'),
      }).run();
    add('recibido', 'Pagos@LosAndes.com', 'pago');
    add('enviado', 'Aldebaran <aldebaran-mock@gmail.com>', 'factura');
    add('recibido', 'aldebaran-mock@gmail.com', 'propio'); // AC-201

    await ingestNewEmails({ db, mailbox: new MockMailbox(db), systemMailbox: 'aldebaran-mock@gmail.com', now: () => now });

    expect(stored()).toEqual(['pago']);
  });

  it('parseAddress separa nombre y dirección', () => {
    expect(parseAddress('"Los Andes" <pagos@losandes.com>')).toEqual({ from: 'pagos@losandes.com', fromName: 'Los Andes' });
    expect(parseAddress('pagos@losandes.com')).toEqual({ from: 'pagos@losandes.com', fromName: null });
  });
});

describe('casilla simulada (API)', () => {
  it('muestra qué hizo el agente con cada email recibido', async () => {
    app = await startTestApp({ mockMode: true });
    const admin = await app.loginAs('admin');
    app.db.run(`insert into clients (business_name, cuit, billing_email, iva_condition, status, created_at, updated_at)
      values ('Los Andes', '30711111111', 'pagos@losandes.com', 1, 'activo', 0, 0)`);
    app.db.run(`insert into invoices (client_id, period, status, voucher_type, point_of_sale, number, cae, cae_due_date, issue_date,
      service_from, service_to, payment_due_date, total_cents, client_business_name, client_cuit, client_iva_condition, created_at, updated_at)
      values (1, '2026-10', 'pendiente_pago', 11, 1, 7, '1', '2026-10-25', '2026-10-15', '2026-10-01', '2026-10-31', '2026-10-31',
      1500050, 'Los Andes', '30711111111', 1, 0, 0)`);
    await upload(admin, { subject: 'Pago' });
    await upload(admin, { from: 'otro@x.com', subject: 'Consulta', attachments: [] });
    const before = (await app.request('GET', '/api/mock-mailbox', { cookie: admin })).body.emails;
    expect(before.map((e: any) => e.processing.status)).toEqual(['pendiente', 'pendiente']);

    const { runMailboxCheck } = await import('../payments/check.js');
    const { MockClassifier } = await import('../classifier/mock.js');
    await runMailboxCheck({
      db: app.db, now: () => new Date(), mailbox: new MockMailbox(app.db), systemMailbox: 'aldebaran-mock@gmail.com',
      classifier: new MockClassifier(), sleep: async () => {},
    });

    const after = (await app.request('GET', '/api/mock-mailbox', { cookie: admin })).body.emails;
    const bySubject = Object.fromEntries(after.map((e: any) => [e.subject, e.processing]));
    expect(bySubject.Consulta).toMatchObject({ status: 'aviso', clientName: null });
    expect(bySubject.Pago).toMatchObject({
      status: 'procesado', clientName: 'Los Andes', classification: 'si', validationResult: 'pago_recibido', validationRule: 'RF-134',
      changes: [{ pointOfSale: 1, number: 7, to: 'pago_recibido', reason: null }],
      attachments: [{ filename: 'pago_30711111111_15000.50.pdf', valid: true, classification: 'si', cuit: '30711111111', amount: '15000.50', error: null }],
    });
  });


  let app: TestApp;
  afterEach(async () => {
    await app?.close();
  });
  const upload = (cookie: string, body: Record<string, unknown> = {}) =>
    app.request('POST', '/api/mock-mailbox', {
      cookie,
      body: {
        from: 'pagos@losandes.com', subject: 'Pago', text: 'Adjunto comprobante',
        attachments: [{ filename: 'pago_30711111111_15000.50.pdf', contentType: 'application/pdf', contentBase64: PDF.toString('base64') }],
        ...body,
      },
    });

  it('un Admin o Editor carga un email recibido con Message-ID único y fecha de carga (RF-200 a RF-202, AC-203)', async () => {
    const now = new Date('2026-10-20T12:00:00-03:00');
    app = await startTestApp({ mockMode: true, now: () => now });
    const editor = await app.loginAs('editor');
    const admin = await app.loginAs('admin');

    const first = await upload(editor);
    const second = await upload(admin);

    expect(first.status).toBe(201);
    expect(first.body.email).toMatchObject({ direction: 'recibido', from: 'pagos@losandes.com', to: 'aldebaran-mock@gmail.com' });
    expect(new Date(first.body.email.date)).toEqual(now);
    expect(first.body.email.messageId).not.toBe(second.body.email.messageId);

    // El remitente no es un cliente: solo el Admin lo ve (RF-198).
    const list = (await app.request('GET', '/api/mock-mailbox', { cookie: admin })).body.emails;
    expect(list[0].attachments).toMatchObject([{ filename: 'pago_30711111111_15000.50.pdf', contentType: 'application/pdf', inline: false }]);
    const download = await app.request('GET', `/api/mock-mailbox/${list[0].id}/attachments/${list[0].attachments[0].id}`, { cookie: admin });
    expect(download.raw.equals(PDF)).toBe(true);
  });

  it('valida el remitente', async () => {
    app = await startTestApp({ mockMode: true });
    expect((await upload(await app.loginAs('admin'), { from: 'no-es-email' })).status).toBe(400);
  });

  it('Consulta no puede cargar emails (AC-219)', async () => {
    app = await startTestApp({ mockMode: true });
    expect((await upload(await app.loginAs('consulta'))).status).toBe(403);
    expect(app.db.select().from(mockMailboxEmails).all()).toEqual([]);
  });

  it('fuera del modo mock no existe (RF-204, AC-220)', async () => {
    app = await startTestApp({ mockMode: false });
    const admin = await app.loginAs('admin');
    expect((await app.request('GET', '/api/mock-mailbox', { cookie: admin })).status).toBe(404);
    expect((await upload(admin)).status).toBe(404);
    expect(app.db.select().from(mockMailboxEmails).all()).toEqual([]);
  });

  it('el Admin ve enviados y recibidos; Editor y Consulta, solo los recibidos de clientes (RF-197, RF-198, AC-221)', async () => {
    app = await startTestApp({ mockMode: true });
    app.db.run(`insert into clients (business_name, cuit, billing_email, iva_condition, status, created_at, updated_at)
      values ('Los Andes', '30711111111', 'Pagos@LosAndes.com', 1, 'activo', 0, 0)`);
    const admin = await app.loginAs('admin');
    await upload(admin); // de un cliente
    await upload(admin, { from: 'desconocido@otro.com' });
    app.db.insert(mockMailboxEmails).values({
      direction: 'enviado', messageId: '<f@mock>', from: 'Aldebaran <aldebaran-mock@gmail.com>', to: 'pagos@losandes.com',
      subject: 'Factura', text: '', date: new Date(),
    }).run();

    const subjects = async (cookie: string) =>
      (await app.request('GET', '/api/mock-mailbox', { cookie })).body.emails.map((e: any) => `${e.direction}:${e.from}`).sort();

    expect(await subjects(admin)).toEqual([
      'enviado:Aldebaran <aldebaran-mock@gmail.com>', 'recibido:desconocido@otro.com', 'recibido:pagos@losandes.com',
    ]);
    for (const role of ['editor', 'consulta'] as const) {
      expect(await subjects(await app.loginAs(role))).toEqual(['recibido:pagos@losandes.com']);
    }
  });
});
