import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { openDatabase, type DatabaseHandle, type Db } from '../db/index.js';
import { clientEvents, clients, receivedAttachments, receivedEmails } from '../db/schema.js';
import { processReceivedEmail } from '../payments/process-email.js';
import { CLASSIFIER_MODEL, ClaudeClassifier } from './claude.js';
import { createClassifier } from './index.js';
import { MockClassifier } from './mock.js';
import { classifyWithRetries } from './retry.js';
import { ClassifierError, normalizeExtractedAmount, type AttachmentInput, type Classification } from './types.js';

const input = (filename: string, contentType = 'application/pdf'): AttachmentInput => ({
  filename, contentType, content: Buffer.from('%PDF-1.4'), emailSubject: 'Pago', emailText: 'Adjunto el comprobante',
});

describe('clasificador del modo mock (RF-188 a RF-193)', () => {
  const mock = new MockClassifier();

  it('pago_<CUIT>_<monto> es "si" con ese CUIT y monto (RF-189, AC-197)', async () => {
    expect(await mock.classify(input('pago_30711111111_15000.50.pdf'))).toEqual({
      classification: 'si', cuit: '30711111111', amount: '15000.50',
    });
  });

  it('una x en lugar del CUIT o del monto es un dato no extraído, sin distinguir mayúsculas (RF-190, AC-198)', async () => {
    expect(await mock.classify(input('PAGO_x_15000.50.PDF'))).toEqual({ classification: 'si', cuit: null, amount: '15000.50' });
    expect(await mock.classify(input('pago_30711111111_x.png', 'image/png'))).toEqual({ classification: 'si', cuit: '30711111111', amount: null });
  });

  it('un CUIT que no tiene 11 dígitos se considera no extraído (RF-122)', async () => {
    expect((await mock.classify(input('pago_3071111_100.pdf'))).cuit).toBeNull();
  });

  it('"dudoso…" es dudoso, "error…" es un procesamiento erróneo y cualquier otro es "no" (RF-191 a RF-193, AC-199)', async () => {
    expect((await mock.classify(input('dudoso_transferencia.jpg', 'image/jpeg'))).classification).toBe('dudoso');
    await expect(mock.classify(input('Error_1.pdf'))).rejects.toMatchObject({ retryable: false });
    expect(await mock.classify(input('factura_proveedor.pdf'))).toEqual({ classification: 'no', cuit: null, amount: null });
  });
});

describe('montos extraídos', () => {
  it.each([
    ['15000.50', '15000.50'],
    ['15.000,50', '15000.50'],
    ['$ 1500', '1500'],
    ['15000.505', '15000.505'], // se conserva: la validación lo descarta (RNF-13)
    ['abc', null],
    [null, null],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeExtractedAmount(raw)).toBe(expected);
  });
});

/** Cliente de Anthropic falso: cada llamada devuelve o tira lo que indique el test. */
function fakeClient(responses: (Partial<Anthropic.Message> | Error)[]) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('No hay más respuestas simuladas');
    if (next instanceof Error) throw next;
    return { stop_reason: 'end_turn', content: [], ...next } as Anthropic.Message;
  });
  return { create, client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'> };
}
const json = (data: unknown): Partial<Anthropic.Message> => ({
  content: [{ type: 'text', text: JSON.stringify(data), citations: null }] as Anthropic.ContentBlock[],
});
const httpError = (status: number) => Anthropic.APIError.generate(status, { error: { message: `HTTP ${status}` } }, `HTTP ${status}`, new Headers());
const SI = json({ clasificacion: 'si', cuit_ordenante: '30-71111111-1', monto: '15000.50' });

describe('clasificador con Claude', () => {
  it('manda el adjunto (PDF o imagen) con el email como contexto y pide JSON estructurado (RF-119)', async () => {
    const { create, client } = fakeClient([SI, SI]);
    const claude = new ClaudeClassifier({ apiKey: 'x', issuerCuit: '20111111112', client });

    await claude.classify(input('comprobante.pdf'));
    await claude.classify({ ...input('foto.png', 'image/png'), content: Buffer.from('png') });

    const [pdfRequest] = create.mock.calls[0] as unknown as [Anthropic.MessageCreateParamsNonStreaming];
    expect(pdfRequest.model).toBe(CLASSIFIER_MODEL);
    expect(pdfRequest.system).toContain('ordenante');
    expect(pdfRequest.system).toContain('20111111112');
    const content = pdfRequest.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
    expect(content[1]).toMatchObject({ type: 'text' });
    expect((content[1] as Anthropic.TextBlockParam).text).toContain('Adjunto el comprobante');
    expect(pdfRequest.output_config).toMatchObject({ format: { type: 'json_schema' } });

    const [imageRequest] = create.mock.calls[1] as unknown as [Anthropic.MessageCreateParamsNonStreaming];
    expect((imageRequest.messages[0]!.content as Anthropic.ContentBlockParam[])[0]).toMatchObject({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png').toString('base64') },
    });
  });

  it('normaliza el CUIT del ordenante y el monto (RF-120, RF-125)', async () => {
    const { client } = fakeClient([SI]);
    expect(await new ClaudeClassifier({ apiKey: 'x', issuerCuit: '1', client }).classify(input('c.pdf'))).toEqual<Classification>({
      classification: 'si', cuit: '30711111111', amount: '15000.50',
    });
  });

  it('un CUIT de menos de 11 dígitos queda como no extraído (RF-122, AC-114)', async () => {
    const { client } = fakeClient([json({ clasificacion: 'si', cuit_ordenante: '3071111111', monto: '100' })]);
    expect((await new ClaudeClassifier({ apiKey: 'x', issuerCuit: '1', client }).classify(input('c.pdf'))).cuit).toBeNull();
  });

  it('para "no" y "dudoso" no guarda CUIT ni monto', async () => {
    const { client } = fakeClient([json({ clasificacion: 'no', cuit_ordenante: '30711111111', monto: '1' })]);
    expect(await new ClaudeClassifier({ apiKey: 'x', issuerCuit: '1', client }).classify(input('c.pdf'))).toEqual({
      classification: 'no', cuit: null, amount: null,
    });
  });

  it.each([
    ['un JSON inválido', { content: [{ type: 'text', text: 'no es json', citations: null }] }],
    ['una clasificación desconocida', json({ clasificacion: 'tal vez', cuit_ordenante: null, monto: null })],
    ['un rechazo', { stop_reason: 'refusal' as const, content: [] }],
  ])('%s cuenta como falla reintentable (RNF-02 c)', async (_label, response) => {
    const { client } = fakeClient([response as Partial<Anthropic.Message>]);
    await expect(new ClaudeClassifier({ apiKey: 'x', issuerCuit: '1', client }).classify(input('c.pdf'))).rejects.toMatchObject({ retryable: true });
  });

  it('usa la API key de ANTHROPIC_API_KEY, 10 s de timeout y sin reintentos del SDK (RNF-08, AC-226)', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'sk-ant-prueba', GMAIL_USER: 'a@gmail.com', GMAIL_APP_PASSWORD: 'x',
      ARCA_CUIT: '30711111111', ARCA_CERT_PATH: 'c', ARCA_KEY_PATH: 'k',
    });
    const classifier = createClassifier(config) as unknown as { client: Anthropic };
    expect(classifier).toBeInstanceOf(ClaudeClassifier);
    expect(classifier.client.apiKey).toBe('sk-ant-prueba');
    expect(classifier.client.timeout).toBe(10_000);
    expect(classifier.client.maxRetries).toBe(0);
  });

  it('en modo mock no usa Claude (RF-187)', () => {
    expect(createClassifier(loadConfig({ MOCK_MODE: 'true' }))).toBeInstanceOf(MockClassifier);
  });
});

describe('reintentos (RNF-02)', () => {
  const run = (responses: (Partial<Anthropic.Message> | Error)[]) => {
    const { create, client } = fakeClient(responses);
    const sleeps: number[] = [];
    const result = classifyWithRetries(
      new ClaudeClassifier({ apiKey: 'x', issuerCuit: '1', client }), input('c.pdf'), async (ms) => void sleeps.push(ms),
    );
    return { result, create, sleeps };
  };

  it('falla dos veces y a la tercera clasifica: 3 llamadas con esperas de 2 s y 4 s (AC-116)', async () => {
    const { result, create, sleeps } = run([httpError(500), httpError(503), SI]);
    expect(await result).toMatchObject({ ok: true, classification: 'si' });
    expect(create).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  it.each([400, 401, 403, 404, 413])('HTTP %i no se reintenta: una sola llamada y procesamiento erróneo (AC-117, AC-118)', async (status) => {
    const { result, create, sleeps } = run([httpError(status)]);
    expect(await result).toMatchObject({ ok: false, attempts: 1 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('HTTP 429 sí se reintenta (AC-118)', async () => {
    const { result, create } = run([httpError(429), SI]);
    expect(await result).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('HTTP 408 y el timeout de 10 s se reintentan', async () => {
    const { result, create } = run([httpError(408), new Anthropic.APIConnectionTimeoutError(), SI]);
    expect(await result).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('con HTTP 500 en los cuatro intentos queda erróneo, después de esperar 2, 4 y 8 s (AC-125)', async () => {
    const { result, create, sleeps } = run([httpError(500), httpError(500), httpError(500), httpError(500)]);
    expect(await result).toMatchObject({ ok: false, attempts: 4, error: expect.stringContaining('HTTP 500') });
    expect(create).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([2_000, 4_000, 8_000]);
  });
});

describe('procesamiento del email con sus adjuntos', () => {
  let handle: DatabaseHandle;
  let db: Db;
  beforeEach(() => {
    handle = openDatabase(':memory:');
    db = handle.db;
    db.insert(clients).values({ businessName: 'Los Andes', cuit: '30711111111', billingEmail: 'pagos@losandes.com', ivaCondition: 1 }).run();
  });
  afterEach(() => handle.close());

  function emailWith(attachments: { filename: string; contentType?: string; valid?: boolean }[]) {
    const email = db.insert(receivedEmails).values({
      messageId: `<${Math.random()}@x>`, from: 'pagos@losandes.com', subject: 'Pago', text: 'Adjunto',
      receivedAt: new Date(), ingestedAt: new Date(),
    }).returning().get();
    for (const a of attachments) {
      db.insert(receivedAttachments).values({
        emailId: email.id, filename: a.filename, contentType: a.contentType ?? 'application/pdf', inline: false,
        valid: a.valid ?? true, content: Buffer.from('%PDF'),
      }).run();
    }
    return email.id;
  }
  const process = (emailId: number, classifier = new MockClassifier()) =>
    processReceivedEmail({ db, now: () => new Date(), classifier, sleep: async () => {} }, emailId);
  const event = () => db.select().from(clientEvents).where(eq(clientEvents.type, 'clasificacion_email')).get();

  it('clasifica cada adjunto, guarda CUIT y monto y registra todo en el historial (RF-123, RF-124, AC-112, AC-113)', async () => {
    const id = emailWith([{ filename: 'pago_30711111111_100.pdf' }, { filename: 'pago_30711111111_200.50.pdf' }, { filename: 'factura.pdf' }]);

    expect(await process(id)).toMatchObject({ classification: 'si' });

    expect(db.select().from(receivedEmails).get()!.classification).toBe('si');
    expect(db.select().from(receivedAttachments).all().map((a) => [a.classification, a.extractedCuit, a.extractedAmount])).toEqual([
      ['si', '30711111111', '100'], ['si', '30711111111', '200.50'], ['no', null, null],
    ]);
    expect(event()!.data).toEqual({
      emailId: id,
      classification: 'si',
      attachments: [
        { filename: 'pago_30711111111_100.pdf', classification: 'si', cuit: '30711111111', amount: '100' },
        { filename: 'pago_30711111111_200.50.pdf', classification: 'si', cuit: '30711111111', amount: '200.50' },
        { filename: 'factura.pdf', classification: 'no', cuit: null, amount: null },
      ],
    });
  });

  it('un adjunto erróneo hace erróneo al email y queda la marca en el historial (RF-123, AC-115)', async () => {
    await process(emailWith([{ filename: 'pago_30711111111_100.pdf' }, { filename: 'error_1.pdf' }]));
    expect(db.select().from(receivedEmails).get()!.classification).toBe('erroneo');
    expect(db.select().from(receivedAttachments).all()[1]!.processingError).toBe('Error simulado (modo mock).');
    expect((event()!.data as { attachments: unknown[] }).attachments[1]).toMatchObject({ filename: 'error_1.pdf', error: 'Error simulado (modo mock).' });
  });

  it('"si" + "dudoso" es dudoso; "no" + "si" es si (RF-123, AC-127, AC-136)', async () => {
    expect(await process(emailWith([{ filename: 'pago_30711111111_100.pdf' }, { filename: 'dudoso.jpg', contentType: 'image/jpeg' }]))).toMatchObject({ classification: 'dudoso' });
    expect(await process(emailWith([{ filename: 'otro.pdf' }, { filename: 'pago_30711111111_100.pdf' }]))).toMatchObject({ classification: 'si' });
  });

  it('sin adjuntos válidos no llama al LLM ni clasifica (RF-115, AC-105 a AC-107)', async () => {
    const classifier = { classify: vi.fn() };
    const id = emailWith([{ filename: 'notas.docx', valid: false }]);

    expect(await process(id, classifier as never)).toMatchObject({ kind: 'cliente', classification: null });
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(event()).toBeUndefined();
  });

  it('solo manda al LLM los adjuntos válidos (AC-107)', async () => {
    const classifier = { classify: vi.fn(async () => ({ classification: 'no' as const, cuit: null, amount: null })) };
    await process(emailWith([{ filename: 'a.png', contentType: 'image/png' }, { filename: 'b.pdf' }, { filename: 'logo.png', valid: false }]), classifier);
    expect(classifier.classify.mock.calls.map((c) => (c as unknown as [AttachmentInput])[0].filename)).toEqual(['a.png', 'b.pdf']);
  });

  it('un error inesperado del clasificador también cuenta como falla', async () => {
    const classifier = { classify: vi.fn(async () => { throw new ClassifierError('400', false); }) };
    await process(emailWith([{ filename: 'c.pdf' }]), classifier);
    expect(db.select().from(receivedEmails).get()!.classification).toBe('erroneo');
  });
});
