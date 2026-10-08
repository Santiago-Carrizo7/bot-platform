import type { MoneyMovement, Prisma, PrismaClient } from '@prisma/client';
import type { MoneyKind } from '../types.js';

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

  /**
   * Busca y elimina el último movimiento registrado por este usuario en este negocio.
   * Usado para la acción "Deshacer" en modo continuo o tras un registro erróneo.
   */
  async undoLastMovement(businessId: string, userId: string): Promise<MoneyMovement | null> {
    const last = await this.db.moneyMovement.findFirst({
      where: { businessId, userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!last) return null;

    await this.db.moneyMovement.delete({
      where: { id: last.id },
    });
    return last;
  }

  async listRecent(businessId: string, limit = 10): Promise<MoneyMovement[]> {
    return this.db.moneyMovement.findMany({
      where: { businessId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }

  /** Suma y conteo de movimientos por tipo (IN/OUT) en un rango de fechas. */
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

  /** Desglose de gastos por categoría en un rango de fechas. */
  async getExpensesByCategory(
    businessId: string,
    start: Date,
    end: Date
  ): Promise<Array<{ category: string; total: number; count: number }>> {
    const groups = await this.db.moneyMovement.groupBy({
      by: ['category'],
      where: { businessId, kind: 'OUT', date: { gte: start, lte: end } },
      _sum: { amount: true },
      _count: { id: true },
    });

    return groups.map((g) => ({
      category: g.category ?? 'Otros',
      total: g._sum.amount ? Number(g._sum.amount) : 0,
      count: g._count.id,
    }));
  }
}
