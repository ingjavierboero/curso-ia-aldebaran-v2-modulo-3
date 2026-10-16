import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  type SQLiteColumn,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const USER_ROLES = ['admin', 'editor', 'consulta'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ACTIVE_STATUSES = ['activo', 'inactivo'] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

/** CHECK que limita una columna a los valores de su enum. */
function inList(column: SQLiteColumn, values: readonly string[]) {
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull(),
    status: text('status', { enum: ACTIVE_STATUSES }).notNull().default('activo'),
    passwordHash: text('password_hash').notNull(),
    ...timestamps,
  },
  (t) => [
    // RF-15: el email no se repite, sin distinguir mayúsculas de minúsculas.
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    check('users_role_check', inList(t.role, USER_ROLES)),
    check('users_status_check', inList(t.status, ACTIVE_STATUSES)),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** Hash SHA-256 del token de sesión; el token en claro solo lo tiene el navegador. */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Base para la expiración por inactividad (RNF-10). */
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);
