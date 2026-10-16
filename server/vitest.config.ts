import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // RNF-12: los tests corren con la misma zona horaria que el server.
    env: { TZ: 'America/Argentina/Buenos_Aires' },
  },
});
