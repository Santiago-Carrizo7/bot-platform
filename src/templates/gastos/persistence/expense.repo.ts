import type { Expense, PrismaClient } from '@prisma/client';
import type { CreateExpenseData } from '../types.js';

export interface ExpenseFindOptions {
  skip?: number;
  take?: number;
  startDate?: Date;
  endDate?: Date;
  category?: string;
  search?: string;
}

export interface ExpenseAggregatedTotal {
  total: number;
  count: number;
}

export interface CategoryBreakdown {
  category: string;
  total: number;
  count: number;
}

/** Repositorio scropeado por negocio: todo método exige businessId. */
export class ExpenseRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: CreateExpenseData): Promise<Expense> {
    return this.db.expense.create({
      data: {
        businessId: data.businessId,
        userId: data.userId,
        amount: data.amount,
        description: data.description,
        category: data.category.toLowerCase().trim(),
        categoryId: data.categoryId,
        date: data.date,
        installments: data.installments ?? 1,
        currency: data.currency ?? 'ARS',
      },
    });
  }

  async findById(id: string, businessId: string): Promise<Expense | null> {
    return this.db.expense.findFirst({ where: { id, businessId } });
  }

  async findLast(businessId: string, limit = 5): Promise<Expense[]> {
    return this.db.expense.findMany({
      where: { businessId },
      orderBy: { date: 'desc' },
      take: limit,
    });
  }

  async findMany(businessId: string, options: ExpenseFindOptions = {}): Promise<Expense[]> {
    const { skip, take = 50, startDate, endDate, category, search } = options;
    return this.db.expense.findMany({
      where: {
        businessId,
        ...(category ? { category: category.toLowerCase().trim() } : {}),
        ...(search ? { description: { contains: search.trim(), mode: 'insensitive' } } : {}),
        ...(startDate || endDate
          ? { date: { ...(startDate ? { gte: startDate } : {}), ...(endDate ? { lte: endDate } : {}) } }
          : {}),
      },
      orderBy: { date: 'desc' },
      skip,
      take,
    });
  }

  async update(
    id: string,
    businessId: string,
    data: Partial<Omit<CreateExpenseData, 'businessId' | 'userId'>>
  ): Promise<Expense | null> {
    const existing = await this.findById(id, businessId);
    if (!existing) return null;
    return this.db.expense.update({
      where: { id },
      data: {
        ...(data.amount !== undefined ? { amount: data.amount } : {}),
        ...(data.description !== undefined ? { description: data.description.trim() } : {}),
        ...(data.category !== undefined ? { category: data.category.toLowerCase().trim() } : {}),
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
        ...(data.date !== undefined ? { date: data.date } : {}),
        ...(data.installments !== undefined ? { installments: data.installments } : {}),
        ...(data.currency !== undefined ? { currency: data.currency } : {}),
      },
    });
  }

  async delete(id: string, businessId: string): Promise<Expense | null> {
    const existing = await this.findById(id, businessId);
    if (!existing) return null;
    return this.db.expense.delete({ where: { id } });
  }

  async getTotalByDateRange(
    businessId: string,
    startDate: Date,
    endDate: Date,
    userId?: string
  ): Promise<ExpenseAggregatedTotal> {
    const aggregate = await this.db.expense.aggregate({
      where: { businessId, ...(userId ? { userId } : {}), date: { gte: startDate, lte: endDate } },
      _sum: { amount: true },
      _count: { id: true },
    });
    return {
      total: aggregate._sum.amount ? Number(aggregate._sum.amount) : 0,
      count: aggregate._count.id,
    };
  }

  /** Desglose por categoría en UNA sola query (evita traer filas a memoria). */
  async getBreakdownByDateRange(
    businessId: string,
    startDate: Date,
    endDate: Date,
    userId?: string
  ): Promise<CategoryBreakdown[]> {
    const groups = await this.db.expense.groupBy({
      by: ['category'],
      where: { businessId, ...(userId ? { userId } : {}), date: { gte: startDate, lte: endDate } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return groups.map((g) => ({
      category: g.category,
      total: g._sum.amount ? Number(g._sum.amount) : 0,
      count: g._count._all,
    }));
  }
}
