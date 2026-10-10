import type { Prisma, PrismaClient, RotiseriaSale, RotiseriaSaleItem } from '@prisma/client';
import type { ResolvedSaleLine } from '../types.js';

type Db = PrismaClient | Prisma.TransactionClient;
export type RotiseriaSaleWithItems = RotiseriaSale & { items: RotiseriaSaleItem[] };

export class SaleRepository {
  constructor(private readonly db: PrismaClient) {}

  private client(tx?: Prisma.TransactionClient): Db {
    return tx ?? this.db;
  }

  async create(
    businessId: string,
    userId: string,
    total: number,
    shiftDate: Date,
    lines: ResolvedSaleLine[],
    note?: string,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaSaleWithItems> {
    const run = async (c: Db) => {
      const sale = await c.rotiseriaSale.create({
        data: {
          businessId,
          userId,
          total,
          shiftDate,
          isCancelled: false,
          note: note?.trim() || null,
        },
      });

      await c.rotiseriaSaleItem.createMany({
        data: lines.map((l) => ({
          saleId: sale.id,
          productId: l.productId ?? null,
          promoId: l.promoId ?? null,
          name: l.name,
          category: l.category && l.category.trim() ? l.category.trim() : 'general',
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          subtotal: l.subtotal,
        })),
      });

      const items = await c.rotiseriaSaleItem.findMany({
        where: { saleId: sale.id },
      });

      return { ...sale, items };
    };

    if (tx) {
      return run(tx);
    }

    if ('$transaction' in this.db && typeof (this.db as any).$transaction === 'function') {
      return this.db.$transaction(async (trx) => run(trx));
    }

    return run(this.db);
  }

  async findById(id: string, businessId: string): Promise<RotiseriaSaleWithItems | null> {
    const sale = await this.db.rotiseriaSale.findFirst({
      where: { id, businessId },
    });
    if (!sale) return null;
    const items = await this.db.rotiseriaSaleItem.findMany({
      where: { saleId: sale.id },
    });
    return { ...sale, items };
  }

  async findLastActive(businessId: string): Promise<RotiseriaSaleWithItems | null> {
    const sale = await this.db.rotiseriaSale.findFirst({
      where: { businessId, isCancelled: false },
      orderBy: { createdAt: 'desc' },
    });
    if (!sale) return null;
    const items = await this.db.rotiseriaSaleItem.findMany({
      where: { saleId: sale.id },
    });
    return { ...sale, items };
  }

  async cancel(
    id: string,
    businessId: string,
    userId: string,
    reason?: string,
    now: Date = new Date(),
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaSaleWithItems> {
    const c = this.client(tx);
    const updated = await c.rotiseriaSale.update({
      where: { id },
      data: {
        isCancelled: true,
        cancelledAt: now,
        cancelledByUserId: userId,
        cancelReason: reason?.trim() || null,
      },
    });
    const items = await c.rotiseriaSaleItem.findMany({
      where: { saleId: id },
    });
    return { ...updated, items };
  }

  async listRecent(businessId: string, limit = 10): Promise<RotiseriaSaleWithItems[]> {
    const sales = await this.db.rotiseriaSale.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const items = await this.db.rotiseriaSaleItem.findMany({
      where: { saleId: { in: sales.map((s) => s.id) } },
    });
    const bySale = new Map<string, RotiseriaSaleItem[]>();
    for (const item of items) {
      const arr = bySale.get(item.saleId) ?? [];
      arr.push(item);
      bySale.set(item.saleId, arr);
    }
    return sales.map((s) => ({ ...s, items: bySale.get(s.id) ?? [] }));
  }

  async findByShiftDate(businessId: string, shiftDate: Date): Promise<RotiseriaSaleWithItems[]> {
    const sales = await this.db.rotiseriaSale.findMany({
      where: { businessId, shiftDate },
      orderBy: { createdAt: 'desc' },
    });
    const items = await this.db.rotiseriaSaleItem.findMany({
      where: { saleId: { in: sales.map((s) => s.id) } },
    });
    const bySale = new Map<string, RotiseriaSaleItem[]>();
    for (const item of items) {
      const arr = bySale.get(item.saleId) ?? [];
      arr.push(item);
      bySale.set(item.saleId, arr);
    }
    return sales.map((s) => ({ ...s, items: bySale.get(s.id) ?? [] }));
  }

  async findByDateRange(businessId: string, start: Date, end: Date): Promise<RotiseriaSaleWithItems[]> {
    const sales = await this.db.rotiseriaSale.findMany({
      where: { businessId, shiftDate: { gte: start, lte: end } },
      orderBy: { createdAt: 'desc' },
    });
    const items = await this.db.rotiseriaSaleItem.findMany({
      where: { saleId: { in: sales.map((s) => s.id) } },
    });
    const bySale = new Map<string, RotiseriaSaleItem[]>();
    for (const item of items) {
      const arr = bySale.get(item.saleId) ?? [];
      arr.push(item);
      bySale.set(item.saleId, arr);
    }
    return sales.map((s) => ({ ...s, items: bySale.get(s.id) ?? [] }));
  }

  async findAll(businessId: string): Promise<RotiseriaSaleWithItems[]> {
    const sales = await this.db.rotiseriaSale.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    });
    const items = await this.db.rotiseriaSaleItem.findMany({
      where: { saleId: { in: sales.map((s) => s.id) } },
    });
    const bySale = new Map<string, RotiseriaSaleItem[]>();
    for (const item of items) {
      const arr = bySale.get(item.saleId) ?? [];
      arr.push(item);
      bySale.set(item.saleId, arr);
    }
    return sales.map((s) => ({ ...s, items: bySale.get(s.id) ?? [] }));
  }
}
