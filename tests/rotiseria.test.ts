import { describe, expect, it, vi } from 'vitest';
import type {
  RotiseriaProduct,
  RotiseriaPromo,
  RotiseriaSale,
  RotiseriaSaleItem,
  RotiseriaDeliveryZone,
} from '@prisma/client';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import type { ActionDef } from '../src/core/actions/registry.js';
import type { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { ProductService } from '../src/templates/rotiseria/domain/product.service.js';
import { SaleService } from '../src/templates/rotiseria/domain/sale.service.js';
import { StatsService } from '../src/templates/rotiseria/domain/stats.service.js';
import { DeliveryZoneService } from '../src/templates/rotiseria/domain/delivery-zone.service.js';
import { getShiftDate, formatShiftLabel } from '../src/templates/rotiseria/domain/shift.js';
import { formatRealDateWithDay } from '../src/templates/rotiseria/format.js';
import { applyModification, parseModificationText } from '../src/templates/rotiseria/domain/modification.js';
import { createRotiseriaTemplate } from '../src/templates/rotiseria/index.js';
import type { ProductRepository } from '../src/templates/rotiseria/persistence/product.repo.js';
import type { SaleRepository, RotiseriaSaleWithItems } from '../src/templates/rotiseria/persistence/sale.repo.js';
import type { DeliveryZoneRepository } from '../src/templates/rotiseria/persistence/delivery-zone.repo.js';
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
  deliveryZones: RotiseriaDeliveryZone[];
}

function newStore(): RotiseriaStore {
  return { products: [], promos: [], sales: [], deliveryZones: [] };
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

  async listPromos(businessId: string, options: { includeInactive?: boolean } = {}) {
    return this.s.promos.filter((p) => p.businessId === businessId && (options.includeInactive ? true : p.isActive));
  }

  async updatePromo(
    id: string,
    _b: string,
    data: { name?: string; description?: string; price?: number; isActive?: boolean }
  ) {
    const pr = this.s.promos.find((x) => x.id === id);
    if (!pr) throw new Error('no encontrado');
    if (data.name !== undefined) pr.name = data.name.trim();
    if (data.description !== undefined) pr.description = data.description?.trim() || null;
    if (data.price !== undefined) pr.price = data.price as unknown as RotiseriaPromo['price'];
    if (data.isActive !== undefined) pr.isActive = data.isActive;
    return pr;
  }

  async deactivatePromo(id: string) {
    const pr = this.s.promos.find((x) => x.id === id);
    if (!pr) throw new Error('no encontrado');
    pr.isActive = false;
    return pr;
  }
}

class FakeRotiseriaDeliveryZoneRepo implements Partial<DeliveryZoneRepository> {
  constructor(private readonly s: RotiseriaStore) {}

  async createZone(data: { businessId: string; name: string; price: number; barrios?: string[] }) {
    const z: RotiseriaDeliveryZone = {
      id: nid('zone'),
      businessId: data.businessId,
      name: data.name.trim(),
      price: data.price as unknown as RotiseriaDeliveryZone['price'],
      barrios: data.barrios?.map((b) => b.trim().toLowerCase()).filter(Boolean) ?? [],
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.s.deliveryZones.push(z);
    return z;
  }

  async upsertBatch(businessId: string, zones: Array<{ name?: string; nombre?: string; price?: number; precio?: number; barrios: string[] }>) {
    const results: RotiseriaDeliveryZone[] = [];
    for (const item of zones) {
      const name = (item.name ?? item.nombre ?? '').trim();
      const price = item.price ?? item.precio ?? 0;
      let existing = this.s.deliveryZones.find(
        (z) => z.businessId === businessId && z.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        existing.price = price as unknown as RotiseriaDeliveryZone['price'];
        existing.barrios = item.barrios.map((b) => b.trim().toLowerCase()).filter(Boolean);
        existing.isActive = true;
      } else {
        existing = {
          id: nid('zone'),
          businessId,
          name,
          price: price as unknown as RotiseriaDeliveryZone['price'],
          barrios: item.barrios.map((b) => b.trim().toLowerCase()).filter(Boolean),
          isActive: true,
          createdAt: NOW,
          updatedAt: NOW,
        };
        this.s.deliveryZones.push(existing);
      }
      results.push(existing);
    }
    return results;
  }

  async listActive(businessId: string) {
    return this.s.deliveryZones.filter((z) => z.businessId === businessId && z.isActive);
  }

  async findByName(businessId: string, name: string) {
    return (
      this.s.deliveryZones.find(
        (z) => z.businessId === businessId && z.name.toLowerCase() === name.trim().toLowerCase() && z.isActive
      ) ?? null
    );
  }

  async findMatching(businessId: string, query: string) {
    const norm = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (!norm) return null;
    const active = await this.listActive(businessId);

    const exactName = active.find(
      (z) => z.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim() === norm
    );
    if (exactName) return exactName;

    const exactBarrio = active.find((z) =>
      z.barrios.some((b) => b.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim() === norm)
    );
    if (exactBarrio) return exactBarrio;

    const subName = active.find((z) => {
      const zNorm = z.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      return norm.includes(zNorm) || zNorm.includes(norm);
    });
    if (subName) return subName;

    const subBarrio = active.find((z) =>
      z.barrios.some((b) => {
        const bNorm = b.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        return norm.includes(bNorm) || bNorm.includes(norm);
      })
    );
    if (subBarrio) return subBarrio;

    return null;
  }

  async findById(id: string, businessId: string) {
    return this.s.deliveryZones.find((x) => x.id === id && x.businessId === businessId) ?? null;
  }

  async updateZone(id: string, businessId: string, data: { name?: string; price?: number; barrios?: string[]; isActive?: boolean }) {
    const z = this.s.deliveryZones.find((x) => x.id === id && x.businessId === businessId);
    if (!z) throw new Error('no encontrado');
    if (data.name !== undefined) z.name = data.name.trim();
    if (data.price !== undefined) z.price = data.price as unknown as RotiseriaDeliveryZone['price'];
    if (data.barrios !== undefined) z.barrios = data.barrios.map((b) => b.trim().toLowerCase()).filter(Boolean);
    if (data.isActive !== undefined) z.isActive = data.isActive;
    return z;
  }

  async deactivate(id: string, businessId: string) {
    const z = this.s.deliveryZones.find((x) => x.id === id && x.businessId === businessId);
    if (!z) throw new Error('no encontrado');
    z.isActive = false;
    return z;
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
    note?: string,
    deliveryZoneName?: string | null,
    deliveryFee?: number | null
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
      deliveryZoneName: deliveryZoneName?.trim() || null,
      deliveryFee: deliveryFee !== undefined && deliveryFee !== null ? (deliveryFee as unknown as RotiseriaSale['deliveryFee']) : null,
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

  async getDeliveryStats(businessId: string, sinceDate?: Date) {
    const active = this.s.sales.filter(
      (s) =>
        s.businessId === businessId &&
        !s.isCancelled &&
        s.deliveryFee !== null &&
        s.deliveryFee !== undefined &&
        (!sinceDate || s.shiftDate >= sinceDate)
    );

    const byZone = new Map<string, { count: number; totalDeliveryFee: number }>();
    for (const sale of active) {
      const zoneName = sale.deliveryZoneName?.trim() || 'General / Sin especificar';
      const fee = Number(sale.deliveryFee ?? 0);
      const current = byZone.get(zoneName) ?? { count: 0, totalDeliveryFee: 0 };
      current.count += 1;
      current.totalDeliveryFee = Math.round((current.totalDeliveryFee + fee) * 100) / 100;
      byZone.set(zoneName, current);
    }

    return Array.from(byZone.entries())
      .map(([zoneName, data]) => ({
        zoneName,
        count: data.count,
        totalDeliveryFee: data.totalDeliveryFee,
      }))
      .sort((a, b) => b.count - a.count || b.totalDeliveryFee - a.totalDeliveryFee);
  }
}

function setupServices(store = newStore()) {
  const productRepo = new FakeRotiseriaProductRepo(store) as unknown as ProductRepository;
  const saleRepo = new FakeRotiseriaSaleRepo(store) as unknown as SaleRepository;
  const deliveryZoneRepo = new FakeRotiseriaDeliveryZoneRepo(store) as unknown as DeliveryZoneRepository;
  const products = new ProductService(productRepo);
  const stats = new StatsService(saleRepo);
  const sales = new SaleService(saleRepo, products, stats);
  const deliveryZones = new DeliveryZoneService(deliveryZoneRepo);
  return { products, sales, stats, deliveryZones, store };
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
    expect(store.products).toHaveLength(0);
    expect(store.promos).toHaveLength(0);

    await products.seedBaseCatalog(BIZ);
    expect(store.products).toHaveLength(0);
    expect(store.promos).toHaveLength(0);
  });
});

function setupFlow(queue: Array<{ action: string; params: Record<string, unknown> }>) {
  const store = newStore();
  const { products, sales, deliveryZones } = setupServices(store);
  const bundle = createRotiseriaTemplate({
    db: {} as any,
    products,
    sales,
    deliveryZones,
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
  return { deps, resolution, auditRepo, store, products, sales, deliveryZones, conversations, template };
}

describe('rotiseria: flujo interactivo por bot (Telegram)', () => {

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
    expect(ask.inlineKeyboard).toEqual([
      [
        { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
        { text: '❌ Cancelar', callbackData: 'confirm:no' },
      ],
      [
        { text: '🛵 Envíos', callbackData: 'rotiseria:flete_menu' },
        { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
      ],
      [
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
      [
        { text: '📋 Últimas 5 ventas', callbackData: 'rotiseria:anular_listar:5' },
        { text: '📋 Últimas 10 ventas', callbackData: 'rotiseria:anular_listar:10' },
      ],
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
    expect(welcomeMsg).toContain('👋 ¡Hola! Qué lindo tenerte por acá.');
    expect(welcomeMsg).toContain('Soy tu asistente para *Rotisería Don Pepe*');
    expect(welcomeMsg).toContain('🎙️ *¿Cómo funciona? Es muy fácil:*');
    expect(welcomeMsg).toContain('👉 _"1 docena de carne y una de pollo con envío a Tres Cerritos"_');
    expect(welcomeMsg).toContain('Abajo te dejo los botones rápidos para que los uses cuando quieras 👇');

    // 2. replyMenu (5 botones, layout [1, 2, 2], acción 'registrar_venta')
    expect(t.replyMenuLayout).toEqual([1, 2, 2]);
    expect(t.replyMenu).toEqual([
      { label: '📝 Registrar venta', action: 'registrar_venta' },
      { label: '📅 Control de días', action: 'control_dias' },
      { label: '📈 Estadísticas', action: 'menu_estadisticas' },
      { label: '↩️ Anular venta', action: 'anular_venta' },
      { label: '🏷️ Cambiar precio', action: 'cambiar_precio' },
    ]);

    // 3. menuCommands (comandos del menú azul de Telegram)
    expect(t.menuCommands).toEqual([
      { command: 'venta', description: '📝 Registrar venta' },
      { command: 'promo', description: '🎁 Gestionar promociones' },
      { command: 'comida', description: '➕ Crear comida' },
      { command: 'precio', description: '🏷️ Modificar precios de la carta' },
      { command: 'envios', description: '🛵 Envíos a domicilio y tarifas' },
      { command: 'dias', description: '📅 Control de días recientes' },
      { command: 'estadisticas', description: '📈 Estadísticas de ventas' },
      { command: 'ventas', description: '🧾 Últimas ventas registradas' },
      { command: 'anular', description: '↩️ Anular última venta' },
      { command: 'carta', description: '📋 Ver carta y promociones vigentes' },
    ]);

    // 4. menu (inline de /menu)
    expect(t.menu.map((m) => m.action)).toEqual([
      'registrar_venta',
      'crear_editar_promo',
      'control_dias',
      'menu_estadisticas',
      'anular_venta',
      'cambiar_precio',
      'gestionar_envios',
      'consultar_carta',
      'consultar_ventas',
      'crear_producto',
    ]);
  });


  it('desambiguación interactiva: sugerencia con resolver suma producto y recalcula docenas', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [],
          no_reconocidos: [
            { texto: 'carneee', cantidad: 12, sugerencia: 'Empanada de Carne' },
          ],
        },
      },
    ]);

    await f.products.createProduct({
      businessId: BIZ,
      name: 'Empanada de Carne',
      priceUnit: 1500,
      priceDozen: 15000,
      category: 'empanadas',
    });

    // 1. Mensaje con término dudoso
    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: '12 de carneee',
      now: NOW,
    });

    expect(ask.text).toContain('Dudoso: *carneee* (¿quisiste decir *Empanada de Carne*?)');
    const flatButtons = ask.inlineKeyboard?.flat() ?? [];
    const resolverBtn = flatButtons.find((b) => b.callbackData.startsWith('rotiseria:resolver:'));
    const ignoreBtn = flatButtons.find((b) => b.callbackData.startsWith('rotiseria:ignorar:'));

    expect(resolverBtn).toBeDefined();
    expect(resolverBtn?.text).toContain('¿Era Empanada de Carne? (12 u.)');
    expect(ignoreBtn).toBeDefined();

    // 2. Click en resolver
    const resolved = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: resolverBtn!.callbackData,
      now: NOW,
    });

    expect(resolved.text).toContain('1x Docena (12 Empanada de Carne)');
    expect(resolved.text).toContain('$ 15.000');
    expect(resolved.text).not.toContain('Dudoso');

    // 3. Confirmar la venta ya resuelta
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('Total cobrado: *$ 15.000*');
    expect(f.store.sales).toHaveLength(1);
    expect(Number(f.store.sales[0].total)).toBe(15000);
  });

  it('desambiguación interactiva: ignorar ítem descarta el pedido si no quedan productos válidos', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [],
          no_reconocidos: [
            { texto: 'carneee', cantidad: 12, sugerencia: 'Empanada de Carne' },
          ],
        },
      },
    ]);

    await f.products.createProduct({
      businessId: BIZ,
      name: 'Empanada de Carne',
      priceUnit: 1500,
      priceDozen: 15000,
    });

    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: '12 de carneee',
      now: NOW,
    });

    const ignoreBtn = ask.inlineKeyboard?.flat().find((b) => b.callbackData.startsWith('rotiseria:ignorar:'));
    expect(ignoreBtn).toBeDefined();

    const ignored = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: ignoreBtn!.callbackData,
      now: NOW,
    });

    expect(ignored.text).toContain('❌ Pedido cancelado al no contener productos de la carta.');
    const conv = await f.conversations.get(BIZ, ACTOR);
    expect(conv).toBeNull();
  });

  it('gestión integral de promociones: listar, crear, editar precio, descripción y pausar/activar', async () => {
    const f = setupFlow([]);

    // 1. Listar promos vacías
    const listEmpty = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/promo',
      now: NOW,
    });
    expect(listEmpty.text).toContain('Gestión de Promociones');
    expect(listEmpty.inlineKeyboard?.[0]?.[0]?.text).toContain('➕ Crear nueva promo');

    // 2. Click en nueva promo
    const askNew = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:promo:nueva',
      now: NOW,
    });
    expect(askNew.text).toContain('Nueva Promoción');

    // 3. Crear promo vía texto directo delimitado con pipes
    const createdResult = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'Promo 2 | 18000 | 1 Pizza Especial + 6 Empanadas',
      now: NOW,
    });
    expect(createdResult.text).toContain('Promo *Promo 2* creada por *$ 18.000*.');
    expect(f.auditRepo.entries.some((e) => e.action === 'promo.created')).toBe(true);

    const promoCreated = await f.products.findPromoByName(BIZ, 'Promo 2');
    expect(promoCreated).toBeDefined();
    expect(Number(promoCreated?.price)).toBe(18000);
    expect(promoCreated?.isActive).toBe(true);

    // 4. Ver ficha de la promo creada
    const card = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: `rotiseria:promo:editar:${promoCreated!.id}`,
      now: NOW,
    });
    expect(card.text).toContain('Promo: Promo 2');
    expect(card.text).toContain('$ 18.000');
    expect(card.text).toContain('1 Pizza Especial');
    expect(card.text).toContain('Activa');

    // 5. Cambiar precio de la promo
    await handleCallback(f.deps, {
      resolution: f.resolution,
      data: `rotiseria:promo:edit_price:${promoCreated!.id}`,
      now: NOW,
    });
    const priceUpdated = await handleText(f.deps, {
      resolution: f.resolution,
      text: '19500',
      now: NOW,
    });
    expect(priceUpdated.text).toContain('actualizado a *$ 19.500*');
    expect(f.auditRepo.entries.some((e) => e.action === 'promo.price_updated')).toBe(true);

    // 6. Cambiar descripción de la promo
    await handleCallback(f.deps, {
      resolution: f.resolution,
      data: `rotiseria:promo:edit_desc:${promoCreated!.id}`,
      now: NOW,
    });
    const descUpdated = await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 Pizza Napolitana + 6 Empanadas',
      now: NOW,
    });
    expect(descUpdated.text).toContain('1 Pizza Napolitana');
    expect(f.auditRepo.entries.some((e) => e.action === 'promo.updated')).toBe(true);

    // 7. Pausar / desactivar promo
    const deactivated = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: `rotiseria:promo:deactivate:${promoCreated!.id}`,
      now: NOW,
    });
    expect(deactivated.text).toContain('Pausada');
    expect(f.auditRepo.entries.some((e) => e.action === 'promo.deactivated')).toBe(true);

    const promoPausada = await f.products.findPromoById(promoCreated!.id, BIZ);
    expect(promoPausada?.isActive).toBe(false);

    // 8. Reactivar promo
    const reactivated = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: `rotiseria:promo:activate:${promoCreated!.id}`,
      now: NOW,
    });
    expect(reactivated.text).toContain('Activa');
    expect(f.auditRepo.entries.some((e) => e.action === 'promo.activated')).toBe(true);
  });

  it('inmutabilidad histórica de promos en estadísticas: cambiar precio de promo no altera ventas pasadas', async () => {
    const f = setupFlow([]);

    // 1. Crear promo inicial a $16.000
    const promo = await f.products.createPromo({
      businessId: BIZ,
      name: 'Promo 1',
      price: 16000,
      description: 'Muzza + 6 empanadas',
    });

    // 2. Registrar venta con Promo 1 a $16.000
    await f.sales.createSale(BIZ, ACTOR, [{ name: 'Promo 1', quantity: 2 }], undefined, NOW);

    // 3. Modificar precio vigente de la promo a $22.000
    await f.products.updatePromo(promo.id, BIZ, { price: 22000 });

    // 4. Consultar estadísticas: deben reflejar los $32.000 históricos exactos
    const stats = await f.sales.getStatsSummary(BIZ, 'esta_semana', NOW);
    expect(stats.salesTotal).toBe(32000);
    expect(stats.salesCount).toBe(1);
    expect(stats.promosSummary).toBeDefined();
    expect(stats.promosSummary?.totalQuantity).toBe(2);
    expect(stats.promosSummary?.totalAmount).toBe(32000);
    expect(stats.promosSummary?.promos[0].name).toBe('Promo 1');
    expect(stats.promosSummary?.promos[0].subtotal).toBe(32000);

    // 5. Formato en pantalla con sección Promos vendidas
    const statsReply = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/stats',
      now: NOW,
    });
    const statsDetail = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:stats:esta_semana',
      now: NOW,
    });
    expect(statsDetail.text).toContain('🎁 *Promos vendidas:*');
    expect(statsDetail.text).toContain('Promo 1*: 2 u. — *$ 32.000*');
    expect(statsDetail.text).toContain('Total combos: *2* u. (*$ 32.000*)');
  });

  it('historial de ventas interactivo (selector 5 vs 10 ventas)', async () => {
    const f = setupFlow([]);
    await f.products.createProduct({ businessId: BIZ, name: 'Empanada', priceUnit: 1500 });

    // Crear 8 ventas
    for (let i = 1; i <= 8; i++) {
      await f.sales.createSale(BIZ, ACTOR, [{ name: 'Empanada', quantity: i }], undefined, NOW);
    }

    // 1. Consulta inicial: muestra 5 ventas y botón de ver 10
    const view5 = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/ventas',
      now: NOW,
    });
    expect(view5.text).toContain('Últimas 5 ventas');
    const flatButtons = view5.inlineKeyboard?.flat() ?? [];
    const btn10 = flatButtons.find((b) => b.callbackData === 'rotiseria:historial:10');
    expect(btn10).toBeDefined();
    expect(btn10?.text).toContain('Ver últimas 10 ventas');

    // 2. Click en ver 10 ventas: muestra 8 ventas (todas las existentes) y botón de volver a 5
    const view10 = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:historial:10',
      now: NOW,
    });
    expect(view10.text).toContain('Últimas 8 ventas');
    const flatButtons10 = view10.inlineKeyboard?.flat() ?? [];
    const btn5 = flatButtons10.find((b) => b.callbackData === 'rotiseria:historial:5');
    expect(btn5).toBeDefined();
    expect(btn5?.text).toContain('Ver últimas 5 ventas');

    // 3. Volver a 5 ventas
    const back5 = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:historial:5',
      now: NOW,
    });
    expect(back5.text).toContain('Últimas 5 ventas');

    // 4. Cerrar historial
    const closed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:historial:cerrar',
      now: NOW,
    });
    expect(closed.text).toContain('Operación cerrada');
  });
});

describe('rotiseria: zonas de envío y flete (delivery)', () => {
  it('Caso 1: cotización con zona de catálogo suma flete y detalla desglose', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Empanada de Carne', cantidad: 12 }],
          zona_envio: 'Tres Cerritos',
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000 });
    await f.deliveryZones.createZone({ businessId: BIZ, name: 'Tres Cerritos', price: 2500, barrios: ['tres cerritos', 'chachapoyas'] });

    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 docena de carne con envío a Tres Cerritos',
      now: NOW,
    });

    expect(ask.text).toContain('Detalle del pedido');
    expect(ask.text).toContain('1x Docena (12 Empanada de Carne) — *$ 15.000*');
    expect(ask.text).toContain('🛵 Envío (Tres Cerritos): *$ 2.500*');
    expect(ask.text).toContain('Total:* *$ 17.500*');

    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('Total cobrado: *$ 17.500*');
    expect(confirmed.text).toContain('🛵 Envío (Tres Cerritos): *$ 2.500*');
    expect(f.store.sales[0].deliveryZoneName).toBe('Tres Cerritos');
    expect(Number(f.store.sales[0].deliveryFee)).toBe(2500);
  });

  it('Caso 2: envío bonificado ($0 / gratis) registra deliveryFee: 0 y no null', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Empanada de Carne', cantidad: 12 }],
          zona_envio: 'Microcentro',
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000 });
    await f.deliveryZones.createZone({ businessId: BIZ, name: 'Microcentro', price: 0, barrios: ['centro', 'plaza 9 de julio'] });

    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 docena de carne al centro',
      now: NOW,
    });

    expect(ask.text).toContain('🛵 Envío (Microcentro): ¡GRATIS! ($0)');
    expect(ask.text).toContain('Total:* *$ 15.000*');

    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('Total cobrado: *$ 15.000*');
    expect(confirmed.text).toContain('🛵 Envío (Microcentro): ¡GRATIS! ($0)');
    expect(f.store.sales[0].deliveryZoneName).toBe('Microcentro');
    expect(Number(f.store.sales[0].deliveryFee)).toBe(0);
  });

  it('Caso 3: barrio desconocido solicita asignación de flete y recalcula al recibir monto', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Empanada de Carne', cantidad: 12 }],
          zona_no_reconocida: 'Barrio Aeropuerto',
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000 });

    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 docena de carne para mandar a Barrio Aeropuerto',
      now: NOW,
    });

    expect(ask.text).toContain('Zona de envío no reconocida: "*Barrio Aeropuerto*" (flete no asignado)');
    expect(ask.text).toContain('Total:* *$ 15.000*');
    const flatButtons = ask.inlineKeyboard?.flat() ?? [];
    const btnAsignar = flatButtons.find((b) => b.callbackData?.startsWith('rotiseria:asignar_flete:'));
    expect(btnAsignar).toBeDefined();
    expect(btnAsignar?.text).toContain("Asignar flete a 'Barrio Aeropuerto'");

    // 1. Toca botón de asignar flete
    const promptFee = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: btnAsignar!.callbackData!,
      now: NOW,
    });
    expect(promptFee.text).toContain('Asignar Flete a "Barrio Aeropuerto"');

    // 2. Envía monto manual 2000
    const askUpdated = await handleText(f.deps, {
      resolution: f.resolution,
      text: '2000',
      now: NOW,
    });

    expect(askUpdated.text).toContain('🛵 Envío (Barrio Aeropuerto): *$ 2.000*');
    expect(askUpdated.text).toContain('Total:* *$ 17.000*');

    // 3. Confirma venta
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });
    expect(confirmed.text).toContain('Total cobrado: *$ 17.000*');
    expect(Number(f.store.sales[0].deliveryFee)).toBe(2000);
    expect(f.store.sales[0].deliveryZoneName).toBe('Barrio Aeropuerto');
  });

  it('Caso 4: configuración de envíos en lote (configurar_envios_lote) persiste zonas y barrios en minúsculas', async () => {
    const { deliveryZones, store } = setupServices();

    const zonesData = [
      {
        nombre: 'Centro',
        precio: 1500,
        barrios: ['Microcentro', 'Plaza 9 de Julio'],
      },
      {
        nombre: 'Zona Norte',
        precio: 2500,
        barrios: ['Tres Cerritos', 'Parque Belgrano'],
      },
      {
        nombre: 'Zona Sur',
        precio: 0,
        barrios: ['San Carlos', 'Limache'],
      },
    ];

    const result = await deliveryZones.upsertBatch(BIZ, zonesData);
    expect(result).toHaveLength(3);
    expect(store.deliveryZones).toHaveLength(3);

    const sur = await deliveryZones.findMatching(BIZ, 'limache');
    expect(sur).toBeDefined();
    expect(sur?.name).toBe('Zona Sur');
    expect(sur?.price).toBe(0);

    const norte = await deliveryZones.findMatching(BIZ, 'TRES CERRITOS');
    expect(norte).toBeDefined();
    expect(norte?.name).toBe('Zona Norte');
    expect(norte?.price).toBe(2500);

    // Matching con acentos / diacríticos
    const centro = await deliveryZones.findMatching(BIZ, 'Plaza 9 de Júlio');
    expect(centro).toBeDefined();
    expect(centro?.name).toBe('Centro');
  });

  it('Caso 5: segregación contable de comida vs flete en estadísticas y resumen de turno', async () => {
    const { products, sales, deliveryZones } = setupServices();

    await products.createProduct({ businessId: BIZ, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000 });
    await deliveryZones.createZone({ businessId: BIZ, name: 'Tres Cerritos', price: 2500, barrios: [] });
    await deliveryZones.createZone({ businessId: BIZ, name: 'Centro', price: 0, barrios: [] });

    // Venta 1: 1 docena ($15.000) + flete $2.500 = $17.500 (Delivery)
    await sales.createSale(
      BIZ,
      ACTOR,
      [{ name: 'Empanada de Carne', quantity: 12 }],
      undefined,
      NOW,
      'America/Argentina/Buenos_Aires',
      undefined,
      { fee: 2500, zoneName: 'Tres Cerritos' }
    );

    // Venta 2: 1 docena ($15.000) + flete $0 = $15.000 (Delivery bonificado)
    await sales.createSale(
      BIZ,
      ACTOR,
      [{ name: 'Empanada de Carne', quantity: 12 }],
      undefined,
      NOW,
      'America/Argentina/Buenos_Aires',
      undefined,
      { fee: 0, zoneName: 'Centro' }
    );

    // Venta 3: 1 docena ($15.000) sin flete (Mostrador)
    await sales.createSale(
      BIZ,
      ACTOR,
      [{ name: 'Empanada de Carne', quantity: 12 }],
      undefined,
      NOW,
      'America/Argentina/Buenos_Aires',
      undefined,
      undefined
    );

    // DaySummary
    const day = await sales.getDaySummary(BIZ, undefined, NOW);
    expect(day.salesCount).toBe(3);
    expect(day.salesTotal).toBe(47500); // 17500 + 15000 + 15000
    expect(day.foodTotal).toBe(45000); // 15000 + 15000 + 15000 (cero contaminación de flete)
    expect(day.deliveryTotal).toBe(2500);
    expect(day.deliveryOrdersCount).toBe(2); // Venta 1 y Venta 2 tuvieron flete/delivery

    // StatsSummary
    const stats = await sales.getStatsSummary(BIZ, 'esta_semana', NOW);
    expect(stats.salesTotal).toBe(47500);
    expect(stats.foodTotal).toBe(45000);
    expect(stats.deliveryTotal).toBe(2500);
    expect(stats.deliveryOrdersCount).toBe(2);
    // AverageTicket computado sobre foodTotal (45000 / 3 = 15000)
    expect(stats.averageTicket).toBe(15000);
  });

  it('Caso 6: quitar flete vía callback restablece a retiro en mostrador', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Empanada de Carne', cantidad: 12 }],
          zona_envio: 'Tres Cerritos',
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000 });
    await f.deliveryZones.createZone({ businessId: BIZ, name: 'Tres Cerritos', price: 2500, barrios: [] });

    // 1. Inicia pedido con flete
    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 docena de carne a Tres Cerritos',
      now: NOW,
    });
    expect(ask.text).toContain('Total:* *$ 17.500*');

    // 2. Ejecuta callback rotiseria:flete_quitar
    const removed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:flete_quitar',
      now: NOW,
    });

    expect(removed.text).not.toContain('🛵 Envío');
    expect(removed.text).toContain('Total:* *$ 15.000*');

    // 3. Confirma la venta
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });
    expect(confirmed.text).toContain('Total cobrado: *$ 15.000*');
    expect(f.store.sales[0].deliveryFee).toBeNull();
    expect(f.store.sales[0].deliveryZoneName).toBeNull();
  });
});

describe('rotiseria: productos no catalogados y anulación de 10 ventas', () => {
  it('Caso 1: pedido con producto no catalogado se cotiza a $0 sin error y se confirma', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Flan Casero', cantidad: 1 }],
        },
      },
    ]);

    const ask = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'un flan casero',
      now: NOW,
    });

    expect(ask.text).toContain('Flan Casero');
    expect(ask.text).toContain('$0 (⚠️ Ítem especial / sin precio en carta)');
    expect(ask.text).toContain('Total:* *$ 0*');
    const flatButtons = ask.inlineKeyboard?.flat() ?? [];
    const btnAsignar = flatButtons.find((b) => b.callbackData === 'rotiseria:precio_item:0');
    expect(btnAsignar).toBeDefined();
    expect(btnAsignar?.text).toContain("Asignar precio a 'Flan Casero'");

    // Confirma la venta directamente sin asignarle precio
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('Total cobrado: *$ 0*');
    expect(f.store.sales).toHaveLength(1);
    expect(f.store.sales[0].items).toHaveLength(1);
    const item = f.store.sales[0].items[0];
    expect(item.name).toBe('Flan Casero');
    expect(item.productId).toBeNull();
    expect(item.promoId).toBeNull();
    expect(item.category).toBe('especial');
    expect(Number(item.unitPrice)).toBe(0);
    expect(Number(item.subtotal)).toBe(0);
  });

  it('Caso 2: modificación interactiva agregando producto libre y asignando precio numérico', async () => {
    const f = setupFlow([
      {
        action: 'registrar_venta',
        params: {
          items: [{ nombre: 'Empanada de Carne', cantidad: 12 }],
        },
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Empanada de Carne', priceUnit: 1500, priceDozen: 15000 });

    // 1. Pedido inicial: 12 empanadas de carne ($15.000)
    await handleText(f.deps, {
      resolution: f.resolution,
      text: '1 docena de carne',
      now: NOW,
    });

    // 2. Toca modificar
    await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:modificar',
      now: NOW,
    });

    // 3. Modifica agregando producto no catalogado "sumale 2 flanes"
    const modAsk = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'sumale 2 flanes',
      now: NOW,
    });

    expect(modAsk.text.toLowerCase()).toContain('flanes');
    expect(modAsk.text).toContain('$0 (⚠️ Ítem especial / sin precio en carta)');
    expect(modAsk.text).toContain('Total:* *$ 15.000*');
    const flatButtons = modAsk.inlineKeyboard?.flat() ?? [];
    const btnPrecio = flatButtons.find((b) => b.callbackData === 'rotiseria:precio_item:1');
    expect(btnPrecio).toBeDefined();

    // 4. Toca botón de asignar precio al flan (índice 1)
    const promptPrecio = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:precio_item:1',
      now: NOW,
    });
    expect(promptPrecio.text.toLowerCase()).toContain('flanes');

    // 5. Envía precio 1200
    const updatedAsk = await handleText(f.deps, {
      resolution: f.resolution,
      text: '1200',
      now: NOW,
    });

    expect(updatedAsk.text.toLowerCase()).toContain('flanes');
    expect(updatedAsk.text).toContain('Total:* *$ 17.400*');

    // 6. Confirma la venta
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });

    expect(confirmed.text).toContain('Total cobrado: *$ 17.400*');
    expect(f.store.sales[0].items).toHaveLength(2);
    const flanItem = f.store.sales[0].items.find((it) => it.name.toLowerCase() === 'flanes');
    expect(flanItem).toBeDefined();
    expect(flanItem?.productId).toBeNull();
    expect(flanItem?.category).toBe('especial');
    expect(Number(flanItem?.unitPrice)).toBe(1200);
    expect(Number(flanItem?.subtotal)).toBe(2400);
  });

  it('Caso 3: flujo de anulación con lote de 10 ventas y exclusión de ventas ya anuladas', async () => {
    const f = setupFlow([
      {
        action: 'anular_venta',
        params: {},
      },
    ]);

    await f.products.createProduct({ businessId: BIZ, name: 'Empanada', priceUnit: 1500 });

    // Crear 10 ventas consecutivas
    for (let i = 1; i <= 10; i++) {
      await f.sales.createSale(BIZ, ACTOR, [{ name: 'Empanada', quantity: i }], `Venta ${i}`, NOW);
    }

    // 1. Pedir anular
    const askMenu = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/anular',
      now: NOW,
    });

    expect(askMenu.text).toContain('¿Qué venta deseás anular?');
    const flatMenu = askMenu.inlineKeyboard?.flat() ?? [];
    expect(flatMenu.some((b) => b.callbackData === 'rotiseria:anular_listar:5')).toBe(true);
    expect(flatMenu.some((b) => b.callbackData === 'rotiseria:anular_listar:10')).toBe(true);

    // 2. Pedir lote de 10 ventas
    const list10 = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:anular_listar:10',
      now: NOW,
    });

    expect(list10.text).toContain('últimas 10');
    const saleButtons = (list10.inlineKeyboard ?? [])
      .flat()
      .filter((b) => b.callbackData?.startsWith('rotiseria:anular_ver:') || b.callbackData?.startsWith('rotiseria:anular_pedido:'));
    expect(saleButtons).toHaveLength(10);

    // 3. Seleccionar la primera opción (la venta más reciente, venta #10)
    const targetCb = saleButtons[0].callbackData!;
    const confirmAsk = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: targetCb,
      now: NOW,
    });
    expect(confirmAsk.text).toContain('¿Confirmás la anulación de esta venta?');

    // 4. Confirmar anulación
    const confirmCb = confirmAsk.inlineKeyboard?.[0]?.[0]?.callbackData!;
    const cancelledRes = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: confirmCb,
      now: NOW,
    });
    expect(cancelledRes.text).toContain('anulada correctamente');

    // La última venta en la DB queda marcada como isCancelled: true
    const lastSale = f.store.sales[f.store.sales.length - 1];
    expect(lastSale.isCancelled).toBe(true);

    // 5. Al volver a listar las 10 ventas, la venta anulada se muestra marcada como ANULADA
    const listAgain = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'rotiseria:anular_listar:10',
      now: NOW,
    });
    const flatAgain = listAgain.inlineKeyboard?.flat() ?? [];
    const btnAnulada = flatAgain.find((b) => b.callbackData === 'rotiseria:anular_ya_anulada');
    expect(btnAnulada).toBeDefined();
    expect(btnAnulada?.text).toContain('ANULADA');
  });

  it('separación de /menu y /carta, y comandos /envios y /comida', async () => {
    const f = setupFlow([]);
    await f.products.createProduct({ businessId: BIZ, name: 'Empanada Salteña', priceUnit: 1500 });
    await f.deliveryZones.createZone({ businessId: BIZ, name: 'Centro', price: 1000, barrios: ['centro'] });

    // 1. /carta muestra la carta de comidas y precios
    const resCarta = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/carta',
      now: NOW,
    });
    expect(resCarta.text).toContain('Carta y Precios:');
    expect(resCarta.text).toContain('Empanada Salteña');

    // 2. /menu muestra las funcionalidades disponibles amigables
    const resMenu = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/menu',
      now: NOW,
    });
    expect(resMenu.text).toContain('✨ *¿Qué podemos hacer juntos?*');
    expect(resMenu.text).toContain('🥟 *Ventas y pedidos:*');
    expect(resMenu.text).toContain('🛵 *Envíos a domicilio:*');
    expect(resMenu.text).toContain('📋 *Tu carta:*');
    expect(resMenu.text).toContain('📊 *Cuentas y números:*');

    // 3. /envios muestra el listado de tarifas de entrega
    const resEnvios = await handleText(f.deps, {
      resolution: f.resolution,
      text: '/envios',
      now: NOW,
    });
    expect(resEnvios.text).toContain('🛵 *Zonas y Tarifas de Envíos*');
    expect(resEnvios.text).toContain('Centro');

    // 4. freestyle "menu" también se interpreta directamente
    const freeMenu = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'menu',
      now: NOW,
    });
    expect(freeMenu.text).toContain('✨ *¿Qué podemos hacer juntos?*');
  });

  describe('módulo de envíos, UX de fletes y métricas de reparto', () => {
    it('mutación de flete en una venta borrador: actualiza el total en un paso sin requerir confirmación por texto "Sí/No"', async () => {
      const f = setupFlow([
        {
          match: /docena/i,
          action: 'registrar_venta',
          params: { items: [{ nombre: 'Empanada de Carne', cantidad: 12 }] },
        },
      ]);
      await f.products.createProduct({
        businessId: BIZ,
        name: 'Empanada de Carne',
        priceUnit: 1500,
        priceDozen: 15000,
      });
      await f.deliveryZones.createZone({
        businessId: BIZ,
        name: 'Grand Bourg',
        price: 2500,
        barrios: ['grand bourg'],
      });

      // 1. Inicia borrador de venta
      const r1 = await handleText(f.deps, {
        resolution: f.resolution,
        text: '1 docena de carne',
        now: NOW,
      });
      expect(r1.text).toContain('¿Confirmar venta?');
      expect(r1.text).toContain('$ 15.000');

      // 2. Usuario toca [ 🛵 Envíos ] -> [ ✍️ Ingresar monto manual / barrio ]
      const menuEnvios = await handleCallback(f.deps, {
        resolution: f.resolution,
        data: 'rotiseria:flete_menu',
        now: NOW,
      });
      expect(menuEnvios.text).toContain('🛵 *Envíos*');

      const pedirFlete = await handleCallback(f.deps, {
        resolution: f.resolution,
        data: 'rotiseria:flete_manual',
        now: NOW,
      });
      expect(pedirFlete.text).toContain("Escribí o decime el barrio o el monto del flete");

      // 3. Usuario escribe el barrio 'Grand Bourg'
      // Debe actualizar zona_envio y flete_monto directamente sin confirmación intermedia
      const fleteIngresado = await handleText(f.deps, {
        resolution: f.resolution,
        text: 'Grand Bourg',
        now: NOW,
      });

      // Se debe re-renderizar inmediatamente el resumen de la comanda con 4 botones inline habituales
      expect(fleteIngresado.text).toContain('📋 *Detalle del pedido:*');
      expect(fleteIngresado.text).toContain('🛵 Envío (Grand Bourg): *$ 2.500*');
      expect(fleteIngresado.text).toContain('$ 17.500'); // 15000 + 2500
      expect(fleteIngresado.text).not.toContain('¿Confirmar? Sí/No');

      const flatBtns = fleteIngresado.inlineKeyboard?.flat() ?? [];
      expect(flatBtns.some((b) => b.callbackData === 'confirm:yes')).toBe(true);
      expect(flatBtns.some((b) => b.callbackData === 'confirm:no')).toBe(true);
      expect(flatBtns.some((b) => b.callbackData === 'rotiseria:flete_menu')).toBe(true);

      // 4. Modificar flete a monto manual '3000'
      await handleCallback(f.deps, {
        resolution: f.resolution,
        data: 'rotiseria:flete_manual',
        now: NOW,
      });
      const fleteManual = await handleText(f.deps, {
        resolution: f.resolution,
        text: '3000',
        now: NOW,
      });
      expect(fleteManual.text).toContain('🛵 Envío (Envío): *$ 3.000*');
      expect(fleteManual.text).toContain('$ 18.000'); // 15000 + 3000

      // 5. Quitar flete escribiendo 'sin envio'
      await handleCallback(f.deps, {
        resolution: f.resolution,
        data: 'rotiseria:flete_manual',
        now: NOW,
      });
      const sinEnvio = await handleText(f.deps, {
        resolution: f.resolution,
        text: 'sin envio',
        now: NOW,
      });
      expect(sinEnvio.text).not.toContain('🛵 Envío');
      expect(sinEnvio.text).toContain('$ 15.000');
    });

    it('modificación de precio de zona individual a través de servicio y persistencia en DB', async () => {
      const f = setupFlow([]);
      const zone = await f.deliveryZones.createZone({
        businessId: BIZ,
        name: 'Zona Sur',
        price: 2500,
        barrios: ['san carlos', 'tribuno', 'intersindical'],
      });

      // Actualizar a través del servicio
      const updated = await f.deliveryZones.updateZonePrice(zone.id, BIZ, 3000);
      expect(updated.price).toBe(3000);

      // Verificar persistencia en consulta de zona
      const found = await f.deliveryZones.findById(zone.id, BIZ);
      expect(found).not.toBeNull();
      expect(found?.price).toBe(3000);

      // Flujo interactivo: seleccionar zona y mandar número
      const pedirNuevoPrecio = await handleCallback(f.deps, {
        resolution: f.resolution,
        data: `rotiseria:envio_sel:${zone.id}`,
        now: NOW,
      });
      expect(pedirNuevoPrecio.text).toContain('¿Qué nuevo precio tiene *Zona Sur*?');

      const respuestaPrecio = await handleText(f.deps, {
        resolution: f.resolution,
        text: '3500',
        now: NOW,
      });
      expect(respuestaPrecio.text).toContain('Precio de la zona *Zona Sur* actualizado a *$ 3.500*');

      const foundAfterFlow = await f.deliveryZones.findById(zone.id, BIZ);
      expect(foundAfterFlow?.price).toBe(3500);
    });

    it('agregación de estadísticas de delivery: reporte correcto de ranking por pedidos y recaudación de fletes excluyendo ventas anuladas', async () => {
      const f = setupFlow([]);
      await f.products.createProduct({ businessId: BIZ, name: 'Pizza Muzza', priceUnit: 8000 });

      // Crear ventas activas con fletes
      // 18 pedidos en Zona Sur a 2500
      for (let i = 0; i < 18; i++) {
        await f.sales.createSale(
          BIZ,
          ACTOR,
          [{ name: 'Pizza Muzza', quantity: 1 }],
          undefined,
          NOW,
          'America/Argentina/Buenos_Aires',
          undefined,
          { fee: 2500, zoneName: 'Zona Sur' }
        );
      }

      // 12 pedidos en Centro a 1500
      for (let i = 0; i < 12; i++) {
        await f.sales.createSale(
          BIZ,
          ACTOR,
          [{ name: 'Pizza Muzza', quantity: 1 }],
          undefined,
          NOW,
          'America/Argentina/Buenos_Aires',
          undefined,
          { fee: 1500, zoneName: 'Centro' }
        );
      }

      // 5 pedidos en San Lorenzo a 4000
      for (let i = 0; i < 5; i++) {
        await f.sales.createSale(
          BIZ,
          ACTOR,
          [{ name: 'Pizza Muzza', quantity: 1 }],
          undefined,
          NOW,
          'America/Argentina/Buenos_Aires',
          undefined,
          { fee: 4000, zoneName: 'San Lorenzo' }
        );
      }

      // Crear 2 pedidos anulados en San Lorenzo (NO deben computar)
      const anulada1 = await f.sales.createSale(
        BIZ,
        ACTOR,
        [{ name: 'Pizza Muzza', quantity: 1 }],
        undefined,
        NOW,
        'America/Argentina/Buenos_Aires',
        undefined,
        { fee: 4000, zoneName: 'San Lorenzo' }
      );
      await f.sales.cancelSale(BIZ, ACTOR, anulada1.sale.id, 'Prueba anulación', NOW);

      // Crear venta sin flete (mostrador - NO debe computar en ranking de fletes)
      await f.sales.createSale(
        BIZ,
        ACTOR,
        [{ name: 'Pizza Muzza', quantity: 1 }],
        undefined,
        NOW,
        'America/Argentina/Buenos_Aires',
        undefined,
        undefined
      );

      // Consultar reporte de delivery stats
      const stats = await f.sales.getDeliveryStats(BIZ);
      expect(stats.totalOrders).toBe(35); // 18 + 12 + 5
      expect(stats.totalDeliveryFees).toBe(83000); // (18*2500) + (12*1500) + (5*4000) = 45000 + 18000 + 20000 = 83000
      expect(stats.zones).toHaveLength(3);
      expect(stats.zones[0]).toEqual({ zoneName: 'Zona Sur', count: 18, totalDeliveryFee: 45000 });
      expect(stats.zones[1]).toEqual({ zoneName: 'Centro', count: 12, totalDeliveryFee: 18000 });
      expect(stats.zones[2]).toEqual({ zoneName: 'San Lorenzo', count: 5, totalDeliveryFee: 20000 });

      // Verificación de visualización formateada vía callback
      const statsCallback = await handleCallback(f.deps, {
        resolution: f.resolution,
        data: 'rotiseria:envios_stats',
        now: NOW,
      });
      expect(statsCallback.text).toContain('🛵 *Ranking de Envíos y Zonas*');
      expect(statsCallback.text).toContain('1. 🥇 *Zona Sur:* 18 envíos — $ 45.000');
      expect(statsCallback.text).toContain('2. 🥈 *Centro:* 12 envíos — $ 18.000');
      expect(statsCallback.text).toContain('3. 🥉 *San Lorenzo:* 5 envíos — $ 20.000');
      expect(statsCallback.text).toContain('📦 *Total pedidos enviados:* 35 envíos');
      expect(statsCallback.text).toContain('💰 *Total dinero fletes:* $ 83.000');

      // Botón volver a envíos presente
      const flatBtns = statsCallback.inlineKeyboard?.flat() ?? [];
      expect(flatBtns.some((b) => b.callbackData === 'rotiseria:envios_menu')).toBe(true);
    });
  });
});


