import type { Category } from '@prisma/client';
import { AppError } from '../../../core/errors/errors.js';
import { logger } from '../../../core/logging/logger.js';
import { CategoryRepository } from '../persistence/category.repo.js';
import { DEFAULT_CATEGORY_NAMES, SYSTEM_CATEGORIES } from '../types.js';

export class CategoryService {
  constructor(private readonly categories: CategoryRepository) {}

  /** Semillas del negocio (categorías del sistema). Idempotente. */
  async seedBusiness(businessId: string): Promise<void> {
    await this.categories.seedDefaults(businessId, [...SYSTEM_CATEGORIES]);
  }

  async getBusinessCategories(businessId: string): Promise<Category[]> {
    return this.categories.findActiveByBusiness(businessId);
  }

  async getBusinessCategoryNames(businessId: string): Promise<string[]> {
    const categories = await this.categories.findActiveByBusiness(businessId);
    if (categories.length === 0) return [...DEFAULT_CATEGORY_NAMES];
    return categories.map((c) => c.name.toLowerCase());
  }

  async findByName(businessId: string, name: string): Promise<Category | null> {
    return this.categories.findByName(businessId, name);
  }

  /** Normaliza la categoría contra el catálogo; fallback seguro a "otros". */
  async normalizeOrFallback(businessId: string, raw: string): Promise<{ name: string; id?: string }> {
    const normalized = raw.toLowerCase().trim();
    const allowed = await this.getBusinessCategoryNames(businessId);
    if (allowed.includes(normalized)) {
      const cat = await this.findByName(businessId, normalized);
      return { name: normalized, id: cat?.id };
    }
    logger.warn(`Categoría "${normalized}" fuera del catálogo. Fallback a "otros".`, { businessId });
    const fallbackName = allowed.includes('otros') ? 'otros' : (allowed[0] ?? 'otros');
    const fallback = await this.findByName(businessId, fallbackName);
    return { name: fallbackName, id: fallback?.id };
  }

  async createCustom(businessId: string, name: string, icon?: string): Promise<Category> {
    const normalized = name.trim().toLowerCase();
    if (!normalized) throw new AppError('El nombre de la categoría no puede estar vacío');
    const existing = await this.categories.findByName(businessId, normalized);
    if (existing) throw new AppError(`Ya existe la categoría "${normalized}"`);
    return this.categories.create(businessId, { name: normalized, icon: icon ?? '🏷️' });
  }

  async updateCustom(
    businessId: string,
    id: string,
    data: { name?: string; icon?: string }
  ): Promise<Category> {
    const category = await this.categories.findById(id, businessId);
    if (!category) throw new AppError('Categoría no encontrada');
    if (category.isSystem) throw new AppError('No se puede editar una categoría del sistema');
    if (data.name) {
      const normalized = data.name.trim().toLowerCase();
      const existing = await this.categories.findByName(businessId, normalized);
      if (existing && existing.id !== id) {
        throw new AppError(`Ya existe la categoría "${normalized}"`);
      }
    }
    return this.categories.update(id, businessId, data);
  }

  async deactivate(businessId: string, id: string): Promise<Category> {
    const category = await this.categories.findById(id, businessId);
    if (!category) throw new AppError('Categoría no encontrada');
    if (category.isSystem) throw new AppError('No se puede desactivar una categoría del sistema');
    return this.categories.deactivate(id, businessId);
  }
}
