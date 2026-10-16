import { defineConfig } from 'drizzle-kit';

// Solo para generar migraciones (npm run db:generate); el server las aplica al arrancar.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
