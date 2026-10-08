import { describe, expect, it, vi } from 'vitest';
import type { RotiseriaProduct, RotiseriaPromo, RotiseriaSale, RotiseriaSaleItem } from '@prisma/client';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import type { ActionDef, TemplateDefinition } from '../src/core/actions/registry.js';
import type { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { ProductService } from '../src/templates/rotiseria/domain/product.service.js';
import { SaleService } from '../src/templates/rotiseria/domain/sale.service.js';
import { calculatePricing } from '../src/templates/rotiseria/domain/pricing.js';
import { getShiftDate, formatShiftLabel } from '../src/templates/rotiseria/domain/shift.js';
import { buildRotiseriaActions } from '../src/templates/rotiseria/actions.js';
import type { ProductRepository } from '../src/templates/rotiseria/persistence/product.repo.js';
import type { SaleRepository, RotiseriaSaleWithItems } from '../src/templates/rotiseria/persistence/sale.repo.js';
import {
  FakeAiUsageRepo,
  FakeAuditRepo,
  FakeBusinessRepo,
  FakeConversationRepo,
  FakeMembershipRepo,
  makeBusiness,
} from './fakes.js';
import type { TenantContext } from '../src/core/tenant/entities.js';

const BIZ = 'biz-rotiseria-1';
const ACTOR = 'user-rotiseria-1';
const NOW = new Date('2026-10-08T22:00:00Z');

let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

interface RotiseriaStore {
  products: RotiseriaProduct[];
  promos: RotiseriaPromo[];
  sales: RotiseriaSaleWithItems[];
}

function newStore(): RotiseriaStore {
  return { products: [], promos: [], sales: [] };
}

class FakeRotiseriaProductRepo implements Partial<ProductRepository> {
  constructor(private readonly s: RotiseriaStore) {}

  async createProduct(data: { businessId: string; name: string; priceUnit: number; priceDozen?: number; category?: string }) {
    const p: RotiseriaProduct = {
      id: nid('prod'),
      businessId: data.businessId,
      name: data.name.trim(),
      priceUnit: data.priceUnit as unknown as RotiseriaProduct['priceUnit'],
      priceDozen: (data.priceDozen ?? null) as unknown as RotiseriaProduct['priceDozen'],
      category: data.category?.trim() || 'empanadas',
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.s.products.push(p);
    return p;
  }

  async findProductByName(businessId: string, name: string) {
    return (
      this.s.products.find(
        (p) => p.businessId === businessId && p.name.toLowerCase() === name.trim().toLowerCase() && p.isActive
      ) ?? null
    );
  }

  async findProductById(id: string, businessId: string) {
    return this.s.products.find((p) => p.id === id && p.businessId === businessId) ?? null;
  }

  async listProducts(businessId: string, opts: { search?: string; category?: string; limit?: number } = {}) {
    let list = this.s.products.filter((p) => p.businessId === businessId && p.isActive);
    if (opts.search) {
      list = list.filter((p) => p.name.toLowerCase().includes(opts.search!.toLowerCase()));
    }
    if (opts.category) {
      list = list.filter((p) => p.category.toLowerCase() === opts.category!.toLowerCase());
    }
    return list.slice(0, opts.limit ?? 50);
  }

  async updateProduct(
    id: string,
    _b: string,
    data: { name?: string; priceUnit?: number; priceDozen?: number | null; category?: string }
  ) {
    const p = this.s.products.find((x) => x.id === id);
    if (!p) throw new Error('no encontrado');
    if (data.name !== undefined) p.name = data.name.trim();
    if (data.priceUnit !== undefined) p.priceUnit = data.priceUnit as unknown as RotiseriaProduct['priceUnit'];
    if (data.priceDozen !== undefined) p.priceDozen = data.priceDozen as unknown as RotiseriaProduct['priceDozen'];
    if (data.category !== undefined) p.category = data.category.trim();
    return p;
  }

  async deactivateProduct(id: string) {
    const p = this.s.products.find((x) => x.id === id);
    if (!p) throw new Error('no encontrado');
    p.isActive = false;
    return p;
  }

  async createPromo(data: { businessId: string; name: string; description?: string; price: number }) {
    const pr: RotiseriaPromo = {
      id: nid('promo'),
      businessId: data.businessId,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      price: data.price as unknown as RotiseriaPromo['price'],
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.s.promos.push(pr);
    return pr;
  }

  async findPromoByName(businessId: string, name: string) {
    return (
      this.s.promos.find(
        (p) => p.businessId === businessId && p.name.toLowerCase() === name.trim().toLowerCase() && p.isActive
      ) ?? null
    );
  }

  async findPromoById(id: string, businessId: string) {
    return this.s.promos.find((p) => p.id === id && p.businessId === businessId) ?? null;
  }

  async listPromos(businessId: string) {
    return this.s.promos.filter((p) => p.businessId === businessId && p.isActive);
  }

  async updatePromo(id: string, _b: string, data: { name?: string; description?: string; price?: number }) {
    const pr = this.s.promos.find((x) => x.id === id);
    if (!pr) throw new Error('no encontrado');
    if (data.name !== undefined) pr.name = data.name.trim();
    if (data.description !== undefined) pr.description = data.description?.trim() || null;
    if (data.price !== undefined) pr.price = data.price as unknown as RotiseriaPromo['price'];
    return pr;
  }

  async deactivatePromo(id: string) {
    const pr = this.s.promos.find((x) => x.id === id);
    if (!pr) throw new Error('no encontrado');
    pr.isActive = false;
    return pr;
  }
}

class FakeRotiseriaSaleRepo implements Partial<SaleRepository> {
  constructor(private readonly s: RotiseriaStore) {}

  async create(
    businessId: string,
    userId: string,
    total: number,
    shiftDate: Date,
    lines: Array<{ productId?: string | null; promoId?: string | null; name: string; quantity: number; unitPrice: number; subtotal: number }>,
    note?: string
  ): Promise<RotiseriaSaleWithItems> {
    const saleId = nid('sale');
    const items: RotiseriaSaleItem[] = lines.map((l) => ({
      id: nid('item'),
      saleId,
      productId: l.productId ?? null,
      promoId: l.promoId ?? null,
      name: l.name,
      quantity: l.quantity as unknown as RotiseriaSaleItem['quantity'],
      unitPrice: l.unitPrice as unknown as RotiseriaSaleItem['unitPrice'],
      subtotal: l.subtotal as unknown as RotiseriaSaleItem['subtotal'],
    }));

    const sale: RotiseriaSaleWithItems = {
      id: saleId,
      businessId,
      userId,
      total: total as unknown as RotiseriaSale['total'],
      shiftDate,
      isCancelled: false,
      cancelledAt: null,
      cancelledByUserId: null,
      cancelReason: null,
      note: note?.trim() || null,
      createdAt: NOW,
      updatedAt: NOW,
      items,
    };
    this.s.sales.push(sale);
    return sale;
  }

  async findById(id: string, businessId: string) {
    return this.s.sales.find((s) => s.id === id && s.businessId === businessId) ?? null;
  }

  async findLastActive(businessId: string) {
    return (
      [...this.s.sales].reverse().find((s) => s.businessId === businessId && !s.isCancelled) ?? null
    );
  }

  async cancel(id: string, businessId: string, userId: string, reason?: string, now: Date = new Date()) {
    const sale = this.s.sales.find((s) => s.id === id && s.businessId === businessId);
    if (!sale) throw new Error('no encontrado');
    sale.isCancelled = true;
    sale.cancelledAt = now;
    sale.cancelledByUserId = userId;
    sale.cancelReason = reason?.trim() || null;
    return sale;
  }

  async listRecent(businessId: string, limit = 10) {
    return [...this.s.sales]
      .filter((s) => s.businessId === businessId)
      .reverse()
      .slice(0, limit);
  }

  async findByShiftDate(businessId: string, shiftDate: Date) {
    return this.s.sales.filter(
      (s) => s.businessId === businessId && s.shiftDate.getTime() === shiftDate.getTime()
    );
  }

  async findByDateRange(businessId: string, start: Date, end: Date) {
    return this.s.sales.filter(
      (s) => s.businessId === businessId && s.shiftDate >= start && s.shiftDate <= end
    );
  }
}

function setupServices(store = newStore()) {
  const productRepo = new FakeRotiseriaProductRepo(store) as unknown as ProductRepository;
  const saleRepo = new FakeRotiseriaSaleRepo(store) as unknown as SaleRepository;
  const products = new ProductService(productRepo);
  const sales = new SaleService(saleRepo, products);
  return { products, sales, store };
}

describe('rotiseria: cálculo de docenas y promos', () => {
  it('12 empanadas de una misma variedad se cobran al precio de docena', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Carne', priceUnit: 1500, priceDozen: 15000 });

    const result = await sales.createSale(BIZ, ACTOR, [{ name: 'Carne', quantity: 12 }]);
    expect(Number(result.sale.total)).toBe(15000);
    expect(result.pricing.breakdown[0]).toContain('1x Docena');
    expect(result.pricing.breakdown[0]).toContain('15.000');
  });

  it('15 empanadas de una variedad: 1 docena + 3 a precio unitario', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Carne', priceUnit: 1500, priceDozen: 15000 });

    const result = await sales.createSale(BIZ, ACTOR, [{ name: 'Carne', quantity: 15 }]);
    // 1 docena (15000) + 3 unidades (3 * 1500 = 4500) = 19500
    expect(Number(result.sale.total)).toBe(19500);
    expect(result.pricing.breakdown).toEqual(
      expect.arrayContaining([
        expect.stringContaining('1x Docena'),
        expect.stringContaining('3x *Carne* (sueltas)'),
      ])
    );
  });

  it('docena combinada: 7 carne + 5 jamón y queso = 1 docena a precio de docena', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Carne', priceUnit: 1500, priceDozen: 15000 });
    await products.createProduct({ businessId: BIZ, name: 'Jamón y Queso', priceUnit: 1500, priceDozen: 15000 });

    const result = await sales.createSale(BIZ, ACTOR, [
      { name: 'Carne', quantity: 7 },
      { name: 'Jamón y Queso', quantity: 5 },
    ]);
    expect(Number(result.sale.total)).toBe(15000);
  });

  it('docena combinada con remanente: 8 carne + 6 jamón y queso (14 empanadas) = 1 docena + 2 sueltas', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Carne', priceUnit: 1500, priceDozen: 15000 });
    await products.createProduct({ businessId: BIZ, name: 'Jamón y Queso', priceUnit: 1500, priceDozen: 15000 });

    const result = await sales.createSale(BIZ, ACTOR, [
      { name: 'Carne', quantity: 8 },
      { name: 'Jamón y Queso', quantity: 6 },
    ]);
    // 1 docena ($15000) + 2 remanente ($3000) = $18000
    expect(Number(result.sale.total)).toBe(18000);
  });

  it('productos regulares sin docena (pizzas, sándwiches) se calculan a precio unitario', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Pizza Muzzarella', priceUnit: 9000, category: 'pizzas' });
    await products.createProduct({ businessId: BIZ, name: 'Sándwich Milanesa', priceUnit: 8500, category: 'sandwiches' });

    const result = await sales.createSale(BIZ, ACTOR, [
      { name: 'Pizza Muzzarella', quantity: 2 },
      { name: 'Sándwich Milanesa', quantity: 1 },
    ]);
    // 2 * 9000 + 8500 = 26500
    expect(Number(result.sale.total)).toBe(26500);
  });

  it('promos cerradas aplican su precio fijo', async () => {
    const { products, sales } = setupServices();
    await products.createPromo({ businessId: BIZ, name: 'Promo 1', price: 16000, description: 'Muzza + 6 empanadas' });
    await products.createProduct({ businessId: BIZ, name: 'Carne', priceUnit: 1500, priceDozen: 15000 });

    const result = await sales.createSale(BIZ, ACTOR, [
      { name: 'Promo 1', quantity: 1 },
      { name: 'Carne', quantity: 12 },
    ]);
    // 16000 + 15000 = 31000
    expect(Number(result.sale.total)).toBe(31000);
  });
});

describe('rotiseria: jornada gastronómica (turno operativo)', () => {
  it('ventas de noche (23:30 hs) computan a la fecha del día', () => {
    // 2026-10-08 23:30 hs en Argentina (UTC-3 es 2026-10-09 02:30 UTC)
    const nightTime = new Date('2026-10-09T02:30:00Z');
    const shift = getShiftDate(nightTime);
    expect(shift.getUTCDate()).toBe(8);
  });

  it('ventas de madrugada (00:00 a 04:59 AM) computan al día calendario anterior', () => {
    // 2026-10-09 02:15 AM en Argentina (UTC-3 es 2026-10-09 05:15 UTC)
    const earlyMorning = new Date('2026-10-09T05:15:00Z');
    const shift = getShiftDate(earlyMorning);
    // Debe computar al turno de "anoche": 08 de octubre
    expect(shift.getUTCDate()).toBe(8);
  });

  it('ventas a partir de las 05:00 AM computan al día calendario actual', () => {
    // 2026-10-09 05:01 AM en Argentina (UTC-3 es 2026-10-09 08:01 UTC)
    const morningTime = new Date('2026-10-09T08:01:00Z');
    const shift = getShiftDate(morningTime);
    expect(shift.getUTCDate()).toBe(9);
  });

  it('control de días agrupa correctamente según el shiftDate', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 8000 });

    // Venta a las 23:00 del día 8
    await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }], undefined, new Date('2026-10-09T02:00:00Z'));
    // Venta a las 02:00 AM del día 9 (computa a la noche del 8)
    await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }], undefined, new Date('2026-10-09T05:00:00Z'));

    const summary = await sales.getDaySummary(BIZ, undefined, new Date('2026-10-09T05:30:00Z'));
    expect(summary.salesCount).toBe(2);
    expect(summary.salesTotal).toBe(16000);
  });
});

describe('rotiseria: anulación lógica y reportes', () => {
  it('anular venta marca isCancelled: true y la excluye del total de caja', async () => {
    const { products, sales, store } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 8000 });

    const s1 = await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }]);
    const s2 = await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 2 }]);

    expect(store.sales).toHaveLength(2);

    // Anular s2
    const cancelled = await sales.cancelSale(BIZ, ACTOR, s2.sale.id, 'Cliente canceló el pedido');
    expect(cancelled.isCancelled).toBe(true);
    expect(cancelled.cancelReason).toBe('Cliente canceló el pedido');

    // Reporte de caja solo debe sumar s1
    const summary = await sales.getDaySummary(BIZ);
    expect(summary.salesCount).toBe(1);
    expect(summary.salesTotal).toBe(8000);
    expect(summary.cancelledCount).toBe(1);
    expect(summary.cancelledTotal).toBe(16000);
  });

  it('anular la última venta activa por omisión de id', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 8000 });

    await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }]);
    const s2 = await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 2 }]);

    // Anular sin pasar ID
    const cancelled = await sales.cancelSale(BIZ, ACTOR);
    expect(cancelled.id).toBe(s2.sale.id);
    expect(cancelled.isCancelled).toBe(true);
  });

  it('no permite anular una venta ya anulada', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 8000 });

    const s1 = await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }]);
    await sales.cancelSale(BIZ, ACTOR, s1.sale.id);

    await expect(sales.cancelSale(BIZ, ACTOR, s1.sale.id)).rejects.toThrow('ya se encuentra anulada');
  });
});

describe('rotiseria: catálogo base idempotente', () => {
  it('seedBaseCatalog es idempotente y no duplica productos ni promos', async () => {
    const { products, store } = setupServices();

    await products.seedBaseCatalog(BIZ);
    expect(store.products).toHaveLength(5);
    expect(store.promos).toHaveLength(1);

    // Segunda ejecución
    await products.seedBaseCatalog(BIZ);
    expect(store.products).toHaveLength(5);
    expect(store.promos).toHaveLength(1);
  });
});

describe('rotiseria: flujo interactivo por bot (Telegram)', () => {
  function setupFlow(queue: Array<{ action: string; params: Record<string, unknown> }>) {
    const store = newStore();
    const { products, sales } = setupServices(store);
    const actions = buildRotiseriaActions({ products, sales });
    const template: TemplateDefinition = {
      id: 'rotiseria',
      label: 'Rotisería / Sándwiches y Empanadas',
      welcome: () => 'Bienvenido a la rotisería',
      systemPrompt: () => 'sys',
      actions,
      commands: [
        { command: 'venta', action: 'registrar_venta' },
        { command: 'dias', action: 'control_dias' },
        { command: 'stats', action: 'consultar_estadisticas' },
        { command: 'anular', action: 'anular_venta' },
        { command: 'precio', action: 'cambiar_precio' },
      ],
      replyMenu: [
        { label: '📝 Registrar venta', action: 'registrar_venta' },
        { label: '📅 Control de días', action: 'control_dias' },
        { label: '📈 Estadísticas', action: 'consultar_estadisticas' },
        { label: '↩️ Anular venta', action: 'anular_venta' },
        { label: '🏷️ Cambiar precio', action: 'cambiar_precio' },
      ],
      menu: [],
    };

    const businesses = new FakeBusinessRepo();
    const membershipRepo = new FakeMembershipRepo(businesses);
    const conversations = new FakeConversationRepo();
    const auditRepo = new FakeAuditRepo();
    const business = businesses.seed(makeBusiness({ id: BIZ, templateId: 'rotiseria' }));
    const user = { id: ACTOR, telegramId: 'tg-rotiseria', createdAt: NOW, updatedAt: NOW };
    const membership = {
      id: 'mem-rotiseria',
      businessId: BIZ,
      userId: ACTOR,
      role: 'EMPLOYEE' as const,
      lastUsedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    membershipRepo.store.set(membership.id, membership);

    const interpreter = {
      interpret: vi.fn(async (_sys: string, all: ActionDef<unknown>[]) => {
        const next = queue.shift();
        if (!next) throw new Error('sin respuestas de IA');
        const action = all.find((a) => a.name === next.action);
        if (!action) throw new Error(`acción desconocida: ${next.action}`);
        return { action, params: next.params };
      }),
    } as unknown as ActionInterpreter;

    const deps: FlowDeps = {
      template,
      interpreter,
      conversations,
      businesses,
      membershipRepo,
      audit: new AuditService(auditRepo),
      aiUsage: new FakeAiUsageRepo(),
      aiProviderName: 'Mock',
      aiModel: 'mock-1',
    };
    const tenant: TenantContext = { business, membership, user, botTemplateId: 'rotiseria' };
    const resolution: ResolutionInfo = { user, tenant, justJoined: false, memberships: [], needsInvitation: false };
    return { deps, resolution, auditRepo, store, products, sales };
  }

  it('freestyle "1 docena de carne y una muzza" → summarize pide confirmación → yes crea venta y audita', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [
            { nombre: 'Empanada de Carne', cantidad: 12 },
            { nombre: 'Pizza Muzzarella', cantidad: 1 },
          ],
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000 });
    await f.products.createProduct({ businessId: BIZ, name: 'Pizza Muzzarella', priceUnit: 9000 });

    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 docena de carne y una muzza',
      now: NOW,
    });

    expect(ask.text).toContain('¿Confirmar venta?');
    expect(ask.text).toContain('Empanada de Carne');
    expect(ask.text).toContain('Pizza Muzzarella');

    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('Venta registrada por *$ 24.000*');
    expect(f.auditRepo.entries).toHaveLength(1);
    expect(f.auditRepo.entries[0]).toMatchObject({
      action: 'sale.created',
      entityType: 'rotiseria_sale',
      actorUserId: ACTOR,
    });
  });

  it('comando /dias responde directamente sin pedir confirmación', async () => {
    const f = setupFlow([]);
    const reply = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/dias',
      now: NOW,
    });

    expect(reply.text).toContain('Control de días');
    expect(reply.text).toContain('0 pedido');
  });

  it('anular venta mediante comando y confirmación', async () => {
    const f = setupFlow([
      {
        action: 'anular_venta',
        params: { motivo: 'Error de tipeo' },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 5000 });
    await f.sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }]);

    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'anular la última venta',
      now: NOW,
    });

    expect(ask.text).toContain('¿Confirmar anulación de venta?');
    expect(ask.text).toContain('última venta activa');

    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('anulada correctamente');
    expect(f.auditRepo.entries.some((e) => e.action === 'sale.cancelled')).toBe(true);
  });
});
