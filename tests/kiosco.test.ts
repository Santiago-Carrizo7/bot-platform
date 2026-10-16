import { describe, expect, it, vi } from 'vitest';
import type { MoneyMovement, PrismaClient } from '@prisma/client';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import type { ActionDef, TemplateDefinition } from '../src/core/actions/registry.js';
import type { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { CashService, inferCategory } from '../src/templates/kiosco/domain/cash.service.js';
import { buildKioscoActions } from '../src/templates/kiosco/actions.js';
import { createKioscoTemplate, createKioscoTemplateWithCash, interpretDirectlyKiosco } from '../src/templates/kiosco/index.js';
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

class FakeCashRepo {
  public movements: MoneyMovement[] = [];

  async addMovement(data: {
    businessId: string;
    userId: string;
    kind: 'IN' | 'OUT';
    amount: number;
    concept: string;
    category?: string;
    date?: Date;
    relatedType?: string;
    relatedId?: string;
  }) {
    const m = {
      id: nid('mov'),
      businessId: data.businessId,
      userId: data.userId,
      kind: data.kind,
      amount: data.amount as unknown as MoneyMovement['amount'],
      concept: data.concept,
      category: data.category ?? null,
      date: data.date ?? NOW,
      relatedType: data.relatedType ?? null,
      relatedId: data.relatedId ?? null,
      createdAt: new Date(),
    } as MoneyMovement;
    this.movements.push(m);
    return m;
  }

  async undoLastMovement(businessId: string, userId: string) {
    const idx = [...this.movements]
      .reverse()
      .findIndex((m) => m.businessId === businessId && m.userId === userId);
    if (idx === -1) return null;
    const realIdx = this.movements.length - 1 - idx;
    const [removed] = this.movements.splice(realIdx, 1);
    return removed;
  }

  async listRecent(businessId: string, limit = 10) {
    return this.movements
      .filter((m) => m.businessId === businessId)
      .slice(-limit)
      .reverse();
  }

  async getTotalsByDateRange(businessId: string, start: Date, end: Date) {
    const filtered = this.movements.filter(
      (m) => m.businessId === businessId && m.date >= start && m.date <= end
    );
    const inMovs = filtered.filter((m) => m.kind === 'IN');
    const outMovs = filtered.filter((m) => m.kind === 'OUT');
    return {
      totalIn: inMovs.reduce((acc, m) => acc + Number(m.amount), 0),
      totalOut: outMovs.reduce((acc, m) => acc + Number(m.amount), 0),
      countIn: inMovs.length,
      countOut: outMovs.length,
    };
  }

  async getExpensesByCategory(businessId: string, start: Date, end: Date) {
    const filtered = this.movements.filter(
      (m) => m.businessId === businessId && m.kind === 'OUT' && m.date >= start && m.date <= end
    );
    const byCat = new Map<string, { total: number; count: number }>();
    for (const m of filtered) {
      const cat = m.category || 'Otros';
      const cur = byCat.get(cat) || { total: 0, count: 0 };
      cur.total += Number(m.amount);
      cur.count += 1;
      byCat.set(cat, cur);
    }
    return [...byCat.entries()].map(([category, data]) => ({ category, ...data }));
  }
}

function setupServices() {
  const repo = new FakeCashRepo();
  const cash = new CashService(repo as unknown as CashRepository);
  return { repo, cash };
}

describe('template kiosco: dominio financiero', () => {
  it('registra venta rápida y gasto con categorías', async () => {
    const { cash, repo } = setupServices();

    const sale = await cash.recordSale(BIZ, ACTOR, { monto: 5000, nota: 'dos alfajores' });
    expect(Number(sale.amount)).toBe(5000);
    expect(sale.kind).toBe('IN');
    expect(sale.concept).toBe('Venta: dos alfajores');
    expect(sale.category).toBe('Ventas');

    const exp = await cash.recordExpense(BIZ, ACTOR, { monto: 3500, concepto: 'Coca Cola', categoria: 'Mercadería' });
    expect(Number(exp.amount)).toBe(3500);
    expect(exp.kind).toBe('OUT');
    expect(exp.category).toBe('Mercadería');
    expect(repo.movements).toHaveLength(2);
  });

  it('infiere categorías típicas de gastos si no fueron pasadas', () => {
    expect(inferCategory('pago al mayorista')).toBe('Proveedores');
    expect(inferCategory('factura de luz')).toBe('Servicios');
    expect(inferCategory('supermercado chino')).toBe('Supermercado');
    expect(inferCategory('alquiler del local')).toBe('Alquiler');
    expect(inferCategory('coca y alfajores')).toBe('Mercadería');
    expect(inferCategory('flete de mercaderia')).toBe('Transporte');
  });

  it('permite registrar fechas retroactivas', async () => {
    const { cash, repo } = setupServices();
    const past = new Date('2026-10-01T10:00:00Z');
    await cash.recordSale(BIZ, ACTOR, { monto: 8000, fecha: past });
    expect(repo.movements[0].date).toEqual(past);
  });

  it('deshacer anula el último movimiento del usuario en el negocio', async () => {
    const { cash, repo } = setupServices();
    await cash.recordSale(BIZ, ACTOR, { monto: 5000 });
    await cash.recordSale(BIZ, ACTOR, { monto: 8200 });
    expect(repo.movements).toHaveLength(2);

    const undone = await cash.undoLast(BIZ, ACTOR);
    expect(undone).not.toBeNull();
    expect(Number(undone!.amount)).toBe(8200);
    expect(repo.movements).toHaveLength(1);
    expect(Number(repo.movements[0].amount)).toBe(5000);
  });

  it('calcula resúmenes periódicos y balance de caja (ventas - gastos)', async () => {
    const { cash } = setupServices();
    await cash.recordSale(BIZ, ACTOR, { monto: 10000 });
    await cash.recordSale(BIZ, ACTOR, { monto: 5000 });
    await cash.recordExpense(BIZ, ACTOR, { monto: 4000, concepto: 'Luz' });

    const summary = await cash.getDaySummary(BIZ, NOW);
    expect(summary.ventasTotal).toBe(15000);
    expect(summary.ventasCount).toBe(2);
    expect(summary.gastosTotal).toBe(4000);
    expect(summary.gastosCount).toBe(1);
    expect(summary.balanceCaja).toBe(11000);
  });

  it('calculador de precio: margen vs recargo/markup con lote y unitario', () => {
    const { cash } = setupServices();

    // Lote: 30 alfajores por 18000 (costo unitario = 600)
    // Recargo del 40%: precio = 600 * 1.4 = 840. Ganancia unit = 240, lote = 7200.
    const markup = cash.calculatePrice({
      costoTotal: 18000,
      cantidad: 30,
      porcentaje: 40,
      tipo: 'recargo',
    });
    expect(markup.costoUnitario).toBe(600);
    expect(markup.precioSugerido).toBe(840);
    expect(markup.gananciaUnitaria).toBe(240);
    expect(markup.gananciaLote).toBe(7200);

    // Margen del 40%: precio = 600 / (1 - 0.4) = 1000. Ganancia unit = 400, lote = 12000.
    const margin = cash.calculatePrice({
      costoUnitario: 600,
      cantidad: 30,
      porcentaje: 40,
      tipo: 'margen',
    });
    expect(margin.precioSugerido).toBe(1000);
    expect(margin.gananciaUnitaria).toBe(400);
    expect(margin.gananciaLote).toBe(12000);
  });
});

describe('template kiosco: flujo por bot (Telegram)', () => {
  function setupFlow(
    queue: Array<{ action: string; params: Record<string, unknown> }>,
    role: 'OWNER' | 'EMPLOYEE' = 'OWNER'
  ) {
    const { cash, repo } = setupServices();
    const { template } = createKioscoTemplateWithCash(cash);
    const businesses = new FakeBusinessRepo();
    const membershipRepo = new FakeMembershipRepo(businesses);
    const conversations = new FakeConversationRepo();
    const auditRepo = new FakeAuditRepo();
    const business = businesses.seed(makeBusiness({ id: BIZ, templateId: 'kiosco' }));
    const user = { id: ACTOR, telegramId: 'tg-1', createdAt: NOW, updatedAt: NOW };
    const membership = {
      id: 'mem-1',
      businessId: BIZ,
      userId: ACTOR,
      role,
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
    const tenant: TenantContext = { business, membership, user, botTemplateId: 'kiosco' };
    const resolution: ResolutionInfo = { user, tenant, justJoined: false, memberships: [], needsInvitation: false };
    return { deps, resolution, auditRepo, repo, businesses, conversations };
  }

  it('flujo ventas: "Vendí 5000" registra directamente, audita y ofrece Deshacer y Finalizar', async () => {
    const f = setupFlow([{ action: 'registrar_venta', params: { monto: 5000 } }]);
    const res = await handleText(f.deps, { resolution: f.resolution, text: 'Vendí 5000', now: NOW });
    expect(res.text).toContain('🟢 Venta registrada: *$ 5.000*');
    expect(res.text).toContain('Total acumulado: $ 5.000 (1)');
    expect(res.inlineKeyboard).toEqual([
      [{ text: '↩️ Deshacer última venta', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
    ]);
    expect(f.auditRepo.entries).toHaveLength(1);
    expect(f.auditRepo.entries[0]).toMatchObject({ action: 'sale.recorded', actorUserId: ACTOR });
    expect(f.repo.movements).toHaveLength(1);
    // Disparo del trial en la primera venta real
    expect(f.businesses.store.get(BIZ)?.trialStartedAt).toEqual(NOW);
  });

  it('negocio en READ_ONLY bloquea registro de ventas en kiosco', async () => {
    const f = setupFlow([{ action: 'registrar_venta', params: { monto: 5000 } }]);
    const biz = f.businesses.store.get(BIZ)!;
    biz.status = 'READ_ONLY';
    const res = await handleText(f.deps, { resolution: f.resolution, text: 'Vendí 5000', now: NOW });
    expect(res.text).toContain('modo solo lectura');
    expect(f.repo.movements).toHaveLength(0);
  });

  it('flujo gastos: registrar gasto registra directamente y categoriza', async () => {
    const f = setupFlow([{ action: 'registrar_gasto', params: { monto: 3500, concepto: 'Coca Cola', categoria: 'Mercadería' } }]);
    const res = await handleText(f.deps, { resolution: f.resolution, text: 'Gasté 3500 en Coca Cola', now: NOW });
    expect(res.text).toContain('🔴 Gasto registrado: *$ 3.500*');
    expect(res.text).toContain('Coca Cola');
    expect(res.text).not.toContain('Mercadería');
    expect(res.inlineKeyboard).toEqual([
      [{ text: '↩️ Deshacer último gasto', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
    ]);
    expect(f.repo.movements[0]).toMatchObject({ kind: 'OUT', amount: 3500, category: 'Mercadería' });
  });

  it('deshacer_ultimo anula el último registro desde comando o callback', async () => {
    const f = setupFlow([]);
    await f.repo.addMovement({ businessId: BIZ, userId: ACTOR, kind: 'IN', amount: 5000, concept: 'Venta' });
    expect(f.repo.movements).toHaveLength(1);

    const undone = await handleCallback(f.deps, { resolution: f.resolution, data: 'undo:last', now: NOW });
    expect(undone.text).toContain('Se anuló el último movimiento');
    expect(undone.text).toContain('$ 5.000');
    expect(f.repo.movements).toHaveLength(0);
  });

  it('unificación de comandos: /ventas y /venta apuntan a ventas, /gastos y /gasto apuntan a gastos', async () => {
    const f = setupFlow([]);

    // 1. /ventas inicia sesión continua de ventas
    const resVentas = await handleText(f.deps, { resolution: f.resolution, text: '/ventas', now: NOW });
    expect(resVentas.text).toContain('Registro de ventas');
    expect(resVentas.text).toContain('Tip: Para audios');

    // 2. /venta 4500 registra directamente
    const resVentaArg = await handleText(f.deps, { resolution: f.resolution, text: '/venta 4500', now: NOW });
    expect(resVentaArg.text).toContain('🟢 Venta registrada: *$ 4.500*');

    // 3. /gastos inicia sesión continua de gastos
    const resGastos = await handleText(f.deps, { resolution: f.resolution, text: '/gastos', now: NOW });
    expect(resGastos.text).toContain('Registro de gastos');
    expect(resGastos.text).toContain('Tip: Para audios');

    // 4. /gasto 3000 yerba registra directamente
    const resGastoArg = await handleText(f.deps, { resolution: f.resolution, text: '/gasto 3000 yerba', now: NOW });
    expect(resGastoArg.text).toContain('🔴 Gasto registrado: *$ 3.000*');
    expect(resGastoArg.text).toContain('yerba');
  });

  it('calculador de precio: si falta tipo explica margen vs recargo; si está completo calcula ganancia', async () => {
    // Caso 1: sin tipo especificado -> pide aclaración pedagógica
    const f1 = setupFlow([{ action: 'calcular_precio', params: { costo_total: 18000, cantidad: 30, porcentaje: 40 } }]);
    const askType = await handleText(f1.deps, { resolution: f1.resolution, text: 'compré 30 alfajores por 18000 y quiero ganar 40%', now: NOW });
    expect(askType.text).toContain('Si calculás con Recargo (sobre el costo)');
    expect(askType.text).toContain('Si calculás con Margen (sobre la venta)');
    expect(askType.text).toContain('Precio sugerido: *$ 840* c/u');
    expect(askType.text).toContain('Precio sugerido: *$ 1.000* c/u');

    // Caso 2: con margen especificado -> cálculo matemático
    const f2 = setupFlow([{ action: 'calcular_precio', params: { costo_unitario: 600, porcentaje: 40, tipo: 'margen', cantidad: 30 } }]);
    const res = await handleText(f2.deps, { resolution: f2.resolution, text: '30 alfajores costo 600, 40% de margen', now: NOW });
    expect(res.text).toContain('Precio de venta: $ 1.000');
    expect(res.text).toContain('Ganancia por unidad: *$ 400*');
    expect(res.text).toContain('Ganancia total del lote: *$ 12.000*');
  });

  it('consultas de resumen y balance de caja aclaran que no es ganancia contable real', async () => {
    const f = setupFlow([{ action: 'consultar_resumen', params: { periodo: 'hoy' } }]);
    await f.repo.addMovement({ businessId: BIZ, userId: ACTOR, kind: 'IN', amount: 20000, concept: 'Venta' });
    await f.repo.addMovement({ businessId: BIZ, userId: ACTOR, kind: 'OUT', amount: 5000, concept: 'Luz' });

    const reply = await handleText(f.deps, { resolution: f.resolution, text: '¿Cuánto vendí hoy?', now: NOW });
    expect(reply.text).toContain('Ventas: *$ 20.000*');
    expect(reply.text).toContain('Gastos: *$ 5.000*');
    expect(reply.text).toContain('Resultado en caja: +$ 15.000');
    expect(reply.text).toContain('no deduce costos de mercadería');
  });

  it('tenant isolation: un negocio no ve ni anula movimientos de otro', async () => {
    const f = setupFlow([]);
    const OTHER_BIZ = 'biz-otro';
    await f.repo.addMovement({ businessId: OTHER_BIZ, userId: 'user-2', kind: 'IN', amount: 99999, concept: 'Venta otro' });
    await f.repo.addMovement({ businessId: BIZ, userId: ACTOR, kind: 'IN', amount: 5000, concept: 'Mi venta' });

    const recent = await f.repo.listRecent(BIZ, 10);
    expect(recent).toHaveLength(1);
    expect(Number(recent[0].amount)).toBe(5000);

    // Deshacer no toca el otro negocio
    const undone = await f.repo.undoLastMovement(BIZ, ACTOR);
    expect(Number(undone!.amount)).toBe(5000);
    expect(f.repo.movements).toHaveLength(1);
    expect(f.repo.movements[0].businessId).toBe(OTHER_BIZ);
  });

  it('/venta sin argumentos inicia sesión de ventas y no genera NaN', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, { resolution: f.resolution, text: '/venta', now: NOW });
    expect(res.text).toContain('Registro de ventas');
    expect(res.text).not.toContain('NaN');

    // Luego el usuario envía el monto suelto en modo continuo y se registra directamente
    const followUp = await handleText(f.deps, { resolution: f.resolution, text: '3500 alfajor', now: NOW });
    expect(followUp.text).toContain('🟢 Venta registrada: *$ 3.500* (alfajor)');
    expect(followUp.text).not.toContain('NaN');
  });

  it('/venta con monto (/venta 5000) registra venta directamente', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, { resolution: f.resolution, text: '/venta 5000', now: NOW });
    expect(res.text).toContain('🟢 Venta registrada: *$ 5.000*');
    expect(res.text).not.toContain('NaN');
  });

  it('un número freestyle (3000) se interpreta directamente sin IA y registra venta', async () => {
    const f = setupFlow([]); // Cola de IA vacía
    const res = await handleText(f.deps, { resolution: f.resolution, text: '3000', now: NOW });
    expect(res.text).toContain('🟢 Venta registrada: *$ 3.000*');
    expect(f.deps.interpreter.interpret).not.toHaveBeenCalled();
  });

  it('si la IA falla en freestyle, no filtra errores técnicos de OpenRouter ni códigos de estado', async () => {
    const f = setupFlow([]);
    // Forzamos un fallo de IA para texto no numérico
    (f.deps.interpreter.interpret as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('OpenRouter respondió con estado 404')
    );
    const res = await handleText(f.deps, { resolution: f.resolution, text: 'algo incomprensible sin números', now: NOW });
    expect(res.text).toContain('No pude interpretar ese mensaje con el asistente inteligente');
    expect(res.text).not.toContain('404');
    expect(res.text).not.toContain('OpenRouter');
  });

  it('multi-monto ventas: "vendí 5000 y vendí 12000" parsea dos ventas sin contaminar la nota y confirma', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, { resolution: f.resolution, text: 'vendí 5000 y vendí 12000', now: NOW });
    expect(res.text).toContain('📋 *Confirmar ventas:*');
    expect(res.text).not.toContain('detectadas en el audio');
    expect(res.text).toContain('1. 🟢 *$ 5.000*');
    expect(res.text).toContain('2. 🟢 *$ 12.000*');
    expect(res.text).toContain('Total:* *$ 17.000* (2 ventas)');
    expect(res.text).toContain('¿Confirmás o querés corregir alguna?');
    expect(res.text).not.toContain('y vendí 12000'); // No debe quedar metido en la nota

    const confirmed = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(confirmed.text).toContain('2 ventas registradas con éxito');
    expect(f.repo.movements).toHaveLength(2);
  });

  it('si el mensaje proviene de un audio (isVoice: true), muestra "Ventas detectadas en el audio:"', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'vendí 5000 y vendí 12000',
      now: NOW,
      isVoice: true,
    });
    expect(res.text).toContain('Ventas detectadas en el audio:');
    expect(res.text).toContain('1. 🟢 *$ 5.000*');
    expect(res.text).toContain('2. 🟢 *$ 12.000*');
  });

  it('en modo continuo, enviar números por texto muestra "Confirmar ventas" y no "audio"', async () => {
    const f = setupFlow([]);
    // Inicia ventas
    await handleText(f.deps, { resolution: f.resolution, text: '/ventas', now: NOW });
    // Manda números por texto
    const res = await handleText(f.deps, { resolution: f.resolution, text: '3000 4000', now: NOW });
    expect(res.text).toContain('📋 *Confirmar ventas:*');
    expect(res.text).not.toContain('detectadas en el audio');
    expect(res.text).toContain('1. 🟢 *$ 3.000*');
    expect(res.text).toContain('2. 🟢 *$ 4.000*');
  });

  it('multi-monto ventas: "vendí 3000 y 12000" parsea ambas ventas correctamente', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, { resolution: f.resolution, text: 'vendí 3000 y 12000', now: NOW });
    expect(res.text).toContain('📋 *Confirmar ventas:*');
    expect(res.text).toContain('1. 🟢 *$ 3.000*');
    expect(res.text).toContain('2. 🟢 *$ 12.000*');
    expect(res.text).toContain('Total:* *$ 15.000* (2 ventas)');
  });

  it('ráfaga de gastos: "gasté 3000 en coca y 5000 en pan" extrae lote, confirma y registra', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'gasté 3000 en coca y 5000 en pan',
      now: NOW,
    });
    expect(res.text).toContain('📋 *Confirmar gastos:*');
    expect(res.text).not.toContain('detectados en el audio');
    expect(res.text).toContain('1. 🔴 *$ 3.000* - coca');
    expect(res.text).toContain('2. 🔴 *$ 5.000* - pan');
    expect(res.text).toContain('Total:* *$ 8.000* (2 gastos)');
    expect(res.text).toContain('¿Confirmás o querés corregir alguna?');

    const confirmed = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(confirmed.text).toContain('2 gastos registrados con éxito');
    expect(f.repo.movements).toHaveLength(2);
    expect(f.repo.movements[0]).toMatchObject({ kind: 'OUT', amount: 3000, concept: 'coca' });
    expect(f.repo.movements[1]).toMatchObject({ kind: 'OUT', amount: 5000, concept: 'pan' });
    expect(f.auditRepo.entries).toHaveLength(1);
    expect(f.auditRepo.entries[0]).toMatchObject({ action: 'kiosco.lote_registrado' });
  });

  it('ráfaga de gastos: "pagué 12000 al proveedor y 4500 de luz"', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'pagué 12000 al proveedor y 4500 de luz',
      now: NOW,
    });
    expect(res.text).toContain('Confirmar gastos:');
    expect(res.text).toContain('1. 🔴 *$ 12.000* - proveedor');
    expect(res.text).toContain('2. 🔴 *$ 4.500* - luz');
    expect(res.text).toContain('Total:* *$ 16.500* (2 gastos)');
  });

  it('corrección interactiva de lote por texto libre y por botón', async () => {
    const f = setupFlow([]);
    // 1. Entra lote con 3 ventas
    const initial = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'vendí 12000, 3000 y 8000',
      now: NOW,
    });
    expect(initial.text).toContain('Confirmar ventas:');
    expect(initial.text).toContain('1. 🟢 *$ 12.000*');
    expect(initial.text).toContain('2. 🟢 *$ 3.000*');
    expect(initial.text).toContain('3. 🟢 *$ 8.000*');
    expect(initial.text).toContain('Total:* *$ 23.000* (3 ventas)');

    // 2. Corrección por texto libre: "el 2 es 3300"
    const textFix = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'el 2 es 3300',
      now: NOW,
    });
    expect(textFix.text).toContain('2. 🟢 *$ 3.300*');
    expect(textFix.text).toContain('Total:* *$ 23.300* (3 ventas)');

    // 3. Borrar por texto libre: "borrar 3"
    const delFix = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'borrar 3',
      now: NOW,
    });
    expect(delFix.text).toContain('Total:* *$ 15.300* (2 ventas)');

    // 4. Corrección por botón interactivo: tocar "Corregir un monto"
    const promptReply = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'kiosco:correct_prompt',
      now: NOW,
    });
    expect(promptReply.text).toContain('Elegí qué monto querés corregir');
    expect(promptReply.inlineKeyboard).toBeDefined();

    // Tocar el botón de editar ítem 1
    const editReply = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'kiosco:edit_item:0',
      now: NOW,
    });
    expect(editReply.text).toContain('ítem 1');

    // Responder con el nuevo importe: 10000
    const fixedNum = await handleText(f.deps, {
      resolution: f.resolution,
      text: '10000',
      now: NOW,
    });
    expect(fixedNum.text).toContain('1. 🟢 *$ 10.000*');
    expect(fixedNum.text).toContain('Total:* *$ 13.300* (2 ventas)');

    // 5. Confirmar y verificar persistencia
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });
    expect(confirmed.text).toContain('2 ventas registradas con éxito');
    expect(f.repo.movements).toHaveLength(2);
    expect(f.repo.movements[0].amount).toBe(10000);
    expect(f.repo.movements[1].amount).toBe(3300);
  });

  it('calculadora asesor de precios: consulta abierta de lote sin porcentaje muestra 3 opciones de kiosco', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'gasté 30.000 en comprar un pack de 12 hierbas para el mate ¿a cuánto vendo cada una?',
      now: NOW,
    });
    expect(res.text).toContain('Precios sugeridos de venta (guía de kiosco):');
    expect(res.text).toContain('Lote de *12 unidades*');
    expect(res.text).toContain('Costo por unidad: *$ 2.500*');
    expect(res.text).toContain('Rotación rápida (+30% recargo):');
    expect(res.text).toContain('$ 3.250');
    expect(res.text).toContain('Kiosco estándar (+50% recargo - recomendado):');
    expect(res.text).toContain('$ 3.750');
    expect(res.text).toContain('Mayor ganancia (+75% recargo):');
    expect(res.text).toContain('$ 4.375');
    // Cero llamadas a IA
    expect(f.deps.interpreter.interpret).not.toHaveBeenCalled();
  });

  it('calculadora protección anti-gasto: "compré 30 alfajores a 18000 a cuánto lo vendo para ganar 40%" va a calculadora', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'compré 30 alfajores a 18000 a cuánto lo vendo para ganar 40%',
      now: NOW,
    });
    expect(res.text).toContain('Si calculás con Recargo (sobre el costo)');
    expect(res.text).toContain('Si calculás con Margen (sobre la venta)');
    expect(res.text).toContain('*Costo unitario:* *$ 600*');
    expect(f.repo.movements).toHaveLength(0); // NUNCA se registra como gasto
    expect(f.deps.interpreter.interpret).not.toHaveBeenCalled();
  });

  it('deshacer con confirmación preventiva (undo:ask -> undo:cancel / undo:confirm)', async () => {
    const f = setupFlow([{ action: 'registrar_venta', params: { monto: 5000 } }]);
    await handleText(f.deps, { resolution: f.resolution, text: 'Vendí 5000', now: NOW });
    await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(f.repo.movements).toHaveLength(1);

    // Tocar botón deshacer pide verificación
    const ask = await handleCallback(f.deps, { resolution: f.resolution, data: 'undo:ask', now: NOW });
    expect(ask.text).toContain('¿Confirmás anular la última operación?');
    expect(ask.inlineKeyboard?.[0]?.some((b) => b.callbackData === 'undo:confirm')).toBe(true);
    expect(ask.inlineKeyboard?.[0]?.some((b) => b.callbackData === 'undo:cancel')).toBe(true);

    // Cancelar no anula nada
    const cancel = await handleCallback(f.deps, { resolution: f.resolution, data: 'undo:cancel', now: NOW });
    expect(cancel.text).toContain('Operación mantenida');
    expect(f.repo.movements).toHaveLength(1);

    // Confirmar sí anula
    const confirm = await handleCallback(f.deps, { resolution: f.resolution, data: 'undo:confirm', now: NOW });
    expect(confirm.text).toContain('Se anuló la última venta');
    expect(confirm.text).toContain('$ 5.000');
    expect(f.repo.movements).toHaveLength(0);
  });

  it('menú interactivo de estadísticas navega por períodos y categorías', async () => {
    const f = setupFlow([]);
    await f.repo.addMovement({ businessId: BIZ, userId: ACTOR, kind: 'IN', amount: 30000, concept: 'Venta 1' });
    await f.repo.addMovement({ businessId: BIZ, userId: ACTOR, kind: 'OUT', amount: 8000, concept: 'Luz', category: 'Servicios' });

    // 1. Abrir menú de estadísticas
    const menu = await handleText(f.deps, { resolution: f.resolution, text: 'estadísticas', now: NOW });
    expect(menu.text).toContain('Estadísticas de tu negocio');
    expect(menu.inlineKeyboard?.[0]?.some((b) => b.callbackData === 'stats:hoy')).toBe(true);

    // 2. Tocar 'Hoy'
    const hoy = await handleCallback(f.deps, { resolution: f.resolution, data: 'stats:hoy', now: NOW });
    expect(hoy.text).toContain('Resumen de hoy');
    expect(hoy.text).toContain('Ventas: *$ 30.000*');
    expect(hoy.text).toContain('Gastos: *$ 8.000*');
    expect(hoy.text).toContain('Resultado en caja: +$ 22.000');

    // 3. Tocar 'Gastos por categoría'
    const cats = await handleCallback(f.deps, { resolution: f.resolution, data: 'stats:categorias', now: NOW });
    expect(cats.text).toContain('Gastos por categoría (este mes):');
    expect(cats.text).toContain('Servicios: *$ 8.000*');
  });

  it('template kiosco: replyMenu y menu unificados sin modo continuo y con Deshacer última acción', () => {
    const bundle = createKioscoTemplate({ db: {} as any });
    const replyLabels = bundle.template.replyMenu?.map((m) => m.label) || [];
    expect(replyLabels).toContain('💰 Ventas');
    expect(replyLabels).toContain('💸 Gastos');
    expect(replyLabels).toContain('↩️ Deshacer última acción');
    expect(replyLabels.some((l) => l.toLowerCase().includes('modo'))).toBe(false);

    const menuLabels = bundle.template.menu?.map((m) => m.label) || [];
    expect(menuLabels.some((l) => l.toLowerCase().includes('continuo'))).toBe(false);
    expect(menuLabels.some((l) => l.toLowerCase().includes('rápido'))).toBe(false);

    const commands = bundle.template.commands.map((c) => c.command);
    expect(commands).toContain('ventas');
    expect(commands).toContain('venta');
    expect(commands).toContain('gastos');
    expect(commands).toContain('gasto');
    expect(commands).toContain('deshacer');
  });

  it('concepto de gasto no duplica categoría si son iguales (ej: Alquiler no muestra Alquiler [Alquiler])', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'pagué 150000 de alquiler',
      now: NOW,
    });
    // Gasto individual directo
    expect(res.text).toContain('$ 150.000');
    expect(res.text.toLowerCase()).toContain('- alquiler');
    expect(res.text).not.toContain('alquiler [Alquiler]');
    expect(res.text).not.toContain('Alquiler [Alquiler]');
    expect(res.text).not.toContain('Categoría:');
  });

  it('lote confirmado cierra la sesión limpia sin botones residuales de deshacer/finalizar', async () => {
    const f = setupFlow([]);
    await handleText(f.deps, {
      resolution: f.resolution,
      text: '3000 y 5000',
      now: NOW,
    });
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });
    expect(confirmed.text).toContain('2 ventas registradas con éxito');
    expect(confirmed.inlineKeyboard).toBeUndefined();
    // Conversación debe haber quedado limpia
    const conv = await f.conversations.get(BIZ, ACTOR);
    expect(conv).toBeNull();
  });

  it('frases con jerga argentina y millones delegan al LLM sin romper números con comas', async () => {
    const f = setupFlow([
      {
        action: 'registrar_lote',
        params: {
          items: [
            { tipo: 'GASTO', monto: 150000, concepto: 'Alquiler', categoria: 'Alquiler' },
            { tipo: 'GASTO', monto: 1200000, concepto: 'Sueldo de empleado', categoria: 'Sueldos' },
          ],
        },
      },
    ]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'pagué 150.000 de alquiler y que le pagué 1.200.000 al sueldo de un empleado',
      now: NOW,
    });
    // Debe haber llamado a la IA porque es una frase compleja con millones
    expect(f.deps.interpreter.interpret).toHaveBeenCalled();
    expect(res.text).toContain('1. 🔴 *$ 150.000* - Alquiler');
    expect(res.text).toContain('2. 🔴 *$ 1.200.000* - Sueldo de empleado');
    expect(res.text).toContain('Total:* *$ 1.350.000* (2 gastos)');
  });

  it('zona horaria de Argentina: movimiento registrado a las 21:09 hs de ayer (00:09 UTC) pertenece a ayer y no a hoy', async () => {
    const f = setupFlow([]);
    // 21:09 hs de Argentina el 10 de octubre de 2026 = 00:09 hs UTC del 11 de octubre de 2026
    const fechaAyerNocheUtc = new Date('2026-10-11T00:09:00.000Z');
    await f.repo.addMovement({
      businessId: BIZ,
      userId: ACTOR,
      kind: 'IN',
      amount: 15000,
      concept: 'Venta de noche',
      date: fechaAyerNocheUtc,
    });

    // Ahora es el 11 de octubre a las 11:38 hs en Argentina (14:38 hs UTC)
    const fechaHoyDiaUtc = new Date('2026-10-11T14:38:00.000Z');

    // 1. Consultar resumen de "hoy" (no debe incluir la venta de las 21:09 de ayer)
    const resHoy = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'caja hoy',
      now: fechaHoyDiaUtc,
    });
    expect(resHoy.text).toContain('Ventas: *$ 0* (0 ventas)');
    expect(resHoy.text).toContain('Resultado en caja: +$ 0');

    // 2. Consultar resumen de "ayer" (SÍ debe incluir la venta de las 21:09)
    const resAyer = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'resumen ayer',
      now: fechaHoyDiaUtc,
    });
    expect(resAyer.text).toContain('Ventas: *$ 15.000* (1 venta)');
    expect(resAyer.text).toContain('Resultado en caja: +$ 15.000');
  });

  it('navegación de meses: permite consultar este mes y navegar al mes anterior con botones interactivos', async () => {
    const f = setupFlow([]);
    // Venta en Septiembre 2026 (mes anterior)
    await f.repo.addMovement({
      businessId: BIZ,
      userId: ACTOR,
      kind: 'IN',
      amount: 45000,
      concept: 'Venta Septiembre',
      date: new Date('2026-09-20T15:00:00Z'),
    });
    // Venta en Octubre 2026 (este mes)
    await f.repo.addMovement({
      businessId: BIZ,
      userId: ACTOR,
      kind: 'IN',
      amount: 80000,
      concept: 'Venta Octubre',
      date: new Date('2026-10-05T15:00:00Z'),
    });

    const refOctubre = new Date('2026-10-11T14:00:00Z');

    // 1. Consultar este mes (offset 0)
    const resEsteMes = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'stats:mes:0',
      now: refOctubre,
    });
    expect(resEsteMes.text).toContain('Resumen de este mes (Octubre 2026)');
    expect(resEsteMes.text).toContain('Ventas: *$ 80.000* (1 venta)');
    expect(resEsteMes.inlineKeyboard).toBeDefined();

    // Verificamos botones de navegación en mes actual:
    const flatButtonsMes0 = resEsteMes.inlineKeyboard!.flat();
    expect(flatButtonsMes0.find((b) => b.text.includes('Mes anterior'))?.callbackData).toBe('stats:mes:-1');
    expect(flatButtonsMes0.find((b) => b.text.includes('Ver semanas del mes'))?.callbackData).toBe('stats:semanas:0');
    // En mes actual no debe haber botón de "Mes siguiente"
    expect(flatButtonsMes0.some((b) => b.text.includes('Mes siguiente'))).toBe(false);

    // 2. Navegar al mes anterior (offset -1: Septiembre 2026)
    const resMesAnt = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'stats:mes:-1',
      now: refOctubre,
    });
    expect(resMesAnt.text).toContain('Resumen de Septiembre 2026');
    expect(resMesAnt.text).toContain('Ventas: *$ 45.000* (1 venta)');

    // En mes anterior debe tener botón para volver al mes siguiente (Octubre) y al mes anterior (Agosto)
    const flatButtonsMesAnt = resMesAnt.inlineKeyboard!.flat();
    expect(flatButtonsMesAnt.find((b) => b.text.includes('Mes anterior'))?.callbackData).toBe('stats:mes:-2');
    expect(flatButtonsMesAnt.find((b) => b.text.includes('Mes siguiente'))?.callbackData).toBe('stats:mes:0');
    expect(flatButtonsMesAnt.find((b) => b.text.includes('Ver semanas del mes'))?.callbackData).toBe('stats:semanas:-1');
  });

  it('desglose de semanas contables: muestra semanas del mes particionadas de lunes a domingo y suma exacta', async () => {
    const f = setupFlow([]);
    // Semana 1 de Octubre (1 al 4 de oct)
    await f.repo.addMovement({
      businessId: BIZ,
      userId: ACTOR,
      kind: 'IN',
      amount: 20000,
      concept: 'Venta Semana 1',
      date: new Date('2026-10-02T15:00:00Z'),
    });
    // Semana 2 de Octubre (5 al 11 de oct)
    await f.repo.addMovement({
      businessId: BIZ,
      userId: ACTOR,
      kind: 'IN',
      amount: 35000,
      concept: 'Venta Semana 2',
      date: new Date('2026-10-08T15:00:00Z'),
    });
    await f.repo.addMovement({
      businessId: BIZ,
      userId: ACTOR,
      kind: 'OUT',
      amount: 5000,
      concept: 'Gasto Pan',
      date: new Date('2026-10-08T16:00:00Z'),
    });

    const refOctubre = new Date('2026-10-11T14:00:00Z');

    // Consultar semanas del mes actual (offset 0)
    const resSemanas = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'stats:semanas:0',
      now: refOctubre,
    });

    expect(resSemanas.text).toContain('Semanas de Octubre 2026');
    expect(resSemanas.text).toContain('Semana 1 (1 al 4 de oct)');
    expect(resSemanas.text).toContain('Ventas: *$ 20.000* (1)');
    expect(resSemanas.text).toContain('Semana 2 (5 al 11 de oct)');
    expect(resSemanas.text).toContain('Ventas: *$ 35.000* (1) | 💸 Gastos: *$ 5.000* (1)');
    expect(resSemanas.text).toContain('Balance: *+$ 30.000*');
    // Total del mes debe sumar exactamente ambas semanas
    expect(resSemanas.text).toContain('Total de Octubre 2026:');
    expect(resSemanas.text).toContain('Ventas: *$ 55.000* (2)');
    expect(resSemanas.text).toContain('Gastos: *$ 5.000* (1)');
    expect(resSemanas.text).toContain('Resultado en caja: +$ 50.000');

    // Botones de navegación en desglose de semanas:
    const flatButtons = resSemanas.inlineKeyboard!.flat();
    expect(flatButtons.find((b) => b.text.includes('Semanas mes ant.'))?.callbackData).toBe('stats:semanas:-1');
    expect(flatButtons.find((b) => b.text.includes('Total del mes'))?.callbackData).toBe('stats:mes:0');
  });

  it('interpretación directa en texto: reconoce "mes pasado" y "semanas del mes"', async () => {
    const f = setupFlow([]);
    const ref = new Date('2026-10-11T14:00:00Z');

    const resMesPasado = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'mes pasado',
      now: ref,
    });
    expect(resMesPasado.text).toContain('Resumen de Septiembre 2026');

    const resSemanas = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'semanas del mes',
      now: ref,
    });
    expect(resSemanas.text).toContain('Semanas de Octubre 2026');
  });

  it('botón de la botonera persistente "📊 Estadísticas" abre el menú de estadísticas sin error', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: '📊 Estadísticas',
      now: NOW,
    });
    expect(res.text).toContain('Estadísticas de tu negocio');
    expect(res.inlineKeyboard).toBeDefined();
    const flat = res.inlineKeyboard!.flat();
    expect(flat.some((b) => b.callbackData === 'stats:hoy')).toBe(true);
    expect(flat.some((b) => b.callbackData === 'stats:ayer')).toBe(true);
    expect(flat.some((b) => b.callbackData === 'stats:semana')).toBe(true);
    expect(flat.some((b) => b.callbackData === 'stats:mes:0')).toBe(true);
    expect(flat.some((b) => b.callbackData === 'stats:categorias')).toBe(true);
    expect(flat.some((b) => b.callbackData === 'stats:movimientos')).toBe(true);
  });

  it('audio con silencios/pausas y multiplicadores: "vendí 8... mil pesos en coca cola y 15 mil en papa"', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'vendí 8... mil pesos en coca cola y 15 mil en papa',
      now: NOW,
    });
    expect(res.text).toContain('Confirmar ventas:');
    expect(res.text).toContain('1. 🟢 *$ 8.000* (coca cola)');
    expect(res.text).toContain('2. 🟢 *$ 15.000* (papa)');
    expect(res.text).toContain('Total:* *$ 23.000* (2 ventas)');
  });

  it('audio de ventas múltiples con productos: "vendí 8000 pesos en Coca Cola, 15000 en papa y 30000 en gaseosa"', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'vendí 8000 pesos en Coca Cola, 15000 en papa y 30000 en gaseosa',
      now: NOW,
    });
    expect(res.text).toContain('Confirmar ventas:');
    expect(res.text).toContain('1. 🟢 *$ 8.000* (Coca Cola)');
    expect(res.text).toContain('2. 🟢 *$ 15.000* (papa)');
    expect(res.text).toContain('Total:* *$ 53.000* (3 ventas)');
  });

  describe('RBAC: Dueño vs Empleado', () => {
    it('empleado: se le bloquea consultar_resumen por comando (/resumen, /estadisticas)', async () => {
      const f = setupFlow([], 'EMPLOYEE');
      const resResumen = await handleText(f.deps, { resolution: f.resolution, text: '/resumen', now: NOW });
      expect(resResumen.text).toContain('Solo el dueño del negocio puede consultar las estadísticas');

      const resStats = await handleText(f.deps, { resolution: f.resolution, text: '/estadisticas', now: NOW });
      expect(resStats.text).toContain('Solo el dueño del negocio puede consultar las estadísticas');
    });

    it('empleado: se le bloquea consultar_resumen por texto ("caja", "balance", "estadisticas")', async () => {
      const f = setupFlow([], 'EMPLOYEE');
      const resCaja = await handleText(f.deps, { resolution: f.resolution, text: 'caja hoy', now: NOW });
      expect(resCaja.text).toContain('Solo el dueño del negocio puede consultar las estadísticas');

      const resStats = await handleText(f.deps, { resolution: f.resolution, text: 'estadísticas', now: NOW });
      expect(resStats.text).toContain('Solo el dueño del negocio puede consultar las estadísticas');
    });

    it('empleado: se le bloquea callback con prefijo stats:', async () => {
      const f = setupFlow([], 'EMPLOYEE');
      const resCb = await handleCallback(f.deps, { resolution: f.resolution, data: 'stats:hoy', now: NOW });
      expect(resCb.text).toContain('Solo el dueño del negocio puede consultar las estadísticas');
    });

    it('empleado: menú inline (/menu) no incluye estadísticas pero sí movimientos y calculadora', () => {
      const { cash } = setupServices();
      const { template } = createKioscoTemplateWithCash(cash);
      const menuEmp = template.getMenu?.('EMPLOYEE') ?? [];
      expect(menuEmp.some((m) => m.action === 'consultar_resumen')).toBe(false);
      expect(menuEmp.some((m) => m.action === 'registrar_venta')).toBe(true);
      expect(menuEmp.some((m) => m.action === 'registrar_gasto')).toBe(true);
      expect(menuEmp.some((m) => m.action === 'consultar_movimientos')).toBe(true);
      expect(menuEmp.some((m) => m.action === 'calcular_precio')).toBe(true);
      expect(menuEmp.some((m) => m.action === 'deshacer_ultimo')).toBe(true);

      const menuOwner = template.getMenu?.('OWNER') ?? [];
      expect(menuOwner.some((m) => m.action === 'consultar_resumen')).toBe(true);
    });

    it('empleado: replyMenu persistente reemplaza estadísticas por movimientos', () => {
      const { cash } = setupServices();
      const { template } = createKioscoTemplateWithCash(cash);
      const replyEmp = template.getReplyMenu?.('EMPLOYEE') ?? [];
      expect(replyEmp.some((m) => m.action === 'consultar_resumen')).toBe(false);
      expect(replyEmp.some((m) => m.action === 'consultar_movimientos')).toBe(true);

      const replyOwner = template.getReplyMenu?.('OWNER') ?? [];
      expect(replyOwner.some((m) => m.action === 'consultar_resumen')).toBe(true);
    });

    it('empleado: tap en "📋 Movimientos" en barra persistente dispara últimos movimientos', async () => {
      const f = setupFlow([], 'EMPLOYEE');
      await f.repo.addMovement({ businessId: BIZ, userId: ACTOR, kind: 'IN', amount: 3500, concept: 'Venta' });
      const res = await handleText(f.deps, { resolution: f.resolution, text: '📋 Movimientos', now: NOW });
      expect(res.text).toContain('Últimos movimientos');
      expect(res.text).toContain('+$ 3.500');
    });

    it('empleado: PUEDE registrar ventas, gastos, calcular precio y deshacer', async () => {
      const f = setupFlow([], 'EMPLOYEE');
      // Venta
      const resVenta = await handleText(f.deps, { resolution: f.resolution, text: 'vendí 4200', now: NOW });
      expect(resVenta.text).toContain('Venta registrada');
      expect(f.repo.movements).toHaveLength(1);
      await handleCallback(f.deps, { resolution: f.resolution, data: 'continuous:fin', now: NOW });

      // Gasto
      const resGasto = await handleText(f.deps, { resolution: f.resolution, text: 'gasté 1500 en pan', now: NOW });
      expect(resGasto.text).toContain('Gasto registrado');
      expect(f.repo.movements).toHaveLength(2);
      await handleCallback(f.deps, { resolution: f.resolution, data: 'continuous:fin', now: NOW });

      // Calcular precio
      const resCalc = await handleText(f.deps, { resolution: f.resolution, text: 'costo 500 margen 50%', now: NOW });
      expect(resCalc.text).toContain('Precio de venta: $ 1.000');

      // Deshacer
      const resUndo = await handleText(f.deps, { resolution: f.resolution, text: '/deshacer', now: NOW });
      expect(resUndo.text).toContain('Se anuló el último movimiento');
      expect(f.repo.movements).toHaveLength(1);
    });
  });

  it('lote de ventas rápidas con productos sin verbo: "8000 gaseosa, 15000 papa, 30000 golosinas"', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: '8000 gaseosa, 15000 papa, 30000 golosinas',
      now: NOW,
    });
    expect(res.text).toContain('Confirmar ventas:');
    expect(res.text).toContain('1. 🟢 *$ 8.000* (gaseosa)');
    expect(res.text).toContain('2. 🟢 *$ 15.000* (papa)');
    expect(res.text).toContain('3. 🟢 *$ 30.000* (golosinas)');
    expect(res.text).toContain('Total:* *$ 53.000* (3 ventas)');
  });

  it('audio en modo libre con un solo gasto entra en confirmación registrar_lote con concepto y categoría en líneas separadas sin guardar antes', async () => {
    const f = setupFlow([
      {
        action: 'registrar_lote',
        params: {
          items: [
            { tipo: 'GASTO', monto: 1000000, concepto: 'sueldo de empleado', categoria: 'Sueldos' },
          ],
        },
      },
    ]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'Le pagué a un empleado el sueldo de un millón',
      isVoice: true,
      now: NOW,
    });

    // 1. Debe mostrar resumen claro con monto y concepto en 1 línea, sin categoría visible
    expect(res.text).toContain('🎤 *Gasto detectado en el audio:*');
    expect(res.text).toContain('🔴 *$ 1.000.000* - sueldo de empleado');
    expect(res.text).not.toContain('Categoría:');
    expect(res.inlineKeyboard).toBeDefined();
    expect(res.inlineKeyboard?.[0]?.[0]?.callbackData).toBe('confirm:yes');
    expect(res.inlineKeyboard?.[1]?.[0]?.callbackData).toBe('kiosco:correct_prompt');

    // 2. NO debe haber mutado la base de datos todavía
    expect(f.repo.movements).toHaveLength(0);

    // 3. Confirmar mediante botón
    const confirmed = await handleCallback(f.deps, {
      resolution: f.resolution,
      data: 'confirm:yes',
      now: NOW,
    });
    expect(confirmed.text).toContain('✅ *Gasto registrado con éxito:*');
    expect(confirmed.text).toContain('🔴 *$ 1.000.000* - sueldo de empleado');
    expect(confirmed.text).not.toContain('Categoría:');

    // 4. Se persistió el movimiento y la conversación quedó limpia (sin modo continuo)
    expect(f.repo.movements).toHaveLength(1);
    expect(f.repo.movements[0]).toMatchObject({
      kind: 'OUT',
      amount: 1000000,
      concept: 'sueldo de empleado',
      category: 'Sueldos',
    });
    const conv = await f.conversations.get(BIZ, ACTOR);
    expect(conv).toBeNull();
  });

  it('audio en modo libre que devuelve registrar_gasto se convierte automáticamente a registrar_lote', async () => {
    const f = setupFlow([
      {
        action: 'registrar_gasto',
        params: { monto: 1000000, concepto: 'sueldo de empleado', categoria: 'Sueldos' },
      },
    ]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'Le pagué a un empleado el sueldo de un millón',
      isVoice: true,
      now: NOW,
    });

    // Debe haberse interceptado y solicitado confirmación
    expect(res.text).toContain('🎤 *Gasto detectado en el audio:*');
    expect(res.text).toContain('🔴 *$ 1.000.000* - sueldo de empleado');
    expect(res.text).not.toContain('Categoría:');
    expect(f.repo.movements).toHaveLength(0);
  });

  it('corrección natural "es 900000" en lote de un solo ítem actualiza el monto', async () => {
    const f = setupFlow([
      {
        action: 'registrar_lote',
        params: {
          items: [
            { tipo: 'GASTO', monto: 1000000, concepto: 'sueldo de empleado', categoria: 'Sueldos' },
          ],
        },
      },
    ]);
    await handleText(f.deps, {
      resolution: f.resolution,
      text: 'Le pagué a un empleado el sueldo de un millón',
      isVoice: true,
      now: NOW,
    });

    // Corregir mediante texto natural
    const corrected = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'es 900000',
      now: NOW,
    });
    expect(corrected.text).toContain('🔴 *$ 900.000* - sueldo de empleado');
  });
});

