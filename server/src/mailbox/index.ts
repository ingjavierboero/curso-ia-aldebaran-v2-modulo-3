import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { ImapMailbox } from './imap.js';
import { MockMailbox } from './mock.js';
import type { Mailbox } from './types.js';

export * from './types.js';

/** Casilla simulada en modo mock (RF-194, RF-203); Gmail por IMAP fuera de él. */
export function createMailbox(config: Config, db: Db): Mailbox {
  if (config.mockMode) return new MockMailbox(db);
  if (!config.gmail) throw new Error('Faltan GMAIL_USER o GMAIL_APP_PASSWORD.');
  return new ImapMailbox(config.gmail);
}
