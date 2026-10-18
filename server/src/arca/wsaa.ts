import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import forge from 'node-forge';
import type { Db } from '../db/index.js';
import { arcaAccessTickets } from '../db/schema.js';
import { extractTag, postSoap, unescapeXml } from './soap.js';
import { ArcaError } from './types.js';

/** Solo homologación: nunca los endpoints productivos (AGENTS.md). */
export const WSAA_HOMOLOGACION_URL = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
const WSAA_NS = 'http://wsaa.view.sua.dvadac.desein.afip.gov';

/** Margen para no usar un ticket que está por vencer en medio de una operación. */
const TICKET_MARGIN_MS = 5 * 60 * 1000;

export interface AccessTicket {
  token: string;
  sign: string;
}

export interface WsaaOptions {
  db: Db;
  certPath: string;
  keyPath: string;
  now: () => Date;
  fetchImpl?: typeof fetch;
}

/**
 * Ticket de acceso vigente para el servicio: usa el guardado si sigue vigente y, si
 * no, pide uno nuevo a WSAA y lo guarda.
 */
export async function getAccessTicket(service: string, options: WsaaOptions): Promise<AccessTicket> {
  const { db, now } = options;
  const cached = db.select().from(arcaAccessTickets).where(eq(arcaAccessTickets.service, service)).get();
  if (cached && cached.expiresAt.getTime() - TICKET_MARGIN_MS > now().getTime()) {
    return { token: cached.token, sign: cached.sign };
  }

  const { certPem, keyPem } = readCredentials(options.certPath, options.keyPath);
  const cms = signTra(buildTra(service, now()), certPem, keyPem);
  const ticket = await loginCms(cms, options.fetchImpl);

  db.insert(arcaAccessTickets)
    .values({ service, ...ticket })
    .onConflictDoUpdate({ target: arcaAccessTickets.service, set: ticket })
    .run();
  return { token: ticket.token, sign: ticket.sign };
}

function readCredentials(certPath: string, keyPath: string) {
  try {
    return { certPem: readFileSync(certPath, 'utf8'), keyPem: readFileSync(keyPath, 'utf8') };
  } catch (error) {
    throw new ArcaError(
      `No se pudo leer el certificado o la clave de ARCA (ARCA_CERT_PATH, ARCA_KEY_PATH): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** TRA (Ticket de Requerimiento de Acceso): válido desde 10 min antes hasta 12 h después. */
export function buildTra(service: string, now: Date): string {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '-00:00');
  const t = now.getTime();
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<loginTicketRequest version="1.0"><header>' +
    `<uniqueId>${Math.floor(t / 1000)}</uniqueId>` +
    `<generationTime>${iso(t - 10 * 60 * 1000)}</generationTime>` +
    `<expirationTime>${iso(t + 12 * 60 * 60 * 1000)}</expirationTime>` +
    `</header><service>${service}</service></loginTicketRequest>`
  );
}

/** Firma el TRA como CMS (PKCS#7, SHA-256) y devuelve el DER en base64. */
export function signTra(tra: string, certPem: string, keyPem: string): string {
  let certificate: forge.pki.Certificate;
  let key: forge.pki.rsa.PrivateKey;
  try {
    certificate = forge.pki.certificateFromPem(certPem);
    key = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  } catch {
    throw new ArcaError('El certificado o la clave privada de ARCA no tienen un formato PEM válido.');
  }

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(certificate);
  p7.addSigner({
    key,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data! },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime!, value: new Date() as unknown as string },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

async function loginCms(cms: string, fetchImpl?: typeof fetch) {
  const envelope =
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="${WSAA_NS}">` +
    '<soapenv:Header/><soapenv:Body>' +
    `<wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms>` +
    '</soapenv:Body></soapenv:Envelope>';

  let xml: string;
  try {
    xml = await postSoap(WSAA_HOMOLOGACION_URL, '', envelope, fetchImpl);
  } catch (error) {
    // Pasa si se perdió el ticket guardado (por ejemplo, otra base) y el anterior sigue vigente.
    if (error instanceof ArcaError && /ya posee un TA valido/i.test(error.message)) {
      throw new ArcaError(
        'WSAA no emite un ticket nuevo porque ya hay uno vigente para este certificado ' +
          '(por ejemplo, pedido desde otra base o aplicación). Vence en hasta 12 h.',
      );
    }
    throw error;
  }

  const ret = extractTag(xml, 'loginCmsReturn');
  const ticketXml = ret ? unescapeXml(ret) : '';
  const token = extractTag(ticketXml, 'token');
  const sign = extractTag(ticketXml, 'sign');
  const expirationTime = extractTag(ticketXml, 'expirationTime');
  if (!token || !sign || !expirationTime) {
    throw new ArcaError('WSAA no devolvió un ticket de acceso válido.');
  }
  return { token, sign, expiresAt: new Date(expirationTime) };
}
