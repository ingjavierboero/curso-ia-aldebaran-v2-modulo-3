import { afterEach, describe, expect, it, vi } from 'vitest';

/** Carga el store de cero con un sistema operativo y un almacenamiento simulados. */
async function loadThemeStore({ systemDark = false, stored = null as string | null } = {}) {
  const storage = new Map<string, string>(stored ? [['aldebaran.theme', stored]] : []);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  let onChange: ((e: { matches: boolean }) => void) | undefined;
  vi.stubGlobal('matchMedia', () => ({
    matches: systemDark,
    addEventListener: (_: string, cb: typeof onChange) => (onChange = cb),
  }));

  vi.resetModules();
  const mod = await import('./theme');
  const resolved = () => {
    const s = mod.useTheme.getState();
    return s.preference === 'system' ? s.systemTheme : s.preference;
  };
  return { ...mod, storage, resolved, changeSystem: (dark: boolean) => onChange?.({ matches: dark }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tema (RNF-15, AC-235)', () => {
  it('sin elección guardada sigue al sistema operativo', async () => {
    const theme = await loadThemeStore({ systemDark: true });
    expect(theme.useTheme.getState().preference).toBe('system');
    expect(theme.resolved()).toBe('dark');
  });

  it('acompaña un cambio de tema del sistema operativo', async () => {
    const theme = await loadThemeStore({ systemDark: false });
    theme.changeSystem(true);
    expect(theme.resolved()).toBe('dark');
  });

  it('la elección del usuario manda sobre el sistema y se guarda', async () => {
    const theme = await loadThemeStore({ systemDark: true });
    theme.useTheme.getState().setPreference('light');

    expect(theme.resolved()).toBe('light');
    expect(theme.storage.get('aldebaran.theme')).toBe('light');
  });

  it('recuerda la elección al volver a cargar la app', async () => {
    const theme = await loadThemeStore({ systemDark: true, stored: 'light' });
    expect(theme.resolved()).toBe('light');
  });

  it('volver a "sistema" borra la elección guardada', async () => {
    const theme = await loadThemeStore({ stored: 'dark' });
    theme.useTheme.getState().setPreference('system');
    expect(theme.storage.has('aldebaran.theme')).toBe(false);
  });

  it('ignora valores guardados inválidos y funciona sin almacenamiento', async () => {
    expect((await loadThemeStore({ stored: 'violeta' })).useTheme.getState().preference).toBe('system');

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('bloqueado');
      },
    });
    vi.resetModules();
    const mod = await import('./theme');
    expect(mod.useTheme.getState().preference).toBe('system');
    expect(() => mod.useTheme.getState().setPreference('dark')).not.toThrow();
  });
});
