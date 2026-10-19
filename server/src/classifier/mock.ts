import { ClassifierError, normalizeExtractedAmount, normalizeExtractedCuit, type AttachmentClassifier, type AttachmentInput, type Classification } from './types.js';

/**
 * Clasificador del modo mock (RF-187 a RF-193): no llama a la API de Claude y clasifica
 * cada adjunto por su nombre de archivo, sin distinguir mayúsculas:
 * - `pago_<CUIT>_<monto>.<ext>` → "si" con ese CUIT y monto (una `x` = no extraído);
 * - empieza con `dudoso` → "dudoso";
 * - empieza con `error` → procesamiento erróneo;
 * - cualquier otro → "no".
 */
export class MockClassifier implements AttachmentClassifier {
  async classify({ filename }: AttachmentInput): Promise<Classification> {
    const name = filename.trim().toLowerCase();

    // El error no se reintenta: así el ensayo no espera 14 s por cada adjunto.
    if (name.startsWith('error')) throw new ClassifierError('Error simulado (modo mock).', false);
    if (name.startsWith('dudoso')) return { classification: 'dudoso', cuit: null, amount: null };

    const payment = /^pago_([^_]+)_(.+)\.[a-z0-9]+$/.exec(name);
    if (payment) {
      const [, cuit, amount] = payment;
      return {
        classification: 'si',
        cuit: cuit === 'x' ? null : normalizeExtractedCuit(cuit),
        amount: amount === 'x' ? null : normalizeExtractedAmount(amount),
      };
    }
    return { classification: 'no', cuit: null, amount: null };
  }
}
