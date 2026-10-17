import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api/client';
import { useSession } from './session';

const JAVIER = { id: 1, name: 'Javier', email: 'javier@aldebaran.com', role: 'admin' };

type Route = { status: number; body?: unknown };

/** Simula el server: cada clave es "MÉTODO /ruta". */
function mockServer(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`Ruta no simulada: ${key}`);
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  useSession.setState({ status: 'loading', error: null, appInfo: null, user: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bootstrap', () => {
  it('sin usuarios registrados no consulta la sesión', async () => {
    const fetchMock = mockServer({
      'GET /api/app-info': { status: 200, body: { mockMode: true, needsSetup: true } },
    });

    await useSession.getState().bootstrap();

    expect(useSession.getState()).toMatchObject({
      status: 'ready',
      appInfo: { mockMode: true, needsSetup: true },
      user: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('con sesión válida carga el usuario', async () => {
    mockServer({
      'GET /api/app-info': { status: 200, body: { mockMode: false, needsSetup: false } },
      'GET /api/auth/me': { status: 200, body: { user: JAVIER } },
    });

    await useSession.getState().bootstrap();

    expect(useSession.getState()).toMatchObject({ status: 'ready', user: JAVIER });
  });

  it('sin sesión queda listo y sin usuario', async () => {
    mockServer({
      'GET /api/app-info': { status: 200, body: { mockMode: false, needsSetup: false } },
      'GET /api/auth/me': { status: 401, body: { error: 'Tenés que iniciar sesión.' } },
    });

    await useSession.getState().bootstrap();

    expect(useSession.getState()).toMatchObject({ status: 'ready', user: null });
  });

  it('si el server no responde queda en error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await useSession.getState().bootstrap();

    expect(useSession.getState()).toMatchObject({
      status: 'error',
      error: 'No se pudo conectar con el servidor.',
    });
  });
});

describe('acciones de sesión', () => {
  it('setup deja al usuario logueado y marca que ya no hace falta registrarse', async () => {
    useSession.setState({ status: 'ready', appInfo: { mockMode: false, needsSetup: true } });
    mockServer({ 'POST /api/auth/setup': { status: 201, body: { user: JAVIER } } });

    await useSession.getState().setup({ name: 'Javier', email: JAVIER.email, password: '12345678' });

    expect(useSession.getState().user).toEqual(JAVIER);
    expect(useSession.getState().appInfo?.needsSetup).toBe(false);
  });

  it('login exitoso guarda el usuario', async () => {
    mockServer({ 'POST /api/auth/login': { status: 200, body: { user: JAVIER } } });

    await useSession.getState().login(JAVIER.email, '12345678');

    expect(useSession.getState().user).toEqual(JAVIER);
  });

  it('login fallido propaga el mensaje del server y no borra nada más', async () => {
    useSession.setState({ status: 'ready', appInfo: { mockMode: false, needsSetup: false } });
    mockServer({
      'POST /api/auth/login': { status: 401, body: { error: 'Email o contraseña incorrectos.' } },
    });

    await expect(useSession.getState().login(JAVIER.email, 'mal')).rejects.toThrow(
      'Email o contraseña incorrectos.',
    );
    expect(useSession.getState().user).toBeNull();
  });

  it('logout olvida al usuario, aunque la sesión ya hubiera vencido', async () => {
    useSession.setState({ user: JAVIER as never });
    mockServer({ 'POST /api/auth/logout': { status: 401, body: { error: 'Tenés que iniciar sesión.' } } });

    await useSession.getState().logout();

    expect(useSession.getState().user).toBeNull();
  });
});

describe('cliente de la API', () => {
  it('un 401 en cualquier llamada olvida al usuario (sesión vencida)', async () => {
    useSession.setState({ user: JAVIER as never });
    mockServer({ 'GET /api/clientes': { status: 401, body: { error: 'Tenés que iniciar sesión.' } } });

    await expect(api('GET', '/clientes')).rejects.toBeInstanceOf(ApiError);
    expect(useSession.getState().user).toBeNull();
  });

  it('usa un mensaje genérico si la respuesta de error no es JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 })));

    await expect(api('GET', '/app-info')).rejects.toMatchObject({
      status: 502,
      message: 'Ocurrió un error inesperado.',
    });
  });
});
