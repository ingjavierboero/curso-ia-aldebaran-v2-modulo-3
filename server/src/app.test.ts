import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './test/http.js';

describe('app', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health responde ok sin sesión', async () => {
    const res = await app.request('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/app-info indica el modo mock sin sesión (RF-209)', async () => {
    const res = await app.request('GET', '/api/app-info');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mockMode: false, needsSetup: true });

    const mockApp = await startTestApp({ mockMode: true });
    expect((await mockApp.request('GET', '/api/app-info')).body.mockMode).toBe(true);
    await mockApp.close();
  });

  it('responde 400 si el body no es JSON válido', async () => {
    const res = await app.request('POST', '/api/auth/login', { rawBody: '{no es json' });
    expect(res.status).toBe(400);
  });
});
