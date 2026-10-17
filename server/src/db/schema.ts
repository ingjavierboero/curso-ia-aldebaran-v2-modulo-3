import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
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
function inList(column: SQLiteColumn, values: readonly (string | number)[]) {
  const list = values.map((v) => (typeof v === 'number' ? String(v) : `'${v}'`)).join(', ');
  return sql`${column} in (${sql.raw(list)})`;
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

/**
 * RF-38: condiciones frente al IVA que ARCA admite para el receptor de una Factura C,
 * con su código.
 */
export const IVA_CONDITIONS = {
  1: 'IVA Responsable Inscripto',
  4: 'IVA Sujeto Exento',
  5: 'Consumidor Final',
  6: 'Responsable Monotributo',
  7: 'Sujeto No Categorizado',
  8: 'Proveedor del Exterior',
  9: 'Cliente del Exterior',
  10: 'IVA Liberado – Ley N° 19.640',
  13: 'Monotributista Social',
  15: 'IVA No Alcanzado',
  16: 'Monotributo Trabajador Independiente Promovido',
} as const;
export type IvaCondition = keyof typeof IVA_CONDITIONS;
export const IVA_CONDITION_CODES = Object.keys(IVA_CONDITIONS).map(Number) as IvaCondition[];

export const clients = sqliteTable(
  'clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    businessName: text('business_name').notNull(),
    /** Solo dígitos (11). */
    cuit: text('cuit').notNull(),
    /**
     * Domicilio del receptor para el PDF. La API lo exige; la columna admite null
     * porque se agregó después y no puede tener un valor por defecto razonable.
     */
    address: text('address'),
    billingEmail: text('billing_email').notNull(),
    /**
     * Código ARCA. La API lo exige, pero la columna admite null para clientes
     * registrados sin ese dato, que no se facturan (RF-82).
     */
    ivaCondition: integer('iva_condition').$type<IvaCondition>(),
    status: text('status', { enum: ACTIVE_STATUSES }).notNull().default('activo'),
    ...timestamps,
  },
  (t) => [
    // RF-40, RF-41: CUIT y email de facturación no se repiten entre clientes.
    uniqueIndex('clients_cuit_unique').on(t.cuit),
    uniqueIndex('clients_billing_email_unique').on(sql`lower(${t.billingEmail})`),
    check('clients_iva_condition_check', inList(t.ivaCondition, IVA_CONDITION_CODES)),
    check('clients_status_check', inList(t.status, ACTIVE_STATUSES)),
  ],
);

export const CLIENT_EVENT_TYPES = [
  'alta',
  'modificacion',
  'baja',
  'reactivacion',
  'asignacion_producto',
  'desasignacion_producto',
] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** Historial del cliente (RF-163). Cada feature suma sus tipos de evento. */
export const clientEvents = sqliteTable(
  'client_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    type: text('type').$type<ClientEventType>().notNull(),
    /** Datos propios del evento (por ejemplo, los campos modificados). */
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Usuario que originó el evento; null si lo originó el agente. */
    userId: integer('user_id').references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('client_events_client_id_idx').on(t.clientId, t.createdAt)],
);

export const CURRENCIES = ['ARS', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    /** Precio de la cuota mensual en centavos de su moneda (RNF-13). */
    priceCents: integer('price_cents').notNull(),
    currency: text('currency', { enum: CURRENCIES }).notNull(),
    status: text('status', { enum: ACTIVE_STATUSES }).notNull().default('activo'),
    ...timestamps,
  },
  (t) => [
    // RF-44: el precio es mayor a cero.
    check('products_price_check', sql`${t.priceCents} > 0`),
    check('products_currency_check', inList(t.currency, CURRENCIES)),
    check('products_status_check', inList(t.status, ACTIVE_STATUSES)),
  ],
);

/** Productos asignados a cada cliente (RF-49, RF-50). */
export const clientProducts = sqliteTable(
  'client_products',
  {
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.productId] }),
    index('client_products_product_id_idx').on(t.productId),
  ],
);
