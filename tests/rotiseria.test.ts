import { describe, expect, it, vi } from 'vitest';
import type { RotiseriaProduct, RotiseriaPromo, RotiseriaSale, RotiseriaSaleItem } from '@prisma/client';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import type { ActionDef } from '../src/core/actions/registry.js';
import type { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { ProductService } from '../src/templates/rotiseria/domain/product.service.js';
import { SaleService } from '../src/templates/rotiseria/domain/sale.service.js';
import { StatsService } from '../src/templates/rotiseria/domain/stats.service.js';
import { getShiftDate, formatShiftLabel } from '../src/templates/rotiseria/domain/shift.js';
import { formatRealDateWithDay } from '../src/templates/rotiseria/format.js';
import { applyModification, parseModificationText } from '../src/templates/rotiseria/domain/modification.js';
import { createRotiseriaTemplate } from '../src/templates/rotiseria/index.js';
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
    lines: Array<{ productId?: string | null; promoId?: string | null; name: string; category?: string; quantity: number; unitPrice: number; subtotal: number }>,
    note?: string
  ): Promise<RotiseriaSaleWithItems> {
    const saleId = nid('sale');
    const items: RotiseriaSaleItem[] = lines.map((l) => ({
      id: nid('item'),
      saleId,
      productId: l.productId ?? null,
      promoId: l.promoId ?? null,
      name: l.name,
      category: l.category ?? 'general',
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
    const targetIso = shiftDate.toISOString().slice(0, 10);
    return this.s.sales.filter(
      (s) => s.businessId === businessId && s.shiftDate.toISOString().slice(0, 10) === targetIso
    );
  }

  async findByDateRange(businessId: string, start: Date, end: Date) {
    return this.s.sales.filter(
      (s) => s.businessId === businessId && s.shiftDate >= start && s.shiftDate <= end
    );
  }

  async findAll(businessId: string) {
    return this.s.sales.filter((s) => s.businessId === businessId);
  }
}

function setupServices(store = newStore()) {
  const productRepo = new FakeRotiseriaProductRepo(store) as unknown as ProductRepository;
  const saleRepo = new FakeRotiseriaSaleRepo(store) as unknown as SaleRepository;
  const products = new ProductService(productRepo);
  const stats = new StatsService(saleRepo);
  const sales = new SaleService(saleRepo, products, stats);
  return { products, sales, stats, store };
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
    expect(Number(result.sale.total)).toBe(18000);
  });

  it('sabores con distintas tarifas de docena calculan sus docenas por separado sin mezclarse erróneamente', async () => {
    const { products, sales } = setupServices();
    // Clásicas: docena 15.000 ($1500 unit)
    await products.createProduct({ businessId: BIZ, name: 'Carne', priceUnit: 1500, priceDozen: 15000, category: 'empanadas' });
    await products.createProduct({ businessId: BIZ, name: 'Pollo', priceUnit: 1500, priceDozen: 15000, category: 'empanadas' });
    // Especiales: docena 22.000 ($2200 unit)
    await products.createProduct({ businessId: BIZ, name: 'Salmón', priceUnit: 2200, priceDozen: 22000, category: 'empanadas' });

    // 6 Carne + 6 Pollo = 1 docena clásica ($15.000)
    // 14 Salmón = 1 docena especial ($22.000) + 2 Salmón sueltas (2 * 2200 = $4.400)
    // Total = 15.000 + 22.000 + 4.400 = 41.400
    const result = await sales.createSale(BIZ, ACTOR, [
      { name: 'Carne', quantity: 6 },
      { name: 'Pollo', quantity: 6 },
      { name: 'Salmón', quantity: 14 },
    ]);

    expect(Number(result.sale.total)).toBe(41400);
    expect(result.pricing.breakdown).toEqual(
      expect.arrayContaining([
        expect.stringContaining('1x Docena (6 Carne, 6 Pollo) — *$ 15.000*'),
        expect.stringContaining('1x Docena (12 Salmón) — *$ 22.000*'),
        expect.stringContaining('2x *Salmón* (sueltas) — *$ 4.400*'),
      ])
    );
  });

  it('productos regulares sin docena (pizzas, sándwiches) se calculan a precio unitario', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Pizza Muzzarella', priceUnit: 9000, category: 'pizzas' });
    await products.createProduct({ businessId: BIZ, name: 'Sándwich Milanesa', priceUnit: 8500, category: 'sandwiches' });

    const result = await sales.createSale(BIZ, ACTOR, [
      { name: 'Pizza Muzzarella', quantity: 2 },
      { name: 'Sándwich Milanesa', quantity: 1 },
    ]);
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
    expect(Number(result.sale.total)).toBe(31000);
  });
});

describe('rotiseria: jornada gastronómica (turno operativo)', () => {
  it('ventas de noche (23:30 hs) computan a la fecha del día', () => {
    const nightTime = new Date('2026-10-09T02:30:00Z');
    const shift = getShiftDate(nightTime);
    expect(shift.getUTCDate()).toBe(8);
  });

  it('ventas de madrugada (00:00 a 04:59 AM) computan al día calendario anterior con fecha real', () => {
    // 02:30 AM en Argentina (05:30 UTC) del 9 de octubre -> computa al 8 de octubre
    const earlyMorning = new Date('2026-10-09T05:30:00Z');
    const shift = getShiftDate(earlyMorning);
    expect(shift.getUTCDate()).toBe(8);

    const label = formatShiftLabel(shift);
    expect(label).toBe('Turno del Jueves 08/10/2026');
    expect(label).not.toContain('ayer');
    expect(label).not.toContain('hoy');
  });

  it('ventas a partir de las 05:00 AM computan al día calendario actual', () => {
    const morningTime = new Date('2026-10-09T08:01:00Z');
    const shift = getShiftDate(morningTime);
    expect(shift.getUTCDate()).toBe(9);
  });

  it('control de días agrupa correctamente según el shiftDate', async () => {
    const { products, sales } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 8000 });

    await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }], undefined, new Date('2026-10-09T02:00:00Z'));
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

    const cancelled = await sales.cancelSale(BIZ, ACTOR, s2.sale.id, 'Cliente canceló el pedido');
    expect(cancelled.isCancelled).toBe(true);
    expect(cancelled.cancelReason).toBe('Cliente canceló el pedido');

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

describe('rotiseria: modificación incremental (applyModification y parseModificationText)', () => {
  it('aplica sumas, reducciones, límites, reemplazos y eliminaciones a un pedido', () => {
    const initial = [
      { name: 'Empanada de Carne', quantity: 12 },
      { name: 'Pizza Muzzarella', quantity: 1 },
    ];

    // 1. Sumar
    const p1 = applyModification(initial, { add: [{ name: 'Empanada de Pollo', quantity: 2 }] });
    expect(p1).toHaveLength(3);
    expect(p1.find((p) => p.name === 'Empanada de Pollo')?.quantity).toBe(2);

    // 2. Reducir cantidad (bajale 2 a carne)
    const p2 = applyModification(p1, { reduce: [{ name: 'carne', quantity: 2 }] });
    expect(p2.find((p) => p.name === 'Empanada de Carne')?.quantity).toBe(10);

    // 3. Fijar cantidad exacta (dejá solo 6 de carne)
    const p3 = applyModification(p2, { setQuantity: [{ name: 'carne', quantity: 6 }] });
    expect(p3.find((p) => p.name === 'Empanada de Carne')?.quantity).toBe(6);

    // 4. Reemplazo con transferencia de cantidad (cambiá carne por jamón y queso)
    const p4 = applyModification(p3, { remove: ['carne'], add: [{ name: 'Jamón y Queso', quantity: 6 }] });
    expect(p4.some((p) => p.name.includes('Carne'))).toBe(false);
    expect(p4.find((p) => p.name === 'Jamón y Queso')?.quantity).toBe(6);

    // 5. Eliminar completamente (sacá la pizza)
    const p5 = applyModification(p4, { remove: ['pizza'] });
    expect(p5.some((p) => p.name.includes('Pizza'))).toBe(false);
    expect(p5).toHaveLength(2); // Jamón y Queso (6) + Pollo (2)
  });

  it('parseModificationText detecta correctamente órdenes de corrección con modismos gastronómicos', () => {
    // Suma
    const p1 = parseModificationText('sumale 2 de pollo');
    expect(p1?.add).toEqual([{ name: 'pollo', quantity: 2 }]);

    // Eliminación total
    const p2 = parseModificationText('sacá la pizza');
    expect(p2?.remove).toEqual(['pizza']);

    const p2b = parseModificationText('sin empanadas');
    expect(p2b?.remove).toEqual(['empanadas']);

    const p2c = parseModificationText('eliminá la muzza');
    expect(p2c?.remove).toEqual(['muzza']);

    // Reducción
    const p3 = parseModificationText('bajale 2 a las empanadas');
    expect(p3?.reduce).toEqual([{ name: 'empanadas', quantity: 2 }]);

    // Cantidad fija
    const p4 = parseModificationText('dejá solo 6 de carne');
    expect(p4?.setQuantity).toEqual([{ name: 'carne', quantity: 6 }]);

    // Reemplazo
    const p5 = parseModificationText('cambiá las de carne por pollo');
    expect(p5?.remove).toEqual(['carne']);
    expect(p5?.add).toEqual([{ name: 'pollo', quantity: 1 }]);

    const p6 = parseModificationText('cambiá 6 de carne por pollo');
    expect(p6?.remove).toEqual(['carne']);
    expect(p6?.add).toEqual([{ name: 'pollo', quantity: 6 }]);
  });
});

describe('rotiseria: estadísticas avanzadas con drill-down', () => {
  it('calcula semana_cerrada (lunes a domingo) y excluye ventas anuladas', async () => {
    const { products, sales, stats } = setupServices();
    await products.createProduct({ businessId: BIZ, name: 'Empanada Carne', priceUnit: 1500, priceDozen: 15000, category: 'empanadas' });
    await products.createProduct({ businessId: BIZ, name: 'Pizza Muzza', priceUnit: 9000, category: 'pizzas' });

    // Jueves 08/10/2026. Semana lunes 05/10 a domingo 11/10
    const thuDate = new Date('2026-10-08T15:00:00Z');
    const monDate = new Date('2026-10-05T15:00:00Z');
    const prevSunday = new Date('2026-10-04T15:00:00Z');

    // Venta lunes 5/10 (en la semana)
    await sales.createSale(BIZ, ACTOR, [{ name: 'Empanada Carne', quantity: 12 }], undefined, monDate);
    // Venta jueves 8/10 (en la semana)
    const sThu = await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza Muzza', quantity: 1 }], undefined, thuDate);
    // Venta domingo 4/10 (fuera de la semana)
    await sales.createSale(BIZ, ACTOR, [{ name: 'Pizza Muzza', quantity: 2 }], undefined, prevSunday);

    // Anular venta del jueves
    await sales.cancelSale(BIZ, ACTOR, sThu.sale.id, 'Error de comanda');

    const summary = await stats.getStats(BIZ, 'semana_cerrada', thuDate);
    // Solo debe sumar la venta activa del lunes
    expect(summary.salesTotal).toBe(15000);
    expect(summary.salesCount).toBe(1);
    expect(summary.cancelledCount).toBe(1);
    expect(summary.top3Products).toHaveLength(1);
    expect(summary.top3Products[0].name).toBe('Empanada Carne');
    expect(summary.categories[0].category).toBe('empanadas');
    expect(summary.productsByCategory['empanadas']).toHaveLength(1);
    expect(summary.productsByCategory['empanadas'][0].name).toBe('Empanada Carne');
  });
});

describe('rotiseria: catálogo base idempotente', () => {
  it('seedBaseCatalog es idempotente y no duplica productos ni promos', async () => {
    const { products, store } = setupServices();

    await products.seedBaseCatalog(BIZ);
    expect(store.products).toHaveLength(5);
    expect(store.promos).toHaveLength(1);

    await products.seedBaseCatalog(BIZ);
    expect(store.products).toHaveLength(5);
    expect(store.promos).toHaveLength(1);
  });
});

describe('rotiseria: flujo interactivo por bot (Telegram)', () => {
  function setupFlow(queue: Array<{ action: string; params: Record<string, unknown> }>) {
    const store = newStore();
    const { products, sales } = setupServices(store);
    const bundle = createRotiseriaTemplate({
      db: {} as any,
      products,
      sales,
    });
    const template = bundle.template;

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
    return { deps, resolution, auditRepo, store, products, sales, conversations, template };
  }

  it('freestyle "1 docena de carne y una muzza" → summarize pide confirmación con 4 botones → yes crea venta y audita', async () => {
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
    // Verifica los 4 botones inline exactos del spec
    expect(ask.inlineKeyboard).toEqual([
      [
        { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
        { text: '❌ Cancelar', callbackData: 'confirm:no' },
      ],
      [
        { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
        { text: '📅 Cambiar fecha', callbackData: 'rotiseria:fecha' },
      ],
    ]);

    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('✅ Venta #');
    expect(confirmed.text).toContain('Total cobrado: *$ 24.000*');
    expect(confirmed.text).toContain('Fecha del turno: *Jueves 08/10/2026*');
    expect(f.auditRepo.entries).toHaveLength(1);
    expect(f.auditRepo.entries[0]).toMatchObject({
      action: 'sale.created',
      entityType: 'rotiseria_sale',
      actorUserId: ACTOR,
    });
  });

  it('ciclo de corrección: rotiseria:modificar pone en COLLECTING y mensaje posterior actualiza el borrador', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Empanada de Carne', cantidad: 12 }],
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000 });

    // 1. Mensaje inicial
    await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 docena de carne',
      now: NOW,
    });

    // 2. Click en "Modificar pedido"
    const modAsk = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:modificar',
      now: NOW,
    });

    expect(modAsk.text).toContain('Detalle del pedido:');
    expect(modAsk.text).toContain('¿Qué modificamos o agregamos?');

    const conv = await f.conversations.get(BIZ, ACTOR);
    expect(conv?.phase).toBe('COLLECTING');
    expect(conv?.data._modifying).toBe(true);

    // 3. Modificación directa determinística: "sumale 2 de carne"
    const updatedAsk = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'sumale 2 de carne',
      now: NOW,
    });

    expect(updatedAsk.text).toContain('Pedido actualizado');
    expect(updatedAsk.text).toContain('1x Docena (12 Empanada de Carne)');
    expect(updatedAsk.text).toContain('2x *Empanada de Carne* (sueltas)');
    expect(updatedAsk.text).toContain('$ 18.000');
    expect(updatedAsk.inlineKeyboard).toBeDefined();

    // 4. Confirmar venta modificada
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    // 1 docena (15000) + 2 remanente (3000) = 18000
    expect(confirmed.text).toContain('Total cobrado: *$ 18.000*');
  });

  it('cambiar fecha: rotiseria:fecha muestra selector y rotiseria:setdate actualiza shiftDate', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Pizza Muzzarella', cantidad: 1 }],
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Pizza Muzzarella', priceUnit: 9000 });

    await handleText(f.deps, {
      resolution: f.resolution,
      text: 'una muzza',
      now: NOW,
    });

    // 1. Click en Cambiar fecha
    const dateMenu = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:fecha',
      now: NOW,
    });

    expect(dateMenu.text).toContain('Seleccioná la fecha operativa');
    expect(dateMenu.inlineKeyboard).toBeDefined();

    // 2. Elegir fecha de ayer
    const picked = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:setdate:2026-10-07',
      now: NOW,
    });

    expect(picked.text).toContain('2026');
    expect(picked.text).toContain('Miércoles 07/10/2026');

    // 3. Confirmar venta con fecha elegida
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('✅ Venta #');
    expect(confirmed.text).toContain('Total cobrado: *$ 9.000*');
    const createdSale = f.store.sales[0];
    expect(createdSale.shiftDate.toISOString()).toContain('2026-10-07');
  });

  it('navegación de estadísticas por 3 niveles: menú -> período -> categorías -> detalle', async () => {
    const f = setupFlow([]);
    await f.products.createProduct({ businessId: BIZ, name: 'Carne', priceUnit: 1500, priceDozen: 15000, category: 'empanadas' });
    await f.products.createProduct({ businessId: BIZ, name: 'Muzza', priceUnit: 9000, category: 'pizzas' });

    await f.sales.createSale(BIZ, ACTOR, [{ name: 'Carne', quantity: 12 }], undefined, NOW);
    await f.sales.createSale(BIZ, ACTOR, [{ name: 'Muzza', quantity: 1 }], undefined, NOW);

    // Nivel 1: Menú selector
    const l1 = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:stats_menu',
      now: NOW,
    });
    expect(l1.text).toContain('Estadísticas del Negocio');
    expect(l1.inlineKeyboard).toBeDefined();

    // Nivel 2: Ver período esta_semana
    const l2 = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:stats:esta_semana',
      now: NOW,
    });
    expect(l2.text).toContain('Facturación neta: *$ 24.000*');
    expect(l2.text).toContain('Top 3 productos más vendidos');
    expect(l2.text).toContain('Desglose por categorías');

    // Nivel 3: Selector de categorías
    const l3Menu = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:catmenu:esta_semana',
      now: NOW,
    });
    expect(l3Menu.text).toContain('Categorías vendidas');

    // Nivel 3: Detalle de categoría empanadas
    const l3Detail = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:catdetail:esta_semana:empanadas',
      now: NOW,
    });
    expect(l3Detail.text).toContain('Detalle: Empanadas');
    expect(l3Detail.text).toContain('Carne');
  });

  it('comando /dias responde directamente sin pedir confirmación', async () => {
    const f = setupFlow([]);
    const reply = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/dias',
      now: NOW,
    });

    expect(reply.text).toContain('Control de días');
    expect(reply.text).toContain('Últimos 7 turnos');
    expect(reply.text).toContain('Sin ventas registradas');
  });

  it('anular venta mediante comando y confirmación interactiva', async () => {
    const f = setupFlow([
      {
        action: 'anular_venta',
        params: {},
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 5000 });
    await f.sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }]);

    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'anular la última venta',
      now: NOW,
    });

    expect(ask.text).toContain('¿Qué venta deseás anular?');
    expect(ask.inlineKeyboard).toEqual([
      [{ text: '↩️ Anular última venta', callbackData: 'rotiseria:anular_ultima' }],
      [{ text: '📋 Elegir de las últimas 5 ventas', callbackData: 'rotiseria:anular_listar' }],
      [{ text: '❌ Cancelar', callbackData: 'rotiseria:anular_cancelar' }],
    ]);

    const askConfirm = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:anular_ultima',
      now: NOW,
    });

    expect(askConfirm.text).toContain('¿Confirmás la anulación de esta venta?');
    expect(askConfirm.text).toContain('Pizza');
    expect(askConfirm.text).toContain('$ 5.000');

    const confirmCb = askConfirm.inlineKeyboard?.[0]?.[0]?.callbackData;
    expect(confirmCb).toMatch(/^rotiseria:anular_confirmar:/);

    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: confirmCb!,
      now: NOW,
    });

    expect(confirmed.text).toContain('anulada correctamente');
    expect(f.auditRepo.entries.some((e) => e.action === 'sale.cancelled')).toBe(true);
  });

  it('modificación interactiva: sacar un producto del pedido ("sacá la pizza") recalcula subtotales y comanda', async () => {
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

    // 1. Mensaje inicial: empanadas + pizza = $24.000
    await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 docena de carne y una muzza',
      now: NOW,
    });

    // 2. Click en Modificar pedido
    const modAsk = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:modificar',
      now: NOW,
    });
    expect(modAsk.text).toContain('Detalle del pedido:');
    expect(modAsk.text).toContain('¿Qué modificamos o agregamos?');

    // 3. Modificación: "sacá la pizza"
    const modUpdated = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'sacá la pizza',
      now: NOW,
    });

    expect(modUpdated.text).toContain('Pedido actualizado');
    expect(modUpdated.text).toContain('1x Docena (12 Empanada de Carne)');
    expect(modUpdated.text).not.toContain('Pizza Muzzarella');
    expect(modUpdated.text).toContain('$ 15.000');

    // 4. Confirmar venta modificada sin pizza
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });
    expect(confirmed.text).toContain('Total cobrado: *$ 15.000*');
    expect(confirmed.text).not.toContain('Pizza Muzzarella');
  });

  it('no_reconocidos: 100% de productos no reconocidos aborta sin crear borrador', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [],
          no_reconocidos: [{ texto: 'chicle bazooka', cantidad: 2 }],
        },
      },
    ]);

    const reply = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'dos chicles bazooka',
      now: NOW,
    });

    expect(reply.text).toContain('⚠️ No reconocí estos productos en la carta:');
    expect(reply.text).toContain('• chicle bazooka');

    // El borrador debe estar limpio (sin draft pendiente)
    const conv = await f.conversations.get(BIZ, ACTOR);
    expect(conv).toBeNull();
  });

  it('no_reconocidos: productos válidos mezclados con no reconocidos muestra viñeta de advertencia', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Pizza Muzzarella', cantidad: 1 }],
          no_reconocidos: [{ texto: 'un marroc', cantidad: 1 }],
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Pizza Muzzarella', priceUnit: 9000 });

    const reply = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'una muzza y un marroc',
      now: NOW,
    });

    expect(reply.text).toContain('¿Confirmar venta?');
    expect(reply.text).toContain('Pizza Muzzarella');
    expect(reply.text).toContain('⚠️ No reconocí *un marroc* (no fue sumado al pedido)');
    expect(reply.inlineKeyboard).toBeDefined();
  });

  it('cambiar fecha: selector dinámico con Turno actual y Ayer, y rechazo de fechas futuras', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Pizza Muzzarella', cantidad: 1 }],
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Pizza Muzzarella', priceUnit: 9000 });

    await handleText(f.deps, {
      resolution: f.resolution,
      text: 'una muzza',
      now: NOW,
    });

    // 1. Abrir selector de fecha
    const dateMenu = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:fecha',
      now: NOW,
    });

    expect(dateMenu.text).toContain('Seleccioná la fecha operativa');
    const flatButtons = dateMenu.inlineKeyboard?.flat().map((b) => b.text) ?? [];
    expect(flatButtons.some((b) => b.includes('(Turno actual)'))).toBe(true);
    expect(flatButtons.some((b) => b.includes('(Ayer)'))).toBe(true);

    // 2. Click en otra fecha manual
    const askDate = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:askdate',
      now: NOW,
    });
    expect(askDate.text).toContain('Escribí la fecha operativa');

    // 3. Enviar fecha futura (debe rebotar)
    const futureErr = await handleText(f.deps, {
      resolution: f.resolution,
      text: '15/10/2026',
      now: NOW,
    });
    expect(futureErr.text).toContain('⚠️ La fecha no puede ser futura');

    // 4. Enviar fecha pasada válida
    const validPast = await handleText(f.deps, {
      resolution: f.resolution,
      text: '07/10/2026',
      now: NOW,
    });
    expect(validPast.text).toContain('Miércoles 07/10/2026');
  });

  it('cambio de precio guiado por categorías hasta actualización en base de datos y auditoría', async () => {
    const f = setupFlow([]);
    const prod = await f.products.createProduct({
      businessId: BIZ,
      name: 'Empanada Salteña',
      priceUnit: 1400,
      priceDozen: 14000,
      category: 'empanadas',
    });

    // 1. Iniciar cambio de precio
    const reply1 = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/precio',
      now: NOW,
    });
    expect(reply1.text).toContain('Cambiar Precios');
    const catCb = reply1.inlineKeyboard?.[0]?.[0]?.callbackData;
    expect(catCb).toBe('rotiseria:price_cat:empanadas');

    // 2. Seleccionar categoría empanadas
    const reply2 = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: catCb!,
      now: NOW,
    });
    expect(reply2.text).toContain('el producto a modificar');
    const prodCb = reply2.inlineKeyboard?.[0]?.[0]?.callbackData;
    expect(prodCb).toBe(`rotiseria:price_prod:${prod.id}`);

    // 3. Seleccionar producto
    const reply3 = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: prodCb!,
      now: NOW,
    });
    expect(reply3.text).toContain('Ingresá el nuevo precio');

    // 4. Escribir nuevos precios "1600 / 17000"
    const updateResult = await handleText(f.deps, {
      resolution: f.resolution,
      text: '1600 / 17000',
      now: NOW,
    });
    expect(updateResult.text).toContain('actualizado a');
    expect(updateResult.text).toContain('$ 1.600');
    expect(updateResult.text).toContain('$ 17.000');

    // Verificar en store
    const updatedProd = await f.products.findProductByName(BIZ, 'Empanada Salteña');
    expect(Number(updatedProd?.priceUnit)).toBe(1600);
    expect(Number(updatedProd?.priceDozen)).toBe(17000);

    // Verificar auditoría
    expect(f.auditRepo.entries.some((e) => e.action === 'product.price_updated')).toBe(true);
  });

  it('control de días semáforo y detalle comanda por comanda interactivo', async () => {
    const f = setupFlow([]);
    await f.products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 8000 });
    await f.sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }], undefined, NOW);

    // 1. Ver control de días
    const reply = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/dias',
      now: NOW,
    });

    expect(reply.text).toContain('🟢 Jueves 08/10/2026: 1 ventas — *$ 8.000*');
    const viewCb = reply.inlineKeyboard?.[0]?.[0]?.callbackData;
    expect(viewCb).toBe('rotiseria:ver_dia:2026-10-08');

    // 2. Click en ver comanda por comanda de ese día
    const detail = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: viewCb!,
      now: NOW,
    });

    expect(detail.text).toContain('Detalle del Jueves 08/10/2026');
    expect(detail.text).toContain('1* ventas | Total recaudado: *$ 8.000*');
    expect(detail.text).toContain('1x Pizza');

    // 3. Volver al semáforo
    const back = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:control_dias_back',
      now: NOW,
    });
    expect(back.text).toContain('Control de días recientes');
  });

  it('anulación interactiva: listar últimas 5 y cancelar operación', async () => {
    const f = setupFlow([]);
    await f.products.createProduct({ businessId: BIZ, name: 'Pizza', priceUnit: 5000 });
    await f.sales.createSale(BIZ, ACTOR, [{ name: 'Pizza', quantity: 1 }]);

    // 1. Abrir menú anulación
    const menu = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'anular venta',
      now: NOW,
    });

    // 2. Elegir listar últimas 5
    const list = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:anular_listar',
      now: NOW,
    });
    expect(list.text).toContain('Seleccioná la venta que querés anular:');
    const viewCb = list.inlineKeyboard?.[0]?.[0]?.callbackData;
    expect(viewCb).toMatch(/^rotiseria:anular_ver:/);

    // 3. Ver venta
    const viewSale = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: viewCb!,
      now: NOW,
    });
    expect(viewSale.text).toContain('¿Confirmás la anulación de esta venta?');

    // 4. Cancelar
    const cancelled = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:anular_cancelar',
      now: NOW,
    });
    expect(cancelled.text).toContain('Operación cancelada');
  });

  it('menú y UX: welcome, replyMenu layout, menuCommands y menu inline están alineados', () => {
    const bundle = createRotiseriaTemplate({ db: {} as any });
    const t = bundle.template;

    // 1. Mensaje de bienvenida
    const welcomeMsg = t.welcome('Rotisería Don Pepe', 'Luciano');
    expect(welcomeMsg).toContain('👋 ¡Hola! Soy el asistente de *Rotisería Don Pepe*.');
    expect(welcomeMsg).toContain('📝 Para registrar ventas, mandame un audio o escribí directo:');
    expect(welcomeMsg).toContain('• "Una docena de salteñas y dos sándwiches de milanesa"');
    expect(welcomeMsg).toContain('• "3 empanadas de pollo y una coca"');
    expect(welcomeMsg).toContain('Tenés los accesos rápidos en los botones de abajo o tocá /menu para ver opciones.');

    // 2. replyMenu (5 botones, layout [1, 2, 2], acción 'registrar_venta')
    expect(t.replyMenuLayout).toEqual([1, 2, 2]);
    expect(t.replyMenu).toEqual([
      { label: '📝 Registrar venta', action: 'registrar_venta' },
      { label: '📅 Control de días', action: 'control_dias' },
      { label: '📈 Estadísticas', action: 'menu_estadisticas' },
      { label: '↩️ Anular venta', action: 'anular_venta' },
      { label: '🏷️ Cambiar precio', action: 'cambiar_precio' },
    ]);

    // 3. menuCommands (7 comandos exactos para el botón azul de Telegram)
    expect(t.menuCommands).toEqual([
      { command: 'venta', description: '📝 Registrar venta' },
      { command: 'dias', description: '📅 Control de días recientes' },
      { command: 'estadisticas', description: '📈 Estadísticas de ventas' },
      { command: 'anular', description: '↩️ Anular última venta' },
      { command: 'precio', description: '🏷️ Modificar precios de la carta' },
      { command: 'menu', description: '📋 Ver carta y promociones vigentes' },
      { command: 'ventas', description: '🧾 Últimas ventas registradas' },
    ]);

    // 4. menu (inline de /menu)
    expect(t.menu.map((m) => m.action)).toEqual([
      'registrar_venta',
      'control_dias',
      'menu_estadisticas',
      'anular_venta',
      'cambiar_precio',
      'consultar_menu',
      'consultar_ventas',
      'crear_producto',
      'crear_promo',
    ]);
  });
});
