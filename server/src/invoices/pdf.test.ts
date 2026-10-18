import { afterEach, describe, expect, it } from 'vitest';
import { clients, invoiceItems, invoices, settings } from '../db/schema.js';
import type { Db } from '../db/index.js';
import { getSettings } from '../settings/settings.js';
import { startTestApp, type TestApp } from '../test/http.js';
import { HOMOLOGATION_NOTICE, MOCK_NOTICE, renderInvoicePdf } from './pdf.js';
import { qrUrl } from './qr.js';

/** Texto de un PDF de pdfkit sin comprimir: decodifica los bloques hexadecimales de texto. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  return [...raw.matchAll(/\[((?:<[0-9a-f]+>\s*-?[\d.]*\s*)+)\]\s*TJ/gi)]
    .map((m) => [...m[1]!.matchAll(/<([0-9a-f]+)>/gi)].map((h) => Buffer.from(h[1]!, 'hex').toString('latin1')).join(''))
    .join('\n');
}

function seedInvoice(db: Db, overrides: Partial<typeof invoices.$inferInsert> = {}) {
  const client = db.insert(clients).values({
    businessName: 'Los Andes SA', cuit: '30711111111', address: 'San Martín 100, Mendoza',
    billingEmail: 'pagos@losandes.com', ivaCondition: 1,
  }).returning().get();
  const invoice = db.insert(invoices).values({
    clientId: client.id, period: '2026-10', voucherType: 11, pointOfSale: 3, number: 42,
    cae: '76421234567890', caeDueDate: '2026-10-25', issueDate: '2026-10-15',
    serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-10-31',
    totalCents: 16_500_050, clientBusinessName: 'Los Andes SA', clientCuit: '30711111111',
    clientAddress: 'San Martín 100, Mendoza', clientIvaCondition: 1,
    exchangeRateCents: 150_000, exchangeRateSource: 'dolarhoy.com', exchangeRateReadAt: new Date('2026-10-15T14:00:00Z'),
    ...overrides,
  }).returning().get();
  db.insert(invoiceItems).values([
    { invoiceId: invoice.id, description: 'ERP', currency: 'ARS', unitPriceCents: 1_500_050, amountCents: 1_500_050 },
    { invoiceId: invoice.id, description: 'CRM', currency: 'USD', unitPriceCents: 10_000, amountCents: 15_000_000 },
  ]).run();
  return invoice;
}

let app: TestApp;
afterEach(async () => {
  await app?.close();
});

async function render(options: { mockMode?: boolean; issuerCuit?: string; withRate?: boolean } = {}) {
  app = await startTestApp();
  getSettings(app.db);
  app.db.update(settings).set({
    issuerBusinessName: 'Aldebaran SAS',
    issuerAddress: 'Av. Corrientes 1234, CABA',
    issuerIvaCondition: 'Responsable Monotributo',
    issuerGrossIncomeNumber: '901-123456-7',
    issuerActivityStartDate: '2020-03-01',
  }).run();
  const invoice = seedInvoice(app.db, options.withRate === false
    ? { exchangeRateCents: null, exchangeRateSource: null, exchangeRateReadAt: null } : {});
  const items = app.db.select().from(invoiceItems).all();
  const pdf = await renderInvoicePdf(invoice, items, {
    issuerCuit: options.issuerCuit ?? '20111111112',
    settings: getSettings(app.db),
    mockMode: options.mockMode ?? false,
    compress: false,
  });
  return { pdf, text: pdfText(pdf) };
}

describe('PDF de la factura (RF-93)', () => {
  it('incluye todos los datos de la factura y del receptor (AC-84)', async () => {
    const { pdf, text } = await render();

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    for (const fragment of [
      'ORIGINAL', 'FACTURA', 'C', 'COD. 011',
      'Punto de Venta:', ' 00003', 'Comp. Nro:', ' 00000042',
      'Fecha de Emisión:', ' 15/10/2026',
      'Período Facturado Desde:', ' 01/10/2026', 'Hasta:', ' 31/10/2026',
      'Fecha de Vto. para el pago:',
      'Apellido y Nombre / Razón Social:', ' Los Andes SA',
      'CUIT:', ' 30711111111', 'Domicilio:', ' San Martín 100, Mendoza',
      'Condición frente al IVA:', ' IVA Responsable Inscripto',
      // La columna es angosta, como en ARCA: la descripción se corta en dos renglones.
      'Cuota mensual ERP \nOCT/2026', '15000,50',
      'Cuota mensual CRM \nOCT/2026 (USD 100,00)', '150000,00',
      'Importe Total: $', '165000,50',
      'CAE N°:', '76421234567890', 'Fecha de Vto. de CAE:', '25/10/2026',
      'Comprobante Autorizado',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
  });

  it('tiene original, duplicado y triplicado, como el comprobante de ARCA', async () => {
    const { pdf, text } = await render();
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(3);
    for (const copy of ['ORIGINAL', 'DUPLICADO', 'TRIPLICADO']) expect(text).toContain(copy);
  });

  it('incluye el QR del comprobante (RG 4892)', async () => {
    const { pdf } = await render();
    expect(pdf.toString('latin1')).toMatch(/\/Subtype \/Image/);
  });

  it('incluye la cotización usada cuando hubo ítems en dólares, y no la menciona si no', async () => {
    expect((await render()).text).toContain('Dólar blue venta de dolarhoy.com: $ 1500,00 por dólar, leída el 15/10/2026.');
    await app.close();
    expect((await render({ withRate: false })).text).not.toContain('dolarhoy.com');
  });

  it('incluye los datos de la empresa emisora y su CUIT (RF-92, AC-83, AC-205)', async () => {
    const { text } = await render({ issuerCuit: '30711111111' });
    for (const fragment of ['Razón Social:', ' Aldebaran SAS', 'Domicilio Comercial:', ' Av. Corrientes 1234, CABA',
      ' Responsable Monotributo', 'Ingresos Brutos:', ' 901-123456-7', 'Fecha de Inicio de Actividades:', ' 01/03/2020',
      'CUIT:', ' 30711111111']) {
      expect(text, fragment).toContain(fragment);
    }
  });

  it('indica que fue emitido en homologación y no tiene validez fiscal (RF-90, AC-82)', async () => {
    const { text } = await render();
    expect(text).toContain(HOMOLOGATION_NOTICE);
    expect(text).not.toContain(MOCK_NOTICE);
  });

  it('en modo mock indica que es simulado y no dice "Comprobante Autorizado" (RF-210, AC-207)', async () => {
    const { text } = await render({ mockMode: true });
    expect(text).toContain(MOCK_NOTICE);
    expect(text).toContain('Comprobante simulado');
    expect(text).not.toContain('Comprobante Autorizado');
  });
});

describe('QR (RG 4892)', () => {
  it('apunta al verificador de ARCA con los datos del comprobante', () => {
    const url = qrUrl({
      issueDate: '2026-10-15', issuerCuit: '20111111112', pointOfSale: 3, voucherType: 11, number: 42,
      totalCents: 16_500_050, receiverCuit: '30711111111', cae: '76421234567890',
    });

    expect(url.startsWith('https://www.afip.gob.ar/fe/qr/?p=')).toBe(true);
    const payload = JSON.parse(Buffer.from(url.split('?p=')[1]!, 'base64').toString('utf8'));
    expect(payload).toEqual({
      ver: 1, fecha: '2026-10-15', cuit: 20111111112, ptoVta: 3, tipoCmp: 11, nroCmp: 42,
      importe: 165000.5, moneda: 'PES', ctz: 1, tipoDocRec: 80, nroDocRec: 30711111111,
      tipoCodAut: 'E', codAut: 76421234567890,
    });
  });
});

describe('descarga del PDF (RF-162)', () => {
  it.each(['admin', 'editor', 'consulta'] as const)('%s descarga el PDF de una factura (AC-169)', async (role) => {
    app = await startTestApp();
    const invoice = seedInvoice(app.db);
    const cookie = await app.loginAs(role);

    const res = await app.request('GET', `/api/invoices/${invoice.id}/pdf`, { cookie });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('factura-c-00003-00000042.pdf');
    expect(res.raw.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('responde 404 si la factura no existe y 401 sin sesión', async () => {
    app = await startTestApp();
    const cookie = await app.loginAs('admin');
    expect((await app.request('GET', '/api/invoices/999/pdf', { cookie })).status).toBe(404);
    expect((await app.request('GET', '/api/invoices/1/pdf')).status).toBe(401);
  });
});

