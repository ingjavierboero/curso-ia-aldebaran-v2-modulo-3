import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AttachmentClassifier } from '../classifier/index.js';
import { classifyWithRetries, type ClassifyOutcome } from '../classifier/retry.js';
import { recordClientEvent } from '../clients/events.js';
import type { Db } from '../db/index.js';
import { clients, invoiceEmails, invoices, receivedAttachments, receivedEmails } from '../db/schema.js';
import { OWED_STATUSES } from '../invoices/email.js';
import { decide, type Decision, type OwedInvoice } from './validation.js';

export interface EmailProcessingDeps {
  db: Db;
  now: () => Date;
  classifier: AttachmentClassifier;
  /** Espera entre reintentos del LLM; inyectable para los tests. */
  sleep: (ms: number) => Promise<void>;
}

export type EmailClassification = 'si' | 'no' | 'dudoso' | 'erroneo';

export type EmailOutcome =
  /** RF-113: el remitente no es un cliente; queda como aviso Pendiente. */
  | { kind: 'aviso' }
  /**
   * `classification` y `decision` son null si el email no traía adjuntos válidos: no
   * dispara ninguna otra acción (RF-115).
   */
  | { kind: 'cliente'; clientId: number; classification: EmailClassification | null; decision: Decision | null }
  /** Ya se había procesado (por ejemplo, en una revisión anterior). */
  | { kind: 'ya_procesado' };

/**
 * RF-123: clasificación del email a partir de la de sus adjuntos, en este orden:
 * erróneo si alguno falló; si no, "dudoso" si alguno es dudoso; si no, "si" si alguno es
 * comprobante; si no, "no".
 */
export function emailClassification(results: ClassifyOutcome[]): EmailClassification {
  if (results.some((r) => !r.ok)) return 'erroneo';
  const classes = results.map((r) => (r.ok ? r.classification : null));
  if (classes.includes('dudoso')) return 'dudoso';
  if (classes.includes('si')) return 'si';
  return 'no';
}

/**
 * Procesa un email recibido:
 * 1. identifica al cliente por su email de facturación, sin distinguir mayúsculas e
 *    incluyendo a los Inactivos (RF-111, RF-112, RF-118); si no hay, queda como aviso
 *    Pendiente y no se sigue (RF-113);
 * 2. clasifica cada adjunto válido con el LLM, con el cuerpo del email como contexto, y
 *    extrae CUIT y monto de cada comprobante (RF-115, RF-119 a RF-122, RNF-02);
 * 3. registra en el historial del cliente el email y el resultado (RF-114, RF-124);
 * 4. aplica las reglas RF-126 a RF-137: las facturas pasan a Pago recibido o a Revisión
 *    manual con su motivo (RF-138), o no cambian. El agente nunca marca una factura como
 *    Pagada.
 * Todo se guarda junto al final: si se corta antes, el email se vuelve a procesar entero.
 */
export async function processReceivedEmail(deps: EmailProcessingDeps, emailId: number): Promise<EmailOutcome> {
  const { db } = deps;
  const email = db.select().from(receivedEmails).where(eq(receivedEmails.id, emailId)).get();
  if (!email) throw new Error(`El email ${emailId} no existe.`);
  if (email.processedAt) return { kind: 'ya_procesado' };

  const client = db
    .select({ id: clients.id, cuit: clients.cuit })
    .from(clients)
    .where(eq(sql`lower(${clients.billingEmail})`, email.from.toLowerCase()))
    .get();

  if (!client) {
    db.update(receivedEmails).set({ notice: 'pendiente', processedAt: deps.now() }).where(eq(receivedEmails.id, emailId)).run();
    return { kind: 'aviso' };
  }

  const attachments = db
    .select()
    .from(receivedAttachments)
    .where(eq(receivedAttachments.emailId, emailId))
    .orderBy(asc(receivedAttachments.id))
    .all();
  const valid = attachments.filter((a) => a.valid);

  // RF-115: sin adjuntos válidos no se clasifica nada. Los adjuntos van en paralelo (RNF-01).
  const results = await Promise.all(
    valid.map((a) =>
      classifyWithRetries(
        deps.classifier,
        { filename: a.filename, contentType: a.contentType, content: a.content, emailSubject: email.subject, emailText: email.text },
        deps.sleep,
      ),
    ),
  );
  const classification = valid.length > 0 ? emailClassification(results) : null;

  const decision = db.transaction((tx) => {
    // Las facturas adeudadas se leen dentro de la transacción, con el estado al día.
    const owed = classification
      ? (tx
          .select({ id: invoices.id, period: invoices.period, totalCents: invoices.totalCents, status: invoices.status })
          .from(invoices)
          .where(and(eq(invoices.clientId, client.id), inArray(invoices.status, [...OWED_STATUSES])))
          .all() as OwedInvoice[])
      : [];
    const decision = classification
      ? decide({
          classification,
          receipts: results.flatMap((r) => (r.ok && r.classification === 'si' ? [{ cuit: r.cuit, amount: r.amount }] : [])),
          clientCuit: client.cuit,
          owed,
        })
      : null;

    tx.update(receivedEmails)
      .set({
        clientId: client.id,
        classification,
        validationResult: !decision ? null : decision.action === 'none' ? 'sin_cambios' : decision.action === 'review' ? 'revision_manual' : 'pago_recibido',
        validationRule: decision?.rule ?? null,
        processedAt: deps.now(),
      })
      .where(eq(receivedEmails.id, emailId))
      .run();
    valid.forEach((attachment, i) => {
      const result = results[i]!;
      tx.update(receivedAttachments)
        .set(
          result.ok
            ? { classification: result.classification, extractedCuit: result.cuit, extractedAmount: result.amount, processingError: null }
            : { classification: null, extractedCuit: null, extractedAmount: null, processingError: result.error },
        )
        .where(and(eq(receivedAttachments.id, attachment.id), eq(receivedAttachments.emailId, emailId)))
        .run();
    });

    // AC-104: fecha, asunto y adjuntos del email en el historial del cliente.
    recordClientEvent(tx, client.id, 'email_recibido', null, {
      emailId,
      from: email.from,
      subject: email.subject,
      receivedAt: email.receivedAt.toISOString(),
      attachments: attachments.map((a) => ({ filename: a.filename, valid: a.valid })),
    });
    // RF-124: clasificación de cada adjunto, CUIT y monto de cada comprobante o la marca
    // de procesamiento erróneo, y la clasificación del email.
    if (classification) {
      recordClientEvent(tx, client.id, 'clasificacion_email', null, {
        emailId,
        classification,
        attachments: valid.map((a, i) => {
          const r = results[i]!;
          return r.ok
            ? { filename: a.filename, classification: r.classification, cuit: r.cuit, amount: r.amount }
            : { filename: a.filename, error: r.error, attempts: r.attempts };
        }),
      });
    }

    if (decision && decision.action !== 'none') {
      const to = decision.action === 'payment_received' ? 'pago_recibido' : 'revision_manual';
      // RF-129: el motivo nuevo reemplaza al anterior; en Pago recibido no hay motivo.
      const reviewReason = decision.action === 'review' ? decision.reason : null;
      for (const invoiceId of decision.invoiceIds) {
        const before = owed.find((i) => i.id === invoiceId)!;
        const updated = tx.update(invoices).set({ status: to, reviewReason }).where(eq(invoices.id, invoiceId)).returning().get();
        // RF-139, RF-141: el email queda asociado a cada factura que tocó.
        tx.insert(invoiceEmails).values({ invoiceId, emailId }).onConflictDoNothing().run();
        recordClientEvent(tx, client.id, 'cambio_estado_factura', null, {
          invoiceId,
          pointOfSale: updated.pointOfSale,
          number: updated.number,
          period: updated.period,
          from: before.status,
          to,
          reason: reviewReason,
          rule: decision.rule,
          emailId,
        });
      }
    }
    return decision;
  });

  return { kind: 'cliente', clientId: client.id, classification, decision };
}
