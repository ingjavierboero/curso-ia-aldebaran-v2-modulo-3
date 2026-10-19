import { ClassifierError, type AttachmentClassifier, type AttachmentInput, type Classification } from './types.js';

/** RNF-02: esperas antes de cada reintento (3 reintentos, 4 intentos en total). */
export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

export type ClassifyOutcome =
  | ({ ok: true } & Classification)
  /** RF-123: procesamiento erróneo del adjunto, con el último error. */
  | { ok: false; error: string; attempts: number };

/**
 * RNF-02: clasifica con hasta 3 reintentos, esperando 2 s, 4 s y 8 s antes de cada uno.
 * Un error no reintentable (400, 401, 403, 404, 413...) marca el procesamiento como
 * erróneo de inmediato; si el cuarto intento también falla, también.
 */
export async function classifyWithRetries(
  classifier: AttachmentClassifier,
  input: AttachmentInput,
  sleep: (ms: number) => Promise<void>,
): Promise<ClassifyOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, ...(await classifier.classify(input)) };
    } catch (error) {
      const retryable = error instanceof ClassifierError ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      const delay = RETRY_DELAYS_MS[attempt - 1];
      if (!retryable || delay === undefined) return { ok: false, error: message, attempts: attempt };
      await sleep(delay);
    }
  }
}
