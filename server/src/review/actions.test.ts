import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { recordProcessError } from '../billing/process-errors.js';
import { clientEvents, clientProducts, clients, invoiceEmails, invoices, mockMailboxEmails, processErrors, products, receivedEmails } from '../db/schema.js';
import { owedInvoices } from '../invoices/email.js';
import { startTestApp, type TestApp } from '../test/http.js';

let app: TestApp;
let now = new Date('2026-10-20T12:00:00-03:00');
afterEach(async () => {
  await app?.close();
});

async function setup(at = '2026-10-20T12:00:00-03:00') {
  now = new Date(at);
  app = await startTestApp({ now: () => now });
  const clientId = app.db.insert(clients).values({
    businessName: 'Los Andes SA', cuit: '30711111111', address: 'Calle 1', billingEmail: 'pagos@losandes.com', ivaCondition: 1,
  }).returning().get().id;
  return { clientId, admin: await app.loginAs('admin') };
}
let seq = 1;
function invoice(clientId: number, status: 'pendiente_pago' | 'pago_recibido' | 'revision_manual' | 'pagada', reviewReason: string | null = null) {
  return app.db.insert(invoices).values({
    clientId, period: '2026-10', status, reviewReason, voucherType: 11, pointOfSale: 9, number: seq++, cae: '1',
    caeDueDate: '2026-10-25', issueDate: '2026-10-15', serviceFrom: '2026-10-01', serviceTo: '2026-10-31',
    paymentDueDate: '2026-10-31', totalCents: 100_000, clientBusinessName: 'Los Andes SA', clientCuit: '30711111111', clientIvaCondition: 1,
  }).returning().get();
}
const post = (path: string, cookie: string) => app.request('POST', path, { cookie });
const state = (id: number) => app.db.select({ status: invoices.status, reason: invoices.reviewReason }).from(invoices).where(eq(invoices.id, id)).get();

describe('acciones sobre las facturas', () => {
  it('Pago recibido → Pagada, y deja de contar como adeudada (RF-143, AC-146)', async () => {
    const { clientId, admin } = await setup();
    const a = invoice(clientId, 'pago_recibido');

    expect((await post(`/api/invoices/${a.id}/mark-paid`, admin)).status).toBe(200);
    expect(state(a.id)!.status).toBe('pagada');
    expect(owedInvoices(app.db, clientId)).toEqual([]);
  });

  it('Pago recibido → Pendiente de pago (RF-144, AC-147)', async () => {
    const { clientId, admin } = await setup();
    const a = invoice(clientId, 'pago_recibido');
    await post(`/api/invoices/${a.id}/return-to-pending`, admin);
    expect(state(a.id)!.status).toBe('pendiente_pago');
  });

  it.each([
    ['mark-paid', 'pagada'],
    ['return-to-pending', 'pendiente_pago'],
  ] as const)('Revisión manual → %s deja de mostrar el motivo (RF-140, RF-145, RF-146, AC-148, AC-149, AC-151)', async (action, to) => {
    const { clientId, admin } = await setup();
    const a = invoice(clientId, 'revision_manual', 'monto no coincide');
    await post(`/api/invoices/${a.id}/${action}`, admin);
    expect(state(a.id)).toEqual({ status: to, reason: null });
  });

  it('Pendiente de pago → Pagada desde el listado, con el usuario en el historial (RF-147, AC-150)', async () => {
    const { clientId, admin } = await setup();
    const a = invoice(clientId, 'pendiente_pago');

    await post(`/api/invoices/${a.id}/mark-paid`, admin);

    expect(state(a.id)!.status).toBe('pagada');
    const event = app.db.select().from(clientEvents).where(eq(clientEvents.type, 'cambio_estado_factura')).get();
    expect(event).toMatchObject({ clientId, userId: expect.any(Number), data: { invoiceId: a.id, from: 'pendiente_pago', to: 'pagada' } });
  });

  it('rechaza cambios que no corresponden', async () => {
    const { clientId, admin } = await setup();
    expect((await post(`/api/invoices/${invoice(clientId, 'pagada').id}/mark-paid`, admin)).status).toBe(409);
    expect((await post(`/api/invoices/${invoice(clientId, 'pendiente_pago').id}/return-to-pending`, admin)).status).toBe(409);
    expect((await post('/api/invoices/999/mark-paid', admin)).status).toBe(404);
  });

  it('un Editor puede (AC-10); Consulta no, y nada cambia (AC-217)', async () => {
    const { clientId } = await setup();
    const a = invoice(clientId, 'pago_recibido');
    const consulta = await app.loginAs('consulta');
    expect((await post(`/api/invoices/${a.id}/mark-paid`, consulta)).status).toBe(403);
    expect((await post(`/api/invoices/${a.id}/return-to-pending`, consulta)).status).toBe(403);
    expect(state(a.id)!.status).toBe('pago_recibido');

    expect((await post(`/api/invoices/${a.id}/mark-paid`, await app.loginAs('editor'))).status).toBe(200);
  });
});

describe('avisos', () => {
  it('marcar como Revisado lo saca de los Pendientes y registra quién (RF-148, AC-153)', async () => {
    const { admin } = await setup();
    const notice = app.db.insert(receivedEmails).values({
      messageId: '<n@x>', from: 'otro@x.com', subject: 'Hola', text: '', receivedAt: now, ingestedAt: now, notice: 'pendiente', processedAt: now,
    }).returning().get();
    const consulta = await app.loginAs('consulta');
    expect((await post(`/api/review/notices/${notice.id}/reviewed`, consulta)).status).toBe(403);

    expect((await post(`/api/review/notices/${notice.id}/reviewed`, admin)).status).toBe(200);

    expect((await app.request('GET', '/api/review/notices', { cookie: admin })).body.notices).toEqual([]);
    expect(app.db.select().from(receivedEmails).get()).toMatchObject({ notice: 'revisado', noticeReviewedBy: expect.any(Number), noticeReviewedAt: now });
    expect((await post(`/api/review/notices/${notice.id}/reviewed`, admin)).status).toBe(404);
  });
});

describe('errores de proceso', () => {
  function billable(clientId: number) {
    const product = app.db.insert(products).values({ name: 'ERP', priceCents: 1_500_000, currency: 'ARS' }).returning().get();
    app.db.insert(clientProducts).values({ clientId, productId: product.id }).run();
  }

  it('marcar como Resuelto lo saca de los Pendientes y registra quién (RF-180, AC-191)', async () => {
    const { admin } = await setup();
    const error = recordProcessError(app.db, { operation: 'revision_casilla', attempts: 1, lastError: 'IMAP' });

    expect((await post(`/api/review/errors/${error.id}/resolve`, admin)).status).toBe(200);

    expect((await app.request('GET', '/api/review/errors', { cookie: admin })).body.errors).toEqual([]);
    expect(app.db.select().from(processErrors).get()).toMatchObject({ status: 'resuelto', resolvedBy: expect.any(Number), resolvedAt: now });
  });

  it('reintentar una generación genera la factura, la envía y resuelve el error (RF-177, RF-179, AC-187, AC-188)', async () => {
    const { clientId, admin } = await setup();
    billable(clientId);
    const error = recordProcessError(app.db, { operation: 'generacion_factura', clientId, period: '2026-10', attempts: 4, lastError: 'ARCA' });

    const res = await post(`/api/review/errors/${error.id}/retry`, admin);

    expect(res).toMatchObject({ status: 200, body: { message: expect.stringContaining('generada y enviada') } });
    expect(app.db.select().from(invoices).all()).toMatchObject([{ clientId, period: '2026-10', status: 'pendiente_pago' }]);
    expect(app.db.select().from(mockMailboxEmails).all()).toMatchObject([{ to: 'pagos@losandes.com' }]);
    expect(app.db.select().from(processErrors).get()).toMatchObject({ status: 'resuelto', attempts: 5 });
  });

  it('una generación reintentada después del fin de mes vence el día de emisión (RF-79 a RF-81, AC-76)', async () => {
    const { clientId, admin } = await setup('2026-11-03T10:00:00-03:00');
    billable(clientId);
    const error = recordProcessError(app.db, { operation: 'generacion_factura', clientId, period: '2026-10', attempts: 4, lastError: 'ARCA' });

    await post(`/api/review/errors/${error.id}/retry`, admin);

    expect(app.db.select().from(invoices).get()).toMatchObject({
      period: '2026-10', issueDate: '2026-11-03', serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-11-03',
    });
  });

  it('reintentar un envío reenvía solo ese email, sin generar otra factura (RF-178, AC-189)', async () => {
    const { clientId, admin } = await setup();
    const a = invoice(clientId, 'pendiente_pago');
    const error = recordProcessError(app.db, { operation: 'envio_factura', clientId, period: '2026-10', invoiceId: a.id, attempts: 4, lastError: 'SMTP' });

    expect((await post(`/api/review/errors/${error.id}/retry`, admin)).status).toBe(200);

    expect(app.db.select().from(invoices).all()).toHaveLength(1);
    expect(app.db.select().from(mockMailboxEmails).all()).toMatchObject([{ subject: `Factura C 00009-${String(a.number).padStart(8, '0')} - octubre de 2026` }]);
    expect(app.db.select().from(processErrors).get()!.status).toBe('resuelto');
  });

  it('si sigue fallando: un único intento, el error sigue Pendiente con el mensaje nuevo y el usuario lo ve (RF-182, RF-183, AC-190, AC-194)', async () => {
    const { clientId, admin } = await setup();
    billable(clientId);
    app.db.update(clients).set({ ivaCondition: null }).run(); // la generación va a fallar
    const error = recordProcessError(app.db, { operation: 'generacion_factura', clientId, period: '2026-10', attempts: 4, lastError: 'ARCA' });

    const res = await post(`/api/review/errors/${error.id}/retry`, admin);

    expect(res).toMatchObject({ status: 502, body: { error: 'el cliente no tiene cargada la condición frente al IVA' } });
    expect(app.db.select().from(processErrors).all()).toMatchObject([
      { status: 'pendiente', attempts: 5, lastError: 'el cliente no tiene cargada la condición frente al IVA' },
    ]);
  });

  it('la revisión de la casilla no se reintenta a mano', async () => {
    const { admin } = await setup();
    const error = recordProcessError(app.db, { operation: 'revision_casilla', attempts: 1, lastError: 'IMAP' });
    expect((await post(`/api/review/errors/${error.id}/retry`, admin)).status).toBe(409);
  });

  it('Consulta no puede reintentar ni resolver (AC-217)', async () => {
    const { clientId } = await setup();
    const error = recordProcessError(app.db, { operation: 'envio_factura', clientId, invoiceId: invoice(clientId, 'pendiente_pago').id, attempts: 4, lastError: 'SMTP' });
    const consulta = await app.loginAs('consulta');
    expect((await post(`/api/review/errors/${error.id}/retry`, consulta)).status).toBe(403);
    expect((await post(`/api/review/errors/${error.id}/resolve`, consulta)).status).toBe(403);
    expect(app.db.select().from(processErrors).get()!.status).toBe('pendiente');
  });
});

describe('pagos resueltos (RF-216)', () => {
  function linkEmail(invoiceId: number, subject: string, receivedAt: Date) {
    const email = app.db.insert(receivedEmails).values({
      messageId: `<${subject}@x>`, from: 'pagos@losandes.com', subject, text: '', receivedAt, ingestedAt: receivedAt,
      clientId: app.db.select().from(invoices).where(eq(invoices.id, invoiceId)).get()!.clientId, classification: 'si', processedAt: receivedAt,
    }).returning().get();
    app.db.insert(invoiceEmails).values({ invoiceId, emailId: email.id }).run();
    return email.id;
  }
  const resolved = async (cookie: string, query = '') => (await app.request('GET', `/api/review/resolved${query}`, { cookie })).body.resolved;

  it('una factura pasada a Pagada aparece con la decisión, el usuario, el estado y motivo anteriores y sus comprobantes (AC-238)', async () => {
    const { clientId, admin } = await setup();
    const a = invoice(clientId, 'revision_manual', 'monto no coincide');
    const first = linkEmail(a.id, 'Parcial', new Date('2026-10-19T10:00:00-03:00'));
    const second = linkEmail(a.id, 'Resto', new Date('2026-10-19T18:00:00-03:00'));

    await post(`/api/invoices/${a.id}/mark-paid`, admin);

    expect((await app.request('GET', '/api/review/invoices', { cookie: admin })).body.invoices).toEqual([]);
    const [item] = await resolved(admin);
    expect(item).toMatchObject({
      decision: 'pagada', previousStatus: 'revision_manual', previousReason: 'monto no coincide',
      userName: 'Usuario admin', clientName: 'Los Andes SA', decidedAt: now.toISOString(),
      invoice: { id: a.id, number: a.number, status: 'pagada' },
    });
    expect(item.emails.map((e: any) => e.id)).toEqual([first, second]);
  });

  it('una devuelta a Pendiente de pago aparece como tal; las decisiones del agente no (AC-238)', async () => {
    const { clientId, admin } = await setup();
    const a = invoice(clientId, 'pago_recibido');
    await post(`/api/invoices/${a.id}/return-to-pending`, admin);
    // Un cambio del agente (sin usuario) no es una decisión de revisión.
    app.db.insert(clientEvents).values({ clientId, type: 'cambio_estado_factura', userId: null, data: { invoiceId: a.id, from: 'pendiente_pago', to: 'pago_recibido' } }).run();

    expect((await resolved(admin)).map((r: any) => [r.decision, r.previousStatus])).toEqual([['pendiente_pago', 'pago_recibido']]);
  });

  it('no muestra los comprobantes que llegaron después de la decisión', async () => {
    const { clientId, admin } = await setup();
    const a = invoice(clientId, 'pago_recibido');
    linkEmail(a.id, 'Antes', new Date('2026-10-19T10:00:00-03:00'));
    await post(`/api/invoices/${a.id}/return-to-pending`, admin);
    linkEmail(a.id, 'Despues', new Date('2026-10-21T10:00:00-03:00'));

    expect((await resolved(admin))[0].emails.map((e: any) => e.subject)).toEqual(['Antes']);
  });

  it('filtra por cliente y por rango de fechas de la decisión, de la más reciente a la más antigua', async () => {
    const setupResult = await setup('2026-10-10T12:00:00-03:00');
    const { clientId } = setupResult;
    let { admin } = setupResult;
    const other = app.db.insert(clients).values({ businessName: 'Pampa', cuit: '20111111112', billingEmail: 'p@p.com', ivaCondition: 1 }).returning().get().id;
    const a = invoice(clientId, 'pago_recibido');
    const b = invoice(other, 'pago_recibido');
    await post(`/api/invoices/${a.id}/mark-paid`, admin);
    // Diez días después la sesión venció por inactividad (RNF-10): se vuelve a entrar.
    now = new Date('2026-10-20T12:00:00-03:00');
    admin = await app.loginAs('admin');
    await post(`/api/invoices/${b.id}/mark-paid`, admin);

    expect((await resolved(admin)).map((r: any) => r.invoice.id)).toEqual([b.id, a.id]);
    expect((await resolved(admin, `?clientId=${clientId}`)).map((r: any) => r.invoice.id)).toEqual([a.id]);
    expect((await resolved(admin, '?from=2026-10-15&to=2026-10-20')).map((r: any) => r.invoice.id)).toEqual([b.id]);
    expect((await resolved(admin, '?from=2026-10-01&to=2026-10-10')).map((r: any) => r.invoice.id)).toEqual([a.id]);
    expect((await app.request('GET', '/api/review/resolved?from=10/10/2026', { cookie: admin })).status).toBe(400);
  });

  it('Consulta los ve (RF-11)', async () => {
    await setup();
    expect((await app.request('GET', '/api/review/resolved', { cookie: await app.loginAs('consulta') })).status).toBe(200);
  });
});
