import { and, asc, eq, inArray } from 'drizzle-orm';
import { recordProcessError } from '../billing/process-errors.js';
import { recordClientEvent } from '../clients/events.js';
import type { Db } from '../db/index.js';
import { clients, invoiceItems, invoices } from '../db/schema.js';
import type { Mailer } from '../email/index.js';
import { getSettings, type Settings } from '../settings/settings.js';
import { formatDate, formatVoucherNumber, HOMOLOGATION_NOTICE, MOCK_NOTICE, renderInvoicePdf } from './pdf.js';

type Invoice = typeof invoices.$inferSelect;

/** Factura adeudada: Pendiente de pago o Revisión manual (definición del PRD). */
export const OWED_STATUSES = ['pendiente_pago', 'revision_manual'] as const;

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ars = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });

/** 1500050 → "$ 15.000,50". */
export const money = (cents: number) => ars.format(cents / 100).replace(/ /g, ' ');
/** "2026-10" → "octubre de 2026". */
export const periodName = (period: string) => {
  const [year, month] = period.split('-');
  return `${MONTHS[Number(month) - 1]} de ${year}`;
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Facturas adeudadas del cliente, de la más antigua a la más reciente. */
export function owedInvoices(db: Db, clientId: number): Invoice[] {
  return db
    .select()
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), inArray(invoices.status, [...OWED_STATUSES])))
    .orderBy(asc(invoices.period), asc(invoices.id))
    .all();
}

export interface InvoiceEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * RF-88 a RF-90, RF-210: número, período, importe y vencimiento de la factura; deuda
 * vigente total del cliente, aclarando si incluye facturas anteriores; pedido de
 * responder con el comprobante de pago; y leyenda de homologación o de modo mock.
 */
export function buildInvoiceEmail(
  invoice: Invoice,
  owed: Invoice[],
  options: { senderName: string; mockMode: boolean },
): InvoiceEmailContent {
  const number = formatVoucherNumber(invoice.pointOfSale, invoice.number);
  const period = periodName(invoice.period);
  const debtCents = owed.reduce((sum, i) => sum + i.totalCents, 0);
  const previous = owed.filter((i) => i.id !== invoice.id);
  const notice = options.mockMode ? MOCK_NOTICE : HOMOLOGATION_NOTICE;
  const sender = options.senderName;

  const subject = `Factura C ${number} - ${period}`;

  const debtLine =
    previous.length > 0
      ? `Tu deuda pendiente total es de ${money(debtCents)}, e incluye ${
          previous.length === 1 ? 'una factura anterior' : `${previous.length} facturas anteriores`
        } además de esta:`
      : `Tu deuda pendiente total es de ${money(debtCents)}.`;
  const previousLines = previous.map(
    (i) => `  - Factura ${formatVoucherNumber(i.pointOfSale, i.number)} de ${periodName(i.period)}: ${money(i.totalCents)}, vencimiento ${formatDate(i.paymentDueDate)}`,
  );

  const text = [
    `Hola, ${invoice.clientBusinessName}:`,
    '',
    `Te enviamos adjunta la factura de ${period}. Tenés una deuda pendiente.`,
    '',
    `  Factura: C ${number}`,
    `  Período: ${period}`,
    `  Importe: ${money(invoice.totalCents)}`,
    `  Vencimiento: ${formatDate(invoice.paymentDueDate)}`,
    '',
    debtLine,
    ...previousLines,
    '',
    'Cuando realices el pago, respondé este email adjuntando el comprobante de pago.',
    '',
    'Saludos,',
    sender,
    '',
    `--`,
    notice,
  ].join('\n');

  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#555">${label}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:600px">
<p style="background:#fff4e5;color:#ad4e00;padding:8px 12px;font-size:12px;font-weight:bold">${escapeHtml(notice)}</p>
<p>Hola, ${escapeHtml(invoice.clientBusinessName)}:</p>
<p>Te enviamos adjunta la factura de ${period}. Tenés una deuda pendiente.</p>
<table style="border-collapse:collapse;margin:8px 0 16px">
${row('Factura', `C ${number}`)}
${row('Período', period)}
${row('Importe', money(invoice.totalCents))}
${row('Vencimiento', formatDate(invoice.paymentDueDate))}
</table>
<p>${escapeHtml(debtLine)}</p>
${previous.length > 0 ? `<ul>${previousLines.map((l) => `<li>${escapeHtml(l.replace(/^ {2}- /, ''))}</li>`).join('')}</ul>` : ''}
<p><strong>Cuando realices el pago, respondé este email adjuntando el comprobante de pago.</strong></p>
<p>Saludos,<br>${escapeHtml(sender)}</p>
</div>`;

  return { subject, text, html };
}

/** RF-215: nombre de fantasía, o la razón social si no hay; "Aldebaran" si no hay ninguno. */
export function emailSenderName(settings: Pick<Settings, 'issuerTradeName' | 'issuerBusinessName'>): string {
  return settings.issuerTradeName ?? settings.issuerBusinessName ?? 'Aldebaran';
}

export interface InvoiceEmailDeps {
  db: Db;
  /** Reloj de la app, para fechar el historial; por defecto, ahora. */
  now?: () => Date;
  mailer: Mailer;
  issuerCuit: string;
  mockMode: boolean;
}

/**
 * Un intento de enviar el email de la factura (RF-84) con el PDF adjunto (RF-93) al
 * email de facturación actual del cliente. Devuelve false si no corresponde enviarlo
 * (cliente Inactivo, RF-96). Tira si el envío falla.
 */
export async function sendInvoiceEmail(deps: InvoiceEmailDeps, invoiceId: number): Promise<boolean> {
  const { db } = deps;
  const invoice = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) throw new Error(`La factura ${invoiceId} no existe.`);
  const client = db.select().from(clients).where(eq(clients.id, invoice.clientId)).get();
  if (!client || client.status !== 'activo') return false;

  const settings = getSettings(db);
  const items = db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoice.id)).orderBy(asc(invoiceItems.id)).all();
  const pdf = await renderInvoicePdf(invoice, items, { issuerCuit: deps.issuerCuit, settings, mockMode: deps.mockMode });
  const senderName = emailSenderName(settings);
  const content = buildInvoiceEmail(invoice, owedInvoices(db, client.id), { senderName, mockMode: deps.mockMode });

  const sent = await deps.mailer.send({
    fromName: senderName,
    to: client.billingEmail,
    ...content,
    attachments: [{
      filename: `factura-c-${formatVoucherNumber(invoice.pointOfSale, invoice.number)}.pdf`,
      contentType: 'application/pdf',
      content: pdf,
    }],
  });

  // RF-57, AC-78: el envío queda en el historial del cliente (fecha, hora y destinatario).
  recordClientEvent(db, client.id, 'email_enviado', null, {
    kind: 'factura',
    invoiceId: invoice.id,
    to: sent.to,
    subject: content.subject,
    messageId: sent.messageId,
  }, deps.now?.());
  return true;
}

/**
 * RF-86, RF-171, RF-174: envía el email de la factura con los reintentos configurados,
 * sin volver a generar la factura; si sigue fallando, registra un error de proceso.
 */
export async function deliverInvoiceEmail(
  deps: InvoiceEmailDeps & { sleep: (ms: number) => Promise<void> },
  invoice: Invoice,
): Promise<void> {
  const { retryCount, retryWaitMinutes } = getSettings(deps.db);
  const maxAttempts = 1 + retryCount;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sendInvoiceEmail(deps, invoice.id);
      return;
    } catch (error) {
      if (attempt < maxAttempts) {
        await deps.sleep(retryWaitMinutes * 60_000);
        continue;
      }
      recordProcessError(deps.db, {
        operation: 'envio_factura',
        clientId: invoice.clientId,
        period: invoice.period,
        invoiceId: invoice.id,
        attempts: attempt,
        lastError: error instanceof Error ? error.message : String(error),
      }, deps.now?.());
    }
  }
}
