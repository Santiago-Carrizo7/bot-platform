import type { Prisma, PrismaClient, Sale, SaleItem } from '@prisma/client';
import type { ResolvedSaleLine } from '../types.js';

type Db = PrismaClient | Prisma.TransactionClient;
export type SaleWithItems = Sale & { items: SaleItem[] };

export class SaleRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(
    businessId: string,
    userId: string,
    total: number,
    lines: ResolvedSaleLine[],
    note: string | undefined,
    currency: string,
    tx: Prisma.TransactionClient
  ): Promise<SaleWithItems> {
    const sale = await tx.sale.create({
      data: { businessId, userId, total, currency, note: note?.trim() || null },
    });
    await tx.saleItem.createMany({
      data: lines.map((l) => ({
        saleId: sale.id,
        productId: l.productId,
        productName: l.productName,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        subtotal: l.subtotal,
      })),
    });
    const items = await tx.saleItem.findMany({ where: { saleId: sale.id } });
    return { ...sale, items };
  }

  async listRecent(businessId: string, limit = 10): Promise<SaleWithItems[]> {
    const sales = await this.db.sale.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const items = await this.db.saleItem.findMany({
      where: { saleId: { in: sales.map((s) => s.id) } },
    });
    const bySale = new Map<string, SaleItem[]>();
    for (const item of items) {
      const arr = bySale.get(item.saleId) ?? [];
      arr.push(item);
      bySale.set(item.saleId, arr);
    }
    return sales.map((s) => ({ ...s, items: bySale.get(s.id) ?? [] }));
  }

  async findById(id: string, businessId: string): Promise<SaleWithItems | null> {
    const sale = await this.db.sale.findFirst({ where: { id, businessId } });
    if (!sale) return null;
    const items = await this.db.saleItem.findMany({ where: { saleId: sale.id } });
    return { ...sale, items };
  }

  /** Total vendido en un rango (para resúmenes). */
  async getTotalByDateRange(businessId: string, start: Date, end: Date): Promise<{ total: number; count: number }> {
    const agg = await (this.db as Db).sale.aggregate({
      where: { businessId, createdAt: { gte: start, lte: end } },
      _sum: { total: true },
      _count: { id: true },
    });
    return { total: agg._sum.total ? Number(agg._sum.total) : 0, count: agg._count.id };
  }
}
