import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../db/schema.js';
import { startTestApp, type TestApp } from '../test/http.js';

const VALID = {
  mailboxIntervalMinutes: 15,
  billingTime: '11:00',
  reminderTime: '11:00',
  retryCount: 3,
  retryWaitMinutes: 5,
  pointOfSale: 1,
  issuerBusinessName: 'Aldebaran SAS',
  issuerAddress: 'Av. Corrientes 1234, CABA',
  issuerIvaCondition: 'Responsable Monotributo',
  issuerGrossIncomeNumber: '901-123456-7',
  issuerActivityStartDate: '2020-03-01',
};

let app: TestApp;
let admin: string;

beforeEach(async () => {
  app = await startTestApp({ issuerCuit: '30711111111' });
  admin = await app.loginAs('admin');
});
afterEach(async () => {
  await app.close();
});

const save = (body: unknown, cookie = admin) => app.request('PUT', '/api/settings', { body, cookie });
const current = async (cookie = admin) => (await app.request('GET', '/api/settings', { cookie })).body.settings;

describe('configuración', () => {
  it('arranca con los valores por defecto del PRD y el CUIT del emisor de ARCA_CUIT', async () => {
    expect(await current()).toMatchObject({
      mailboxIntervalMinutes: 15, billingTime: '11:00', reminderTime: '11:00',
      retryCount: 3, retryWaitMinutes: 5, pointOfSale: 1,
      issuerBusinessName: null, issuerCuit: '30711111111', mockMode: false,
    });
  });

  it('un Admin guarda todos los valores, incluidos los datos de la empresa emisora (RF-91, AC-06, AC-83)', async () => {
    const res = await save({ ...VALID, mailboxIntervalMinutes: 30, billingTime: '14:00', pointOfSale: 5 });

    expect(res.status).toBe(200);
    expect(await current()).toMatchObject({ ...VALID, mailboxIntervalMinutes: 30, billingTime: '14:00', pointOfSale: 5 });
  });

  it('acepta los límites de cada valor', async () => {
    for (const body of [
      { mailboxIntervalMinutes: 5 }, { mailboxIntervalMinutes: 60 },
      { billingTime: '00:00' }, { billingTime: '23:39' }, { reminderTime: '23:39' },
      { retryCount: 0 }, { retryCount: 10 }, { retryWaitMinutes: 1 }, { retryWaitMinutes: 60 },
      { pointOfSale: 1 }, { pointOfSale: 99_999 },
    ]) {
      expect((await save({ ...VALID, ...body })).status, JSON.stringify(body)).toBe(200);
    }
  });

  it.each([
    ['intervalo de la casilla en 4', { mailboxIntervalMinutes: 4 }, 'AC-94'],
    ['intervalo de la casilla en 61', { mailboxIntervalMinutes: 61 }, 'AC-94'],
    ['hora de facturación 23:40', { billingTime: '23:40' }, 'AC-62'],
    ['hora de facturación 9:00', { billingTime: '9:00' }, 'RF-62'],
    ['hora de recordatorios 23:40', { reminderTime: '23:40' }, 'AC-160'],
    ['11 reintentos', { retryCount: 11 }, 'AC-183'],
    ['espera de 0 minutos', { retryWaitMinutes: 0 }, 'AC-185'],
    ['espera de 61 minutos', { retryWaitMinutes: 61 }, 'AC-185'],
    ['punto de venta 0', { pointOfSale: 0 }, 'AC-71'],
    ['punto de venta 100000', { pointOfSale: 100_000 }, 'AC-71'],
    ['fecha de inicio inválida', { issuerActivityStartDate: '01/03/2020' }, 'RF-91'],
  ])('rechaza %s y mantiene el valor anterior (%s)', async (_label, body) => {
    await save(VALID);

    const res = await save({ ...VALID, ...body });

    expect(res.status).toBe(400);
    expect(await current()).toMatchObject(VALID);
  });

  it('guarda vacíos los datos opcionales del emisor que se borran', async () => {
    await save(VALID);
    await save({ ...VALID, issuerGrossIncomeNumber: '', issuerActivityStartDate: '' });
    expect(await current()).toMatchObject({ issuerGrossIncomeNumber: null, issuerActivityStartDate: null });
  });

  it.each(['editor', 'consulta'] as const)('%s la ve pero no puede modificarla (RF-10, RF-13, AC-215)', async (role) => {
    const cookie = await app.loginAs(role);

    expect(await current(cookie)).toMatchObject({ pointOfSale: 1 });
    expect((await save({ ...VALID, pointOfSale: 9 }, cookie)).status).toBe(403);
    expect(app.db.select().from(settings).get()).toMatchObject({ pointOfSale: 1 });
  });
});
