import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockClassifier } from '../classifier/mock.js';
import { openDatabase, type DatabaseHandle, type Db } from '../db/index.js';
import { clients, invoices, processErrors, receivedEmails, settings } from '../db/schema.js';
import { MailboxError, type IncomingEmail, type Mailbox } from '../mailbox/index.js';
import { getSettings } from '../settings/settings.js';
import { MailboxRunner } from './runner.js';

const MINUTE = 60_000;
let handle: DatabaseHandle;
let db: Db;
let now: Date;
let inbox: IncomingEmail[];
let failing: boolean;
let fetchSince: ReturnType<typeof vi.fn>;
let runner: MailboxRunner;

beforeEach(() => {
  handle = openDatabase(':memory:');
  db = handle.db;
  now = new Date('2026-10-20T15:00:00-03:00');
  inbox = [];
  failing = false;
  const clientId = db.insert(clients).values({ businessName: 'Los Andes', cuit: '30711111111', billingEmail: 'pagos@losandes.com', ivaCondition: 1 }).returning().get().id;
  db.insert(invoices).values({
    clientId, period: '2026-10', voucherType: 11, pointOfSale: 1, number: 1, cae: '1', caeDueDate: '2026-10-25',
    issueDate: '2026-10-15', serviceFrom: '2026-10-01', serviceTo: '2026-10-31', paymentDueDate: '2026-10-31',
    totalCents: 100, clientBusinessName: 'Los Andes', clientCuit: '30711111111', clientIvaCondition: 1,
  }).run();
  fetchSince = vi.fn(async (since: Date) => {
    if (failing) throw new MailboxError('IMAP sin respuesta en 30 s');
    return inbox.filter((e) => e.date >= since);
  });
  const mailbox: Mailbox = { fetchSince };
  runner = new MailboxRunner(
    db,
    () => ({ db, now: () => now, mailbox, systemMailbox: 'aldebaran@gmail.com', classifier: new MockClassifier(), sleep: async () => {} }),
    () => now,
  );
});
afterEach(() => handle.close());

const advance = (minutes: number) => {
  now = new Date(now.getTime() + minutes * MINUTE);
};
/** Una revisión del scheduler y la espera a que termine la que haya arrancado. */
const tick = async () => {
  runner.tick();
  await runner.whenIdle();
};
const email = (subject: string, at: Date): IncomingEmail => ({
  messageId: `<${subject}@x>`, from: 'pagos@losandes.com', fromName: null, subject, text: '', date: at, attachments: [],
});
const pendingErrors = () => db.select().from(processErrors).all().filter((e) => e.status === 'pendiente');

describe('revisión periódica de la casilla', () => {
  it('revisa al arrancar y después cada 15 minutos desde el inicio de la anterior (RF-99, RF-101, AC-92)', async () => {
    await tick();
    expect(fetchSince).toHaveBeenCalledTimes(1);

    advance(14);
    await tick();
    expect(fetchSince).toHaveBeenCalledTimes(1);

    advance(1);
    await tick();
    expect(fetchSince).toHaveBeenCalledTimes(2);
  });

  it('respeta el intervalo configurado (RF-100, AC-93)', async () => {
    getSettings(db);
    db.update(settings).set({ mailboxIntervalMinutes: 30 }).run();
    await tick();
    advance(15);
    await tick();
    expect(fetchSince).toHaveBeenCalledTimes(1);
    advance(15);
    await tick();
    expect(fetchSince).toHaveBeenCalledTimes(2);
  });

  it('si una revisión sigue en curso, no inicia otra hasta que termine (RF-102, AC-95)', async () => {
    let release!: () => void;
    fetchSince.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));

    runner.tick(); // 15:00, queda colgada
    advance(15);
    runner.tick(); // 15:15, todavía en curso
    expect(fetchSince).toHaveBeenCalledTimes(1);

    release();
    await runner.whenIdle();
    await tick(); // ya pasó el intervalo desde el inicio de la anterior
    expect(fetchSince).toHaveBeenCalledTimes(2);
  });

  it('procesa los emails nuevos de cada revisión', async () => {
    await tick();
    inbox.push(email('pago', new Date(now.getTime() + MINUTE)));
    advance(15);
    await tick();
    expect(db.select().from(receivedEmails).all().map((e) => [e.subject, e.clientId !== null])).toEqual([['pago', true]]);
  });
});

describe('falla de la casilla (RF-103 a RF-106)', () => {
  it('registra un error de proceso Pendiente de revisión de la casilla (RF-103, AC-96)', async () => {
    failing = true;
    await tick();
    expect(pendingErrors()).toMatchObject([
      { operation: 'revision_casilla', clientId: null, attempts: 1, lastError: 'IMAP sin respuesta en 30 s' },
    ]);
  });

  it('con la casilla caída tres intervalos: un intento por intervalo y un único error Pendiente (RF-104, AC-97)', async () => {
    failing = true;
    await tick();
    for (let i = 0; i < 2; i++) {
      advance(5);
      await tick(); // antes del intervalo: no reintenta
      advance(10);
      await tick();
    }
    expect(fetchSince).toHaveBeenCalledTimes(3);
    expect(pendingErrors()).toHaveLength(1);
    expect(pendingErrors()[0]!.attempts).toBe(3);
  });

  it('al volver, procesa los emails llegados durante la falla y resuelve el error (RF-105, RF-106, AC-98)', async () => {
    await tick(); // 15:00 bien
    failing = true;
    inbox.push(email('durante-1', new Date(now.getTime() + 5 * MINUTE)), email('durante-2', new Date(now.getTime() + 20 * MINUTE)));
    advance(15);
    await tick(); // 15:15 falla
    advance(15);
    await tick(); // 15:30 falla
    failing = false;
    advance(15);
    await tick(); // 15:45 vuelve

    expect(db.select().from(receivedEmails).all().map((e) => e.subject)).toEqual(['durante-1', 'durante-2']);
    expect(pendingErrors()).toEqual([]);
    expect(db.select().from(processErrors).get()).toMatchObject({ status: 'resuelto', operation: 'revision_casilla' });
  });

  it('check() nunca tira: el error queda registrado', async () => {
    failing = true;
    await expect(runner.check()).resolves.toBeNull();
  });
});
