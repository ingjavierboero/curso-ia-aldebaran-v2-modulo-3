import { normalizeCuit } from '../domain/cuit.js';

export type AttachmentClass = 'si' | 'no' | 'dudoso';

/** Resultado de clasificar un adjunto (RF-119, RF-120). */
export interface Classification {
  classification: AttachmentClass;
  /** Solo si es "si": CUIT del ordenante (11 dígitos) o null si no se pudo extraer. */
  cuit: string | null;
  /** Solo si es "si": monto pagado como decimal con punto ("15000.50"), o null. */
  amount: string | null;
}

export interface AttachmentInput {
  filename: string;
  contentType: string;
  content: Buffer;
  emailSubject: string;
  emailText: string;
}

export interface AttachmentClassifier {
  /** Un intento de clasificación. Tira ClassifierError si falla. */
  classify(input: AttachmentInput): Promise<Classification>;
}

/**
 * Falla de una llamada al LLM. `retryable` indica si vale reintentar (RNF-02): sí ante
 * timeout, red, 408, 429, 5xx o una respuesta que no se puede interpretar; no ante el
 * resto de los 4xx (400, 401, 403, 404, 413...).
 */
export class ClassifierError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ClassifierError';
  }
}

/** RF-122, RF-125: solo los dígitos; si no son 11, el CUIT se considera no extraído. */
export function normalizeExtractedCuit(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = normalizeCuit(value);
  return digits.length === 11 ? digits : null;
}

/** Monto tal como se leyó, como decimal con punto ("15.000,50" → "15000.50"); null si no es un número. */
export function normalizeExtractedAmount(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value).trim().replace(/^\$\s*/, '').replace(/\s/g, '');
  // Formato argentino (1.234,56): los puntos son miles y la coma es decimal.
  if (/,\d+$/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}
