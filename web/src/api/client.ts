export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** Se llama cuando el server responde 401 (sesión vencida o cerrada en otro lado). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Llama a la API del server. Devuelve el JSON de la respuesta o tira un ApiError. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el servidor.');
  }

  const data = await readJson(res);

  if (!res.ok) {
    // Un 401 del login es "credenciales incorrectas", no una sesión vencida.
    if (res.status === 401 && path !== '/auth/login') unauthorizedHandler?.();
    const message =
      typeof data === 'object' && data && 'error' in data && typeof data.error === 'string'
        ? data.error
        : 'Ocurrió un error inesperado.';
    throw new ApiError(res.status, message);
  }

  return data as T;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
