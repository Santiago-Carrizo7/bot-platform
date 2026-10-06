import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Budget, Category, Expense } from '@prisma/client';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import type { ActionDef, TemplateDefinition } from '../src/core/actions/registry.js';
import type { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { verifyApiToken } from '../src/infrastructure/http/api-tokens.js';
import { RegistrarGastoInput } from '../src/templates/gastos/schemas.js';
import { ExpenseService } from '../src/templates/gastos/domain/expense.service.js';
import { CategoryService } from '../src/templates/gastos/domain/category.service.js';
import { BudgetService } from '../src/templates/gastos/domain/budget.service.js';
import { buildGastosActions } from '../src/templates/gastos/actions.js';
import type { ExpenseRepository } from '../src/templates/gastos/persistence/expense.repo.js';
import type { CategoryRepository } from '../src/templates/gastos/persistence/category.repo.js';
import type { BudgetRepository } from '../src/templates/gastos/persistence/budget.repo.js';
import { SYSTEM_CATEGORIES } from '../src/templates/gastos/types.js';
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
const API_SECRET = 'secreto-de-prueba-muy-largo-123';

function asExpense(partial: Partial<Expense>): Expense {
  return {
    id: 'exp-1',
    businessId: 'biz-1',
    userId: 'user-1',
    amount: 5000 as unknown as Expense['amount'],
    description: 'Saeta',
    category: 'transporte',
    categoryId: null,
    date: new Date('2026-10-06T12:00:00Z'),
    installments: 1,
    currency: 'ARS',
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  } as Expense;
}

class FakeExpenseRepo {
  readonly store = new Map<string, Expense>();
  async create(data: {
    businessId: string; userId: string; amount: number; description: string;
    category: string; categoryId?: string; date: Date; installments?: number; currency?: string;
  }) {
    const e = asExpense({
      id: `exp-${this.store.size + 1}`,
      businessId: data.businessId,
      userId: data.userId,
      amount: data.amount as unknown as Expense['amount'],
      description: data.description,
      category: data.category,
      categoryId: data.categoryId ?? null,
      date: data.date,
      installments: data.installments ?? 1,
      currency: data.currency ?? 'ARS',
    });
    this.store.set(e.id, e);
    return e;
  }
  async findById(id: string, businessId: string) {
    const e = this.store.get(id);
    return e && e.businessId === businessId ? e : null;
  }
  async findLast(businessId: string, limit = 5) {
    return [...this.store.values()].filter((e) => e.businessId === businessId).slice(0, limit);
  }
  async findMany() {
    return [...this.store.values()];
  }
  async update(id: string, _businessId: string, data: Partial<Expense>) {
    const e = this.store.get(id);
    if (!e) return null;
    const updated = { ...e, ...data };
    this.store.set(id, updated);
    return updated;
  }
  async delete(id: string) {
    const e = this.store.get(id);
    if (!e) return null;
    this.store.delete(id);
    return e;
  }
  async getTotalByDateRange() {
    return { total: 0, count: 0 };
  }
  async getBreakdownByDateRange() {
    return [];
  }
}

class FakeCategoryRepo {
  readonly store: Category[] = [...SYSTEM_CATEGORIES].map((c, i) => ({
    id: `cat-${i}`,
    businessId: 'biz-1',
    name: c.name,
    icon: c.icon,
    isSystem: true,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  async seedDefaults() {
    /* ya sembrado */
  }
  async findActiveByBusiness(businessId: string) {
    return this.store.filter((c) => c.businessId === businessId && c.isActive);
  }
  async findByName(businessId: string, name: string) {
    return this.store.find((c) => c.businessId === businessId && c.name === name && c.isActive) ?? null;
  }
  async findById(id: string, businessId: string) {
    return this.store.find((c) => c.id === id && c.businessId === businessId) ?? null;
  }
  async create(businessId: string, data: { name: string; icon?: string }) {
    const c: Category = {
      id: `cat-custom-${this.store.length}`,
      businessId,
      name: data.name,
      icon: data.icon ?? null,
      isSystem: false,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.store.push(c);
    return c;
  }
  async update(id: string, _businessId: string, data: { name?: string; icon?: string }) {
    const c = this.store.find((x) => x.id === id);
    if (!c) throw new Error('no encontrada');
    if (data.name) c.name = data.name;
    if (data.icon !== undefined) c.icon = data.icon ?? null;
    return c;
  }
  async deactivate(id: string) {
    const c = this.store.find((x) => x.id === id);
    if (!c) throw new Error('no encontrada');
    c.isActive = false;
    return c;
  }
}

class FakeBudgetRepo {
  readonly store: Budget[] = [];
  async upsert(businessId: string, userId: string, category: string, amount: number, currency = 'ARS') {
    const b = {
      id: `bud-${this.store.length + 1}`,
      businessId,
      userId,
      category,
      amount: amount as unknown as Budget['amount'],
      currency,
      createdAt: NOW,
      updatedAt: NOW,
    } as Budget;
    this.store.push(b);
    return b;
  }
  async findByUser(businessId: string, userId: string) {
    return this.store.filter((b) => b.businessId === businessId && b.userId === userId);
  }
  async delete(id: string) {
    const i = this.store.findIndex((b) => b.id === id);
    if (i < 0) return null;
    return this.store.splice(i, 1)[0];
  }
}

function setupServices() {
  const expenseRepo = new FakeExpenseRepo();
  const categoryRepo = new FakeCategoryRepo();
  const budgetRepo = new FakeBudgetRepo();
  const categories = new CategoryService(categoryRepo as unknown as CategoryRepository);
  const expenses = new ExpenseService(expenseRepo as unknown as ExpenseRepository, categories);
  const budgets = new BudgetService(
    budgetRepo as unknown as BudgetRepository,
    expenseRepo as unknown as ExpenseRepository,
    categories
  );
  return { expenses, categories, budgets, expenseRepo };
}

function setupFlow(actionQueue: Array<{ action: string; params: Record<string, unknown> }>, role: 'OWNER' | 'EMPLOYEE' = 'EMPLOYEE') {
  const { expenses, categories, budgets } = setupServices();
  const actions = buildGastosActions({ expenses, categories, budgets, apiSecret: API_SECRET, apiTokenTtlSeconds: 3600 });
  const template: TemplateDefinition = {
    id: 'gastos',
    label: 'Gastos',
    welcome: () => 'Bienvenido',
    systemPrompt: () => 'sys',
    actions,
    commands: [
      { command: 'gastos', action: 'consultar_ultimos' },
      { command: 'vincular', action: 'generar_vinculacion' },
    ],
    menu: [],
  };
  const businesses = new FakeBusinessRepo();
  const membershipRepo = new FakeMembershipRepo(businesses);
  const conversations = new FakeConversationRepo();
  const auditRepo = new FakeAuditRepo();
  const business = businesses.seed(makeBusiness({ id: 'biz-1', templateId: 'gastos' }));
  const user = { id: 'user-1', telegramId: 'tg-1', createdAt: NOW, updatedAt: NOW };
  const membership = {
    id: 'mem-1', businessId: business.id, userId: user.id, role,
    lastUsedAt: null, createdAt: NOW, updatedAt: NOW,
  };
  membershipRepo.store.set(membership.id, membership);
  const interpreter = {
    interpret: vi.fn(async (_sys: string, all: ActionDef<unknown>[]) => {
      const next = actionQueue.shift();
      if (!next) throw new Error('sin respuestas de IA');
      const action = all.find((a) => a.name === next.action);
      if (!action) throw new Error('acción desconocida');
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
  const tenant: TenantContext = { business, membership, user, botTemplateId: 'gastos' };
  const resolution: ResolutionInfo = { user, tenant, justJoined: false, memberships: [], needsInvitation: false };
  return { deps, resolution, auditRepo, conversations };
}

describe('template gastos', () => {
  describe('schemas (paridad con bot-gastos)', () => {
    it('acepta un gasto válido', () => {
      const parsed = RegistrarGastoInput.parse({
        amount: 5000, description: 'Saeta', category: 'transporte',
        date: '2026-09-30', installments: 1, currency: 'ARS',
      });
      expect(parsed.amount).toBe(5000);
    });

    it('rechaza monto negativo', () => {
      expect(() =>
        RegistrarGastoInput.parse({ amount: -500, description: 'x', category: 'y' })
      ).toThrow();
    });

    it('categoría inventada por IA hace fallback a "otros" en el servicio', async () => {
      const { expenses } = setupServices();
      const created = await expenses.create('biz-1', 'user-1', {
        amount: 100, description: 'Gym', category: 'categoria_inventada_por_ia',
      });
      expect(created.category).toBe('otros');
    });

    it('categoría personalizada del catálogo se acepta', async () => {
      const { expenses, categories } = setupServices();
      await categories.createCustom('biz-1', 'crossfit', '🏋️');
      const created = await expenses.create('biz-1', 'user-1', {
        amount: 15000, description: 'Cuota', category: 'crossfit',
      });
      expect(created.category).toBe('crossfit');
    });
  });

  describe('flujo extremo a extremo (freestyle → confirmación → DB)', () => {
    beforeEach(() => undefined);

    it('registra un gasto con confirmación y auditoría con actor', async () => {
      const f = setupFlow([{ action: 'registrar_gasto', params: { amount: 5000, description: 'Saeta', category: 'transporte' } }]);
      const ask = await handleText(f.deps, { resolution: f.resolution, text: 'gasté 5000 en Saeta', now: NOW });
      expect(ask.text).toContain('¿Confirmar?');
      const done = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
      expect(done.text).toContain('Registré');
      expect(done.text).toContain('Saeta');
      expect(f.auditRepo.entries).toHaveLength(1);
      expect(f.auditRepo.entries[0]).toMatchObject({ action: 'expense.created', actorUserId: 'user-1' });
    });

    it('/vincular genera un token HMAC verificable atado al negocio', async () => {
      const f = setupFlow([]);
      const reply = await handleText(f.deps, { resolution: f.resolution, text: '/vincular', now: NOW });
      const match = reply.text.match(/`([^`]+)`/);
      expect(match).not.toBeNull();
      const payload = verifyApiToken(API_SECRET, match![1]);
      expect(payload).toMatchObject({ userId: 'user-1', businessId: 'biz-1' });
    });
  });

  describe('permisos sobre gastos', () => {
    it('el autor puede editar su gasto; otro empleado no; el dueño sí', async () => {
      const { expenses } = setupServices();
      const created = await expenses.create('biz-1', 'autor-1', { amount: 100, description: 'x', category: 'otros' });
      await expenses.updateExpense('biz-1', 'autor-1', false, created.id, { amount: 200 });
      await expect(expenses.updateExpense('biz-1', 'otro-1', false, created.id, { amount: 300 })).rejects.toThrow(/Solo quien registró/);
      await expenses.updateExpense('biz-1', 'dueno-1', true, created.id, { amount: 300 });
      await expect(expenses.deleteExpense('biz-1', 'otro-1', false, created.id)).rejects.toThrow(/Solo quien registró/);
    });
  });
});
