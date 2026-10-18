import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { MockArcaClient } from './mock.js';
import type { ArcaClient } from './types.js';
import { getAccessTicket } from './wsaa.js';
import { WsfeClient } from './wsfe.js';

export * from './types.js';

/** ARCA simulado en modo mock (RF-185); WSFEv1 de homologación fuera de él. */
export function createArcaClient(config: Config, db: Db, now: () => Date = () => new Date()): ArcaClient {
  if (config.mockMode) return new MockArcaClient(db);

  const { cuit, certPath, keyPath } = config.arca;
  if (!certPath || !keyPath) throw new Error('Faltan ARCA_CERT_PATH o ARCA_KEY_PATH.');

  return new WsfeClient({
    cuit,
    getTicket: () => getAccessTicket('wsfe', { db, certPath, keyPath, now }),
  });
}
