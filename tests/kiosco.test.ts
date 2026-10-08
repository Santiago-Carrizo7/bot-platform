import { describe, expect, it, vi } from 'vitest';
import type { MoneyMovement, PrismaClient } from '@prisma/client';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import type { ActionDef, TemplateDefinition } from '../src/core/actions/registry.js';
import type { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { CashService, inferCategory } from '../src/templates/kiosco/domain/cash.service.js';
import { buildKioscoActions } from '../src/templates/kiosco/actions.js';
import { interpretDirectlyKiosco } from '../src/templates/kiosco/index.js';
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
  function setupFlow(queue: Array<{ action: string; params: Record<string, unknown> }>) {
    const { cash, repo } = setupServices();
    const actions = buildKioscoActions({ cash });
    const template: TemplateDefinition = {
      id: 'kiosco',
      label: 'Kiosco',
      welcome: () => 'Bienvenido',
      systemPrompt: () => 'sys',
      actions,
      commands: [
        { command: 'venta', action: 'registrar_venta' },
        { command: 'ventas', action: 'modo_ventas' },
        { command: 'gasto', action: 'registrar_gasto' },
        { command: 'gastos', action: 'modo_gastos' },
        { command: 'resumen', action: 'consultar_resumen' },
        { command: 'movimientos', action: 'consultar_movimientos' },
        { command: 'calcular', action: 'calcular_precio' },
        { command: 'deshacer', action: 'deshacer_ultimo' },
      ],
      menu: [],
      interpretDirectly: interpretDirectlyKiosco,
    };
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
    const tenant: TenantContext = { business, membership, user, botTemplateId: 'kiosco' };
    const resolution: ResolutionInfo = { user, tenant, justJoined: false, memberships: [], needsInvitation: false };
    return { deps, resolution, auditRepo, repo, businesses, conversations };
  }

  it('modo normal: "Vendí 5000" pide confirmación Sí/No, registra, audita y ofrece Deshacer', async () => {
    const f = setupFlow([{ action: 'registrar_venta', params: { monto: 5000 } }]);
    const ask = await handleText(f.deps, { resolution: f.resolution, text: 'Vendí 5000', now: NOW });
    expect(ask.text).toContain('¿Confirmar?');
    expect(ask.text).toContain('$ 5.000');

    const done = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(done.text).toContain('🟢 Venta registrada: *$ 5.000*');
    expect(done.inlineKeyboard).toEqual([[{ text: '↩️ Deshacer', callbackData: 'undo:ask' }]]);
    expect(f.auditRepo.entries).toHaveLength(1);
    expect(f.auditRepo.entries[0]).toMatchObject({ action: 'sale.recorded', actorUserId: ACTOR });
    expect(f.repo.movements).toHaveLength(1);
  });

  it('modo normal: registrar gasto pide confirmación y categoriza', async () => {
    const f = setupFlow([{ action: 'registrar_gasto', params: { monto: 3500, concepto: 'Coca Cola', categoria: 'Mercadería' } }]);
    const ask = await handleText(f.deps, { resolution: f.resolution, text: 'Gasté 3500 en Coca Cola', now: NOW });
    expect(ask.text).toContain('¿Confirmar?');
    expect(ask.text).toContain('Coca Cola');

    const done = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(done.text).toContain('🔴 Gasto registrado: *$ 3.500*');
    expect(done.text).toContain('Mercadería');
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

  it('modo continuo de ventas: /ventas activa modo rápido, números registran directo, deshacer funciona y /fin finaliza', async () => {
    const f = setupFlow([]);

    // 1. Activar modo ventas
    const start = await handleText(f.deps, { resolution: f.resolution, text: '/ventas', now: NOW });
    expect(start.text).toContain('🟢 *Modo ventas activo*');

    // 2. Enviar importes consecutivos (sin IA, registro inmediato)
    const v1 = await handleText(f.deps, { resolution: f.resolution, text: '2500', now: NOW });
    expect(v1.text).toContain('🟢 Venta registrada: *$ 2.500*');
    expect(v1.text).toContain('Total acumulado: $ 2.500 (1)');

    const v2 = await handleText(f.deps, { resolution: f.resolution, text: '4300', now: NOW });
    expect(v2.text).toContain('🟢 Venta registrada: *$ 4.300*');
    expect(v2.text).toContain('Total acumulado: $ 6.800 (2)');

    // 3. Deshacer última venta desde callback
    const undo = await handleCallback(f.deps, { resolution: f.resolution, data: 'undo:last', now: NOW });
    expect(undo.text).toContain('Se anuló la última venta de *$ 4.300*');
    expect(undo.text).toContain('Total acumulado: $ 2.500 (1)');

    // 4. Cargar otra venta con texto
    const v3 = await handleText(f.deps, { resolution: f.resolution, text: '1800', now: NOW });
    expect(v3.text).toContain('🟢 Venta registrada: *$ 1.800*');
    expect(v3.text).toContain('Total acumulado: $ 4.300 (2)');

    // 5. Finalizar con /fin
    const end = await handleText(f.deps, { resolution: f.resolution, text: '/fin', now: NOW });
    expect(end.text).toContain('🏁 *Registro de ventas finalizado*');
    expect(end.text).toContain('Ventas registradas: *2*');
    expect(end.text).toContain('Total acumulado: *$ 4.300*');

    // Estado de conversación queda limpio
    const conv = await f.conversations.get(BIZ, ACTOR);
    expect(conv).toBeNull();
  });

  it('calculador de precio: si falta tipo explica margen vs recargo; si está completo calcula ganancia', async () => {
    // Caso 1: sin tipo especificado -> pide aclaración pedagógica
    const f1 = setupFlow([{ action: 'calcular_precio', params: { costo_total: 18000, cantidad: 30, porcentaje: 40 } }]);
    const askType = await handleText(f1.deps, { resolution: f1.resolution, text: 'compré 30 alfajores por 18000 y quiero ganar 40%', now: NOW });
    expect(askType.text).toContain('¿Querés calcular usando *margen* o *recargo*');
    expect(askType.text).toContain('Recargo / Markup');
    expect(askType.text).toContain('Margen');

    // Caso 2: con margen especificado -> cálculo matemático
    const f2 = setupFlow([{ action: 'calcular_precio', params: { costo_unitario: 600, porcentaje: 40, tipo: 'margen', cantidad: 30 } }]);
    const res = await handleText(f2.deps, { resolution: f2.resolution, text: 'costo 600, 40% de margen', now: NOW });
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
    expect(reply.text).toContain('Resultado registrado: +$ 15.000');
    expect(reply.text).toContain('no la ganancia contable real');
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

  it('/venta sin argumentos pide el importe y no genera NaN', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, { resolution: f.resolution, text: '/venta', now: NOW });
    expect(res.text).toContain('decime el monto');
    expect(res.text).not.toContain('NaN');

    // Luego el usuario envía el monto suelto en modo COLLECTING
    const followUp = await handleText(f.deps, { resolution: f.resolution, text: '3500 alfajor', now: NOW });
    expect(followUp.text).toContain('¿Confirmás registrar la venta de *$ 3.500*');
    expect(followUp.text).not.toContain('NaN');
  });

  it('/venta con monto (/venta 5000) entra directo en confirmación', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, { resolution: f.resolution, text: '/venta 5000', now: NOW });
    expect(res.text).toContain('¿Confirmás registrar la venta de *$ 5.000*');
    expect(res.text).not.toContain('NaN');
  });

  it('un número freestyle (3000) se interpreta directamente sin IA y pide confirmación', async () => {
    const f = setupFlow([]); // Cola de IA vacía
    const res = await handleText(f.deps, { resolution: f.resolution, text: '3000', now: NOW });
    expect(res.text).toContain('¿Confirmás registrar la venta de *$ 3.000*');
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

  it('modo continuo soporta deshacer multi-paso hasta vaciar la tanda', async () => {
    const f = setupFlow([]);
    await handleText(f.deps, { resolution: f.resolution, text: '/ventas', now: NOW });

    await handleText(f.deps, { resolution: f.resolution, text: '1000', now: NOW });
    await handleText(f.deps, { resolution: f.resolution, text: '2000', now: NOW });
    await handleText(f.deps, { resolution: f.resolution, text: '3000', now: NOW });

    // Deshacer paso 1: 3000 anulado -> quedan 2
    const u1 = await handleCallback(f.deps, { resolution: f.resolution, data: 'undo:last', now: NOW });
    expect(u1.text).toContain('Se anuló la última venta de *$ 3.000*');
    expect(u1.text).toContain('Total acumulado: $ 3.000 (2)');
    expect(u1.inlineKeyboard?.[0]?.some((b) => b.callbackData === 'undo:ask')).toBe(true);

    // Deshacer paso 2: 2000 anulado -> queda 1
    const u2 = await handleCallback(f.deps, { resolution: f.resolution, data: 'undo:last', now: NOW });
    expect(u2.text).toContain('Se anuló la última venta de *$ 2.000*');
    expect(u2.text).toContain('Total acumulado: $ 1.000 (1)');
    expect(u2.inlineKeyboard?.[0]?.some((b) => b.callbackData === 'undo:ask')).toBe(true);

    // Deshacer paso 3: 1000 anulado -> quedan 0
    const u3 = await handleCallback(f.deps, { resolution: f.resolution, data: 'undo:last', now: NOW });
    expect(u3.text).toContain('Se anuló la última venta de *$ 1.000*');
    expect(u3.text).toContain('Total acumulado: $ 0 (0)');
    // Cuando quedan 0, ya no debe tener deshacer, solo finalizar
    expect(u3.inlineKeyboard?.[0]?.some((b) => b.callbackData === 'undo:ask')).toBe(false);
    expect(u3.inlineKeyboard?.[0]?.some((b) => b.callbackData === 'continuous:fin')).toBe(true);
  });

  it('modo continuo procesa ráfagas de números de audio/texto en un solo paso', async () => {
    const f = setupFlow([]);
    await handleText(f.deps, { resolution: f.resolution, text: '/ventas', now: NOW });

    // Enviar ráfaga de 4 números separados por espacio
    const res = await handleText(f.deps, { resolution: f.resolution, text: '3200 2800 2500 8000', now: NOW });
    expect(res.text).toContain('4 ventas registradas');
    expect(res.text).toContain('$ 3.200');
    expect(res.text).toContain('$ 2.800');
    expect(res.text).toContain('$ 2.500');
    expect(res.text).toContain('$ 8.000');
    expect(res.text).toContain('Total acumulado: $ 16.500 (4)');
    expect(f.repo.movements).toHaveLength(4);
  });

  it('audio o texto con múltiples ventas fuera de modo continuo pide confirmación conjunta', async () => {
    const f = setupFlow([]);
    const res = await handleText(f.deps, {
      resolution: f.resolution,
      text: 'hice dos ventas, una de 2.000 y otra de 3.800',
      now: NOW,
    });
    expect(res.text).toContain('Entendí las ventas:');
    expect(res.text).toContain('• *$ 2.000*');
    expect(res.text).toContain('• *$ 3.800*');
    expect(res.text).toContain('Total: *$ 5.800*');
    expect(res.text).toContain('¿Confirmar?');

    // Confirmar registra ambas en la base de datos
    const confirmed = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(confirmed.text).toContain('Registradas *2* ventas por un total de *$ 5.800*');
    expect(f.repo.movements).toHaveLength(2);
  });

  it('deshacer con confirmación preventiva (undo:ask -> undo:cancel / undo:confirm)', async () => {
    const f = setupFlow([]);
    await handleText(f.deps, { resolution: f.resolution, text: '/ventas', now: NOW });
    await handleText(f.deps, { resolution: f.resolution, text: '5000', now: NOW });

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
    expect(confirm.text).toContain('Se anuló la última venta de *$ 5.000*');
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
    expect(hoy.text).toContain('Resumen de hoy:');
    expect(hoy.text).toContain('Ventas: *$ 30.000*');
    expect(hoy.text).toContain('Gastos: *$ 8.000*');
    expect(hoy.text).toContain('Resultado registrado: +$ 22.000');

    // 3. Tocar 'Gastos por categoría'
    const cats = await handleCallback(f.deps, { resolution: f.resolution, data: 'stats:categorias', now: NOW });
    expect(cats.text).toContain('Gastos por categoría (este mes):');
    expect(cats.text).toContain('Servicios: *$ 8.000*');
  });
});
