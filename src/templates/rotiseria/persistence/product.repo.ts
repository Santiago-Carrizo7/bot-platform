import type { Prisma, PrismaClient, RotiseriaProduct, RotiseriaPromo } from '@prisma/client';
import type { CreateProductData, CreatePromoData, UpdateProductData, UpdatePromoData } from '../types.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface ProductListOptions {
  search?: string;
  category?: string;
  limit?: number;
}

export class ProductRepository {
  constructor(private readonly db: PrismaClient) {}

  private client(tx?: Prisma.TransactionClient): Db {
    return tx ?? this.db;
  }

  // --- PRODUCTOS ---

  async createProduct(data: CreateProductData, tx?: Prisma.TransactionClient): Promise<RotiseriaProduct> {
    return this.client(tx).rotiseriaProduct.create({
      data: {
        businessId: data.businessId,
        name: data.name.trim(),
        priceUnit: data.priceUnit,
        priceDozen: data.priceDozen ?? null,
        category: data.category?.trim() || 'empanadas',
      },
    });
  }

  async findProductByName(
    businessId: string,
    name: string,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaProduct | null> {
    return this.client(tx).rotiseriaProduct.findFirst({
      where: {
        businessId,
        name: { equals: name.trim(), mode: 'insensitive' },
        isActive: true,
      },
    });
  }

  async findProductById(id: string, businessId: string): Promise<RotiseriaProduct | null> {
    return this.db.rotiseriaProduct.findFirst({
      where: { id, businessId },
    });
  }

  async listProducts(businessId: string, options: ProductListOptions = {}): Promise<RotiseriaProduct[]> {
    const { search, category, limit = 50 } = options;
    return this.db.rotiseriaProduct.findMany({
      where: {
        businessId,
        isActive: true,
        ...(search ? { name: { contains: search.trim(), mode: 'insensitive' } } : {}),
        ...(category ? { category: { equals: category.trim(), mode: 'insensitive' } } : {}),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: Math.min(limit, 100),
    });
  }

  async updateProduct(
    id: string,
    businessId: string,
    data: UpdateProductData,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaProduct> {
    return this.client(tx).rotiseriaProduct.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.priceUnit !== undefined ? { priceUnit: data.priceUnit } : {}),
        ...(data.priceDozen !== undefined ? { priceDozen: data.priceDozen } : {}),
        ...(data.category !== undefined ? { category: data.category.trim() } : {}),
      },
    });
  }

  async deactivateProduct(id: string, tx?: Prisma.TransactionClient): Promise<RotiseriaProduct> {
    return this.client(tx).rotiseriaProduct.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // --- PROMOS ---

  async createPromo(data: CreatePromoData, tx?: Prisma.TransactionClient): Promise<RotiseriaPromo> {
    return this.client(tx).rotiseriaPromo.create({
      data: {
        businessId: data.businessId,
        name: data.name.trim(),
        description: data.description?.trim() || null,
        price: data.price,
      },
    });
  }

  async findPromoByName(
    businessId: string,
    name: string,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaPromo | null> {
    return this.client(tx).rotiseriaPromo.findFirst({
      where: {
        businessId,
        name: { equals: name.trim(), mode: 'insensitive' },
        isActive: true,
      },
    });
  }

  async findPromoById(id: string, businessId: string): Promise<RotiseriaPromo | null> {
    return this.db.rotiseriaPromo.findFirst({
      where: { id, businessId },
    });
  }

  async listPromos(businessId: string): Promise<RotiseriaPromo[]> {
    return this.db.rotiseriaPromo.findMany({
      where: { businessId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async updatePromo(
    id: string,
    businessId: string,
    data: UpdatePromoData,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaPromo> {
    return this.client(tx).rotiseriaPromo.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.description !== undefined ? { description: data.description?.trim() || null } : {}),
        ...(data.price !== undefined ? { price: data.price } : {}),
      },
    });
  }

  async deactivatePromo(id: string, tx?: Prisma.TransactionClient): Promise<RotiseriaPromo> {
    return this.client(tx).rotiseriaPromo.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
