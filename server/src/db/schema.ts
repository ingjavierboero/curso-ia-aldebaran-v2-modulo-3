import { sql } from 'drizzle-orm';
import {
  blob,
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
  'factura_generada',
  'email_enviado',
  'email_recibido',
  'clasificacion_email',
  'error_proceso',
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

/** RF-65: cada cotización del dólar blue venta leída, con su fuente y fecha de lectura. */
export const exchangeRates = sqliteTable(
  'exchange_rates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Pesos por dólar, en centavos (RNF-13): $1.555,50 → 155550. */
    rateCents: integer('rate_cents').notNull(),
    source: text('source').notNull(),
    readAt: integer('read_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    check('exchange_rates_rate_check', sql`${t.rateCents} > 0`),
    index('exchange_rates_read_at_idx').on(t.readAt),
  ],
);

/**
 * Ticket de acceso de WSAA vigente por servicio. Se guarda porque WSAA rechaza
 * emitir uno nuevo mientras el anterior siga vigente (dura unas 12 h).
 */
export const arcaAccessTickets = sqliteTable('arca_access_tickets', {
  service: text('service').primaryKey(),
  token: text('token').notNull(),
  sign: text('sign').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * Comprobantes autorizados por el ARCA simulado del modo mock (RF-186). Cumple el
 * papel de la base de ARCA: numeración por punto de venta y consulta de comprobantes.
 */
export const mockArcaVouchers = sqliteTable(
  'mock_arca_vouchers',
  {
    pointOfSale: integer('point_of_sale').notNull(),
    voucherType: integer('voucher_type').notNull(),
    number: integer('number').notNull(),
    cae: text('cae').notNull(),
    /** YYYY-MM-DD */
    caeDueDate: text('cae_due_date').notNull(),
    issueDate: text('issue_date').notNull(),
    receiverCuit: text('receiver_cuit').notNull(),
    totalCents: integer('total_cents').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.pointOfSale, t.voucherType, t.number] })],
);

/**
 * Configuración del sistema (RF-91 y "Configuración" en el PRD). Una sola fila (id 1)
 * con los valores por defecto del PRD.
 */
export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey(),
    /** RF-99, RF-100: minutos entre revisiones de la casilla (5 a 60). */
    mailboxIntervalMinutes: integer('mailbox_interval_minutes').notNull().default(15),
    /** RF-51, RF-62: hora de facturación del día 15, "HH:MM". */
    billingTime: text('billing_time').notNull().default('11:00'),
    /** RF-149, RF-152: hora de los recordatorios del último día del mes, "HH:MM". */
    reminderTime: text('reminder_time').notNull().default('11:00'),
    /** RF-171, RF-172: reintentos de una operación automática (0 a 10). */
    retryCount: integer('retry_count').notNull().default(3),
    /** RF-171, RF-173: minutos de espera entre reintentos (1 a 60). */
    retryWaitMinutes: integer('retry_wait_minutes').notNull().default(5),
    /** RF-72, RF-73: punto de venta de ARCA (1 a 99999). */
    pointOfSale: integer('point_of_sale').notNull().default(1),
    // RF-91: datos de la empresa emisora.
    issuerBusinessName: text('issuer_business_name'),
    /** RF-215: nombre con el que se firman los emails; no va en el PDF. */
    issuerTradeName: text('issuer_trade_name'),
    issuerAddress: text('issuer_address'),
    issuerIvaCondition: text('issuer_iva_condition'),
    issuerGrossIncomeNumber: text('issuer_gross_income_number'),
    /** YYYY-MM-DD */
    issuerActivityStartDate: text('issuer_activity_start_date'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [check('settings_single_row', sql`${t.id} = 1`)],
);

/** Estado del proceso de facturación de cada período (RF-52 a RF-61). */
export const billingPeriods = sqliteTable('billing_periods', {
  /** "YYYY-MM" */
  period: text('period').primaryKey(),
  /** RF-54: cancelación por un Admin; null si no está cancelado. */
  cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
  cancelledBy: integer('cancelled_by').references(() => users.id),
  /** Inicio del proceso; null si nunca empezó. */
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  /** Usuario que ejecutó "Facturar ahora"; null si lo inició el agente. */
  startedBy: integer('started_by').references(() => users.id),
  /** Se intentó facturar a todos los clientes facturables (RF-61). */
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

export const INVOICE_STATUSES = ['pendiente_pago', 'pago_recibido', 'revision_manual', 'pagada'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Factura C autorizada por ARCA. Guarda una copia de los datos del cliente y de la
 * cotización al momento de facturar, para que las facturas emitidas no cambien.
 */
export const invoices = sqliteTable(
  'invoices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    /** Período facturado, "YYYY-MM". */
    period: text('period').notNull(),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('pendiente_pago'),
    /** RF-138: motivo, solo mientras está en Revisión manual. */
    reviewReason: text('review_reason'),
    voucherType: integer('voucher_type').notNull(),
    pointOfSale: integer('point_of_sale').notNull(),
    number: integer('number').notNull(),
    cae: text('cae').notNull(),
    // Fechas en YYYY-MM-DD (hora de Argentina).
    caeDueDate: text('cae_due_date').notNull(),
    issueDate: text('issue_date').notNull(),
    serviceFrom: text('service_from').notNull(),
    serviceTo: text('service_to').notNull(),
    paymentDueDate: text('payment_due_date').notNull(),
    totalCents: integer('total_cents').notNull(),
    // Copia del receptor al momento de facturar (RF-78).
    clientBusinessName: text('client_business_name').notNull(),
    clientCuit: text('client_cuit').notNull(),
    clientAddress: text('client_address'),
    clientIvaCondition: integer('client_iva_condition').notNull(),
    // Cotización usada si algún ítem estaba en dólares (RF-63, RF-93).
    exchangeRateId: integer('exchange_rate_id').references(() => exchangeRates.id),
    exchangeRateCents: integer('exchange_rate_cents'),
    exchangeRateSource: text('exchange_rate_source'),
    exchangeRateReadAt: integer('exchange_rate_read_at', { mode: 'timestamp_ms' }),
    /** RF-67: se usó la última cotización registrada porque no se pudo leer. */
    exchangeRateFallback: integer('exchange_rate_fallback', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('invoices_client_period_idx').on(t.clientId, t.period),
    index('invoices_status_idx').on(t.status),
    uniqueIndex('invoices_voucher_unique').on(t.voucherType, t.pointOfSale, t.number),
    check('invoices_status_check', inList(t.status, INVOICE_STATUSES)),
    check('invoices_total_check', sql`${t.totalCents} > 0`),
  ],
);

/** Detalle de cada cuota facturada (copia del producto al facturar, AC-45, AC-46). */
export const invoiceItems = sqliteTable('invoice_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceId: integer('invoice_id')
    .notNull()
    .references(() => invoices.id),
  productId: integer('product_id').references(() => products.id),
  description: text('description').notNull(),
  /** Moneda y precio originales del producto. */
  currency: text('currency', { enum: CURRENCIES }).notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  /** Importe facturado en pesos (convertido si era en dólares, RF-64). */
  amountCents: integer('amount_cents').notNull(),
});

/**
 * Intento de generación en curso: el número que se le pidió a ARCA y el detalle que se
 * facturó. Permite no emitir dos comprobantes para la misma factura si ARCA autorizó
 * pero la respuesta no llegó (RF-75, RF-76). Se borra al registrar la factura.
 */
export const invoiceAttempts = sqliteTable(
  'invoice_attempts',
  {
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    period: text('period').notNull(),
    pointOfSale: integer('point_of_sale').notNull(),
    pendingNumber: integer('pending_number').notNull(),
    /** Ítems, total y cotización del intento (JSON). */
    payload: text('payload', { mode: 'json' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.period] })],
);

export const PROCESS_OPERATIONS = [
  'generacion_factura',
  'envio_factura',
  'envio_recordatorio',
  'revision_casilla',
] as const;
export type ProcessOperation = (typeof PROCESS_OPERATIONS)[number];

/** RF-174: operación automática que siguió fallando después del último reintento. */
export const processErrors = sqliteTable(
  'process_errors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    operation: text('operation', { enum: PROCESS_OPERATIONS }).notNull(),
    status: text('status', { enum: ['pendiente', 'resuelto'] }).notNull().default('pendiente'),
    clientId: integer('client_id').references(() => clients.id),
    period: text('period'),
    invoiceId: integer('invoice_id').references(() => invoices.id),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    resolvedBy: integer('resolved_by').references(() => users.id),
  },
  (t) => [
    index('process_errors_status_idx').on(t.status),
    check('process_errors_operation_check', inList(t.operation, PROCESS_OPERATIONS)),
  ],
);

/**
 * Casilla simulada del modo mock (RF-196 a RF-203): guarda los emails que el sistema
 * envía y los recibidos que carga un usuario. Fuera del modo mock no se usa.
 */
export const mockMailboxEmails = sqliteTable(
  'mock_mailbox_emails',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    direction: text('direction', { enum: ['enviado', 'recibido'] }).notNull(),
    messageId: text('message_id').notNull(),
    from: text('from').notNull(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    html: text('html'),
    /** Fecha de envío o, para los recibidos, de carga (RF-201). */
    date: integer('date', { mode: 'timestamp_ms' }).notNull(),
    /** Usuario que cargó un email recibido. */
    createdBy: integer('created_by').references(() => users.id),
  },
  (t) => [uniqueIndex('mock_mailbox_message_id_unique').on(t.messageId), index('mock_mailbox_date_idx').on(t.date)],
);

export const mockMailboxAttachments = sqliteTable('mock_mailbox_attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  emailId: integer('email_id')
    .notNull()
    .references(() => mockMailboxEmails.id),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  /** Imagen embebida en el cuerpo (RF-116), no un adjunto. */
  inline: integer('inline', { mode: 'boolean' }).notNull().default(false),
  content: blob('content', { mode: 'buffer' }).notNull(),
});

/**
 * Emails recibidos en la casilla del sistema (o en la simulada). Cada uno entra una sola
 * vez, identificado por su Message-ID (RF-109). Los pasos siguientes completan a qué
 * cliente corresponde y el resultado de su procesamiento.
 */
export const receivedEmails = sqliteTable(
  'received_emails',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: text('message_id').notNull(),
    /** Dirección del remitente en minúsculas (RF-112). */
    from: text('from').notNull(),
    fromName: text('from_name'),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
    ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).notNull(),
    /** Cliente cuyo email de facturación coincide con el remitente (RF-111). */
    clientId: integer('client_id').references(() => clients.id),
    /** RF-113: aviso (remitente que no es un cliente), Pendiente hasta que se revisa (RF-148). */
    notice: text('notice', { enum: ['pendiente', 'revisado'] }),
    noticeReviewedAt: integer('notice_reviewed_at', { mode: 'timestamp_ms' }),
    noticeReviewedBy: integer('notice_reviewed_by').references(() => users.id),
    /**
     * RF-123: clasificación del email con adjuntos válidos, a partir de la de sus
     * adjuntos; null si no tiene ninguno (RF-115) o es un aviso.
     */
    classification: text('classification', { enum: ['si', 'no', 'dudoso', 'erroneo'] }),
    /** Terminó de procesarse; null mientras falta (se retoma en la siguiente revisión). */
    processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('received_emails_message_id_unique').on(t.messageId),
    index('received_emails_received_at_idx').on(t.receivedAt),
    index('received_emails_client_idx').on(t.clientId),
  ],
);

export const receivedAttachments = sqliteTable('received_attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  emailId: integer('email_id')
    .notNull()
    .references(() => receivedEmails.id),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  /** Imagen embebida en el cuerpo (RF-116). */
  inline: integer('inline', { mode: 'boolean' }).notNull(),
  /** Es un adjunto a procesar: imagen o PDF y no embebido (RF-116, RF-117). */
  valid: integer('valid', { mode: 'boolean' }).notNull(),
  content: blob('content', { mode: 'buffer' }).notNull(),
  /** RF-119: clasificación del LLM; null si no se clasificó o el procesamiento fue erróneo. */
  classification: text('classification', { enum: ['si', 'no', 'dudoso'] }),
  /** RNF-02: el procesamiento falló después de los reintentos. */
  processingError: text('processing_error'),
  /** RF-120 a RF-122: CUIT del ordenante (11 dígitos) o null si no se pudo extraer. */
  extractedCuit: text('extracted_cuit'),
  /** RF-120: monto pagado como decimal con punto ("15000.50"), o null si no se pudo extraer. */
  extractedAmount: text('extracted_amount'),
});

/** Estado de la revisión de la casilla (una sola fila). */
export const mailboxState = sqliteTable(
  'mailbox_state',
  {
    id: integer('id').primaryKey(),
    /** Inicio de la última revisión exitosa: la siguiente lee desde acá (RF-101, RF-108). */
    lastCheckStartedAt: integer('last_check_started_at', { mode: 'timestamp_ms' }),
  },
  (t) => [check('mailbox_state_single_row', sql`${t.id} = 1`)],
);
