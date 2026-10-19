import { defaultSleep } from '../billing/process.js';
import { createClassifier } from '../classifier/index.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { createMailbox } from '../mailbox/index.js';
import type { MailboxCheckDeps } from './check.js';

/** Dependencias reales de la revisión de la casilla según la configuración (mock o real). */
export function createMailboxCheckDeps(config: Config, db: Db, now: () => Date = () => new Date()): MailboxCheckDeps {
  return {
    db,
    now,
    mailbox: createMailbox(config, db),
    systemMailbox: config.systemMailbox,
    classifier: createClassifier(config),
    sleep: defaultSleep,
  };
}
