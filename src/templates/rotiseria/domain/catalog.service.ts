import type { Prisma, PrismaClient, RotiseriaProduct } from '@prisma/client';
import { AppError } from '../../../core/errors/errors.js';
import { prisma as defaultPrisma } from '../../../infrastructure/persistence/prisma.js';
import type { CreateCatalogProductData } from '../types.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

export class CatalogService {
  constructor(private readonly db: DbClient = defaultPrisma) {}

  /**
   * Crea o da de alta un producto nuevo en el catálogo de la rotisería.
   * Valida unicidad de nombre dentro del negocio (case-insensitive).
   */
  async createProduct(
    businessId: string,
    data: CreateCatalogProductData
  ): Promise<RotiseriaProduct> {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new AppError('El nombre del producto no puede estar vacío.');
    }

    const unitPrice = Number(data.priceUnit);
    if (isNaN(unitPrice) || unitPrice <= 0) {
      throw new AppError('El precio unitario debe ser un número mayor a 0.');
    }

    const existing = await this.db.rotiseriaProduct.findFirst({
      where: {
        businessId,
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });

    if (existing) {
      throw new AppError(`Ya existe un producto con el nombre "${trimmedName}".`);
    }

    const category = data.category?.trim().toLowerCase() || 'general';

    return this.db.rotiseriaProduct.create({
      data: {
        businessId,
        name: trimmedName,
        category,
        priceUnit: unitPrice,
        priceDozen:
          data.priceDozen !== undefined && data.priceDozen !== null ? Number(data.priceDozen) : null,
        priceHalfDozen:
          data.priceHalfDozen !== undefined && data.priceHalfDozen !== null
            ? Number(data.priceHalfDozen)
            : null,
        isActive: data.isActive ?? true,
      },
    });
  }

  /**
   * Actualiza la categoría de un producto existente.
   * Crea conceptualmente la categoría al utilizar un texto nuevo que queda disponible para futuros productos.
   */
  async updateProductCategory(
    productId: string,
    newCategory: string
  ): Promise<RotiseriaProduct> {
    const trimmedCategory = newCategory.trim().toLowerCase();
    if (!trimmedCategory) {
      throw new AppError('La categoría no puede estar vacía.');
    }

    const product = await this.db.rotiseriaProduct.findUnique({
      where: { id: productId },
    });

    if (!product) {
      throw new AppError(`Producto ${productId} no encontrado.`);
    }

    return this.db.rotiseriaProduct.update({
      where: { id: productId },
      data: { category: trimmedCategory },
    });
  }

  /**
   * Invierte el booleano isActive (da de baja o reactiva el producto)
   * sin eliminar el producto ni romper el historial de ventas asociadas.
   */
  async toggleProductStatus(productId: string): Promise<RotiseriaProduct> {
    const product = await this.db.rotiseriaProduct.findUnique({
      where: { id: productId },
    });

    if (!product) {
      throw new AppError(`Producto ${productId} no encontrado.`);
    }

    return this.db.rotiseriaProduct.update({
      where: { id: productId },
      data: { isActive: !product.isActive },
    });
  }

  /**
   * Retorna un array único de categorías activas en el negocio.
   * Equivale a SELECT DISTINCT category FROM rotiseria_products WHERE businessId = ... AND isActive = true.
   */
  async listCategories(businessId: string): Promise<string[]> {
    const records = await this.db.rotiseriaProduct.findMany({
      where: {
        businessId,
        isActive: true,
      },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });

    const categoriesSet = new Set<string>();
    for (const r of records) {
      const cat = r.category?.trim().toLowerCase();
      if (cat) {
        categoriesSet.add(cat);
      }
    }

    return Array.from(categoriesSet);
  }

  /**
   * Retorna todos los productos del negocio (activos e inactivos) agrupados por categoría.
   */
  async listAllProductsGrouped(businessId: string): Promise<Map<string, RotiseriaProduct[]>> {
    const products = await this.db.rotiseriaProduct.findMany({
      where: { businessId },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    const grouped = new Map<string, RotiseriaProduct[]>();
    for (const p of products) {
      const cat = p.category?.trim().toLowerCase() || 'general';
      const list = grouped.get(cat) ?? [];
      list.push(p);
      grouped.set(cat, list);
    }

    return grouped;
  }

  /**
   * Busca un producto por ID y opcionalmente valida pertenencia a un negocio.
   */
  async findProductById(productId: string, businessId?: string): Promise<RotiseriaProduct | null> {
    return this.db.rotiseriaProduct.findFirst({
      where: {
        id: productId,
        ...(businessId ? { businessId } : {}),
      },
    });
  }

  /**
   * Actualiza los precios de un producto.
   */
  async updateProductPrice(
    productId: string,
    data: {
      priceUnit?: number;
      priceDozen?: number | null;
      priceHalfDozen?: number | null;
    }
  ): Promise<RotiseriaProduct> {
    const updateData: Prisma.RotiseriaProductUpdateInput = {};

    if (data.priceUnit !== undefined) {
      updateData.priceUnit = Number(data.priceUnit);
    }
    if (data.priceDozen !== undefined) {
      updateData.priceDozen = data.priceDozen !== null ? Number(data.priceDozen) : null;
    }
    if (data.priceHalfDozen !== undefined) {
      updateData.priceHalfDozen = data.priceHalfDozen !== null ? Number(data.priceHalfDozen) : null;
    }

    return this.db.rotiseriaProduct.update({
      where: { id: productId },
      data: updateData,
    });
  }
}

// Funciones puras exportadas de conveniencia para cumplir con el contrato de dominio
export async function createProduct(
  businessId: string,
  data: CreateCatalogProductData,
  db?: DbClient
): Promise<RotiseriaProduct> {
  const service = new CatalogService(db);
  return service.createProduct(businessId, data);
}

export async function updateProductCategory(
  productId: string,
  newCategory: string,
  db?: DbClient
): Promise<RotiseriaProduct> {
  const service = new CatalogService(db);
  return service.updateProductCategory(productId, newCategory);
}

export async function toggleProductStatus(
  productId: string,
  db?: DbClient
): Promise<RotiseriaProduct> {
  const service = new CatalogService(db);
  return service.toggleProductStatus(productId);
}

export async function listCategories(
  businessId: string,
  db?: DbClient
): Promise<string[]> {
  const service = new CatalogService(db);
  return service.listCategories(businessId);
}
