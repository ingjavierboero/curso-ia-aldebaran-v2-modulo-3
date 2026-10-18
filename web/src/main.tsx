import { App as AntApp, ConfigProvider, theme } from 'antd';
import esES from 'antd/locale/es_ES';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import 'dayjs/locale/es';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useResolvedTheme } from './stores/theme';

// Fechas y horas en español, y lectura de "HH:mm" en los TimePicker.
dayjs.extend(customParseFormat);
dayjs.locale('es');

/** Aplica el tema claro u oscuro a antd y al documento (RNF-15). */
function ThemeProvider({ children }: { children: ReactNode }) {
  const resolved = useResolvedTheme();

  useEffect(() => {
    // Scrollbars, controles nativos y el fondo fuera del layout acompañan al tema.
    document.documentElement.style.colorScheme = resolved;
    document.body.style.background = resolved === 'dark' ? '#000' : '#f5f5f5';
  }, [resolved]);

  return (
    <ConfigProvider
      locale={esES}
      theme={{ algorithm: resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
