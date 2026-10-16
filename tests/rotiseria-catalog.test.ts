import { describe, expect, it } from 'vitest';
import type {
  RotiseriaProduct,
  RotiseriaSale,
  RotiseriaSaleItem,
  RotiseriaPromo,
  RotiseriaDeliveryZone,
} from '@prisma/client';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import type { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { CatalogService } from '../src/templates/rotiseria/domain/catalog.service.js';
import { ProductService } from '../src/templates/rotiseria/domain/product.service.js';
import { SaleService } from '../src/templates/rotiseria/domain/sale.service.js';
import { StatsService } from '../src/templates/rotiseria/domain/stats.service.js';
import { DeliveryZoneService } from '../src/templates/rotiseria/domain/delivery-zone.service.js';
import { createRotiseriaTemplate } from '../src/templates/rotiseria/index.js';
import {
  FakeAiUsageRepo,
  FakeAuditRepo,
  FakeBusinessRepo,
  FakeConversationRepo,
  FakeMembershipRepo,
  makeBusiness,
} from './fakes.js';
import { AppError } from '../src/core/errors/errors.js';

const BIZ = 'biz-rotiseria-cat';
const ACTOR = 'user-rotiseria-owner';
const NOW = new Date('2026-10-16T12:00:00Z');

let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

class FakePrismaDb {
  products: RotiseriaProduct[] = [];
  sales: RotiseriaSale[] = [];
  saleItems: RotiseriaSaleItem[] = [];
  promos: RotiseriaPromo[] = [];
  deliveryZones: RotiseriaDeliveryZone[] = [];

  rotiseriaProduct = {
    findFirst: async ({ where }: any) => {
      return (
        this.products.find((p) => {
          if (where.businessId && p.businessId !== where.businessId) return false;
          if (where.id && p.id !== where.id) return false;
          if (where.isActive !== undefined && p.isActive !== where.isActive) return false;
          if (where.name?.equals) {
            const isInsensitive = where.name.mode === 'insensitive';
            const eq = where.name.equals.trim();
            if (isInsensitive) {
              if (p.name.trim().toLowerCase() !== eq.toLowerCase()) return false;
            } else {
              if (p.name.trim() !== eq) return false;
            }
          }
          return true;
        }) ?? null
      );
    },
    findUnique: async ({ where }: any) => {
      return this.products.find((p) => p.id === where.id) ?? null;
    },
    findMany: async (args: any = {}) => {
      let list = [...this.products];
      if (args.where?.businessId) {
        list = list.filter((p) => p.businessId === args.where.businessId);
      }
      if (args.where?.isActive !== undefined) {
        list = list.filter((p) => p.isActive === args.where.isActive);
      }
      if (args.where?.category?.equals) {
        const cat = args.where.category.equals.toLowerCase().trim();
        list = list.filter((p) => p.category.toLowerCase().trim() === cat);
      }
      if (args.where?.name?.contains) {
        const term = args.where.name.contains.toLowerCase().trim();
        list = list.filter((p) => p.name.toLowerCase().includes(term));
      }
      if (args.distinct?.includes('category')) {
        const seen = new Set<string>();
        const distinctList: RotiseriaProduct[] = [];
        for (const item of list) {
          const c = item.category.toLowerCase().trim();
          if (!seen.has(c)) {
            seen.add(c);
            distinctList.push(item);
          }
        }
        list = distinctList;
      }
      return list;
    },
    create: async ({ data }: any) => {
      const p: RotiseriaProduct = {
        id: nid('prod'),
        businessId: data.businessId,
        name: data.name.trim(),
        priceUnit: data.priceUnit as unknown as RotiseriaProduct['priceUnit'],
        priceDozen: (data.priceDozen ?? null) as unknown as RotiseriaProduct['priceDozen'],
        priceHalfDozen: (data.priceHalfDozen ?? null) as unknown as RotiseriaProduct['priceHalfDozen'],
        category: data.category?.trim().toLowerCase() || 'general',
        isActive: data.isActive ?? true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      this.products.push(p);
      return p;
    },
    update: async ({ where, data }: any) => {
      const p = this.products.find((x) => x.id === where.id);
      if (!p) throw new Error(`Producto ${where.id} no encontrado`);
      if (data.name !== undefined) p.name = data.name.trim();
      if (data.category !== undefined) p.category = data.category.trim().toLowerCase();
      if (data.priceUnit !== undefined) p.priceUnit = data.priceUnit as unknown as RotiseriaProduct['priceUnit'];
      if (data.priceDozen !== undefined) p.priceDozen = data.priceDozen as unknown as RotiseriaProduct['priceDozen'];
      if (data.priceHalfDozen !== undefined)
        p.priceHalfDozen = data.priceHalfDozen as unknown as RotiseriaProduct['priceHalfDozen'];
      if (data.isActive !== undefined) p.isActive = data.isActive;
      p.updatedAt = NOW;
      return p;
    },
  };

  rotiseriaSale = {
    findMany: async () => this.sales,
    create: async ({ data }: any) => {
      const s: RotiseriaSale = {
        id: nid('sale'),
        businessId: data.businessId,
        userId: data.userId,
        total: data.total,
        shiftDate: data.shiftDate ?? NOW,
        isCancelled: false,
        cancelledAt: null,
        cancelledByUserId: null,
        cancelReason: null,
        deliveryZoneName: null,
        deliveryFee: null,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      this.sales.push(s);
      return s;
    },
  };

  rotiseriaSaleItem = {
    findMany: async ({ where }: any = {}) => {
      if (where?.productId) {
        return this.saleItems.filter((i) => i.productId === where.productId);
      }
      return this.saleItems;
    },
    create: async ({ data }: any) => {
      const it: RotiseriaSaleItem = {
        id: nid('item'),
        saleId: data.saleId,
        productId: data.productId ?? null,
        promoId: data.promoId ?? null,
        name: data.name,
        category: data.category ?? 'general',
        quantity: data.quantity,
        unitPrice: data.unitPrice,
        subtotal: data.subtotal,
      };
      this.saleItems.push(it);
      return it;
    },
  };
}

function setupCatalogTestEnv(role: 'OWNER' | 'EMPLOYEE' = 'OWNER') {
  const fakeDb = new FakePrismaDb();
  const catalogService = new CatalogService(fakeDb as any);

  // Repositorios y servicios conectados a fakeDb
  const productRepo: any = {
    findProductById: async (id: string, b: string) =>
      fakeDb.products.find((p) => p.id === id && p.businessId === b) ?? null,
    findProductByName: async (b: string, n: string) =>
      fakeDb.products.find(
        (p) => p.businessId === b && p.name.toLowerCase() === n.trim().toLowerCase() && p.isActive
      ) ?? null,
    listProducts: async (b: string, opts: any = {}) => {
      let list = fakeDb.products.filter((p) => p.businessId === b);
      if (!opts.includeInactive) {
        list = list.filter((p) => p.isActive);
      }
      if (opts.category) {
        list = list.filter((p) => p.category.toLowerCase() === opts.category.toLowerCase());
      }
      return list;
    },
    createProduct: async (d: any) => fakeDb.rotiseriaProduct.create({ data: d }),
    updateProduct: async (id: string, _b: string, d: any) =>
      fakeDb.rotiseriaProduct.update({ where: { id }, data: d }),
    deactivateProduct: async (id: string) =>
      fakeDb.rotiseriaProduct.update({ where: { id }, data: { isActive: false } }),
    toggleProductStatus: async (id: string) => catalogService.toggleProductStatus(id),
    listPromos: async () => fakeDb.promos,
  };

  const saleRepo: any = {
    listRecent: async () => [],
    create: async (
      businessId: string,
      userId: string,
      total: number,
      shiftDate: Date,
      lines: any[]
    ) => {
      const saleId = nid('sale');
      const s: RotiseriaSale = {
        id: saleId,
        businessId,
        userId,
        total: total as any,
        shiftDate,
        isCancelled: false,
        cancelledAt: null,
        cancelledByUserId: null,
        cancelReason: null,
        deliveryZoneName: null,
        deliveryFee: null,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      fakeDb.sales.push(s);
      const items: RotiseriaSaleItem[] = lines.map((l) => ({
        id: nid('item'),
        saleId,
        productId: l.productId ?? null,
        promoId: l.promoId ?? null,
        name: l.name,
        category: l.category ?? 'general',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        subtotal: l.subtotal,
      }));
      fakeDb.saleItems.push(...items);
      return { ...s, items };
    },
  };

  const deliveryZoneRepo: any = {
    listActive: async () => fakeDb.deliveryZones,
  };

  const products = new ProductService(productRepo);
  const stats = new StatsService(saleRepo);
  const sales = new SaleService(saleRepo, products, stats);
  const deliveryZones = new DeliveryZoneService(deliveryZoneRepo);

  const bundle = createRotiseriaTemplate({
    db: fakeDb as any,
    products,
    sales,
    deliveryZones,
    catalog: catalogService,
  });

  const businesses = new FakeBusinessRepo();
  businesses.seed(makeBusiness({ id: BIZ, templateId: 'rotiseria' }));

  const conversations = new FakeConversationRepo();
  const auditRepo = new FakeAuditRepo();
  const user = { id: ACTOR, telegramId: 'tg-owner', createdAt: NOW, updatedAt: NOW };
  const membership = {
    id: 'mem-1',
    businessId: BIZ,
    userId: ACTOR,
    role,
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const resolution: ResolutionInfo = {
    user,
    membership,
    tenant: {
      business: makeBusiness({ id: BIZ, templateId: 'rotiseria' }),
      membership,
      user,
    },
  };

  const interpreter: ActionInterpreter = {
    interpret: async () => {
      throw new Error('Interpreter not expected in catalog direct flow');
    },
  };

  const deps: FlowDeps = {
    businesses,
    membershipRepo: new FakeMembershipRepo(businesses),
    users: { findByTelegramId: async () => user } as any,
    conversations,
    audit: new AuditService(auditRepo),
    aiUsage: new FakeAiUsageRepo(),
    interpreter,
    template: bundle.template,
  };

  return {
    fakeDb,
    catalogService,
    products,
    sales,
    deps,
    resolution,
    auditRepo,
  };
}

describe('Módulo de Administración de Catálogo, Productos y Categorías en rotiseria', () => {
  describe('Servicios de Dominio (CatalogService)', () => {
    it('1. Crear un producto nuevo asociado a una categoría totalmente nueva ("picadas") la registra correctamente y la incluye en el listado de categorías', async () => {
      const { fakeDb, catalogService } = setupCatalogTestEnv();

      // Verificar que al inicio la categoría 'picadas' no existe
      const initialCats = await catalogService.listCategories(BIZ);
      expect(initialCats).not.toContain('picadas');

      // Crear el producto asignado a 'picadas'
      const prod = await catalogService.createProduct(BIZ, {
        name: 'Tabla de Picada Especial',
        category: 'picadas',
        priceUnit: 14500,
        priceDozen: null,
        priceHalfDozen: null,
      });

      expect(prod).toBeDefined();
      expect(prod.name).toBe('Tabla de Picada Especial');
      expect(prod.category).toBe('picadas');
      expect(Number(prod.priceUnit)).toBe(14500);
      expect(prod.isActive).toBe(true);

      // La categoría 'picadas' ahora debe figurar en listCategories
      const updatedCats = await catalogService.listCategories(BIZ);
      expect(updatedCats).toContain('picadas');
    });

    it('2. Modificar la categoría de un producto existente actualiza su campo category sin romper el historial de ventas asociadas (RotiseriaSaleItem)', async () => {
      const { fakeDb, catalogService, sales } = setupCatalogTestEnv();

      // 1. Crear producto con categoría inicial
      const prod = await catalogService.createProduct(BIZ, {
        name: 'Empanada Tradicional',
        category: 'empanadas',
        priceUnit: 1500,
        priceDozen: 15000,
      });

      // 2. Registrar una venta histórica que incluya este producto
      await sales.createSale(BIZ, ACTOR, [
        { name: 'Empanada Tradicional', quantity: 12 },
      ]);

      const itemsBefore = await fakeDb.rotiseriaSaleItem.findMany({ where: { productId: prod.id } });
      expect(itemsBefore.length).toBeGreaterThan(0);
      expect(itemsBefore[0].productId).toBe(prod.id);
      const originalSaleItemId = itemsBefore[0].id;

      // 3. Modificar la categoría del producto (ej: moverlo a 'gourmet')
      const updatedProd = await catalogService.updateProductCategory(prod.id, 'gourmet');
      expect(updatedProd.category).toBe('gourmet');

      // 4. Verificar que la venta histórica y sus items siguen intactos con su FK productId
      const itemsAfter = await fakeDb.rotiseriaSaleItem.findMany({ where: { productId: prod.id } });
      expect(itemsAfter.length).toBe(itemsBefore.length);
      expect(itemsAfter[0].id).toBe(originalSaleItemId);
      expect(itemsAfter[0].productId).toBe(prod.id);
      expect(itemsAfter[0].name).toBe('Empanada Tradicional');
    });

    it('3. Dar de baja un producto (isActive = false) lo oculta de la búsqueda de catálogo del bot pero preserva las FKs de ventas históricas', async () => {
      const { fakeDb, catalogService, products, sales } = setupCatalogTestEnv();

      // 1. Crear producto y asociarle una venta
      const prod = await catalogService.createProduct(BIZ, {
        name: 'Pizza Especial de Jamón y Morrones',
        category: 'pizzas',
        priceUnit: 12000,
      });

      await sales.createSale(BIZ, ACTOR, [
        { name: 'Pizza Especial de Jamón y Morrones', quantity: 1 },
      ]);

      const itemsBefore = await fakeDb.rotiseriaSaleItem.findMany({ where: { productId: prod.id } });
      expect(itemsBefore).toHaveLength(1);
      expect(itemsBefore[0].productId).toBe(prod.id);

      // 2. Dar de baja el producto (isActive -> false)
      const deactivated = await catalogService.toggleProductStatus(prod.id);
      expect(deactivated.isActive).toBe(false);

      // 3. Verificar que el bot oculta el producto del catálogo activo
      const activeProducts = await products.listProducts(BIZ);
      expect(activeProducts.find((p) => p.id === prod.id)).toBeUndefined();

      // 4. Verificar que las FKs en el historial de ventas siguen intactas
      const itemsAfter = await fakeDb.rotiseriaSaleItem.findMany({ where: { productId: prod.id } });
      expect(itemsAfter).toHaveLength(1);
      expect(itemsAfter[0].productId).toBe(prod.id);

      // 5. Reactivar el producto (isActive -> true)
      const reactivated = await catalogService.toggleProductStatus(prod.id);
      expect(reactivated.isActive).toBe(true);

      const activeAfterReactivate = await products.listProducts(BIZ);
      expect(activeAfterReactivate.find((p) => p.id === prod.id)).toBeDefined();
    });

    it('valida unicidad: rechaza productos con nombre duplicado en el mismo negocio', async () => {
      const { catalogService } = setupCatalogTestEnv();

      await catalogService.createProduct(BIZ, {
        name: 'Sandwich de Bondiola',
        category: 'sandwiches',
        priceUnit: 7500,
      });

      // Intento de duplicado con mismo nombre y diferente case
      await expect(
        catalogService.createProduct(BIZ, {
          name: 'sandwich de bondiola',
          category: 'sandwiches',
          priceUnit: 8000,
        })
      ).rejects.toThrowError(AppError);
    });
  });

  describe('Control de Acceso y Handlers de Telegram (/catalogo y /producto_nuevo)', () => {
    it('RBAC: Empleado no puede acceder a /catalogo ni /producto_nuevo', async () => {
      const { deps, resolution } = setupCatalogTestEnv('EMPLOYEE');

      const resCat = await handleText(deps, {
        resolution,
        text: '/catalogo',
        now: NOW,
      });
      expect(resCat.text).toContain('Solo el dueño del negocio puede');

      const resNuevo = await handleText(deps, {
        resolution,
        text: '/producto_nuevo',
        now: NOW,
      });
      expect(resNuevo.text).toContain('Solo el dueño del negocio puede');

      const resCb = await handleCallback(deps, {
        resolution,
        data: 'rotiseria:prod:toggle:prod-123',
        now: NOW,
      });
      expect(resCb.text).toContain('Solo el dueño del negocio puede');
    });

    it('Flujo guiado /producto_nuevo: alta paso a paso (nombre -> categoría -> precio -> guardar)', async () => {
      const { deps, resolution, fakeDb } = setupCatalogTestEnv('OWNER');

      // 1. Comando inicial /producto_nuevo
      const step1 = await handleText(deps, {
        resolution,
        text: '/producto_nuevo',
        now: NOW,
      });
      expect(step1.text).toContain('Paso 1/4');
      expect(step1.text).toContain('¿Cómo se llama el producto?');

      // 2. Ingresar nombre
      const step2 = await handleText(deps, {
        resolution,
        text: 'Empanada Salteña Picante',
        now: NOW,
      });
      expect(step2.text).toContain('Paso 2/4');
      expect(step2.text).toContain('¿A qué *categoría* pertenece?');

      // 3. Ingresar nueva categoría 'empanadas'
      const step3 = await handleText(deps, {
        resolution,
        text: 'empanadas',
        now: NOW,
      });
      expect(step3.text).toContain('Paso 3/4');
      expect(step3.text).toContain('¿Cuál es el *precio unitario*?');

      // 4. Ingresar precio unitario
      const step4 = await handleText(deps, {
        resolution,
        text: '1600',
        now: NOW,
      });
      expect(step4.text).toContain('Paso 4/4');
      expect(step4.text).toContain('¿Tiene precio por docena o media docena?');

      // 5. Omitir precios de docena
      const finish = await handleCallback(deps, {
        resolution,
        data: 'rotiseria:prod_nuevo:skip_dozen',
        now: NOW,
      });
      expect(finish.text).toContain('¡Producto creado con éxito!');
      expect(finish.text).toContain('Empanada Salteña Picante');
      expect(finish.text).toContain('$ 1.600');

      // Verificar que se persistió en DB
      const created = fakeDb.products.find((p) => p.name === 'Empanada Salteña Picante');
      expect(created).toBeDefined();
      expect(created?.category).toBe('empanadas');
      expect(Number(created?.priceUnit)).toBe(1600);
      expect(created?.isActive).toBe(true);
    });

    it('Flujo /catalogo: listar productos, ver detalle y alternar estado activo/inactivo', async () => {
      const { deps, resolution, catalogService, fakeDb } = setupCatalogTestEnv('OWNER');

      // Crear 2 productos de prueba
      const p1 = await catalogService.createProduct(BIZ, {
        name: 'Muzzarella al Molde',
        category: 'pizzas',
        priceUnit: 9500,
      });
      const p2 = await catalogService.createProduct(BIZ, {
        name: 'Empanada Criolla',
        category: 'empanadas',
        priceUnit: 1500,
        priceDozen: 15000,
      });

      // 1. Invocar /catalogo
      const catalogoMsg = await handleText(deps, {
        resolution,
        text: '/catalogo',
        now: NOW,
      });
      expect(catalogoMsg.text).toContain('Administración de Catálogo');
      expect(catalogoMsg.text).toContain('PIZZAS');
      expect(catalogoMsg.text).toContain('Muzzarella al Molde');
      expect(catalogoMsg.text).toContain('EMPANADAS');
      expect(catalogoMsg.text).toContain('Empanada Criolla');

      // 2. Abrir detalle del producto 1
      const detail = await handleCallback(deps, {
        resolution,
        data: `rotiseria:prod:ver:${p1.id}`,
        now: NOW,
      });
      expect(detail.text).toContain('Muzzarella al Molde');
      expect(detail.text).toContain('🟢 Activo');
      expect(detail.inlineKeyboard?.flat().some((b) => b.text.includes('Dar de baja'))).toBe(true);

      // 3. Dar de baja el producto con botón inline
      const toggleOff = await handleCallback(deps, {
        resolution,
        data: `rotiseria:prod:toggle:${p1.id}`,
        now: NOW,
      });
      expect(toggleOff.text).toContain('Producto dado de baja');
      expect(fakeDb.products.find((p) => p.id === p1.id)?.isActive).toBe(false);
      expect(toggleOff.inlineKeyboard?.flat().some((b) => b.text.includes('Activar'))).toBe(true);

      // 4. Reactivar el producto con botón inline
      const toggleOn = await handleCallback(deps, {
        resolution,
        data: `rotiseria:prod:toggle:${p1.id}`,
        now: NOW,
      });
      expect(toggleOn.text).toContain('Producto reactivado con éxito');
      expect(fakeDb.products.find((p) => p.id === p1.id)?.isActive).toBe(true);
    });

    it('Flujo /catalogo: modificar categoría de un producto vía botones inline (callback corto seguro)', async () => {
      const { deps, resolution, catalogService, fakeDb } = setupCatalogTestEnv('OWNER');

      const prod = await catalogService.createProduct(BIZ, {
        name: 'Sándwich de Vacío',
        category: 'sandwiches',
        priceUnit: 9000,
      });

      // 1. Tocar 'Modificar categoría'
      const editCat = await handleCallback(deps, {
        resolution,
        data: `rotiseria:prod:edit_cat:${prod.id}`,
        now: NOW,
      });
      expect(editCat.text).toContain('Modificar categoría');

      // 2. Asignar categoría vía callback corto seguro (<= 64 bytes)
      const setCat = await handleCallback(deps, {
        resolution,
        data: `rotiseria:cat_set:parrilla`,
        now: NOW,
      });
      expect(setCat.text).toContain('actualizada a *parrilla*');
      expect(fakeDb.products.find((p) => p.id === prod.id)?.category).toBe('parrilla');
    });

    it('Flujo /catalogo: escribir el nombre de la nueva categoría directamente por texto', async () => {
      const { deps, resolution, catalogService, fakeDb } = setupCatalogTestEnv('OWNER');

      const prod = await catalogService.createProduct(BIZ, {
        name: 'Hamburguesa Doble Carne',
        category: 'hamburguesas',
        priceUnit: 8500,
      });

      // 1. Tocar 'Modificar categoría'
      await handleCallback(deps, {
        resolution,
        data: `rotiseria:prod:edit_cat:${prod.id}`,
        now: NOW,
      });

      // 2. Escribir directamente el nuevo nombre de categoría en el chat
      const res = await handleText(deps, {
        resolution,
        text: 'especiales',
        now: NOW,
      });

      expect(res.text).toContain('actualizada a *especiales*');
      expect(fakeDb.products.find((p) => p.id === prod.id)?.category).toBe('especiales');
    });

    it('Flujo freestyle / texto: cambiar categoria de un producto con frase natural', async () => {
      const { deps, resolution, catalogService, fakeDb } = setupCatalogTestEnv('OWNER');

      const prod = await catalogService.createProduct(BIZ, {
        name: 'Milanesa Napolitana',
        category: 'minutas',
        priceUnit: 9500,
      });

      // 1. Frase: "cambiar categoría de Milanesa Napolitana a platos del dia"
      const res = await handleText(deps, {
        resolution,
        text: 'cambiar categoría de Milanesa Napolitana a platos del dia',
        now: NOW,
      });

      expect(res.text).toContain('actualizada a *platos del dia*');
      expect(fakeDb.products.find((p) => p.id === prod.id)?.category).toBe('platos del dia');

      // 2. Frase: "mover Milanesa Napolitana a especiales"
      const resMover = await handleText(deps, {
        resolution,
        text: 'mover Milanesa Napolitana a categoria gourmet',
        now: NOW,
      });

      expect(resMover.text).toContain('actualizada a *gourmet*');
      expect(fakeDb.products.find((p) => p.id === prod.id)?.category).toBe('gourmet');
    });

    it('Flujo /catalogo: cambiar precio de un producto existente', async () => {
      const { deps, resolution, catalogService, fakeDb } = setupCatalogTestEnv('OWNER');

      const prod = await catalogService.createProduct(BIZ, {
        name: 'Pizza Fugazzeta Rellena',
        category: 'pizzas',
        priceUnit: 12000,
      });

      // 1. Tocar 'Cambiar precio'
      const askPrice = await handleCallback(deps, {
        resolution,
        data: `rotiseria:prod:edit_price:${prod.id}`,
        now: NOW,
      });
      expect(askPrice.text).toContain('Cambiar precio de Pizza Fugazzeta Rellena');

      // 2. Enviar nuevo precio
      const updatedPriceMsg = await handleText(deps, {
        resolution,
        text: '14000',
        now: NOW,
      });
      expect(updatedPriceMsg.text).toContain('actualizado a *$ 14.000*');
      expect(Number(fakeDb.products.find((p) => p.id === prod.id)?.priceUnit)).toBe(14000);
    });
  });
});
