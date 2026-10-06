import type { Budget } from '@prisma/client';
import { AppError } from '../../../core/errors/errors.js';
import { ExpenseRepository } from '../persistence/expense.repo.js';
import { BudgetRepository } from '../persistence/budget.repo.js';
import { CategoryService } from './category.service.js';

export interface BudgetProgress {
  id: string;
  category: string;
  budgetAmount: number;
  spentAmount: number;
  remainingAmount: number;
  percentageUsed: number;
  isExceeded: boolean;
  currency: string;
}

export class BudgetService {
  constructor(
    private readonly budgets: BudgetRepository,
    private readonly expenses: ExpenseRepository,
    private readonly categories: CategoryService
  ) {}

  async setBudget(
    businessId: string,
    userId: string,
    category: string,
    amount: number,
    currency = 'ARS'
  ): Promise<Budget> {
    if (amount <= 0) throw new AppError('El monto del presupuesto debe ser mayor a 0');
    const normalized = category.toLowerCase().trim();
    const allowed = await this.categories.getBusinessCategoryNames(businessId);
    if (!allowed.includes(normalized)) {
      throw new AppError(`La categoría "${normalized}" no existe en este negocio.`);
    }
    return this.budgets.upsert(businessId, userId, normalized, amount, currency);
  }

  async getBudgets(businessId: string, userId: string): Promise<Budget[]> {
    return this.budgets.findByUser(businessId, userId);
  }

  async getBudgetsWithProgress(
    businessId: string,
    userId: string,
    referenceDate: Date = new Date()
  ): Promise<BudgetProgress[]> {
    const budgets = await this.budgets.findByUser(businessId, userId);
    if (budgets.length === 0) return [];

    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth();
    const startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

    // Un solo groupBy por rango (gastado por categoría de ESTE usuario) + cálculo en memoria.
    const breakdown = await this.expenses.getBreakdownByDateRange(businessId, startDate, endDate, userId);
    const spentByCategory = new Map(breakdown.map((b) => [b.category, b.total]));

    return budgets.map((b) => {
      const spent = spentByCategory.get(b.category) ?? 0;
      const budgetAmount = Number(b.amount);
      const remainingAmount = budgetAmount - spent;
      return {
        id: b.id,
        category: b.category,
        budgetAmount,
        spentAmount: spent,
        remainingAmount,
        percentageUsed: budgetAmount > 0 ? Math.round((spent / budgetAmount) * 100) : 0,
        isExceeded: spent > budgetAmount,
        currency: b.currency,
      };
    });
  }

  async deleteBudget(businessId: string, userId: string, id: string): Promise<void> {
    const deleted = await this.budgets.delete(id, businessId, userId);
    if (!deleted) throw new AppError('Presupuesto no encontrado');
  }
}
