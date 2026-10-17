import { create } from 'zustand';

/** RNF-15: tema elegido por el usuario; "system" sigue al sistema operativo. */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'aldebaran.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeState {
  preference: ThemePreference;
  /** Tema del sistema operativo en este momento. */
  systemTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function savePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Sin almacenamiento disponible (por ejemplo, modo privado): la elección dura la sesión.
  }
}

function readSystemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export const useTheme = create<ThemeState>()((set) => ({
  preference: readPreference(),
  systemTheme: readSystemTheme(),
  setPreference(preference) {
    savePreference(preference);
    set({ preference });
  },
}));

// Si el usuario cambia el tema del sistema operativo, la app lo sigue al instante.
if (typeof matchMedia === 'function') {
  matchMedia(DARK_QUERY).addEventListener('change', (event) => {
    useTheme.setState({ systemTheme: event.matches ? 'dark' : 'light' });
  });
}

/** Tema que se aplica: el elegido, o el del sistema si no se eligió ninguno. */
export function useResolvedTheme(): ResolvedTheme {
  return useTheme((s) => (s.preference === 'system' ? s.systemTheme : s.preference));
}
