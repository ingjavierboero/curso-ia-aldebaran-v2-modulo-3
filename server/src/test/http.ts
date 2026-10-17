import type { Server } from 'node:http';
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
export async function startTestApp(options: { now?: () => Date } = {}): Promise<TestApp> {
  const database = openDatabase(':memory:');
  const server: Server = createApp({ db: database.db, now: options.now }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    db: database.db,
    async request(method, path, { body, rawBody, cookie } = {}) {
      const headers: Record<string, string> = {};
      if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = `aldebaran_session=${cookie}`;

      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      });

      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('aldebaran_session='));
      const sessionCookie = setCookie?.split(';')[0]?.split('=')[1] || undefined;
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, sessionCookie };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
