import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { MockMailer } from './mock.js';
import { SmtpMailer } from './smtp.js';
import type { Mailer } from './types.js';

export * from './types.js';

/** Casilla simulada en modo mock (RF-194); Gmail por SMTP fuera de él. */
export function createMailer(config: Config, db: Db, now: () => Date = () => new Date()): Mailer {
  if (config.mockMode) return new MockMailer(db, config.systemMailbox, now);
  if (!config.gmail) throw new Error('Faltan GMAIL_USER o GMAIL_APP_PASSWORD.');
  return new SmtpMailer({ ...config.gmail, redirectTo: config.emailRedirectTo });
}
