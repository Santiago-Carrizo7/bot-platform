import type { Expense } from '@prisma/client';
import { AppError, NotFoundError } from '../../../core/errors/errors.js';
import { ExpenseRepository, type ExpenseFindOptions } from '../persistence/expense.repo.js';
import { CategoryService } from './category.service.js';
import { MONTH_NAMES, type MonthlyTotal } from '../types.js';

export interface CreateManualExpenseDTO {
  amount: number;
  description: string;
  category: string;
  date?: string | Date;
  installments?: number;
  currency?: string;
}

export class ExpenseService {
  constructor(
    private readonly expenses: ExpenseRepository,
    private readonly categories: CategoryService
  ) {}

  async create(
    businessId: string,
    actorUserId: string,
    data: CreateManualExpenseDTO,
    now: Date = new Date()
  ): Promise<Expense> {
    if (data.amount <= 0) throw new AppError('El monto debe ser mayor a 0');
    if (!data.description.trim()) throw new AppError('La descripción no puede estar vacía');

    const { name: category, id: categoryId } = await this.categories.normalizeOrFallback(
      businessId,
      data.category
    );

    return this.expenses.create({
      businessId,
      userId: actorUserId,
      amount: data.amount,
      description: data.description.trim(),
      category,
      categoryId,
      date: toUtcNoon(data.date) ?? now,
      installments: data.installments ?? 1,
      currency: data.currency ?? 'ARS',
    });
  }

  async getExpense(businessId: string, id: string): Promise<Expense> {
    const expense = await this.expenses.findById(id, businessId);
    if (!expense) throw new NotFoundError('Gasto no encontrado');
    return expense;
  }

  /** Solo el autor o un OWNER pueden modificar/eliminar. */
  async updateExpense(
    businessId: string,
    requesterUserId: string,
    requesterIsOwner: boolean,
    id: string,
    data: Partial<CreateManualExpenseDTO>
  ): Promise<Expense> {
    const existing = await this.getExpense(businessId, id);
    if (existing.userId !== requesterUserId && !requesterIsOwner) {
      throw new AppError('Solo quien registró el gasto (o el dueño) puede modificarlo');
    }
    if (data.amount !== undefined && data.amount <= 0) {
      throw new AppError('El monto debe ser mayor a 0');
    }
    if (data.description !== undefined && !data.description.trim()) {
      throw new AppError('La descripción no puede estar vacía');
    }

    let category: string | undefined;
    let categoryId: string | undefined;
    if (data.category !== undefined) {
      const resolved = await this.categories.normalizeOrFallback(businessId, data.category);
      category = resolved.name;
      categoryId = resolved.id;
    }

    const updated = await this.expenses.update(id, businessId, {
      amount: data.amount,
      description: data.description?.trim(),
      category,
      categoryId,
      date: data.date ? (toUtcNoon(data.date) ?? undefined) : undefined,
      installments: data.installments,
      currency: data.currency,
    });
    if (!updated) throw new AppError('No se pudo actualizar el gasto');
    return updated;
  }

  async deleteExpense(
    businessId: string,
    requesterUserId: string,
    requesterIsOwner: boolean,
    id: string
  ): Promise<void> {
    const existing = await this.getExpense(businessId, id);
    if (existing.userId !== requesterUserId && !requesterIsOwner) {
      throw new AppError('Solo quien registró el gasto (o el dueño) puede eliminarlo');
    }
    const deleted = await this.expenses.delete(id, businessId);
    if (!deleted) throw new NotFoundError('Gasto no encontrado');
  }

  async listExpenses(businessId: string, options: ExpenseFindOptions = {}): Promise<Expense[]> {
    return this.expenses.findMany(businessId, options);
  }

  async getLastExpenses(businessId: string, limit = 5): Promise<Expense[]> {
    return this.expenses.findLast(businessId, limit);
  }

  async getCurrentMonthTotal(businessId: string, referenceDate: Date = new Date()): Promise<MonthlyTotal> {
    const { startDate, endDate, month, year } = monthRange(referenceDate);
    const aggregate = await this.expenses.getTotalByDateRange(businessId, startDate, endDate);
    return { total: aggregate.total, count: aggregate.count, monthName: MONTH_NAMES[month], year };
  }

  async getMonthlySummary(businessId: string, referenceDate: Date = new Date()) {
    const { startDate, endDate, month, year } = monthRange(referenceDate);
    const [breakdown, aggregate] = await Promise.all([
      this.expenses.getBreakdownByDateRange(businessId, startDate, endDate),
      this.expenses.getTotalByDateRange(businessId, startDate, endDate),
    ]);
    const categories: Record<string, { total: number; count: number }> = {};
    for (const row of breakdown) {
      categories[row.category] = { total: row.total, count: row.count };
    }
    return { year, month: month + 1, monthName: MONTH_NAMES[month], total: aggregate.total, count: aggregate.count, categories };
  }

  async getMonthlyHistory(businessId: string, monthsCount = 6) {
    const now = new Date();
    const history = [];
    for (let i = monthsCount - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
      const { startDate, endDate, month, year } = monthRange(d);
      const aggregate = await this.expenses.getTotalByDateRange(businessId, startDate, endDate);
      history.push({ year, month: month + 1, monthName: MONTH_NAMES[month], total: aggregate.total, count: aggregate.count });
    }
    return history;
  }
}

function monthRange(referenceDate: Date) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  return {
    year,
    month,
    startDate: new Date(Date.UTC(year, month, 1, 0, 0, 0)),
    endDate: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
  };
}

/** Normaliza "YYYY-MM-DD" al mediodía UTC (evita corrimientos por timezone). */
export function toUtcNoon(value: string | Date | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}
