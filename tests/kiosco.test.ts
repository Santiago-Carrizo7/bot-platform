import { describe, expect, it, vi } from 'vitest';
import type { MoneyMovement, PrismaClient, Product, Purchase, Sale, SaleItem, StockMovement } from '@prisma/client';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import type { ActionDef, TemplateDefinition } from '../src/core/actions/registry.js';
import type { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { ProductService } from '../src/templates/kiosco/domain/product.service.js';
import { SaleService } from '../src/templates/kiosco/domain/sale.service.js';
import { CashService } from '../src/templates/kiosco/domain/cash.service.js';
import { buildKioscoActions } from '../src/templates/kiosco/actions.js';
import type { ProductRepository } from '../src/templates/kiosco/persistence/product.repo.js';
import type { SaleRepository } from '../src/templates/kiosco/persistence/sale.repo.js';
import type { CashRepository } from '../src/templates/kiosco/persistence/cash.repo.js';
import {
  FakeAiUsageRepo,
  FakeAuditRepo,
  FakeBusinessRepo,
  FakeConversationRepo,
  FakeMembershipRepo,
  makeBusiness,
} from './fakes.js';
import type { TenantContext } from '../src/core/tenant/entities.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const BIZ = 'biz-kiosco';
const ACTOR = 'user-1';

let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

interface Store {
  products: Product[];
  movements: MoneyMovement[];
  purchases: Purchase[];
  stockMovements: StockMovement[];
  sales: Array<Sale & { items: SaleItem[] }>;
}

function newStore(): Store {
  return { products: [], movements: [], purchases: [], stockMovements: [], sales: [] };
}

function asProduct(p: Partial<Product>): Product {
  return {
    id: nid('prod'), businessId: BIZ, name: 'X', salePrice: 100 as unknown as Product['salePrice'],
    costPrice: null, stock: 0 as unknown as Product['stock'], minStock: null,
    unit: 'unidad', isActive: true, createdAt: NOW, updatedAt: NOW, ...p,
  } as Product;
}

class FakeProductRepo {
  constructor(private readonly s: Store) {}
  async create(data: { businessId: string; name: string; salePrice: number; costPrice?: number; stock?: number; minStock?: number; unit?: string }) {
    const p = asProduct({
      id: nid('prod'), businessId: data.businessId, name: data.name.trim(),
      salePrice: data.salePrice as unknown as Product['salePrice'],
      costPrice: (data.costPrice ?? null) as unknown as Product['costPrice'],
      stock: (data.stock ?? 0) as unknown as Product['stock'],
      minStock: (data.minStock ?? null) as unknown as Product['minStock'],
      unit: data.unit ?? 'unidad',
    });
    this.s.products.push(p);
    return p;
  }
  async findByName(businessId: string, name: string) {
    return this.s.products.find((p) => p.businessId === businessId && p.name.toLowerCase() === name.trim().toLowerCase() && p.isActive) ?? null;
  }
  async findById(id: string, businessId: string) {
    return this.s.products.find((p) => p.id === id && p.businessId === businessId) ?? null;
  }
  async list(businessId: string, opts: { search?: string; onlyLowStock?: boolean; limit?: number } = {}) {
    let all = this.s.products.filter((p) => p.businessId === businessId && p.isActive);
    if (opts.search) all = all.filter((p) => p.name.toLowerCase().includes(opts.search!.toLowerCase()));
    if (opts.onlyLowStock) all = all.filter((p) => p.minStock !== null && Number(p.stock) <= Number(p.minStock));
    return all.slice(0, opts.limit ?? 50);
  }
  async update(id: string, _b: string, data: { name?: string; salePrice?: number; costPrice?: number; minStock?: number | null; unit?: string }) {
    const p = this.s.products.find((x) => x.id === id);
    if (!p) throw new Error('no encontrado');
    if (data.name !== undefined) p.name = data.name;
    if (data.salePrice !== undefined) p.salePrice = data.salePrice as unknown as Product['salePrice'];
    if (data.costPrice !== undefined) p.costPrice = data.costPrice as unknown as Product['costPrice'];
    if (data.minStock !== undefined) p.minStock = data.minStock as unknown as Product['minStock'];
    if (data.unit !== undefined) p.unit = data.unit;
    return p;
  }
  async deactivate(id: string) {
    const p = this.s.products.find((x) => x.id === id);
    if (!p) throw new Error('no encontrado');
    p.isActive = false;
    return p;
  }
  async changeStock(id: string, _b: string, delta: number) {
    const p = this.s.products.find((x) => x.id === id);
    if (!p) throw new Error('no encontrado');
    p.stock = (Number(p.stock) + delta) as unknown as Product['stock'];
    return p;
  }
  async setStock(id: string, _b: string, quantity: number) {
    const p = this.s.products.find((x) => x.id === id);
    if (!p) throw new Error('no encontrado');
    const previous = Number(p.stock);
    p.stock = quantity as unknown as Product['stock'];
    return { product: p, previous };
  }
}

class FakeSaleRepo {
  constructor(private readonly s: Store) {}
  async create(businessId: string, userId: string, total: number, lines: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; subtotal: number }>, note?: string) {
    const sale = {
      id: nid('sale'), businessId, userId, total: total as unknown as Sale['total'],
      currency: 'ARS', note: note ?? null, createdAt: NOW, updatedAt: NOW,
      items: lines.map((l) => ({
        id: nid('item'), saleId: '', productId: l.productId, productName: l.productName,
        quantity: l.quantity as unknown as SaleItem['quantity'],
        unitPrice: l.unitPrice as unknown as SaleItem['unitPrice'],
        subtotal: l.subtotal as unknown as SaleItem['subtotal'],
      })),
    } as Sale & { items: SaleItem[] };
    for (const it of sale.items) it.saleId = sale.id;
    this.s.sales.push(sale);
    return sale;
  }
  async listRecent() {
    return this.s.sales;
  }
}

class FakeCashRepo {
  constructor(private readonly s: Store) {}
  async addMovement(data: { businessId: string; userId: string; kind: string; amount: number; concept: string; category?: string; date?: Date; relatedType?: string; relatedId?: string }) {
    const m = {
      id: nid('mov'), businessId: data.businessId, userId: data.userId, kind: data.kind,
      amount: data.amount as unknown as MoneyMovement['amount'], concept: data.concept,
      category: data.category ?? null, date: data.date ?? NOW,
      relatedType: data.relatedType ?? null, relatedId: data.relatedId ?? null, createdAt: NOW,
    } as MoneyMovement;
    this.s.movements.push(m);
    return m;
  }
  async createPurchase(data: { businessId: string; userId: string; description: string; amount: number; productId?: string; quantity?: number; date?: Date }) {
    const p = {
      id: nid('pur'), businessId: data.businessId, userId: data.userId, description: data.description,
      amount: data.amount as unknown as Purchase['amount'], currency: 'ARS',
      productId: data.productId ?? null, quantity: (data.quantity ?? null) as unknown as Purchase['quantity'],
      date: data.date ?? NOW, createdAt: NOW,
    } as Purchase;
    this.s.purchases.push(p);
    return p;
  }
  async addStockMovement(data: { businessId: string; productId?: string; productName: string; quantity: number; reason: string; relatedType?: string; relatedId?: string; userId: string }) {
    const m = {
      id: nid('sm'), businessId: data.businessId, productId: data.productId ?? null,
      productName: data.productName, quantity: data.quantity as unknown as StockMovement['quantity'],
      reason: data.reason, relatedType: data.relatedType ?? null, relatedId: data.relatedId ?? null,
      userId: data.userId, createdAt: NOW,
    } as StockMovement;
    this.s.stockMovements.push(m);
    return m;
  }
  async getTotalsByDateRange() {
    const totalIn = this.s.movements.filter((m) => m.kind === 'IN').reduce((a, m) => a + Number(m.amount), 0);
    const totalOut = this.s.movements.filter((m) => m.kind === 'OUT').reduce((a, m) => a + Number(m.amount), 0);
    return {
      totalIn, totalOut,
      countIn: this.s.movements.filter((m) => m.kind === 'IN').length,
      countOut: this.s.movements.filter((m) => m.kind === 'OUT').length,
    };
  }
}

function setupServices(store: Store = newStore()) {
  const productRepo = new FakeProductRepo(store);
  const saleRepo = new FakeSaleRepo(store);
  const cashRepo = new FakeCashRepo(store);
  const fakeDb = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    sale: {
      aggregate: async (args: { where?: { createdAt?: { gte?: Date; lte?: Date } } }) => {
        const gte = args.where?.createdAt?.gte;
        const lte = args.where?.createdAt?.lte;
        const inRange = store.sales.filter(
          (s) => (!gte || s.createdAt >= gte) && (!lte || s.createdAt <= lte)
        );
        return {
          _sum: { total: inRange.reduce((a, s) => a + Number(s.total), 0) },
          _count: { id: inRange.length },
        };
      },
    },
  } as unknown as PrismaClient;
  const products = new ProductService(productRepo as unknown as ProductRepository, cashRepo as unknown as CashRepository);
  const sales = new SaleService(fakeDb, saleRepo as unknown as SaleRepository, productRepo as unknown as ProductRepository, cashRepo as unknown as CashRepository);
  const cash = new CashService(fakeDb, cashRepo as unknown as CashRepository, productRepo as unknown as ProductRepository);
  return { products, sales, cash, store };
}

describe('template kiosco: dominio', () => {
  it('crea producto y rechaza duplicados', async () => {
    const { products } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca Cola 2.5L', salePrice: 3500, stock: 12 });
    await expect(products.create(BIZ, ACTOR, { name: 'coca cola 2.5l', salePrice: 3500 })).rejects.toThrow(/Ya existe/);
  });

  it('venta multi-producto: total, descuento de stock y movimiento de caja', async () => {
    const { products, sales, store } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca Cola 2.5L', salePrice: 3500, stock: 12 });
    await products.create(BIZ, ACTOR, { name: 'Alfajor', salePrice: 800, stock: 30 });
    const result = await sales.createSale(BIZ, ACTOR, [
      { productName: 'Coca Cola 2.5L', quantity: 3 },
      { productName: 'Alfajor', quantity: 2 },
    ]);
    expect(Number(result.sale.total)).toBe(3 * 3500 + 2 * 800);
    expect(result.lines).toHaveLength(2);
    expect(Number((await products.findByName(BIZ, 'Coca Cola 2.5L'))!.stock)).toBe(9);
    expect(store.movements).toHaveLength(1);
    expect(store.movements[0]).toMatchObject({ kind: 'IN', amount: 12100 });
    expect(store.stockMovements.filter((m) => m.reason === 'VENTA')).toHaveLength(2);
  });

  it('venta con producto inexistente falla con mensaje útil (sin tocar stock)', async () => {
    const { products, sales, store } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca', salePrice: 3500, stock: 12 });
    await expect(
      sales.createSale(BIZ, ACTOR, [{ productName: 'Pepsi', quantity: 1 }])
    ).rejects.toThrow(/No encontré.*Pepsi/);
    expect(store.sales).toHaveLength(0);
    expect(Number((await products.findByName(BIZ, 'Coca'))!.stock)).toBe(12);
  });

  it('venta que deja stock negativo avisa pero no bloquea', async () => {
    const { products, sales } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca', salePrice: 3500, stock: 1 });
    const result = await sales.createSale(BIZ, ACTOR, [{ productName: 'Coca', quantity: 3 }]);
    expect(result.negativeStock).toHaveLength(1);
    expect(result.negativeStock[0].stock).toBe(-2);
  });

  it('compra con mercadería: sale dinero y entra stock', async () => {
    const { products, cash, store } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca', salePrice: 3500, stock: 2 });
    const result = await cash.registerPurchase(BIZ, ACTOR, {
      description: '2 cajones de Coca', amount: 20000, productName: 'Coca', quantity: 12,
    });
    expect(result.stockAdded).toMatchObject({ productName: 'Coca', stock: 14 });
    expect(store.movements).toMatchObject([{ kind: 'OUT', amount: 20000 }]);
    expect(store.stockMovements.filter((m) => m.reason === 'COMPRA')).toHaveLength(1);
  });

  it('gasto y entrada generan movimientos OUT/IN', async () => {
    const { cash, store } = setupServices();
    await cash.moneyOut(BIZ, ACTOR, { concept: 'Luz', amount: 15000, category: 'gastos' });
    await cash.moneyIn(BIZ, ACTOR, { concept: 'Deuda cobrada', amount: 5000, category: 'entradas' });
    expect(store.movements.map((m) => m.kind)).toEqual(['OUT', 'IN']);
  });

  it('fijar stock: valor absoluto + movimiento de ajuste con diferencia', async () => {
    const { products, store } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca', salePrice: 3500, stock: 10 });
    const { previous } = await products.setStock(BIZ, ACTOR, 'Coca', 24);
    expect(previous).toBe(10);
    expect(store.stockMovements.filter((m) => m.reason === 'AJUSTE').map((m) => Number(m.quantity))).toEqual([14]);
  });

  it('stock bajo: solo productos con mínimo superado', async () => {
    const { products } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca', salePrice: 3500, stock: 3, minStock: 5 });
    await products.create(BIZ, ACTOR, { name: 'Alfajor', salePrice: 800, stock: 30, minStock: 5 });
    await products.create(BIZ, ACTOR, { name: 'Yerba', salePrice: 4000, stock: 2 });
    const bajos = await products.list(BIZ, { onlyLowStock: true });
    expect(bajos.map((p) => p.name)).toEqual(['Coca']);
  });

  it('modificar precio y dar de baja (conserva historial)', async () => {
    const { products, sales, store } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca', salePrice: 3500, stock: 10 });
    await sales.createSale(BIZ, ACTOR, [{ productName: 'Coca', quantity: 1 }]);
    await products.update(BIZ, 'Coca', { salePrice: 3800 });
    expect(Number((await products.findByName(BIZ, 'Coca'))!.salePrice)).toBe(3800);
    await products.deactivate(BIZ, 'Coca');
    expect(await products.list(BIZ)).toHaveLength(0);
    expect(store.sales).toHaveLength(1); // el historial se conserva
  });

  it('resumen del día agrega ventas y movimientos', async () => {
    const { products, sales, cash } = setupServices();
    await products.create(BIZ, ACTOR, { name: 'Coca', salePrice: 3500, stock: 10 });
    await sales.createSale(BIZ, ACTOR, [{ productName: 'Coca', quantity: 2 }]);
    await cash.moneyOut(BIZ, ACTOR, { concept: 'Luz', amount: 1000 });
    const summary = await cash.getDaySummary(BIZ, NOW);
    expect(summary.salesTotal).toBe(7000);
    expect(summary.totalIn).toBe(7000);
    expect(summary.totalOut).toBe(1000);
    expect(summary.net).toBe(6000);
  });
});

describe('template kiosco: flujo por bot', () => {
  function setupFlow(queue: Array<{ action: string; params: Record<string, unknown> }>) {
    const store = newStore();
    const { products, sales, cash } = setupServices(store);
    const actions = buildKioscoActions({ products, sales, cash });
    const template: TemplateDefinition = {
      id: 'kiosco', label: 'Kiosco',
      welcome: () => 'Bienvenido', systemPrompt: () => 'sys',
      actions,
      commands: [{ command: 'venta', action: 'registrar_venta' }, { command: 'stock', action: 'consultar_stock' }],
      menu: [],
    };
    const businesses = new FakeBusinessRepo();
    const membershipRepo = new FakeMembershipRepo(businesses);
    const conversations = new FakeConversationRepo();
    const auditRepo = new FakeAuditRepo();
    const business = businesses.seed(makeBusiness({ id: BIZ, templateId: 'kiosco' }));
    const user = { id: ACTOR, telegramId: 'tg-1', createdAt: NOW, updatedAt: NOW };
    const membership = {
      id: 'mem-1', businessId: BIZ, userId: ACTOR, role: 'EMPLOYEE' as const,
      lastUsedAt: null, createdAt: NOW, updatedAt: NOW,
    };
    membershipRepo.store.set(membership.id, membership);
    const interpreter = {
      interpret: vi.fn(async (_sys: string, all: ActionDef<unknown>[]) => {
        const next = queue.shift();
        if (!next) throw new Error('sin respuestas de IA');
        const action = all.find((a) => a.name === next.action);
        if (!action) throw new Error('acción desconocida');
        return { action, params: next.params };
      }),
    } as unknown as ActionInterpreter;
    const deps: FlowDeps = {
      template, interpreter, conversations, businesses, membershipRepo,
      audit: new AuditService(auditRepo), aiUsage: new FakeAiUsageRepo(),
      aiProviderName: 'Mock', aiModel: 'mock-1',
    };
    const tenant: TenantContext = { business, membership, user, botTemplateId: 'kiosco' };
    const resolution: ResolutionInfo = { user, tenant, justJoined: false, memberships: [], needsInvitation: false };
    return { deps, resolution, auditRepo, store };
  }

  it('freestyle "vendí 3 Coca" → confirmación con total calculado → registra y audita', async () => {
    const f = setupFlow([{ action: 'registrar_venta', params: { items: [{ producto: 'Coca', cantidad: 3 }] } }]);
    // Producto cargado previamente por el dueño.
    const { products } = setupServices(f.store);
    await products.create(BIZ, ACTOR, { name: 'Coca', salePrice: 2000, stock: 10 });

    const ask = await handleText(f.deps, { resolution: f.resolution, text: 'vendí 3 Coca', now: NOW });
    expect(ask.text).toContain('¿Confirmar?');
    expect(ask.text).toContain('Coca');
    const done = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(done.text).toContain('$ 6.000');
    expect(f.auditRepo.entries).toHaveLength(1);
    expect(f.auditRepo.entries[0]).toMatchObject({ action: 'sale.created', actorUserId: ACTOR });
    expect(f.store.movements[0]).toMatchObject({ kind: 'IN', amount: 6000 });
  });

  it('/stock ejecuta la consulta sin confirmación', async () => {
    const f = setupFlow([]);
    const reply = await handleText(f.deps, { resolution: f.resolution, text: '/stock', now: NOW });
    expect(reply.text).toContain('No hay productos');
  });
});
