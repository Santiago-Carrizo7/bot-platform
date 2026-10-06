import type { Budget, PrismaClient } from '@prisma/client';

export class BudgetRepository {
  constructor(private readonly db: PrismaClient) {}

  async upsert(
    businessId: string,
    userId: string,
    category: string,
    amount: number,
    currency = 'ARS'
  ): Promise<Budget> {
    return this.db.budget.upsert({
      where: { businessId_userId_category: { businessId, userId, category } },
      create: { businessId, userId, category, amount, currency },
      update: { amount, currency },
    });
  }

  async findByUser(businessId: string, userId: string): Promise<Budget[]> {
    return this.db.budget.findMany({ where: { businessId, userId }, orderBy: { category: 'asc' } });
  }

  async delete(id: string, businessId: string, userId: string): Promise<Budget | null> {
    const existing = await this.db.budget.findFirst({ where: { id, businessId, userId } });
    if (!existing) return null;
    return this.db.budget.delete({ where: { id } });
  }
}
