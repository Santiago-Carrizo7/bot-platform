import type { Category, PrismaClient } from '@prisma/client';

export class CategoryRepository {
  constructor(private readonly db: PrismaClient) {}

  async seedDefaults(businessId: string, defaults: { name: string; icon: string }[]): Promise<void> {
    for (const cat of defaults) {
      await this.db.category.upsert({
        where: { businessId_name: { businessId, name: cat.name } },
        create: { businessId, name: cat.name, icon: cat.icon, isSystem: true, isActive: true },
        update: {},
      });
    }
  }

  async findActiveByBusiness(businessId: string): Promise<Category[]> {
    return this.db.category.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
  }

  async findByName(businessId: string, name: string): Promise<Category | null> {
    return this.db.category.findFirst({
      where: { businessId, name: name.trim().toLowerCase(), isActive: true },
    });
  }

  async findById(id: string, businessId: string): Promise<Category | null> {
    return this.db.category.findFirst({ where: { id, businessId } });
  }

  async create(businessId: string, data: { name: string; icon?: string }): Promise<Category> {
    return this.db.category.create({
      data: {
        businessId,
        name: data.name.trim().toLowerCase(),
        icon: data.icon?.trim(),
        isSystem: false,
        isActive: true,
      },
    });
  }

  async update(
    id: string,
    businessId: string,
    data: { name?: string; icon?: string }
  ): Promise<Category> {
    return this.db.category.update({
      where: { id },
      data: {
        ...(data.name ? { name: data.name.trim().toLowerCase() } : {}),
        ...(data.icon !== undefined ? { icon: data.icon?.trim() } : {}),
      },
    });
  }

  async deactivate(id: string, businessId: string): Promise<Category> {
    return this.db.category.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
