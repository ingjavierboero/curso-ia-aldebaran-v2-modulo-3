import Anthropic from '@anthropic-ai/sdk';
import { attachmentType } from '../mailbox/attachments.js';
import {
  ClassifierError,
  normalizeExtractedAmount,
  normalizeExtractedCuit,
  type AttachmentClassifier,
  type AttachmentInput,
  type Classification,
} from './types.js';

/** Modelo fijado en el AGENTS.md para la clasificación y la extracción. */
export const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

/** RNF-02: una llamada al LLM se da por fallida si no responde en 10 s. */
export const LLM_TIMEOUT_MS = 10_000;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Salida estructurada: clasificación, CUIT del ordenante y monto (RF-119 a RF-121). */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    clasificacion: { type: 'string', enum: ['si', 'no', 'dudoso'] },
    cuit_ordenante: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    monto: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['clasificacion', 'cuit_ordenante', 'monto'],
  additionalProperties: false,
} as const;

function systemPrompt(issuerCuit: string): string {
  return `Revisás los adjuntos que los clientes de una empresa argentina responden a sus emails de facturación, para saber si son comprobantes de pago.

Para el adjunto que recibís, respondé:
- clasificacion:
  - "si": es un comprobante de pago legible (transferencia bancaria, depósito, pago por homebanking, billetera virtual o similar) donde se ve que se pagó un monto.
  - "no": no es un comprobante de pago (por ejemplo, una factura, un presupuesto, un logo, una foto cualquiera u otro documento).
  - "dudoso": no se puede leer bien o no permite determinar si es un comprobante de pago.
- cuit_ordenante: solo si es "si", el CUIT o CUIL de quien hizo el pago (ordenante u originante), tal como figura. Nunca el del beneficiario o destinatario: el CUIT ${issuerCuit} es el de la empresa que cobra, no lo devuelvas. null si no figura o no se lee.
- monto: solo si es "si", el importe pagado en pesos como número decimal con punto y sin separador de miles (por ejemplo "15000.50"). null si no figura o no se lee.

Para "no" y "dudoso", cuit_ordenante y monto van en null. El asunto y el cuerpo del email son contexto: clasificá el adjunto.`;
}

export interface ClaudeClassifierOptions {
  apiKey: string;
  /** CUIT de la empresa emisora, para que nunca se confunda con el del ordenante. */
  issuerCuit: string;
  /** Inyectable para los tests. */
  client?: Pick<Anthropic, 'messages'>;
}

/** RF-119 a RF-121: clasificación y extracción con Claude. */
export class ClaudeClassifier implements AttachmentClassifier {
  private readonly client: Pick<Anthropic, 'messages'>;

  constructor(private readonly options: ClaudeClassifierOptions) {
    // Los reintentos los maneja classifyWithRetries con las esperas de RNF-02.
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 0 });
  }

  async classify(input: AttachmentInput): Promise<Classification> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: CLASSIFIER_MODEL,
        max_tokens: 512,
        system: systemPrompt(this.options.issuerCuit),
        messages: [{ role: 'user', content: [attachmentBlock(input), emailContext(input)] }],
        output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      });
    } catch (error) {
      throw toClassifierError(error);
    }
    return parseResponse(response);
  }
}

function attachmentBlock(input: AttachmentInput): Anthropic.ContentBlockParam {
  const type = attachmentType(input);
  const data = input.content.toString('base64');
  if (type === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (IMAGE_TYPES.has(type)) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data },
    };
  }
  throw new ClassifierError(`Formato de adjunto no soportado: ${type}.`, false);
}

function emailContext(input: AttachmentInput): Anthropic.TextBlockParam {
  return {
    type: 'text',
    text: `Nombre del archivo: ${input.filename}\nAsunto del email: ${input.emailSubject}\nCuerpo del email:\n${input.emailText.slice(0, 4000)}`,
  };
}

/** RNF-02 (c): una respuesta que no se puede interpretar cuenta como falla y se reintenta. */
export function parseResponse(response: Anthropic.Message): Classification {
  if (response.stop_reason === 'refusal') throw new ClassifierError('El modelo rechazó clasificar el adjunto.', true);
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  let data: { clasificacion?: unknown; cuit_ordenante?: unknown; monto?: unknown };
  try {
    data = JSON.parse(text ?? '');
  } catch {
    throw new ClassifierError('La respuesta del modelo no es un JSON válido.', true);
  }
  const classification = data.clasificacion;
  if (classification !== 'si' && classification !== 'no' && classification !== 'dudoso') {
    throw new ClassifierError(`Clasificación inválida: ${JSON.stringify(classification)}.`, true);
  }
  if (classification !== 'si') return { classification, cuit: null, amount: null };
  return {
    classification,
    cuit: normalizeExtractedCuit(typeof data.cuit_ordenante === 'string' ? data.cuit_ordenante : null),
    amount: normalizeExtractedAmount(typeof data.monto === 'string' || typeof data.monto === 'number' ? data.monto : null),
  };
}

/** RNF-02 (a), (b): qué errores se reintentan. */
export function toClassifierError(error: unknown): ClassifierError {
  if (error instanceof ClassifierError) return error;
  // APIConnectionError (red y timeout) es subclase de APIError: se revisa primero.
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ClassifierError(`Claude no respondió en ${LLM_TIMEOUT_MS / 1000} s.`, true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ClassifierError(`No se pudo conectar con Claude: ${error.message}`, true);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const retryable = status === 408 || status === 429 || status >= 500;
    return new ClassifierError(`Claude respondió HTTP ${status}: ${error.message}`, retryable);
  }
  return new ClassifierError(error instanceof Error ? error.message : String(error), true);
}
