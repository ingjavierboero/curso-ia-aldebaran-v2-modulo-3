import { createArcaClient } from '../arca/index.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { createMailer } from '../email/index.js';
import { fetchBlueSellRate } from '../exchange/dolarhoy.js';
import { deliverInvoiceEmail } from '../invoices/email.js';
import type { Invoice } from './generate.js';
import { defaultSleep, type BillingDeps } from './process.js';

/**
 * Dependencias reales del proceso de facturación según la configuración: ARCA real o
 * simulado, dolarhoy.com y el envío del email de cada factura apenas se genera (RF-85).
 */
export function createBillingDeps(
  config: Config,
  db: Db,
  options: {
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    /** Se llama después de intentar enviar el email de cada factura. */
    afterInvoice?: (invoice: Invoice) => void;
  } = {},
): BillingDeps {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const mailer = createMailer(config, db, now);

  return {
    db,
    arca: createArcaClient(config, db, now),
    readRate: () => fetchBlueSellRate(),
    now,
    sleep,
    onInvoiceGenerated: async (invoice) => {
      await deliverInvoiceEmail(
        { db, mailer, issuerCuit: config.arca.cuit, mockMode: config.mockMode, sleep },
        invoice,
      );
      options.afterInvoice?.(invoice);
    },
  };
}
