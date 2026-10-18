import { timeoutSignal } from '../http/timeout.js';
import { ArcaError } from './types.js';

/** RNF-07: ARCA (WSAA y WSFEv1) se da por caído si no responde en 30 s. */
export const ARCA_TIMEOUT_MS = 30_000;

/** POST de un sobre SOAP 1.1. Devuelve el XML de la respuesta o tira ArcaError. */
export async function postSoap(
  url: string,
  soapAction: string,
  envelope: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: soapAction },
      body: envelope,
      signal: timeoutSignal(ARCA_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new ArcaError(
      timedOut
        ? `ARCA no respondió en ${ARCA_TIMEOUT_MS / 1000} s (${url}).`
        : `No se pudo conectar con ARCA (${url}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    // Los SOAP Fault llegan con HTTP 500.
    const fault = extractTag(text, 'faultstring');
    throw new ArcaError(`ARCA devolvió un error: ${fault ? unescapeXml(fault) : `HTTP ${res.status}`}`);
  }
  return text;
}

/** Contenido del primer <nombre>…</nombre>, sin importar el prefijo de namespace. */
export function extractTag(xml: string, name: string): string | undefined {
  return tagRegex(name, '').exec(xml)?.[1];
}

/** Contenido de todas las apariciones de <nombre>…</nombre>. */
export function extractAll(xml: string, name: string): string[] {
  return [...xml.matchAll(tagRegex(name, 'g'))].map((m) => m[1]!);
}

function tagRegex(name: string, flags: string): RegExp {
  return new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, `i${flags}`);
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Junta los pares Code/Msg de un bloque (Errors, Observaciones) en un texto legible. */
export function readMessages(block: string | undefined): string | null {
  if (!block) return null;
  const codes = extractAll(block, 'Code');
  const msgs = extractAll(block, 'Msg');
  if (msgs.length === 0) return null;
  return msgs.map((msg, i) => `[${codes[i] ?? '?'}] ${unescapeXml(msg)}`).join(' · ');
}
