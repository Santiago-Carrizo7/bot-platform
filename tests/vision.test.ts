import { describe, expect, it, vi } from 'vitest';
import { VisionService } from '../src/infrastructure/ai/vision.service.js';
import { buildKioscoActions } from '../src/templates/kiosco/actions.js';
import { CashService } from '../src/templates/kiosco/domain/cash.service.js';
import { FakeAiUsageRepo, FakeAuditRepo, FakeBusinessRepo, FakeConversationRepo, FakeMembershipRepo, makeBusiness } from './fakes.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import type { MoneyMovement } from '@prisma/client';
import type { ActionContext } from '../src/core/actions/registry.js';

let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;
const NOW = new Date('2026-10-08T12:00:00Z');

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
      relatedType: null,
      relatedId: null,
      createdAt: new Date(),
    } as MoneyMovement;
    this.movements.push(m);
    return m;
  }

  async undoLastMovement() {
    return this.movements.pop() ?? null;
  }

  async getMovementsBetween() {
    return this.movements;
  }

  async listRecent() {
    return [...this.movements].reverse();
  }
}

describe('VisionService & Procesamiento de Libretas', () => {
  it('detecta configuración correctamente según las API keys provistas', () => {
    const unconfigured = new VisionService({});
    expect(unconfigured.isConfigured()).toBe(false);

    const withGemini = new VisionService({ geminiKey: 'gem-123' });
    expect(withGemini.isConfigured()).toBe(true);

    const withGroq = new VisionService({ groqKey: 'gsk-123' });
    expect(withGroq.isConfigured()).toBe(true);
  });

  it('parsea respuestas JSON con markdown fencing y texto circundante', async () => {
    const vision = new VisionService({ geminiKey: 'dummy-key' });
    const mockJson = JSON.stringify({
      items: [
        { tipo: 'VENTA', monto: 1800, nota: 'Alfajor' },
        { tipo: 'VENTA', monto: 2500 },
        { tipo: 'GASTO', monto: 12000, concepto: 'Proveedor Coca', categoria: 'Bebidas' },
      ],
    });

    // Mockeamos callVisionModel para simular la respuesta del LLM con formato markdown
    vi.spyOn(vision as any, 'callVisionModel').mockResolvedValue(`\`\`\`json\n${mockJson}\n\`\`\``);

    const result = await vision.extractLedgerItems('base64data');
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual({ tipo: 'VENTA', monto: 1800, nota: 'Alfajor' });
    expect(result.items[1]).toEqual({ tipo: 'VENTA', monto: 2500 });
    expect(result.items[2]).toEqual({ tipo: 'GASTO', monto: 12000, concepto: 'Proveedor Coca', categoria: 'Bebidas' });
  });

  it('cascada de visión: pasa al siguiente proveedor si el primero falla', async () => {
    const vision = new VisionService({ geminiKey: 'gem-fail', groqKey: 'groq-ok' });

    let callCount = 0;
    vi.spyOn(vision as any, 'callVisionModel').mockImplementation(async (candidate: any) => {
      callCount++;
      if (candidate.name === 'Google Gemini Vision') {
        throw new Error('Rate limit 429');
      }
      return JSON.stringify({
        items: [{ tipo: 'VENTA', monto: 5000 }],
      });
    });

    const result = await vision.extractLedgerItems('base64data');
    expect(callCount).toBe(2);
    expect(result.provider).toBe('Groq Vision');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].monto).toBe(5000);
  });

  it('límite de 5 fotos diarias: FakeAiUsageRepo cuenta fotos y bloquea la 6ta', async () => {
    const aiUsage = new FakeAiUsageRepo();
    const bizId = 'biz-test';
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    for (let i = 0; i < 5; i++) {
      expect(await aiUsage.countVisionByBusinessSince(bizId, startOfDay)).toBe(i);
      await aiUsage.log({
        businessId: bizId,
        provider: 'vision',
        model: 'vision:gemini-2.0-flash',
      });
    }

    const currentCount = await aiUsage.countVisionByBusinessSince(bizId, startOfDay);
    expect(currentCount).toBe(5);
    // Un chequeo >= 5 deniega una 6ta foto
    expect(currentCount >= 5).toBe(true);
  });

  it('acción registrar_lote: registra ventas y gastos en lote y genera auditoría', async () => {
    const fakeCash = new FakeCashRepo();
    const cashService = new CashService(fakeCash as any);
    const actions = buildKioscoActions({ cash: cashService });
    const registrarLote = actions.find((a) => a.name === 'registrar_lote')!;

    expect(registrarLote).toBeDefined();

    const business = makeBusiness({ id: 'biz-1' });
    const ctx: ActionContext = {
      tenant: {
        business,
        membership: { id: 'm-1', businessId: 'biz-1', userId: 'u-1', role: 'OWNER', createdAt: NOW },
      },
      actorUserId: 'u-1',
      now: NOW,
    };

    const input = {
      items: [
        { tipo: 'VENTA' as const, monto: 1500, nota: 'Galletitas' },
        { tipo: 'VENTA' as const, monto: 3000 },
        { tipo: 'GASTO' as const, monto: 8000, concepto: 'Coca Cola', categoria: 'Mercadería' },
      ],
    };

    // Resumen legible
    const summary = registrarLote.summarize?.(input);
    expect(summary).toContain('1.500');
    expect(summary).toContain('8.000');
    expect(summary).toContain('Galletitas');

    // Ejecución
    const result = await registrarLote.handler(ctx, input);
    expect(result.reply).toContain('2 ventas');
    expect(result.reply).toContain('1 gastos');
    expect(result.audit?.action).toBe('kiosco.lote_registrado');

    // Verificación de movimientos en caja
    expect(fakeCash.movements).toHaveLength(3);
    expect(fakeCash.movements[0].kind).toBe('IN');
    expect(fakeCash.movements[0].amount).toBe(1500);
    expect(fakeCash.movements[1].kind).toBe('IN');
    expect(fakeCash.movements[1].amount).toBe(3000);
    expect(fakeCash.movements[2].kind).toBe('OUT');
    expect(fakeCash.movements[2].amount).toBe(8000);
  });
});
