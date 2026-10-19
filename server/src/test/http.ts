import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { MockArcaClient } from '../arca/mock.js';
import { hashPassword } from '../auth/password.js';
import { BillingRunner } from '../billing/runner.js';
import { MockMailer } from '../email/mock.js';
import { openDatabase, type Db } from '../db/index.js';
import { users, type UserRole } from '../db/schema.js';

export interface TestResponse {
  status: number;
  body: any;
  /** Valor de la cookie de sesión que fijó la respuesta, si fijó alguna. */
  sessionCookie: string | undefined;
  headers: import('node:http').IncomingHttpHeaders;
  /** Cuerpo sin parsear (por ejemplo, un PDF). */
  raw: Buffer;
}

export interface TestApp {
  db: Db;
  billing: BillingRunner;
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; rawBody?: string; cookie?: string },
  ) => Promise<TestResponse>;
  /** Crea un usuario Activo con ese perfil, inicia su sesión y devuelve la cookie. */
  loginAs: (role: UserRole) => Promise<string>;
  close: () => Promise<void>;
}

const TEST_PASSWORD = '12345678';
let testPasswordHash: Promise<string> | null = null;

/** Levanta la app con una base en memoria en un puerto libre. */
export async function startTestApp(
  options: { now?: () => Date; mockMode?: boolean; issuerCuit?: string } = {},
): Promise<TestApp> {
  const database = openDatabase(':memory:');
  const now = options.now ?? (() => new Date());
  // Facturación con ARCA simulado, cotización fija y sin esperas entre reintentos.
  const billing = new BillingRunner(
    database.db,
    () => ({ db: database.db, arca: new MockArcaClient(database.db), readRate: async () => 150_000, now, sleep: async () => {} }),
    now,
  );
  const operations = () => {
    const billingDeps = { db: database.db, arca: new MockArcaClient(database.db), readRate: async () => 150_000, now, sleep: async () => {} };
    const mailer = new MockMailer(database.db, 'aldebaran-mock@gmail.com', now);
    return { billing: billingDeps, invoiceEmail: { db: database.db, mailer, issuerCuit: '20111111112', mockMode: true } };
  };
  const server: Server = createApp({ db: database.db, ...options, billing, operations }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    db: database.db,
    billing,
    request(method, path, { body, rawBody, cookie } = {}) {
      const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
      const headers: Record<string, string> = {};
      if (payload !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = `aldebaran_session=${cookie}`;

      // agent: false → una conexión por request. Con keep-alive, una conexión de un
      // test anterior podía quedar apuntando a un server ya cerrado en el mismo puerto.
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, method, path, headers, agent: false },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const raw = Buffer.concat(chunks);
              const isJson = String(res.headers['content-type'] ?? '').includes('json');
              const text = isJson ? raw.toString('utf8') : '';
              const setCookie = res.headers['set-cookie']?.find((c) =>
                c.startsWith('aldebaran_session='),
              );
              const sessionCookie = setCookie?.split(';')[0]?.split('=')[1] || undefined;
              resolve({
                status: res.statusCode ?? 0,
                body: text ? JSON.parse(text) : null,
                sessionCookie,
                headers: res.headers,
                raw,
              });
            });
          },
        );
        req.on('error', reject);
        req.end(payload);
      });
    },
    async loginAs(role) {
      testPasswordHash ??= hashPassword(TEST_PASSWORD);
      const email = `${role}-${Math.random().toString(36).slice(2)}@aldebaran.com`;
      this.db
        .insert(users)
        .values({ name: `Usuario ${role}`, email, role, passwordHash: await testPasswordHash })
        .run();
      const res = await this.request('POST', '/api/auth/login', {
        body: { email, password: TEST_PASSWORD },
      });
      if (!res.sessionCookie) throw new Error(`No se pudo iniciar sesión como ${role}`);
      return res.sessionCookie;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
