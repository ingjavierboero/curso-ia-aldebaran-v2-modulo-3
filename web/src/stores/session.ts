import { create } from 'zustand';
import { api, ApiError, setUnauthorizedHandler } from '../api/client';
import type { AppInfo, User } from '../api/types';

type Status = 'loading' | 'ready' | 'error';

interface SessionState {
  status: Status;
  /** Mensaje cuando no se pudo cargar la app (por ejemplo, server caído). */
  error: string | null;
  appInfo: AppInfo | null;
  user: User | null;

  /** Carga el modo de la app y, si hay sesión, el usuario actual. */
  bootstrap: () => Promise<void>;
  setup: (data: { name: string; email: string; password: string }) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Olvida al usuario sin llamar al server (la sesión ya no es válida). */
  clearUser: () => void;
}

export const useSession = create<SessionState>()((set, get) => ({
  status: 'loading',
  error: null,
  appInfo: null,
  user: null,

  async bootstrap() {
    set({ status: 'loading', error: null });
    try {
      const appInfo = await api<AppInfo>('GET', '/app-info');
      let user: User | null = null;
      if (!appInfo.needsSetup) {
        try {
          ({ user } = await api<{ user: User }>('GET', '/auth/me'));
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 401)) throw error;
        }
      }
      set({ status: 'ready', appInfo, user });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'No se pudo cargar la aplicación.',
      });
    }
  },

  async setup(data) {
    const { user } = await api<{ user: User }>('POST', '/auth/setup', data);
    const appInfo = get().appInfo;
    set({ user, appInfo: appInfo && { ...appInfo, needsSetup: false } });
  },

  async login(email, password) {
    const { user } = await api<{ user: User }>('POST', '/auth/login', { email, password });
    set({ user });
  },

  async logout() {
    try {
      await api('POST', '/auth/logout');
    } catch (error) {
      // Si la sesión ya había vencido, igual queda cerrada.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    set({ user: null });
  },

  clearUser() {
    set({ user: null });
  },
}));

setUnauthorizedHandler(() => useSession.getState().clearUser());

/** RF-10, RF-13: Admin y Editor modifican datos; Consulta solo los ve. */
export function useCanEdit(): boolean {
  return useSession((s) => s.user !== null && s.user.role !== 'consulta');
}
