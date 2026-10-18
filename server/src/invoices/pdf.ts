import PDFDocument from 'pdfkit';
import { IVA_CONDITIONS, type invoiceItems, type invoices } from '../db/schema.js';
import type { Settings } from '../settings/settings.js';
import { qrPng, qrUrl } from './qr.js';

type Invoice = typeof invoices.$inferSelect;
type InvoiceItem = typeof invoiceItems.$inferSelect;

export interface PdfContext {
  /** CUIT del emisor (ARCA_CUIT, RF-92). */
  issuerCuit: string;
  settings: Settings;
  mockMode: boolean;
  /** Solo para los tests: sin compresión se puede leer el texto del PDF. */
  compress?: boolean;
}

/** RF-90: mientras se facture en homologación. */
export const HOMOLOGATION_NOTICE =
  'Comprobante emitido en el ambiente de homologación de ARCA. No tiene validez fiscal.';
/** RF-210: en modo mock. */
export const MOCK_NOTICE = 'Generado en modo mock: comprobante simulado, sin validez fiscal.';

/** Como el comprobante de ARCA: original, duplicado y triplicado. */
const COPIES = ['ORIGINAL', 'DUPLICADO', 'TRIPLICADO'];
const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

/** ARCA muestra coma decimal y sin separador de miles: 1270000,00. */
export const arcaNumber = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
/** "2026-10-15" → "15/10/2026". */
export const formatDate = (date: string) => date.split('-').reverse().join('/');
/** "2026-10" → "OCT/2026". */
export const periodLabel = (period: string) => {
  const [year, month] = period.split('-');
  return `${MONTHS[Number(month) - 1]}/${year}`;
};
export const formatVoucherNumber = (pointOfSale: number, number: number) =>
  `${String(pointOfSale).padStart(5, '0')}-${String(number).padStart(8, '0')}`;

// Coordenadas calcadas del comprobante de ARCA (A4, 595 × 842 pt), las mismas de
// facturador-afip. Marco de x 15 a 581.
const L = 15;
const R = 581;
const W = R - L;

/**
 * RF-93: PDF de la Factura C con el diseño del comprobante de ARCA (original,
 * duplicado y triplicado) y el QR de la RG 4892. Suma la leyenda de homologación o de
 * modo mock (RF-90, RF-210) y, si hubo ítems en dólares, la cotización usada.
 */
export async function renderInvoicePdf(invoice: Invoice, items: InvoiceItem[], ctx: PdfContext): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    compress: ctx.compress ?? true,
    info: { Title: `Factura C ${formatVoucherNumber(invoice.pointOfSale, invoice.number)}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const qr = await qrPng(qrUrl({
    issueDate: invoice.issueDate,
    issuerCuit: ctx.issuerCuit,
    pointOfSale: invoice.pointOfSale,
    voucherType: invoice.voucherType,
    number: invoice.number,
    totalCents: invoice.totalCents,
    receiverCuit: invoice.clientCuit,
    cae: invoice.cae,
  }));

  COPIES.forEach((copy, i) => {
    if (i > 0) doc.addPage({ size: 'A4', margin: 0 });
    drawCopy(doc, invoice, items, ctx, copy, qr);
  });

  doc.end();
  return done;
}

function drawCopy(
  doc: PDFKit.PDFDocument,
  invoice: Invoice,
  items: InvoiceItem[],
  ctx: PdfContext,
  copy: string,
  qr: Buffer,
) {
  const { settings } = ctx;
  const issuerName = settings.issuerBusinessName ?? '—';

  /** Etiqueta en negrita + valor en una línea. */
  const label = (
    x: number,
    y: number,
    text: string,
    value: string,
    { size = 9, valueSize, valueBold = false }: { size?: number; valueSize?: number; valueBold?: boolean } = {},
  ) => {
    doc.fontSize(size).font('Helvetica-Bold').fillColor('#000').text(text, x, y, { lineBreak: false });
    const width = doc.widthOfString(text);
    doc.fontSize(valueSize ?? size).font(valueBold ? 'Helvetica-Bold' : 'Helvetica').text(` ${value}`, x + width, y, { lineBreak: false });
  };
  /** Etiqueta en negrita + valor que se corta dentro de maxWidth. */
  const labelWrap = (x: number, y: number, text: string, value: string, maxWidth: number, size = 9) => {
    doc.fontSize(size).font('Helvetica-Bold').fillColor('#000').text(text, x, y, { lineBreak: false });
    const width = doc.widthOfString(`${text} `);
    doc.font('Helvetica').text(` ${value}`, x + width, y, { width: Math.max(20, maxWidth - width) });
  };

  doc.lineWidth(0.7).fillColor('#000').strokeColor('#000');

  // Marco: encabezado, período y receptor.
  doc.rect(L, 23, W, 146).stroke();
  doc.rect(L, 169, W, 25).stroke();
  doc.rect(L, 194, W, 64).stroke();

  doc.fontSize(14).font('Helvetica-Bold').text(copy, L, 31, { width: W, align: 'center' });
  doc.moveTo(L, 50.5).lineTo(R, 50.5).stroke();

  // Caja "C" y divisor emisor / comprobante.
  doc.rect(275, 51, 47, 41).stroke();
  doc.fontSize(24).font('Helvetica-Bold').text('C', 275, 55, { width: 47, align: 'center' });
  doc.fontSize(8).font('Helvetica-Bold').text(`COD. ${String(invoice.voucherType).padStart(3, '0')}`, 275, 80, { width: 47, align: 'center' });
  doc.moveTo(298.5, 92).lineTo(298.5, 169).stroke();

  // Emisor (RF-92).
  doc.fontSize(10).font('Helvetica-Bold').text(issuerName, L, 69, { width: 275 - L, align: 'center' });
  label(21, 109.6, 'Razón Social:', issuerName);
  labelWrap(21, 133.6, 'Domicilio Comercial:', settings.issuerAddress ?? '—', 254);
  label(21, 158.4, 'Condición frente al IVA:', settings.issuerIvaCondition ?? '—', { valueBold: true });

  // Comprobante.
  doc.fontSize(18).font('Helvetica-Bold').text('FACTURA', 341, 63.4);
  label(341, 92.3, 'Punto de Venta:', String(invoice.pointOfSale).padStart(5, '0'), { valueSize: 10, valueBold: true });
  label(461, 92.3, 'Comp. Nro:', String(invoice.number).padStart(8, '0'), { valueSize: 10, valueBold: true });
  label(341, 108.4, 'Fecha de Emisión:', formatDate(invoice.issueDate), { valueSize: 10, valueBold: true });
  label(341, 131.4, 'CUIT:', ctx.issuerCuit);
  label(341, 143.4, 'Ingresos Brutos:', settings.issuerGrossIncomeNumber ?? ctx.issuerCuit);
  label(341, 155.4, 'Fecha de Inicio de Actividades:',
    settings.issuerActivityStartDate ? formatDate(settings.issuerActivityStartDate) : '—');

  // Período facturado (RF-80) y vencimiento del pago (RF-81).
  label(21, 177.5, 'Período Facturado Desde:', formatDate(invoice.serviceFrom), { size: 10 });
  label(232, 177.5, 'Hasta:', formatDate(invoice.serviceTo), { size: 10 });
  label(363, 177.5, 'Fecha de Vto. para el pago:', formatDate(invoice.paymentDueDate), { size: 10 });

  // Receptor.
  const ivaLabel = IVA_CONDITIONS[invoice.clientIvaCondition as keyof typeof IVA_CONDITIONS] ?? String(invoice.clientIvaCondition);
  label(21, 197.6, 'CUIT:', invoice.clientCuit);
  labelWrap(222, 197.4, 'Apellido y Nombre / Razón Social:', invoice.clientBusinessName, R - 6 - 222, 8);
  label(21, 214.4, 'Condición frente al IVA:', ivaLabel, { size: 8 });
  labelWrap(312, 214.4, 'Domicilio:', invoice.clientAddress ?? '—', R - 6 - 312, 8);
  label(21, 234.4, 'Condición de venta:', 'Contado', { size: 8 });

  // Ítems: una cuota mensual por producto.
  const cols = [
    { key: 'code', title: 'Código', x0: 15, x1: 55, headAlign: 'left', align: 'left', headSize: 8 },
    { key: 'desc', title: 'Producto / Servicio', x0: 55, x1: 168, headAlign: 'left', align: 'left', headSize: 8 },
    { key: 'qty', title: 'Cantidad', x0: 168, x1: 226, headAlign: 'center', align: 'right', headSize: 8 },
    { key: 'unit', title: 'U. Medida', x0: 226, x1: 268, headAlign: 'center', align: 'center', headSize: 8 },
    { key: 'price', title: 'Precio Unit.', x0: 268, x1: 360, headAlign: 'center', align: 'right', headSize: 7 },
    { key: 'discPct', title: '% Bonif', x0: 360, x1: 394, headAlign: 'center', align: 'right', headSize: 7 },
    { key: 'disc', title: 'Imp. Bonif.', x0: 394, x1: 478, headAlign: 'center', align: 'right', headSize: 7 },
    { key: 'subtotal', title: 'Subtotal', x0: 478, x1: 581, headAlign: 'center', align: 'right', headSize: 7 },
  ] as const;
  const headY = 258;
  const headH = 18;
  doc.rect(L, headY, W, headH).fillAndStroke('#e6e6e6', '#000');
  doc.fillColor('#000').font('Helvetica-Bold');
  for (const c of cols) {
    doc.fontSize(c.headSize).text(c.title, c.x0 + 2, headY + (headH - c.headSize) / 2 - 1, { width: c.x1 - c.x0 - 4, align: c.headAlign });
  }
  doc.lineWidth(0.5);
  for (const c of cols.slice(1)) doc.moveTo(c.x0, headY).lineTo(c.x0, headY + headH).stroke();
  doc.lineWidth(0.7);

  const pad = 4;
  const descCol = cols[1];
  const descWidth = descCol.x1 - descCol.x0 - pad * 2;
  let y = headY + headH + 2;
  doc.font('Helvetica');
  for (const item of items) {
    const description =
      `Cuota mensual ${item.description} ${periodLabel(invoice.period)}` +
      (item.currency === 'USD' ? ` (USD ${arcaNumber(item.unitPriceCents)})` : '');
    const values: Record<(typeof cols)[number]['key'], string> = {
      code: '',
      desc: description,
      qty: '1,00',
      unit: 'unidades',
      price: arcaNumber(item.amountCents),
      discPct: '0,00',
      disc: '0,00',
      subtotal: arcaNumber(item.amountCents),
    };
    doc.fontSize(8);
    const rowHeight = Math.max(14, doc.heightOfString(description, { width: descWidth }) + 4);
    for (const c of cols) {
      doc.fontSize(c.key === 'unit' ? 7 : 8);
      const width = c.key === 'desc' ? descWidth : c.x1 - c.x0 - pad * 2;
      doc.text(values[c.key], c.x0 + pad, y, { width, align: c.align });
    }
    y += rowHeight;
  }

  // Leyenda de homologación o de modo mock, arriba de los totales.
  const notice = ctx.mockMode ? MOCK_NOTICE : HOMOLOGATION_NOTICE;
  doc.rect(L, 490, W, 20).fill('#fff4e5');
  doc.fillColor('#ad4e00').font('Helvetica-Bold').fontSize(9).text(notice, L, 496, { width: W, align: 'center' });
  doc.fillColor('#000');

  // Totales (Factura C: sin IVA discriminado).
  doc.rect(L, 517, W, 94).stroke();
  const totalRow = (rowY: number, text: string, value: string, size: number) => {
    doc.font('Helvetica-Bold').fontSize(size);
    doc.text(text, 360, rowY, { width: 150, align: 'right' });
    doc.text(value, 446, rowY, { width: 126, align: 'right' });
  };
  totalRow(554.6, 'Subtotal: $', arcaNumber(invoice.totalCents), 9);
  totalRow(572.6, 'Importe Otros Tributos: $', '0,00', 9);
  totalRow(590.8, 'Importe Total: $', arcaNumber(invoice.totalCents), 10);

  // Cotización usada para los ítems en dólares (RF-63, RF-93).
  if (invoice.exchangeRateCents !== null) {
    const readAt = invoice.exchangeRateReadAt
      ? invoice.exchangeRateReadAt.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
      : '—';
    doc.font('Helvetica-Bold').fontSize(8).text('Cotización del dólar usada:', 21, 535);
    doc.font('Helvetica').fontSize(8).text(
      `Dólar blue venta de ${invoice.exchangeRateSource ?? '—'}: $ ${arcaNumber(invoice.exchangeRateCents)} ` +
        `por dólar, leída el ${readAt}.`,
      21, 547, { width: 320 },
    );
  }

  // Pie: QR, ARCA y CAE.
  doc.image(qr, 20, 653, { width: 80 });
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(18).text('ARCA', 113, 655);
  doc.font('Helvetica').fontSize(5).text('AGENCIA DE RECAUDACIÓN\nY CONTROL ADUANERO', 113, 674, { width: 95 });
  doc.font('Helvetica-Bold').fontSize(10).text('Pág. 1/1', 240, 649.5, { width: 90, align: 'center' });
  // En modo mock ARCA no autorizó nada: no se dice "Comprobante Autorizado".
  doc.font('Helvetica-BoldOblique').fontSize(9).text(ctx.mockMode ? 'Comprobante simulado' : 'Comprobante Autorizado', 113, 688.6);
  doc.font('Helvetica-BoldOblique').fontSize(6).text(
    'Esta Agencia no se responsabiliza por los datos ingresados en el detalle de la operación', 113, 708.1, { width: 340 },
  );
  doc.font('Helvetica-Bold').fontSize(10).text('CAE N°:', 340, 646.8, { width: 136, align: 'right' });
  doc.font('Helvetica').text(invoice.cae, 478, 646.8, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10).text('Fecha de Vto. de CAE:', 300, 661.8, { width: 176, align: 'right' });
  doc.font('Helvetica').text(formatDate(invoice.caeDueDate), 478, 661.8, { lineBreak: false });
}
