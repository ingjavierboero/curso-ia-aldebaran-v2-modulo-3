import { randomInt } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { mockArcaVouchers } from '../db/schema.js';
import {
  ArcaError,
  VOUCHER_TYPE_FACTURA_C,
  type ArcaClient,
  type AuthorizedVoucher,
  type VoucherRequest,
} from './types.js';

/** RF-186: el CAE ficticio vence 10 días después de la fecha de emisión. */
const CAE_VALIDITY_DAYS = 10;

/**
 * ARCA simulado del modo mock (RF-185, RF-186): no se conecta a ARCA y autoriza
 * todas las facturas con numeración correlativa por punto de venta, igual que ARCA.
 */
export class MockArcaClient implements ArcaClient {
  constructor(private readonly db: Db) {}

  async lastAuthorizedNumber(pointOfSale: number): Promise<number> {
    const last = this.db
      .select({ number: mockArcaVouchers.number })
      .from(mockArcaVouchers)
      .where(
        and(eq(mockArcaVouchers.pointOfSale, pointOfSale), eq(mockArcaVouchers.voucherType, VOUCHER_TYPE_FACTURA_C)),
      )
      .orderBy(desc(mockArcaVouchers.number))
      .get();
    return last?.number ?? 0;
  }

  async getVoucher(pointOfSale: number, number: number): Promise<AuthorizedVoucher | null> {
    const row = this.db
      .select()
      .from(mockArcaVouchers)
      .where(
        and(
          eq(mockArcaVouchers.pointOfSale, pointOfSale),
          eq(mockArcaVouchers.voucherType, VOUCHER_TYPE_FACTURA_C),
          eq(mockArcaVouchers.number, number),
        ),
      )
      .get();
    return row ? toVoucher(row) : null;
  }

  async authorize(request: VoucherRequest): Promise<AuthorizedVoucher> {
    // Como ARCA: el número tiene que ser el siguiente al último autorizado.
    const expected = (await this.lastAuthorizedNumber(request.pointOfSale)) + 1;
    if (request.number !== expected) {
      throw new ArcaError(
        `ARCA simulado rechazó la factura ${request.pointOfSale}-${request.number}: ` +
          `el próximo número a autorizar es ${expected}.`,
      );
    }

    const row = this.db
      .insert(mockArcaVouchers)
      .values({
        pointOfSale: request.pointOfSale,
        voucherType: VOUCHER_TYPE_FACTURA_C,
        number: request.number,
        cae: fakeCae(),
        caeDueDate: addDays(request.issueDate, CAE_VALIDITY_DAYS),
        issueDate: request.issueDate,
        receiverCuit: request.receiverCuit,
        totalCents: request.totalCents,
      })
      .returning()
      .get();
    return toVoucher(row);
  }
}

function toVoucher(row: typeof mockArcaVouchers.$inferSelect): AuthorizedVoucher {
  return {
    pointOfSale: row.pointOfSale,
    number: row.number,
    cae: row.cae,
    caeDueDate: row.caeDueDate,
    issueDate: row.issueDate,
    receiverCuit: row.receiverCuit,
    totalCents: row.totalCents,
  };
}

/** CAE ficticio de 14 dígitos (RF-186). */
function fakeCae(): string {
  return String(randomInt(10_000_000, 100_000_000)) + String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** "2026-10-15" + 10 → "2026-10-25". Opera en UTC para no depender de la zona horaria. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
