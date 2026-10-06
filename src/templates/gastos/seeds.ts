import type { CategoryService } from './domain/category.service.js';

/** Datos iniciales de un negocio nuevo del template gastos. Idempotente. */
export async function seedGastosBusiness(
  categories: CategoryService,
  businessId: string
): Promise<void> {
  await categories.seedBusiness(businessId);
}
