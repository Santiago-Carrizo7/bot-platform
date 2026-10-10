import { AppError } from '../../../core/errors/errors.js';
import type { RotiseriaProduct, RotiseriaPromo } from '@prisma/client';
import type { CatalogLookup } from './pricing.js';
import { ProductRepository, type ProductListOptions } from '../persistence/product.repo.js';
import type { CreateProductData, CreatePromoData, UpdateProductData, UpdatePromoData } from '../types.js';

export class ProductService {
  constructor(private readonly repo: ProductRepository) {}

  // --- PRODUCTOS ---

  async createProduct(data: CreateProductData): Promise<RotiseriaProduct> {
    const existing = await this.repo.findProductByName(data.businessId, data.name);
    if (existing) {
      throw new AppError(`Ya existe un producto activo con el nombre "${data.name.trim()}".`);
    }
    return this.repo.createProduct(data);
  }

  async updateProduct(id: string, businessId: string, data: UpdateProductData): Promise<RotiseriaProduct> {
    const existing = await this.repo.findProductById(id, businessId);
    if (!existing) {
      throw new AppError('Producto no encontrado.');
    }
    if (data.name && data.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await this.repo.findProductByName(businessId, data.name);
      if (duplicate && duplicate.id !== id) {
        throw new AppError(`Ya existe un producto con el nombre "${data.name.trim()}".`);
      }
    }
    return this.repo.updateProduct(id, businessId, data);
  }

  async deactivateProduct(id: string, businessId: string): Promise<RotiseriaProduct> {
    const existing = await this.repo.findProductById(id, businessId);
    if (!existing) {
      throw new AppError('Producto no encontrado.');
    }
    return this.repo.deactivateProduct(id);
  }

  async listProducts(businessId: string, options: ProductListOptions = {}): Promise<RotiseriaProduct[]> {
    return this.repo.listProducts(businessId, options);
  }

  async findProductByName(businessId: string, name: string): Promise<RotiseriaProduct | null> {
    return this.repo.findProductByName(businessId, name);
  }

  async findProductById(id: string, businessId: string): Promise<RotiseriaProduct | null> {
    return this.repo.findProductById(id, businessId);
  }

  async listActiveCategories(businessId: string): Promise<string[]> {
    const prods = await this.repo.listProducts(businessId, { limit: 200 });
    const set = new Set<string>();
    for (const p of prods) {
      if (p.category) {
        set.add(p.category.toLowerCase().trim());
      }
    }
    return Array.from(set);
  }

  // --- PROMOS ---

  async createPromo(data: CreatePromoData): Promise<RotiseriaPromo> {
    const existing = await this.repo.findPromoByName(data.businessId, data.name);
    if (existing) {
      throw new AppError(`Ya existe una promo activa con el nombre "${data.name.trim()}".`);
    }
    return this.repo.createPromo(data);
  }

  async updatePromo(id: string, businessId: string, data: UpdatePromoData): Promise<RotiseriaPromo> {
    const existing = await this.repo.findPromoById(id, businessId);
    if (!existing) {
      throw new AppError('Promo no encontrada.');
    }
    if (data.name && data.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await this.repo.findPromoByName(businessId, data.name);
      if (duplicate && duplicate.id !== id) {
        throw new AppError(`Ya existe una promo con el nombre "${data.name.trim()}".`);
      }
    }
    return this.repo.updatePromo(id, businessId, data);
  }

  async deactivatePromo(id: string, businessId: string): Promise<RotiseriaPromo> {
    const existing = await this.repo.findPromoById(id, businessId);
    if (!existing) {
      throw new AppError('Promo no encontrada.');
    }
    return this.repo.deactivatePromo(id);
  }

  async listPromos(businessId: string): Promise<RotiseriaPromo[]> {
    return this.repo.listPromos(businessId);
  }

  async findPromoByName(businessId: string, name: string): Promise<RotiseriaPromo | null> {
    return this.repo.findPromoByName(businessId, name);
  }

  // --- LOOKUP PARA PRICING ---

  async getCatalogLookup(businessId: string): Promise<CatalogLookup> {
    const [products, promos] = await Promise.all([
      this.repo.listProducts(businessId, { limit: 100 }),
      this.repo.listPromos(businessId),
    ]);

    const normalize = (s: string) => s.trim().toLowerCase();

    return {
      findProduct: (name: string) => {
        const needle = normalize(name);
        return products.find((p) => normalize(p.name) === needle);
      },
      findPromo: (name: string) => {
        const needle = normalize(name);
        return promos.find((p) => normalize(p.name) === needle);
      },
    };
  }

  // --- SEED IDEMPOTENTE BASE ---

  async seedBaseCatalog(businessId: string): Promise<void> {
    const defaultProducts: CreateProductData[] = [
      { businessId, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000, category: 'empanadas' },
      { businessId, name: 'Empanada de Jamón y Queso', priceUnit: 1500, priceDozen: 15000, category: 'empanadas' },
      { businessId, name: 'Empanada de Pollo', priceUnit: 1500, priceDozen: 15000, category: 'empanadas' },
      { businessId, name: 'Pizza Muzzarella', priceUnit: 9000, category: 'pizzas' },
      { businessId, name: 'Sándwich de Milanesa', priceUnit: 8500, category: 'sandwiches' },
    ];

    for (const p of defaultProducts) {
      const existing = await this.repo.findProductByName(businessId, p.name);
      if (!existing) {
        await this.repo.createProduct(p);
      }
    }

    const defaultPromo: CreatePromoData = {
      businessId,
      name: 'Promo 1',
      description: '1 Pizza Muzzarella + 6 Empanadas',
      price: 16000,
    };

    const existingPromo = await this.repo.findPromoByName(businessId, defaultPromo.name);
    if (!existingPromo) {
      await this.repo.createPromo(defaultPromo);
    }
  }
}
