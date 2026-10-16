import { AppError } from '../../../core/errors/errors.js';
import type { RotiseriaProduct, RotiseriaPromo } from '@prisma/client';
import type { CatalogLookup } from './pricing.js';
import { ProductRepository, type ProductListOptions } from '../persistence/product.repo.js';
import type { CreateProductData, CreatePromoData, UpdateProductData, UpdatePromoData } from '../types.js';

export function normalizeDrinkName(raw: string): string {
  let name = raw.trim();

  // Mapear marcas y nombres coloquiales
  name = name.replace(/\bcoca\s*cola\b/gi, 'Coca-Cola');
  name = name.replace(/\bcoca\b/gi, 'Coca-Cola');
  name = name.replace(/\bpepsi\b/gi, 'Pepsi');
  name = name.replace(/\bsprite\b/gi, 'Sprite');
  name = name.replace(/\bfanta\b/gi, 'Fanta');
  name = name.replace(/\bseven\s*up\b|\b7up\b/gi, '7Up');
  name = name.replace(/\bquilmes\b/gi, 'Cerveza Quilmes');
  name = name.replace(/\bbrahma\b/gi, 'Cerveza Brahma');
  name = name.replace(/\bheineken\b/gi, 'Cerveza Heineken');
  name = name.replace(/\bcervesa\b/gi, 'Cerveza');
  name = name.replace(/\bcerveza\s+cerveza\b/gi, 'Cerveza');

  // Mapear tamaños coloquiales a formatos estándar
  name = name.replace(/\b(?:litro\s+y\s+medio|de\s+litro\s+y\s+medio|1\s+y\s+medio|1,5\s*l(?:itros?)?|1\.5\s*l(?:itros?)?)\b/gi, '1.5L');
  name = name.replace(/\b(?:dos\s+litros|de\s+dos\s+litros|2\s*l(?:itros?)?)\b/gi, '2L');
  name = name.replace(/\b(?:un\s+litro|de\s+un\s+litro|1\s*l(?:itro)?)\b/gi, '1L');
  name = name.replace(/\b(?:medio\s+litro|de\s+medio\s+litro|500\s*ml|500)\b/gi, '500ml');
  name = name.replace(/\blatas?\b/gi, 'Lata');

  // Si dice "grande" o "chica"
  name = name.replace(/\bchica\b/gi, '500ml');

  return name.trim().replace(/\s+/g, ' ');
}

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
    return this.repo.deactivateProduct(id, businessId);
  }

  async toggleProductStatus(id: string, businessId: string): Promise<RotiseriaProduct> {
    const existing = await this.repo.findProductById(id, businessId);
    if (!existing) {
      throw new AppError('Producto no encontrado.');
    }
    return this.repo.toggleProductStatus(id, businessId);
  }

  async upsertBatchBebidas(
    businessId: string,
    bebidas: Array<{ nombre: string; precio: number }>
  ): Promise<RotiseriaProduct[]> {
    const results: RotiseriaProduct[] = [];
    for (const b of bebidas) {
      const normalizedName = normalizeDrinkName(b.nombre);
      const existing = await this.repo.findProductByName(businessId, normalizedName);
      if (existing) {
        const updated = await this.repo.updateProduct(existing.id, businessId, {
          name: normalizedName,
          priceUnit: b.precio,
          priceDozen: null,
          category: 'bebidas',
        });
        results.push(updated);
      } else {
        const created = await this.repo.createProduct({
          businessId,
          name: normalizedName,
          priceUnit: b.precio,
          priceDozen: undefined,
          category: 'bebidas',
        });
        results.push(created);
      }
    }
    return results;
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
    return this.repo.deactivatePromo(id, businessId);
  }

  async listPromos(businessId: string, options: { includeInactive?: boolean } = {}): Promise<RotiseriaPromo[]> {
    return this.repo.listPromos(businessId, options);
  }

  async findPromoByName(businessId: string, name: string): Promise<RotiseriaPromo | null> {
    return this.repo.findPromoByName(businessId, name);
  }

  async findPromoById(id: string, businessId: string): Promise<RotiseriaPromo | null> {
    return this.repo.findPromoById(id, businessId);
  }

  // --- LOOKUP PARA PRICING ---

  async getCatalogLookup(businessId: string): Promise<CatalogLookup> {
    const [products, promos] = await Promise.all([
      this.repo.listProducts(businessId, { limit: 100 }),
      this.repo.listPromos(businessId),
    ]);

    const normalize = (s: string) =>
      s
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    const cleanNeedle = (s: string) =>
      normalize(s)
        .replace(/^(?:una|un|\d+)\s+(?:de\s+)?/i, '')
        .replace(/^(?:empanadas?\s+de\s+|empanadas?\s+|pizzas?\s+de\s+|pizzas?\s+|sandwiches?\s+de\s+|sandwiches?\s+)/i, '')
        .replace(/^(?:de\s+)/i, '')
        .replace(/\b(?:carne\s+vacuna|de\s+vaca|vacuna)\b/gi, 'carne')
        .trim();

    const extractTokens = (s: string) =>
      cleanNeedle(s)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !['empanada', 'empanadas', 'pizza', 'pizzas', 'sandwich', 'sandwiches', 'vaca', 'vacuna'].includes(w));

    return {
      findProduct: (name: string) => {
        const needle = normalize(name);
        // 1. Coincidencia exacta
        const exact = products.find((p) => normalize(p.name) === needle);
        if (exact) return exact;

        // 1b. Coincidencia con normalización de bebidas (ej: "coca de litro y medio" -> "Coca-Cola 1.5L")
        const normDrink = normalizeDrinkName(name);
        if (normDrink) {
          const matchDrink = products.find((p) => normalize(p.name) === normalize(normDrink));
          if (matchDrink) return matchDrink;
        }

        // 2. Coincidencia limpia idéntica (ej. "1 de carne" o "carne" -> "Empanada de Carne" si cleanNeedle es idéntico)
        const cleaned = cleanNeedle(name);
        if (cleaned) {
          const matchCleaned = products.find((p) => cleanNeedle(p.name) === cleaned);
          if (matchCleaned) return matchCleaned;
        }

        // 3. Coincidencia por palabra o sabor raíz (tokens significativos con word-boundary)
        const needleTokens = extractTokens(name);
        if (needleTokens.length > 0) {
          // Buscar productos cuyos tokens contengan todos los tokens del needle
          const tokenMatches = products.filter((p) => {
            const pTokens = extractTokens(p.name);
            return needleTokens.every((nt) => pTokens.some((pt) => pt.includes(nt) || nt.includes(pt)));
          });
          if (tokenMatches.length === 1) {
            return tokenMatches[0];
          }
          if (tokenMatches.length > 1) {
            // Priorizar si coincide exactamente con el sabor principal (ej: "carne" -> "Empanada de Carne" sobre "Empanada de Carne Picante")
            const exactFlavor = tokenMatches.find((p) => {
              const pTokens = extractTokens(p.name);
              return pTokens.length === needleTokens.length && needleTokens.every((nt, idx) => pTokens[idx] === nt);
            });
            if (exactFlavor) return exactFlavor;
            return tokenMatches[0];
          }
        }

        // 4. Substring match seguro (requiere palabra completa en nombre del producto)
        if (cleaned.length >= 3) {
          const sub = products.find((p) => {
            const pCleaned = cleanNeedle(p.name);
            const regex = new RegExp(`\\b${cleaned}\\b`, 'i');
            return regex.test(pCleaned) || regex.test(normalize(p.name));
          });
          if (sub) return sub;
        }

        return undefined;
      },
      findPromo: (name: string) => {
        const needle = normalize(name);
        const exact = promos.find((p) => normalize(p.name) === needle);
        if (exact) return exact;
        return promos.find((p) => normalize(p.name).includes(needle) || needle.includes(normalize(p.name)));
      },
    };
  }

  // --- SEED IDEMPOTENTE BASE ---

  async seedBaseCatalog(businessId: string): Promise<void> {
    

    // Negocios nuevos arrancan limpios (0 productos, 0 promos).
    // La carta y zonas se cargan durante el onboarding de cada local.
  }
}
