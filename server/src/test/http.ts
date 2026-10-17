import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db/index.js';

export interface TestResponse {
  status: number;
  body: any;
  /** Valor de la cookie de sesión que fijó la respuesta, si fijó alguna. */
  sessionCookie: string | undefined;
}

export interface TestApp {
  db: Db;
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; rawBody?: string; cookie?: string },
  ) => Promise<TestResponse>;
  close: () => Promise<void>;
}

/** Levanta la app con una base en memoria en un puerto libre. */
export async function startTestApp(
  options: { now?: () => Date; mockMode?: boolean } = {},
): Promise<TestApp> {
  const database = openDatabase(':memory:');
  const server: Server = createApp({ db: database.db, ...options }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    db: database.db,
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
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (text += chunk));
            res.on('end', () => {
              const setCookie = res.headers['set-cookie']?.find((c) =>
                c.startsWith('aldebaran_session='),
              );
              const sessionCookie = setCookie?.split(';')[0]?.split('=')[1] || undefined;
              resolve({
                status: res.statusCode ?? 0,
                body: text ? JSON.parse(text) : null,
                sessionCookie,
              });
            });
          },
        );
        req.on('error', reject);
        req.end(payload);
      });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
