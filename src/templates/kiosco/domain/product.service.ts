import type { Product } from '@prisma/client';
import { AppError } from '../../../core/errors/errors.js';
import { ProductRepository } from '../persistence/product.repo.js';
import { CashRepository } from '../persistence/cash.repo.js';
import type { CreateProductData } from '../types.js';

export class ProductService {
  constructor(
    private readonly products: ProductRepository,
    private readonly cash: CashRepository
  ) {}

  async create(businessId: string, actorUserId: string, data: Omit<CreateProductData, 'businessId'>): Promise<Product> {
    if (data.salePrice <= 0) throw new AppError('El precio de venta debe ser mayor a 0');
    if (!data.name.trim()) throw new AppError('El nombre del producto no puede estar vacío');
    const existing = await this.products.findByName(businessId, data.name);
    if (existing) throw new AppError(`Ya existe el producto "${data.name.trim()}"`);

    const product = await this.products.create({ ...data, businessId });
    if ((data.stock ?? 0) > 0) {
      await this.cash.addStockMovement({
        businessId,
        productId: product.id,
        productName: product.name,
        quantity: data.stock ?? 0,
        reason: 'CARGA_INICIAL',
        relatedType: 'product',
        relatedId: product.id,
        userId: actorUserId,
      });
    }
    return product;
  }

  async update(
    businessId: string,
    currentName: string,
    data: { name?: string; salePrice?: number; costPrice?: number; minStock?: number | null; unit?: string }
  ): Promise<Product> {
    const product = await this.requireActive(businessId, currentName);
    if (data.salePrice !== undefined && data.salePrice <= 0) {
      throw new AppError('El precio de venta debe ser mayor a 0');
    }
    if (data.name) {
      const clash = await this.products.findByName(businessId, data.name);
      if (clash && clash.id !== product.id) {
        throw new AppError(`Ya existe el producto "${data.name.trim()}"`);
      }
    }
    return this.products.update(product.id, businessId, data);
  }

  async deactivate(businessId: string, name: string): Promise<Product> {
    const product = await this.requireActive(businessId, name);
    return this.products.deactivate(product.id, businessId);
  }

  /** Fija el stock en un valor absoluto (registra la diferencia como AJUSTE). */
  async setStock(
    businessId: string,
    actorUserId: string,
    name: string,
    quantity: number
  ): Promise<{ product: Product; previous: number }> {
    if (quantity < 0) throw new AppError('El stock no puede ser negativo');
    const product = await this.requireActive(businessId, name);
    const { product: updated, previous } = await this.products.setStock(product.id, businessId, quantity);
    const diff = quantity - previous;
    if (diff !== 0) {
      await this.cash.addStockMovement({
        businessId,
        productId: product.id,
        productName: product.name,
        quantity: diff,
        reason: 'AJUSTE',
        userId: actorUserId,
      });
    }
    return { product: updated, previous };
  }

  async findByName(businessId: string, name: string): Promise<Product | null> {
    return this.products.findByName(businessId, name);
  }

  async list(businessId: string, options: { search?: string; onlyLowStock?: boolean; limit?: number } = {}): Promise<Product[]> {
    return this.products.list(businessId, options);
  }

  private async requireActive(businessId: string, name: string): Promise<Product> {
    const product = await this.products.findByName(businessId, name);
    if (!product) throw new AppError(`No encontré el producto "${name.trim()}". Crealo primero.`);
    return product;
  }
}
