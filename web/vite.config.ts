import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // El .env vive en la raíz del repo; de ahí sale el PORT del server.
  const env = loadEnv(mode, '..', '');
  const serverPort = process.env.PORT ?? env.PORT ?? 3000;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': `http://localhost:${serverPort}`,
      },
    },
  };
});
