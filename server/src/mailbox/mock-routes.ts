import { randomUUID } from 'node:crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { currentUser, requireRole } from '../auth/middleware.js';
import { clients, mockMailboxAttachments, mockMailboxEmails } from '../db/schema.js';
import { parseBody } from '../http/validation.js';
import { attachmentType } from './attachments.js';
import { parseAddress } from './mock.js';

/** Límite de los adjuntos de un email cargado (en base64 ocupa ~33 % más). */
const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

const uploadSchema = z.object({
  from: z.string({ error: 'El remitente es obligatorio.' }).trim().pipe(z.email('El remitente no es un email válido.')),
  subject: z.string().trim().default(''),
  text: z.string().default(''),
  attachments: z
    .array(
      z.object({
        filename: z.string().trim().min(1, 'Cada adjunto necesita un nombre.'),
        contentType: z.string().default(''),
        inline: z.boolean().default(false),
        contentBase64: z.string().min(1, 'Un adjunto está vacío.'),
      }),
    )
    .default([]),
});

/** RF-204: fuera del modo mock la casilla simulada no existe. */
function mockOnly(ctx: AppContext) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!ctx.mockMode) {
      res.status(404).json({ error: 'La casilla simulada solo existe en modo mock.' });
      return;
    }
    next();
  };
}

export function mockMailboxRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(mockOnly(ctx));

  /**
   * RF-197, RF-198: un Admin ve todos los emails, enviados y recibidos; Editor y Consulta,
   * solo los recibidos desde el email de facturación de un cliente.
   */
  const visibleEmails = (req: Request) => {
    const rows = ctx.db.select().from(mockMailboxEmails).orderBy(desc(mockMailboxEmails.date), desc(mockMailboxEmails.id)).all();
    if (currentUser(req).role === 'admin') return rows;
    const billingEmails = new Set(
      ctx.db.select({ email: sql<string>`lower(${clients.billingEmail})` }).from(clients).all().map((c) => c.email),
    );
    return rows.filter((e) => e.direction === 'recibido' && billingEmails.has(parseAddress(e.from).from.toLowerCase()));
  };

  router.get('/', (req, res) => {
    const emails = visibleEmails(req);
    const attachments = ctx.db
      .select({ id: mockMailboxAttachments.id, emailId: mockMailboxAttachments.emailId, filename: mockMailboxAttachments.filename,
        contentType: mockMailboxAttachments.contentType, inline: mockMailboxAttachments.inline,
        size: sql<number>`length(${mockMailboxAttachments.content})` })
      .from(mockMailboxAttachments)
      .orderBy(asc(mockMailboxAttachments.id))
      .all();
    res.json({
      emails: emails.map((e) => ({ ...e, attachments: attachments.filter((a) => a.emailId === e.id) })),
    });
  });

  router.get('/:id/attachments/:attachmentId', (req, res) => {
    const email = visibleEmails(req).find((e) => e.id === Number(req.params.id));
    const attachment = email
      ? ctx.db.select().from(mockMailboxAttachments).where(eq(mockMailboxAttachments.id, Number(req.params.attachmentId))).get()
      : undefined;
    if (!email || !attachment || attachment.emailId !== email.id) {
      res.status(404).json({ error: 'El adjunto no existe.' });
      return;
    }
    res.type(attachment.contentType || 'application/octet-stream')
      .setHeader('content-disposition', `inline; filename="${encodeURIComponent(attachment.filename)}"`)
      .send(attachment.content);
  });

  /**
   * RF-200 a RF-202: un Admin o Editor carga un email recibido. La fecha de recepción es
   * el momento de la carga y recibe un Message-ID único. Se procesa en la siguiente
   * revisión de la casilla (RF-203).
   */
  router.post('/', requireRole('admin', 'editor'), (req, res) => {
    const data = parseBody(uploadSchema, req, res);
    if (!data) return;

    const attachments = data.attachments.map((a) => {
      const content = Buffer.from(a.contentBase64, 'base64');
      return { filename: a.filename, inline: a.inline, content, contentType: attachmentType({ filename: a.filename, contentType: a.contentType || 'application/octet-stream' }) };
    });
    if (attachments.reduce((sum, a) => sum + a.content.length, 0) > MAX_ATTACHMENTS_BYTES) {
      res.status(413).json({ error: 'Los adjuntos superan los 15 MB.' });
      return;
    }

    const email = ctx.db.transaction((tx) => {
      const row = tx
        .insert(mockMailboxEmails)
        .values({
          direction: 'recibido',
          messageId: `<${randomUUID()}@aldebaran-mock>`,
          from: data.from,
          to: ctx.systemMailbox,
          subject: data.subject,
          text: data.text,
          date: ctx.now(),
          createdBy: currentUser(req).id,
        })
        .returning()
        .get();
      for (const attachment of attachments) tx.insert(mockMailboxAttachments).values({ emailId: row.id, ...attachment }).run();
      return row;
    });
    res.status(201).json({ email });
  });

  return router;
}
