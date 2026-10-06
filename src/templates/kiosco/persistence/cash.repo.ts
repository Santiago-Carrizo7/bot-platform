import type { MoneyMovement, Prisma, PrismaClient, Purchase, StockMovement } from '@prisma/client';
import type { MoneyKind, StockReason } from '../types.js';

type Db = PrismaClient | Prisma.TransactionClient;

export class CashRepository {
  constructor(private readonly db: PrismaClient) {}

  private client(tx?: Prisma.TransactionClient): Db {
    return tx ?? this.db;
  }

  async addMovement(
    data: {
      businessId: string;
      userId: string;
      kind: MoneyKind;
      amount: number;
      concept: string;
      category?: string;
      date?: Date;
      relatedType?: string;
      relatedId?: string;
    },
    tx?: Prisma.TransactionClient
  ): Promise<MoneyMovement> {
    return this.client(tx).moneyMovement.create({
      data: {
        businessId: data.businessId,
        userId: data.userId,
        kind: data.kind,
        amount: data.amount,
        concept: data.concept.trim(),
        category: data.category?.trim() || null,
        date: data.date ?? new Date(),
        relatedType: data.relatedType,
        relatedId: data.relatedId,
      },
    });
  }

  async createPurchase(
    data: {
      businessId: string;
      userId: string;
      description: string;
      amount: number;
      currency?: string;
      productId?: string;
      quantity?: number;
      date?: Date;
    },
    tx?: Prisma.TransactionClient
  ): Promise<Purchase> {
    return this.client(tx).purchase.create({
      data: {
        businessId: data.businessId,
        userId: data.userId,
        description: data.description.trim(),
        amount: data.amount,
        currency: data.currency ?? 'ARS',
        productId: data.productId,
        quantity: data.quantity,
        date: data.date ?? new Date(),
      },
    });
  }

  async listPurchases(businessId: string, limit = 10): Promise<Purchase[]> {
    return this.db.purchase.findMany({
      where: { businessId },
      orderBy: { date: 'desc' },
      take: limit,
    });
  }

  async addStockMovement(
    data: {
      businessId: string;
      productId?: string;
      productName: string;
      quantity: number;
      reason: StockReason;
      relatedType?: string;
      relatedId?: string;
      userId: string;
    },
    tx?: Prisma.TransactionClient
  ): Promise<StockMovement> {
    return this.client(tx).stockMovement.create({
      data: {
        businessId: data.businessId,
        productId: data.productId,
        productName: data.productName,
        quantity: data.quantity,
        reason: data.reason,
        relatedType: data.relatedType,
        relatedId: data.relatedId,
        userId: data.userId,
      },
    });
  }

  async listStockMovements(businessId: string, productId: string, limit = 10): Promise<StockMovement[]> {
    return this.db.stockMovement.findMany({
      where: { businessId, productId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Suma de movimientos por tipo en un rango (caja del día/mes). */
  async getTotalsByDateRange(
    businessId: string,
    start: Date,
    end: Date
  ): Promise<{ totalIn: number; totalOut: number; countIn: number; countOut: number }> {
    const [inAgg, outAgg] = await Promise.all([
      this.db.moneyMovement.aggregate({
        where: { businessId, kind: 'IN', date: { gte: start, lte: end } },
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.db.moneyMovement.aggregate({
        where: { businessId, kind: 'OUT', date: { gte: start, lte: end } },
        _sum: { amount: true },
        _count: { id: true },
      }),
    ]);
    return {
      totalIn: inAgg._sum.amount ? Number(inAgg._sum.amount) : 0,
      totalOut: outAgg._sum.amount ? Number(outAgg._sum.amount) : 0,
      countIn: inAgg._count.id,
      countOut: outAgg._count.id,
    };
  }
}
