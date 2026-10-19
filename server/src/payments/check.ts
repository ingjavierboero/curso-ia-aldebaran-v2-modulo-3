import { asc, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { receivedEmails } from '../db/schema.js';
import { ingestNewEmails } from '../mailbox/ingest.js';
import type { Mailbox } from '../mailbox/index.js';
import { processReceivedEmail, type EmailOutcome } from './process-email.js';

export interface MailboxCheckDeps {
  db: Db;
  mailbox: Mailbox;
  systemMailbox: string;
  now: () => Date;
}

export interface MailboxCheckResult {
  /** Emails nuevos leídos de la casilla. */
  ingested: number;
  /** Resultado de cada email procesado en esta revisión. */
  outcomes: { emailId: number; outcome: EmailOutcome }[];
}

/**
 * Una revisión de la casilla: registra los emails nuevos y procesa todos los que estén
 * sin procesar, del más viejo al más nuevo (también los que quedaron a medias si el
 * sistema se cortó). Si la casilla no responde, tira (RF-103 lo maneja quien llama).
 */
export async function runMailboxCheck(deps: MailboxCheckDeps): Promise<MailboxCheckResult> {
  const { emailIds } = await ingestNewEmails(deps);

  const pending = deps.db
    .select({ id: receivedEmails.id })
    .from(receivedEmails)
    .where(isNull(receivedEmails.processedAt))
    .orderBy(asc(receivedEmails.receivedAt), asc(receivedEmails.id))
    .all();

  const outcomes: MailboxCheckResult['outcomes'] = [];
  for (const { id } of pending) {
    outcomes.push({ emailId: id, outcome: await processReceivedEmail(deps, id) });
  }
  return { ingested: emailIds.length, outcomes };
}
