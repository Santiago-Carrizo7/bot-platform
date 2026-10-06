import type { Prisma, PrismaClient, Product } from '@prisma/client';
import type { CreateProductData } from '../types.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface ProductSearchOptions {
  search?: string;
  onlyLowStock?: boolean;
  limit?: number;
}

/** Repositorio scropeado por negocio: todo método exige businessId. */
export class ProductRepository {
  constructor(private readonly db: PrismaClient) {}

  private client(tx?: Prisma.TransactionClient): Db {
    return tx ?? this.db;
  }

  async create(data: CreateProductData, tx?: Prisma.TransactionClient): Promise<Product> {
    return this.client(tx).product.create({
      data: {
        businessId: data.businessId,
        name: data.name.trim(),
        salePrice: data.salePrice,
        costPrice: data.costPrice,
        stock: data.stock ?? 0,
        minStock: data.minStock,
        unit: data.unit ?? 'unidad',
      },
    });
  }

  async findByName(businessId: string, name: string, tx?: Prisma.TransactionClient): Promise<Product | null> {
    return this.client(tx).product.findFirst({
      where: { businessId, name: { equals: name.trim(), mode: 'insensitive' }, isActive: true },
    });
  }

  async findById(id: string, businessId: string): Promise<Product | null> {
    return this.db.product.findFirst({ where: { id, businessId } });
  }

  async list(businessId: string, options: ProductSearchOptions = {}): Promise<Product[]> {
    const { search, onlyLowStock, limit = 50 } = options;
    const all = await this.db.product.findMany({
      where: {
        businessId,
        isActive: true,
        ...(search ? { name: { contains: search.trim(), mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      take: Math.min(limit, 100),
    });
    if (!onlyLowStock) return all;
    return all.filter((p) => p.minStock !== null && Number(p.stock) <= Number(p.minStock));
  }

  async update(
    id: string,
    businessId: string,
    data: { name?: string; salePrice?: number; costPrice?: number; minStock?: number | null; unit?: string },
    tx?: Prisma.TransactionClient
  ): Promise<Product> {
    return this.client(tx).product.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.salePrice !== undefined ? { salePrice: data.salePrice } : {}),
        ...(data.costPrice !== undefined ? { costPrice: data.costPrice } : {}),
        ...(data.minStock !== undefined ? { minStock: data.minStock } : {}),
        ...(data.unit !== undefined ? { unit: data.unit.trim() } : {}),
      },
    });
  }

  /** Baja lógica: se conserva el historial (ventas, movimientos). */
  async deactivate(id: string, businessId: string): Promise<Product> {
    const existing = await this.findById(id, businessId);
    if (!existing) throw new Error('Producto no encontrado en este negocio');
    return this.db.product.update({ where: { id }, data: { isActive: false } });
  }

  async changeStock(
    id: string,
    businessId: string,
    delta: number,
    tx?: Prisma.TransactionClient
  ): Promise<Product> {
    const client = this.client(tx);
    const existing = await client.product.findFirst({ where: { id, businessId } });
    if (!existing) throw new Error('Producto no encontrado en este negocio');
    const newStock = Number(existing.stock) + delta;
    return client.product.update({ where: { id }, data: { stock: newStock } });
  }

  async setStock(
    id: string,
    businessId: string,
    quantity: number,
    tx?: Prisma.TransactionClient
  ): Promise<{ product: Product; previous: number }> {
    const client = this.client(tx);
    const existing = await client.product.findFirst({ where: { id, businessId } });
    if (!existing) throw new Error('Producto no encontrado en este negocio');
    const previous = Number(existing.stock);
    const product = await client.product.update({ where: { id }, data: { stock: quantity } });
    return { product, previous };
  }
}
